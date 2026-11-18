/**
 * Guards the colours of the recording panel (the K table of src/recorder/capture-script.ts, Kiro dark tokens, see
 * docs/design-tokens.md): text keeps a WCAG contrast of at least 4.5:1 on the surface it sits on, marks 3:1.
 */
import { describe, expect, it } from 'vitest';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

const table = /const K = \{([^}]*)\};/.exec(CAPTURE_SCRIPT)?.[1] ?? '';
const K = new Map<string, string>([...table.matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/gi)].map((m) => [m[1], m[2]]));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(K.get(a) ?? a), luminance(K.get(b) ?? b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('recording panel colours', () => {
  it('finds the colour table', () => {
    expect(K.size).toBeGreaterThan(10);
  });

  const text: Array<[string, string]> = [
    ['text', 'surface'], ['muted', 'surface'], ['muted', 'raised'], ['text', 'raised'], ['text', 'neutral'],
    ['muted', 'tray'], ['text', 'tray'], ['violetText', 'violetDeep'], ['green', '#0f2f23'], ['muted', 'line'],
    ['#ffffff', 'violet'], ['violetSoft', 'surface'], ['#ffffff', 'raised'],
  ];
  for (const [foreground, background] of text) {
    it(`${foreground} on ${background} is at least 4.5:1`, () => {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the violet outline and the focus ring are at least 3:1 on the surface', () => {
    expect(contrast('violetSoft', 'surface')).toBeGreaterThanOrEqual(3);
    expect(contrast('violet', 'surface')).toBeGreaterThanOrEqual(3);
  });
});
