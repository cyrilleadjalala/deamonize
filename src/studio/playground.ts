/**
 * The MCP playground bridge: one MCP client per Studio, spawned over stdio from the `mcp.json` entry of the output
 * directory, behind a small HTTP surface (see server.ts).
 *
 * What it guarantees:
 * - one client for the whole Studio, started on first use, stopped after an idle period, restarted after a crash;
 * - one call at a time (a short queue), each with its own timeout and an abort;
 * - the child gets an allow-listed environment: system basics, `DAEMONIZE_*` and (heal mode only) the model keys.
 *   The values are never echoed: every answer and the call log are scrubbed with the known secret values;
 * - arguments are validated against the tool's input schema before the server is asked, a write or delete tool
 *   needs `confirm: true`, and the log of the last calls shows typed values of secret fields as `***`;
 * - pictures the server reports (a failure screenshot, a final screenshot) are copied into a Studio-owned temporary
 *   folder and served by random id; no arbitrary path is ever opened.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Validator } from '../validator/validator.js';
import { VaultUnreadableError, type SecretVault } from './contracts.js';
import { clipText } from './pbt-result.js';
import { collectEnvSecretValues, makeScrubber, redactForStudio, REDACTED } from './redact.js';

export type ReplayModeName = 'strict' | 'heal';
export type ToolRisk = 'read' | 'write' | 'delete';

export const DEFAULT_IDLE_MS = 5 * 60_000;
export const HISTORY_SIZE = 50;
export const MAX_QUEUE = 8;
export const MAX_SHOTS = 30;
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;
export const MAX_DATA_JSON = 200_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Time added to the timeout of a call for the start of the server and the transport. */
const STARTUP_ALLOWANCE_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const SHOT_ID = /^[a-f0-9]{24}$/;

// ---------------------------------------------------------------------------
// Environment of the child
// ---------------------------------------------------------------------------

/** System variables a server needs to start a browser or a program; compared without regard to case (Windows `Path`). */
const SYSTEM_ENV = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM',
  'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH',
]);
/** Credentials of a model: given to the child only in heal mode, the one mode that may call it. */
const MODEL_ENV = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

function isModelVariable(upper: string): boolean {
  return upper.startsWith('DAEMONIZE_MODEL_') || MODEL_ENV.has(upper);
}

function allowedEnvName(name: string, mode: ReplayModeName): boolean {
  const upper = name.toUpperCase();
  if (isModelVariable(upper)) return mode === 'heal';
  return SYSTEM_ENV.has(upper) || upper.startsWith('LC_') || upper.startsWith('DAEMONIZE_');
}

function pickAllowed(env: Record<string, string | undefined> | undefined, mode: ReplayModeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && allowedEnvName(name, mode)) out[name] = value;
  }
  return out;
}

export interface ChildEnvOptions {
  /** The real process environment: the source of the system variables. */
  processEnv: Record<string, string | undefined>;
  /** The environment of the Studio (default: the process one): the source of `DAEMONIZE_*` and the secrets. */
  studioEnv?: Record<string, string | undefined>;
  /** The `env` of the `mcp.json` entry; `${VAR}` placeholders are names, not values, and are ignored. */
  mcpEnv?: Record<string, string>;
  mode: ReplayModeName;
  /** Ask the server for a picture of the final screen. */
  preview?: boolean;
}

/** The environment of the MCP server process: allow-listed names only, with the mode and the preview chosen by the Studio. */
export function buildChildEnv(options: ChildEnvOptions): Record<string, string> {
  const literal: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.mcpEnv ?? {})) {
    if (typeof value === 'string' && !/\$\{[^}]*\}/.test(value)) literal[name] = value;
  }
  const merged: Record<string, string> = {
    ...pickAllowed(literal, options.mode),
    ...pickAllowed(options.processEnv, options.mode),
    ...pickAllowed(options.studioEnv ?? options.processEnv, options.mode),
  };
  // Whatever case an inherited name had, the two settings of the Studio win
  for (const name of Object.keys(merged)) {
    const upper = name.toUpperCase();
    if (upper === 'DAEMONIZE_MODE' || upper === 'DAEMONIZE_SCREENSHOT') delete merged[name];
  }
  merged.DAEMONIZE_MODE = options.mode;
  if (options.preview === true) merged.DAEMONIZE_SCREENSHOT = 'final';
  return merged;
}

