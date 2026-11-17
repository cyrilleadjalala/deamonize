import { describe, it, expect } from 'vitest';
import { applicationKey, plainName, validateName, validateUrl } from '../../src/studio/validate-action.js';

describe('validateName', () => {
  it('trims and accepts 1 to 80 code points with a letter or digit', () => {
    expect(validateName('  Create customer  ')).toEqual({ ok: true, value: 'Create customer' });
    expect(validateName('a').ok).toBe(true);
    expect(validateName('é'.repeat(79) + 'a').ok).toBe(true);
  });
  it('rejects empty, 81 code points, no letter or digit, and control characters', () => {
    expect(validateName('   ').ok).toBe(false);
    expect(validateName('a'.repeat(81)).ok).toBe(false);
    expect(validateName('\u{1F600}'.repeat(5)).ok).toBe(false);
    expect(validateName('line\nbreak').ok).toBe(false);
    expect(validateName('tab\there').ok).toBe(false);
    expect(validateName('del\u007f').ok).toBe(false);
    expect(validateName(42).ok).toBe(false);
  });
  it('counts code points, not UTF-16 units', () => {
    expect(validateName('a' + '\u{1F600}'.repeat(79)).ok).toBe(true);
  });
});

describe('validateUrl', () => {
  it('accepts http and https', () => {
    expect(validateUrl(' https://example.com/a?b=1 ')).toEqual({ ok: true, value: 'https://example.com/a?b=1' });
    expect(validateUrl('http://localhost:3000').ok).toBe(true);
  });
  it('rejects other schemes, relative values, user info and long values', () => {
    for (const bad of ['ftp://example.com', 'example.com', '/path', 'javascript:alert(1)', 'https://user:pass@example.com/', 'https://user@example.com/', '']) {
      expect(validateUrl(bad).ok, bad).toBe(false);
    }
    expect(validateUrl('https://example.com/' + 'a'.repeat(2049)).ok).toBe(false);
    expect(validateUrl('https://example.com/' + 'a'.repeat(2028)).ok).toBe(true);
  });
});

describe('plainName', () => {
  it('rejects dot segments, absolute paths, separators and NUL', () => {
    for (const bad of ['..', '../x', 'a/..', '/etc/passwd', 'C:\\x', 'C:x', 'a\\b', 'a/b', 'a\0b', '', '.']) {
      expect(plainName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(plainName('CRM_PASSWORD')).toEqual({ ok: true, value: 'CRM_PASSWORD' });
  });
});

describe('applicationKey', () => {
  it('is the normalized origin for http(s) only', () => {
    expect(applicationKey('https://Example.com:443/a?b')).toBe('https://example.com');
    expect(applicationKey('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(applicationKey('ftp://example.com')).toBeUndefined();
    expect(applicationKey('nonsense')).toBeUndefined();
  });
});
