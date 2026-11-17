// Feature: kiro-global-connect-vault-bridge, Property 20: No stored value appears outside the vault
// Validates: Requirements 6.5, 6.8, 8.11 (secrets half: routes never answer with a stored value, key or vault path)
import { afterAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretRoutes } from '../../src/studio/routes/secrets.js';
import type { RouteContext, RouteDef, RouteResponse } from '../../src/studio/routes/types.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { InertSecretVault } from '../../src/studio/inert-services.js';
import { VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import type { AppData, SecretVault } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';
import type { WorkflowSet } from '../../src/types.js';

vi.setConfig({ testTimeout: 120000 });
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const secretValue = fc.stringMatching(/^[A-Za-z0-9]{16}$/).map((s) => `Zq-${s}`);
const appOrigin = fc.constantFrom('https://a.example', 'https://b.example:8443', 'http://localhost:3000');

const set = {
  version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://a.example',
  workflows: [{ id: 'a', label: 'A', steps: [{ actionType: 'type', selectors: [], secretRef: 'PW' }] }],
} as unknown as WorkflowSet;

async function build(vault: SecretVault | undefined, dir: string, application: string) {
  const resolved =
    vault ??
    (() => {
      const appData: AppData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
      let key: Buffer | undefined;
      const provider: KeyProvider = { id: 'mem', get: async () => key, create: async (k) => void (key = k) };
      return createSecretVault({ appData, keyProvider: provider });
    })();
  const ctx = {
    services: { vault: resolved },
    playground: { serverStarted: false, stopNow: async () => undefined },
    sample: false,
    loadSet: async () => ({ set, outputs: {} }),
    activeApplication: async () => ({ applicationKey: application, slug: 'app', outDir: dir, legacy: false }),
    configuredSecretVariables: async () => new Set(await resolved.namesFor(application).then((n) => [...n].map((x) => `DAEMONIZE_SECRET_${x}`))),
    studioEnv: {},
  } as unknown as RouteContext;
  const routes = new Map<string, RouteDef>(secretRoutes(ctx).map((r) => [r.path, r]));
  const call = (path: string, method: 'GET' | 'POST', body: Record<string, unknown> = {}, query = ''): Promise<RouteResponse> =>
    routes.get(path)!.handlers[method]!({ method, query: new URLSearchParams(query), body, signal: new AbortController().signal });
  return { call };
}

describe('Property 20: secrets responses never hold a stored value', () => {
  it('no answer holds the value, a key or the vault path, and no file but the vault holds the value', async () => {
    await fc.assert(
      fc.asyncProperty(secretValue, appOrigin, fc.boolean(), async (value, application, scoped) => {
        const dir = await mkdtemp(join(tmpdir(), 'daemonize-p20-'));
        tmpDirs.push(dir);
        const { call } = await build(undefined, dir, application);
        const body = scoped ? { name: 'PW', value, application } : { name: 'PW', value };
        const answers: RouteResponse[] = [
          await call('/api/secrets', 'POST', body),
          await call('/api/secrets', 'GET', {}, scoped ? `application=${encodeURIComponent(application)}` : ''),
          await call('/api/secrets', 'POST', { name: 'PW', value, application: 'not an origin' }),
          await call('/api/secrets', 'POST', { name: 'PW', value: '', application }),
          await call('/api/secrets/forget', 'POST', scoped ? { name: 'PW', application } : { name: 'PW' }),
          await call('/api/secrets/forget', 'POST', { name: 'PW', application: 'nope' }),
        ];
        const bad = await build(new InertSecretVault(), dir, application);
        answers.push(await bad.call('/api/secrets', 'POST', body));
        const text = JSON.stringify(answers);
        expect(text).not.toContain(value);
        expect(text).not.toContain(VAULT_FILE);
        expect(text).not.toContain(dir);
        expect(answers[0].status).toBe(200);
        expect(answers[6].status).toBe(503);
        for (const name of await readdir(dir)) {
          if (name === VAULT_FILE) continue;
          expect(await readFile(join(dir, name), 'utf-8').catch(() => '')).not.toContain(value);
        }
      }),
      { numRuns: 100 }
    );
  });
});
