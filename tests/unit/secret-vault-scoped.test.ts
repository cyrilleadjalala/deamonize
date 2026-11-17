import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSecretVault, encryptVault, VAULT_FILE } from '../../src/studio/secret-vault.js';
import type { AppData } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';

const APP = 'https://x.example';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup(initialKey?: Buffer): Promise<{ dir: string; vault: ReturnType<typeof createSecretVault> }> {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-scoped-'));
  dirs.push(dir);
  let held = initialKey;
  const keyProvider: KeyProvider = { id: 'm', get: async () => held, create: async (k) => void (held = Buffer.from(k)) };
  const appData: AppData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
  return { dir, vault: createSecretVault({ appData, keyProvider }) };
}

describe('scoped secret vault entries', () => {
  it('reads and updates a vault written before scoped entries existed', async () => {
    const key = randomBytes(32);
    const { dir, vault } = await setup(key);
    await writeFile(join(dir, VAULT_FILE), JSON.stringify(encryptVault(key, new Map([['PASSWORD', 'old']]))));
    expect(await vault.snapshot()).toEqual({ PASSWORD: 'old' });
    expect((await vault.snapshotFor(APP)).PASSWORD).toBe('old');
    await vault.setFor(APP, 'PASSWORD', 'new');
    expect(await vault.snapshot()).toEqual({ PASSWORD: 'old' });
    expect(await vault.snapshotFor(APP)).toEqual({ PASSWORD: 'new' });
  });

  it('refuses an empty scoped value and a name with a slash', async () => {
    const { vault } = await setup();
    await expect(vault.setFor(APP, 'PASSWORD', '')).rejects.toThrow();
    await expect(vault.setFor(APP, 'A/B', 'x')).rejects.toThrow();
    expect([...(await vault.namesFor(APP))]).toEqual([]);
  });

  it('values() covers generic and scoped values and the files hold no plaintext', async () => {
    const { dir, vault } = await setup();
    await vault.set('G', 'generic-value-1');
    await vault.setFor(APP, 'S', 'scoped-value-2');
    expect(vault.values()).toEqual(expect.arrayContaining(['generic-value-1', 'scoped-value-2']));
    const text = await readFile(join(dir, VAULT_FILE), 'utf-8');
    expect(text).not.toContain('scoped-value-2');
    expect(text).not.toContain(APP);
    expect([...(await vault.names())]).toEqual(['G']);
    expect([...(await vault.namesFor(APP))].sort()).toEqual(['G', 'S']);
  });
});
