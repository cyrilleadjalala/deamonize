/**
 * Level 1 recipes (requirement 13.2): where does the recorded value of a Variable appear in a captured
 * request, and what recipe results. Pure and deterministic: nothing is read from the network, the clock
 * or the environment.
 *
 * A value is found, by exact match of its string form, in
 *  - a path segment (`name`: index of the segment in `pathname.split('/')`),
 *  - a query parameter (`name`: the key),
 *  - a header (`name`: the header name),
 *  - a leaf of a JSON or form-encoded body, numbers and booleans stringified (`name`: JSON pointer).
 * A value found in several places binds every one of them.
 */

import { findLiteralSecrets, isSecretReference, redactRequest, type RedactedEntry } from './redactor.js';
import type { HttpRecipe, SecretValueRef } from '../types.js';

export type Scalar = string | number | boolean;

export interface VariableValue {
  name: string;
  value: Scalar;
}

export type BindingLocation = 'query' | 'body' | 'path' | 'header';

export interface Binding {
  variable: string;
  in: BindingLocation;
  name: string;
}

/** A request the way the correlation sees it. */
export interface RequestParts {
  method: string;
  /** Absolute URL, with its query string. */
  url: string;
  headers?: Record<string, string>;
  /** Parsed JSON value, or the fields of a form-encoded body. */
  body?: unknown;
  bodyFormat?: 'json' | 'form' | 'text';
}

/** A leaf of the body bound to a Variable; `as` is set when the recorded leaf was not a string. */
export interface VarMarker {
  $var: string;
  as?: 'number' | 'boolean';
}

/** A request with its Variables replaced by placeholders (before redaction and without the response). */
export interface RecipeTemplate {
  method: string;
  /** Origin and path; bound segments are `{{variable}}`; no query string. */
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  bodyFormat?: 'json' | 'form' | 'text';
}

// ---------------------------------------------------------------------------
// JSON pointers and leaves
// ---------------------------------------------------------------------------

const escapeKey = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const PLACEHOLDER = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Rebuild `value`, replacing each scalar leaf by `fn(pointer, leaf)`. Secret references stay as they are. */
function mapLeaves(value: unknown, fn: (pointer: string, leaf: Scalar) => unknown, pointer = ''): unknown {
  if (isSecretReference(value)) return value;
  if (Array.isArray(value)) return value.map((item, i) => mapLeaves(item, fn, `${pointer}/${i}`));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapLeaves(item, fn, `${pointer}/${escapeKey(key)}`);
    }
    return out;
  }
  return isScalar(value) ? fn(pointer, value) : value;
}

function forEachLeaf(value: unknown, visit: (pointer: string, leaf: Scalar) => void): void {
  mapLeaves(value, (pointer, leaf) => {
    visit(pointer, leaf);
    return leaf;
  });
}

function leafAt(root: unknown, pointer: string): unknown {
  let current = root;
  if (pointer === '') return current;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) current = current[Number(key)];
    else if (typeof current === 'object' && current !== null) current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

function isMarker(value: unknown): value is VarMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return typeof (value as VarMarker).$var === 'string' && keys.every((k) => k === '$var' || k === 'as');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Where do the values appear?
// ---------------------------------------------------------------------------

/** Every place where the recorded value of a Variable appears in the request. */
export function findBindings(variables: readonly VariableValue[], request: RequestParts): Binding[] {
  const byValue = new Map<string, string>();
  for (const variable of variables) {
    const text = String(variable.value);
    if (text !== '' && !byValue.has(text)) byValue.set(text, variable.name);
  }
  const found: Binding[] = [];
  const url = new URL(request.url);

  url.pathname.split('/').forEach((segment, index) => {
    const variable = byValue.get(safeDecode(segment));
    if (index > 0 && variable !== undefined) found.push({ variable, in: 'path', name: String(index) });
  });

  const seenKeys = new Set<string>();
  const repeated = new Set<string>();
  for (const [key] of url.searchParams) (seenKeys.has(key) ? repeated : seenKeys).add(key);
  for (const [key, value] of url.searchParams) {
    const variable = byValue.get(value);
    // A key given twice cannot be told apart in a recipe: not bound
    if (variable !== undefined && !repeated.has(key)) found.push({ variable, in: 'query', name: key });
  }

  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const variable = byValue.get(value);
    if (variable !== undefined) found.push({ variable, in: 'header', name });
  }

  if (request.body !== undefined && request.bodyFormat !== 'text') {
    forEachLeaf(request.body, (pointer, leaf) => {
      const variable = byValue.get(String(leaf));
      if (variable !== undefined) found.push({ variable, in: 'body', name: pointer });
    });
  }
  return found;
}

