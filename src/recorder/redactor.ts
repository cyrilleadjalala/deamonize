/**
 * Redaction of recorded HTTP requests (requirement 16.1, 13.7). Pure and deterministic: the same
 * request always gives the same output, nothing is read from the clock, the environment or a random source.
 *
 * What is replaced by a Secret_Reference `{"$secret":"NAME"}`:
 *  - the value of Authorization, Cookie, Set-Cookie, Proxy-Authorization and X-API-Key / X-Auth / X-CSRF style headers,
 *    and of any header whose name looks like a credential;
 *  - the value of a query parameter or a body field (nested JSON, form-encoded) whose name looks like a credential
 *    (password, secret, token, api key, otp, code, session, csrf, authorization...);
 *  - any other string that looks like a credential: a JWT, a `Bearer` / `Basic` value, or a long base64 / hex run.
 * NAME is the upper-snake form of the key, made unique inside the request (`TOKEN`, `TOKEN_2`...).
 * The names and positions of what was replaced are returned in `redacted`; the values never are.
 */

import type { SecretValueRef } from '../types.js';

export interface RecordedRequest {
  method: string;
  /** Absolute or relative URL, possibly with a query string and credentials. */
  url: string;
  headers?: Record<string, string>;
  /** An already parsed JSON value, or the raw text of a JSON, form-encoded or other body. */
  body?: unknown;
}

export type RedactedLocation = 'header' | 'query' | 'body';

export interface RedactedEntry {
  in: RedactedLocation;
  /** Header or query name, or the path of the field in the body (`user.password`, `items[0].token`). */
  name: string;
  secret: string;
}

export interface RedactedRequest {
  method: string;
  /** The URL without credentials, query string or fragment. */
  url: string;
  query: Record<string, string | SecretValueRef>;
  headers: Record<string, string | SecretValueRef>;
  body?: unknown;
  /** 'form' when the body was `application/x-www-form-urlencoded` text: `body` is then an object of its fields. */
  bodyFormat?: 'json' | 'form' | 'text';
  redacted: RedactedEntry[];
}

// ---------------------------------------------------------------------------
// What looks like a credential
// ---------------------------------------------------------------------------

/** Names that contain one of these (ignoring case and separators) are credentials. */
const SENSITIVE_PARTS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'session', 'csrf', 'xsrf', 'authorization', 'credential', 'privatekey'];
/** Short names that only count as a whole word (`code`, not `zipcode` or `encoding`). */
const SENSITIVE_WORDS = new Set(['otp', 'totp', 'code', 'pwd', 'auth', 'sid', 'jwt', 'pin']);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** True when a query parameter, body field or header name designates a credential. */
export function isSensitiveName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (SENSITIVE_PARTS.some((part) => compact.includes(part))) return true;
  return wordsOf(name).some((word) => SENSITIVE_WORDS.has(word));
}

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADERS.has(lower) || /^x-(api|auth|csrf|xsrf)/.test(lower) || isSensitiveName(name);
}

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const SCHEME = /^(bearer|basic|token|digest)\s+\S{6,}/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_RUN = /^[A-Za-z0-9+/_=-]{24,}$/;

