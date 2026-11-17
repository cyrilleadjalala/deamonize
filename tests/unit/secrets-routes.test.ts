import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretRoutes } from '../../src/studio/routes/secrets.js';
import type { RouteContext, RouteDef, RouteResponse } from '../../src/studio/routes/types.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { InertSecretVault } from '../../src/studio/inert-services.js';
import type { AppData, SecretVault } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';
import type { WorkflowSet } from '../../src/types.js';

const PLANTED = 'Planted-Route-Value-77aa';
const TOTP = 'JBSWY3DPEHPK3PXP';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const set = {
  version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://app.example',
  workflows: [{ id: 'a', label: 'A', steps: [{ actionType: 'type', selectors: [], secretRef: 'PW' }, { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true }] }],
} as unknown as WorkflowSet;

async function setup(options: { vault?: SecretVault; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-sr-'));
  dirs.push(dir);
  const appData: AppData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
  let key: Buffer | undefined;
  const provider: KeyProvider = { id: 'mem', get: async () => key, create: async (k) => void (key = k) };
  const vault = options.vault ?? createSecretVault({ appData, keyProvider: provider });
  const stops = { count: 0 };
  const playground = { serverStarted: true, stopNow: async () => void (stops.count += 1) };
  const ctx = {
    services: { vault },
    playground,
    sample: false,
    loadSet: async () => ({ set, outputs: {} }),
    configuredSecretVariables: async () => new Set([...[...(await vault.names())].map((n) => `DAEMONIZE_SECRET_${n.toUpperCase()}`), ...Object.keys(options.env ?? {}).map((n) => n.toUpperCase())]),
    studioEnv: options.env ?? {},
  } as unknown as RouteContext;
  const routes = new Map<string, RouteDef>(secretRoutes(ctx).map((r) => [r.path, r]));
  const call = (path: string, method: 'GET' | 'POST', body: Record<string, unknown> = {}): Promise<RouteResponse> =>
    routes.get(path)!.handlers[method]!({ method, query: new URLSearchParams(), body, signal: new AbortController().signal });
  return { dir, vault, stops, call, routes };
}

describe('secrets routes', () => {
  it('registers three routes, all blocked for a remote listener', async () => {
    const { routes } = await setup();
    expect([...routes.keys()].sort()).toEqual(['/api/secrets', '/api/secrets/forget']);
    for (const r of routes.values()) expect(r.remote).toBe('blocked');
  });

  it('lists names, kinds and configured only', async () => {
    const { call, vault } = await setup({ env: { DAEMONIZE_SECRET_OTP: 'x' } });
    await vault.set('PW', PLANTED);
    const res = await call('/api/secrets', 'GET');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ secrets: [{ name: 'OTP', kind: 'totp', configured: true }, { name: 'PW', kind: 'password', configured: true }] });
    expect(JSON.stringify(res.body)).not.toContain(PLANTED);
  });

  it('saves a value, stops the Child_Server and answers without the value', async () => {
    const { call, vault, stops } = await setup();
    const res = await call('/api/secrets', 'POST', { name: 'PW', value: PLANTED });
    expect(res).toEqual({ status: 200, body: { name: 'PW', configured: true } });
    expect(await vault.snapshot()).toEqual({ PW: PLANTED });
    expect(stops.count).toBe(1);
  });

  it('stores the normalized key of a TOTP value, from a key or an otpauth address', async () => {
    const { call, vault } = await setup();
    await call('/api/secrets', 'POST', { name: 'OTP', value: 'jbsw y3dp ehpk 3pxp' });
    expect((await vault.snapshot()).OTP).toBe(TOTP);
    await call('/api/secrets', 'POST', { name: 'OTP', value: `otpauth://totp/x?secret=${TOTP.toLowerCase()}&issuer=y` });
    expect((await vault.snapshot()).OTP).toBe(TOTP);
  });

  it.each([
    ['not required', { name: 'OTHER', value: PLANTED }],
    ['empty value', { name: 'PW', value: '' }],
    ['two characters', { name: 'PW', value: 'ab' }],
    ['over 4096 bytes', { name: 'PW', value: 'é'.repeat(2049) }],
    ['NUL', { name: 'PW', value: 'ab\0cd' }],
    ['not a string', { name: 'PW', value: 12345 }],
    ['invalid TOTP', { name: 'OTP', value: 'not*valid' }],
    ['hotp address', { name: 'OTP', value: `otpauth://hotp/x?secret=${TOTP}` }],
    ['unknown field', { name: 'PW', value: PLANTED, extra: 1 }],
    ['path in name', { name: '../PW', value: PLANTED }],
    ['absolute name', { name: 'C:\\PW', value: PLANTED }],
  ])('refuses %s with 400 and changes nothing', async (_label, body) => {
    const { call, vault, stops, dir } = await setup();
    const res = await call('/api/secrets', 'POST', body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(PLANTED);
    expect(await vault.snapshot()).toEqual({});
    expect(stops.count).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('answers 503 when the vault is unavailable and does not stop the server', async () => {
    const { call, stops } = await setup({ vault: new InertSecretVault() });
    const res = await call('/api/secrets', 'POST', { name: 'PW', value: PLANTED });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain(PLANTED);
    expect(stops.count).toBe(0);
  });

  it('forgets a value: stops the server only when something was removed, and recomputes configured', async () => {
    const { call, vault, stops } = await setup({ env: { DAEMONIZE_SECRET_PW: 'from-env' } });
    await vault.set('PW', PLANTED);
    const first = await call('/api/secrets/forget', 'POST', { name: 'PW' });
    expect(first).toEqual({ status: 200, body: { name: 'PW', configured: true } });
    expect(stops.count).toBe(1);
    const second = await call('/api/secrets/forget', 'POST', { name: 'PW' });
    expect(second.status).toBe(200);
    expect(stops.count).toBe(1);
    expect(await vault.has('PW')).toBe(false);
  });

  it('refuses to forget an unknown name or a path form', async () => {
    const { call } = await setup();
    expect((await call('/api/secrets/forget', 'POST', { name: 'NOPE' })).status).toBe(400);
    expect((await call('/api/secrets/forget', 'POST', { name: '..' })).status).toBe(400);
    expect((await call('/api/secrets/forget', 'POST', { name: 'PW', other: 1 })).status).toBe(400);
  });
});