function placeholder(variable: string): string {
  return `{{${variable}}}`;
}

function markerFor(variable: string, leaf: Scalar): VarMarker {
  return typeof leaf === 'string' ? { $var: variable } : { $var: variable, as: typeof leaf as 'number' | 'boolean' };
}

/** The request with the bound positions replaced by placeholders (`{{name}}` in strings, `{"$var":name}` in the body). */
export function templateOf(request: RequestParts, bindings: readonly Binding[]): RecipeTemplate {
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const query: Record<string, string> = Object.fromEntries(url.searchParams);
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  const bodyBindings = new Map<string, string>();
  for (const b of bindings) {
    if (b.in === 'path') segments[Number(b.name)] = placeholder(b.variable);
    else if (b.in === 'query') query[b.name] = placeholder(b.variable);
    else if (b.in === 'header') headers[b.name] = placeholder(b.variable);
    else bodyBindings.set(b.name, b.variable);
  }
  const template: RecipeTemplate = {
    method: request.method.toUpperCase(),
    url: url.origin + segments.join('/'),
    query,
    headers,
  };
  if (request.body !== undefined) {
    template.body = mapLeaves(request.body, (pointer, leaf) => {
      const variable = bodyBindings.get(pointer);
      return variable === undefined ? leaf : markerFor(variable, leaf);
    });
    if (request.bodyFormat !== undefined) template.bodyFormat = request.bodyFormat;
  }
  return template;
}

function coerce(value: Scalar, as: VarMarker['as']): Scalar {
  if (as === 'number') return Number(value);
  if (as === 'boolean') return value === true || value === 'true';
  return String(value);
}

/** The request a template gives for these values (the inverse of `templateOf`). */
export function applyTemplate(
  template: RecipeTemplate,
  values: Readonly<Record<string, Scalar>>
): { method: string; url: string; headers: Record<string, string>; body?: unknown } {
  const resolve = (name: string): Scalar => {
    const value = values[name];
    if (value === undefined) throw new Error(`No value for the variable "${name}"`);
    return value;
  };
  const fill = (text: string): string => {
    const match = PLACEHOLDER.exec(text);
    return match === null ? text : String(resolve(match[1]));
  };

  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(template.url)?.[0] ?? '';
  const path = template.url
    .slice(origin.length)
    .split('/')
    .map((segment) => {
      const match = PLACEHOLDER.exec(segment);
      return match === null ? segment : encodeURIComponent(String(resolve(match[1])));
    })
    .join('/');
  const search = new URLSearchParams(Object.entries(template.query).map(([k, v]) => [k, fill(v)])).toString();

  const out: { method: string; url: string; headers: Record<string, string>; body?: unknown } = {
    method: template.method,
    url: origin + path + (search === '' ? '' : `?${search}`),
    headers: Object.fromEntries(Object.entries(template.headers).map(([k, v]) => [k, fill(v)])),
  };
  if (template.body !== undefined) out.body = fillBody(template.body, resolve);
  return out;
}

