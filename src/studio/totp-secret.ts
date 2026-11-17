/**
 * Input of a TOTP secret: a Base32 key (spaces, dashes, padding and lower case tolerated) or an `otpauth://totp/...`
 * address that holds one `secret` parameter. Pure; nothing here logs or returns anything but the normalized key.
 */

/** Removes whitespace and dashes and trailing `=`, upper-cases; undefined unless the rest is at least 3 Base32 characters. */
export function normalizeBase32(text: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  return /^[A-Z2-7]{3,}$/.test(cleaned) ? cleaned : undefined;
}

const OTPAUTH = /^otpauth:\/\/([^/?#]*)([^?#]*)\?([^#]*)/i;

/** The normalized Base32 key of a plain key or an otpauth address; undefined when the value is not a valid TOTP secret. */
export function extractTotpSecret(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^otpauth:/i.test(trimmed)) {
    const match = OTPAUTH.exec(trimmed);
    if (match === null) return undefined;
    if (match[1].toLowerCase() !== 'totp') return undefined;
    let secrets: string[];
    try {
      secrets = new URLSearchParams(match[3]).getAll('secret');
    } catch {
      return undefined;
    }
    return secrets.length === 1 ? normalizeBase32(secrets[0]) : undefined;
  }
  return normalizeBase32(trimmed);
}
