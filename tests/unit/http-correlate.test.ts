import { describe, it, expect } from 'vitest';
import {
  applyTemplate,
  buildHttpRecipe,
  findBindings,
  jsonShape,
  parseBody,
  templateOf,
  type CapturedRequest,
} from '../../src/recorder/http-correlate.js';
import { findLiteralSecrets } from '../../src/recorder/redactor.js';

function captured(overrides: Partial<CapturedRequest>): CapturedRequest {
  return {
    method: 'GET',
    url: 'http://app.test/api/customers',
    startedAt: 0,
    headers: {},
    redactedHeaders: [],
    hasCookie: false,
    status: 200,
    responseKind: 'json',
    ...overrides,
  };
}

describe('findBindings', () => {
  it('finds a value in a path segment, a query parameter, a header and a JSON body leaf', () => {
    const bindings = findBindings(
      [{ name: 'id', value: '42' }, { name: 'q', value: 'Ada' }],
      {
        method: 'POST',
        url: 'http://app.test/api/customers/42?q=Ada&limit=10',
        headers: { 'x-tenant': 'Ada' },
        body: { customer: { ids: [7, 42], name: 'Ada' } },
        bodyFormat: 'json',
      }
    );
    expect(bindings).toEqual([
      { variable: 'id', in: 'path', name: '3' },
      { variable: 'q', in: 'query', name: 'q' },
      { variable: 'q', in: 'header', name: 'x-tenant' },
      { variable: 'id', in: 'body', name: '/customer/ids/1' },
      { variable: 'q', in: 'body', name: '/customer/name' },
    ]);
  });

  it('matches numbers and booleans by their string form, and url-decodes path segments', () => {
    const bindings = findBindings(
      [{ name: 'n', value: 5 }, { name: 'flag', value: true }, { name: 'who', value: 'a b/c' }],
      { method: 'PUT', url: 'http://app.test/x/a%20b%2Fc', body: { n: 5, on: true, s: '5' }, bodyFormat: 'json' }
    );
    expect(bindings).toContainEqual({ variable: 'who', in: 'path', name: '2' });
    expect(bindings).toContainEqual({ variable: 'n', in: 'body', name: '/n' });
    expect(bindings).toContainEqual({ variable: 'flag', in: 'body', name: '/on' });
    expect(bindings).toContainEqual({ variable: 'n', in: 'body', name: '/s' });
  });

  it('finds values in a form-encoded body', () => {
    const { body, bodyFormat } = parseBody('name=Ada&tags=a&tags=b', 'application/x-www-form-urlencoded');
    expect(bodyFormat).toBe('form');
    const bindings = findBindings([{ name: 'v', value: 'b' }], { method: 'POST', url: 'http://app.test/f', body, bodyFormat });
    expect(bindings).toEqual([{ variable: 'v', in: 'body', name: '/tags/1' }]);
  });

  it('ignores empty values and escapes pointer keys', () => {
    const bindings = findBindings([{ name: 'e', value: '' }, { name: 'k', value: 'v' }], {
      method: 'POST',
      url: 'http://app.test/',
      body: { 'a/b~c': 'v', empty: '' },
      bodyFormat: 'json',
    });
    expect(bindings).toEqual([{ variable: 'k', in: 'body', name: '/a~1b~0c' }]);
  });
});

describe('templateOf and applyTemplate', () => {
  it('puts placeholders at the bound positions and fills them back', () => {
    const request = {
      method: 'POST',
      url: 'http://app.test/api/customers/42/notes?q=Ada&limit=10',
      body: { text: 'Ada', count: 3, urgent: false },
      bodyFormat: 'json' as const,
    };
    const bindings = findBindings(
      [{ name: 'id', value: 42 }, { name: 'who', value: 'Ada' }, { name: 'count', value: 3 }, { name: 'urgent', value: false }],
      request
    );
    const template = templateOf(request, bindings);
    expect(template.url).toBe('http://app.test/api/customers/{{id}}/notes');
    expect(template.query).toEqual({ q: '{{who}}', limit: '10' });
    expect(template.body).toEqual({ text: { $var: 'who' }, count: { $var: 'count', as: 'number' }, urgent: { $var: 'urgent', as: 'boolean' } });

    const applied = applyTemplate(template, { id: 7, who: 'Bob Smith', count: '9', urgent: true });
    expect(applied.url).toBe('http://app.test/api/customers/7/notes?q=Bob+Smith&limit=10');
    expect(applied.body).toEqual({ text: 'Bob Smith', count: 9, urgent: true });
  });
});