/** The mode a server starts in: the Studio's `DAEMONIZE_MODE` when it is exactly `heal`, else the `mcp.json` default, else strict. */
export function initialMode(studioEnv: Record<string, string | undefined>, mcpEnv?: Record<string, string>): ReplayModeName {
  const given = studioEnv.DAEMONIZE_MODE ?? mcpEnv?.DAEMONIZE_MODE;
  return given === 'heal' ? 'heal' : 'strict';
}

// ---------------------------------------------------------------------------
// Arguments: validation and redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY =
  /pass(word|wd|phrase|code)?|secret|token|(^|[^a-z])t?otp($|[^a-z])|api[-_ ]?key|credential|cvv|(^|[^a-z])pin($|[^a-z])|(^|[^a-z])ssn($|[^a-z])|private[-_ ]?key|authorization|cookie/i;

/** True for a name that looks like it holds a credential, whatever the workflow declared. */
export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}

const keyForm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The values the arguments hold under sensitive names (declared by the workflow or looking like a credential). */
export function sensitiveValues(args: unknown, declared: readonly string[] = []): string[] {
  const names = new Set(declared.map(keyForm));
  const values: string[] = [];
  const walk = (node: unknown, sensitive: boolean): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      if (sensitive && String(node).length >= 3) values.push(String(node));
    } else if (Array.isArray(node)) node.forEach((item) => walk(item, sensitive));
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, sensitive || isSensitiveKey(k) || names.has(keyForm(k)));
    }
  };
  walk(args, false);
  return values;
}

/** A copy of the arguments safe to show: sensitive fields become `***`, known secret values anywhere are scrubbed. */
export function redactArguments(args: unknown, declared: readonly string[] = [], scrub: (text: string) => string = (t) => t): unknown {
  const names = new Set(declared.map(keyForm));
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[scrub(k)] = isSensitiveKey(k) || names.has(keyForm(k)) ? REDACTED : walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(args);
}

/** The input schema as the playground validates and shows it: no `$schema` (draft 7 is not known to Ajv 2020) and no reserved `_timeoutMs`. */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete copy.$schema;
  const properties = copy.properties;
  if (properties !== null && typeof properties === 'object') delete (properties as Record<string, unknown>)._timeoutMs;
  if (Array.isArray(copy.required)) copy.required = (copy.required as unknown[]).filter((n) => n !== '_timeoutMs');
  return copy;
}

export interface ArgumentIssue {
  path: string;
  message: string;
}

/** Validate arguments the way the generated server will, before asking it. Null when valid. */
export function validateArguments(tool: string, schema: Record<string, unknown>, args: unknown): ArgumentIssue[] | null {
  let validator: Validator;
  try {
    validator = new Validator(new Map([[tool, schema]]));
  } catch {
    // A schema Ajv cannot compile: the server itself will judge
    return null;
  }
  const result = validator.validate(tool, args);
  if (result === null) return null;
  return result.errors.map((e) => ({ path: e.instancePath === '' ? '(arguments)' : e.instancePath.replace(/^\//, '').replace(/\//g, '.'), message: e.message }));
}

// ---------------------------------------------------------------------------
// Connection to the server
// ---------------------------------------------------------------------------

export interface McpClientLike {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ content?: unknown; isError?: boolean }>;
}

export interface McpConnection {
  client: McpClientLike;
  /** Registers a function called once when the server process or the pipe is gone. */
  onClose(listener: () => void): void;
  /** Stops the server and waits for its process to end. */
  close(): Promise<void>;
  /** The end of the server's error output (may hold anything the server printed: scrub before showing). */
  stderrTail(): string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type ConnectFn = (spec: LaunchSpec) => Promise<McpConnection>;

function waitForExit(pid: number | null | undefined, timeoutMs: number): Promise<void> {
  if (pid === null || pid === undefined) return Promise.resolve();
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const poll = (): void => {
      if (!alive() || Date.now() >= deadline) done();
      else setTimeout(poll, 50);
    };
    poll();
  });
}

/** The real connection: the MCP SDK client over the stdio of a spawned server. */
export const connectStdio: ConnectFn = async (spec) => {
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, stderr: 'pipe' });
  const client = new Client({ name: 'daemonize-studio', version: '1.0.0' });
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf-8')).slice(-2000);
  });
  const listeners: Array<() => void> = [];
  let closed = false;
  client.onclose = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener();
  };
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close().catch(() => undefined);
    await waitForExit(transport.pid, 3000);
    throw Object.assign(new Error((err as Error).message), { stderrTail: tail });
  }
  return {
    client: client as unknown as McpClientLike,
    onClose: (listener) => {
      if (closed) listener();
      else listeners.push(listener);
    },
    close: async () => {
      const pid = transport.pid;
      closed = true;
      await client.close().catch(() => undefined);
      await waitForExit(pid, 5000);
    },
    stderrTail: () => tail,
  };
};

