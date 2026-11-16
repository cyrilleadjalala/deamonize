import { describe, it, expect } from 'vitest';
import { readFinalScreen } from '../../src/cli/commands/record-tui.js';

// A program that redraws all the time can be captured just after it cleared the screen. Recording
// must read the screen again instead of failing on that one empty capture.
describe('readFinalScreen', () => {
  const options = { resultRegex: 'Menu: \\[(?<key>\\d)\\] (?<action>\\w+)' };

  it('reads again until the result zone can be read, when a capture falls mid-redraw', async () => {
    const captures = ['', '   \n  ', 'Clock: 12:00:01\nMenu: [1] Start'];
    let reads = 0;
    const result = await readFinalScreen(() => captures[Math.min(reads++, captures.length - 1)], options, 2000);
    expect(reads).toBe(3);
    expect(result.fullText).toContain('Menu: [1] Start');
    expect(result.resultZone?.extractor).toEqual({ kind: 'regex', pattern: options.resultRegex });
  });

  it('still fails, with the extractor message, when the zone never appears', async () => {
    const started = Date.now();
    await expect(readFinalScreen(() => 'nothing here', options, 200)).rejects.toThrow(/result zone cannot be read/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps the first capture when no result zone was asked for', async () => {
    let reads = 0;
    const result = await readFinalScreen(() => `capture ${++reads}`, {}, 2000);
    expect(reads).toBe(1);
    expect(result).toEqual({ fullText: 'capture 1', resultZone: undefined });
  });
});