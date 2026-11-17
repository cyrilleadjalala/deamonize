import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { DEFAULT_ROUTES } from '../../src/studio/routes/index.js';
import type { RouteContext, RouteDef, RouteFactory } from '../../src/studio/routes/types.js';
import { plainName } from '../../src/studio/validate-action.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

/**
 * Walks every registered route. The fake routes stand in until the real ones are merged; the real ones are added through
 * DEFAULT_ROUTES, so this file needs no change when they land. A fake plain-name route proves the 400 rule.
 */
describe('guard rules on every registered route', () => {
  let dir: string;
  let local: StudioHandle;
  let remote: StudioHandle;
  const all: RouteDef[] = [];
  let touched = 0;

  const fake: RouteFactory = () => [
    { path: '/api/guardfake/read', remote: 'blocked', handlers: { GET: async () => ({ status: 200, body: {} }) } },
    {
      path: '/api/guardfake/plain',
      remote: 'blocked',
      handlers: {
        POST: async (req) => {
          const check = plainName(req.body.name);
          if (!check.ok) return { status: 400, body: { error: check.message } };
          touched += 1;
          return { status: 200, body: {} };
        },
      },
    },
  ];
  const collect: RouteFactory = (ctx: RouteContext) => {
    for (const factory of [...DEFAULT_ROUTES, fake]) all.push(...factory(ctx));
    return all;
  };

  const call = (h: StudioHandle, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...headers }, body);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guard-routes-'));
    const base = { workflowFile: join(dir, 'w.json'), outDir: join(dir, 'out'), env: {} };
    local = await startStudio({ ...base, routes: [collect] });
    // Same registry again, on a listener that is not loopback
    remote = await startStudio({ ...base, host: '0.0.0.0', allowRemote: true, routes: [(ctx) => [...DEFAULT_ROUTES, fake].flatMap((f) => f(ctx))] });
  });
  afterAll(async () => {
    await local.close();
    await remote.close();
    await removeDir(dir);
  });

  it('refuses every blocked route with 403 on a remote listener and runs no handler', async () => {
    for (const def of all.filter((d) => d.remote === 'blocked')) {
      for (const method of ['GET', 'POST'] as const) {
        if (def.handlers[method] === undefined) continue;
        const r = await call(remote, method, def.path, { 'content-type': 'application/json' }, method === 'POST' ? '{"name":"ok"}' : undefined);
        expect(r.status, `${method} ${def.path}`).toBe(403);
      }
    }
    expect(touched).toBe(0);
  });

  it('answers 405 with Allow for a method a route does not define', async () => {
    for (const def of all) {
      const missing = def.handlers.POST === undefined ? 'POST' : def.handlers.GET === undefined ? 'GET' : undefined;
      if (missing === undefined) continue;
      const r = await call(local, missing, def.path, { 'content-type': 'application/json' }, missing === 'POST' ? '{}' : undefined);
      expect(r.status, def.path).toBe(405);
      expect(String(r.headers.allow)).toBe(missing === 'POST' ? 'GET, HEAD' : 'POST');
    }
  });

  it('answers 413 above 64 KiB and 415 for a non-JSON body on every POST route', async () => {
    for (const def of all.filter((d) => d.handlers.POST !== undefined)) {
      const big = await call(local, 'POST', def.path, { 'content-type': 'application/json' }, JSON.stringify({ pad: 'x'.repeat(65 * 1024) }));
      expect(big.status, def.path).toBe(413);
      const text = await call(local, 'POST', def.path, { 'content-type': 'text/plain' }, 'hello');
      expect(text.status, def.path).toBe(415);
    }
  });

  it('answers 400 for `..`, an absolute path and NUL in a plain-name field, and touches nothing', async () => {
    const before = await readdir(dir);
    await writeFile(join(dir, 'marker.txt'), 'x');
    for (const name of ['..', '../x', '/etc/passwd', 'C:\\Windows', 'a\u0000b']) {
      const r = await call(local, 'POST', '/api/guardfake/plain', { 'content-type': 'application/json' }, JSON.stringify({ name }));
      expect(r.status, JSON.stringify(name)).toBe(400);
    }
    expect(touched).toBe(0);
    expect((await readdir(dir)).sort()).toEqual([...before, 'marker.txt'].sort());
  });
});
