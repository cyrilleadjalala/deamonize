/**
 * Level 1 of the replay cascade: execute the recorded HTTP request of a step directly, with no browser
 * (requirements 12.1, 13.3, 13.4, 13.6). Copied verbatim into the output directory and the Docker
 * context, like step-plan.ts. Dependency free: the global `fetch`, `node:fs` and `node:crypto` only,
 * and nothing from src/.
 *
 * What a run does with a recipe:
 *  1. `buildRequest` fills the placeholders with the Payload (`{{name}}` in the path, query and headers,
 *     `{"$var":name}` leaves of the body, typed by `as`) and resolves `{"$secret":NAME}` from the
 *     environment variable `DAEMONIZE_SECRET_<NAME>`;
 *  2. the Cookie header comes from `DAEMONIZE_COOKIE_HEADER` (never a file) or from the Playwright
 *     storageState file, read into memory only;
 *  3. `execute` sends it (timeout, bounded manual redirects) and `extractResponse` checks the
 *     status and the shape of the JSON response against what was recorded.
 *
 * No header, cookie or secret value is ever logged or put in an error: every message goes through `scrub`.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretRefLike {
  $secret: string;
}

export interface HttpRecipeLike {
  method: string;
  url: string;
  query: Record<string, string | SecretRefLike>;
  body?: unknown;
  bodyFormat?: 'json' | 'form' | 'text';
  headers?: Record<string, string | SecretRefLike>;
  bindings?: Array<{ variable: string; in: string; name: string }>;
  auth?: string;
  expectStatus?: number;
  responseShape?: Record<string, unknown>;
}

export type Scalar = string | number | boolean;
export type Env = Record<string, string | undefined>;

export type HttpErrorKind = 'missing_secret' | 'invalid' | 'network' | 'timeout' | 'status' | 'shape' | 'storage_state';

/** An error whose message holds no secret, header or cookie value. */
export class HttpReplayError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    readonly status?: number,
    /** Name of the environment variable, for `missing_secret`. */
    readonly variable?: string
  ) {
    super(message);
    this.name = 'HttpReplayError';
  }
}

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Values that came from the environment: removed from every diagnostic and result. */
  secrets: string[];
}

export const MAX_RESPONSE_CHARS = 5_000_000;
export const MAX_DATA_CHARS = 20000;
const MAX_REDIRECTS = 5;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export const secretVariable = (name: string): string => `DAEMONIZE_SECRET_${name}`;
export const COOKIE_HEADER_VARIABLE = 'DAEMONIZE_COOKIE_HEADER';

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/** Replace every occurrence of a secret value by `***`, longest first. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

function scrubDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return scrub(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v, secrets)])) as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Secrets of a recipe
// ---------------------------------------------------------------------------

function isSecretRef(value: unknown): value is SecretRefLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as SecretRefLike).$secret === 'string';
}

function collectSecretNames(value: unknown, into: Set<string>): void {
  if (isSecretRef(value)) {
    into.add(value.$secret);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretNames(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectSecretNames(item, into);
  }
}

/** Names N of the `{"$secret":N}` references a recipe uses (query, headers and body), sorted. */
export function httpSecretNames(recipe: HttpRecipeLike | undefined): string[] {
  const names = new Set<string>();
  if (recipe !== undefined) {
    collectSecretNames(recipe.query, names);
    collectSecretNames(recipe.headers, names);
    collectSecretNames(recipe.body, names);
  }
  return [...names].sort();
}

/** Names of the environment variables the recipes of the steps need and the environment lacks (never values). */
export function missingHttpSecrets(steps: ReadonlyArray<{ http?: HttpRecipeLike }>, env: Env): string[] {
  const missing: string[] = [];
  for (const step of steps) {
    for (const name of httpSecretNames(step.http)) {
      const variable = secretVariable(name);
      const value = env[variable];
      if ((value === undefined || value === '') && !missing.includes(variable)) missing.push(variable);
    }
  }
  return missing;
}

