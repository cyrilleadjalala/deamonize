// @ts-check
/**
 * Mirror of `src/studio/validate-action.ts` for the new-action form. A test checks that both give the same verdict for
 * every pair of strings. The messages are the same plain-language texts as `src/studio/messages/common.ts`.
 */

const NAME_REQUIRED = 'Enter a name with 1 to 80 characters, with at least one letter or number.';
const NAME_CONTROL = 'The name cannot contain line breaks or other control characters.';
const URL_INVALID = 'Enter a full web address that starts with http:// or https://.';
const URL_TOO_LONG = 'The web address is too long. Use at most 2048 characters.';
const URL_CREDENTIALS = 'Remove the user name and password from the web address. You can sign in during the recording.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** @typedef {{ ok: true, value: string } | { ok: false, message: string }} Validation */

/** Trim, 1 to 80 code points, an ASCII letter or digit, no control character. @param {unknown} input @returns {Validation} */
export function validateName(input) {
  if (typeof input !== 'string') return { ok: false, message: NAME_REQUIRED };
  const value = input.trim();
  const length = [...value].length;
  if (length < 1 || length > 80) return { ok: false, message: NAME_REQUIRED };
  if (CONTROL.test(value)) return { ok: false, message: NAME_CONTROL };
  if (!/[A-Za-z0-9]/.test(value)) return { ok: false, message: NAME_REQUIRED };
  return { ok: true, value };
}

/** Trim, at most 2048 characters, absolute http or https, no user name or password. @param {unknown} input @returns {Validation} */
export function validateUrl(input) {
  if (typeof input !== 'string') return { ok: false, message: URL_INVALID };
  const value = input.trim();
  if (value.length > 2048) return { ok: false, message: URL_TOO_LONG };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: URL_INVALID };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: URL_INVALID };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, message: URL_CREDENTIALS };
  return { ok: true, value };
}

/** The normalized origin of an http(s) address, else undefined. Only this leaves the page when a saved session is looked up. @param {string} url */
export function applicationKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