describe('buildHttpRecipe', () => {
  const variables = [{ name: 'query', value: 'Ada' }];

  it('records a GET with the bound query value as a placeholder and the shape of the response', () => {
    const attempt = buildHttpRecipe(variables, captured({
      url: 'http://app.test/api/customers?q=Ada&limit=10',
      headers: { accept: 'application/json', authorization: { $secret: 'AUTHORIZATION' } },
      redactedHeaders: [{ in: 'header', name: 'authorization', secret: 'AUTHORIZATION' }],
      hasCookie: true,
      responseShape: jsonShape({ customers: [{ id: 1, name: 'Ada' }], total: 1 }),
    }));
    expect(attempt.reason).toBeUndefined();
    expect(attempt.bound).toEqual(['query']);
    expect(attempt.recipe).toMatchObject({
      method: 'GET',
      url: 'http://app.test/api/customers',
      query: { q: '{{query}}', limit: '10' },
      bindings: [{ variable: 'query', in: 'query', name: 'q' }],
      headers: { accept: 'application/json', authorization: { $secret: 'AUTHORIZATION' } },
      redacted: [{ in: 'header', name: 'authorization', secret: 'AUTHORIZATION' }],
      auth: 'env:AUTHORIZATION',
      expectStatus: 200,
    });
    expect(attempt.recipe?.responseShape).toEqual({
      type: 'object',
      properties: {
        customers: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } },
        total: { type: 'integer' },
      },
    });
  });

  it('notes storageState as the authentication when only cookies were sent', () => {
    const attempt = buildHttpRecipe(variables, captured({ url: 'http://app.test/api/customers?q=Ada', hasCookie: true }));
    expect(attempt.recipe?.auth).toBe('storageState');
    expect(JSON.stringify(attempt.recipe)).not.toMatch(/cookie/i);
  });

  it('records a JSON POST with $var markers at the bound leaves', () => {
    const attempt = buildHttpRecipe(
      [{ name: 'name', value: 'Zed' }, { name: 'email', value: 'zed@example.com' }],
      captured({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ name: 'Zed', email: 'zed@example.com', plan: 'free' }),
        status: 201,
      })
    );
    expect(attempt.recipe?.body).toEqual({ name: { $var: 'name' }, email: { $var: 'email' }, plan: 'free' });
    expect(attempt.recipe?.bindings).toEqual([
      { variable: 'name', in: 'body', name: '/name' },
      { variable: 'email', in: 'body', name: '/email' },
    ]);
    expect(attempt.recipe?.expectStatus).toBe(201);
  });

  it('binds a path segment and accepts a write without a body in the response', () => {
    const attempt = buildHttpRecipe([{ name: 'id', value: '3' }], captured({
      method: 'DELETE',
      url: 'http://app.test/api/customers/3',
      status: 204,
      responseKind: 'empty',
    }));
    expect(attempt.recipe?.url).toBe('http://app.test/api/customers/{{id}}');
    expect(attempt.recipe?.bindings).toEqual([{ variable: 'id', in: 'path', name: '3' }]);
  });

  it('refuses a response that is not JSON, and an empty read', () => {
    expect(buildHttpRecipe(variables, captured({ responseKind: 'other' })).recipe).toBeUndefined();
    expect(buildHttpRecipe(variables, captured({ responseKind: 'empty' })).reason).toMatch(/not JSON/);
  });

  it('does not bind a value that sits in a credential field, and keeps no literal secret', () => {
    const attempt = buildHttpRecipe([{ name: 'pw', value: 'hunter2hunter2' }], captured({
      method: 'POST',
      postData: JSON.stringify({ user: 'ada', password: 'hunter2hunter2' }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(attempt.bound).toEqual([]);
    expect(attempt.recipe?.body).toEqual({ user: 'ada', password: { $secret: 'PASSWORD' } });
    expect(JSON.stringify(attempt.recipe)).not.toContain('hunter2');
    expect(findLiteralSecrets(attempt.recipe!)).toEqual([]);
  });

  it('turns a form-encoded body into fields with markers', () => {
    const attempt = buildHttpRecipe([{ name: 'name', value: 'Ada' }], captured({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'name=Ada&city=Paris',
    }));
    expect(attempt.recipe?.bodyFormat).toBe('form');
    expect(attempt.recipe?.body).toEqual({ name: { $var: 'name' }, city: 'Paris' });
  });
});

describe('jsonShape', () => {
  it('keeps names and types, never values, and stays bounded', () => {
    const shape = jsonShape({ secretValue: 'hunter2', list: [1, 2.5], nested: { deep: null } });
    expect(JSON.stringify(shape)).not.toContain('hunter2');
    expect(shape).toEqual({
      type: 'object',
      properties: {
        secretValue: { type: 'string' },
        list: { type: 'array', items: { type: 'number' } },
        nested: { type: 'object', properties: { deep: { type: 'null' } } },
      },
    });
    const deep = JSON.parse('{"a":'.repeat(20) + '1' + '}'.repeat(20));
    expect(JSON.stringify(jsonShape(deep)).length).toBeLessThan(600);
  });
});
