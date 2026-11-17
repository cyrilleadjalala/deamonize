/**
 * The format of the Daemonize secret vault, shared by the Studio (writer) and the generated runtime (reader).
 * Pure: imports only node:crypto. Copied verbatim next to `vault-reader.ts` in every output folder.
 *
 * File `secrets.vault.json`: { v: 1, alg: 'aes-256-gcm', iv, tag, ct } (base64), AAD `daemonize-vault-v1`.
 * Plaintext of `ct` is a JSON object `name -> value`. A scoped entry has the key `<origin>/<NAME>`;
 * a generic name never contains `/`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const VAULT_FILE = 'secrets.vault.json';
export const VAULT_AAD = 'daemonize-vault-v1';
export const KEY_BYTES = 32;
export const KEY_SERVICE = 'daemonize-studio-vault-v1';
export const LINUX_KEY_ATTRS: readonly string[] = ['service', 'daemonize-studio', 'account', 'vault-key-v1'];

const PS_PREAMBLE = `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Security\n$e=[Text.Encoding]::UTF8.GetBytes('${KEY_SERVICE}')\n$i=[Console]::In.ReadToEnd().Trim()\n$b=[Convert]::FromBase64String($i)\n`;
const encodeScript = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');
/** stdin = base64 key, stdout = base64 blob */
export const DPAPI_PROTECT: string = encodeScript(`${PS_PREAMBLE}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))`);
/** stdin = base64 blob, stdout = base64 key */
export const DPAPI_UNPROTECT: string = encodeScript(`${PS_PREAMBLE}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))`);

export interface VaultEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
}

const AAD = Buffer.from(VAULT_AAD, 'utf-8');

export function encryptVault(key: Buffer, map: ReadonlyMap<string, string>): VaultEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(map)), 'utf-8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Throws when the envelope is malformed, the key is wrong, or the bytes were changed. */
export function decryptVault(key: Buffer, text: string): Map<string, string> {
  const env = JSON.parse(text) as Partial<VaultEnvelope> | null;
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

/** `https://host:port` + `/` + NAME. */
export function scopedKey(applicationKey: string, name: string): string {
  return `${applicationKey}/${name}`;
}

/** A generic key never contains `/`. */
export function isScopedKey(key: string): boolean {
  return key.includes('/');
}

/** Throws on a key that is not 64 hex characters. */
export function parseHexKey(text: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('bad key');
  return Buffer.from(hex, 'hex');
}

/** `${...}`: a client that did not expand the variable passes the text through. */
export function isUnexpandedPlaceholder(value: string | undefined): boolean {
  return value !== undefined && value.startsWith('${') && value.endsWith('}');
}

const SECRET_PREFIX = 'DAEMONIZE_SECRET_';
/** `DAEMONIZE_SECRET_PASSWORD` -> `PASSWORD`; undefined for any other name. */
export function secretNameOf(variable: string): string | undefined {
  return variable.startsWith(SECRET_PREFIX) && variable.length > SECRET_PREFIX.length ? variable.slice(SECRET_PREFIX.length) : undefined;
}

export interface SecretCandidates {
  explicit?: string;
  scoped?: string;
  generic?: string;
}

/** First candidate with at least 1 character; an explicit placeholder counts as absent. */
export function pickSecret(c: SecretCandidates): string | undefined {
  if (c.explicit !== undefined && c.explicit !== '' && !isUnexpandedPlaceholder(c.explicit)) return c.explicit;
  if (c.scoped !== undefined && c.scoped !== '') return c.scoped;
  if (c.generic !== undefined && c.generic !== '') return c.generic;
  return undefined;
}
