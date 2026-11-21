import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error no type declarations for the browser modules
import { COPY_ACTIVITY, allActivityCopyTexts, decisionText, outcomeText, durationText } from '../../src/studio/ui/js/copy-activity.js';

/** The Plain_Language terms, as whole words, case-insensitive (same rule as studio-ui-copy.test.ts). */
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

describe('Activity copy', () => {
  it('keeps the names the seam promised', () => {
    expect(COPY_ACTIVITY.title).toBe('Activity');
    expect(COPY_ACTIVITY.empty).toBe('No calls yet. When Kiro uses one of your tools, it appears here.');
    expect(Array.isArray(allActivityCopyTexts())).toBe(true);
  });

  it('has no banned term in any text', () => {
    const texts = allActivityCopyTexts() as string[];
    expect(texts.length).toBeGreaterThan(40);
    expect(texts.filter((t) => BANNED.test(t))).toEqual([]);
  });

  it('says every decision and outcome with words', () => {
    for (const d of ['auto', 'approved', 'denied', 'timeout', 'unavailable']) expect(decisionText(d)).not.toBe('');
    expect(new Set(['approved', 'denied', 'timeout', 'unavailable', 'auto'].map(decisionText)).size).toBe(5);
    expect(outcomeText('success')).toBe('Worked');
    expect(outcomeText('boom')).toBe('Failed');
    expect(durationText(250)).toBe('250 ms');
    expect(durationText(4210)).toBe('4.2 s');
  });

  it('has no literal colour in activity.css', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/studio/ui/css/activity.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(css.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });
});
