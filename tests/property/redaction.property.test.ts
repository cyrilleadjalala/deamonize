import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findLiteralSecrets, isSecretReference, redactRequest, type RecordedRequest, type RedactedRequest } from '../../src/recorder/redactor.js';
import { findPlainSecrets } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { encodedForms } from '../helpers/scan-artifacts.js';

// Feature: daemonize, Property 11: redaction removes sensitive values
// Validates: Requirements 13.7, 16.1

// ---------------------------------------------------------------------------
// Generators.
// Generator restrictions (the redactor is only specified for these inputs):
//  - every planted secret is a random string of 16 or more characters from [A-Za-z0-9] (plus `-`/`_` in
//    some), so a short value ("123456") can never be confused with ordinary text in the output;
//  - a "long run" secret holds a letter and a digit (a pure number or a pure word is not a token, by design);
//  - a secret under a credential key is a string; a credential key holds a string leaf, never an object
//    (a container under a credential key redacts everything below it, which would hide neutral values);
//  - neutral keys never look like credentials; neutral values are words, small integers, UUIDs or booleans.
// ---------------------------------------------------------------------------

const ALNUM = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
const B64URL = [...ALNUM, '-', '_'];
const HEX = [...'0123456789abcdef'];
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];

const chars = (set: string[], min: number, max: number) => fc.array(fc.constantFrom(...set), { minLength: min, maxLength: max }).map((a) => a.join(''));

const secretValue = fc.oneof(chars(ALNUM, 16, 32), chars(B64URL, 16, 32));
/** A run of 24+ base64/hex characters mixing letters and digits. */
const longRun = fc.oneof(
  fc.tuple(fc.constantFrom(...LETTERS), fc.constantFrom(...DIGITS), chars(ALNUM, 22, 40)).map(([l, d, r]) => l + d + r),
  fc.tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), fc.constantFrom(...DIGITS), chars(HEX, 22, 40)).map(([l, d, r]) => l + d + r)
);
const jwtSegment = chars(B64URL, 12, 30);

interface Planted {
  value: string;
  /** Every string that must be absent from the output (the whole value and its secret parts). */
  secrets: string[];
}

/** A credential-looking value planted under a NEUTRAL key or header: no name gives it away. */
const wildValue: fc.Arbitrary<Planted> = fc.oneof(
  fc.tuple(jwtSegment, jwtSegment, jwtSegment).map(([a, b, c]) => {
    const jwt = `eyJ${a}.${b}.${c}`;
    return { value: jwt, secrets: [jwt, a, b, c] };
  }),
  secretValue.map((s) => ({ value: `Bearer ${s}`, secrets: [s, `Bearer ${s}`] })),
  secretValue.map((s) => ({ value: `Basic ${s}`, secrets: [s, `Basic ${s}`] })),
  longRun.map((s) => ({ value: s, secrets: [s] }))
);

const BASES = ['password', 'token', 'access_token', 'refresh_token', 'api_key', 'secret', 'otp', 'csrf', 'session'];
const sensitiveKey: fc.Arbitrary<string> = fc.tuple(fc.constantFrom(...BASES), fc.constantFrom('snake', 'camel', 'kebab', 'pascal'), fc.constantFrom('keep', 'upper', 'lower')).map(([base, style, casing]) => {
  const words = base.split('_');
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  let key =
    style === 'snake' ? words.join('_')
      : style === 'kebab' ? words.join('-')
        : style === 'camel' ? words[0] + words.slice(1).map(cap).join('')
          : words.map(cap).join('');
  if (casing === 'upper') key = key.toUpperCase();
  if (casing === 'lower') key = key.toLowerCase();
  return key;
});

const NEUTRAL_KEYS = ['name', 'title', 'count', 'note', 'status', 'id', 'label', 'flag', 'city', 'price'];
const CONTAINER_KEYS = ['user', 'data', 'items', 'profile', 'meta', 'payload'];
const neutralKey = fc.constantFrom(...NEUTRAL_KEYS);
const uuid = fc.uuid();
const word = chars(LETTERS, 3, 10).filter((w) => w !== 'bearer' && w !== 'basic' && w !== 'token' && w !== 'digest');
const neutralValue: fc.Arbitrary<string | number | boolean> = fc.oneof(word, fc.integer({ min: 0, max: 100000 }), uuid, fc.boolean());

// ---- Body trees ----

type Leaf =
  | { t: 'secret'; value: string }
  | { t: 'wild'; planted: Planted }
  | { t: 'neutral'; value: string | number | boolean };
