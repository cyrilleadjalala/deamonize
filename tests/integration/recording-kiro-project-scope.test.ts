import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createApplicationLocator } from '../../src/studio/active-app.js';
import { createAppData } from '../../src/studio/app-data.js';
import { createAppNames, deriveSlug } from '../../src/studio/app-names.js';
import { createAutoAddStore } from '../../src/studio/auto-add-store.js';
import { createCompileRunner } from '../../src/studio/compile-runner.js';
import { createInstallRecords } from '../../src/studio/install-records.js';
import { KIRO_ADDED } from '../../src/studio/messages/record.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { createRecordingManager, defaultRecord, type RecordFn } from '../../src/studio/recording-manager.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { createSessionStore } from '../../src/studio/session-store.js';
import type { LiveRecorder } from '../../src/recorder/live-recorder.js';
import type { WorkflowSet } from '../../src/types.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest } from '../helpers/http.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const workspaceRoot = resolve(import.meta.dirname, '../..');

const PAGE_HTML = `<!doctype html>
<html>
  <head><title>Search</title></head>
  <body>
    <form method="get" action="/">
      <label for="q">Item query</label>
      <input id="q" name="q" type="text" />
      <button type="submit">Find</button>
    </form>
  </body>
</html>`;

interface Harness {
  base: string;
  ws: string;
  home: string;
  handle: StudioHandle;
  slug: string;
  live: () => LiveRecorder | undefined;
  pageOf: () => Page;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string; json: Record<string, any> | undefined }>;
  followFinal: () => Promise<Record<string, any>>;
}