/** The launch of the generated server of an output directory, read from its `mcp.json`. */
export interface Launch {
  command: string;
  args: string[];
  mcpEnv: Record<string, string>;
  cwd: string;
}

export class PlaygroundUnavailable extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/** Reads `mcp.json` and refuses anything but `node <script>`: the Studio never runs another command from a file. */
export async function readLaunch(outDir: string): Promise<Launch> {
  const dir = resolve(outDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new PlaygroundUnavailable(code === 'ENOENT' ? 'mcp.json not found in the output directory: run daemonize compile first' : 'mcp.json cannot be read', 'no_mcp_json');
  }
  const servers = (parsed as { mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown }> } | null)?.mcpServers;
  const entry = servers === undefined || servers === null ? undefined : Object.values(servers)[0];
  if (entry === undefined || typeof entry.command !== 'string' || !Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) {
    throw new PlaygroundUnavailable('mcp.json has no usable server entry', 'bad_mcp_json');
  }
  const name = basename(entry.command).toLowerCase();
  if (name !== 'node' && name !== 'node.exe' && resolve(entry.command) !== process.execPath) {
    throw new PlaygroundUnavailable('the playground only starts servers launched with node', 'unsupported_command');
  }
  const args = [...(entry.args as string[])];
  // The recorded path is absolute: when the folder was moved, the server next to mcp.json is the one meant
  if (args.length === 0 || !existsSync(args[0])) args[0] = join(dir, 'mcp-server.js');
  if (!existsSync(args[0])) throw new PlaygroundUnavailable('mcp-server.js not found in the output directory: run daemonize compile first', 'not_compiled');
  const env: Record<string, string> = {};
  if (entry.env !== null && typeof entry.env === 'object') {
    for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
  }
  return { command: process.execPath, args, mcpEnv: env, cwd: dir };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** Where a server may put a picture: under these folders of the temporary directory, nowhere else. */
const SHOT_FOLDERS = ['daemonize-failures', 'daemonize-shots'];

/** The pictures of a Studio: copies in a folder only this Studio owns, by random id. */
export class ShotStore {
  private dir: string | undefined;
  private readonly order: string[] = [];
  private closed = false;

  private async folder(): Promise<string> {
    if (this.dir === undefined) this.dir = await mkdtemp(join(tmpdir(), 'daemonize-studio-shots-'));
    return this.dir;
  }

