// @ts-check
/**
 * Thin client of the Studio API, with two data sources:
 * - live: fetch `/api/*` of the Studio server (the token travels in the cookie set by the first visit);
 * - static: the demo build, with no server. The data is read from `./data/*.json` (relative URLs only, so it works
 *   under a sub-path such as /repo/) and the playground is simulated in the browser by `sim/static-session.js`.
 * The static mode is chosen by `<meta name="daemonize-mode" content="static">` or `window.DAEMONIZE_STATIC`.
 * Nothing is stored in JS, and no token or cookie is used in static mode.
 */
import { StaticPlayground } from './sim/static-session.js';

/** @returns {boolean} */
function detectStatic() {
  if (/** @type {any} */ (globalThis).DAEMONIZE_STATIC === true) return true;
  return globalThis.document?.querySelector('meta[name="daemonize-mode"]')?.getAttribute('content') === 'static';
}

export const isStatic = detectStatic();

/** Static file of each GET endpoint. */
const STATIC_FILES = {
  '/api/overview': 'data/overview.json',
  '/api/workflows': 'data/workflows.json',
  '/api/graph': 'data/graph.json',
  '/api/schemas': 'data/schemas.json',
  '/api/pbt': 'data/pbt.json',
  '/api/activity': 'data/activity.json',
  '/api/approvals': 'data/approvals.json',
};

/** @type {Promise<StaticPlayground> | undefined} */
let staticPlayground;
function playgroundSim() {
  staticPlayground ??= fetchStatic('data/playground-tools.json').then((tools) => new StaticPlayground({ tools }));
  return staticPlayground;
}

/** @param {string} file relative to the page */
async function fetchStatic(file) {
  let res;
  try {
    res = await fetch(file, { headers: { accept: 'application/json' }, cache: 'no-cache' });
  } catch {
    throw new ApiError('Cannot load the demo data.', 0);
  }
  if (!res.ok) throw new ApiError(`The demo data ${file} could not be loaded (${res.status}).`, res.status);
  try {
    return await res.json();
  } catch {
    throw new ApiError(`The demo data ${file} is not valid.`, 500);
  }
}

/** @param {string} path @param {'GET' | 'POST'} method */
async function requestStatic(path, method) {
  if (method === 'POST') throw new ApiError('This is a static demo: there is no server to run tests.', 405);
  if (path === '/api/playground') return (await playgroundSim()).status();
  if (path === '/api/playground/history') return (await playgroundSim()).history();
  const file = /** @type {Record<string, string>} */ (STATIC_FILES)[path];
  if (file === undefined) throw new ApiError('not found', 404);
  return fetchStatic(file);
}

/** @param {string} path @param {any} payload @param {AbortSignal} [signal] */
async function postStatic(path, payload, signal) {
  const sim = await playgroundSim();
  if (path === '/api/playground/call') return sim.call(payload, signal);
  if (path === '/api/playground/restart') return sim.restart(payload);
  if (path === '/api/playground/stop') return sim.stop();
  // The demo has no server to answer a question
  if (path === '/api/approvals/decide') return { status: 409, body: { error: 'This is a static demo: there is no server to answer.' } };
  return { status: 404, body: { error: 'not found' } };
}

export class ApiError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * @param {string} path
 * @param {'GET' | 'POST'} [method]
 */
async function request(path, method = 'GET') {
  if (isStatic) return requestStatic(path, method);
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  // The server wants a marker header on POST (CSRF); the browser adds the Origin itself
  if (method === 'POST') headers['x-studio-request'] = '1';
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('Cannot reach the Studio server. Is it still running?', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON
  }
  if (!res.ok) {
    const message = body && typeof body.error === 'string' ? body.error : `The server answered ${res.status}`;
    throw new ApiError(res.status === 401 ? 'Not authorized. Open the address printed by `daemonize studio` (it carries the token).' : message, res.status);
  }
  return body;
}

/**
 * A POST with a JSON body. Unlike `request`, an answer of the server is returned whatever its status (the playground
 * explains a refusal, a missing confirmation, a busy server), and only a network problem or a 401 throws.
 * @param {string} path
 * @param {unknown} payload
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(path, payload, signal) {
  if (isStatic) return postStatic(path, payload, signal);
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-studio-request': '1' },
      body: JSON.stringify(payload ?? {}),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the Studio server. Is it still running?', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON
  }
  if (res.status === 401) throw new ApiError('Not authorized. Open the address printed by `daemonize studio` (it carries the token).', 401);
  return { status: res.status, body };
}

/** @type {Map<string, Promise<any>>} */
const cache = new Map();

/** GET with a per-page cache: views share one request. */
export function get(path) {
  let entry = cache.get(path);
  if (entry === undefined) {
    entry = request(path).catch((err) => {
      cache.delete(path);
      throw err;
    });
    cache.set(path, entry);
  }
  return entry;
}

export function invalidate(path) {
  cache.delete(path);
}

/** GET that never uses the page cache (status polls and lists the user just changed). @param {string} path @returns {Promise<any>} */
export function getFresh(path) {
  invalidate(path);
  return request(path);
}

/**
 * An old server or the static demo sends no `workflowFileExists`: it is read as true.
 * @param {any} overview
 */
function normalizeOverview(overview) {
  if (overview === null || typeof overview !== 'object') return overview;
  return { ...overview, workflowFileExists: overview.workflowFileExists !== false, recordingActive: overview.recordingActive === true };
}