type Entry = { key: string; node: Leaf | { t: 'obj'; entries: Entry[] } | { t: 'arr'; items: Entry[][] } };

const leafEntry: fc.Arbitrary<Entry> = fc.oneof(
  fc.tuple(sensitiveKey, secretValue).map(([key, value]) => ({ key, node: { t: 'secret', value } as Leaf })),
  fc.tuple(neutralKey, wildValue).map(([key, planted]) => ({ key, node: { t: 'wild', planted } as Leaf })),
  fc.tuple(neutralKey, neutralValue).map(([key, value]) => ({ key, node: { t: 'neutral', value } as Leaf })),
  fc.tuple(neutralKey, neutralValue).map(([key, value]) => ({ key, node: { t: 'neutral', value } as Leaf }))
);

function entryArb(depth: number): fc.Arbitrary<Entry> {
  if (depth <= 0) return leafEntry;
  const inner = fc.array(entryArb(depth - 1), { maxLength: 4 });
  return fc.oneof(
    { weight: 4, arbitrary: leafEntry },
    { weight: 2, arbitrary: fc.tuple(fc.constantFrom(...CONTAINER_KEYS), inner).map(([key, entries]) => ({ key, node: { t: 'obj', entries } as const })) },
    { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...CONTAINER_KEYS), fc.array(inner, { maxLength: 3 })).map(([key, items]) => ({ key, node: { t: 'arr', items } as const })) }
  );
}

interface Built {
  value: unknown;
  /** Same shape with every redacted position replaced by '<S>'. */
  expected: unknown;
  secrets: string[];
}

function buildEntries(entries: Entry[]): Built {
  const value: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  const secrets: string[] = [];
  const seen = new Set<string>();
  for (const { key, node } of entries) {
    if (seen.has(key)) continue; // first entry wins when a key repeats
    seen.add(key);
    if (node.t === 'secret') {
      value[key] = node.value;
      expected[key] = '<S>';
      secrets.push(node.value);
    } else if (node.t === 'wild') {
      value[key] = node.planted.value;
      expected[key] = '<S>';
      secrets.push(...node.planted.secrets);
    } else if (node.t === 'neutral') {
      value[key] = node.value;
      expected[key] = node.value;
    } else if (node.t === 'obj') {
      const b = buildEntries(node.entries);
      value[key] = b.value;
      expected[key] = b.expected;
      secrets.push(...b.secrets);
    } else {
      const parts = node.items.map(buildEntries);
      value[key] = parts.map((p) => p.value);
      expected[key] = parts.map((p) => p.expected);
      for (const p of parts) secrets.push(...p.secrets);
    }
  }
  return { value, expected, secrets };
}

// ---- Whole requests ----

const SENSITIVE_HEADERS = ['Authorization', 'Cookie', 'Set-Cookie', 'Proxy-Authorization', 'X-API-Key'];
const recase = (name: string, mode: string) => (mode === 'lower' ? name.toLowerCase() : mode === 'upper' ? name.toUpperCase() : name);

type HeaderSpec =
  | { t: 'sens'; name: string; value: Planted }
  | { t: 'wild'; name: string; planted: Planted }
  | { t: 'neutral'; name: string; value: string };

const sensitiveHeader: fc.Arbitrary<HeaderSpec> = fc
  .tuple(fc.constantFrom(...SENSITIVE_HEADERS), fc.constantFrom('keep', 'lower', 'upper'), secretValue, secretValue, fc.constantFrom('bearer', 'basic', 'raw', 'cookie'))
  .map(([base, casing, s1, s2, form]) => {
    const value: Planted =
      base === 'Cookie' || base === 'Set-Cookie'
        ? { value: `sid=${s1}; theme=dark; ${'x'}=${s2}`, secrets: [s1, s2] }
        : form === 'bearer' ? { value: `Bearer ${s1}`, secrets: [s1] }
          : form === 'basic' ? { value: `Basic ${s1}`, secrets: [s1] }
            : { value: s1, secrets: [s1] };
    return { t: 'sens', name: recase(base, casing), value };
  });
const wildHeader: fc.Arbitrary<HeaderSpec> = fc.tuple(fc.constantFrom('X-Trace', 'X-Note'), wildValue).map(([name, planted]) => ({ t: 'wild', name, planted }));
const neutralHeader: fc.Arbitrary<HeaderSpec> = fc
  .tuple(fc.constantFrom('Accept', 'Accept-Language', 'X-Request-Id', 'User-Agent'), uuid, word)
  .map(([name, id, w]) => ({ t: 'neutral', name, value: name === 'X-Request-Id' ? id : name === 'Accept' ? 'application/json' : w }));