  /** Keep a PNG the server reported by path. Undefined when the path is not an allowed picture. */
  async addFile(path: unknown): Promise<string | undefined> {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) return undefined;
    try {
      const base = await realpath(tmpdir());
      const file = await realpath(resolve(path));
      const allowed = SHOT_FOLDERS.some((f) => file.startsWith(join(base, f) + sep));
      if (!allowed || !file.toLowerCase().endsWith('.png')) return undefined;
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SHOT_BYTES) return undefined;
      return await this.addBytes(await readFile(file));
    } catch {
      return undefined;
    }
  }

  /** Keep PNG bytes (checked for the PNG signature and the size cap). */
  async addBytes(bytes: Buffer): Promise<string | undefined> {
    if (this.closed || bytes.length > MAX_SHOT_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    const id = randomBytes(12).toString('hex');
    await writeFile(join(await this.folder(), `${id}.png`), bytes);
    this.order.push(id);
    while (this.order.length > MAX_SHOTS) {
      const old = this.order.shift() as string;
      await unlink(join(await this.folder(), `${old}.png`)).catch(() => undefined);
    }
    return id;
  }

  /** The bytes of a kept picture; undefined for anything that is not an id this store issued. */
  async read(id: string): Promise<Buffer | undefined> {
    if (!SHOT_ID.test(id) || !this.order.includes(id) || this.dir === undefined) return undefined;
    try {
      return await readFile(join(this.dir, `${id}.png`));
    } catch {
      return undefined;
    }
  }

  get count(): number {
    return this.order.length;
  }

  get directory(): string | undefined {
    return this.dir;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.order.length = 0;
    const dir = this.dir;
    this.dir = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface PlaygroundResult {
  ok: boolean;
  tool: string;
  elapsedMs: number;
  success?: boolean;
  drifted?: boolean;
  driftChecked?: boolean;
  healed?: boolean;
  healedSteps?: unknown[];
  levels?: string[];
  mode?: string;
  screenType?: string;
  title?: string;
  text?: string;
  data?: unknown;
  dataTruncated?: boolean;
  error?: string;
  errors?: unknown[];
  message?: string;
  refused?: 'validation';
  failure?: Record<string, unknown>;
  heal?: unknown;
  levelFallback?: boolean;
  driftReason?: string;
  terminalSize?: unknown;
  screenshotUrl?: string;
  screenshotSkipped?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The JSON a generated server answers in its first text block, or undefined when it is not one. */
export function parseToolResponse(response: { content?: unknown }): Record<string, unknown> | undefined {
  if (!Array.isArray(response.content)) return undefined;
  for (const block of response.content) {
    const b = asRecord(block);
    if (b !== undefined && b.type === 'text' && typeof b.text === 'string') {
      try {
        return asRecord(JSON.parse(b.text));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const decodeDataUri = (uri: unknown): Buffer | undefined => {
  if (typeof uri !== 'string') return undefined;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(uri.slice(0, 200_000));
  return m === null ? undefined : Buffer.from(m[1], 'base64');
};

/**
 * The summary of what a server answered: the fields the playground shows and nothing else. Pictures are kept in the
 * store and replaced by a URL; the inline thumbnail and any path are dropped.
 */
export async function summarizeResult(tool: string, raw: Record<string, unknown>, elapsedMs: number, shots: ShotStore): Promise<PlaygroundResult> {
  const out: PlaygroundResult = { ok: true, tool, elapsedMs };
  if (typeof raw.success === 'boolean') out.success = raw.success;
  if (typeof raw.drifted === 'boolean') out.drifted = raw.drifted;
  if (typeof raw.driftChecked === 'boolean') out.driftChecked = raw.driftChecked;
  if (typeof raw.healed === 'boolean') out.healed = raw.healed;
  if (Array.isArray(raw.healedSteps)) out.healedSteps = raw.healedSteps.slice(0, 50);
  if (Array.isArray(raw.levels)) out.levels = raw.levels.filter((l): l is string => typeof l === 'string').slice(0, 100);
  for (const key of ['mode', 'screenType', 'error', 'driftReason', 'screenshotSkipped'] as const) {
    if (typeof raw[key] === 'string') out[key] = clipText(raw[key] as string, 300);
  }
  if (typeof raw.title === 'string') out.title = clipText(raw.title, 300);
  if (typeof raw.text === 'string') out.text = raw.text.length > 20_000 ? `${raw.text.slice(0, 20_000)}\u2026` : raw.text;
  if (typeof raw.levelFallback === 'boolean') out.levelFallback = raw.levelFallback;
  if (Array.isArray(raw.errors)) out.errors = raw.errors.slice(0, 50);
  if (raw.heal !== undefined) out.heal = raw.heal;
  if (raw.terminalSize !== undefined) out.terminalSize = raw.terminalSize;
  if (raw.data !== undefined) {
    const json = JSON.stringify(raw.data) ?? '';
    if (json.length > MAX_DATA_JSON) out.dataTruncated = true;
    else out.data = raw.data;
  }
  let picture: string | undefined;
  const failure = asRecord(raw.failure);
  if (failure !== undefined) {
    const { screenshot, screenshotData, thumbnail, path, ...rest } = failure;
    out.failure = typeof path === 'string' ? { ...rest, path: basename(path.replace(/\\/g, '/')) } : rest;
    picture = await shots.addFile(screenshot);
    if (picture === undefined) {
      const bytes = typeof screenshotData === 'string' && screenshotData.length < 3_000_000 ? Buffer.from(screenshotData, 'base64') : decodeDataUri(thumbnail);
      if (bytes !== undefined) picture = await shots.addBytes(bytes);
    }
  }
  if (picture === undefined && typeof raw.screenshot === 'string') picture = await shots.addFile(raw.screenshot);
  if (picture !== undefined) out.screenshotUrl = `/api/playground/shot/${picture}.png`;
  if (out.success === undefined) out.success = false;
  return out;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface ToolMeta {
  risk: ToolRisk;
  /** Argument names that hold a typed secret (a password field of the recording). */
  sensitiveArgs: string[];
}

export interface PlaygroundTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HistoryEntry {
  id: number;
  at: string;
  tool: string;
  arguments: unknown;
  mode: ReplayModeName;
  ok: boolean;
  success?: boolean;
  drifted?: boolean;
  healed?: boolean;
  error?: string;
  elapsedMs: number;
}

export interface PlaygroundOptions {
  /** The output directory of `daemonize compile`. */
  outDir: string;
  /** Environment of the Studio: the source of `DAEMONIZE_*` values; its secret values are scrubbed from every answer. */
  env?: Record<string, string | undefined>;
  /** Idle time after which the server is stopped (default 5 min). */
  idleMs?: number;
  /** Timeout of a call without `timeoutMs` (default 60 s). */
  callTimeoutMs?: number;
  /** Risk and sensitive argument names of a tool (from the workflow); an unknown tool is treated as `write`. */
  toolMeta?: (tool: string) => Promise<ToolMeta | undefined> | ToolMeta | undefined;
  /** Replace the stdio connection (tests, sample mode). */
  connect?: ConnectFn;
  /** Replace the launch read from `mcp.json` (sample mode). */
  launch?: () => Promise<Launch> | Launch;
  /** Does this server have heal support (default: the output directory has `heal/heal-step.js`). */
  healSupport?: boolean;
  /** Extra secret values to scrub (the Studio's own). */
  secretValues?: () => readonly string[];
  /** The Secret_Vault: its values reach the child only (behavior: studio-first-flow group G2). */
  vault?: Pick<SecretVault, 'snapshot' | 'names' | 'values'>;
  /** Names of the secrets the workflows require (behavior: studio-first-flow group G2). */
  requiredSecretNames?: () => Promise<readonly string[]>;
  /** The real environment (default process.env), for the system variables of the child. */
  processEnv?: Record<string, string | undefined>;
}

export interface CallRequest {
  tool: string;
  arguments?: Record<string, unknown>;
  mode?: ReplayModeName;
  timeoutMs?: number;
  confirm?: boolean;
  /** Ask the server for a picture of the final screen (restarts it once when this changes). */
  preview?: boolean;
}

export interface HttpOutcome {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): HttpOutcome => ({ status, body: { error, message, ...extra } });

export class PlaygroundSession {
  private conn: McpConnection | undefined;
  private starting: Promise<McpConnection> | undefined;
  private tools: PlaygroundTool[] | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private currentMode: ReplayModeName;
  private currentPreview: boolean;
  private nextId = 1;
  private readonly log: HistoryEntry[] = [];
  private readonly studioEnv: Record<string, string | undefined>;
  private readonly idleMs: number;
  private readonly connectFn: ConnectFn;
  readonly shots = new ShotStore();
  /** How many times the server was started: tests and the status line read it. */
  starts = 0;
  /** Why the last server stopped by itself, if it did. */
  lastCrash: string | undefined;

  constructor(private readonly options: PlaygroundOptions) {
    this.studioEnv = options.env ?? process.env;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.connectFn = options.connect ?? connectStdio;
    this.currentMode = initialMode(this.studioEnv);
    this.currentPreview = this.studioEnv.DAEMONIZE_SCREENSHOT === 'final';
  }

  get mode(): ReplayModeName {
    return this.currentMode;
  }

  get preview(): boolean {
    return this.currentPreview;
  }

  get serverStarted(): boolean {
    return this.conn !== undefined;
  }

  get queued(): number {
    return this.pending;
  }

  get healSupport(): boolean {
    return this.options.healSupport ?? existsSync(join(resolve(this.options.outDir), 'heal', 'heal-step.js'));
  }

  history(): HistoryEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  private scrubber(extra: readonly string[] = []): (text: string) => string {
    return makeScrubber([...collectEnvSecretValues(this.studioEnv), ...(this.options.secretValues?.() ?? []), ...(this.options.vault?.values() ?? []), ...extra]);
  }

  /** A deep copy without credential keys and secret values. */
  redact<T>(value: T, extra: readonly string[] = []): T {
    return redactForStudio(value, { env: this.studioEnv, secretValues: [...(this.options.secretValues?.() ?? []), ...(this.options.vault?.values() ?? []), ...extra] });
  }

  /** Whether a server can be started at all, and why not. */
  async availability(): Promise<{ available: boolean; reason?: string; message?: string }> {
    try {
      await (this.options.launch ?? (() => readLaunch(this.options.outDir)))();
      return { available: true };
    } catch (err) {
      if (err instanceof PlaygroundUnavailable) return { available: false, reason: err.reason, message: err.message };
      return { available: false, reason: 'unavailable', message: 'the server cannot be launched' };
    }
  }

  // --- queue ---------------------------------------------------------------

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_QUEUE) return Promise.reject(Object.assign(new Error('too many calls waiting'), { busy: true }));
    this.pending += 1;
    this.clearIdle();
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run.finally(() => {
      this.pending -= 1;
      if (this.pending === 0) this.armIdle();
    });
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.conn === undefined || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.pending === 0) void this.stopConn();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * The server to start. With `strictVault` an unreadable vault throws VaultUnreadableError (no process may start with
   * half of its credentials); otherwise the vault values are skipped. Vault values win over any other source of the
   * same name, only the `DAEMONIZE_SECRET_<NAME>` key form is created, and neither `process.env` nor the Studio
   * environment object is changed.
   */
  private async launchSpec(options: { strictVault?: boolean } = {}): Promise<LaunchSpec> {
    const launch = await (this.options.launch ?? (() => readLaunch(this.options.outDir)))();
    const env = buildChildEnv({
      processEnv: this.options.processEnv ?? process.env,
      studioEnv: this.studioEnv,
      mcpEnv: launch.mcpEnv,
      mode: this.currentMode,
      preview: this.currentPreview,
    });
    const vault = this.options.vault;
    if (vault !== undefined) {
      let snapshot: Record<string, string> = {};
      try {
        snapshot = await vault.snapshot();
      } catch (err) {
        if (options.strictVault === true || !(err instanceof VaultUnreadableError)) throw err;
      }
      const required = this.options.requiredSecretNames === undefined ? Object.keys(snapshot) : await this.options.requiredSecretNames().catch(() => Object.keys(snapshot));
      for (const name of required) {
        const value = snapshot[name];
        if (typeof value !== 'string' || value === '') continue;
        const key = `DAEMONIZE_SECRET_${name}`;
        for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
        env[key] = value;
      }
    }
    return { command: launch.command, args: launch.args, env, cwd: launch.cwd };
  }

  /**
   * Upper-case names of the `DAEMONIZE_SECRET_*` variables that are non-empty in the environment this session passes
   * to the server (allow-listed names of the Studio and process environment, the literal entries of the `mcp.json`
   * env, and the names held by the Secret_Vault). Names only: no value leaves this method.
   */
  async configuredSecretVariables(): Promise<Set<string>> {
    const env =
      (await this.launchSpec({ strictVault: false }).catch(() => undefined))?.env ??
      buildChildEnv({ processEnv: this.options.processEnv ?? process.env, studioEnv: this.studioEnv, mode: this.currentMode });
    const names = new Set(
      Object.entries(env)
        .filter(([name, value]) => value !== '' && /^DAEMONIZE_SECRET_/i.test(name))
        .map(([name]) => name.toUpperCase())
    );
    for (const name of (await this.options.vault?.names().catch(() => undefined)) ?? []) names.add(`DAEMONIZE_SECRET_${name.toUpperCase()}`);
    return names;
  }
  private async ensureConn(): Promise<McpConnection> {
    if (this.closed) throw new PlaygroundUnavailable('the playground is closed', 'closed');
    if (this.conn !== undefined) return this.conn;
    if (this.starting !== undefined) return this.starting;
    this.starting = (async () => {
      let spec: LaunchSpec;
      try {
        spec = await this.launchSpec({ strictVault: true });
      } catch (err) {
        if (err instanceof VaultUnreadableError) {
          throw new PlaygroundUnavailable('Your saved credentials could not be read. Enter them again in the Credentials panel.', 'vault_unreadable');
        }
        throw err;
      }
      let conn: McpConnection;
      try {
        conn = await this.connectFn(spec);
      } catch (err) {
        const tail = (err as { stderrTail?: string }).stderrTail ?? '';
        const detail = this.scrubber()(`${(err as Error).message}${tail === '' ? '' : ` | ${tail.trim().split(/\r?\n/).slice(-3).join(' / ')}`}`);
        throw new PlaygroundUnavailable(`the MCP server did not start: ${clipText(detail, 500)}`, 'start_failed');
      }
      this.starts += 1;
      this.lastCrash = undefined;
      conn.onClose(() => {
        // A close we did not ask for: the next call starts a new server
        if (this.conn === conn) {
          this.conn = undefined;
          this.tools = undefined;
          this.lastCrash = this.scrubber()(clipText(conn.stderrTail().trim().split(/\r?\n/).slice(-2).join(' / '), 300) || 'the server process ended');
        }
      });
      this.conn = conn;
      return conn;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async stopConn(): Promise<void> {
    this.clearIdle();
    const conn = this.conn;
    this.conn = undefined;
    this.tools = undefined;
    if (conn !== undefined) await conn.close().catch(() => undefined);
  }

  /**
   * Stop the server at once, without waiting behind the queue (a call in flight ends with the usual server_crashed
   * answer). Used when a credential changed, so the next call starts a server with the new environment.
   */
  async stopNow(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.stopConn();
  }

  /** Stop the server (and keep the log); the next call starts it again. */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopConn());
  }

  /** Stop, optionally change the mode or the preview, and start again so that errors show now. */
  restart(change: { mode?: ReplayModeName; preview?: boolean } = {}): Promise<PlaygroundTool[]> {
    return this.enqueue(async () => {
      await this.stopConn();
      if (change.mode !== undefined) this.currentMode = change.mode;
      if (change.preview !== undefined) this.currentPreview = change.preview;
      return this.loadTools();
    });
  }

  /** Stop everything and delete the copied pictures. The session cannot be used afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    await this.tail.catch(() => undefined);
    await this.stopConn();
    await this.shots.close();
  }

  // --- tools ------------------------------------------------------------------

  private async loadTools(): Promise<PlaygroundTool[]> {
    const conn = await this.ensureConn();
    if (this.tools === undefined) {
      const listed = await conn.client.listTools();
      this.tools = listed.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: sanitizeSchema(t.inputSchema) }));
    }
    return this.tools;
  }

  /** The tools of the server, cached until it restarts. Starts the server when needed. */
  listTools(): Promise<PlaygroundTool[]> {
    return this.enqueue(() => this.loadTools());
  }

  // --- calls --------------------------------------------------------------------

  private record(entry: Omit<HistoryEntry, 'id' | 'at'>): void {
    this.log.push({ id: this.nextId++, at: new Date().toISOString(), ...entry });
    while (this.log.length > HISTORY_SIZE) this.log.shift();
  }

  /**
   * One call: refused when the arguments do not fit the schema or a write/delete tool is not confirmed, otherwise
   * sent to the server. Never throws: a failure of the bridge is an answer with `ok: false`.
   */
  async call(request: CallRequest, signal?: AbortSignal): Promise<HttpOutcome> {
    try {
      return await this.enqueue(() => this.runCall(request, signal));
    } catch (err) {
      if ((err as { busy?: boolean }).busy === true) return fail(429, 'busy', 'Too many calls are waiting. Try again in a moment.');
      if (err instanceof PlaygroundUnavailable) return fail(503, err.reason === 'closed' ? 'closed' : 'server_unavailable', err.message);
      return fail(500, 'internal_error', 'The playground failed unexpectedly.');
    }
  }

  private async runCall(request: CallRequest, signal: AbortSignal | undefined): Promise<HttpOutcome> {
    if (signal?.aborted === true) return fail(499, 'aborted', 'The request was cancelled before it started.');
    const tools = await this.loadTools();
    const tool = tools.find((t) => t.name === request.tool);
    if (tool === undefined) return fail(404, 'unknown_tool', `The server has no tool named ${clipText(request.tool, 80)}.`);
    const meta = await this.options.toolMeta?.(tool.name);
    const declared = meta?.sensitiveArgs ?? [];
    const args = { ...(request.arguments ?? {}) };
    // The reserved timeout is not part of the payload
    let timeoutMs = request.timeoutMs;
    if (args._timeoutMs !== undefined) {
      if (timeoutMs === undefined && typeof args._timeoutMs === 'number') timeoutMs = args._timeoutMs;
      delete args._timeoutMs;
    }
    const sensitive = sensitiveValues(args, declared);
    const scrub = this.scrubber(sensitive);
    const shownArgs = redactArguments(args, declared, scrub);
    const mode = request.mode ?? this.currentMode;

    const issues = validateArguments(tool.name, tool.inputSchema, args);
    if (issues !== null) {
      const message = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      const result: PlaygroundResult = {
        ok: false,
        tool: tool.name,
        elapsedMs: 0,
        success: false,
        refused: 'validation',
        error: 'validation',
        message: `The call was refused before reaching the server: ${message}`,
        errors: issues.map((i) => ({ instancePath: i.path, message: i.message })),
        mode: this.currentMode,
      };
      this.record({ tool: tool.name, arguments: shownArgs, mode, ok: false, success: false, error: 'validation', elapsedMs: 0 });
      return { status: 200, body: this.redact(result, sensitive) as unknown as Record<string, unknown> };
    }

    // An unknown tool (no workflow metadata) is treated as one that changes things
    const risk: ToolRisk = meta?.risk ?? 'write';
    if (risk !== 'read' && request.confirm !== true) {
      return fail(409, 'confirmation_required', `${tool.name} can change data in the application (${risk}). Send confirm: true to run it.`, { risk, tool: tool.name });
    }
    if (request.mode === 'heal' && !this.healSupport) {
      return fail(400, 'mode_unsupported', 'This server was compiled without --heal-support: heal mode is not available.');
    }

    // Another mode or preview needs a server started with that environment
    if ((request.mode !== undefined && request.mode !== this.currentMode) || (request.preview !== undefined && request.preview !== this.currentPreview)) {
      await this.stopConn();
      if (request.mode !== undefined) this.currentMode = request.mode;
      if (request.preview !== undefined) this.currentPreview = request.preview;
    }
    const conn = await this.ensureConn();

    const callMs = timeoutMs ?? undefined;
    const sdkTimeout = callMs !== undefined ? Math.min(callMs, MAX_TIMEOUT_MS) + STARTUP_ALLOWANCE_MS : (this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    const started = Date.now();
    let outcome: PlaygroundResult;
    try {
      const response = await conn.client.callTool(
        { name: tool.name, arguments: callMs === undefined ? args : { ...args, _timeoutMs: callMs } },
        undefined,
        { timeout: sdkTimeout, signal }
      );
      const raw = parseToolResponse(response);
      const elapsed = Date.now() - started;
      if (raw === undefined) {
        outcome = { ok: false, tool: tool.name, elapsedMs: elapsed, success: false, error: 'bad_response', message: 'The server answered something that is not a result.', mode: this.currentMode };
      } else {
        // Scrub before anything is cut to a length: a cut could leave half of a secret
        outcome = await summarizeResult(tool.name, this.redact(raw, sensitive), elapsed, this.shots);
      }
    } catch (err) {
      const elapsed = Date.now() - started;
      const e = err as { code?: number; name?: string; message?: string };
      let error: string;
      let message: string;
      const cancelled = (): boolean => signal?.aborted === true;
      if (cancelled() || e.name === 'AbortError') {
        error = 'aborted';
        message = 'The call was cancelled; the server was stopped.';
      } else if (e.code === -32001) {
        error = 'timeout';
        message = `The server did not answer within ${Math.round(sdkTimeout / 1000)} s; it was stopped.`;
      } else if (this.conn !== conn || e.code === -32000) {
        error = 'server_crashed';
        message = `The server stopped during the call${this.lastCrash === undefined ? '' : `: ${this.lastCrash}`}. It starts again on the next call.`;
      } else {
        error = 'call_failed';
        message = clipText(String(e.message ?? 'the call failed'), 300);
      }
      // A call that did not come back may still be running in the server: end it
      if (error === 'aborted' || error === 'timeout') await this.stopConn();
      outcome = { ok: false, tool: tool.name, elapsedMs: elapsed, success: false, error, message: this.scrubber(sensitive)(message), mode: this.currentMode };
    }
    const safe = this.redact(outcome, sensitive);
    this.record({
      tool: tool.name,
      arguments: shownArgs,
      mode: this.currentMode,
      ok: safe.ok,
      ...(safe.success === undefined ? {} : { success: safe.success }),
      ...(safe.drifted === undefined ? {} : { drifted: safe.drifted }),
      ...(safe.healed === undefined ? {} : { healed: safe.healed }),
      ...(safe.error === undefined ? {} : { error: safe.error }),
      elapsedMs: safe.elapsedMs,
    });
    return { status: 200, body: safe as unknown as Record<string, unknown> };
  }
}