function fillBody(value: unknown, resolve: (name: string) => Scalar): unknown {
  if (isMarker(value)) return coerce(resolve(value.$var), value.as);
  if (Array.isArray(value)) return value.map((item) => fillBody(item, resolve));
  if (typeof value === 'object' && value !== null && !isSecretReference(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillBody(v, resolve)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Bodies and response shapes
// ---------------------------------------------------------------------------

/** Parse a request body by its content type: JSON, form-encoded fields, or plain text. */
export function parseBody(
  postData: string | undefined,
  contentType: string | undefined
): { body?: unknown; bodyFormat?: 'json' | 'form' | 'text' } {
  if (postData === undefined || postData === '') return {};
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(postData)) {
      const previous = fields[key];
      fields[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    return { body: fields, bodyFormat: 'form' };
  }
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(postData)) {
    try {
      return { body: JSON.parse(postData), bodyFormat: 'json' };
    } catch {
      // not JSON after all
    }
  }
  return { body: postData, bodyFormat: 'text' };
}

const MAX_SHAPE_DEPTH = 6;
const MAX_SHAPE_KEYS = 40;
const MAX_SHAPE_ITEMS = 5;

type Shape = Record<string, unknown>;

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, Shape> = { ...(a.properties as Record<string, Shape>) };
    for (const [key, shape] of Object.entries(b.properties as Record<string, Shape>)) {
      properties[key] = key in properties ? mergeShapes(properties[key], shape) : shape;
    }
    return { type: 'object', properties };
  }
  if (a.type === 'array' && b.type === 'array') {
    return { type: 'array', items: mergeShapes(a.items as Shape, b.items as Shape) };
  }
  if (a.type === b.type) return a;
  if ((a.type === 'integer' && b.type === 'number') || (a.type === 'number' && b.type === 'integer')) return { type: 'number' };
  return {};
}

/** The JSON Schema-like shape of a value: names and types, never values. Bounded in depth and width. */
export function jsonShape(value: unknown, depth = 0): Shape {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (depth >= MAX_SHAPE_DEPTH) return {};
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_SHAPE_ITEMS).map((item) => jsonShape(item, depth + 1));
    return items.length === 0 ? { type: 'array' } : { type: 'array', items: items.reduce(mergeShapes) };
  }
  if (typeof value === 'object') {
    const properties: Record<string, Shape> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_SHAPE_KEYS)) {
      properties[key] = jsonShape(item, depth + 1);
    }
    return { type: 'object', properties };
  }
  return {};
}

// ---------------------------------------------------------------------------
// The recipe of a captured request
// ---------------------------------------------------------------------------

/** A fetch or XHR request the recorder observed, with credentials already replaced by references. */
export interface CapturedRequest {
  method: string;
  /** Absolute URL of the request the page made (before redirects). */
  url: string;
  startedAt: number;
  /** Non-sensitive headers as sent, credential headers as Secret_References; never Cookie. */
  headers: Record<string, string | SecretValueRef>;
  redactedHeaders: RedactedEntry[];
  hasCookie: boolean;
  postData?: string;
  /** Status of the final response, after redirects. */
  status: number;
  /** json: a JSON response; empty: no content (204); other: html, text, binary. */
  responseKind: 'json' | 'empty' | 'other';
  responseShape?: Shape;
}

export type RecipeMethod = HttpRecipe['method'];
const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface RecipeAttempt {
  recipe?: HttpRecipe;
  /** Variables found in the request (kept bindings only). */
  bound: string[];
  /** Why the request is not a Level 1 candidate. */
  reason?: string;
}

/** True for a request that changes something on the server. */
export function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function plainHeaders(headers: Record<string, string | SecretValueRef>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (typeof value === 'string') out[name] = value;
  return out;
}

/**
 * Turn a captured request into a recipe for the Variables it carries. Everything that looks like a
 * credential is a Secret_Reference, bound positions are placeholders, and a recipe that still holds a
 * literal secret is refused (the step stays Level 2).
 */