/** True when the new features must stay hidden: the static demo, or the Studio started with --sample. @param {any} overview */
export const isDemo = (overview) => isStatic || overview?.sample === true;

export { postJson };

export const api = {
  /** @returns {Promise<any>} */
  overview: async () => normalizeOverview(await get('/api/overview')),
  /** Same as `overview` but read again from the server. */
  overviewFresh: async () => normalizeOverview(await getFresh('/api/overview')),
  workflowsFresh: () => getFresh('/api/workflows'),
  /** @param {object} body see POST /api/workflows/update */
  workflowUpdate: (body) => postJson('/api/workflows/update', body),
  /** @param {string} id */
  workflowDelete: (id) => postJson('/api/workflows/delete', { id }),
  // ----- recording and sessions ------------------------------------------------------------------------------
  recordStart: (payload) => postJson('/api/record/start', payload),
  recordStatus: () => getFresh('/api/record/status'),
  recordStop: () => postJson('/api/record/stop', {}),
  /** `{ applicationKey, available }`. Only the Application_Key (an origin) is sent, never the full address. */
  sessionFor: (key) => getFresh(`/api/sessions?key=${encodeURIComponent(key)}`),
  sessions: () => getFresh('/api/sessions'),
  sessionForget: (applicationKey) => postJson('/api/sessions/forget', { applicationKey }),
  // ----- credentials -------------------------------------------------------------------------------------------
  secrets: () => getFresh('/api/secrets'),
  /** The value travels in the body of this one request and nowhere else. */
  secretSave: (name, value, signal) => postJson('/api/secrets', { name, value }, signal),
  secretForget: (name, signal) => postJson('/api/secrets/forget', { name }, signal),
  // ----- compile and connect -----------------------------------------------------------------------------------
  /** @param {{ http?: 'off' | 'auto', healSupport?: boolean }} [options] */
  compileStart: (options) => postJson('/api/compile', options ?? {}),
  compileStatus: () => getFresh('/api/compile/status'),
  powerInfo: () => getFresh('/api/power/info'),
  powerSnippet: () => getFresh('/api/power/snippet'),
  /** @param {string} scope 'global' or 'project' @param {string} [workspacePath] only for project */
  powerPreview: (scope, workspacePath) => postJson('/api/power/preview', scope === 'project' ? { scope, workspacePath } : { scope }),
  /** utoAdd: true is sent only when the user ticked the box. */
  powerInstall: (confirmationId, kiroPath, scope, autoAdd) => postJson('/api/power/install', autoAdd === true ? { confirmationId, kiroPath, scope, autoAdd: true } : { confirmationId, kiroPath, scope }),
  powerRemove: (scope) => postJson('/api/power/remove', { scope }),
  powerAutoAdd: () => getFresh('/api/power/auto-add'),
  powerAutoAddOff: () => postJson('/api/power/auto-add', { enabled: false }),
  // ----- approvals and activity ----------------------------------------------------------------------------------
  /** `{ pending, serverTime }`, never cached. */
  approvals: () => getFresh('/api/approvals'),
  /** @param {string} id 32 hex @param {'approved' | 'denied'} decision `{ status, body }`: 200 `{ id, decision }`, 400, 404 or 409. */
  approvalDecide: (id, decision) => postJson('/api/approvals/decide', { id, decision }),
  /**
   * `{ entries, tools, total }`, newest first, never cached. The static demo filters the sample file in the page.
   * @param {{ limit?: number, tool?: string, decision?: string }} [query]
   */
  activity: async (query = {}) => {
    const q = new URLSearchParams();
    if (typeof query.limit === 'number') q.set('limit', String(query.limit));
    if (typeof query.tool === 'string' && query.tool !== '') q.set('tool', query.tool);
    if (typeof query.decision === 'string' && query.decision !== '') q.set('decision', query.decision);
    if (!isStatic) return getFresh(q.toString() !== '' ? `/api/activity?${q}` : '/api/activity');
    const all = await getFresh('/api/activity');
    const entries = (Array.isArray(all?.entries) ? all.entries : []).filter((e) => (!query.tool || e.tool === query.tool) && (!query.decision || e.decision === query.decision));
    return { entries: entries.slice(0, query.limit ?? 50), tools: Array.isArray(all?.tools) ? all.tools : [], total: entries.length };
  },
  workflows: () => get('/api/workflows'),
  graph: () => get('/api/graph'),
  schemas: () => get('/api/schemas'),
  pbt: () => get('/api/pbt'),
  /** The playground is optional: resolves null when the server does not have it. */
  playground: async () => {
    try {
      return await get('/api/playground');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  },
  /** Status and tools of the playground, never cached: the server may have started or stopped since. */
  playgroundFresh: async () => {
    invalidate('/api/playground');
    return api.playground();
  },
  /** A call of a tool: `{ status, body }`, the body being a result summary or `{ error, message }`. */
  playgroundCall: (payload, signal) => postJson('/api/playground/call', payload, signal),
  playgroundRestart: (payload) => postJson('/api/playground/restart', payload),
  playgroundStop: () => postJson('/api/playground/stop', {}),
  /** `{ history, serverStarted, mode }`: the last calls of this session, secrets already shown as ***. */
  playgroundHistory: async () => {
    const res = await request('/api/playground/history');
    return { ...res, history: Array.isArray(res?.history) ? res.history : [] };
  },
  /** Runs the generated property tests; the answer is the new PBT view. */
  async runPbt() {
    const view = await request('/api/pbt/run', 'POST');
    cache.set('/api/pbt', Promise.resolve(view));
    return view;
  },
};
