/** Mirror of src/studio/validate-action.ts (name and address of a new action). A parity test compares the two. */

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const NAME_REQUIRED = 'Enter a name with 1 to 80 characters, with at least one letter or number.';
const NAME_CONTROL = 'The name cannot contain line breaks or other control characters.';
const URL_INVALID = 'Enter a full web address that starts with http:// or https://.';
const URL_TOO_LONG = 'The web address is too long. Use at most 2048 characters.';
const URL_CREDENTIALS = 'Remove the user name and password from the web address. You can sign in during the recording.';

// eslint-disable-next-line no-control-regex
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
