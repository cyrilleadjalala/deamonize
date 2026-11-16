/**
 * The Studio server: a static single-page UI and a small JSON API over `node:http`, for one person on one machine.
 *
 * Safety model:
 * - binds to loopback; another host needs `allowRemote`, and then the token is the only protection;
 * - every /api call needs the per-process token (header `x-studio-token`, or the cookie set by the first visit of
 *   `/?token=...`; a POST with the cookie also needs the `x-studio-request` header and a matching Origin);
 * - the Host header must be one of ours (DNS rebinding), a foreign Origin is refused, and no CORS header is ever sent;
 * - data endpoints answer GET only; the POSTs are `/api/pbt/run` (no body) and the playground ones (a small JSON
 *   body, `application/json` only); bodies and URLs are size-limited;
 * - static files are resolved inside the static folder, symlinks included;
 * - every JSON answer passes through `redactForStudio`; pictures are served only from the whitelisted assets route.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { deserializeWorkflowSet } from '../workflow/workflow-set.js';
import {
  ASSET_NAME,
  buildGraph,
  buildOverview,
  buildPbtView,
  buildSchemas,
  buildWorkflows,
  isSecretStep,
  type StudioOutputs,
  type StudioTarget,
} from './model.js';
import { redactForStudio, storageStateValues } from './redact.js';
import { readPbtResult, runPbtSuite, DEFAULT_PBT_TIMEOUT_MS } from './pbt-run.js';
import { SAMPLE_PNG, sampleStudioData } from './sample-data.js';
import type { PbtRunResult } from './pbt-result.js';
import { MAX_TIMEOUT_MS, PlaygroundSession, SHOT_ID, type CallRequest, type ToolMeta } from './playground.js';
import { sampleConnect, sampleLaunch } from './sample-playground.js';

export interface StudioOptions {
  /** The workflow file to show (default `daemonize.workflows.json`). */
  workflowFile?: string;
  /** The output directory of `daemonize compile` (default `daemonize-out`). */
  outDir?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. Anything but loopback needs `allowRemote`. */
  host?: string;
  allowRemote?: boolean;
  /** The folder of the single-page UI (default: `ui` next to this module). */
  staticDir?: string;
  /** Serve the built-in fictitious data; no file is read. */
  sampleData?: boolean;
  /** A State_Graph file to show (default: `<out>/state-graph.json`, then next to the workflow file). */
  graphFile?: string;
  /** Environment whose secret values are removed from responses (default process.env). */
  env?: Record<string, string | undefined>;
  /** Timeout of a property-test run (default 120 s). */
  pbtTimeoutMs?: number;
  /** Fixed token, for tests; default a random one. */
  token?: string;
  /** Serve the MCP playground (default true). Without it `/api/playground` answers 404. */
  playground?: boolean;
  /** Idle time after which the playground stops its server (default 5 min). */
  playgroundIdleMs?: number;
  /** Timeout of a playground call that gives none (default 60 s). */
  playgroundCallTimeoutMs?: number;
}

