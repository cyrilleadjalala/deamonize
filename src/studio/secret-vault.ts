/**
 * The Secret_Vault: credentials typed in the Studio, kept in one AES-256-GCM file inside the App_Data_Dir.
 *
 * File: `<App_Data_Dir>/secrets.vault.json`, mode 0600:
 *   { "v": 1, "alg": "aes-256-gcm", "iv": "<base64, 12 bytes>", "tag": "<base64>", "ct": "<base64>" }
 * Plaintext of `ct` is `JSON.stringify({ [name]: value })`; the additional authenticated data is `daemonize-vault-v1`.
 * Each write uses a fresh random IV and goes to `secrets.vault.json.tmp-<random>` (ciphertext only) before a rename.
 * The 256-bit key lives in the operating system's key store (see key-providers.ts), never next to the file.
 * There is no plain-text mode: when the key store or the App_Data_Dir cannot be used, `set` throws
 * VaultUnavailableError and nothing is written.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VaultUnavailableError, VaultUnreadableError, type AppData, type SecretVault } from './contracts.js';
import { InertSecretVault } from './inert-services.js';
import { createKeyProvider, KEY_BYTES, KeyStoreUnavailableError, type KeyProvider } from './key-providers.js';
import { VAULT_FILE, decryptVault, encryptVault, isScopedKey, scopedKey } from '../replay/runtime/vault-format.js';
import { extractTotpSecret, normalizeBase32 } from './totp-secret.js';

export { VAULT_FILE, encryptVault, decryptVault };
/** A vault is a few small values: a bigger file is not one of ours. */
const MAX_VAULT_BYTES = 4 * 1024 * 1024;

export interface SecretVaultDeps {
  appData: AppData;
  /** Defaults to the OS key provider, created on first use with the App_Data_Dir. */
  keyProvider?: KeyProvider;
  env?: Record<string, string | undefined>;
}

export class NullSecretVault extends InertSecretVault { }

interface Cache {
  mtimeMs: number;
  size: number;
  map: Map<string, string>;
}

