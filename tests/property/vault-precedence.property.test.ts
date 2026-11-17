// Feature: kiro-global-connect-vault-bridge, Property 15: Secret precedence
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptVault, scopedKey, VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import { withResolvedSecrets, type RunProcess } from '../../src/replay/runtime/vault-reader.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';

const APP = 'https://app.example';
const VAR = 'DAEMONIZE_SECRET_PASSWORD';
const key = randomBytes(32);
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-p15-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeDir(entries: Record<string, string>): Promise<string> {
  const dir = join(root, `d${counter++}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, VAULT_FILE), JSON.stringify(encryptVault(key, new Map(Object.entries(entries)))));
  await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
  return dir;
}

const valueArb = fc.string({ minLength: 1, maxLength: 20 });
const explicitArb = fc.oneof(fc.constant(undefined), fc.constant(''), fc.constant('${DAEMONIZE_SECRET_PASSWORD}'), fc.constant('${x}'), valueArb.filter((v) => !(v.startsWith('${') && v.endsWith('}'))));
const optArb = fc.option(valueArb, { nil: undefined });

describe('Property 15: Secret precedence', () => {
  it('explicit > scoped (only with an app key) > generic, and a placeholder or empty value is absent', async () => {
    await fc.assert(
      fc.asyncProperty(explicitArb, optArb, optArb, fc.boolean(), async (explicit, scoped, generic, withApp) => {
        const entries: Record<string, string> = {};
        if (scoped !== undefined) entries[scopedKey(APP, 'PASSWORD')] = scoped;
        if (generic !== undefined) entries.PASSWORD = generic;
        const dir = await makeDir(entries);
        const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', DAEMONIZE_APP_KEY: withApp ? APP : '', ...(explicit === undefined ? {} : { [VAR]: explicit }) };
        const usable = explicit !== undefined && explicit !== '' && !(explicit.startsWith('${') && explicit.endsWith('}'));
        const expected = usable ? explicit : withApp && scoped !== undefined ? scoped : generic;
        const out = await withResolvedSecrets(env, [VAR]);
        expect(out[VAR]).toBe(expected);
        expect(Object.prototype.hasOwnProperty.call(out, VAR)).toBe(expected !== undefined);
        // the input is not mutated
        expect(env[VAR as keyof typeof env]).toBe(explicit);
      }),
      { numRuns: 100 }
    );
  }, 120_000);

  it('touches neither the key store nor the vault when every variable is explicit', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(valueArb.filter((v) => !(v.startsWith('${') && v.endsWith('}'))), { minLength: 1, maxLength: 4 }), async (values) => {
        let calls = 0;
        const run: RunProcess = async () => {
          calls++;
          return { code: 1, stdout: '', stderr: '' };
        };
        const dir = join(root, 'does-not-exist');
        const env: Record<string, string> = { DAEMONIZE_DATA_DIR: dir };
        const names = values.map((_, i) => `DAEMONIZE_SECRET_N${i}`);
        values.forEach((v, i) => (env[names[i]] = v));
        const out = await withResolvedSecrets(env, names, { run });
        names.forEach((n, i) => expect(out[n]).toBe(values[i]));
        expect(calls).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('the Studio vault resolves scoped over generic like the reader', async () => {
    await fc.assert(
      fc.asyncProperty(optArb, optArb, async (scoped, generic) => {
        const dir = join(root, `s${counter++}`);
        await mkdir(dir, { recursive: true });
        let held: Buffer | undefined;
        const provider: KeyProvider = { id: 'm', get: async () => held, create: async (k) => void (held = Buffer.from(k)) };
        const vault = createSecretVault({ appData: { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) }, keyProvider: provider });
        if (generic !== undefined) await vault.set('PASSWORD', generic);
        if (scoped !== undefined) await vault.setFor(APP, 'PASSWORD', scoped);
        expect((await vault.snapshotFor(APP)).PASSWORD).toBe(scoped ?? generic);
      }),
      { numRuns: 100 }
    );
  }, 120_000);
});
