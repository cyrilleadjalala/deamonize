// Feature: kiro-thin-extension, Property 6: Handshake and origin validation accept exactly the valid forms
// **Validates: Requirements 5.1, 5.2, 5.3, 5.12**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isLoopbackOrigin, isStudioToken } from '../../../kiro-extension/src/core/origin';
import { formatHandshake, parseHandshakeLine } from '../../../kiro-extension/src/core/handshake';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const urlParts = fc.record({
  scheme: fc.constantFrom('http', 'https', 'ftp', 'ws'),
  host: fc.constantFrom('127.0.0.1', 'localhost', '[::1]', 'example.com', '10.0.0.1', '127.0.0.2', '0.0.0.0'),
  port: fc.option(fc.oneof(fc.integer({ min: 0, max: 70000 }), fc.constantFrom(80, 65535, 65536)), { nil: undefined }),
  path: fc.constantFrom('', '/', '/x', '//'),
  user: fc.constantFrom('', 'u@', 'u:p@'),
  query: fc.constantFrom('', '?a=1'),
  hash: fc.constantFrom('', '#h'),
});

describe('Property 6: validation accepts exactly the valid forms', () => {
  it('isLoopbackOrigin is true exactly for http loopback with an explicit port and nothing else', () => {
    fc.assert(
      fc.property(urlParts, (p) => {
        const text = `${p.scheme}://${p.user}${p.host}${p.port === undefined ? '' : `:${p.port}`}${p.path}${p.query}${p.hash}`;
        const expected =
          p.scheme === 'http' &&
          LOOPBACK.includes(p.host) &&
          p.port !== undefined && p.port >= 1 && p.port <= 65535 && p.port !== 80 &&
          (p.path === '' || p.path === '/') &&
          p.user === '' && p.query === '' && p.hash === '';
        expect(isLoopbackOrigin(text)).toBe(expected);
      }),
      { numRuns: 300 }
    );
  });

  it('isLoopbackOrigin refuses surrounding whitespace and non-strings', () => {
    expect(isLoopbackOrigin(' http://127.0.0.1:5000')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1:5000\n')).toBe(false);
    expect(isLoopbackOrigin(5000 as unknown as string)).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1:5000/')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:5000')).toBe(true);
  });

  it('isStudioToken matches ^[A-Za-z0-9_-]{16,128}$ for any string', () => {
    const tokenish = fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9_-]{0,140}$/),
      fc.string({ maxLength: 40 }),
      fc.stringMatching(/^[A-Za-z0-9_-]{16,40}$/).map((s) => `${s}\n`)
    );
    fc.assert(fc.property(tokenish, (t) => { expect(isStudioToken(t)).toBe(/^[A-Za-z0-9_-]{16,128}$/.test(t)); }), { numRuns: 300 });
  });

  it('parseHandshakeLine returns the three fields exactly when the value is valid', () => {
    const origin = fc.oneof(fc.integer({ min: 1, max: 65535 }).filter((n) => n !== 80).map((n) => `http://127.0.0.1:${n}`), fc.constantFrom('http://evil.com:5', 'https://127.0.0.1:5', 'nonsense'));
    const token = fc.oneof(fc.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), fc.constantFrom('short', 'has space 1234567890123'));
    const pid = fc.oneof(fc.integer({ min: 1, max: 4_000_000 }), fc.constantFrom(0, -1, 1.5), fc.constant('7' as unknown as number));
    const extras = fc.dictionary(fc.constantFrom('extra', 'note', 'x'), fc.string(), { maxKeys: 2 });
    fc.assert(
      fc.property(origin, token, pid, extras, (o, t, p, e) => {
        const line = JSON.stringify({ ...e, origin: o, token: t, pid: p });
        const valid = isLoopbackOrigin(o) && isStudioToken(t) && typeof p === 'number' && Number.isInteger(p) && p > 0;
        const got = parseHandshakeLine(line);
        if (valid) expect(got).toEqual({ origin: o, token: t, pid: p });
        else expect(got).toBeUndefined();
      }),
      { numRuns: 300 }
    );
  });

  it('parseHandshakeLine refuses non-objects and broken JSON', () => {
    for (const text of ['', 'null', '[]', '1', '"x"', '{', 'not json', '{"origin":1}']) expect(parseHandshakeLine(text)).toBeUndefined();
  });

  it('formatHandshake round trips through parseHandshakeLine', () => {
    const h = { origin: 'http://127.0.0.1:5000', token: 'abcdefghijklmnopqrstuvwxyz012345', pid: 9 };
    expect(parseHandshakeLine(formatHandshake(h).trimEnd())).toEqual(h);
  });
});