/** The values of the secrets the recipes use, to be removed from every diagnostic. */
export function httpSecretValues(steps: ReadonlyArray<{ http?: HttpRecipeLike }>, env: Env): string[] {
  const values: string[] = [];
  for (const step of steps) {
    for (const name of httpSecretNames(step.http)) {
      const value = env[secretVariable(name)];
      if (value !== undefined && value !== '' && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function coerceVariable(name: string, value: unknown, as: string | undefined): Scalar {
  if (value === undefined || value === null) {
    throw new HttpReplayError('invalid', `no value for the variable "${name}"`);
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new HttpReplayError('invalid', `the variable "${name}" must be a string, a number or a boolean`);
  }
  if (as === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw new HttpReplayError('invalid', `the variable "${name}" is not a number`);
    return n;
  }
  if (as === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    throw new HttpReplayError('invalid', `the variable "${name}" is not a boolean`);
  }
  return String(value);
}

function secretValue(name: string, env: Env, secrets: string[]): string {
  const variable = secretVariable(name);
  const value = env[variable];
  if (value === undefined || value === '') {
    throw new HttpReplayError('missing_secret', `missing secret: the environment variable ${variable} is not set`, undefined, variable);
  }
  if (!secrets.includes(value)) secrets.push(value);
  return value;
}

/** Replace the `{{name}}` placeholders of a text; `encode` is applied to each value (path segments). */
function fillText(text: string, variables: Record<string, unknown>, encode: (value: string) => string = (v) => v): string {
  return text.replace(PLACEHOLDER, (_, name: string) => encode(String(coerceVariable(name, variables[name], undefined))));
}

function fillBody(value: unknown, variables: Record<string, unknown>, env: Env, secrets: string[]): unknown {
  if (isSecretRef(value)) return secretValue(value.$secret, env, secrets);
  if (Array.isArray(value)) return value.map((item) => fillBody(item, variables, env, secrets));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (typeof record.$var === 'string' && keys.every((k) => k === '$var' || k === 'as')) {
      return coerceVariable(record.$var, variables[record.$var], record.as as string | undefined);
    }
    return Object.fromEntries(keys.map((k) => [k, fillBody(record[k], variables, env, secrets)]));
  }
  return value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/**
 * The request a recipe gives for the Payload `variables`. Path values are URL-encoded, query and form
 * values by URLSearchParams, JSON by JSON.stringify. A missing variable or secret is an error that names it.
 */
export function buildRequest(recipe: HttpRecipeLike, variables: Record<string, unknown>, env: Env): BuiltRequest {
  const method = recipe.method.toUpperCase();
  if (!METHODS.includes(method)) throw new HttpReplayError('invalid', `${method} requests are not replayed directly`);
  const secrets: string[] = [];

  const parts = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(recipe.url);
  if (parts === null || !/^https?:/i.test(parts[1])) throw new HttpReplayError('invalid', 'the recipe URL is not an absolute http(s) URL');
  const path = parts[2]
    .split('/')
    .map((segment) => fillText(segment, variables, encodeURIComponent))
    .join('/');

  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(recipe.query ?? {})) {
    search.append(key, isSecretRef(raw) ? secretValue(raw.$secret, env, secrets) : fillText(raw, variables));
  }
  const query = search.toString();
  const url = parts[1] + path + (query === '' ? '' : `?${query}`);

  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(recipe.headers ?? {})) {
    const value = isSecretRef(raw) ? secretValue(raw.$secret, env, secrets) : fillText(raw, variables);
    // A value holding a line break would inject another header
    if (/[\r\n]/.test(value)) throw new HttpReplayError('invalid', `the header "${name}" holds a line break`);
    headers[name] = value;
  }
  if (!hasHeader(headers, 'accept')) headers['accept'] = 'application/json, text/plain, */*';

  const built: BuiltRequest = { method, url, headers, secrets };
  if (recipe.body !== undefined && method !== 'GET') {
    const filled = fillBody(recipe.body, variables, env, secrets);
    if (recipe.bodyFormat === 'form' && typeof filled === 'object' && filled !== null) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(filled as Record<string, unknown>)) {
        for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item));
      }
      built.body = form.toString();
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (recipe.bodyFormat === 'text' || typeof filled === 'string') {
      built.body = String(filled);
    } else {
      built.body = JSON.stringify(filled);
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    }
  }
  return built;
}