export interface StudioHandle {
  /** `http://host:port/?token=...`: open this one. */
  url: string;
  /** The address without the token. */
  origin: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_WORKFLOWS_FILE = 'daemonize.workflows.json';
const DEFAULT_OUTPUT_DIR = 'daemonize-out';
const COOKIE_NAME = 'daemonize_studio';
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_PLAYGROUND_BODY_BYTES = 64 * 1024;
const MAX_JSON_FILE = 20 * 1024 * 1024;
const MAX_STATIC_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CSP = "default-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const PLACEHOLDER_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Daemonize Studio</title><body><h1>Daemonize Studio</h1><p>The API is running; the UI files were not found. Read <code>/api/overview</code>.</p></body>';

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

interface Loaded {
  targets: StudioTarget[];
  stateGraph?: unknown;
  /** Values to scrub from every response, besides those of the environment. */
  secretValues: string[];
  /** Thumbnail names a step (not a secret one) refers to. */
  assetNames: Set<string>;
  assetsDir?: string;
  pbt?: PbtRunResult;
}

class LoadError extends Error { }

/** The body of a request, read by the one route that needs it. */
interface BodyReader {
  read(): Promise<Buffer>;
  tooLarge(): boolean;
}

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (info.size > MAX_JSON_FILE) throw new Error('file too large');
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readOutputs(outDir: string): Promise<StudioOutputs> {
  const tryJson = async (name: string): Promise<unknown> => {
    try {
      return await readJson(join(outDir, name));
    } catch {
      return undefined;
    }
  };
  const nameMap = await tryJson('name-map.json');
  let testTools: string[] = [];
  try {
    testTools = (await readdir(join(outDir, 'tests'))).flatMap((f) => /^(.+)\.property\.test\.ts$/.exec(f)?.[1] ?? []).sort();
  } catch {
    // No tests folder
  }
  return {
    ...(nameMap !== null && typeof nameMap === 'object' ? { nameMap: nameMap as Record<string, string> } : {}),
    openapi: await tryJson('openapi.json'),
    flags: {
      compiled: await exists(join(outDir, 'mcp-server.js')),
      healSupport: await exists(join(outDir, 'heal', 'heal-step.js')),
      http: await exists(join(outDir, 'http-replay.js')),
      pbtGenerated: testTools.length > 0,
    },
    testTools,
  };
}

async function loadLive(options: Required<Pick<StudioOptions, 'workflowFile' | 'outDir'>> & { graphFile?: string }): Promise<Loaded> {
  const file = resolve(options.workflowFile);
  let set;
  try {
    set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new LoadError(`workflow file not found: ${basename(file)}`);
    throw new LoadError(`workflow file is not valid: ${(err as Error).message}`);
  }
  const outputs = await readOutputs(resolve(options.outDir));
  const secretValues: string[] = [];
  // The storage state is read only to know which values to hide; none of it is ever returned
  if (set.storageState !== undefined) {
    try {
      secretValues.push(...storageStateValues(await readJson(resolve(dirname(file), set.storageState))));
    } catch {
      // Missing or unreadable: nothing to hide
    }
  }
  let stateGraph: unknown;
  const graphCandidates = options.graphFile !== undefined ? [resolve(options.graphFile)] : [join(resolve(options.outDir), 'state-graph.json'), join(dirname(file), 'daemonize.state-graph.json')];
  for (const candidate of graphCandidates) {
    try {
      stateGraph = await readJson(candidate);
      break;
    } catch {
      // Try the next one
    }
  }
  const assetNames = new Set<string>();
  for (const workflow of set.workflows ?? []) {
    for (const step of workflow.steps ?? []) {
      const name = step.visual?.thumbnailPath?.split(/[\\/]/).pop();
      if (name !== undefined && ASSET_NAME.test(name) && !isSecretStep(step)) assetNames.add(name);
    }
  }
  return {
    targets: [{ set, outputs }],
    stateGraph,
    secretValues,
    assetNames,
    assetsDir: join(dirname(file), `${basename(file)}.assets`),
    pbt: await readPbtResult(resolve(options.outDir)),
  };
}

function loadSample(): Loaded {
  const data = sampleStudioData();
  const assetNames = new Set<string>();
  for (const { set } of data.targets) {
    for (const w of set.workflows) for (const s of w.steps) {
      const name = s.visual?.thumbnailPath?.split(/[\\/]/).pop();
      if (name !== undefined && ASSET_NAME.test(name) && !isSecretStep(s)) assetNames.add(name);
    }
  }
  return { targets: data.targets, stateGraph: data.stateGraph, secretValues: [], assetNames, pbt: data.pbt };
}

/** A path inside `root` for a URL path, or undefined when it leaves it (`..`, encoded or not, absolute paths, NUL, backslashes). */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const base = resolve(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep) ? target : undefined;
}

