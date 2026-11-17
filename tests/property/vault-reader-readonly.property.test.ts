// Feature: kiro-global-connect-vault-bridge, Property 18: The reader is read-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptVault, scopedKey, VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import { withResolvedSecrets } from '../../src/replay/runtime/vault-reader.js';

const APP = 'https://ro.example';
const key = randomBytes(32);
let root: string;
let counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-p18-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function snapshot(dir: string): Promise<Array<[string, string, number]>> {
  const out: Array<[string, string, number]> = [];
  for (const name of (await readdir(dir)).sort()) {
    const file = join(dir, name);
    out.push([name, (await readFile(file)).toString('base64'), (await stat(file)).mtimeMs]);
  }
  return out;
}

describe('Property 18: The reader is read-only', () => {
  it('bytes, modification times and the directory listing do not change', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/), fc.string({ minLength: 1, maxLength: 20 }), { maxKeys: 4 }),
        fc.constantFrom<'good' | 'corrupt' | 'missing' | 'nokey'>('good', 'corrupt', 'missing', 'nokey'),
        fc.boolean(),
        async (entries, state, withApp) => {
          const dir = join(root, `d${counter++}`);
          await mkdir(dir, { recursive: true });
          const map = new Map<string, string>();
          for (const [k, v] of Object.entries(entries)) {
            map.set(k, v);
            map.set(scopedKey(APP, k), `${v}-scoped`);
          }
          if (state === 'good' || state === 'nokey') await writeFile(join(dir, VAULT_FILE), JSON.stringify(encryptVault(key, map)));
          if (state === 'corrupt') await writeFile(join(dir, VAULT_FILE), '{"v":1,');
          if (state !== 'nokey') await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
          const before = await snapshot(dir);
          const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', DAEMONIZE_APP_KEY: withApp ? APP : '' };
          await withResolvedSecrets(env, [...Object.keys(entries), 'MISSING'].map((n) => `DAEMONIZE_SECRET_${n}`));
          expect(await snapshot(dir)).toEqual(before);
        }
      ),
      { numRuns: 100 }
    );
  }, 120_000);
});
