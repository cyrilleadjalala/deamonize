// @ts-check
/**
 * The playground of the static demo: the same contract as the Studio server's `/api/playground*` routes
 * (status, call, restart, stop, history), answered in the browser by the shared simulation in `simulate.js`.
 * No application is driven and nothing leaves the page. Dependency-free; it has no DOM or network access.
 */
import { simulate } from './simulate.js';

const REDACTED = '***';
const HISTORY_SIZE = 50;
const MAX_TIMEOUT_MS = 600000;
const SENSITIVE_KEY =
  /pass(word|wd|phrase|code)?|secret|token|(^|[^a-z])t?otp($|[^a-z])|api[-_ ]?key|credential|cvv|(^|[^a-z])pin($|[^a-z])|(^|[^a-z])ssn($|[^a-z])|private[-_ ]?key|authorization|cookie/i;
const keyForm = (/** @type {string} */ name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A small JSON Schema check for the keywords the sample tools use (type, required, enum, bounds, length, pattern).
 * Messages follow Ajv's wording so the demo reads like the real playground.
 * @param {any} schema
 * @param {unknown} value
 * @param {string} path
 * @param {Array<{ path: string, message: string }>} out
 */
function check(schema, value, path, out) {
  if (schema === null || typeof schema !== 'object') return;
  const here = path === '' ? '(arguments)' : path;
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  const isInt = typeof value === 'number' && Number.isInteger(value);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length > 0 && !types.some((t) => (t === 'integer' ? isInt : t === 'number' ? typeof value === 'number' : t === actual))) {
    out.push({ path: here, message: `must be ${types.join(',')}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push({ path: here, message: 'must be equal to one of the allowed values' });
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push({ path: here, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push({ path: here, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push({ path: here, message: `must NOT have fewer than ${schema.minLength} characters` });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push({ path: here, message: `must NOT have more than ${schema.maxLength} characters` });
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) out.push({ path: here, message: `must match pattern "${schema.pattern}"` });
      } catch {
        // A pattern this engine cannot compile: left to the server
      }
    }
  }
  if (actual === 'object' && value !== null && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!(name in record)) out.push({ path: here, message: `must have required property '${name}'` });
    }
    const props = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [name, sub] of Object.entries(props)) {
      if (name in record) check(sub, record[name], path === '' ? name : `${path}.${name}`, out);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) value.forEach((item, i) => check(schema.items, item, `${path}.${i}`.replace(/^\./, ''), out));
}

/**
 * @param {unknown} schema
 * @param {unknown} args
 * @returns {Array<{ path: string, message: string }>}
 */
export function validateArguments(schema, args) {
  /** @type {Array<{ path: string, message: string }>} */
  const issues = [];
  check(schema, args, '', issues);
  return issues;
}

/** The failure of a call that the bridge itself refuses. */
const fail = (/** @type {number} */ status, /** @type {string} */ error, /** @type {string} */ message, extra = {}) => ({ status, body: { error, message, ...extra } });

/** Fields of the simulated answer the playground shows. */
const COPIED = ['success', 'drifted', 'driftChecked', 'healed', 'mode', 'screenType', 'error', 'driftReason', 'screenshotSkipped', 'title', 'text', 'levelFallback', 'heal', 'terminalSize', 'data'];

export class StaticPlayground {
  /**
   * @param {{ tools: any[], pictures?: { failure: string, shot: string } }} options
   *   `tools`: the tool list generated at build time (name, description, inputSchema, risk, levels, secrets, sensitiveArgs, label)
   */
  constructor(options) {
    this.tools = options.tools;
    this.pictures = options.pictures ?? { failure: 'data/failure.png', shot: 'data/final.png' };
    this.mode = 'strict';
    this.preview = false;
    this.serverStarted = false;
    this.nextId = 1;
    /** @type {any[]} */
    this.log = [];
  }

  /** The status the UI reads on opening the page: listing the tools starts the (simulated) server. */
  status() {
    this.serverStarted = true;
    return {
      available: true,
      simulated: true,
      staticDemo: true,
      serverStarted: this.serverStarted,
      mode: this.mode,
      healSupport: true,
      previewSupported: true,
      preview: this.preview,
      tools: this.tools,
    };
  }

  history() {
    return { history: this.log.map((e) => ({ ...e })), serverStarted: this.serverStarted, mode: this.mode, queued: 0 };
  }

  /** @param {{ mode?: unknown, preview?: unknown }} [change] */
  restart(change = {}) {
    for (const key of Object.keys(change)) if (key !== 'mode' && key !== 'preview') return fail(400, 'bad_request', `unknown field ${key.slice(0, 40)}`);
    if (change.mode !== undefined && change.mode !== 'strict' && change.mode !== 'heal') return fail(400, 'bad_request', 'mode must be strict or heal');
    if (change.preview !== undefined && typeof change.preview !== 'boolean') return fail(400, 'bad_request', 'preview must be true or false');
    if (change.mode !== undefined) this.mode = change.mode;
    if (change.preview !== undefined) this.preview = change.preview;
    this.serverStarted = true;
    return { status: 200, body: { ok: true, serverStarted: this.serverStarted, mode: this.mode, preview: this.preview } };
  }

  stop() {
    this.serverStarted = false;
    return { status: 200, body: { ok: true, serverStarted: false } };
  }

  /** @param {{ tool: string, arguments?: Record<string, unknown>, mode?: string, timeoutMs?: number, confirm?: boolean, preview?: boolean }} request @param {AbortSignal} [signal] */
  async call(request, signal) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (typeof request?.tool !== 'string' || request.tool === '') return fail(400, 'bad_request', 'tool must be a non-empty string');
    if (request.mode !== undefined && request.mode !== 'strict' && request.mode !== 'heal') return fail(400, 'bad_request', 'mode must be strict or heal');
    const t = request.timeoutMs;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MS)) return fail(400, 'bad_request', `timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
    const tool = this.tools.find((x) => x.name === request.tool);
    if (tool === undefined) return fail(404, 'unknown_tool', `The server has no tool named ${request.tool.slice(0, 80)}.`);
    const args = { ...(request.arguments ?? {}) };
    delete args._timeoutMs;
    const declared = new Set((tool.sensitiveArgs ?? []).map(keyForm));
    const shownArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, SENSITIVE_KEY.test(k) || declared.has(keyForm(k)) ? REDACTED : v]));
    const mode = request.mode ?? this.mode;

    const issues = validateArguments(tool.inputSchema, args);
    if (issues.length > 0) {
      this.record({ tool: tool.name, arguments: shownArgs, mode, ok: false, success: false, error: 'validation', elapsedMs: 0 });
      return {
        status: 200,
        body: {
          ok: false,
          tool: tool.name,
          elapsedMs: 0,
          success: false,
          refused: 'validation',
          error: 'validation',
          message: `The call was refused before reaching the server: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
          errors: issues.map((i) => ({ instancePath: i.path, message: i.message })),
          mode: this.mode,
        },
      };
    }
    const risk = tool.risk ?? 'write';
    if (risk !== 'read' && request.confirm !== true) {
      return fail(409, 'confirmation_required', `${tool.name} can change data in the application (${risk}). Send confirm: true to run it.`, { risk, tool: tool.name });
    }
    if (request.mode !== undefined) this.mode = request.mode;
    if (request.preview !== undefined) this.preview = request.preview;
    this.serverStarted = true;

    const raw = await simulate(tool.name, args, this.mode, this.preview, { failure: () => this.pictures.failure, shot: () => this.pictures.shot });
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const body = { ...summarize(tool.name, raw), trace: sampleTrace() };
    this.record({
      tool: tool.name,
      arguments: shownArgs,
      mode: this.mode,
      ok: true,
      success: body.success,
      ...(body.drifted === undefined ? {} : { drifted: body.drifted }),
      ...(body.healed === undefined ? {} : { healed: body.healed }),
      ...(body.error === undefined ? {} : { error: body.error }),
      elapsedMs: body.elapsedMs,
    });
    return { status: 200, body };
  }

  /** @param {Record<string, unknown>} entry */
  record(entry) {
    this.log.push({ id: this.nextId++, at: new Date().toISOString(), ...entry });
    while (this.log.length > HISTORY_SIZE) this.log.shift();
  }
}

/**
 * The sample trace of the static demo (the same steps as sampleTrace() of the sample Studio): an http step, an
 * ccessibility step, a skipped step, a drifted step and a failed write step that is not repeated.
 * @returns {Array<Record<string, unknown>>}
 */
function sampleTrace() {
  return [
    { index: 0, label: 'Open the sign-in page', level: 'http', durationMs: 120, status: 'ok' },
    { index: 1, label: 'Click Sign in', level: 'accessibility', durationMs: 640, status: 'ok' },
    { index: 2, label: 'Type the optional note', level: 'skipped', durationMs: 0, status: 'skipped' },
    { index: 3, label: 'Open the invoice list', level: 'accessibility', durationMs: 910, status: 'drifted', note: 'The page looks different from the recording' },
    { index: 4, label: 'Click Create invoice', level: 'accessibility', durationMs: 1500, status: 'failed', note: 'Not repeated: this step changes data' },
    { index: 5, label: 'Read the invoice number', level: 'not_run', durationMs: 0, status: 'not_run' },
  ];
}

/**
 * The summary the UI shows: the fields it knows, the picture as a URL (the simulation puts the URL where the real
 * server puts a file path).
 * @param {string} tool @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
function summarize(tool, raw) {
  /** @type {Record<string, any>} */
  const out = { ok: true, tool, elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : 0 };
  for (const key of COPIED) if (raw[key] !== undefined) out[key] = raw[key];
  if (Array.isArray(raw.healedSteps)) out.healedSteps = raw.healedSteps;
  if (Array.isArray(raw.levels)) out.levels = raw.levels;
  let picture;
  if (raw.failure !== null && typeof raw.failure === 'object') {
    const { screenshot, ...rest } = raw.failure;
    out.failure = rest;
    picture = screenshot;
  }
  if (picture === undefined && typeof raw.screenshot === 'string') picture = raw.screenshot;
  if (typeof picture === 'string') out.screenshotUrl = picture;
  if (out.success === undefined) out.success = false;
  return out;
}