/** The recorded values of the variables, used for a variable the call does not supply (like Level 2). */
export function withRecordedDefaults(
  steps: ReadonlyArray<{ variable?: string; value?: string }>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of steps) {
    if (step.variable !== undefined && step.value !== undefined && !(step.variable in out)) out[step.variable] = step.value;
  }
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) out[name] = value;
  }
  return out;
}

/** Move a recipe URL from the origin it was recorded on to the origin of another start URL (a sandbox). */
export function rebaseOrigin(url: string, recordedStartUrl: string, actualStartUrl: string | undefined): string {
  if (actualStartUrl === undefined) return url;
  try {
    const from = new URL(recordedStartUrl).origin;
    const to = new URL(actualStartUrl).origin;
    return url.startsWith(from + '/') || url === from ? to + url.slice(from.length) : url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Seconds since the epoch; -1 (or absent) for a session cookie. */
  expires?: number;
  secure?: boolean;
}

export interface StorageStateLike {
  cookies?: StoredCookie[];
}

function domainMatches(host: string, domain: string): boolean {
  const wanted = domain.toLowerCase();
  if (wanted.startsWith('.')) {
    const base = wanted.slice(1);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === wanted;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  const base = cookiePath === '' ? '/' : cookiePath;
  if (requestPath === base) return true;
  return requestPath.startsWith(base) && (base.endsWith('/') || requestPath[base.length] === '/');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The cookies of a storage state that a request to `url` carries (domain, path, secure and expiry rules). */
export function cookiesFor(url: string, cookies: readonly StoredCookie[], nowMs: number = Date.now()): StoredCookie[] {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  const secureContext = target.protocol === 'https:' || LOCAL_HOSTS.has(host);
  return cookies
    .filter((cookie) => {
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') return false;
      if (!domainMatches(host, cookie.domain)) return false;
      if (!pathMatches(target.pathname, cookie.path ?? '/')) return false;
      if (cookie.secure === true && !secureContext) return false;
      const expires = cookie.expires;
      if (expires !== undefined && expires >= 0 && expires * 1000 <= nowMs) return false;
      return true;
    })
    // The most specific path first, as a browser sends them
    .sort((a, b) => (b.path ?? '/').length - (a.path ?? '/').length);
}

/** `name=value; name2=value2` for a request to `url`, or undefined when no cookie applies. */
export function cookieHeaderFromState(url: string, state: StorageStateLike, nowMs: number = Date.now()): string | undefined {
  const matching = cookiesFor(url, state.cookies ?? [], nowMs);
  return matching.length === 0 ? undefined : matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Read a Playwright storageState file into memory and build the Cookie header for `url`; the content is never logged. */
export function cookieHeaderFor(url: string, storageStatePath: string, nowMs: number = Date.now()): string | undefined {
  let state: StorageStateLike;
  try {
    state = JSON.parse(readFileSync(storageStatePath, 'utf8')) as StorageStateLike;
  } catch (err) {
    // The error of JSON.parse can quote the file: say only that it cannot be read
    throw new HttpReplayError('storage_state', `the storage state file cannot be read as JSON (${(err as NodeJS.ErrnoException).code ?? 'invalid content'})`);
  }
  return cookieHeaderFromState(url, state, nowMs);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  /** True when the body is JSON (and `json` holds it). */
  hasJson: boolean;
  json?: unknown;
}

export interface ExecuteOptions {
  timeoutMs: number;
  maxRedirects?: number;
  /** Values removed from error messages (the secrets of the request and the cookie values). */
  secrets?: readonly string[];
  fetchImpl?: typeof fetch;
}

const CREDENTIAL_HEADER = /authorization|cookie|token|key|auth|secret|csrf|session/i;

/**
 * Send the request. Redirects are followed by hand, at most `maxRedirects` times, and a redirect to another
 * origin drops the credential headers. A network error, a timeout and a body over 5 million characters are errors.
 */
export async function execute(request: BuiltRequest, options: ExecuteOptions): Promise<HttpResponse> {
  const send = options.fetchImpl ?? fetch;
  const secrets = [...(options.secrets ?? []), ...request.secrets];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  const limit = options.maxRedirects ?? MAX_REDIRECTS;
  try {
    let method = request.method;
    let url = request.url;
    let body = request.body;
    let headers = { ...request.headers };
    for (let hop = 0; ; hop++) {
      const response = await send(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null && response.status !== 304) {
        if (hop >= limit) throw new HttpReplayError('network', `more than ${limit} redirects`, response.status);
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new HttpReplayError('network', 'redirect to a non-http URL', response.status);
        if (next.origin !== new URL(url).origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADER.test(name)));
        }
        // As a browser does: 303, and 301/302 after a POST, become a GET without body; 307 and 308 keep both
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'));
        }
        url = next.toString();
        await response.body?.cancel().catch(() => { });
        continue;
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new HttpReplayError('network', 'the response is larger than 5 million characters', response.status);
      const type = response.headers.get('content-type') ?? '';
      const trimmed = text.trim();
      if (trimmed !== '' && (/json/i.test(type) || /^[[{]/.test(trimmed))) {
        try {
          return { status: response.status, hasJson: true, json: JSON.parse(trimmed) };
        } catch {
          // Not JSON after all
        }
      }
      return { status: response.status, hasJson: false };
    }
  } catch (err) {
    if (err instanceof HttpReplayError) throw new HttpReplayError(err.kind, scrub(err.message, secrets), err.status);
    if (controller.signal.aborted) throw new HttpReplayError('timeout', `no response within ${options.timeoutMs} ms`);
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as NodeJS.ErrnoException).code;
    throw new HttpReplayError('network', scrub(`the request failed${cause !== undefined ? ` (${cause})` : ''}: ${(err as Error).name}`, secrets));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shapes (drift)
// ---------------------------------------------------------------------------

type Shape = { type?: string; properties?: Record<string, Shape>; items?: Shape };

const MAX_SHAPE_DEPTH = 6;
const MAX_SHAPE_KEYS = 40;
const MAX_SHAPE_ITEMS = 5;

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, Shape> = { ...a.properties };
    for (const [key, shape] of Object.entries(b.properties ?? {})) {
      properties[key] = key in properties ? mergeShapes(properties[key], shape) : shape;
    }
    return { type: 'object', properties };
  }
  if (a.type === 'array' && b.type === 'array') {
    return a.items === undefined ? b : b.items === undefined ? a : { type: 'array', items: mergeShapes(a.items, b.items) };
  }
  if (a.type === b.type) return a;
  if ((a.type === 'integer' && b.type === 'number') || (a.type === 'number' && b.type === 'integer')) return { type: 'number' };
  return {};
}

/** The names and types of a JSON value, never its values (the same rules as the recorder, so shapes can be compared). */
export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (depth >= MAX_SHAPE_DEPTH) return {};
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_SHAPE_ITEMS).map((item) => shapeOf(item, depth + 1));
    return items.length === 0 ? { type: 'array' } : { type: 'array', items: items.reduce(mergeShapes) };
  }
  if (typeof value === 'object') {
    const properties: Record<string, Shape> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SHAPE_KEYS)) {
      properties[key] = shapeOf(item, depth + 1);
    }
    return { type: 'object', properties };
  }
  return {};
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash of a shape: equal for two shapes that differ only in the order of their properties. */
export function shapeHash(shape: unknown): string {
  return createHash('sha256').update(canonical(shape)).digest('hex').slice(0, 16);
}

