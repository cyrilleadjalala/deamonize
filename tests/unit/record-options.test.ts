import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { record } from '../../src/cli/commands/record.js';
import { removeDir } from '../helpers/cleanup.js';

const PAGE = '<!doctype html><html><head><title>Home</title></head><body><a href="/other">Other page</a></body></html>';
const COOKIE_VALUE = 'planted-session-value-123';

describe('record() options', () => {
  let httpServer: Server;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    dir = await mkdtemp(join(tmpdir(), 'daemonize-record-options-'));
  });
  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await removeDir(dir);
  });

  const click = async (page: import('playwright').Page): Promise<void> => {
    await page.getByRole('link', { name: 'Other page' }).click();
    await page.waitForURL('**/other');
  };

  it('uses sessionStorageState for the context and never writes it to the Workflow_File', async () => {
    const statePath = join(dir, 'session.storage-state.json');
    await writeFile(
      statePath,
      JSON.stringify({ cookies: [{ name: 'sid', value: COOKIE_VALUE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] })
    );
    const out = join(dir, 'session.workflows.json');
    let cookies = '';
    const summary = await record({
      url, name: 'App', label: 'Go', out, headless: true, sessionStorageState: statePath,
      drive: async (page) => {
        cookies = await page.evaluate(() => document.cookie);
        await click(page);
      },
    });
    expect(cookies).toContain(COOKIE_VALUE);
    expect(summary.sessionCaptured).toBeUndefined();
    const text = await readFile(out, 'utf-8');
    expect(text).not.toContain(COOKIE_VALUE);
    expect(text).not.toContain('storageState');
    expect(text).not.toContain(statePath.replace(/\\/g, '\\\\'));
  });

  it('passes the session state in memory to captureSessionState and reports sessionCaptured', async () => {
    let captured: { cookies?: Array<{ name: string }> } | undefined;
    const summary = await record({
      url, name: 'App', label: 'Go capture', out: join(dir, 'capture.workflows.json'), headless: true,
      captureSessionState: (state) => { captured = state as typeof captured; },
      drive: async (page) => {
        await page.context().addCookies([{ name: 'fresh', value: 'v', url }]);
        await click(page);
      },
    });
    expect(summary.sessionCaptured).toBe(true);
    expect(captured?.cookies?.map((c) => c.name)).toContain('fresh');
  });

  it('reports sessionCaptured = false when captureSessionState throws, and still saves', async () => {
    const out = join(dir, 'throwing.workflows.json');
    const summary = await record({
      url, name: 'App', label: 'Go throw', out, headless: true,
      captureSessionState: () => { throw new Error('nope'); },
      drive: click,
    });
    expect(summary.sessionCaptured).toBe(false);
    expect(summary.steps).toBe(1);
    await expect(readFile(out, 'utf-8')).resolves.toContain('Go throw');
  });

  it('fires onBrowser, onLive and onEnding in order, onEnding before the save', async () => {
    const events: string[] = [];
    const out = join(dir, 'hooks.workflows.json');
    await record({
      url, name: 'App', label: 'Go hooks', out, headless: true,
      onBrowser: (browser) => { events.push(typeof browser.close === 'function' ? 'browser' : 'bad'); },
      onLive: (live) => { events.push(`live:${live.stepCount}`); },
      onEnding: (reason) => { events.push(`ending:${reason}`, existsSync(out) ? 'saved' : 'not-saved'); },
      drive: click,
    });
    expect(events).toEqual(['browser', 'live:0', 'ending:api', 'not-saved']);
  });

  it('launches through the injected launcher with headless false by default, and a failure writes no file', async () => {
    const calls: unknown[] = [];
    const out = join(dir, 'never.workflows.json');
    await expect(
      record({
        url, name: 'App', label: 'Never', out,
        launch: async (options) => { calls.push(options); throw new Error('browserType.launch: Executable doesn\'t exist at /x'); },
      })
    ).rejects.toThrow(/Google Chrome and Microsoft Edge|Microsoft Edge/);
    expect(calls).toEqual([{ headless: false }, { headless: false, channel: 'chrome' }, { headless: false, channel: 'msedge' }]);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith('never'))).toEqual([]);
  });

  it('uses the injected launcher for a real browser', async () => {
    const seen: unknown[] = [];
    const summary = await record({
      url, name: 'App', label: 'Go launch', out: join(dir, 'launch.workflows.json'), headless: true,
      launch: (options) => { seen.push(options); return chromium.launch(options); },
      drive: click,
    });
    expect(seen).toEqual([{ headless: true }]);
    expect(summary.steps).toBe(1);
  });
});
