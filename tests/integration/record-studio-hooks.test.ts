import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { record } from '../../src/cli/commands/record.js';
import type { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';

const PAGE = '<!doctype html><html><head><title>Home</title></head><body><a href="/other">Other page</a></body></html>';
const COOKIE_VALUE = 'studio-hook-session-value-456';

describe('record() hooks of a Studio-driven recording (real browser)', () => {
  let httpServer: Server;
  let url: string;
  let dir: string;
  let statePath: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    dir = await mkdtemp(join(tmpdir(), 'daemonize-record-studio-'));
    statePath = join(dir, 'app.storage-state.json');
    await writeFile(
      statePath,
      JSON.stringify({ cookies: [{ name: 'sid', value: COOKIE_VALUE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] })
    );
  });
  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await removeDir(dir);
  });

  /** Drives the page of a recording from the hooks, as the Recording_Manager and a user do. */
  function harness() {
    const events: string[] = [];
    let browser: Browser | undefined;
    let live: LiveRecorder | undefined;
    const pageOf = (): Page => browser!.contexts()[0].pages()[0];
    const recordOneStep = async (): Promise<void> => {
      const page = pageOf();
      await page.getByRole('link', { name: 'Other page' }).click();
      await page.waitForURL('**/other');
      await live!.idle();
    };
    return {
      events,
      recordOneStep,
      pageOf,
      hooks: {
        onBrowser: (b: Browser) => { browser = b; events.push('browser'); },
        onLive: (l: LiveRecorder) => { live = l; events.push('live'); },
      },
    };
  }

  it('saves on abort, fires the hooks in order, and keeps the session state out of the Workflow_File', async () => {
    const out = join(dir, 'abort.workflows.json');
    const h = harness();
    const controller = new AbortController();
    const run = record({
      url, name: 'App', label: 'Go abort', out, headless: true, windowMode: 'studio',
      sessionStorageState: statePath, signal: controller.signal,
      ...h.hooks,
      onEnding: (reason) => { h.events.push(`ending:${reason}:${existsSync(out) ? 'saved' : 'not-saved'}`); },
    });
    // Wait until the page is ready, record a step from Node, then end the session by signal
    while (!h.events.includes('live')) await new Promise((r) => setTimeout(r, 25));
    expect(await h.pageOf().evaluate(() => document.cookie)).toContain(COOKIE_VALUE);
    await h.recordOneStep();
    controller.abort();
    const summary = await run;

    expect(summary.steps).toBe(1);
    expect(h.events).toEqual(['browser', 'live', 'ending:signal:not-saved']);
    const text = await readFile(out, 'utf-8');
    expect(deserializeWorkflowSet(text).workflows).toHaveLength(1);
    expect(text).not.toContain(COOKIE_VALUE);
    expect(text).not.toContain('storageState');
  });

  it('takes the recovery path when the window is closed, and never stdin', async () => {
    const out = join(dir, 'closed.workflows.json');
    const h = harness();
    const run = record({
      url, name: 'App', label: 'Go closed', out, headless: true, windowMode: 'studio',
      sessionStorageState: statePath,
      ...h.hooks,
      onEnding: (reason) => { h.events.push(`ending:${reason}`); },
    });
    const outcome = run.then(() => undefined, (e: Error) => e);
    while (!h.events.includes('live')) await new Promise((r) => setTimeout(r, 25));
    await h.recordOneStep();
    await h.pageOf().close();
    const error = await outcome;

    expect(error?.message).toMatch(/Recording interrupted: the browser window was closed\. The 1 step\(s\) recorded so far were saved to .*closed\.workflows\.json\.recovery\.json\./);
    expect(h.events).toEqual(['browser', 'live', 'ending:closed']);
    expect(existsSync(out)).toBe(false);
    const recovery = await readFile(`${out}.recovery.json`, 'utf-8');
    expect(deserializeWorkflowSet(recovery).workflows[0].steps).toHaveLength(1);
    expect(recovery).not.toContain(COOKIE_VALUE);
    expect(recovery).not.toContain('storageState');
  });

  it('writes no file when the browser cannot be launched', async () => {
    const out = join(dir, 'nolaunch.workflows.json');
    const events: string[] = [];
    await expect(
      record({
        url, name: 'App', label: 'No launch', out, windowMode: 'studio',
        launch: async () => { throw new Error('browserType.launch: spawn EACCES'); },
        onBrowser: () => events.push('browser'),
        onLive: () => events.push('live'),
        onEnding: () => events.push('ending'),
      })
    ).rejects.toThrow(/Chromium could not be started: browserType\.launch: spawn EACCES/);
    expect(events).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.startsWith('nolaunch'))).toEqual([]);
  });
});
