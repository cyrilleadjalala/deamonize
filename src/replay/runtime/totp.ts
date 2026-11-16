/**
 * RFC 6238 time-based one-time passwords, with node:crypto only. Copied verbatim into the
 * output directory like the other run-time modules, so it imports nothing from src/.
 */

import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  /** The instant to compute the code for, in milliseconds since the epoch (default: now). Injectable for tests. */
  timeMs?: number;
  /** 6 to 8 digits (default 6). */
  digits?: number;
  /** Length of a time step in seconds (default 30). */
  period?: number;
  /** HMAC hash (default SHA1, the one every authenticator app uses). */
  algorithm?: TotpAlgorithm;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 (RFC 4648) secret. Spaces, dashes, lowercase and `=` padding are tolerated;
 * any other character is an error (its value is never put in the message).
 */
export function decodeBase32(text: string): Buffer {
  const clean = text.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (clean === '') throw new Error('the TOTP secret is empty');
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error('the TOTP secret is not valid base32');
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** The TOTP code of a base32 secret at `timeMs`, zero-padded to `digits`. */
export function totp(secretBase32: string, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const algorithm = options.algorithm ?? 'SHA1';
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error('digits must be 6, 7 or 8');
  if (!Number.isInteger(period) || period < 1) throw new Error('period must be a positive integer');

  const key = decodeBase32(secretBase32);
  const counter = Math.floor((options.timeMs ?? Date.now()) / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}
