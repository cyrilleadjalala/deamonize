import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpReplayError,
  buildRequest,
  compareShapes,
  cookieHeaderFor,
  cookieHeaderFromState,
  execute,
  extractResponse,
  httpSecretNames,
  isHttpOnly,
  missingHttpSecrets,
  planSteps,
  rebaseOrigin,
  runHttpStep,
  shapeHash,
  shapeOf,
  trimJson,
  withRecordedDefaults,
  type HttpRecipeLike,
  type StoredCookie,
} from '../../src/replay/runtime/http-replay.js';
import { removeDir } from '../helpers/cleanup.js';

const recipe = (extra: Partial<HttpRecipeLike> = {}): HttpRecipeLike => ({
  method: 'GET',
  url: 'http://app.test/api/customers',
  query: {},
  bindings: [],
  ...extra,
});

describe('buildRequest', () => {
  it('fills the query, the path and the headers and encodes them', () => {
    const request = buildRequest(
      recipe({
        url: 'http://app.test/api/customers/{{id}}/notes',
        query: { q: '{{query}}', fixed: 'a b' },
        headers: { 'x-trace': 'id-{{id}}' },
      }),
      { id: 'a/b c', query: 'Ada & Bob' },
      {}
    );
    expect(request.url).toBe('http://app.test/api/customers/a%2Fb%20c/notes?q=Ada+%26+Bob&fixed=a+b');
    expect(request.headers['x-trace']).toBe('id-a/b c');
    expect(request.method).toBe('GET');
  });

  it('replaces {"$var"} leaves of a JSON body with typed values', () => {
    const request = buildRequest(
      recipe({
        method: 'POST',
        body: { name: { $var: 'name' }, qty: { $var: 'qty', as: 'number' }, vip: { $var: 'vip', as: 'boolean' }, tags: [{ $var: 'tag' }], keep: 'x' },
        bodyFormat: 'json',
      }),
      { name: 'Zed', qty: '3', vip: 'true', tag: 7 },
      {}
    );
    expect(JSON.parse(request.body as string)).toEqual({ name: 'Zed', qty: 3, vip: true, tags: ['7'], keep: 'x' });
    expect(request.headers['content-type']).toBe('application/json');
  });

  it('encodes a form body and keeps an explicit content type', () => {
    const request = buildRequest(
      recipe({ method: 'POST', bodyFormat: 'form', body: { a: { $var: 'a' }, list: ['1', '2'] }, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } }),
      { a: 'x y&z' },
      {}
    );
    expect(request.body).toBe('a=x+y%26z&list=1&list=2');
    expect(Object.keys(request.headers).filter((h) => h.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('rejects a value that is not a number or a boolean', () => {
    const body = { n: { $var: 'n', as: 'number' } };
    expect(() => buildRequest(recipe({ method: 'POST', body }), { n: 'abc' }, {})).toThrow(/"n" is not a number/);
    expect(() => buildRequest(recipe({ method: 'POST', body: { b: { $var: 'b', as: 'boolean' } } }), { b: 'maybe' }, {})).toThrow(/not a boolean/);
  });

  it('names the variable that has no value', () => {
    expect(() => buildRequest(recipe({ query: { q: '{{query}}' } }), {}, {})).toThrow(/no value for the variable "query"/);
  });

  it('resolves {"$secret"} from DAEMONIZE_SECRET_<NAME> in headers, query and body', () => {
    const request = buildRequest(
      recipe({
        method: 'POST',
        query: { key: { $secret: 'API_KEY' } },
        headers: { authorization: { $secret: 'AUTHORIZATION' } },
        body: { token: { $secret: 'BODY_TOKEN' } },
      }),
      {},
      { DAEMONIZE_SECRET_API_KEY: 'k-1', DAEMONIZE_SECRET_AUTHORIZATION: 'Bearer abc', DAEMONIZE_SECRET_BODY_TOKEN: 't-2' }
    );
    expect(request.url).toBe('http://app.test/api/customers?key=k-1');
    expect(request.headers.authorization).toBe('Bearer abc');
    expect(JSON.parse(request.body as string)).toEqual({ token: 't-2' });
    expect(request.secrets.sort()).toEqual(['Bearer abc', 'k-1', 't-2']);
  });

  it('fails on a missing secret and names the variable, not a value', () => {
    let error: unknown;
    try {
      buildRequest(recipe({ headers: { authorization: { $secret: 'AUTHORIZATION' } } }), {}, { DAEMONIZE_SECRET_OTHER: 'x' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HttpReplayError);
    expect((error as HttpReplayError).kind).toBe('missing_secret');
    expect((error as HttpReplayError).variable).toBe('DAEMONIZE_SECRET_AUTHORIZATION');
    expect((error as Error).message).toContain('DAEMONIZE_SECRET_AUTHORIZATION');
    expect(() => buildRequest(recipe({ headers: { authorization: { $secret: 'A' } } }), {}, { DAEMONIZE_SECRET_A: '' })).toThrow(/DAEMONIZE_SECRET_A/);
  });

  it('refuses a header value with a line break and a non-http URL', () => {
    expect(() => buildRequest(recipe({ headers: { 'x-a': '{{v}}' } }), { v: 'a\r\nx-b: 1' }, {})).toThrow(/line break/);
    expect(() => buildRequest(recipe({ url: 'file:///etc/passwd' }), {}, {})).toThrow(/absolute http/);
  });

  it('lists the secrets of the recipes and those missing', () => {
    const steps = [
      { http: recipe({ headers: { a: { $secret: 'ONE' } }, query: { b: { $secret: 'TWO' } } }) },
      { http: recipe({ body: { c: [{ $secret: 'ONE' }] } }) },
      {},
    ];
    expect(httpSecretNames(steps[0].http)).toEqual(['ONE', 'TWO']);
    expect(missingHttpSecrets(steps, { DAEMONIZE_SECRET_ONE: 'v' })).toEqual(['DAEMONIZE_SECRET_TWO']);
    expect(missingHttpSecrets(steps, { DAEMONIZE_SECRET_ONE: 'v', DAEMONIZE_SECRET_TWO: 'w' })).toEqual([]);
  });

  it('uses the recorded value of a variable the call does not supply', () => {
    expect(withRecordedDefaults([{ variable: 'q', value: 'Ada' }], {})).toEqual({ q: 'Ada' });
    expect(withRecordedDefaults([{ variable: 'q', value: 'Ada' }], { q: 'Bob' })).toEqual({ q: 'Bob' });
    expect(rebaseOrigin('http://127.0.0.1:1/api/x', 'http://127.0.0.1:1/', 'http://app:8080/start')).toBe('http://app:8080/api/x');
  });
});

describe('cookie header from a storage state', () => {
  const NOW = Date.UTC(2025, 0, 1);
  const cookie = (extra: Partial<StoredCookie>): StoredCookie => ({ name: 'sid', value: 'v', domain: 'app.test', path: '/', expires: -1, ...extra });

  it('matches by domain: exact for a host cookie, subdomains for a dotted one', () => {
    const cookies = [cookie({ name: 'host', domain: 'app.test' }), cookie({ name: 'dot', domain: '.app.test' }), cookie({ name: 'other', domain: 'other.test' })];
    expect(cookieHeaderFromState('http://app.test/x', { cookies }, NOW)).toBe('host=v; dot=v');
    expect(cookieHeaderFromState('http://www.app.test/x', { cookies }, NOW)).toBe('dot=v');
    expect(cookieHeaderFromState('http://notapp.test/x', { cookies }, NOW)).toBeUndefined();
  });

  it('matches by path, the most specific first', () => {
    const cookies = [cookie({ name: 'root', path: '/' }), cookie({ name: 'api', path: '/api' }), cookie({ name: 'admin', path: '/admin' })];
    expect(cookieHeaderFromState('http://app.test/api/customers', { cookies }, NOW)).toBe('api=v; root=v');
    expect(cookieHeaderFromState('http://app.test/apix', { cookies }, NOW)).toBe('root=v');
    expect(cookieHeaderFromState('http://app.test/api', { cookies }, NOW)).toBe('api=v; root=v');
  });

  it('sends a Secure cookie over https and to localhost only', () => {
    const cookies = [cookie({ secure: true })];
    expect(cookieHeaderFromState('http://app.test/', { cookies }, NOW)).toBeUndefined();
    expect(cookieHeaderFromState('https://app.test/', { cookies }, NOW)).toBe('sid=v');
    expect(cookieHeaderFromState('http://localhost/', { cookies: [cookie({ secure: true, domain: 'localhost' })] }, NOW)).toBe('sid=v');
  });

  it('drops an expired cookie and keeps a session or future one', () => {
    const cookies = [
      cookie({ name: 'old', expires: NOW / 1000 - 10 }),
      cookie({ name: 'future', expires: NOW / 1000 + 3600 }),
      cookie({ name: 'session', expires: -1 }),
    ];
    expect(cookieHeaderFromState('http://app.test/', { cookies }, NOW)).toBe('future=v; session=v');
  });

  it('reads the file into memory and reports an unreadable one without quoting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemonize-cookie-'));
    try {
      const good = join(dir, 'state.json');
      writeFileSync(good, JSON.stringify({ cookies: [cookie({ value: 'abc' })], origins: [] }));
      expect(cookieHeaderFor('http://app.test/', good, NOW)).toBe('sid=abc');
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, 'SECRET-CONTENT {');
      let message = '';
      try {
        cookieHeaderFor('http://app.test/', bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/cannot be read/);
      expect(message).not.toContain('SECRET-CONTENT');
    } finally {
      void removeDir(dir);
    }
  });
});

describe('shapes and drift', () => {
  const recorded = shapeOf({ customers: [{ id: 1, name: 'Ada' }], total: 1 });

  it('hashes equal shapes alike whatever the order of the properties', () => {
    expect(shapeHash(shapeOf({ a: 1, b: 'x' }))).toBe(shapeHash(shapeOf({ b: 'y', a: 2 })));
    expect(shapeHash(shapeOf({ a: 1 }))).not.toBe(shapeHash(shapeOf({ a: 'x' })));
  });

  it('is identical for the same shape, even with an empty list or another number kind', () => {
    expect(compareShapes(recorded, shapeOf({ customers: [{ id: 5, name: 'Bob' }], total: 1 }))).toMatchObject({ compatible: true, identical: true });
    expect(compareShapes(recorded, shapeOf({ customers: [], total: 0 }))).toMatchObject({ compatible: true, identical: true });
    expect(compareShapes(recorded, shapeOf({ customers: [{ id: 1.5, name: null }], total: 1 }))).toMatchObject({ compatible: true, identical: true });
  });

  it('is compatible but not identical when a property was added', () => {
    const result = compareShapes(recorded, shapeOf({ customers: [{ id: 1, name: 'A', vip: true }], total: 1, page: 1 }));
    expect(result.compatible).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.differences.join(' ')).toContain('new property');
  });

  it('is incompatible when a recorded property is missing or retyped', () => {
    const missing = compareShapes(recorded, shapeOf({ results: [] }));
    expect(missing.compatible).toBe(false);
    expect(missing.differences).toContain('/customers: missing');
    const retyped = compareShapes(recorded, shapeOf({ customers: [{ id: 'x', name: 'A' }], total: 1 }));
    expect(retyped.compatible).toBe(false);
    expect(retyped.differences[0]).toContain('expected integer, got string');
  });

  it('extractResponse checks the status, the JSON and the shape', () => {
    const withShape = recipe({ expectStatus: 200, responseShape: recorded });
    expect(extractResponse(withShape, { status: 500, hasJson: true, json: {} })).toMatchObject({ ok: false, kind: 'status' });
    expect(extractResponse(withShape, { status: 200, hasJson: false })).toMatchObject({ ok: false, kind: 'shape' });
    expect(extractResponse(withShape, { status: 200, hasJson: true, json: { results: [] } })).toMatchObject({ ok: false, kind: 'shape' });
    expect(extractResponse(withShape, { status: 200, hasJson: true, json: { customers: [], total: 0 } })).toMatchObject({ ok: true, drifted: false, driftChecked: true });
    expect(extractResponse(withShape, { status: 200, hasJson: true, json: { customers: [], total: 0, extra: 1 } })).toMatchObject({ ok: true, drifted: true });
    // Without a recorded shape nothing can drift; a recorded 204 has no body
    expect(extractResponse(recipe({ expectStatus: 204 }), { status: 204, hasJson: false })).toEqual({ ok: true, data: null, drifted: false, driftChecked: false });
    expect(extractResponse(recipe(), { status: 201, hasJson: true, json: { a: 1 } })).toMatchObject({ ok: true, data: { a: 1 } });
  });

  it('trims a large response by cutting arrays, then text', () => {
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `customer ${i}` })) };
    const trimmed = trimJson(big, 2000);
    expect(trimmed.truncated).toBe(true);
    expect(JSON.stringify(trimmed.value).length).toBeLessThanOrEqual(2000);
    expect((trimmed.value as typeof big).rows[0]).toEqual({ id: 0, name: 'customer 0' });
    expect(trimJson({ a: 1 }, 2000)).toEqual({ value: { a: 1 }, truncated: false });
    const text = trimJson({ s: 'x'.repeat(5000) }, 100);
    expect(typeof text.value).toBe('string');
    expect((text.value as string).length).toBe(100);
  });
});

