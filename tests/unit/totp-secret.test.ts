import { describe, expect, it } from 'vitest';
import { extractTotpSecret, normalizeBase32 } from '../../src/studio/totp-secret.js';

const KEY = 'JBSWY3DPEHPK3PXP';

describe('normalizeBase32', () => {
  it('accepts lower case, grouping, dashes and padding', () => {
    expect(normalizeBase32('jbsw y3dp-ehpk 3pxp')).toBe(KEY);
    expect(normalizeBase32(`${KEY}====`)).toBe(KEY);
  });
  it('rejects a = in the middle, bad letters and keys shorter than 3', () => {
    expect(normalizeBase32('JBSW=Y3DP')).toBeUndefined();
    expect(normalizeBase32('JBSW1Y3DP')).toBeUndefined();
    expect(normalizeBase32('AB')).toBeUndefined();
    expect(normalizeBase32('')).toBeUndefined();
  });
});

describe('extractTotpSecret', () => {
  it('reads the secret of an otpauth address and ignores the rest', () => {
    expect(extractTotpSecret(`otpauth://totp/Example:ada@example.com?secret=${KEY.toLowerCase()}&issuer=Example&digits=8&period=60`)).toBe(KEY);
    expect(extractTotpSecret(`  OTPAUTH://TOTP/x?issuer=a&secret=${KEY}  `)).toBe(KEY);
  });
  it('accepts a plain key', () => {
    expect(extractTotpSecret(`${KEY.slice(0, 8)} ${KEY.slice(8)}`)).toBe(KEY);
  });
  it('rejects hotp, two secret parameters, no secret and a bad secret', () => {
    expect(extractTotpSecret(`otpauth://hotp/x?secret=${KEY}&counter=1`)).toBeUndefined();
    expect(extractTotpSecret(`otpauth://totp/x?secret=${KEY}&secret=${KEY}`)).toBeUndefined();
    expect(extractTotpSecret('otpauth://totp/x?issuer=a')).toBeUndefined();
    expect(extractTotpSecret('otpauth://totp/x?secret=not*base32')).toBeUndefined();
    expect(extractTotpSecret('otpauth:totp')).toBeUndefined();
  });
});