export interface ShapeComparison {
  /** Everything recorded is still there with the same type: the response can be used. */
  compatible: boolean;
  /** Nothing was added, removed or retyped. */
  identical: boolean;
  differences: string[];
}

/**
 * Compare the shape of a response with the recorded one. A recorded property that is missing or has another
 * type makes the response incompatible; a new property only makes it not identical (the API grew).
 * Neutral: integer against number, null against anything, and an array that is empty on either side.
 */
export function compareShapes(recorded: unknown, actual: unknown): ShapeComparison {
  const differences: string[] = [];
  let compatible = true;
  let identical = true;
  const visit = (path: string, r: Shape | undefined, a: Shape | undefined): void => {
    if (r === undefined || a === undefined || r.type === undefined || a.type === undefined) return;
    if (r.type === 'null' || a.type === 'null') return;
    const numbers = ['integer', 'number'];
    if (r.type !== a.type && !(numbers.includes(r.type) && numbers.includes(a.type))) {
      compatible = false;
      identical = false;
      differences.push(`${path || '$'}: expected ${r.type}, got ${a.type}`);
      return;
    }
    if (r.type === 'object') {
      for (const [key, shape] of Object.entries(r.properties ?? {})) {
        const other = a.properties?.[key];
        if (other === undefined) {
          compatible = false;
          identical = false;
          differences.push(`${path}/${key}: missing`);
        } else {
          visit(`${path}/${key}`, shape, other);
        }
      }
      for (const key of Object.keys(a.properties ?? {})) {
        if (r.properties?.[key] === undefined) {
          identical = false;
          differences.push(`${path}/${key}: new property`);
        }
      }
    } else if (r.type === 'array') {
      visit(`${path}[]`, r.items, a.items);
    }
  };
  if (shapeHash(recorded) === shapeHash(actual)) return { compatible: true, identical: true, differences };
  visit('', recorded as Shape, actual as Shape);
  return { compatible, identical, differences };
}

