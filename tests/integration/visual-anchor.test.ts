import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { record } from '../../src/cli/commands/record.js';
import { merge } from '../../src/cli/commands/merge.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { resolveThumbnail } from '../../src/recorder/visual-anchor.js';
import { removeDir } from '../helpers/cleanup.js';

const LOGIN_PAGE = `<!doctype html>
<html><head><title>Login</title>
<style>
  body { font-family: sans-serif; margin: 40px; }
  label, input, button { display: block; }
  input { margin-bottom: 60px; width: 220px; height: 28px; }
  button { height: 32px; width: 90px; }
</style></head>
<body>
  <form onsubmit="event.preventDefault(); document.title = 'Saved'">
    <label for="user">Username</label>
    <input id="user" name="user" />
    <label for="pass">Password</label>
    <input id="pass" name="pass" type="password" />
    <button type="submit">Save</button>
  </form>
</body></html>`;

const IMAGE_DATA = /data:image\/[a-z+]+;base64,[A-Za-z0-9+\/]{40,}|iVBORw0KGgo/;

describe('Visual_Anchors recorded in a real browser', () => {
  let httpServer: Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url?.startsWith('/done') ? '<html><body><p>Saved</p></body></html>' : LOGIN_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    dir = await mkdtemp(join(tmpdir(), 'daemonize-visual-'));
  });

  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await removeDir(dir);
  });

  const login = async (page: Page): Promise<void> => {
    await page.locator('#user').click();
    await page.keyboard.type('ada');
    await page.keyboard.press('Tab'); // leaving the field records it
    await page.keyboard.type('hunter2');
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.title === 'Saved');
  };

  it('saves a small thumbnail for each ordinary step and none for the password field', async () => {
    const file = join(dir, 'workflows.json');
    const summary = await record({ url: baseUrl, name: 'App', label: 'Login', out: file, headless: true, drive: login });

    const raw = await readFile(file, 'utf-8');
    const set = deserializeWorkflowSet(raw);
    const steps = set.workflows[0].steps;
    expect(raw).not.toMatch(IMAGE_DATA);

    const passwordStep = steps.find((s) => s.secretRef !== undefined);
    expect(passwordStep).toBeDefined();
    expect(passwordStep!.visual).toBeDefined();
    expect(passwordStep!.visual!.thumbnailPath).toBeUndefined();
    expect(passwordStep!.visual!.intent).toMatch(/^Type into the field/);

    const withThumbnail = steps.filter((s) => s.visual?.thumbnailPath !== undefined);
    expect(withThumbnail.length).toBeGreaterThanOrEqual(2); // the username field and the Save button
    expect(summary.thumbnails).toBe(withThumbnail.length);

    for (const step of steps) {
      const { rect } = step.visual!;
      for (const key of ['x', 'y', 'w', 'h'] as const) {
        expect(rect[key]).toBeGreaterThanOrEqual(0);
        expect(rect[key]).toBeLessThanOrEqual(1);
      }
      expect(rect.x + rect.w).toBeLessThanOrEqual(1);
      expect(rect.y + rect.h).toBeLessThanOrEqual(1);
    }
    for (const step of withThumbnail) {
      const path = step.visual!.thumbnailPath!;
      expect(path).toMatch(new RegExp(`^workflows\\.json\\.assets/step-${set.workflows[0].id}-\\d+\\.png$`));
      const info = await stat(resolveThumbnail(file, path));
      expect(info.size).toBeGreaterThan(0);
      expect(info.size).toBeLessThan(20 * 1024);
    }
    const save = steps.find((s) => s.visual?.intent.includes("button 'Save'"));
    expect(save?.visual?.intent).toBe("Click the button 'Save'");
    expect(await readdir(join(dir, 'workflows.json.assets'))).toHaveLength(withThumbnail.length);
  });

  it('puts no thumbnail, image data or assets path in the compiled artifacts', async () => {
    const set = deserializeWorkflowSet(await readFile(join(dir, 'workflows.json'), 'utf-8'));
    const out = join(dir, 'compiled');
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), out);
    } finally {
      console.log = log;
    }
    const files = (await readdir(out, { recursive: true, withFileTypes: true })).filter((e) => e.isFile() && e.name !== '.dockerignore');
    expect(files.length).toBeGreaterThan(5);
    for (const entry of files) {
      const text = await readFile(join(entry.parentPath, entry.name), 'utf-8');
      expect(text, entry.name).not.toMatch(IMAGE_DATA);
      expect(text, entry.name).not.toMatch(/\.assets[\\/]|step-[0-9a-f-]{36}-\d+\.png/);
    }
  });

  it('copies the thumbnails of the kept workflows when merging into another file', async () => {
    const merged = join(dir, 'merged.json');
    const other = join(dir, 'other.json');
    await record({ url: baseUrl, name: 'App', label: 'Other', out: other, headless: true, drive: async (page) => { await page.getByRole('button', { name: 'Save' }).click(); } });
    expect(await merge(join(dir, 'workflows.json'), other, merged)).toBe(2);
    const set = deserializeWorkflowSet(await readFile(merged, 'utf-8'));
    const paths = set.workflows.flatMap((w) => w.steps.map((s) => s.visual?.thumbnailPath)).filter((p): p is string => p !== undefined);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const path of paths) {
      expect(path.startsWith('merged.json.assets/')).toBe(true);
      expect((await stat(resolveThumbnail(merged, path))).size).toBeGreaterThan(0);
    }
  });

  it('with visual off, records no visual anchor and writes no file', async () => {
    const file = join(dir, 'novisual.json');
    const summary = await record({ url: baseUrl, name: 'App', label: 'Login', out: file, headless: true, visual: false, drive: login });
    expect(summary.thumbnails).toBe(0);
    const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
    expect(set.workflows[0].steps.every((s) => s.visual === undefined)).toBe(true);
    expect((await readdir(dir)).includes('novisual.json.assets')).toBe(false);
  });
});