describe('Studio "Save and add to Kiro" with project scope and real PowerInstaller', () => {
  let site: Server;
  let origin: string;
  let url: string;
  const bases: string[] = [];
  const handles: StudioHandle[] = [];

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE_HTML);
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    url = `${origin}/`;
  });

  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close().catch(() => undefined);
    for (const b of bases.splice(0)) await removeDir(b).catch(() => undefined);
  });

  afterAll(async () => {
    await new Promise<void>((done) => site?.close(() => done()));
  });

  async function setupHarness(opts: { createHomeKiro: boolean; passWorkspacePath: boolean; separateWorkflowDir?: boolean }): Promise<Harness> {
    const base = await mkdtemp(join(tmpdir(), 'rec-kiro-scope-'));
    bases.push(base);
    const ws = join(base, 'workspace');
    const home = join(base, 'home');
    const appDir = join(base, 'appdata');
    const baseOut = join(ws, 'daemonize-out');
    const slug = deriveSlug({ origin });
    const appOut = join(ws, slug);
    const workflowDir = opts.separateWorkflowDir ? join(base, 'meta') : ws;
    const workflowFile = join(workflowDir, 'daemonize.workflows.json');

    await mkdir(ws, { recursive: true });
    await mkdir(workflowDir, { recursive: true });
    await mkdir(home, { recursive: true });
    if (opts.createHomeKiro) await mkdir(join(home, '.kiro'), { recursive: true });
    await mkdir(join(base, 'ui'), { recursive: true });
    await mkdir(appOut, { recursive: true });
    // Stand-in for "npm install": the compile runner skips installation when node_modules exists
    await symlink(join(workspaceRoot, 'node_modules'), join(appOut, 'node_modules'), 'junction');

    const env = { DAEMONIZE_DATA_DIR: appDir, DAEMONIZE_VAULT_KEY_PROVIDER: 'memory' };
    const appData = createAppData({ cwd: ws, outDir: baseOut, env, home });
    const vault = createSecretVault({ appData, env });
    const sessions = createSessionStore({ appData });
    const loadSet = async (): Promise<{ set: WorkflowSet | undefined }> => {
      try {
        return { set: deserializeWorkflowSet(await readFile(workflowFile, 'utf-8')) };
      } catch {
        return { set: undefined };
      }
    };
    const locator = createApplicationLocator({ baseOutDir: baseOut, apps: createAppNames({ appData }), loadSet });
    const compiler = createCompileRunner({
      workflowFile,
      target: () => locator.prepareCompile(),
      playground: () => undefined,
      scrub: (t) => t,
      paths: [base],
    });
    const power = createPowerInstaller({
      cwd: ws,
      home,
      appData,
      locate: () => locator.current(),
      vault,
      records: createInstallRecords({ appData }),
      autoAdd: createAutoAddStore({ appData }),
    });

    let liveRef: LiveRecorder | undefined;
    let browserRef: Browser | undefined;
    const record: RecordFn = (options) =>
      defaultRecord({
        ...options,
        onLive: (l) => {
          liveRef = l as LiveRecorder;
          options.onLive(l);
        },
        onBrowser: (b) => {
          browserRef = b as Browser;
          options.onBrowser(b);
        },
      });
    const recording = createRecordingManager({
      workflowFile,
      ...(opts.passWorkspacePath ? { workspacePath: ws } : {}),
      sessions,
      compiler,
      scrub: (t) => t,
      power,
      record,
      launch: (o: Parameters<typeof chromium.launch>[0]) =>
        chromium.launch({ ...o, headless: true, executablePath: o?.executablePath ?? (process.env.DAEMONIZE_CHROMIUM_PATH || undefined) }),
    });

    const handle = await startStudio({
      workflowFile,
      outDir: baseOut,
      staticDir: join(base, 'ui'),
      env,
      home,
      services: { appData, vault, sessions, recording, compiler, power, locator },
    });
    handles.push(handle);

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await rawRequest(
        handle,
        method,
        path,
        { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body === undefined ? undefined : JSON.stringify(body),
      );
      return { status: res.status, text: res.text, json: res.text === '' ? undefined : (JSON.parse(res.text) as Record<string, any>) };
    };

    const followFinal = async (): Promise<Record<string, any>> => {
      let last: Record<string, any> = {};
      for (let i = 0; i < 3000; i += 1) {
        last = (await call('GET', '/api/record/status')).json ?? {};
        if (last.state === 'done' || last.state === 'error') return last;
        await new Promise((r) => setTimeout(r, 20));
      }
      return last;
    };

    return {
      base,
      ws,
      home,
      handle,
      slug,
      live: () => liveRef,
      pageOf: () => browserRef!.contexts()[0].pages()[0],
      call,
      followFinal,
    };
  }

  async function recordSearchStep(h: Harness, query: string): Promise<Page> {
    const start = await h.call('POST', '/api/record/start', { name: 'Find item', url, reuseSession: false });
    expect(start.status).toBe(202);
    for (let i = 0; i < 600 && h.live() === undefined; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(h.live()).toBeDefined();
    const page = h.pageOf();
    await page.waitForSelector('[data-daemonize-panel]', { timeout: 20000 });
    await page.getByLabel('Item query').fill(query);
    await page.getByRole('button', { name: 'Find' }).click();
    await page.waitForURL('**/?q=*');
    await h.live()!.idle();
    await page.waitForSelector('[data-daemonize-panel]', { timeout: 10000 });
    return page;
  }

  it('writes <workspace>/.kiro/settings/mcp.json (and not <home>/.kiro) when "Only this project" is chosen', async () => {
    const h = await setupHarness({ createHomeKiro: true, passWorkspacePath: true, separateWorkflowDir: true });
    const page = await recordSearchStep(h, 'laptop');

    await page.locator('[data-daemonize-action="finish"]').click();
    await page.locator('[data-daemonize-action="scope-project"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-daemonize-action="scope-project"]').check();
    await page.locator('[data-daemonize-action="finish-kiro"]').click();

    const finalStatus = await h.followFinal();
    expect(finalStatus.state).toBe('done');
    expect(finalStatus.intent).toBe('kiro');
    expect(finalStatus.kiro).toEqual({
      added: true,
      message: KIRO_ADDED,
      scope: 'project',
      missingSecrets: [],
      requiredSecrets: [],
    });

    const projectMcp = join(h.ws, '.kiro', 'settings', 'mcp.json');
    const projectSkill = join(h.ws, '.kiro', 'skills', h.slug, 'SKILL.md');
    expect(existsSync(projectMcp)).toBe(true);
    expect(existsSync(projectSkill)).toBe(true);
    expect(existsSync(join(h.home, '.kiro', 'settings', 'mcp.json'))).toBe(false);
    expect(existsSync(join(h.base, 'meta', '.kiro'))).toBe(false);

    const parsed = JSON.parse(await readFile(projectMcp, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(parsed.mcpServers)).toEqual([h.slug]);
  });

  it('auto-selects project scope and succeeds via workflowFile dirname fallback when ~/.kiro does not exist', async () => {
    const h = await setupHarness({ createHomeKiro: false, passWorkspacePath: false });
    const page = await recordSearchStep(h, 'tablet');

    await page.locator('[data-daemonize-action="finish"]').click();
    await page.locator('[data-daemonize-action="scope-static"]').waitFor({ state: 'visible', timeout: 10000 });
    expect(await page.locator('[data-daemonize-action="scope-project"]').count()).toBe(0);
    await page.locator('[data-daemonize-action="finish-kiro"]').click();

    const finalStatus = await h.followFinal();
    expect(finalStatus.state).toBe('done');
    expect(finalStatus.intent).toBe('kiro');
    expect(finalStatus.kiro).toEqual({
      added: true,
      message: KIRO_ADDED,
      scope: 'project',
      missingSecrets: [],
      requiredSecrets: [],
    });

    const projectMcp = join(h.ws, '.kiro', 'settings', 'mcp.json');
    const projectSkill = join(h.ws, '.kiro', 'skills', h.slug, 'SKILL.md');
    expect(existsSync(projectMcp)).toBe(true);
    expect(existsSync(projectSkill)).toBe(true);
    expect(existsSync(join(h.home, '.kiro'))).toBe(false);
  });
});
