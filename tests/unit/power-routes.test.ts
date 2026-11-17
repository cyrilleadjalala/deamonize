import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { FAKE_SECRET_VALUE, SERVER, writeCompiledOutput } from '../helpers/power-fixture.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

/** The six Power routes, through the real dispatcher: remote refusal, method, unknown field, scope. */
describe('Power routes through the Studio', () => {
  let dir: string;
  let ws: string;
  let local: StudioHandle;
  let remote: StudioHandle;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const call = (h: StudioHandle, method: string, path: string, body?: unknown) =>
    rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...(body === undefined ? {} : JSON_HEADERS) }, body === undefined ? undefined : JSON.stringify(body));
  const json = (text: string) => JSON.parse(text) as Record<string, any>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'power-routes-'));
    ws = join(dir, 'ws');
    await mkdir(ws, { recursive: true });
    await mkdir(join(dir, 'ui'), { recursive: true });
    const out = join(dir, 'out');
    await writeCompiledOutput(out);
    const base = { workflowFile: join(dir, 'w.json'), outDir: out, staticDir: join(dir, 'ui'), env: { DAEMONIZE_DATA_DIR: join(dir, 'appdata') }, home: join(dir, 'home') };
    local = await startStudio(base);
    remote = await startStudio({ ...base, host: '0.0.0.0', allowRemote: true });
  });
  afterAll(async () => {
    await local.close();
    await remote.close();
    await removeDir(dir);
  });

  const routes: Array<[string, string[]]> = [
    ['/api/power/info', ['GET']],
    ['/api/power/snippet', ['GET']],
    ['/api/power/preview', ['POST']],
    ['/api/power/install', ['POST']],
    ['/api/power/remove', ['POST']],
    ['/api/power/auto-add', ['GET', 'POST']],
  ];

  it('answers 403 from a remote listener on every route and method', async () => {
    for (const [path, methods] of routes) {
      for (const method of methods) {
        const res = await call(remote, method, path, method === 'POST' ? {} : undefined);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
  });

  it('answers 405 for a method a route does not define', async () => {
    for (const [path, methods] of routes) {
      if (methods.length > 1) continue;
      const wrong = methods[0] === 'GET' ? 'POST' : 'GET';
      const res = await call(local, wrong, path, wrong === 'POST' ? {} : undefined);
      expect(res.status, path).toBe(405);
    }
  });

  it('answers 400 for an unknown body field on every POST route', async () => {
    const bodies: Record<string, Record<string, unknown>> = {
      '/api/power/preview': { scope: 'global', extra: 1 },
      '/api/power/install': { confirmationId: 'x', kiroPath: 'y', scope: 'global', extra: 1 },
      '/api/power/remove': { scope: 'global', extra: 1 },
      '/api/power/auto-add': { enabled: false, extra: 1 },
    };
    for (const [path, body] of Object.entries(bodies)) {
      const res = await call(local, 'POST', path, body);
      expect(res.status, path).toBe(400);
    }
  });

  it('answers 400 POWER_SCOPE_INVALID for a bad scope, and 400 for an auto-add body that is not enabled:false', async () => {
    for (const path of ['/api/power/preview', '/api/power/install', '/api/power/remove']) {
      for (const scope of [undefined, 'both', 5, null]) {
        const res = await call(local, 'POST', path, { scope, confirmationId: 'x', kiroPath: 'y' } as never);
        expect(res.status, `${path} ${String(scope)}`).toBe(400);
      }
    }
    expect((await call(local, 'POST', '/api/power/auto-add', { enabled: true })).status).toBe(400);
    expect((await call(local, 'POST', '/api/power/auto-add', {})).status).toBe(400);
  });

  it('answers a refused install with 409, and the working routes with names, paths and booleans only', async () => {
    const info = await call(local, 'GET', '/api/power/info');
    expect(info.status).toBe(200);
    expect(json(info.text)).toMatchObject({ available: true, serverName: SERVER, kiroHomeExists: false, installs: [] });
    const refused = await call(local, 'POST', '/api/power/install', { confirmationId: 'nope', kiroPath: 'x', scope: 'global' });
    expect(refused.status).toBe(409);
    expect((await call(local, 'POST', '/api/power/remove', { scope: 'global' })).status).toBe(409);
    const state = await call(local, 'GET', '/api/power/auto-add');
    expect(json(state.text)).toMatchObject({ enabled: false });
    const off = await call(local, 'POST', '/api/power/auto-add', { enabled: false });
    expect(off.status).toBe(200);
    const preview = await call(local, 'POST', '/api/power/preview', { scope: 'global' });
    expect(preview.status).toBe(200);
    const done = await call(local, 'POST', '/api/power/install', { confirmationId: json(preview.text).confirmationId, kiroPath: json(preview.text).kiroPath, scope: 'global', autoAdd: true });
    expect(done.status).toBe(200);
    expect(typeof json(done.text).autoAddSaved).toBe('boolean');
    const snippet = await call(local, 'GET', '/api/power/snippet');
    for (const res of [info, refused, state, off, preview, done, snippet]) expect(res.text).not.toContain(FAKE_SECRET_VALUE);
    const removed = await call(local, 'POST', '/api/power/remove', { scope: 'global' });
    expect(removed.status).toBe(200);
    expect(Array.isArray(json(removed.text).removed)).toBe(true);
  });
});
