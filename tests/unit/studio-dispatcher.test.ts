import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import type { RouteDef, RouteFactory } from '../../src/studio/routes/types.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

const VAULT_VALUE = ['Fake', 'Vault', 'Value-12345'].join('');
const routes: RouteDef[] = [
  { path: '/api/fake/status', remote: 'allowed', handlers: { GET: async () => ({ status: 200, body: { ok: true } }) } },
  { path: '/api/fake/act', remote: 'blocked', handlers: { POST: async (req) => ({ status: 202, body: { got: req.body } }) } },
  { path: '/api/fake/read', remote: 'blocked', handlers: { GET: async () => ({ status: 200, body: { text: "value is ${VAULT_VALUE}" } }) } },
];
const factory: RouteFactory = () => routes;

describe('route dispatcher', () => {
  let dir: string;
  let handle: StudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (dir) await removeDir(dir);
  });

  const start = async (extra: { host?: string; allowRemote?: boolean; sampleData?: boolean } = {}) => {
    dir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    handle = await startStudio({
      workflowFile: join(dir, 'none.json'),
      outDir: join(dir, 'out'),
      staticDir: join(dir, 'ui'),
      routes: [factory],
      env: {},
      services: { vault: { names: async () => new Set(), values: () => [VAULT_VALUE], set: async () => undefined, remove: async () => false, has: async () => false, snapshot: async () => ({}) } },
      ...extra,
    });
    const h = handle;
    return (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...headers }, body);
  };
  const json = { 'content-type': 'application/json' };

  it('answers 405 with Allow for other methods, and dispatches HEAD as GET', async () => {
    const call = await start();
    const post = await call('POST', '/api/fake/status', json, '{}');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const get = await call('GET', '/api/fake/act');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const head = await call('HEAD', '/api/fake/status');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect((await call('HEAD', '/api/fake/act')).status).toBe(405);
  });

  it('passes a JSON object body, {} for an empty one, and refuses 415, 400 and 413', async () => {
    const call = await start();
    expect(JSON.parse((await call('POST', '/api/fake/act', json, '{"a":1}')).text)).toEqual({ got: { a: 1 } });
    expect(JSON.parse((await call('POST', '/api/fake/act')).text)).toEqual({ got: {} });
    expect((await call('POST', '/api/fake/act', { 'content-type': 'text/plain' }, 'x')).status).toBe(415);
    expect((await call('POST', '/api/fake/act', json, '[1]')).status).toBe(400);
    expect((await call('POST', '/api/fake/act', json, '{bad')).status).toBe(400);
    const big = await call('POST', '/api/fake/act', json, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }));
    expect(big.status).toBe(413);
    // Between 8 KiB and 64 KiB is fine on a registered POST route
    expect((await call('POST', '/api/fake/act', json, JSON.stringify({ pad: 'x'.repeat(20 * 1024) }))).status).toBe(202);
  });

  it('keeps the existing guard order: 414, 403 host, 401 before the route checks', async () => {
    const call = await start();
    expect((await call('GET', '/api/fake/status?' + 'a'.repeat(2100))).status).toBe(414);
    expect((await call('GET', '/api/fake/status', { host: 'evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/fake/status', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/fake/status', { 'x-studio-token': 'wrong' })).status).toBe(401);
    expect((await call('GET', '/api/fake/status', { 'x-studio-token': 'wrong' })).status).toBe(401);
  });

  it('answers 409 to a write route in sample mode, and still serves a read route', async () => {
    const call = await start({ sampleData: true });
    expect((await call('POST', '/api/fake/act', json, '{}')).status).toBe(409);
    expect((await call('GET', '/api/fake/status')).status).toBe(200);
  });

  it('refuses a blocked route with 403 when the listener is not loopback, before the method check', async () => {
    const call = await start({ host: '0.0.0.0', allowRemote: true });
    expect((await call('POST', '/api/fake/act', json, '{}')).status).toBe(403);
    expect((await call('GET', '/api/fake/act')).status).toBe(403);
    expect((await call('GET', '/api/fake/status')).status).toBe(200);
  });

  it('redacts vault values from route answers, and unowned paths still answer the old 404', async () => {
    const call = await start();
    const read = await call('GET', '/api/fake/read');
    expect(read.text).not.toContain(VAULT_VALUE);
    expect((await call('GET', '/api/nothing')).status).toBe(404);
    expect((await call('POST', '/api/nothing', json, '{}')).status).toBe(405);
  });

  it('refuses two routes with the same path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dispatch-'));
    await expect(startStudio({ workflowFile: join(dir, 'x.json'), outDir: join(dir, 'o'), routes: [factory, factory] })).rejects.toThrow(/Duplicate/);
  });
});