export async function startStudio(options: StudioOptions = {}): Promise<StudioHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && options.allowRemote !== true) {
    throw new Error(`Refusing to listen on ${host}: the Studio has no authentication besides its token. Use 127.0.0.1, or add --allow-remote if you accept that.`);
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port ${String(options.port)}`);
  const token = options.token ?? randomBytes(24).toString('base64url');
  const env = options.env ?? process.env;
  const sample = options.sampleData === true;
  const workflowFile = options.workflowFile ?? DEFAULT_WORKFLOWS_FILE;
  const outDir = options.outDir ?? DEFAULT_OUTPUT_DIR;
  const staticDir = resolve(options.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), 'ui'));
  const pbtTimeoutMs = options.pbtTimeoutMs ?? DEFAULT_PBT_TIMEOUT_MS;

  let allowedHosts = new Set<string>();
  let pbtRun: Promise<PbtRunResult> | undefined;

  // The secret values found by the last load (a storage state): the playground scrubs them from its answers too
  let knownSecretValues: string[] = [];
  const load = async (): Promise<Loaded> => {
    const data = sample ? loadSample() : await loadLive({ workflowFile, outDir, graphFile: options.graphFile });
    knownSecretValues = data.secretValues;
    return data;
  };

  /** What the playground needs to know about a tool: its risk and which arguments hold a typed secret. */
  const toolMeta = async (tool: string): Promise<ToolMeta | undefined> => {
    const data = await load().catch(() => undefined);
    const view = data === undefined ? undefined : buildWorkflows(data.targets).workflows.find((w) => w.toolName === tool);
    if (view === undefined) return undefined;
    return {
      risk: view.risk.highest,
      sensitiveArgs: [...view.steps.flatMap((s) => (s.usesSecret && s.variable !== undefined ? [s.variable] : [])), ...view.secrets.map((s) => s.name)],
    };
  };

  const playground =
    options.playground === false
      ? undefined
      : new PlaygroundSession({
        outDir: resolve(outDir),
        env,
        idleMs: options.playgroundIdleMs,
        callTimeoutMs: options.playgroundCallTimeoutMs,
        toolMeta,
        secretValues: () => knownSecretValues,
        ...(sample ? { connect: sampleConnect, launch: sampleLaunch, healSupport: true } : {}),
      });

  const baseHeaders = (): Record<string, string> => ({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });

  const sendBytes = (res: ServerResponse, status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}, head = false): void => {
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': type, 'Content-Length': String(buffer.length), ...extra });
    res.end(head ? undefined : buffer);
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, secretValues: readonly string[] = []): void => {
    const safe = redactForStudio(body, { env, secretValues });
    sendBytes(res, status, 'application/json; charset=utf-8', JSON.stringify(safe));
  };

  const sendError = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void => {
    const buffer = Buffer.from(JSON.stringify({ error: message }), 'utf-8');
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buffer.length), ...extra });
    res.end(buffer);
  };

  const originAllowed = (origin: string): boolean => {
    try {
      return allowedHosts.has(new URL(origin).host.toLowerCase());
    } catch {
      return false;
    }
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = firstHeader(req.headers['x-studio-token']);
    if (sameToken(header, token)) return true;
    // The cookie of the first visit: GET freely, a POST only with the marker header and our own Origin (CSRF)
    if (!sameToken(cookieValue(req.headers.cookie, COOKIE_NAME), token)) return false;
    if (req.method !== 'POST') return true;
    const origin = firstHeader(req.headers.origin);
    return firstHeader(req.headers['x-studio-request']) !== undefined && origin !== undefined && originAllowed(origin);
  };

  async function serveAsset(res: ServerResponse, rawName: string, head: boolean): Promise<void> {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return sendError(res, 404, 'not found');
    }
    // Png only, a plain name: no separator, no dot but the extension
    if (!ASSET_NAME.test(name)) return sendError(res, 404, 'not found');
    const data = await load().catch(() => undefined);
    if (data === undefined || !data.assetNames.has(name)) return sendError(res, 404, 'not found');
    if (sample) return sendBytes(res, 200, 'image/png', SAMPLE_PNG, {}, head);
    try {
      const dir = await realpath(data.assetsDir as string);
      const file = await realpath(join(dir, name));
      if (!file.startsWith(dir + sep)) return sendError(res, 404, 'not found');
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return sendError(res, 404, 'not found');
      const bytes = await readFile(file);
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return sendError(res, 404, 'not found');
      return sendBytes(res, 200, 'image/png', bytes, {}, head);
    } catch {
      return sendError(res, 404, 'not found');
    }
  }

  /** Read the JSON body of a playground POST: an object, or `{}` when there is none. */
  async function readJsonObject(req: IncomingMessage, body: BodyReader, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    const bytes = await body.read();
    if (body.tooLarge()) {
      sendError(res, 413, 'request too large', { Connection: 'close' });
      return undefined;
    }
    if (bytes.length === 0) return {};
    if (!/^application\/json\b/i.test(firstHeader(req.headers['content-type']) ?? '')) {
      sendError(res, 415, 'send application/json');
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf-8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Falls through to the error
    }
    sendError(res, 400, 'the body must be a JSON object');
    return undefined;
  }

  /** The checks of a call request; a message when it is malformed. */
  function parseCall(body: Record<string, unknown>): CallRequest | string {
    const allowed = new Set(['tool', 'arguments', 'mode', 'timeoutMs', 'confirm', 'preview']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) return `unknown field ${key.slice(0, 40)}`;
    if (typeof body.tool !== 'string' || body.tool === '' || body.tool.length > 200) return 'tool must be a non-empty string';
    const args = body.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return 'arguments must be an object';
    if (body.mode !== undefined && body.mode !== 'strict' && body.mode !== 'heal') return 'mode must be strict or heal';
    const t = body.timeoutMs;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MS)) return `timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`;
    for (const flag of ['confirm', 'preview'] as const) if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return `${flag} must be true or false`;
    return {
      tool: body.tool,
      ...(args === undefined ? {} : { arguments: args as Record<string, unknown> }),
      ...(body.mode === undefined ? {} : { mode: body.mode as 'strict' | 'heal' }),
      ...(t === undefined ? {} : { timeoutMs: t as number }),
      ...(body.confirm === undefined ? {} : { confirm: body.confirm as boolean }),
      ...(body.preview === undefined ? {} : { preview: body.preview as boolean }),
    };
  }

  /** The tools of the server with what the workflows say about each: risk, levels, secrets by name. */
  async function playgroundStatus(session: PlaygroundSession): Promise<Record<string, unknown>> {
    let availability = await session.availability();
    let tools: Array<Record<string, unknown>> = [];
    if (availability.available) {
      try {
        const listed = await session.listTools();
        const data = await load().catch(() => undefined);
        const views = data === undefined ? [] : buildWorkflows(data.targets).workflows;
        tools = listed.map((tool) => {
          const view = views.find((w) => w.toolName === tool.name);
          const levels = view === undefined ? [] : [...new Set(view.steps.map((s) => s.primaryLevel))];
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            risk: view?.risk.highest ?? 'write',
            levels,
            secrets: view?.secrets ?? [],
            sensitiveArgs: view === undefined ? [] : view.steps.flatMap((s) => (s.usesSecret && s.variable !== undefined ? [s.variable] : [])),
            ...(view === undefined ? {} : { label: view.label }),
          };
        });
      } catch (err) {
        availability = { available: false, reason: 'start_failed', message: (err as Error).message };
      }
    }
    const data = await load().catch(() => undefined);
    return {
      ...availability,
      simulated: sample,
      serverStarted: session.serverStarted,
      mode: session.mode,
      healSupport: session.healSupport,
      previewSupported: data?.targets.some((t) => t.set.targetType === 'web') ?? false,
      preview: session.preview,
      tools,
    };
  }

  async function handlePlayground(session: PlaygroundSession | undefined, req: IncomingMessage, res: ServerResponse, pathname: string, body: BodyReader): Promise<void> {
    if (session === undefined) return sendError(res, 404, 'not found');
    const method = req.method ?? 'GET';
    const shot = /^\/api\/playground\/shot\/([^/]+)\.png$/.exec(pathname);
    if (shot !== null) {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'use GET', { Allow: 'GET, HEAD' });
      const bytes = SHOT_ID.test(shot[1]) ? await session.shots.read(shot[1]) : undefined;
      if (bytes === undefined) return sendError(res, 404, 'not found');
      return sendBytes(res, 200, 'image/png', bytes, {}, method === 'HEAD');
    }
    if (pathname === '/api/playground' || pathname === '/api/playground/history') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'use GET', { Allow: 'GET, HEAD' });
      if (pathname === '/api/playground/history') {
        return sendJson(res, 200, { history: session.history(), serverStarted: session.serverStarted, mode: session.mode, queued: session.queued }, knownSecretValues);
      }
      return sendJson(res, 200, await playgroundStatus(session), knownSecretValues);
    }
    if (pathname !== '/api/playground/call' && pathname !== '/api/playground/restart' && pathname !== '/api/playground/stop') return sendError(res, 404, 'not found');
    if (method !== 'POST') return sendError(res, 405, 'use POST', { Allow: 'POST' });
    const parsed = await readJsonObject(req, body, res);
    if (parsed === undefined) return;
    if (pathname === '/api/playground/stop') {
      await session.stop();
      return sendJson(res, 200, { ok: true, serverStarted: session.serverStarted });
    }
    if (pathname === '/api/playground/restart') {
      for (const key of Object.keys(parsed)) if (key !== 'mode' && key !== 'preview') return sendError(res, 400, `unknown field ${key.slice(0, 40)}`);
      if (parsed.mode !== undefined && parsed.mode !== 'strict' && parsed.mode !== 'heal') return sendError(res, 400, 'mode must be strict or heal');
      if (parsed.preview !== undefined && typeof parsed.preview !== 'boolean') return sendError(res, 400, 'preview must be true or false');
      if (parsed.mode === 'heal' && !session.healSupport) return sendError(res, 400, 'This server was compiled without --heal-support: heal mode is not available.');
      try {
        await session.restart({ mode: parsed.mode as 'strict' | 'heal' | undefined, preview: parsed.preview as boolean | undefined });
      } catch (err) {
        return sendJson(res, 503, { error: 'server_unavailable', message: (err as Error).message }, knownSecretValues);
      }
      return sendJson(res, 200, { ok: true, serverStarted: session.serverStarted, mode: session.mode, preview: session.preview });
    }
    const call = parseCall(parsed);
    if (typeof call === 'string') return sendError(res, 400, call);
    // A browser that gives up (the Abort button) ends the call and the server's replay
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const outcome = await session.call(call, abort.signal);
    if (res.destroyed) return;
    return sendJson(res, outcome.status, outcome.body, knownSecretValues);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, body: BodyReader): Promise<void> {
    const method = req.method ?? 'GET';
    if (pathname === '/api/playground' || pathname.startsWith('/api/playground/')) return handlePlayground(playground, req, res, pathname, body);
    if (pathname === '/api/pbt/run') {
      if (method !== 'POST') return sendError(res, 405, 'use POST', { Allow: 'POST' });
      if (sample) return sendError(res, 409, 'sample mode: there is no suite to run');
      if (pbtRun !== undefined) return sendError(res, 409, 'a run is already in progress');
      let data: Loaded;
      try {
        data = await load();
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
      const run = runPbtSuite(resolve(outDir), { timeoutMs: pbtTimeoutMs });
      pbtRun = run;
      try {
        const result = await run;
        return sendJson(res, 200, buildPbtView(result, data.targets, false), data.secretValues);
      } finally {
        pbtRun = undefined;
      }
    }
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'use GET', { Allow: 'GET, HEAD' });
    const head = method === 'HEAD';
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, sample });
    if (pathname.startsWith('/api/assets/')) return serveAsset(res, pathname.slice('/api/assets/'.length), head);
    const routes = ['/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt'];
    if (!routes.includes(pathname)) return sendError(res, 404, 'not found');
    let data: Loaded;
    try {
      data = await load();
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof LoadError ? err.message : 'cannot read the workflow file' });
    }
    // Hide secret values in the raw data first: a view cuts long texts, and a cut could leave half of a secret
    data = { ...data, targets: redactForStudio(data.targets, { env, secretValues: data.secretValues }), stateGraph: redactForStudio(data.stateGraph, { env, secretValues: data.secretValues }) };
    switch (pathname) {
      case '/api/overview':
        return sendJson(res, 200, buildOverview(data.targets, sample), data.secretValues);
      case '/api/workflows':
        return sendJson(res, 200, buildWorkflows(data.targets), data.secretValues);
      case '/api/graph':
        return sendJson(res, 200, buildGraph(data.targets, data.stateGraph), data.secretValues);
      case '/api/schemas':
        return sendJson(res, 200, buildSchemas(data.targets), data.secretValues);
      default:
        return sendJson(res, 200, buildPbtView(data.pbt, data.targets, pbtRun !== undefined), data.secretValues);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'use GET', { Allow: 'GET, HEAD' });
    const head = req.method === 'HEAD';
    // The first visit carries the token in the URL: keep it in a cookie and take it off the address bar
    const given = url.searchParams.get('token');
    if (given !== null) {
      if (!sameToken(given, token)) return sendError(res, 401, 'invalid token');
      url.searchParams.delete('token');
      const location = `${url.pathname}${url.search}`;
      res.writeHead(302, { ...baseHeaders(), Location: location, 'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`, 'Content-Length': '0' });
      res.end();
      return;
    }
    let root: string;
    try {
      root = await realpath(staticDir);
    } catch {
      if (url.pathname === '/' || url.pathname === '/index.html') return sendBytes(res, 200, CONTENT_TYPES['.html'], PLACEHOLDER_PAGE, {}, head);
      return sendError(res, 404, 'not found');
    }
    let target = resolveInside(root, url.pathname);
    if (target === undefined) return sendError(res, 403, 'forbidden');
    try {
      let info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target);
      }
      // A symlink may point out of the folder
      const real = await realpath(target);
      if (real !== root && !real.startsWith(root + sep)) return sendError(res, 403, 'forbidden');
      if (!info.isFile() || info.size > MAX_STATIC_BYTES) return sendError(res, 404, 'not found');
      const type = CONTENT_TYPES[target.slice(target.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
      return sendBytes(res, 200, type, await readFile(real), {}, head);
    } catch {
      return sendError(res, 404, 'not found');
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '';
    if (rawUrl.length > MAX_URL_LENGTH) return sendError(res, 414, 'URL too long');
    const hostHeader = firstHeader(req.headers.host)?.toLowerCase();
    if (hostHeader === undefined || !allowedHosts.has(hostHeader)) return sendError(res, 403, 'forbidden host');
    const origin = firstHeader(req.headers.origin);
    if (origin !== undefined && !originAllowed(origin)) return sendError(res, 403, 'forbidden origin');
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return sendError(res, 400, 'bad request');
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${hostHeader}`);
    } catch {
      return sendError(res, 400, 'bad request');
    }
    // Only the playground POSTs read a body (a small JSON object); everywhere else it is cut off at a few KB
    const limit = url.pathname.startsWith('/api/playground/') ? MAX_PLAYGROUND_BODY_BYTES : MAX_BODY_BYTES;
    const declared = Number(firstHeader(req.headers['content-length']) ?? 0);
    if (!Number.isFinite(declared) || declared > limit) return sendError(res, 413, 'request too large', { Connection: 'close' });
    let received = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    const finished = new Promise<void>((done) => {
      req.on('end', done);
      req.on('close', done);
      req.on('error', done);
    });
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        tooLarge = true;
        req.destroy();
      } else chunks.push(chunk);
    });
    const body: BodyReader = {
      read: async () => {
        await finished;
        return Buffer.concat(chunks);
      },
      tooLarge: () => tooLarge,
    };
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!authorized(req)) return sendError(res, 401, 'missing or invalid token', { 'WWW-Authenticate': 'Studio-Token' });
      if (tooLarge) return;
      return handleApi(req, res, url.pathname, body);
    }
    return serveStatic(req, res, url);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done();
    });
  });
  const address = server.address() as AddressInfo;
  const bare = host.replace(/^\[|\]$/g, '');
  const shown = bare.includes(':') ? `[${bare}]` : bare;
  allowedHosts = new Set([`${shown}:${address.port}`.toLowerCase(), `localhost:${address.port}`, `127.0.0.1:${address.port}`, `[::1]:${address.port}`]);
  const origin = `http://${shown}:${address.port}`;

  return {
    url: `${origin}/?token=${token}`,
    origin,
    token,
    port: address.port,
    close: async () => {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      // The MCP server it started, and the pictures it copied
      await playground?.close();
    },
  };
}