type QuerySpec = { t: 'secret'; key: string; value: string } | { t: 'wild'; key: string; planted: Planted } | { t: 'neutral'; key: string; value: string };
const queryEntry: fc.Arbitrary<QuerySpec> = fc.oneof(
  fc.tuple(sensitiveKey, secretValue).map(([key, value]) => ({ t: 'secret', key, value }) as QuerySpec),
  fc.tuple(fc.constantFrom('ref', 'q', 'page', 'sort'), wildValue).map(([key, planted]) => ({ t: 'wild', key, planted }) as QuerySpec),
  fc.tuple(fc.constantFrom('limit', 'filter', 'lang', 'view'), fc.oneof(word, fc.uuid(), fc.integer({ min: 0, max: 999 }).map(String))).map(([key, value]) => ({ t: 'neutral', key, value }) as QuerySpec)
);

interface Case {
  request: RecordedRequest;
  secrets: string[];
  expectedUrl: string;
  expectedMethod: string;
  expectedBody: unknown;
  hasBody: boolean;
  neutralHeaders: Record<string, string>;
  neutralQuery: Record<string, string>;
}

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    method: fc.constantFrom('get', 'POST', 'Put', 'delete', 'PATCH'),
    scheme: fc.constantFrom('http', 'https'),
    host: chars(LETTERS, 3, 10),
    segments: fc.array(chars(LETTERS, 1, 8), { maxLength: 3 }),
    userinfo: fc.option(fc.record({ user: chars(LETTERS, 3, 8), pass: chars(ALNUM, 16, 24) }), { nil: undefined }),
    query: fc.array(queryEntry, { maxLength: 5 }),
    headers: fc.array(fc.oneof(sensitiveHeader, wildHeader, neutralHeader), { maxLength: 6 }),
    bodyMode: fc.constantFrom('none', 'object', 'json', 'form'),
    body: fc.array(entryArb(3), { maxLength: 6 }),
    formBody: fc.array(leafEntry, { maxLength: 6 }),
  })
  .map((s): Case => {
    const secrets: string[] = [];
    const path = s.segments.length === 0 ? '/' : '/' + s.segments.join('/');
    const origin = `${s.scheme}://${s.host}.example`;
    let url = origin;
    if (s.userinfo !== undefined) {
      url = `${s.scheme}://${s.userinfo.user}:${s.userinfo.pass}@${s.host}.example`;
      secrets.push(s.userinfo.pass);
    }
    url += path;

    const query = new URLSearchParams();
    const neutralQuery: Record<string, string> = {};
    const seenQ = new Set<string>();
    for (const q of s.query) {
      if (seenQ.has(q.key)) continue;
      seenQ.add(q.key);
      if (q.t === 'secret') { query.set(q.key, q.value); secrets.push(q.value); }
      else if (q.t === 'wild') { query.set(q.key, q.planted.value); secrets.push(...q.planted.secrets); }
      else { query.set(q.key, q.value); neutralQuery[q.key] = q.value; }
    }
    const search = query.toString();
    if (search !== '') url += `?${search}`;
    if (s.segments.length % 2 === 0) url += '#frag';

    const headers: Record<string, string> = {};
    const neutralHeaders: Record<string, string> = {};
    const seenH = new Set<string>();
    for (const h of s.headers) {
      if (seenH.has(h.name.toLowerCase())) continue;
      seenH.add(h.name.toLowerCase());
      if (h.t === 'sens') { headers[h.name] = h.value.value; secrets.push(...h.value.secrets); }
      else if (h.t === 'wild') { headers[h.name] = h.planted.value; secrets.push(...h.planted.secrets); }
      else { headers[h.name] = h.value; neutralHeaders[h.name] = h.value; }
    }

    let body: unknown;
    let expectedBody: unknown;
    if (s.bodyMode === 'object' || s.bodyMode === 'json') {
      const b = buildEntries(s.body);
      body = s.bodyMode === 'object' ? b.value : JSON.stringify(b.value);
      expectedBody = b.expected;
      secrets.push(...b.secrets);
    } else if (s.bodyMode === 'form') {
      const flat = buildEntries(s.formBody);
      const form = new URLSearchParams();
      const expected: Record<string, string> = {};
      for (const [k, v] of Object.entries(flat.value as Record<string, unknown>)) {
        form.set(k, String(v));
        expected[k] = String((flat.expected as Record<string, unknown>)[k]);
      }
      body = form.toString();
      expectedBody = expected;
      secrets.push(...flat.secrets);
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    // An empty body ("", "{}" is still a body) is not recorded
    const hasBody = body !== undefined && body !== '';
    return {
      request: { method: s.method, url, headers, ...(body === undefined ? {} : { body }) },
      secrets,
      expectedUrl: origin + path,
      expectedMethod: s.method.toUpperCase(),
      expectedBody,
      hasBody,
      neutralHeaders,
      neutralQuery,
    };
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refs(out: RedactedRequest): string[] {
  const names: string[] = [];
  const walk = (v: unknown): void => {
    if (isSecretReference(v)) names.push(v.$secret);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
  };
  walk(out.headers);
  walk(out.query);
  walk(out.body);
  return names;
}

function normalise(v: unknown): unknown {
  if (isSecretReference(v)) return '<S>';
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  return v;
}

function resolve(out: RedactedRequest, where: 'header' | 'query' | 'body', name: string): unknown {
  if (where === 'header') return out.headers[name];
  if (where === 'query') return out.query[name];
  let cur: unknown = out.body;
  for (const token of name.match(/[^.[\]]+/g) ?? []) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

function workflowWith(out: RedactedRequest): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'http://localhost/',
    workflows: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'w',
        steps: [{ actionType: 'click', selectors: ['#go'], http: { method: out.method, url: out.url, query: out.query, headers: out.headers, body: out.body, bindings: [], redacted: out.redacted } }],
        variables: [],
        observedPayloads: [],
      },
    ],
  } as unknown as WorkflowSet;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 11: redaction removes sensitive values', () => {
  it('leaves no planted secret in the serialized output, keeps neutral values, lists every replacement', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const out = redactRequest(c.request);
        const serialized = JSON.stringify(out);

        // 1. No planted value, raw, JSON-escaped, URL-encoded (or base64/hex) in the serialized output
        const leaked: string[] = [];
        for (const secret of c.secrets) {
          for (const { form, text } of encodedForms(secret)) {
            if (serialized.includes(text)) leaked.push(`${form}:${secret}`);
          }
        }
        expect(leaked).toEqual([]);

        // 2. No literal secret per the recipe validators
        expect(findLiteralSecrets({ url: out.url, query: out.query, headers: out.headers, body: out.body })).toEqual([]);
        expect(findPlainSecrets(workflowWith(out))).toEqual([]);

        // 3. Every replaced position is listed, and every entry points at a reference with its name
        const names = refs(out);
        expect(out.redacted).toHaveLength(names.length);
        for (const entry of out.redacted) {
          const at = resolve(out, entry.in, entry.name);
          expect(isSecretReference(at) ? at.$secret : undefined).toBe(entry.secret);
        }

        // 4. Names match the grammar and are unique inside the request
        for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(new Set(names).size).toBe(names.length);

        // 5. Neutral values are untouched
        expect(out.method).toBe(c.expectedMethod);
        expect(out.url).toBe(c.expectedUrl);
        for (const [k, v] of Object.entries(c.neutralHeaders)) expect(out.headers[k]).toBe(v);
        for (const [k, v] of Object.entries(c.neutralQuery)) expect(out.query[k]).toBe(v);
        if (c.hasBody) expect(normalise(out.body)).toEqual(c.expectedBody);
        else expect(out.body).toBeUndefined();

        // 6. Deterministic: same input, same output and the same $secret names
        expect(redactRequest(c.request)).toEqual(out);

        // 7. Idempotent: redacting the redacted request changes nothing and finds nothing new
        const again = redactRequest({
          method: out.method,
          url: out.url,
          headers: out.headers as unknown as Record<string, string>,
          ...(out.body === undefined ? {} : { body: out.body }),
        });
        expect(again.headers).toEqual(out.headers);
        expect(again.url).toBe(out.url);
        expect(again.body).toEqual(out.body);
        expect(again.redacted).toEqual([]);
        const plainQuery = Object.fromEntries(Object.entries(out.query).filter(([, v]) => typeof v === 'string'));
        const againQuery = redactRequest({ method: 'GET', url: `${out.url}?${new URLSearchParams(plainQuery as Record<string, string>).toString()}` });
        expect(againQuery.query).toEqual(plainQuery);
        expect(againQuery.redacted).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });

  it('is deterministic for a fixed example', () => {
    const request: RecordedRequest = { method: 'post', url: 'https://u:pw123456789012345678@h.example/a?token=abcdefghij0123456789', headers: { Cookie: 'sid=abc' }, body: { password: 'x' } };
    expect(JSON.stringify(redactRequest(request))).toBe(JSON.stringify(redactRequest(request)));
  });
});