export type ExtractOutcome =
  | { ok: true; data: unknown; drifted: boolean; driftChecked: boolean }
  | { ok: false; kind: 'status' | 'shape'; reason: string };

/**
 * Check a response against the recipe and return its JSON: the status must be the recorded one (2xx when none
 * was recorded) and the shape must be compatible with the recorded one. `drifted` says the shape is not identical.
 */
export function extractResponse(recipe: HttpRecipeLike, response: HttpResponse): ExtractOutcome {
  if (recipe.expectStatus !== undefined ? response.status !== recipe.expectStatus : response.status < 200 || response.status >= 300) {
    return { ok: false, kind: 'status', reason: `unexpected status ${response.status}${recipe.expectStatus !== undefined ? ` (recorded ${recipe.expectStatus})` : ''}` };
  }
  if (recipe.responseShape === undefined) {
    return { ok: true, data: response.hasJson ? response.json : null, drifted: false, driftChecked: false };
  }
  if (!response.hasJson) return { ok: false, kind: 'shape', reason: 'the response is not JSON as recorded' };
  const comparison = compareShapes(recipe.responseShape, shapeOf(response.json));
  if (!comparison.compatible) {
    return { ok: false, kind: 'shape', reason: `the response shape changed: ${comparison.differences.slice(0, 3).join('; ')}` };
  }
  return { ok: true, data: response.json, drifted: !comparison.identical, driftChecked: true };
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

export interface RunOptions {
  timeoutMs: number;
  /** Path of a storageState file, or its content already in memory (taken from a live browser context). */
  storageState?: string | StorageStateLike;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

export type HttpStepOutcome =
  | { ok: true; status: number; data: unknown; drifted: boolean; driftChecked: boolean; secrets: string[] }
  | {
    ok: false;
    kind: HttpErrorKind;
    reason: string;
    status?: number;
    /** The request left this process: a write step must not be done again. */
    sent: boolean;
    secrets: string[];
    variable?: string;
  };

/** The Cookie header: `DAEMONIZE_COOKIE_HEADER` first, else the cookies of the storage state that match the URL. */
export function resolveCookieHeader(url: string, env: Env, storageState: string | StorageStateLike | undefined, nowMs?: number): string | undefined {
  const fromEnv = env[COOKIE_HEADER_VARIABLE];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (storageState === undefined) return undefined;
  return typeof storageState === 'string' ? cookieHeaderFor(url, storageState, nowMs) : cookieHeaderFromState(url, storageState, nowMs);
}

/** Every cookie value inside a Cookie header, to be scrubbed from diagnostics. */
function cookieValues(header: string): string[] {
  // A short value ("1", "en") would also erase unrelated text such as a status code: only the whole header and longer values
  return [header, ...header.split(';').map((pair) => pair.slice(pair.indexOf('=') + 1).trim()).filter((v) => v.length >= 8)].filter((v) => v !== '');
}

/** Build, send and check the request of a step. Never throws: the outcome says what failed and whether the request was sent. */
export async function runHttpStep(
  recipe: HttpRecipeLike,
  variables: Record<string, unknown>,
  env: Env,
  options: RunOptions
): Promise<HttpStepOutcome> {
  let built: BuiltRequest;
  const secrets: string[] = [];
  try {
    built = buildRequest(recipe, variables, env);
    secrets.push(...built.secrets);
    const cookie = resolveCookieHeader(built.url, env, options.storageState, options.nowMs);
    if (cookie !== undefined) {
      built.headers['cookie'] = cookie;
      secrets.push(...cookieValues(cookie));
    }
  } catch (err) {
    const error = err instanceof HttpReplayError ? err : new HttpReplayError('invalid', (err as Error).message);
    return { ok: false, kind: error.kind, reason: scrub(error.message, secrets), sent: false, secrets, variable: error.variable };
  }
  let response: HttpResponse;
  try {
    response = await execute(built, { timeoutMs: options.timeoutMs, secrets, fetchImpl: options.fetchImpl });
  } catch (err) {
    const error = err as HttpReplayError;
    return { ok: false, kind: error.kind ?? 'network', reason: scrub(error.message, secrets), status: error.status, sent: true, secrets };
  }
  const extracted = extractResponse(recipe, response);
  if (!extracted.ok) {
    return { ok: false, kind: extracted.kind, reason: scrub(extracted.reason, secrets), status: response.status, sent: true, secrets };
  }
  return { ok: true, status: response.status, data: scrubDeep(extracted.data, secrets), drifted: extracted.drifted, driftChecked: extracted.driftChecked, secrets };
}

// ---------------------------------------------------------------------------
// Which steps run over HTTP
// ---------------------------------------------------------------------------

export interface PlanStepLike {
  actionType: string;
  variable?: string;
  secretRef?: string;
  totp?: boolean;
  http?: HttpRecipeLike;
}

/** http: has a recipe. prep: only fills a field (or hovers) for a later request. ui: needs the page (Level 2). */
export type StepMode = 'http' | 'prep' | 'ui';

const PREPARATORY = new Set(['type', 'select', 'hover', 'scrollIntoView']);

/**
 * The plan before the mixed-workflow rule: a step with a recipe is http. A step that only fills a field is
 * preparatory when a later recipe takes its value (the Variable is bound in it) or it has no Variable: its
 * effect is carried by that request, so it is skipped. Everything else (a click or a submit without recipe,
 * a secret, a TOTP step, a pop-up switch) is Level 2.
 */
function rawPlan(steps: readonly PlanStepLike[]): StepMode[] {
  return steps.map((step, index) => {
    if (step.http !== undefined) return 'http';
    if (!PREPARATORY.has(step.actionType) || step.secretRef !== undefined || step.totp === true) return 'ui';
    const later = steps.slice(index + 1).filter((s) => s.http !== undefined);
    if (later.length === 0) return 'ui';
    if (step.variable === undefined) return 'prep';
    return later.some((s) => (s.http?.bindings ?? []).some((b) => b.variable === step.variable)) ? 'prep' : 'ui';
  });
}

/**
 * Decide, per step, how a call runs it (see rawPlan for the per-step choice).
 *
 * Mixed workflows: Node fetch() runs outside the browser, so it moves neither the page to the next screen nor
 * the cookies of the browser. Therefore no http or prep step may precede a ui step: every step up to and
 * including the last ui step runs in the browser. Only the final suffix (after the last ui step) keeps its mode.
 * Within a plan that has a ui step, a recipe with `auth === 'storageState'` depends on the browser cookies
 * (the response may rotate them, and CSRF state is paired with the page), so it is a ui step too, together
 * with everything before it. A recipe without `auth`, or with `none` or `env:NAME`, stays independent.
 * A workflow with no ui step (HTTP only) is unchanged.
 */
export function planSteps(steps: readonly PlanStepLike[]): StepMode[] {
  const plan = rawPlan(steps);
  if (!plan.includes('ui')) return plan;
  plan.forEach((mode, i) => {
    if (mode === 'http' && steps[i].http?.auth === 'storageState') plan[i] = 'ui';
  });
  const lastUi = plan.lastIndexOf('ui');
  return plan.map((mode, i) => (i <= lastUi ? 'ui' : mode));
}

/** True when the recipe changes state on the server (anything but GET and HEAD): it must never run twice. */
export function recipeMutates(recipe: { method: string }): boolean {
  const method = recipe.method.toUpperCase();
  return method !== 'GET' && method !== 'HEAD';
}
/** True when no step needs the browser. */
export function isHttpOnly(plan: readonly StepMode[]): boolean {
  return plan.length > 0 && plan.every((mode) => mode !== 'ui');
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Trim a JSON value to `max` characters once serialized: arrays are cut by halves, then the text is cut. */
export function trimJson(value: unknown, max: number = MAX_DATA_CHARS): { value: unknown; truncated: boolean } {
  const size = (v: unknown): number => JSON.stringify(v)?.length ?? 0;
  if (size(value) <= max) return { value, truncated: false };
  let current = value;
  for (let round = 0; round < 24 && size(current) > max; round++) {
    let cut = false;
    const shrink = (v: unknown): unknown => {
      if (Array.isArray(v)) {
        const kept = v.length > 1 ? v.slice(0, Math.ceil(v.length / 2)) : v;
        if (kept.length < v.length) cut = true;
        return kept.map(shrink);
      }
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, item]) => [k, shrink(item)]));
      }
      return v;
    };
    current = shrink(current);
    if (!cut) break;
  }
  if (size(current) <= max) return { value: current, truncated: true };
  return { value: JSON.stringify(current).slice(0, max), truncated: true };
}

