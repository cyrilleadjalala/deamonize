import { describe, it, expect } from 'vitest';
import { buildSelectors, looksGenerated } from '../../src/recorder/selector-builder.js';

describe('looksGenerated', () => {
  it.each(['_R_jqatpesnelb_-field', '_R_13qatpesnelb_-field', ':r0:', ':r1:', 'radix-:r5:', '«r2»', 'a3f9c2d10b7e', '12345'])(
    'flags %s',
    (id) => expect(looksGenerated(id)).toBe(true),
  );
  it.each(['email', 'login-form', 'save', 'rooms:list'])('does not flag %s', (id) => expect(looksGenerated(id)).toBe(false));
});

describe('buildSelectors with generated ids', () => {
  const css = (id: string) => `#${id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;

  it('drops the id and id-anchored css when role and name exist', () => {
    const id = '_R_13qatpesnelb_-field';
    expect(buildSelectors({ id, css: css(id), role: 'textbox', name: 'Code' })).toEqual(['role=textbox[name="Code"]']);
  });

  it('gives the same list as without the id for React 18, Radix and guillemet ids', () => {
    for (const id of [':r1:', 'radix-:r5:', '«r2»', '_R_jqatpesnelb_-field']) {
      const base = { role: 'button', name: 'Go', testId: 't', nameAttr: 'n' };
      expect(buildSelectors({ ...base, id, css: `${css(id)} > button` })).toEqual(buildSelectors(base));
    }
  });

  it('keeps selectors apart for password and TOTP fields sharing a reused id', () => {
    const id = '_R_13qatpesnelb_-field';
    const a = buildSelectors({ id, css: css(id), role: 'textbox', name: 'Password' });
    const b = buildSelectors({ id, css: css(id), role: 'textbox', name: 'Code' });
    expect(a).not.toEqual(b);
    expect([...a, ...b].some((s) => s.includes('_R_'))).toBe(false);
  });

  it('keeps a plain id and rooms:list', () => {
    expect(buildSelectors({ id: 'email', role: 'textbox', name: 'Email' })).toEqual(['role=textbox[name="Email"]', '#email']);
    expect(buildSelectors({ id: 'rooms:list' })).toEqual(['#rooms\\:list']);
  });

  it('keeps the css fallback when nothing else is available', () => {
    const id = '_R_13qatpesnelb_-field';
    expect(buildSelectors({ id, css: css(id) })).toEqual([css(id)]);
  });
});
