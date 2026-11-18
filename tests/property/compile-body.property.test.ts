import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileRoutes } from '../../src/studio/routes/compile.js';
import type { CompileOptionsInput, StudioServices } from '../../src/studio/contracts.js';
import type { RouteContext, RouteRequest } from '../../src/studio/routes/types.js';

const req = (body: Record<string, unknown>): RouteRequest => ({ method: 'POST', query: new URLSearchParams(), body, signal: new AbortController().signal });

/** A runner double that records the options of every compile it starts. */
function run(body: Record<string, unknown>) {
  const started: CompileOptionsInput[] = [];
  const compiler = {
    tryStart: (options?: CompileOptionsInput) => {
      if (options) started.push(options);
      return true;
    },
  };
  const post = compileRoutes({ services: { compiler } as unknown as StudioServices } as RouteContext)[0]!.handlers.POST!;
  return { started, answer: post(req(body)) };
}

const anyValue = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constantFrom('off', 'auto', 'OFF', 'on', ''));
const validHttp = fc.constantFrom('off' as const, 'auto' as const);

describe('compile body', () => {
  // Feature: user-journey-improvements, Property 33: Compile body validation
  // **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 21.15, 21.16**
  it('Property 33: a valid body starts a compile with the validated options, any other body answers 400 and starts none', async () => {
    const body = fc.record({ http: anyValue, healSupport: anyValue, extra: anyValue, __proto_x: anyValue }, { requiredKeys: [] });
    await fc.assert(
      fc.asyncProperty(body, async (input) => {
        const { started, answer } = run(input as Record<string, unknown>);
        const res = await answer;
        const keys = Object.keys(input);
        const unexpected = keys.find((k) => k !== 'http' && k !== 'healSupport');
        const httpBad = 'http' in input && input.http !== 'off' && input.http !== 'auto';
        const healBad = 'healSupport' in input && typeof input.healSupport !== 'boolean';
        if (unexpected !== undefined) {
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: 'UNEXPECTED_FIELD', field: unexpected });
          expect(started).toEqual([]);
        } else if (httpBad || healBad) {
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ field: httpBad ? 'http' : 'healSupport' });
          expect(started).toEqual([]);
        } else {
          expect(res.status).toBe(202);
          expect(started).toEqual([{ http: (input.http as string | undefined) ?? 'off', healSupport: (input.healSupport as boolean | undefined) ?? false }]);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('Property 33: a missing field takes its default, whatever the other field is', async () => {
    await fc.assert(
      fc.asyncProperty(validHttp, fc.boolean(), async (http, healSupport) => {
        const a = run({ http });
        expect((await a.answer).status).toBe(202);
        expect(a.started).toEqual([{ http, healSupport: false }]);
        const b = run({ healSupport });
        expect((await b.answer).status).toBe(202);
        expect(b.started).toEqual([{ http: 'off', healSupport }]);
      }),
      { numRuns: 100 }
    );
  });
});
