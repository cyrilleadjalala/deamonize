import { describe, expect, it } from 'vitest';
import { validateHealResult, type Mark } from '../../src/heal/healer.js';
import { DEFAULT_MARK_CAP, clipToViewport, locatorHintFor, overlapRatio, rankMarks, type MarkCandidate } from '../../src/heal/marks.js';
import { FakeHealer } from '../helpers/fake-healer.js';

const viewport = { width: 800, height: 600 };
const marks: Mark[] = [
  { id: 1, box: { x: 0, y: 0, width: 10, height: 10 } },
  { id: 2, box: { x: 20, y: 0, width: 10, height: 10 } },
];

describe('validateHealResult', () => {
  it('accepts a known mark and an in-viewport point', () => {
    expect(validateHealResult({ kind: 'mark', markId: 2 }, marks, viewport)).toEqual({ kind: 'mark', markId: 2 });
    expect(validateHealResult({ kind: 'point', x: 10, y: 599 }, marks, viewport)).toEqual({ kind: 'point', x: 10, y: 599 });
  });
  it('rejects unknown ids, out-of-viewport points and malformed answers', () => {
    for (const bad of [
      { kind: 'mark', markId: 9 },
      { kind: 'mark', markId: 1.5 },
      { kind: 'mark', markId: '1' },
      { kind: 'point', x: 800, y: 1 },
      { kind: 'point', x: -1, y: 1 },
      { kind: 'point', x: 1, y: NaN },
      { kind: 'point', x: 'a', y: 1 },
      { kind: 'other' },
      null,
      'text',
    ]) {
      expect(validateHealResult(bad, marks, viewport).kind).toBe('none');
    }
  });
  it('keeps the reason of a none answer', () => {
    expect(validateHealResult({ kind: 'none', reason: 'not visible' }, marks, viewport)).toEqual({ kind: 'none', reason: 'not visible' });
  });
});

describe('marks ranking', () => {
  const cand = (x: number, y: number, role?: string, name?: string, w = 50, h = 20): MarkCandidate => ({ box: { x, y, width: w, height: h }, role, name });

  it('clips to the viewport and drops boxes outside or tiny', () => {
    expect(clipToViewport({ x: -10, y: -10, width: 30, height: 30 }, viewport)).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(clipToViewport({ x: 900, y: 0, width: 10, height: 10 }, viewport)).toBeUndefined();
    expect(rankMarks([cand(0, 0, 'button', 'a', 2, 2), cand(900, 0, 'button', 'b')], viewport)).toEqual([]);
  });

  it('numbers marks from 1 in reading order', () => {
    const result = rankMarks([cand(300, 100, 'link', 'c'), cand(10, 10, 'button', 'a'), cand(200, 10, 'button', 'b')], viewport);
    expect(result.map((m) => [m.id, m.name])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('collapses near-identical boxes, keeping the better ranked one', () => {
    const result = rankMarks([cand(10, 10, 'clickable'), cand(11, 10, 'button', 'Save')], viewport);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('button');
    expect(overlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 })).toBe(0);
  });

  it('caps the count (default 60) and prefers important roles', () => {
    const many: MarkCandidate[] = [];
    for (let i = 0; i < 100; i++) many.push(cand((i % 10) * 70, Math.floor(i / 10) * 40, i < 5 ? 'button' : 'clickable', i < 5 ? `b${i}` : undefined));
    const result = rankMarks(many, viewport);
    expect(result).toHaveLength(DEFAULT_MARK_CAP);
    expect(result.filter((m) => m.role === 'button')).toHaveLength(5);
    expect(result.map((m) => m.id)).toEqual(result.map((_, i) => i + 1));
    expect(rankMarks(many, viewport, 7)).toHaveLength(7);
  });

  it('is deterministic and gives a locator hint', () => {
    const input = [cand(5, 5, 'button', 'Go'), cand(100, 5, 'link', 'Home')];
    expect(rankMarks(input, viewport)).toEqual(rankMarks([...input].reverse(), viewport));
    expect(locatorHintFor({ role: 'button', name: 'Go' })).toBe('getByRole("button", { name: "Go" })');
    expect(locatorHintFor({ role: 'clickable', css: '#x' })).toBe('locator("#x")');
  });
});

describe('FakeHealer', () => {
  it('replays the script and logs calls', async () => {
    const fake = new FakeHealer([{ kind: 'mark', markId: 1 }, new Error('boom')]);
    const req = { screenshotPng: Buffer.from('x'), marks, intent: 'i', step: { action: 'click' }, viewport };
    expect(await fake.locate(req)).toEqual({ kind: 'mark', markId: 1 });
    await expect(fake.locate(req)).rejects.toThrow('boom');
    expect(fake.calls).toHaveLength(2);
  });
});