class FileSecretVault implements SecretVault {
  private cache: Cache | undefined;
  private key: Buffer | undefined;
  private provider: KeyProvider | undefined;
  /** What the Redactor must remove, besides the cached values: the raw inputs stored in this process. */
  private readonly typed = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SecretVaultDeps) {
    this.provider = deps.keyProvider;
  }

  /** One operation at a time: a read never sees half of a write. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private keyProvider(dir: string): KeyProvider {
    if (this.provider === undefined) this.provider = createKeyProvider({ dataDir: dir, env: this.deps.env });
    return this.provider;
  }

  /** The vault file path when the App_Data_Dir is usable (never creates anything). */
  private async dirIfUsable(): Promise<string | undefined> {
    const check = await this.deps.appData.check().catch(() => undefined);
    return check?.ok === true ? check.dir : undefined;
  }

  /** Current contents. Missing file -> empty. Throws VaultUnreadableError when the file exists but cannot be opened. */
  private async load(): Promise<Map<string, string>> {
    const dir = await this.dirIfUsable();
    if (dir === undefined) return new Map();
    const file = join(dir, VAULT_FILE);
    let info;
    try {
      info = await stat(file);
    } catch {
      this.cache = undefined;
      return new Map();
    }
    if (this.cache !== undefined && this.cache.mtimeMs === info.mtimeMs && this.cache.size === info.size) return this.cache.map;
    const unreadable = (): VaultUnreadableError => new VaultUnreadableError('The saved credentials could not be read.');
    if (!info.isFile() || info.size > MAX_VAULT_BYTES) throw unreadable();
    try {
      const text = await readFile(file, 'utf-8');
      let key = this.key;
      if (key === undefined) {
        key = await this.keyProvider(dir).get();
        if (key === undefined) throw unreadable();
        this.key = key;
      }
      const map = decryptVault(key, text);
      this.cache = { mtimeMs: info.mtimeMs, size: info.size, map };
      return map;
    } catch {
      this.cache = undefined;
      throw unreadable();
    }
  }

  private async tryLoad(): Promise<Map<string, string>> {
    try {
      return await this.load();
    } catch {
      return new Map();
    }
  }

  async names(): Promise<ReadonlySet<string>> {
    return this.exclusive(async () => new Set([...(await this.tryLoad())].filter(([n, v]) => v !== '' && !isScopedKey(n)).map(([n]) => n)));
  }

  values(): readonly string[] {
    const out = new Set<string>(this.typed);
    for (const value of this.cache?.map.values() ?? []) {
      if (value === '') continue;
      out.add(value);
      const totp = extractTotpSecret(value) ?? normalizeBase32(value);
      if (totp !== undefined) out.add(totp);
    }
    return [...out];
  }

  async has(name: string): Promise<boolean> {
    return (await this.names()).has(name);
  }

  async snapshot(): Promise<Record<string, string>> {
    return this.exclusive(async () => {
      const map = await this.load();
      const out: Record<string, string> = {};
      for (const [name, value] of map) if (value !== '' && !isScopedKey(name)) out[name] = value;
      return out;
    });
  }

  /** Writes `map` encrypted with `key`: temp file with the final mode, then rename. The old file survives any failure. */
  private async write(dir: string, key: Buffer, map: Map<string, string>): Promise<void> {
    const file = join(dir, VAULT_FILE);
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, JSON.stringify(encryptVault(key, map)), { mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
      const info = await stat(file);
      this.cache = { mtimeMs: info.mtimeMs, size: info.size, map };
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new VaultUnavailableError('The credentials could not be saved on this computer.');
    }
  }

  private async usableDir(): Promise<string> {
    const check = await this.deps.appData.ensure().catch(() => undefined);
    if (check === undefined || !check.ok) throw new VaultUnavailableError('There is no safe place on this computer to keep credentials.');
    return check.dir;
  }

  /** The key of this vault, created when none exists yet. `fresh` is true for a key made now. */
  private async keyForWrite(dir: string): Promise<{ key: Buffer; fresh: boolean }> {
    if (this.key !== undefined) return { key: this.key, fresh: false };
    const provider = this.keyProvider(dir);
    try {
      const found = await provider.get();
      if (found !== undefined) {
        this.key = found;
        return { key: found, fresh: false };
      }
      // No key: a vault file that exists cannot be opened any more and is replaced
      const key = randomBytes(KEY_BYTES);
      await provider.create(key);
      this.key = key;
      return { key, fresh: true };
    } catch (err) {
      if (err instanceof KeyStoreUnavailableError) throw new VaultUnavailableError('The system key store is not available, so credentials cannot be kept safely.');
      throw err;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (isScopedKey(name)) throw new Error('A generic secret name cannot contain "/".');
    return this.putEntry(name, value);
  }

  private async putEntry(entryKey: string, value: string): Promise<void> {
    return this.exclusive(async () => {
      const dir = await this.usableDir();
      const { key, fresh } = await this.keyForWrite(dir);
      // A vault that cannot be opened starts empty, so a valid save repairs it
      let current = new Map<string, string>();
      if (!fresh) current = await this.tryLoad();
      const next = new Map(current);
      next.set(entryKey, value);
      await this.write(dir, key, next);
      this.typed.add(value);
    });
  }

  private async dropEntry(entryKey: string): Promise<boolean> {
    return this.exclusive(async () => {
      const dir = await this.usableDir();
      const current = await this.tryLoad();
      if (!current.has(entryKey) || this.key === undefined) return false;
      const next = new Map(current);
      next.delete(entryKey);
      await this.write(dir, this.key, next);
      return true;
    });
  }

  async remove(name: string): Promise<boolean> {
    if (isScopedKey(name)) return false;
    return this.dropEntry(name);
  }

  async setFor(applicationKey: string, name: string, value: string): Promise<void> {
    if (applicationKey === '' || name === '' || isScopedKey(name)) throw new Error('Invalid application or secret name.');
    if (value === '') throw new Error('A credential cannot be empty.');
    return this.putEntry(scopedKey(applicationKey, name), value);
  }

  async removeFor(applicationKey: string, name: string): Promise<boolean> {
    if (applicationKey === '' || name === '' || isScopedKey(name)) return false;
    return this.dropEntry(scopedKey(applicationKey, name));
  }

  async namesFor(applicationKey: string): Promise<ReadonlySet<string>> {
    return this.exclusive(async () => {
      const prefix = `${applicationKey}/`;
      const out = new Set<string>();
      for (const [n, v] of await this.tryLoad()) {
        if (v === '') continue;
        if (!isScopedKey(n)) out.add(n);
        else if (applicationKey !== '' && n.startsWith(prefix) && !isScopedKey(n.slice(prefix.length))) out.add(n.slice(prefix.length));
      }
      return out;
    });
  }

  async snapshotFor(applicationKey: string): Promise<Record<string, string>> {
    return this.exclusive(async () => {
      const map = await this.load();
      const prefix = `${applicationKey}/`;
      const out: Record<string, string> = {};
      for (const [n, v] of map) if (v !== '' && !isScopedKey(n)) out[n] = v;
      if (applicationKey !== '') for (const [n, v] of map) if (v !== '' && n.startsWith(prefix) && !isScopedKey(n.slice(prefix.length))) out[n.slice(prefix.length)] = v;
      return out;
    });
  }
}

export function createSecretVault(deps: SecretVaultDeps): SecretVault {
  return new FileSecretVault(deps);
}
