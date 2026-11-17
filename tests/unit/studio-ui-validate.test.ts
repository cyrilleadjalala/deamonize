import { describe, it, expect } from 'vitest';
// @ts-expect-error no type declarations for the browser modules
import { applicationKey as uiKey, validateName as uiName, validateUrl as uiUrl } from '../../src/studio/ui/js/validate.js';
import { applicationKey, validateName, validateUrl } from '../../src/studio/validate-action.js';

describe('UI validators (mirror of validate-action.ts)', () => {
  it('trims and accepts a good name and address', () => {
    expect(uiName('  Search customers ')).toEqual({ ok: true, value: 'Search customers' });
    expect(uiUrl(' https://example.com/login ')).toEqual({ ok: true, value: 'https://example.com/login' });
  });

  it('rejects the names the requirement lists', () => {
    for (const bad of ['', '   ', '!!!', 'a'.repeat(81), 'two\nlines', 'bell\u0007']) expect(uiName(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(uiName('a'.repeat(80)).ok).toBe(true);
    // 80 code points that are 160 UTF-16 units
    expect(uiName(`a${'\u{1F600}'.repeat(79)}`).ok).toBe(true);
  });

  it('rejects the addresses the requirement lists', () => {
    for (const bad of ['', 'example.com', 'ftp://example.com/', 'javascript:1', 'http://user:pw@example.com/', `https://e.com/${'a'.repeat(2048)}`]) {
      expect(uiUrl(bad).ok, bad).toBe(false);
    }
  });

  it('gives the same verdict and message as the server module', () => {
    for (const value of ['', 'Ok', ' x ', '###', 'a'.repeat(81), 'a\tb']) expect(uiName(value)).toEqual(validateName(value));
    for (const value of ['', 'http://h', 'https://h/p', 'ftp://h', 'http://u:p@h/', 'x'.repeat(2049)]) expect(uiUrl(value)).toEqual(validateUrl(value));
    expect(uiKey('https://example.com:8443/a?b=1')).toBe(applicationKey('https://example.com:8443/a?b=1'));
    expect(uiKey('ftp://h')).toBeUndefined();
  });
});
