import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptVault, VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import { missingSecrets } from '../../src/replay/runtime/step-plan.js';
import { resolveDataDir, withResolvedSecrets, type RunProcess } from '../../src/replay/runtime/vault-reader.js';

const SECRET = 'Planted-Reader-Secret-55a';
const VAR = 'DAEMONIZE_SECRET_PASSWORD';
const key = randomBytes(32);
const steps = [{ actionType: 'type', secretRef: 'PASSWORD' }] as Parameters<typeof missingSecrets>[0];
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daemonize-reader-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const goodVault = (): string => JSON.stringify(encryptVault(key, new Map([['PASSWORD', SECRET], ['OTHER', 'o'], ['THIRD', 't']])));
const fileEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', ...extra });

async function expectMissing(env: Record<string, string | undefined>): Promise<void> {
  const out = await withResolvedSecrets(env, [VAR]);
  expect(missingSecrets(steps, out)).toEqual([VAR]);
  const serialized = JSON.stringify(missingSecrets(steps, out));
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(key.toString('hex'));
  expect(serialized).not.toContain(dir);
}

describe('vault reader', () => {
  it('(a) key provider unavailable -> missing_secret', async () => {
    await writeFile(join(dir, VAULT_FILE), goodVault());
    await expectMissing(fileEnv({ DAEMONIZE_VAULT_KEY_PROVIDER: 'unavailable' }));
  });

  it('(b) corrupt vault -> missing_secret', async () => {
    await writeFile(join(dir, VAULT_FILE), '{"v":1,"alg":"aes-256-gcm"');
    await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
    await expectMissing(fileEnv());
  });

  it('(c) missing vault -> missing_secret', async () => {
    await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
    await expectMissing(fileEnv());
  });

  it('(d) an Unexpanded_Placeholder is treated as not set', async () => {
    await expectMissing(fileEnv({ [VAR]: '${DAEMONIZE_SECRET_PASSWORD}' }));
  });

  it('(d2) an Unexpanded_Placeholder is replaced by the vault value', async () => {
    await writeFile(join(dir, VAULT_FILE), goodVault());
    await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
    const out = await withResolvedSecrets(fileEnv({ [VAR]: '${DAEMONIZE_SECRET_PASSWORD}' }), [VAR]);
    expect(out[VAR]).toBe(SECRET);
  });

  it('(e) a successful read leaves the vault bytes and modification time unchanged', async () => {
    const file = join(dir, VAULT_FILE);
    await writeFile(file, goodVault());
    await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
    const before = { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs };
    const out = await withResolvedSecrets(fileEnv(), [VAR]);
    expect(out[VAR]).toBe(SECRET);
    expect((await readFile(file)).equals(before.bytes)).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before.mtime);
  });

  it('asks the key store at most once for several variables in one call', async () => {
    await writeFile(join(dir, VAULT_FILE), goodVault());
    await writeFile(join(dir, 'vault.key'), 'blob'); // read by the Windows provider
    let calls = 0;
    const run: RunProcess = async () => {
      calls++;
      return { code: 0, stdout: process.platform === 'win32' ? key.toString('base64') : key.toString('hex'), stderr: '' };
    };
    const out = await withResolvedSecrets({ DAEMONIZE_DATA_DIR: dir }, [VAR, 'DAEMONIZE_SECRET_OTHER', 'DAEMONIZE_SECRET_THIRD'], { run });
    expect(out[VAR]).toBe(SECRET);
    expect(out.DAEMONIZE_SECRET_OTHER).toBe('o');
    expect(out.DAEMONIZE_SECRET_THIRD).toBe('t');
    expect(calls).toBe(1);
  });

  it('ignores the test providers outside NODE_ENV=test', async () => {
    await writeFile(join(dir, VAULT_FILE), goodVault());
    await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const run: RunProcess = async () => ({ code: 1, stdout: '', stderr: '', failure: 'missing' });
      const out = await withResolvedSecrets(fileEnv(), [VAR], { run });
      expect(out[VAR]).toBeUndefined();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('resolveDataDir uses DAEMONIZE_DATA_DIR when non-empty', () => {
    expect(resolveDataDir({ DAEMONIZE_DATA_DIR: dir })).toBe(dir);
    expect(resolveDataDir({ DAEMONIZE_DATA_DIR: 'relative/path' })).toBeUndefined();
  });
});
