// Feature: user-journey-improvements, Property 7: HTTP request with skipped Variables
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildRequest, type HttpRecipeLike } from '../../src/replay/runtime/http-replay.js';

type Kind = 'skipVar' | 'keepVar' | 'lit' | 'mixedSkip' | 'mixedKeep';
const kinds: Kind[] = ['skipVar', 'keepVar', 'lit', 'mixedSkip', 'mixedKeep'];
const specArb = fc.array(fc.constantFrom(...kinds), { minLength: 0, maxLength: 8 });

const removed = (k: Kind): boolean => k === 'skipVar' || k === 'mixedSkip';
const text = (k: Kind): string => (k === 'mixedSkip' ? 'Bearer {{opt}}' : k === 'mixedKeep' ? 'Bearer {{keep}}' : k === 'keepVar' ? '{{keep}}' : k === 'skipVar' ? '{{opt}}' : 'lit');
const leaf = (k: Kind): unknown => (k === 'skipVar' ? { $var: 'opt' } : k === 'keepVar' ? { $var: 'keep' } : k === 'lit' ? 'lit' : text(k));
const value = (k: Kind): unknown => (k === 'keepVar' ? 'K' : k === 'lit' ? 'lit' : k === 'mixedKeep' ? 'Bearer {{keep}}' : undefined);

describe('Property 7: HTTP request with skipped Variables', () => {
  /** **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.9** */
  it('removes exactly the entries that mention a skipped Variable and keeps the others', () => {
    fc.assert(
      fc.property(specArb, specArb, specArb, fc.constantFrom<'json' | 'form'>('json', 'form'), (q, h, b, format) => {
        const recipe: HttpRecipeLike = {
          method: 'POST',
          url: 'https://api.example.com/path',
          query: Object.fromEntries(q.map((k, i) => [`q${i}`, text(k)])),
          headers: Object.fromEntries(h.map((k, i) => [`x-h${i}`, text(k)])),
          body: Object.fromEntries(b.map((k, i) => [`b${i}`, leaf(k)])),
          bodyFormat: format,
        };
        const vars = { keep: 'K' };
        const built = buildRequest(recipe, vars, {}, new Set(['opt']));
        const params = new URL(built.url).searchParams;
        q.forEach((k, i) => expect(params.has(`q${i}`)).toBe(!removed(k)));
        h.forEach((k, i) => expect(built.headers[`x-h${i}`] !== undefined).toBe(!removed(k)));
        expect(built.url + JSON.stringify(built.headers) + (built.body ?? '')).not.toContain('{{opt}}');
        const kept = b.map((k, i) => [i, k] as const).filter(([, k]) => !removed(k));
        if (format === 'form') {
          const form = new URLSearchParams(built.body ?? '');
          expect([...form.keys()]).toEqual(kept.map(([i]) => `b${i}`));
        } else {
          const body = JSON.parse(built.body as string) as Record<string, unknown>;
          expect(Object.keys(body)).toEqual(kept.map(([i]) => `b${i}`));
          for (const [i, k] of kept) if (value(k) !== undefined && k !== 'mixedKeep') expect(body[`b${i}`]).toBe(value(k));
        }
        // 3.5: with nothing skipped the request is the one built without the argument
        const full = { ...vars, opt: 'O' };
        expect(buildRequest(recipe, full, {}, new Set())).toEqual(buildRequest(recipe, full, {}));
      }),
      { numRuns: 200 },
    );
  });

  /** **Validates: Requirements 3.2** */
  it('keeps the order of array items that remain', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }), { maxLength: 10 }), (items) => {
        const recipe: HttpRecipeLike = {
          method: 'POST',
          url: 'https://api.example.com/p',
          query: {},
          body: { list: items.map((n) => (n === undefined ? { $var: 'opt' } : n)) },
        };
        const body = JSON.parse(buildRequest(recipe, {}, {}, new Set(['opt'])).body as string) as { list: number[] };
        expect(body.list).toEqual(items.filter((n) => n !== undefined));
      }),
      { numRuns: 100 },
    );
  });
});