describe('planning the steps', () => {
  const http = (variable: string): HttpRecipeLike => recipe({ bindings: [{ variable, in: 'query', name: 'q' }] });

  it('runs a workflow of field-filling steps and requests entirely over HTTP', () => {
    const plan = planSteps([{ actionType: 'type', variable: 'q' }, { actionType: 'click', http: http('q') }]);
    expect(plan).toEqual(['prep', 'http']);
    expect(isHttpOnly(plan)).toBe(true);
  });

  it('keeps a click, a secret or an unbound variable on the page', () => {
    expect(planSteps([{ actionType: 'type', variable: 'other' }, { actionType: 'click', http: http('q') }])).toEqual(['ui', 'http']);
    expect(planSteps([{ actionType: 'type', secretRef: 'PW' }, { actionType: 'click', http: http('q') }])).toEqual(['ui', 'http']);
    expect(planSteps([{ actionType: 'click', http: http('q') }, { actionType: 'click' }])).toEqual(['http', 'ui']);
    // Nothing after it carries the value
    expect(planSteps([{ actionType: 'click', http: http('q') }, { actionType: 'type', variable: 'q' }])).toEqual(['http', 'ui']);
    expect(isHttpOnly(planSteps([]))).toBe(false);
  });
});

describe('execute and runHttpStep', () => {
  const json = (status: number, value: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('follows redirects by hand, bounded, and drops credentials across origins', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; method: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, method: init.method as string, body: init.body });
      if (url === 'http://app.test/a') return new Response(null, { status: 302, headers: { location: '/b' } });
      if (url === 'http://app.test/b') return new Response(null, { status: 307, headers: { location: 'http://other.test/c' } });
      return json(200, { ok: true });
    }) as unknown as typeof fetch;
    const request = buildRequest(recipe({ method: 'POST', url: 'http://app.test/a', body: { a: 1 }, headers: { authorization: { $secret: 'T' } } }), {}, { DAEMONIZE_SECRET_T: 'Bearer zzz' });
    const response = await execute(request, { timeoutMs: 1000, fetchImpl });
    expect(response).toEqual({ status: 200, hasJson: true, json: { ok: true } });
    // 302 after a POST becomes a GET without body; the 307 keeps it; the other origin gets no credential
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET', 'GET']);
    expect(seen[0].headers.authorization).toBe('Bearer zzz');
    expect(seen[1].headers.authorization).toBe('Bearer zzz');
    expect(seen[2].headers.authorization).toBeUndefined();

    const loop = (async () => new Response(null, { status: 302, headers: { location: '/again' } })) as unknown as typeof fetch;
    await expect(execute(buildRequest(recipe(), {}, {}), { timeoutMs: 1000, fetchImpl: loop, maxRedirects: 3 })).rejects.toThrow(/more than 3 redirects/);
  });

  it('times out and scrubs secrets from a network error', async () => {
    const slow = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(execute(buildRequest(recipe(), {}, {}), { timeoutMs: 30, fetchImpl: slow })).rejects.toMatchObject({ kind: 'timeout' });

    const broken = (async () => {
      throw Object.assign(new TypeError('fetch failed Bearer s3cr3t-value'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const error = await execute(buildRequest(recipe({ headers: { authorization: { $secret: 'T' } } }), {}, { DAEMONIZE_SECRET_T: 's3cr3t-value' }), { timeoutMs: 1000, fetchImpl: broken }).catch((e) => e as Error);
    expect((error as HttpReplayError).kind).toBe('network');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain('s3cr3t-value');
  });

  it('sends the cookie from the environment, never logs it, and reports the outcome', async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return json(500, { error: 'boom for sid=COOKIEVALUE123' });
    }) as unknown as typeof fetch;
    const outcome = await runHttpStep(recipe({ expectStatus: 200 }), {}, { DAEMONIZE_COOKIE_HEADER: 'sid=COOKIEVALUE123; other=2' }, { timeoutMs: 1000, fetchImpl });
    expect(sent.cookie).toBe('sid=COOKIEVALUE123; other=2');
    expect(outcome).toMatchObject({ ok: false, kind: 'status', status: 500, sent: true });
    // `secrets` is for the caller's own scrubbing; what is reported holds none
    expect((outcome as { reason: string }).reason).toBe('unexpected status 500 (recorded 200)');

    const missing = await runHttpStep(recipe({ headers: { authorization: { $secret: 'T' } } }), {}, {}, { timeoutMs: 1000, fetchImpl });
    expect(missing).toMatchObject({ ok: false, kind: 'missing_secret', sent: false, variable: 'DAEMONIZE_SECRET_T' });
  });

  it('returns the JSON of a good response with secrets removed', async () => {
    const fetchImpl = (async () => json(200, { echo: 'Bearer abc-secret', n: 1 })) as unknown as typeof fetch;
    const outcome = await runHttpStep(
      recipe({ headers: { authorization: { $secret: 'T' } }, expectStatus: 200 }),
      {},
      { DAEMONIZE_SECRET_T: 'Bearer abc-secret' },
      { timeoutMs: 1000, fetchImpl }
    );
    expect(outcome).toMatchObject({ ok: true, status: 200, data: { echo: '***', n: 1 } });
  });
});
