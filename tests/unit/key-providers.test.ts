import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createKeyProvider, KeyStoreUnavailableError, minimalEnv, type ProcessResult, type RunProcess } from '../../src/studio/key-providers.js';

const KEY = Buffer.from('ab'.repeat(32), 'hex');
const SYNTHETIC = 'DAEMONIZE_SECRET_SYNTHETIC';

interface Seen {
  file: string;
  args: readonly string[];
  input: string;
  env: Record<string, string>;
}
function fakeRun(result: Partial<ProcessResult>, seen: Seen[] = []): RunProcess {
  return async (file, args, options) => {
    seen.push({ file, args, input: options.input, env: options.env });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
}
const env = { PATH: '/bin', HOME: '/home/u', [SYNTHETIC]: 'planted-value', OTHER: 'x' };

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
const tempDir = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'daemonize-kp-'));
  dirs.push(d);
  return d;
};

describe('key providers: no key material on the command line, no studio secrets in the child', () => {
  it('macOS: key on stdin of `security -i`, never in argv', async () => {
    const seen: Seen[] = [];
    const provider = createKeyProvider({ platform: 'darwin', env, run: fakeRun({}, seen) });
    await provider.create(KEY);
    expect(seen[0].args).toEqual(['-i']);
    expect(seen[0].input).toContain(KEY.toString('hex'));
    expect(JSON.stringify(seen[0].args)).not.toContain(KEY.toString('hex'));
    expect(seen[0].env).not.toHaveProperty(SYNTHETIC);
    expect(seen[0].env).not.toHaveProperty('OTHER');
  });

  it('macOS: not found (exit 44) is "no key", other failures are unavailable', async () => {
    expect(await createKeyProvider({ platform: 'darwin', env, run: fakeRun({ code: 44 }) }).get()).toBeUndefined();
    await expect(createKeyProvider({ platform: 'darwin', env, run: fakeRun({ code: 51, stderr: 'locked' }) }).get()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
    const found = await createKeyProvider({ platform: 'darwin', env, run: fakeRun({ stdout: `${KEY.toString('hex')}\n` }) }).get();
    expect(found?.equals(KEY)).toBe(true);
  });

  it('Linux: key on stdin of secret-tool, never in argv', async () => {
    const seen: Seen[] = [];
    await createKeyProvider({ platform: 'linux', env, run: fakeRun({}, seen) }).create(KEY);
    expect(seen[0].file).toBe('secret-tool');
    expect(JSON.stringify(seen[0].args)).not.toContain(KEY.toString('hex'));
    expect(seen[0].input).toBe(KEY.toString('hex'));
    expect(seen[0].env).not.toHaveProperty(SYNTHETIC);
  });

  it('Linux: empty exit 1 is "no key"; a missing binary or any stderr is unavailable', async () => {
    expect(await createKeyProvider({ platform: 'linux', env, run: fakeRun({ code: 1 }) }).get()).toBeUndefined();
    await expect(createKeyProvider({ platform: 'linux', env, run: fakeRun({ code: null, failure: 'missing' }) }).get()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
    await expect(createKeyProvider({ platform: 'linux', env, run: fakeRun({ code: 1, stderr: 'no dbus' }) }).get()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
  });

  it('Windows: key on stdin of powershell.exe, blob in vault.key, no secret in the child env', async () => {
    const dir = await tempDir();
    const seen: Seen[] = [];
    const provider = createKeyProvider({ platform: 'win32', dataDir: dir, env: { ...env, SystemRoot: 'C:\\Windows' }, run: fakeRun({ stdout: 'QkxPQg==' }, seen) });
    expect(await provider.get()).toBeUndefined();
    await provider.create(KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toBe(KEY.toString('base64'));
    expect(JSON.stringify(seen[0].args)).not.toContain(KEY.toString('base64'));
    expect(seen[0].env).not.toHaveProperty(SYNTHETIC);
    expect(await readFile(join(dir, 'vault.key'), 'utf-8')).toBe('QkxPQg==');
  });

  it('Windows: a failing powershell is unavailable, never a plain-text fallback', async () => {
    const dir = await tempDir();
    const provider = createKeyProvider({ platform: 'win32', dataDir: dir, env, run: fakeRun({ code: 1 }) });
    await expect(provider.create(KEY)).rejects.toBeInstanceOf(KeyStoreUnavailableError);
    await expect(readFile(join(dir, 'vault.key'))).rejects.toThrow();
  });

  it('minimalEnv keeps only the allow-list', () => {
    expect(minimalEnv(env)).toEqual({ PATH: '/bin', HOME: '/home/u' });
  });
});

describe('DAEMONIZE_VAULT_KEY_PROVIDER', () => {
  it('is honoured under NODE_ENV=test', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const provider = createKeyProvider({ env: { DAEMONIZE_VAULT_KEY_PROVIDER: 'memory' } });
    expect(provider.id).toBe('test-memory');
    await provider.create(KEY);
    expect((await provider.get())?.equals(KEY)).toBe(true);
    await expect(createKeyProvider({ env: { DAEMONIZE_VAULT_KEY_PROVIDER: 'unavailable' } }).get()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
  });

  it('is ignored under any other NODE_ENV', () => {
    for (const mode of ['production', 'development', '']) {
      vi.stubEnv('NODE_ENV', mode);
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const provider = createKeyProvider({ platform, env: { DAEMONIZE_VAULT_KEY_PROVIDER: 'memory' } });
        expect(provider.id).not.toMatch(/^test-/);
      }
    }
  });

  it('file provider keeps the key in vault.key.test across instances', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const dir = await tempDir();
    const options = { dataDir: dir, env: { DAEMONIZE_VAULT_KEY_PROVIDER: 'file' } };
    await createKeyProvider(options).create(KEY);
    expect((await createKeyProvider(options).get())?.equals(KEY)).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows DPAPI (real powershell.exe)', () => {
  it('protects and unprotects a key round trip, with the key on stdin only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const dir = await tempDir();
    const key = randomBytes(32);
    const provider = createKeyProvider({ platform: 'win32', dataDir: dir, env: process.env });
    expect(await provider.get()).toBeUndefined();
    await provider.create(key);
    const blob = await readFile(join(dir, 'vault.key'), 'utf-8');
    expect(blob).not.toContain(key.toString('base64'));
    expect(Buffer.from(blob.trim(), 'base64').includes(key)).toBe(false);
    const again = await createKeyProvider({ platform: 'win32', dataDir: dir, env: process.env }).get();
    expect(again?.equals(key)).toBe(true);
  }, 60_000);
});
