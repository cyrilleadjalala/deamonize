/**
 * Guards the Kiro design tokens of the Studio (src/studio/ui/app.css, see docs/design-tokens.md):
 * the text colours keep a WCAG contrast of at least 4.5:1 on the surfaces they sit on (3:1 for the
 * focus ring and other non-text marks), and no colour literal creeps back outside the token block.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(resolve(import.meta.dirname, '../../src/studio/ui'), 'app.css'), 'utf8');

/** The text between the braces of the block that starts at `start` (index of its opening brace). */
function blockAt(source: string, start: number): { body: string; end: number } {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(start + 1, i), end: i + 1 };
    }
  }
  throw new Error('unbalanced braces');
}

const rootStart = css.indexOf(':root');
const root = blockAt(css, css.indexOf('{', rootStart));
const tokens = new Map<string, string>();
for (const match of root.body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens.set(match[1], match[2].trim());

/** The #rrggbb value of a token, following var() references. */
function color(name: string): [number, number, number] {
  let value = tokens.get(name);
  for (let hops = 0; value !== undefined && value.startsWith('var(') && hops < 8; hops++) {
    value = tokens.get(value.slice(6, -1));
  }
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a #rrggbb colour (${value})`);
  return [1, 3, 5].map((i) => parseInt(value!.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(color(foreground));
  const b = luminance(color(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ['bg', 'bg-raised', 'panel', 'panel-2', 'kiro-surface-2', 'chip-bg'];

describe('Studio design tokens: text contrast (WCAG AA, 4.5:1)', () => {
  const textOnSurfaces: Array<[string, string[]]> = [
    ['text', [...SURFACES, 'surface-hover', 'surface-pressed', 'code-bg']],
    ['muted', SURFACES],
    ['muted-2', ['bg', 'panel', 'panel-2']],
    ['purple', [...SURFACES, 'surface-hover', 'purple-deep']],
    ['purple-hover', ['bg', 'panel', 'panel-2']],
    ['zinc', ['bg-raised', 'bg']],
    ['code-text', ['kiro-surface-2']],
  ];

  for (const [foreground, backgrounds] of textOnSurfaces) {
    for (const background of backgrounds) {
      it(`--${foreground} on --${background}`, () => {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  const tints: Array<[string, string]> = [
    ['lv-http', 'lv-http-bg'],
    ['lv-accessibility', 'lv-accessibility-bg'],
    ['lv-vision', 'lv-vision-bg'],
    ['lv-coordinates', 'lv-coordinates-bg'],
    ['lv-terminal', 'lv-terminal-bg'],
    ['lv-none', 'lv-none-bg'],
    ['warn', 'warn-deep'],
    ['green', 'green-deep'],
    ['red', 'red-deep'],
    ['red-text', 'red-deep'],
    ['blue', 'blue-deep'],
    ['purple-100', 'purple-deep'],
    ['purple', 'purple-deep'],
  ];
  for (const [foreground, background] of tints) {
    it(`status tint: --${foreground} on --${background}`, () => {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the primary button keeps white text readable on the Kiro violet (the margin is thin, about 4.6:1)', () => {
    tokens.set('white', '#ffffff');
    expect(contrast('white', 'purple-fill')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Studio design tokens: non-text marks (3:1)', () => {
  for (const background of ['bg', 'panel', 'panel-2', 'kiro-surface-2']) {
    it(`the focus ring on --${background}`, () => {
      expect(contrast('focus', background)).toBeGreaterThanOrEqual(3);
    });
  }

  for (const level of ['http', 'accessibility', 'vision', 'coordinates', 'terminal', 'none']) {
    it(`the ${level} bar segment on the track`, () => {
      expect(contrast(`lv-${level}`, 'bg-raised')).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('Studio design tokens: no colour literal outside the token block', () => {
  // The forced-colors and print blocks use system colours and black and white on purpose
  const withoutRoot = css.slice(0, rootStart) + css.slice(root.end);
  // Comments may quote colours: they are not declarations
  let rest = withoutRoot.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const marker of ['@media (forced-colors: active)', '@media print']) {
    const at = rest.indexOf(marker);
    if (at !== -1) {
      const block = blockAt(rest, rest.indexOf('{', at));
      rest = rest.slice(0, at) + rest.slice(block.end);
    }
  }

  it('uses variables for every hex colour', () => {
    const literals = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    // #fff and #000 are the text colours of the white and violet buttons and of the button hover
    const unexpected = literals.filter((literal) => literal !== '#fff' && literal !== '#000');
    expect(unexpected).toEqual([]);
  });

  it('keeps the orange of the old theme out of the file', () => {
    expect(css).not.toMatch(/--orange/);
    expect(css.toLowerCase()).not.toContain('#ffa24d');
  });
});
