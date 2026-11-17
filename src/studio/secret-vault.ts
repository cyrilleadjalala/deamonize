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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VaultUnavailableError, VaultUnreadableError, type AppData, type SecretVault } from './contracts.js';
import { InertSecretVault } from './inert-services.js';
import { createKeyProvider, KEY_BYTES, KeyStoreUnavailableError, type KeyProvider } from './key-providers.js';
import { extractTotpSecret, normalizeBase32 } from './totp-secret.js';

export const VAULT_FILE = 'secrets.vault.json';
const AAD = Buffer.from('daemonize-vault-v1', 'utf-8');
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

interface Envelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
}

export function encryptVault(key: Buffer, map: ReadonlyMap<string, string>): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(map)), 'utf-8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Throws when the envelope is malformed, the key is wrong, or the bytes were changed. */
export function decryptVault(key: Buffer, text: string): Map<string, string> {
  const env = JSON.parse(text) as Partial<Envelope> | null;
  if (env === null || typeof env !== 'object' || env.v !== 1 || env.alg !== 'aes-256-gcm' || typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.ct !== 'string') {
    throw new Error('not a vault');
  }
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('not a vault');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf-8');
  const parsed = JSON.parse(plain) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a vault');
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) if (typeof value === 'string') map.set(name, value);
  return map;
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
    return this.exclusive(async () => new Set([...(await this.tryLoad())].filter(([, v]) => v !== '').map(([n]) => n)));
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
      for (const [name, value] of map) if (value !== '') out[name] = value;
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
    return this.exclusive(async () => {
      const dir = await this.usableDir();
      const { key, fresh } = await this.keyForWrite(dir);
      // A vault that cannot be opened starts empty, so a valid save repairs it
      let current = new Map<string, string>();
      if (!fresh) current = await this.tryLoad();
      const next = new Map(current);
      next.set(name, value);
      await this.write(dir, key, next);
      this.typed.add(value);
    });
  }

  async remove(name: string): Promise<boolean> {
    return this.exclusive(async () => {
      const dir = await this.usableDir();
      const current = await this.tryLoad();
      if (!current.has(name) || this.key === undefined) return false;
      const next = new Map(current);
      next.delete(name);
      await this.write(dir, this.key, next);
      return true;
    });
  }
}

export function createSecretVault(deps: SecretVaultDeps): SecretVault {
  return new FileSecretVault(deps);
}