export function buildHttpRecipe(variables: readonly VariableValue[], request: CapturedRequest): RecipeAttempt {
  const method = request.method.toUpperCase();
  if (!METHODS.includes(method)) return { bound: [], reason: `${method} requests are not replayed directly` };
  if (!(request.responseKind === 'json' || (request.responseKind === 'empty' && isWriteMethod(method)))) {
    return { bound: [], reason: 'the response is not JSON (server-rendered page or other content)' };
  }

  const staticHeaders = plainHeaders(request.headers);
  const contentType = Object.entries(staticHeaders).find(([n]) => n.toLowerCase() === 'content-type')?.[1];
  const { body, bodyFormat } = parseBody(request.postData, contentType);
  const parts: RequestParts = { method, url: request.url, headers: staticHeaders, body, bodyFormat };
  const found = findBindings(variables, parts);

  // Redaction runs on the template, so a bound value that sits in a credential field is redacted, not bound
  const template = templateOf(parts, found);
  const url = new URL(request.url);
  const redactedInput = redactRequest({
    method,
    url: url.origin + url.pathname + (Object.keys(template.query).length === 0 ? '' : `?${new URLSearchParams(template.query)}`),
    headers: { ...request.headers, ...template.headers } as Record<string, string>,
    body: template.body === undefined ? undefined : unmark(template.body, found),
  });

  const sentinel = (b: Binding): string => placeholder(b.variable);
  const kept = found.filter((b) => {
    if (b.in === 'path') return true;
    if (b.in === 'query') return redactedInput.query[b.name] === sentinel(b);
    if (b.in === 'header') return redactedInput.headers[b.name] === sentinel(b);
    return leafAt(redactedInput.body, b.name) === sentinel(b);
  });

  const bodyKept = new Map(kept.filter((b) => b.in === 'body').map((b) => [b.name, b.variable]));
  const recipe: HttpRecipe = {
    method: method as RecipeMethod,
    url: template.url,
    query: redactedInput.query,
    bindings: kept.map((b) => ({ variable: b.variable, in: b.in, name: b.name })),
    redacted: [...request.redactedHeaders, ...redactedInput.redacted],
  };
  if (redactedInput.body !== undefined) {
    recipe.body = mapLeaves(redactedInput.body, (pointer, leaf) => {
      const variable = bodyKept.get(pointer);
      return variable === undefined ? leaf : markerFor(variable, leaf === placeholder(variable) ? originalLeaf(parts.body, pointer) : leaf);
    });
    if (bodyFormat !== undefined) recipe.bodyFormat = bodyFormat;
  }
  if (Object.keys(redactedInput.headers).length > 0) recipe.headers = redactedInput.headers;

  const secretHeaders = Object.entries(redactedInput.headers).filter(([, v]) => isSecretReference(v));
  const authorization = secretHeaders.find(([name]) => name.toLowerCase() === 'authorization') ?? secretHeaders[0];
  recipe.auth = authorization !== undefined
    ? `env:${(authorization[1] as SecretValueRef).$secret}`
    : request.hasCookie ? 'storageState' : 'none';
  recipe.expectStatus = request.status;
  if (request.responseShape !== undefined) recipe.responseShape = request.responseShape;

  const literal = findLiteralSecrets(recipe);
  if (literal.length > 0) {
    return { bound: [], reason: `a credential would be stored in clear at ${literal.join(', ')}` };
  }
  return { recipe, bound: [...new Set(recipe.bindings.map((b) => b.variable))] };
}

/** Inside the redactor input a bound leaf is its placeholder string, so no value of a Variable reaches the redactor. */
function unmark(body: unknown, bindings: readonly Binding[]): unknown {
  const bound = new Map(bindings.filter((b) => b.in === 'body').map((b) => [b.name, b.variable]));
  return mapLeaves(markersToLeaves(body), (pointer, leaf) => {
    const variable = bound.get(pointer);
    return variable === undefined ? leaf : placeholder(variable);
  });
}

/** The template body holds markers; the redactor needs plain JSON, positions are the same. */
function markersToLeaves(body: unknown): unknown {
  if (isMarker(body)) return placeholder(body.$var);
  if (Array.isArray(body)) return body.map(markersToLeaves);
  if (typeof body === 'object' && body !== null && !isSecretReference(body)) {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, markersToLeaves(v)]));
  }
  return body;
}

function originalLeaf(body: unknown, pointer: string): Scalar {
  const leaf = leafAt(body, pointer);
  return isScalar(leaf) ? leaf : '';
}
