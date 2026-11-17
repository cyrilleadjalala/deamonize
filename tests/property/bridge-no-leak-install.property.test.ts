// Feature: kiro-global-connect-vault-bridge, Property 20: No stored value appears outside the vault
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFile } from 'node:fs/promises';
import type { SecretVault, StudioServices } from '../../src/studio/contracts.js';
import { powerRoutes } from '../../src/studio/routes/power.js';
import type { RouteContext, RouteRequest, RouteResponse } from '../../src/studio/routes/types.js';
import { createHarness, previewRequest, realVaultIn, scopeArb, snapshotTree, writeSettings, kiroDirOf, type Harness } from '../helpers/power-fixture.js';
import { withEnv } from '../helpers/with-env.js';
import { removeDir } from '../helpers/cleanup.js';

const APP_KEY = 'https://leak.example';
// A recognisable prefix keeps a random value from appearing in a path by accident
const secretArb = fc.stringMatching(/^[A-Za-z0-9]{12,24}$/).map((s) => `Zq9-${s}`);

/** Every file below the Kiro folders, as text. */
async function kiroTexts(h: Harness): Promise<string[]> {
  const texts: string[] = [];
  for (const dir of [h.kiroGlobal, h.kiroProject]) {
    for (const line of await snapshotTree(dir)) if (!line.endsWith('/')) texts.push(await readFile(line.slice(0, line.lastIndexOf(':')), 'utf-8'));
  }
  return texts;
}

describe('Property 20: No stored value appears outside the vault (install half)', () => {
  it('responses of the Power routes and every file written or kept hold no stored value', async () => {
    // **Validates: Requirements 8.5, 8.6, 8.11**
    await withEnv({ NODE_ENV: 'test', DAEMONIZE_VAULT_KEY_PROVIDER: 'file' }, async () => {
      await fc.assert(
        fc.asyncProperty(secretArb, secretArb, scopeArb, fc.boolean(), async (password, totp, scope, existing) => {
          fc.pre(password !== totp);
          const h = await createHarness({ applicationKey: APP_KEY, vault: (dir) => realVaultIn(dir) });
          try {
            const vault = h.vault as SecretVault;
            await vault.setFor(APP_KEY, 'PASSWORD', password);
            await vault.set('TOTP', totp);
            if (existing) await writeSettings(kiroDirOf(h, scope), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
            const power = h.installer;
            const routes = powerRoutes({ services: { power } as unknown as StudioServices } as RouteContext);
            const post = (path: string, body: Record<string, unknown>): Promise<RouteResponse> =>
              routes.find((r) => r.path === path)!.handlers.POST!({ method: 'POST', query: new URLSearchParams(), body, signal: new AbortController().signal } as RouteRequest);
            const get = (path: string): Promise<RouteResponse> =>
              routes.find((r) => r.path === path)!.handlers.GET!({ method: 'GET', query: new URLSearchParams(), body: {}, signal: new AbortController().signal } as RouteRequest);

            const answers: unknown[] = [];
            answers.push(await get('/api/power/info'));
            const preview = await post('/api/power/preview', previewRequest(h, scope));
            answers.push(preview);
            const body = preview.body as { confirmationId: string; kiroPath: string };
            answers.push(await post('/api/power/install', { confirmationId: body.confirmationId, kiroPath: body.kiroPath, scope, autoAdd: true }));
            answers.push(await get('/api/power/snippet'));
            answers.push(await get('/api/power/auto-add'));
            answers.push(await power.runAutoAdd());
            answers.push(await post('/api/power/auto-add', { enabled: false }));
            // a refused request carries a message, not a value
            answers.push(await post('/api/power/install', { confirmationId: 'nope', kiroPath: 'x', scope }));
            // files kept while installed
            const texts = [...(await kiroTexts(h)), JSON.stringify(answers)];
            for (const text of texts) for (const value of [password, totp]) expect(text).not.toContain(value);
            answers.push(await post('/api/power/remove', { scope }));
            for (const text of [...(await kiroTexts(h)), JSON.stringify(answers)]) for (const value of [password, totp]) expect(text).not.toContain(value);
            // the vault itself still has the values
            expect(((await vault.snapshotFor(APP_KEY)) as Record<string, string>).PASSWORD).toBe(password);
          } finally {
            await removeDir(h.base);
          }
        }),
        { numRuns: 100 }
      );
    });
  }, 300_000);
});