export interface ResultZoneLike {
  extractor?: { kind: string };
}

/**
 * What `data` holds for an HTTP result: the JSON of the response. With a Result_Zone of kind `fields` the
 * scalar properties of the top-level object, as strings; any other kind (json included) gets the whole body.
 */
export function selectData(body: unknown, zone: ResultZoneLike | undefined): unknown {
  if (zone?.extractor?.kind === 'fields' && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([k, v]) => [k, String(v)])
    );
  }
  return body;
}

/** The successful result of a call that ended on an HTTP step, in the same shape as a page result. */
export function buildHttpResult(input: {
  data: unknown;
  drifted: boolean;
  driftChecked: boolean;
  resultZone?: ResultZoneLike;
  levels: string[];
  levelFallback: boolean;
  secrets: readonly string[];
  elapsedMs: number;
}): Record<string, unknown> {
  const trimmed = trimJson(scrubDeep(selectData(input.data, input.resultZone), input.secrets));
  const text = typeof trimmed.value === 'string' ? trimmed.value : JSON.stringify(trimmed.value ?? null);
  return {
    success: true,
    screenType: 'dom',
    title: '',
    text: text.length > MAX_DATA_CHARS ? text.slice(0, MAX_DATA_CHARS) : text,
    data: trimmed.value ?? null,
    ...(trimmed.truncated ? { dataTruncated: true } : {}),
    drifted: input.drifted,
    driftChecked: input.driftChecked,
    levels: input.levels,
    ...(input.levelFallback ? { levelFallback: true } : {}),
    elapsedMs: input.elapsedMs,
  };
}

/** The failure of a write or delete step over HTTP: nothing is retried on another level, so the action never runs twice. */
export function httpFailureResult(input: {
  stepIndex: number;
  step: { actionType: string; label?: string; risk?: string; http?: HttpRecipeLike };
  outcome: Extract<HttpStepOutcome, { ok: false }>;
  levels: string[];
  elapsedMs: number;
}): Record<string, unknown> {
  const { step, outcome } = input;
  const target = step.http === undefined ? '' : `${step.http.method.toUpperCase()} ${step.http.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')}`;
  return {
    success: false,
    error: 'http_failed',
    drifted: true,
    failure: {
      stepIndex: input.stepIndex,
      label: step.label ?? `${step.actionType} step ${input.stepIndex}`,
      action: step.actionType,
      risk: step.risk ?? 'read',
      level: 'http',
      tried: target === '' ? [] : [target],
      reason: `${outcome.reason}${outcome.sent ? '. The request was sent: a write step is never retried on another level' : ''}`,
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    },
    levels: input.levels,
    elapsedMs: input.elapsedMs,
  };
}
