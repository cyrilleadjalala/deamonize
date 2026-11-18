// Feature: kiro-thin-extension, Property 9: The browser URL carries the token and the route
// **Validates: Requirements 6.1, 6.3**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildBrowserUrl } from '../../../kiro-extension/src/core/studio-url';

const origin = fc
  .tuple(fc.constantFrom('127.0.0.1', 'localhost', '[::1]'), fc.integer({ min: 1, max: 65535 }).filter((n) => n !== 80))
  .map(([h, p]) => `http://${h}:${p}`);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{16,128}$/);
const route = fc.constantFrom(undefined, 'playground' as const, 'credentials' as const, 'overview' as const);
const HASH = { playground: '#/playground', credentials: '#/credentials', overview: '', undefined: '' } as const;

describe('Property 9: browser URL', () => {
  it('keeps the origin, carries the token and sets the hash of the route', () => {
    fc.assert(
      fc.property(origin, token, route, (o, t, r) => {
        const url = new URL(buildBrowserUrl({ origin: o, token: t }, r));
        expect(url.origin).toBe(new URL(o).origin);
        expect(url.searchParams.get('token')).toBe(t);
        expect([...url.searchParams.keys()]).toEqual(['token']);
        expect(url.hash).toBe(HASH[String(r) as keyof typeof HASH]);
        expect(url.pathname).toBe('/');
      }),
      { numRuns: 200 }
    );
  });

  it('throws for an invalid origin or token', () => {
    fc.assert(
      fc.property(fc.constantFrom('http://evil.com:5', 'https://127.0.0.1:5', '', 'x'), token, (o, t) => {
        expect(() => buildBrowserUrl({ origin: o, token: t })).toThrow();
      }),
      { numRuns: 100 }
    );
    fc.assert(
      fc.property(origin, fc.constantFrom('', 'short', 'has space 1234567890123', 'a'.repeat(129)), (o, t) => {
        expect(() => buildBrowserUrl({ origin: o, token: t })).toThrow();
      }),
      { numRuns: 100 }
    );
  });
});
