// Feature: user-journey-improvements, Property 26: Payload coercion
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { coercePayloadValue, retypePayloads, type VariableHost } from '../../src/workflow/variable-edit.js';

type Kind = 'string' | 'number' | 'boolean';
const kind = fc.constantFrom<Kind>('string', 'number', 'boolean');
const valueOf = (type: Kind): fc.Arbitrary<unknown> =>
  type === 'string'
    ? fc.oneof(fc.string({ maxLength: 10 }), fc.constantFrom('true', 'false', ' 12 ', '1e3', '', '   ', 'abc', '0x10', 'Infinity', 'TRUE', '-0.5'))
    : type === 'number'
      ? fc.double({ noNaN: true, noDefaultInfinity: true })
      : fc.boolean();

const pair = fc.tuple(kind, kind).chain(([from, to]) => valueOf(from).map((value) => ({ from, to, value })));

describe('Property 26: Payload coercion', () => {
  /** **Validates: Requirements 14.14** */
  it('follows the table of conversions', () => {
    fc.assert(
      fc.property(pair, ({ from, to, value }) => {
        const result = coercePayloadValue(value, from, to);
        if (from === to) {
          expect(result).toEqual({ ok: true, value });
        } else if (from === 'string' && to === 'number') {
          const text = (value as string).trim();
          const ok = text !== '' && Number.isFinite(Number(text));
          expect(result.ok).toBe(ok);
          if (result.ok) expect(result.value).toBe(Number(text));
        } else if (from === 'string' && to === 'boolean') {
          expect(result.ok).toBe(value === 'true' || value === 'false');
          if (result.ok) expect(result.value).toBe(value === 'true');
        } else if (to === 'string') {
          expect(result).toEqual({ ok: true, value: String(value) });
        } else {
          expect(result).toEqual({ ok: false });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('retypePayloads leaves the host unchanged when any value is refused, and converts all otherwise', () => {
    fc.assert(
      fc.property(
        kind,
        kind,
        fc.array(fc.option(fc.string({ maxLength: 6 }), { nil: undefined }), { minLength: 1, maxLength: 4 }),
        (from, to, texts) => {
          const payloads = texts.map((text) => (text === undefined ? { other: 1 } : { field: from === 'string' ? text : from === 'number' ? Number(text.length) : text.length % 2 === 0, other: 1 }));
          const host: VariableHost = { steps: [], variables: [{ name: 'field' }], observedPayloads: payloads };
          const before = structuredClone(host);
          const refused = payloads.some((payload) => 'field' in payload && !coercePayloadValue((payload as Record<string, unknown>).field, from, to).ok);
          const done = retypePayloads(host, 'field', from, to);
          expect(done).toBe(!refused);
          if (refused) {
            expect(host).toEqual(before);
          } else {
            host.observedPayloads.forEach((payload, i) => {
              if ('field' in payload) expect(payload.field).toEqual((coercePayloadValue((before.observedPayloads[i] as Record<string, unknown>).field, from, to) as { value: unknown }).value);
              expect(payload.other).toBe(1);
            });
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});