// checkpoint-only: needs G-F1, G-F2
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

/** The Daemonize Power routes through the real dispatcher, with the real `power/` folder and a fake home. */
describe('Daemonize Power routes through the Studio', () => {
  let dir: string;
  let local: StudioHandle;
  let remote: StudioHandle;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const call = (h: StudioHandle, method: string, path: string, body?: unknown, token: string = h.token) =>
    rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': token, ...(body === undefined ? {} : JSON_HEADERS) }, body === undefined ? undefined : JSON.stringify(body));
  const json = (text: string) => JSON.parse(text) as Record<string, any>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-power-routes-'));
    await mkdir(join(dir, 'ui'), { recursive: true });
    await mkdir(join(dir, 'ws'), { recursive: true });
    const base = { workflowFile: join(dir, 'w.json'), outDir: join(dir, 'out'), staticDir: join(dir, 'ui'), env: { DAEMONIZE_DATA_DIR: join(dir, 'appdata') }, home: join(dir, 'home') };
    local = await startStudio(base);
    remote = await startStudio({ ...base, host: '0.0.0.0', allowRemote: true });
  });
  afterAll(async () => {
    await local.close();
    await remote.close();
    await removeDir(dir);
  });

  it('answers 403 from a remote listener', async () => {
    expect((await call(remote, 'GET', '/api/power/daemonize/info')).status).toBe(403);
    expect((await call(remote, 'POST', '/api/power/daemonize/preview', { scope: 'global' })).status).toBe(403);
  });

  it('answers 400 for an unknown field and a bad scope', async () => {
    expect((await call(local, 'POST', '/api/power/daemonize/preview', { scope: 'global', extra: 1 })).status).toBe(400);
    expect((await call(local, 'POST', '/api/power/daemonize/remove', { scope: 'nowhere' })).status).toBe(400);
  });

  it('previews, installs into the fake home, then removes', async () => {
    const preview = await call(local, 'POST', '/api/power/daemonize/preview', { scope: 'global' });
    expect(preview.status).toBe(200);
    const plan = json(preview.body);
    expect(plan.kiroPath).toBe(join(dir, 'home', '.kiro'));
    const done = await call(local, 'POST', '/api/power/daemonize/install', { confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope: 'global' });
    expect(done.status).toBe(200);
    expect(json(done.body).written).toContain('settings/mcp.json');
    const settings = JSON.parse(await readFile(join(dir, 'home', '.kiro', 'settings', 'mcp.json'), 'utf-8'));
    expect(settings.mcpServers['daemonize-studio'].args.at(-1)).toBe('mcp');
    const removed = await call(local, 'POST', '/api/power/daemonize/remove', { scope: 'global' });
    expect(removed.status).toBe(200);
    expect(json(removed.body).removed).toContain('settings/mcp.json');
  });
});
