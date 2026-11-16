import { describe, it, expect } from 'vitest';
import {
  findLiteralSecrets,
  isSensitiveName,
  looksLikeSecretValue,
  redactBody,
  redactHeaders,
  redactRequest,
  secretNameFromKey,
} from '../../src/recorder/redactor.js';
import { findPlainSecrets, serializeWorkflowSet, deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('names', () => {
  it('derives an upper-snake name from the key', () => {
    expect(secretNameFromKey('accessToken')).toBe('ACCESS_TOKEN');
    expect(secretNameFromKey('x-api-key')).toBe('X_API_KEY');
    expect(secretNameFromKey('1st')).toBe('SECRET_1ST');
    expect(secretNameFromKey('***')).toBe('SECRET');
    for (const key of ['a b', 'Set-Cookie', 'ñ', 'user.password']) expect(secretNameFromKey(key)).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('knows credential names, as whole words for the short ones', () => {
    for (const name of ['password', 'Passwd', 'client_secret', 'accessToken', 'api_key', 'apikey', 'X-Api-Key', 'otp', 'verification_code', 'JSESSIONID', 'csrfmiddlewaretoken', 'Authorization']) {
      expect(isSensitiveName(name), name).toBe(true);
    }
    for (const name of ['zipcode', 'encoding', 'name', 'email', 'quantity', 'barcode', 'pinned']) {
      expect(isSensitiveName(name), name).toBe(false);
    }
  });

  it('recognises token-looking values and leaves ids alone', () => {
    expect(looksLikeSecretValue(JWT)).toBe(true);
    expect(looksLikeSecretValue('Bearer abc123def456')).toBe(true);
    expect(looksLikeSecretValue('Basic dXNlcjpwYXNzd29yZA==')).toBe(true);
    expect(looksLikeSecretValue('sk_live_51Habcdefghijklmnop1234')).toBe(true);
    expect(looksLikeSecretValue('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(looksLikeSecretValue('internationalizationandlocalization')).toBe(false);
    expect(looksLikeSecretValue('12345678901234567890123456')).toBe(false);
    expect(looksLikeSecretValue('507f1f77bcf86cd799439011', false)).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('replaces credential headers by references and keeps the others', () => {
    const { headers, redacted } = redactHeaders({
      Authorization: 'Bearer abc.def.ghi',
      Cookie: 'sid=1; theme=dark',
      'Set-Cookie': 'sid=2; HttpOnly',
      'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
      'X-API-Key': 'k-12345',
      'X-CSRF-Token': 'c-999',
      'X-Auth': 'a',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(headers).toEqual({
      Authorization: { $secret: 'AUTHORIZATION' },
      Cookie: { $secret: 'COOKIE' },
      'Set-Cookie': { $secret: 'SET_COOKIE' },
      'Proxy-Authorization': { $secret: 'PROXY_AUTHORIZATION' },
      'X-API-Key': { $secret: 'X_API_KEY' },
      'X-CSRF-Token': { $secret: 'X_CSRF_TOKEN' },
      'X-Auth': { $secret: 'X_AUTH' },
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(redacted).toHaveLength(7);
    expect(redacted[0]).toEqual({ in: 'header', name: 'Authorization', secret: 'AUTHORIZATION' });
    expect(JSON.stringify({ headers, redacted })).not.toMatch(/abc\.def|sid=|k-12345|c-999/);
  });
});

describe('redactBody', () => {
  it('redacts nested JSON by key and by value, with unique names', () => {
    const { body, redacted } = redactBody({
      user: { name: 'ada', password: 'hunter2', profile: { token: 'tk-1' } },
      items: [{ sku: 'A1', apiKey: 'key-1' }, { sku: 'A2', apiKey: 'key-2' }],
      note: JWT,
      otp: 123456,
      zip: '75001',
    });
    expect(body).toEqual({
      user: { name: 'ada', password: { $secret: 'PASSWORD' }, profile: { token: { $secret: 'TOKEN' } } },
      items: [{ sku: 'A1', apiKey: { $secret: 'API_KEY' } }, { sku: 'A2', apiKey: { $secret: 'API_KEY_2' } }],
      note: { $secret: 'NOTE' },
      otp: { $secret: 'OTP' },
      zip: '75001',
    });
    expect(redacted.map((r) => r.name)).toEqual(['user.password', 'user.profile.token', 'items[0].apiKey', 'items[1].apiKey', 'note', 'otp']);
    expect(new Set(redacted.map((r) => r.secret)).size).toBe(redacted.length);
  });

  it('redacts everything inside a credential object', () => {
    const { body } = redactBody({ session: { id: 'abc', user: { n: 1 } } });
    expect(body).toEqual({ session: { id: { $secret: 'ID' }, user: { n: { $secret: 'N' } } } });
  });

  it('parses JSON text and form-encoded text', () => {
    const json = redactBody('{"password":"pw-1","name":"x"}', 'application/json');
    expect(json).toMatchObject({ format: 'json', body: { password: { $secret: 'PASSWORD' }, name: 'x' } });
    const form = redactBody('user=ada&password=pw%202&csrf=zzz&tag=a&tag=b', 'application/x-www-form-urlencoded');
    expect(form).toMatchObject({
      format: 'form',
      body: { user: 'ada', password: { $secret: 'PASSWORD' }, csrf: { $secret: 'CSRF' }, tag: ['a', 'b'] },
    });
    expect(JSON.stringify(form)).not.toMatch(/pw%202|pw 2|zzz/);
  });

  it('keeps plain text and replaces a bare token', () => {
    expect(redactBody('hello world')).toMatchObject({ format: 'text', body: 'hello world', redacted: [] });
    expect(redactBody(JWT)).toMatchObject({ format: 'text', body: { $secret: 'BODY' } });
  });

  it('keeps references that are already there', () => {
    expect(redactBody({ password: { $secret: 'PW' } })).toMatchObject({ body: { password: { $secret: 'PW' } }, redacted: [] });
  });
});

describe('redactRequest', () => {
  const request = {
    method: 'post',
    url: 'https://user:s3cr3t-pw@api.example.com/v1/login?next=%2Fhome&access_token=at-123&page=2#frag=1',
    headers: { Authorization: 'Bearer zzz.yyy.xxx', 'Content-Type': 'application/json', Accept: '*/*' },
    body: '{"email":"a@b.c","password":"pw-9","remember":true}',
  };

  it('removes credentials, query values and body values and lists what it did', () => {
    const out = redactRequest(request);
    expect(out.method).toBe('POST');
    expect(out.url).toBe('https://api.example.com/v1/login');
    expect(out.query).toEqual({ next: '/home', access_token: { $secret: 'ACCESS_TOKEN' }, page: '2' });
    expect(out.headers['Authorization']).toEqual({ $secret: 'AUTHORIZATION' });
    expect(out.headers['Accept']).toBe('*/*');
    expect(out.body).toEqual({ email: 'a@b.c', password: { $secret: 'PASSWORD' }, remember: true });
    expect(out.bodyFormat).toBe('json');
    expect(out.redacted.map((r) => `${r.in}:${r.name}`)).toEqual(['header:Authorization', 'query:access_token', 'body:password']);
    const text = JSON.stringify(out);
    for (const leaked of ['s3cr3t-pw', 'at-123', 'zzz.yyy.xxx', 'pw-9', 'frag']) expect(text).not.toContain(leaked);
  });

  it('turns credentials of the URL into an authorization reference', () => {
    const out = redactRequest({ method: 'GET', url: 'http://u:p@host/x' });
    expect(out.headers['Authorization']).toEqual({ $secret: 'AUTHORIZATION' });
    expect(out.url).toBe('http://host/x');
  });

  it('is pure and deterministic', () => {
    const copy = structuredClone(request);
    const first = redactRequest(request);
    expect(request).toEqual(copy);
    expect(redactRequest(request)).toEqual(first);
  });

  it('handles relative URLs', () => {
    expect(redactRequest({ method: 'get', url: '/api/me?token=abc&x=1' })).toMatchObject({
      url: '/api/me',
      query: { token: { $secret: 'TOKEN' }, x: '1' },
    });
  });
});

describe('findPlainSecrets integration', () => {
  function setWith(http: Record<string, unknown>): WorkflowSet {
    return {
      version: '1',
      targetType: 'web',
      targetName: 'app',
      startUrl: 'http://localhost/',
      workflows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          label: 'login',
          steps: [{ actionType: 'click', selectors: ['#go'], http: { method: 'POST', url: 'http://localhost/login', query: {}, bindings: [], redacted: [], ...http } }],
          variables: [],
          observedPayloads: [],
        },
      ],
    } as unknown as WorkflowSet;
  }

  it('rejects a recipe holding a literal secret, in a header, the query or the body', () => {
    expect(findPlainSecrets(setWith({ headers: { Authorization: 'Bearer abc123def' } }))).toEqual([
      '$.workflows[0].steps[0].http.headers.Authorization',
    ]);
    expect(findPlainSecrets(setWith({ query: { api_key: 'k1' } }))).toEqual(['$.workflows[0].steps[0].http.query.api_key']);
    expect(findPlainSecrets(setWith({ body: { user: { password: 'pw' }, jwt: JWT } }))).toEqual([
      '$.workflows[0].steps[0].http.body.user.password',
      '$.workflows[0].steps[0].http.body.jwt',
    ]);
    expect(() => serializeWorkflowSet(setWith({ body: { password: 'pw' } }))).toThrow(/plain-text secrets/);
    expect(() => deserializeWorkflowSet(JSON.stringify(setWith({ body: { password: 'pw' } })))).toThrow(/plain-text secret/);
  });

  it('accepts the output of the redactor', () => {
    const out = redactRequest({
      method: 'POST',
      url: 'http://localhost/login?token=t-1',
      headers: { Authorization: 'Bearer abc123def', Cookie: 'sid=1' },
      body: { password: 'pw', id: '507f1f77bcf86cd799439011' },
    });
    const set = setWith({ query: out.query, headers: out.headers, body: out.body, redacted: out.redacted });
    expect(findPlainSecrets(set)).toEqual([]);
    expect(() => serializeWorkflowSet(set)).not.toThrow();
    expect(findLiteralSecrets({ body: { name: 'x' } })).toEqual([]);
  });
});
