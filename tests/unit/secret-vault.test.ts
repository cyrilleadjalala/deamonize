import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppData } from '../../src/studio/app-data.js';
import { VaultUnavailableError, VaultUnreadableError, type AppData } from '../../src/studio/contracts.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { KeyStoreUnavailableError, type KeyProvider } from '../../src/studio/key-providers.js';

const PLANTED = 'Planted-Vault-Value-91f3';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'daemonize-vault-'));
  dirs.push(d);
  return d;
}
const appDataAt = (dir: string): AppData => ({ dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) });
function memoryProvider(): KeyProvider & { key: Buffer | undefined; fail: boolean } {
  const p = {
    id: 'mem',
    key: undefined as Buffer | undefined,
    fail: false,
    async get() {
      if (p.fail) throw new KeyStoreUnavailableError('x');
      return p.key;
    },
    async create(key: Buffer) {
      if (p.fail) throw new KeyStoreUnavailableError('x');
      p.key = key;
    },
  };
  return p;
}

describe('secret vault', () => {
  it('round trips values, keeps only ciphertext on disk and the file mode private', async () => {
    const dir = await tempDir();
    const provider = memoryProvider();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    await vault.set('CRM', PLANTED);
    await vault.set('OTP', 'JBSWY3DPEHPK3PXP');
    expect(await vault.snapshot()).toEqual({ CRM: PLANTED, OTP: 'JBSWY3DPEHPK3PXP' });
    expect([...(await vault.names())].sort()).toEqual(['CRM', 'OTP']);
    expect(await vault.has('CRM')).toBe(true);
    expect(vault.values()).toContain(PLANTED);

    const text = await readFile(join(dir, 'secrets.vault.json'), 'utf-8');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(['alg', 'ct', 'iv', 'tag', 'v']);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain('CRM');
    if (process.platform !== 'win32') expect((await stat(join(dir, 'secrets.vault.json'))).mode & 0o777).toBe(0o600);

    // A second instance with the same key provider reads the same file
    const again = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    expect(await again.snapshot()).toEqual({ CRM: PLANTED, OTP: 'JBSWY3DPEHPK3PXP' });
    expect(await again.remove('CRM')).toBe(true);
    expect(await again.remove('CRM')).toBe(false);
    expect(await again.snapshot()).toEqual({ OTP: 'JBSWY3DPEHPK3PXP' });
  });

  it('uses a fresh IV for every write and leaves no temporary file', async () => {
    const dir = await tempDir();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: memoryProvider() });
    await vault.set('A', 'value-1');
    const first = JSON.parse(await readFile(join(dir, 'secrets.vault.json'), 'utf-8')).iv;
    await vault.set('A', 'value-1');
    const second = JSON.parse(await readFile(join(dir, 'secrets.vault.json'), 'utf-8')).iv;
    expect(first).not.toBe(second);
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('reports a tampered file as unreadable and never throws from names()', async () => {
    const dir = await tempDir();
    const provider = memoryProvider();
    await createSecretVault({ appData: appDataAt(dir), keyProvider: provider }).set('A', PLANTED);
    const file = join(dir, 'secrets.vault.json');
    const env = JSON.parse(await readFile(file, 'utf-8'));
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] ^= 0xff;
    await writeFile(file, JSON.stringify({ ...env, ct: ct.toString('base64') }));
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    await expect(vault.snapshot()).rejects.toBeInstanceOf(VaultUnreadableError);
    expect((await vault.names()).size).toBe(0);
    // A later valid save repairs it
    await vault.set('B', 'fresh-value');
    expect(await vault.snapshot()).toEqual({ B: 'fresh-value' });
  });

  it('reports a missing key as unreadable, and a new save starts a new vault', async () => {
    const dir = await tempDir();
    await createSecretVault({ appData: appDataAt(dir), keyProvider: memoryProvider() }).set('A', PLANTED);
    const lost = memoryProvider();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: lost });
    await expect(vault.snapshot()).rejects.toBeInstanceOf(VaultUnreadableError);
    await vault.set('A', 'new-value');
    expect(await vault.snapshot()).toEqual({ A: 'new-value' });
  });

  it('answers {} and no names when there is no vault file, without needing the key', async () => {
    const dir = await tempDir();
    const provider = memoryProvider();
    provider.fail = true;
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    expect(await vault.snapshot()).toEqual({});
    expect((await vault.names()).size).toBe(0);
  });

  it('throws VaultUnavailableError when the key store fails and keeps the old values and no plain text', async () => {
    const dir = await tempDir();
    const provider = memoryProvider();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    await vault.set('A', 'old-value');
    const before = await readFile(join(dir, 'secrets.vault.json'), 'utf-8');
    // The key store is gone, and so is the process cache (a new instance)
    provider.fail = true;
    const other = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
    await expect(other.set('A', 'new-value')).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(await readFile(join(dir, 'secrets.vault.json'), 'utf-8')).toBe(before);
    expect(await readdir(dir)).toEqual(['secrets.vault.json']);
  });

  it('throws VaultUnavailableError when the folder cannot be written, and writes nothing', async () => {
    const dir = await tempDir();
    const missing = join(dir, 'missing', 'deeper');
    const broken: AppData = { dir: missing, ensure: async () => ({ ok: true, dir: missing }), check: async () => ({ ok: true, dir: missing }) };
    await expect(createSecretVault({ appData: broken, keyProvider: memoryProvider() }).set('A', 'x')).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('answers 503-class errors and creates nothing when the App_Data_Dir is excluded (Property 15, vault half)', async () => {
    const inside = join(process.cwd(), '.vault-excluded-test');
    const appData = createAppData({ cwd: process.cwd(), outDir: join(tmpdir(), 'x-out'), env: { DAEMONIZE_DATA_DIR: inside } });
    const vault = createSecretVault({ appData, keyProvider: memoryProvider() });
    await expect(vault.set('A', PLANTED)).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(existsSync(inside)).toBe(false);
    expect((await vault.names()).size).toBe(0);
    expect(vault.values()).toEqual([]);
  });

  it('adds the normalized TOTP key of a stored value to values()', async () => {
    const dir = await tempDir();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: memoryProvider() });
    await vault.set('OTP', 'jbsw y3dp ehpk 3pxp');
    expect(vault.values()).toContain('JBSWY3DPEHPK3PXP');
  });
});
