// Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildRequest, HttpReplayError, type HttpRecipeLike } from '../../src/replay/runtime/http-replay.js';

const nameArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

describe('Property 8: A skipped Variable in a path is refused (runtime part)', () => {
  /** **Validates: Requirements 3.7, 3.8** */
  it('throws invalid naming the Variable, with no secret in the text, when a skipped name is in the path', () => {
    fc.assert(
      fc.property(nameArb, fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 3 }), fc.stringMatching(/^[A-Za-z0-9]{8,20}$/), (name, before, secret) => {
        const recipe: HttpRecipeLike = {
          method: 'GET',
          url: `https://api.example.com/${[...before, `{{${name}}}`].join('/')}`,
          query: {},
          headers: { authorization: { $secret: 'T' } },
        };
        const env = { DAEMONIZE_SECRET_T: secret };
        let error: unknown;
        try {
          buildRequest(recipe, { [name]: 'v' }, env, new Set([name]));
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(HttpReplayError);
        expect((error as HttpReplayError).kind).toBe('invalid');
        expect((error as Error).message).toContain(`"${name}"`);
        expect((error as Error).message).not.toContain(secret);
        // Not skipped: the same recipe builds
        expect(buildRequest(recipe, { [name]: 'v' }, env, new Set()).url).toContain('/v');
      }),
      { numRuns: 100 },
    );
  });
});
