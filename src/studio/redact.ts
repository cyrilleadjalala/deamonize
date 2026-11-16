/**
 * Everything the Studio sends passes through `redactForStudio`: a last line of defence behind the view builders,
 * which never copy a typed value, a header, a cookie or a storage state in the first place.
 *
 * It removes credential-carrying keys, replaces every occurrence of a known secret value (the DAEMONIZE_SECRET_*
 * variables of this process, the values found in the storage state file, any value the caller adds) by `***`,
 * replaces whole strings that look like a JWT or a `Bearer ...` credential, and reduces a `storageState`
 * to the basename of its path.
 */
import { basename } from 'node:path';
import { looksLikeSecretValue } from '../recorder/redactor.js';

export const REDACTED = '***';

/** Values shorter than this are not scrubbed: replacing 1 or 2 characters everywhere would destroy every response. */
export const MIN_SECRET_LENGTH = 3;

/** Keys whose value is a credential or a session whatever it holds (header names, storage state members). */
const DROPPED_KEYS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'cookies', 'origins', 'localstorage', 'sessionstorage']);

export interface RedactOptions {
  /** Secret values to remove, in addition to those of the environment. */
  secretValues?: readonly string[];
  /** The environment whose DAEMONIZE_SECRET_* and model key values are removed (default: process.env). */
  env?: Record<string, string | undefined>;
}

/** The values of the environment that must never be shown: secrets and model credentials. */
export function collectEnvSecretValues(env: Record<string, string | undefined> = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (
      name.startsWith('DAEMONIZE_SECRET_') ||
      name === 'DAEMONIZE_COOKIE_HEADER' ||
      name === 'ANTHROPIC_API_KEY' ||
      name === 'OPENAI_API_KEY' ||
      (name.startsWith('DAEMONIZE_MODEL_') && /KEY|TOKEN|SECRET|PASSWORD/i.test(name))
    ) {
      values.push(value);
    }
  }
  return values;
}

/** Every string leaf of a Playwright storage state (cookie values, local storage values), which must never be shown. */
export function storageStateValues(state: unknown): string[] {
  const values = new Set<string>();
  const visit = (node: unknown, key?: string): void => {
    if (typeof node === 'string') {
      // Names of cookies and origins are not secret; values are. Keeping every leaf longer than the minimum is the safe side.
      if (node.length >= MIN_SECRET_LENGTH && key !== 'sameSite') values.add(node);
    } else if (Array.isArray(node)) node.forEach((item) => visit(item, key));
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) visit(v, k);
    }
  };
  visit(state);
  return [...values];
}

/** The scrubbing function for a set of secret values (longest first, so a value inside another is not left half-replaced). */
export function makeScrubber(values: readonly string[]): (text: string) => string {
  const sorted = [...new Set(values.filter((v) => v.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const secret of sorted) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return looksLikeSecretValue(out, false) ? REDACTED : out;
  };
}

/** A deep copy of `value` without credential keys and secret values. */
export function redactForStudio<T>(value: T, options: RedactOptions = {}): T {
  const scrub = makeScrubber([...collectEnvSecretValues(options.env), ...(options.secretValues ?? [])]);
  const seen = new WeakSet<object>();
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      if (key === 'storageState') return basename(node.replace(/\\/g, '/'));
      return scrub(node);
    }
    if (node === null || typeof node !== 'object') return node;
    if (key === 'storageState') return REDACTED;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) return node.map((item) => walk(item));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROPPED_KEYS.has(k.toLowerCase())) continue;
      out[scrub(k)] = walk(v, k);
    }
    seen.delete(node);
    return out;
  };
  return walk(value) as T;
}
