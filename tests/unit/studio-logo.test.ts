/**
 * Guards the Studio logo (Requirement 23): an original outline shield with a check mark, the same shield path as
 * kiro-extension/media/icon.svg, painted only through the --logo-* tokens of app.css.
 * **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.8, 23.9**
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const favicon = read('src/studio/ui/favicon.svg');
const html = read('src/studio/ui/index.html');
const css = read('src/studio/ui/app.css');
const extensionIcon = read('kiro-extension/media/icon.svg');
const SHIELD = /d="(M12 3 4 7v6c0 4\.2 3\.2 7\.2 8 8 4\.8-\.8 8-3\.8 8-8V7l-8-4Z)"/;
const CHECK = 'm9 12 2 2 4-4';
const logo = html.slice(html.indexOf('<svg class="logo"'), html.indexOf('</svg>', html.indexOf('<svg class="logo"')) + 6);
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** The #rrggbb of a token of the first :root block or of the print :root block, following var() hops. */
function token(name: string, scope: string): string {
  const own = scope.match(new RegExp(`--${name}:\\s*([^;]+);`));
  const value = own?.[1].trim() ?? css.match(new RegExp(`--${name}:\\s*([^;]+);`))![1].trim();
  const ref = value.match(/^var\(--([a-z0-9-]+)\)$/);
  return ref ? token(ref[1], scope) : value;
}
const dark = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const printAt = css.indexOf('@media print');
const print = css.slice(css.indexOf(':root', printAt), css.indexOf('}', css.indexOf(':root', printAt)));
describe('favicon.svg', () => {
  it('has the shield path of the extension icon exactly once, and one check path', () => {
    const shield = favicon.match(SHIELD);
    expect(shield).not.toBeNull();
    expect(extensionIcon).toContain(`d="${shield![1]}"`);
    expect(favicon.match(/<path\b/g)).toHaveLength(2);
    expect(favicon.split(shield![1])).toHaveLength(2);
    expect(favicon).toContain(`d="${CHECK}"`);
  });
  it('draws an outline shield with the violet strokes on the extension surface', () => {
    expect(favicon).toMatch(/viewBox="0 0 24 24"/);
    expect(favicon).toContain('fill="#19161d"');
    expect(favicon).toMatch(/<path d="M12 3[^>]*fill="none"[^>]*stroke="#9147ff"/);
    expect(favicon).toMatch(/<path d="m9 12[^>]*stroke="#c59eff"/);
  });
  it('keeps no ellipse, circle, ghost path or ghost id', () => {
    expect(favicon).not.toMatch(/<(ellipse|circle)\b/);
    expect(favicon).not.toContain('M7 35 V19');
    expect(favicon.toLowerCase()).not.toMatch(/id="[^"]*ghost/);
  });
});
describe('inline logo of index.html', () => {
  it('is one svg with class logo, aria-hidden and focusable=false', () => {
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(logo).toMatch(/^<svg class="logo" viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  });
  it('draws the same shield and check as the favicon', () => {
    expect(logo).toMatch(SHIELD);
    expect(logo).toContain(`d="${CHECK}"`);
  });
  it('paints only through var(--...) tokens that :root defines', () => {
    const paints = [...logo.matchAll(/\b(fill|stroke)="([^"]*)"/g)].map((m) => m[2]);
    for (const paint of paints) expect(paint === 'none' || /^var\(--[a-z-]+\)$/.test(paint)).toBe(true);
    expect(logo).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl|style=/);
    for (const name of ['logo-shield', 'logo-check']) {
      expect(logo).toContain(`var(--${name})`);
      expect(dark).toContain(`--${name}:`);
    }
  });
  it('has no ghost gradient, ellipse or url() reference', () => {
    expect(html).not.toContain('ghost-body');
    expect(html).not.toContain('linearGradient');
    expect(html).not.toMatch(/<ellipse\b/);
    expect(html).not.toContain('url(#');
  });
  it('leaves the brand text unchanged', () => {
    expect(html).toContain('<span class="brand-name">Daemonize <strong>Studio</strong></span>');
  });
});
describe('logo contrast (3:1 per mark against its backdrop)', () => {
  const backdrops: Array<[string, string, string]> = [
    ['favicon surface', '#19161d', dark],
    ['dark header', token('bg', dark), dark],
    ['print header', '#ffffff', print],
  ];
  for (const [label, backdrop, scope] of backdrops) {
    for (const mark of ['logo-shield', 'logo-check']) {
      it(`--${mark} on the ${label}`, () => {
        expect(contrast(token(mark, scope), backdrop)).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it('the favicon colours equal the tokens of the dark theme', () => {
    expect(token('logo-shield', dark)).toBe('#9147ff');
    expect(token('logo-check', dark)).toBe('#c59eff');
  });
});
