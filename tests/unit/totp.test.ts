import { describe, it, expect } from 'vitest';
import { decodeBase32, totp, type TotpAlgorithm } from '../../src/replay/runtime/totp.js';
import { resolveStepValue, secretValues } from '../../src/replay/runtime/step-plan.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(text: string): string {
  let bits = '';
  for (const byte of Buffer.from(text, 'ascii')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

// RFC 6238 Appendix B: the seed is the ASCII text, repeated to the length of the hash block
const SEEDS: Record<TotpAlgorithm, string> = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};
const VECTORS: Array<[number, Record<TotpAlgorithm, string>]> = [
  [59, { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' }],
  [1111111109, { SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' }],
  [1111111111, { SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' }],
  [1234567890, { SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' }],
  [2000000000, { SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' }],
  [20000000000, { SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }],
];

describe('totp: RFC 6238 Appendix B', () => {
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    it(`matches every ${algorithm} vector with 8 digits`, () => {
      const secret = base32(SEEDS[algorithm]);
      for (const [seconds, expected] of VECTORS) {
        expect(totp(secret, { timeMs: seconds * 1000, digits: 8, algorithm })).toBe(expected[algorithm]);
      }
    });
  }

  it('defaults to SHA-1, 6 digits and a 30 s step', () => {
    // The 6-digit code is the last 6 digits of the 8-digit one
    expect(totp(base32(SEEDS.SHA1), { timeMs: 59_000 })).toBe('287082');
  });

  it('changes exactly at the period boundary', () => {
    const secret = base32(SEEDS.SHA1);
    const before = totp(secret, { timeMs: 29_999 });
    expect(totp(secret, { timeMs: 0 })).toBe(before);
    expect(totp(secret, { timeMs: 30_000 })).not.toBe(before);
    expect(totp(secret, { timeMs: 59_999 })).toBe(totp(secret, { timeMs: 30_000 }));
    expect(totp(secret, { timeMs: 60_000 })).not.toBe(totp(secret, { timeMs: 59_999 }));
  });

  it('honours a custom period and 7 digits, and keeps leading zeros', () => {
    const secret = base32(SEEDS.SHA1);
    expect(totp(secret, { timeMs: 1111111109_000, digits: 8 })).toBe('07081804');
    expect(totp(secret, { timeMs: 59_000, digits: 7 })).toBe('4287082');
    expect(totp(secret, { timeMs: 119_000, period: 60 })).toBe(totp(secret, { timeMs: 60_000, period: 60 }));
  });

  it('rejects unsupported digits and periods', () => {
    expect(() => totp('GEZDGNBV', { digits: 5 })).toThrow(/digits/);
    expect(() => totp('GEZDGNBV', { digits: 9 })).toThrow(/digits/);
    expect(() => totp('GEZDGNBV', { period: 0 })).toThrow(/period/);
  });
});

describe('base32 secrets', () => {
  const canonical = base32(SEEDS.SHA1);

  it('accepts lowercase, spaces, dashes and padding', () => {
    const expected = totp(canonical, { timeMs: 59_000 });
    const spaced = canonical.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    expect(totp(spaced, { timeMs: 59_000 })).toBe(expected);
    expect(totp(canonical.replace(/(.{4})/g, '$1-'), { timeMs: 59_000 })).toBe(expected);
    expect(totp(canonical + '====', { timeMs: 59_000 })).toBe(expected);
  });

  it('decodes to the original bytes', () => {
    expect(decodeBase32(canonical).toString('ascii')).toBe(SEEDS.SHA1);
    expect(decodeBase32('MY======').toString('ascii')).toBe('f');
    expect(decodeBase32('mzxw6ytboi').toString('ascii')).toBe('foobar');
  });

  it('rejects an empty or invalid secret without echoing it', () => {
    expect(() => totp('', {})).toThrow(/empty/);
    expect(() => totp('   ', {})).toThrow(/empty/);
    let message = '';
    try {
      totp('NOT*BASE32!1', {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/base32/);
    expect(message).not.toContain('NOT*BASE32');
  });
});

describe('secret resolution of a step', () => {
  const seed = base32('daemonize-seed-0001');

  it('types the current code of a totp step, computed from the seed in the environment', () => {
    const step = { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true };
    const env = { DAEMONIZE_SECRET_OTP: seed };
    expect(resolveStepValue(step, {}, env, 59_000)).toBe(totp(seed, { timeMs: 59_000 }));
    expect(resolveStepValue(step, {}, env, 61_000)).not.toBe(resolveStepValue(step, {}, env, 59_000));
  });

  it('types the environment value as is when the step is not a totp step', () => {
    const step = { actionType: 'type', selectors: [], secretRef: 'PASSWORD' };
    expect(resolveStepValue(step, {}, { DAEMONIZE_SECRET_PASSWORD: 'p@ss word' })).toBe('p@ss word');
  });

  it('names the missing variable and never a value', () => {
    const step = { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true };
    expect(() => resolveStepValue(step, {}, {})).toThrow(/DAEMONIZE_SECRET_OTP/);
    expect(() => resolveStepValue(step, {}, { DAEMONIZE_SECRET_OTP: '' })).toThrow(/DAEMONIZE_SECRET_OTP/);
  });

  it('does not echo an invalid seed, and refuses a totp step without secretRef', () => {
    const step = { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true };
    let message = '';
    try {
      resolveStepValue(step, {}, { DAEMONIZE_SECRET_OTP: 'bad*seed*value' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DAEMONIZE_SECRET_OTP/);
    expect(message).not.toContain('bad*seed*value');
    expect(() => resolveStepValue({ actionType: 'type', selectors: [], totp: true }, {}, {})).toThrow(/secretRef/);
  });

  it('lists the raw secret values to remove from diagnostics', () => {
    const steps = [
      { actionType: 'type', selectors: [], secretRef: 'PASSWORD' },
      { actionType: 'type', selectors: [], secretRef: 'OTP', totp: true },
      { actionType: 'click', selectors: [] },
    ];
    expect(secretValues(steps, { DAEMONIZE_SECRET_PASSWORD: 'pw-1', DAEMONIZE_SECRET_OTP: seed })).toEqual(['pw-1', seed]);
  });
});
