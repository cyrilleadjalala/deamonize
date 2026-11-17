/** Shared validators for a new action (pure). `ui/js/validate.js` mirrors them. */
import { NAME_CONTROL, NAME_REQUIRED, PLAIN_NAME_INVALID, URL_CREDENTIALS, URL_INVALID, URL_TOO_LONG } from './messages/common.js';

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Trim, 1 to 80 code points, an ASCII letter or digit, no control character. */
export function validateName(input: unknown): Validation<string> {
  if (typeof input !== 'string') return { ok: false, message: NAME_REQUIRED };
  const value = input.trim();
  const length = [...value].length;
  if (length < 1 || length > 80) return { ok: false, message: NAME_REQUIRED };
  if (CONTROL.test(value)) return { ok: false, message: NAME_CONTROL };
  if (!/[A-Za-z0-9]/.test(value)) return { ok: false, message: NAME_REQUIRED };
  return { ok: true, value };
}

/** Trim, at most 2048 characters, absolute http or https, no user name or password. */
export function validateUrl(input: unknown): Validation<string> {
  if (typeof input !== 'string') return { ok: false, message: URL_INVALID };
  const value = input.trim();
  if (value.length > 2048) return { ok: false, message: URL_TOO_LONG };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: URL_INVALID };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: URL_INVALID };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, message: URL_CREDENTIALS };
  return { ok: true, value };
}

/** A plain name: no `..` segment, no absolute path, no NUL, no separator. */
export function plainName(value: unknown): Validation<string> {
  if (typeof value !== 'string' || value === '' || value.length > 300) return { ok: false, message: PLAIN_NAME_INVALID };
  if (value.includes('\0') || /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..') || value === '.') {
    return { ok: false, message: PLAIN_NAME_INVALID };
  }
  return { ok: true, value };
}

/** The normalized origin for an http(s) address, else undefined. */
export function applicationKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
