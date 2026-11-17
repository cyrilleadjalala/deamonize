import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../../src/cli/commands/record.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

const PAGE = `<!doctype html>
<html><head><title>Orders</title></head>
<body>
  <label for="token">API token</label><input id="token" type="text" />
  <button id="go" type="button">Go</button>
  <ul id="results"><li>one</li><li>two</li></ul>
</body></html>`;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe('record(): no recorded step is lost after the session ends', () => {
  let httpServer: Server;
  let baseUrl: string;
  let dir: string;
  let counter = 0;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    dir = await mkdtemp(join(tmpdir(), 'daemonize-recovery-'));
  });

  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  const outFile = (): string => join(dir, `out-${++counter}.workflows.json`);
  const base = { name: 'app', label: 'flow', headless: true, visual: false, captureNetwork: false } as const;

  async function recoveryOf(out: string): Promise<ReturnType<typeof deserializeWorkflowSet>> {
    return deserializeWorkflowSet(await readFile(`${out}.recovery.json`, 'utf-8'));
  }

  it('window X after a marked zone writes the recovery file with the steps and the unchecked zone', async () => {
    const out = outFile();
    const failure = await record({
      ...base,
      url: baseUrl,
      out,
      drive: async (page) => {
        await page.locator('#go').click();
        await page.keyboard.press('Alt+Shift+R');
        await page.locator('#results').click();
        await page.locator('[data-daemonize-action=result-kind]').waitFor();
        await page.close();
      },
    }).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`${out}.recovery.json`);
    expect(message).toContain('result zone');
    expect(await exists(out)).toBe(false);
    const set = await recoveryOf(out);
    expect(set.workflows[0].steps).toHaveLength(1);
    expect(set.workflows[0].resultZone?.selector).toBeDefined();
    expect(set.workflows[0].resultZone?.schema).toBeUndefined();
  });

  it('window X with --result-zone writes the recovery file too', async () => {
    const out = outFile();
    const failure = await record({
      ...base,
      url: baseUrl,
      out,
      resultZone: '#results',
      drive: async (page) => {
        await page.locator('#go').click();
        await page.close();
      },
    }).catch((err: Error) => err);

    expect((failure as Error).message).toContain(`${out}.recovery.json`);
    const set = await recoveryOf(out);
    expect(set.workflows[0].resultZone).toMatchObject({ selector: '#results' });
  });

  it('window X with no marked zone still saves the workflow normally', async () => {
    const out = outFile();
    const summary = await record({
      ...base,
      url: baseUrl,
      out,
      drive: async (page) => {
        await page.locator('#go').click();
        await page.close();
      },
    });
    expect(summary.steps).toBe(1);
    expect(await exists(out)).toBe(true);
    expect(await exists(`${out}.recovery.json`)).toBe(false);
  });

  it('a failing saveWorkflow on the output file leaves the steps in the recovery file', async () => {
    const out = outFile();
    await mkdir(out); // a directory: the workflow file cannot be written there
    const failure = await record({
      ...base,
      url: baseUrl,
      out,
      drive: async (page) => {
        await page.locator('#go').click();
      },
    }).catch((err: Error) => err);

    expect((failure as Error).message).toContain(`${out}.recovery.json`);
    expect((await recoveryOf(out)).workflows[0].steps).toHaveLength(1);
  });

  it('a failing finalizeNetwork leaves the steps in the recovery file', async () => {
    const out = outFile();
    const failure = await record({
      ...base,
      url: baseUrl,
      out,
      drive: async (page, live) => {
        live.finalizeNetwork = async () => {
          throw new Error('network boom');
        };
        await page.locator('#go').click();
      },
    }).catch((err: Error) => err);

    expect((failure as Error).message).toContain('network boom');
    expect((failure as Error).message).toContain(`${out}.recovery.json`);
    expect((await recoveryOf(out)).workflows[0].steps).toHaveLength(1);
  });

  it('writes no file when nothing was recorded', async () => {
    const out = outFile();
    const failure = await record({
      ...base,
      url: baseUrl,
      out,
      resultZone: '#results',
      drive: async (page) => {
        await page.close();
      },
    }).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(await exists(`${out}.recovery.json`)).toBe(false);
    expect(await exists(out)).toBe(false);
  });

  it('RecordOptions.signal ends the recording with the page open', async () => {
    const out = outFile();
    const controller = new AbortController();
    const summary = await record({
      ...base,
      url: baseUrl,
      out,
      resultZone: '#results',
      signal: controller.signal,
      drive: async (page) => {
        await page.locator('#go').click();
        setTimeout(() => controller.abort(), 100);
        await new Promise<never>(() => { });
      },
    });
    expect(summary.steps).toBe(1);
    expect(summary.resultZone?.kind).toBe('list');
    expect(await exists(`${out}.recovery.json`)).toBe(false);
  });
});
