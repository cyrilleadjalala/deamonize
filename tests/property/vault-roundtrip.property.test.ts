// Feature: kiro-global-connect-vault-bridge, Property 16: Studio write then reader read round trip
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { createKeyProvider } from '../../src/studio/key-providers.js';
import { withResolvedSecrets } from '../../src/replay/runtime/vault-reader.js';

const APP = 'https://rt.example:8443';
let root: string;
let counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-p16-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/);
const valueArb = fc.oneof(
  fc.fullUnicodeString({ minLength: 1, maxLength: 60 }),
  fc.constantFrom('with "quotes" and \'single\'', '  leading and trailing  ', 'tab\tnew\nline', '日本語パスワード 🔐'),
  fc.string({ minLength: 1000, maxLength: 3000 })
);

describe('Property 16: Studio write then reader read round trip', () => {
  it('the reader returns exactly what the Studio stored, generic and scoped', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, nameArb, valueArb, valueArb, async (genericName, scopedName, genericValue, scopedValue) => {
        fc.pre(genericName !== scopedName);
        const dir = join(root, `d${counter++}`);
        await mkdir(dir, { recursive: true });
        const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file' };
        const vault = createSecretVault({
          appData: { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) },
          keyProvider: createKeyProvider({ dataDir: dir, env }),
        });
        await vault.set(genericName, genericValue);
        await vault.setFor(APP, scopedName, scopedValue);
        const g = `DAEMONIZE_SECRET_${genericName}`;
        const s = `DAEMONIZE_SECRET_${scopedName}`;
        const out = await withResolvedSecrets({ ...env, DAEMONIZE_APP_KEY: APP }, [g, s]);
        expect(out[g]).toBe(genericValue);
        expect(out[s]).toBe(scopedValue);
        // without an application key the scoped value is not visible
        const bare = await withResolvedSecrets(env, [g, s]);
        expect(bare[g]).toBe(genericValue);
        expect(bare[s]).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
