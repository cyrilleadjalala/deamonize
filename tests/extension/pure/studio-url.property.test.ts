// Feature: user-journey-improvements, Property 30: The browser URL and its route
// **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.13**
// Feature: kiro-thin-extension, Property 9: The browser URL carries the token and the route
// **Validates: Requirements 6.1, 6.3**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildBrowserUrl, TARGET_NAME_RE } from '../../../kiro-extension/src/core/studio-url';
import { parseRoute } from '../../../src/studio/ui/js/router.js';

const origin = fc
  .tuple(fc.constantFrom('127.0.0.1', 'localhost', '[::1]'), fc.integer({ min: 1, max: 65535 }).filter((n) => n !== 80))
  .map(([h, p]) => `http://${h}:${p}`);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{16,128}$/);
const route = fc.constantFrom(undefined, 'playground' as const, 'credentials' as const, 'overview' as const, 'workflows' as const);
const HASH = { playground: '#/playground', credentials: '#/credentials', overview: '', workflows: '#/workflows', undefined: '' } as const;

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

describe('Property 30: the browser URL and its route (targets)', () => {
  const toolName = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
  const anyRoute = fc.constantFrom(undefined, 'playground' as const, 'credentials' as const, 'overview' as const, 'workflows' as const);
  const badName = fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 65, maxLength: 90 }).map((s) => s.replace(/[^A-Za-z0-9_-]/g, 'a')),
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !TARGET_NAME_RE.test(s)),
  );

  it('a tool target puts the token in the query only and round-trips through the Studio parseRoute', () => {
    fc.assert(
      fc.property(origin, token, anyRoute, toolName, (o, t, r, name) => {
        const url = new URL(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'tool', name }));
        expect(url.hash).toBe(`#/playground?tool=${encodeURIComponent(name)}`);
        expect(url.searchParams.get('token')).toBe(t);
        expect([...url.searchParams.keys()]).toEqual(['token']);
        expect(url.hash).not.toContain(t);
        expect(url.origin).toBe(new URL(o).origin);
        const route = parseRoute(url.hash);
        expect(route.name).toBe('playground');
        expect(route.query.get('tool')).toBe(name);
      }),
      { numRuns: 200 },
    );
  });

  it('a workflow target builds #/workflows/<encoded id> that parseRoute reads back', () => {
    fc.assert(
      fc.property(origin, token, anyRoute, fc.string({ minLength: 1, maxLength: 200 }), (o, t, r, id) => {
        const url = new URL(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'workflow', id }));
        if (url.hash === buildBrowserUrl({ origin: o, token: t }, r).replace(/^[^#]*/, '')) return; // lone surrogate: the target is ignored
        expect(url.hash).toBe(`#/workflows/${encodeURIComponent(id)}`);
        expect(url.searchParams.get('token')).toBe(t);
        expect([...url.searchParams.keys()]).toEqual(['token']);
        const route = parseRoute(url.hash);
        expect(route.name).toBe('workflows');
        expect(route.parts).toEqual([id]);
      }),
      { numRuns: 200 },
    );
  });

  it('an invalid name or id is ignored: the URL equals the one without a target', () => {
    fc.assert(
      fc.property(origin, token, anyRoute, badName, (o, t, r, name) => {
        const plain = buildBrowserUrl({ origin: o, token: t }, r);
        expect(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'tool', name })).toBe(plain);
        expect(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'workflow', id: '' })).toBe(plain);
        expect(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'workflow', id: 'x'.repeat(201) })).toBe(plain);
        expect(buildBrowserUrl({ origin: o, token: t }, r, { kind: 'workflow', id: '\ud800' })).toBe(plain);
      }),
      { numRuns: 200 },
    );
  });
});