/** A JWT, a `Bearer ...` / `Basic ...` value, or (with `longRuns`) a run of 24 or more base64 / hex characters. */
export function looksLikeSecretValue(value: string, longRuns = true): boolean {
  const text = value.trim();
  if (JWT.test(text) || SCHEME.test(text)) return true;
  if (!longRuns || !LONG_RUN.test(text) || UUID.test(text)) return false;
  // A word of 24 letters or a number is not a token: it mixes letters and digits
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

export function isSecretReference(value: unknown): value is SecretValueRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['$secret'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The upper-snake name of a key: `accessToken` and `access-token` give `ACCESS_TOKEN`. Always matches `^[A-Z][A-Z0-9_]*$`. */
export function secretNameFromKey(key: string): string {
  const name = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (name === '') return 'SECRET';
  return /^[A-Z]/.test(name) ? name : `SECRET_${name}`;
}

class Redaction {
  readonly entries: RedactedEntry[] = [];
  private readonly used = new Set<string>();

  constructor(private readonly longRuns: boolean = true) { }

  /** The reference for a value found at `where`; a name already taken by another position gets a numeric suffix. */
  ref(where: RedactedLocation, position: string, key: string): SecretValueRef {
    const base = secretNameFromKey(key);
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}_${n}`;
    this.used.add(name);
    this.entries.push({ in: where, name: position, secret: name });
    return { $secret: name };
  }

  suspicious(value: string): boolean {
    return looksLikeSecretValue(value, this.longRuns);
  }
}

// ---------------------------------------------------------------------------
// Headers, query, body
// ---------------------------------------------------------------------------

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function redactHeadersWith(headers: Record<string, string>, state: Redaction): Record<string, string | SecretValueRef> {
  const out: Record<string, string | SecretValueRef> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isSecretReference(value)) {
      out[name] = value;
    } else if (hasContent(value) && (isSensitiveHeader(name) || state.suspicious(String(value)))) {
      out[name] = state.ref('header', name, name);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Replace the value of every credential header; the other headers are kept as they are. */
export function redactHeaders(headers: Record<string, string>): { headers: Record<string, string | SecretValueRef>; redacted: RedactedEntry[] } {
  const state = new Redaction();
  const out = redactHeadersWith(headers, state);
  return { headers: out, redacted: state.entries };
}

function redactValue(value: unknown, path: string, key: string, where: RedactedLocation, state: Redaction, forced = false): unknown {
  if (isSecretReference(value)) return value;
  // Everything inside a credential object (a session, an auth block) is a credential
  const sensitive = forced || isSensitiveName(key);
  if (Array.isArray(value)) {
    return value.map((item, i) => redactValue(item, `${path}[${i}]`, key, where, state, sensitive));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [child, item] of Object.entries(value)) {
      out[child] = redactValue(item, path === '' ? child : `${path}.${child}`, child, where, state, sensitive);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (hasContent(value) && (sensitive || (typeof value === 'string' && state.suspicious(value)))) {
      return state.ref(where, path, key);
    }
  }
  return value;
}

function parseForm(text: string): Record<string, string | string[]> | undefined {
  if (text === '' || !/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const previous = out[key];
    out[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

function bodyWith(
  body: unknown,
  state: Redaction,
  contentType: string | undefined
): { body: unknown; format: 'json' | 'form' | 'text' } {
  if (typeof body !== 'string') return { body: redactValue(body, '', '', 'body', state), format: 'json' };

  const text = body.trim();
  const isForm = /x-www-form-urlencoded/i.test(contentType ?? '');
  if (!isForm && /^[[{]/.test(text)) {
    try {
      return { body: redactValue(JSON.parse(text), '', '', 'body', state), format: 'json' };
    } catch {
      // Not JSON after all
    }
  }
  const form = isForm || contentType === undefined ? parseForm(text) : undefined;
  if (form !== undefined) return { body: redactValue(form, '', '', 'body', state), format: 'form' };
  if (state.suspicious(text)) return { body: state.ref('body', '', 'body'), format: 'text' };
  return { body, format: 'text' };
}

/** Redact a request or response body: nested JSON, form-encoded text, or a bare token. */
export function redactBody(
  body: unknown,
  contentType?: string
): { body: unknown; format: 'json' | 'form' | 'text'; redacted: RedactedEntry[] } {
  const state = new Redaction();
  const result = bodyWith(body, state, contentType);
  return { body: result.body, format: result.format, redacted: state.entries };
}

// ---------------------------------------------------------------------------
// A whole request
// ---------------------------------------------------------------------------

function headerValue(headers: Record<string, string> | undefined, wanted: string): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export interface RedactOptions {
  /** Also treat a run of 24 or more base64 / hex characters as a credential (default true). */
  longRuns?: boolean;
}

export function redactRequest(request: RecordedRequest, options: RedactOptions = {}): RedactedRequest {
  const state = new Redaction(options.longRuns ?? true);

  let base = request.url;
  let search = '';
  let credentials = false;
  try {
    const parsed = new URL(request.url, 'http://placeholder.invalid');
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(request.url);
    credentials = parsed.username !== '' || parsed.password !== '';
    search = parsed.search;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    base = relative ? parsed.pathname : parsed.toString();
  } catch {
    const cut = request.url.search(/[?#]/);
    if (cut >= 0) {
      search = request.url.startsWith('?', cut) ? request.url.slice(cut).split('#')[0] : '';
      base = request.url.slice(0, cut);
    }
  }

  const headers = redactHeadersWith(request.headers ?? {}, state);
  // Credentials in the URL (`https://user:password@host`) end up as an authorization header reference
  if (credentials && headers['Authorization'] === undefined && headers['authorization'] === undefined) {
    headers['Authorization'] = state.ref('header', 'Authorization', 'Authorization');
  }

  const query: Record<string, string | SecretValueRef> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    query[key] = hasContent(value) && (isSensitiveName(key) || state.suspicious(value)) ? state.ref('query', key, key) : value;
  }

  const result: RedactedRequest = {
    method: request.method.toUpperCase(),
    url: base,
    query,
    headers,
    redacted: state.entries,
  };
  if (request.body !== undefined && request.body !== null && request.body !== '') {
    const { body, format } = bodyWith(request.body, state, headerValue(request.headers, 'content-type'));
    result.body = body;
    result.bodyFormat = format;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Literal secrets in an already written recipe (used by the workflow file validation)
// ---------------------------------------------------------------------------

/**
 * Paths, relative to the recipe, of the literals that must be Secret_References: a credential header, a
 * credential query or body field, or a value that is a JWT or a `Bearer` value. Long opaque runs are not
 * reported here (an entity id is a legitimate literal); the redactor still replaces them while recording.
 */
export function findLiteralSecrets(recipe: {
  url?: unknown;
  query?: unknown;
  headers?: unknown;
  body?: unknown;
}): string[] {
  const probe = redactRequest(
    {
      method: 'GET',
      url: typeof recipe.url === 'string' ? recipe.url : '/',
      headers: (recipe.headers ?? {}) as Record<string, string>,
      body: recipe.body,
    },
    { longRuns: false }
  );
  const state = new Redaction(false);
  for (const [name, value] of Object.entries((recipe.query ?? {}) as Record<string, unknown>)) {
    if (!isSecretReference(value) && hasContent(value) && (isSensitiveName(name) || state.suspicious(String(value)))) {
      state.ref('query', name, name);
    }
  }
  const paths = { header: '.headers', query: '.query', body: '.body' };
  const order = { query: 0, header: 1, body: 2 };
  const entries = [...probe.redacted, ...state.entries].sort((a, b) => order[a.in] - order[b.in]);
  return entries.map((entry) =>
    entry.in === 'body' && entry.name === '' ? '.body' : `${paths[entry.in]}.${entry.name}`
  );
}