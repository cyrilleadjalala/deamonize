/**
 * Approval queue: a signed file queue in `<App_Data_Dir>/approvals/` between a generated server (or the Studio_MCP)
 * and the Studio. Standalone runtime module: imports only `node:*` and its siblings.
 *
 * Fail closed: a folder that cannot be used, a bad signature, a corrupt record or a missing approver never gives
 * `approved`. Only a record with a valid HMAC that answers the request that is waiting can approve a call.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ApprovalRisk = 'write' | 'delete';
export type ApprovalSource = 'kiro' | 'studio-mcp';
export type ApprovalKind = 'tool-call' | 'install' | 'delete-action' | 'test-action';
export type ApprovalDecisionValue = 'approved' | 'denied' | 'timeout' | 'withdrawn';
export interface WriteStepMeta {
  index: number;
  label: string;
  risk: ApprovalRisk;
}
export interface ApprovalRequestBody {
  v: 1;
  /** 32 lower-case hex. */
  id: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** 5000 to 600000. */
  timeoutMs: number;
  /** The process that waits. */
  pid: number;
  source: ApprovalSource;
  kind: ApprovalKind;
  tool: string;
  application: string;
  risk: ApprovalRisk;
  /** One plain sentence for kinds other than tool-call. */
  summary?: string;
  /** Redacted_Arguments. */
  arguments: unknown;
  writeSteps: WriteStepMeta[];
}
export type ApprovalRequestRecord = ApprovalRequestBody & { mac: string };
export interface ApprovalDecisionBody {
  v: 1;
  id: string;
  decision: ApprovalDecisionValue;
  decidedAt: string;
  by: 'studio' | 'requester';
  reqMac: string;
}
export type ApprovalDecisionRecord = ApprovalDecisionBody & { mac: string };

export const APPROVAL_DEFAULT_TIMEOUT_MS = 120_000;
export const APPROVAL_MIN_TIMEOUT_MS = 5_000;
export const APPROVAL_MAX_TIMEOUT_MS = 600_000;
export const APPROVAL_MAX_PENDING = 50;
export const HEARTBEAT_EVERY_MS = 2_000;
export const HEARTBEAT_FRESH_MS = 6_000;

const MAX_RECORD_BYTES = 16 * 1024;
const WAIT_STALE_MS = 10_000;
const RETENTION_MS = 10 * 60_000;
const TMP_RETENTION_MS = 60_000;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const REQ_FILE = /^req-([0-9a-f]{32})\.json$/;
const DEC_FILE = /^dec-([0-9a-f]{32})\.json$/;
const RISKS: readonly string[] = ['write', 'delete'];
const SOURCES: readonly string[] = ['kiro', 'studio-mcp'];
const KINDS: readonly string[] = ['tool-call', 'install', 'delete-action', 'test-action'];
const DECISIONS: readonly string[] = ['approved', 'denied', 'timeout', 'withdrawn'];

/** A whole number of milliseconds from 5000 to 600000 as text, else 120000. */
export function parseApprovalTimeout(value: string | undefined): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return APPROVAL_DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  return n >= APPROVAL_MIN_TIMEOUT_MS && n <= APPROVAL_MAX_TIMEOUT_MS ? n : APPROVAL_DEFAULT_TIMEOUT_MS;
}

/** Sorted keys, no spaces. */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): string | undefined => {
    if (node === null) return 'null';
    if (typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'number') return Number.isFinite(node) ? JSON.stringify(node) : 'null';
    if (typeof node === 'boolean') return node ? 'true' : 'false';
    if (Array.isArray(node)) return `[${node.map((item) => walk(item) ?? 'null').join(',')}]`;
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const text = walk(record[key]);
        if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
      }
      return `{${parts.join(',')}}`;
    }
    return undefined;
  };
  return walk(value) ?? 'null';
}

const macOf = (key: Buffer, body: object): string => createHmac('sha256', key).update(canonicalJson(body)).digest('base64url');

export function sign<T extends object>(key: Buffer, body: T): T & { mac: string } {
  const { mac: _ignored, ...rest } = body as T & { mac?: unknown };
  return { ...(rest as T), mac: macOf(key, rest) };
}

/** Constant time. */
export function verify(key: Buffer, record: unknown): boolean {
  try {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
    const { mac, ...rest } = record as Record<string, unknown>;
    if (typeof mac !== 'string' || mac.length === 0) return false;
    const expected = Buffer.from(macOf(key, rest));
    const actual = Buffer.from(mac);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function encodeRecord(record: ApprovalRequestRecord | ApprovalDecisionRecord): string {
  return canonicalJson(record);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const parseJson = (text: string): unknown => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Shape only, never throws. */
export function decodeRequest(text: string): ApprovalRequestRecord | undefined {
  try {
    const o = parseJson(text);
    if (!isObject(o) || o.v !== 1) return undefined;
    if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return undefined;
    if (!isIso(o.createdAt)) return undefined;
    if (!Number.isInteger(o.timeoutMs) || (o.timeoutMs as number) < APPROVAL_MIN_TIMEOUT_MS || (o.timeoutMs as number) > APPROVAL_MAX_TIMEOUT_MS) return undefined;
    if (!Number.isInteger(o.pid) || (o.pid as number) < 1) return undefined;
    if (typeof o.source !== 'string' || !SOURCES.includes(o.source)) return undefined;
    if (typeof o.kind !== 'string' || !KINDS.includes(o.kind)) return undefined;
    if (typeof o.tool !== 'string' || typeof o.application !== 'string') return undefined;
    if (typeof o.risk !== 'string' || !RISKS.includes(o.risk)) return undefined;
    if (o.summary !== undefined && typeof o.summary !== 'string') return undefined;
    if (!('arguments' in o)) return undefined;
    if (!Array.isArray(o.writeSteps)) return undefined;
    for (const s of o.writeSteps) {
      if (!isObject(s) || !Number.isInteger(s.index) || typeof s.label !== 'string' || typeof s.risk !== 'string' || !RISKS.includes(s.risk)) return undefined;
    }
    if (typeof o.mac !== 'string' || o.mac.length === 0) return undefined;
    return o as unknown as ApprovalRequestRecord;
  } catch {
    return undefined;
  }
}

export function decodeDecision(text: string): ApprovalDecisionRecord | undefined {
  try {
    const o = parseJson(text);
    if (!isObject(o) || o.v !== 1) return undefined;
    if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return undefined;
    if (typeof o.decision !== 'string' || !DECISIONS.includes(o.decision)) return undefined;
    if (!isIso(o.decidedAt)) return undefined;
    if (o.by !== 'studio' && o.by !== 'requester') return undefined;
    if (typeof o.reqMac !== 'string' || o.reqMac.length === 0) return undefined;
    if (typeof o.mac !== 'string' || o.mac.length === 0) return undefined;
    return o as unknown as ApprovalDecisionRecord;
  } catch {
    return undefined;
  }
}

export interface ApprovalStore {
  dir: string;
  key: Buffer;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
};

const readKeyFile = async (path: string): Promise<Buffer | undefined> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, 'hex');
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return undefined;
      return undefined;
    }
    await defaultSleep(30); // the creator may still be writing
  }
  return undefined;
};

/**
 * `<dataDir>/approvals`, created `0700`; the key is created with `wx` (0600). On POSIX the folder must be owned by the
 * user and not group or world accessible. undefined = unusable.
 */
export async function openApprovalStore(dataDir: string): Promise<ApprovalStore | undefined> {
  try {
    if (typeof dataDir !== 'string' || dataDir === '') return undefined;
    const dir = join(dataDir, 'approvals');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await stat(dir);
    if (!info.isDirectory()) return undefined;
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return undefined;
    }
    const keyPath = join(dir, '.key');
    let key = await readKeyFile(keyPath).catch(() => undefined);
    if (key === undefined) {
      try {
        await writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (errCode(e) !== 'EEXIST') return undefined;
      }
      key = await readKeyFile(keyPath);
    }
    return key === undefined ? undefined : { dir, key };
  } catch {
    return undefined;
  }
}

/** Writes `text` to `path` so that the first writer wins and a reader never sees a half written file. */
const createExclusive = async (dir: string, path: string, text: string): Promise<'written' | 'exists'> => {
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    await link(tmp, path);
    return 'written';
  } catch (e) {
    if (errCode(e) === 'EEXIST') return 'exists';
    try {
      await writeFile(path, text, { flag: 'wx', mode: 0o600 });
      return 'written';
    } catch (e2) {
      if (errCode(e2) === 'EEXIST') return 'exists';
      throw e2;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
};

const heartbeatPath = (store: ApprovalStore): string => join(store.dir, 'approver.json');

export async function writeHeartbeat(store: ApprovalStore, now: number = Date.now()): Promise<void> {
  const record = sign(store.key, { v: 1, pid: process.pid, at: now });
  const tmp = join(store.dir, `.tmp-hb-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  try {
    await rename(tmp, heartbeatPath(store));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function removeHeartbeat(store: ApprovalStore): Promise<void> {
  await unlink(heartbeatPath(store)).catch(() => undefined);
}

/** The `at` of a valid heartbeat whose process is alive, else undefined. */
const readHeartbeat = async (store: ApprovalStore): Promise<number | undefined> => {
  try {
    const o = parseJson(await readFile(heartbeatPath(store), 'utf8'));
    if (!isObject(o) || o.v !== 1 || !verify(store.key, o)) return undefined;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at) || !Number.isInteger(o.pid)) return undefined;
    if (!pidAlive(o.pid as number)) return undefined;
    return o.at;
  } catch {
    return undefined;
  }
};

export async function approverAvailable(store: ApprovalStore, now: number = Date.now()): Promise<boolean> {
  const at = await readHeartbeat(store);
  return at !== undefined && Math.abs(now - at) <= HEARTBEAT_FRESH_MS;
}

const readDecisionFor = async (store: ApprovalStore, req: ApprovalRequestRecord): Promise<ApprovalDecisionRecord | undefined> => {
  try {
    const dec = decodeDecision(await readFile(join(store.dir, `dec-${req.id}.json`), 'utf8'));
    if (dec === undefined || dec.id !== req.id || dec.reqMac !== req.mac || !verify(store.key, dec)) return undefined;
    return dec;
  } catch {
    return undefined;
  }
};

const readRequest = async (store: ApprovalStore, id: string): Promise<ApprovalRequestRecord | undefined> => {
  try {
    const req = decodeRequest(await readFile(join(store.dir, `req-${id}.json`), 'utf8'));
    return req !== undefined && req.id === id && verify(store.key, req) ? req : undefined;
  } catch {
    return undefined;
  }
};

export async function listPending(store: ApprovalStore, now: number = Date.now()): Promise<ApprovalRequestRecord[]> {
  try {
    const names = (await readdir(store.dir)).filter((n) => REQ_FILE.test(n));
    const out: ApprovalRequestRecord[] = [];
    for (const name of names) {
      const id = (REQ_FILE.exec(name) as RegExpExecArray)[1];
      const req = await readRequest(store, id);
      if (req === undefined) continue;
      if (now >= Date.parse(req.createdAt) + req.timeoutMs) continue;
      if (!pidAlive(req.pid)) continue;
      if ((await readDecisionFor(store, req)) !== undefined) continue;
      out.push(req);
    }
    out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
    return out.slice(0, APPROVAL_MAX_PENDING);
  } catch {
    return [];
  }
}

/** `exists` when a decision file is already there (first wins). */
export async function writeDecision(
  store: ApprovalStore,
  req: ApprovalRequestRecord,
  decision: ApprovalDecisionValue,
  by: 'studio' | 'requester',
  now: number = Date.now()
): Promise<'written' | 'exists'> {
  // A request that does not verify is never answered.
  if (!verify(store.key, req) || !ID_PATTERN.test(req.id) || !DECISIONS.includes(decision)) return 'exists';
  const body: ApprovalDecisionBody = { v: 1, id: req.id, decision, decidedAt: new Date(now).toISOString(), by, reqMac: req.mac };
  const text = encodeRecord(sign(store.key, body));
  const path = join(store.dir, `dec-${req.id}.json`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await createExclusive(store.dir, path, text)) === 'written') return 'written';
    if ((await readDecisionFor(store, req)) !== undefined) return 'exists';
    // A file that is not a valid answer to this request does not count as a decision: replace it once.
    await unlink(path).catch(() => undefined);
  }
  return 'exists';
}

/** Removes decided, expired and orphaned files older than the retention (10 min), and temp files older than 1 min. */
export async function sweep(store: ApprovalStore, now: number = Date.now()): Promise<void> {
  try {
    for (const name of await readdir(store.dir)) {
      const isTmp = name.startsWith('.tmp-');
      if (!isTmp && !REQ_FILE.test(name) && !DEC_FILE.test(name)) continue;
      try {
        const info = await stat(join(store.dir, name));
        if (now - info.mtimeMs > (isTmp ? TMP_RETENTION_MS : RETENTION_MS)) await unlink(join(store.dir, name));
      } catch {
        // gone already
      }
    }
  } catch {
    // an unusable folder has nothing to sweep
  }
}

export interface RequestApprovalOptions {
  dataDir: string | undefined;
  source: ApprovalSource;
  kind: ApprovalKind;
  tool: string;
  application: string;
  risk: ApprovalRisk;
  summary?: string;
  /** Already redacted by the caller. */
  arguments: unknown;
  writeSteps: WriteStepMeta[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Default 250. */
  pollMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export type ApprovalOutcome = { decision: 'approved' | 'denied' | 'timeout' | 'withdrawn' | 'unavailable'; id?: string };

/**
 * Never throws. Anything unexpected is `unavailable`. Writes `timeout` or `withdrawn` itself with `wx`;
 * a decision that won the race is honoured.
 */
export async function requestApproval(options: RequestApprovalOptions): Promise<ApprovalOutcome> {
  let store: ApprovalStore | undefined;
  let req: ApprovalRequestRecord | undefined;
  try {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const pollMs = Math.max(1, options.pollMs ?? 250);
    if (typeof options.dataDir !== 'string' || options.dataDir === '') return { decision: 'unavailable' };
    store = await openApprovalStore(options.dataDir);
    if (store === undefined) return { decision: 'unavailable' };
    if (!(await approverAvailable(store, now()))) return { decision: 'unavailable' };
    if ((await listPending(store, now())).length >= APPROVAL_MAX_PENDING) return { decision: 'unavailable' };

    const timeoutMs = Math.min(APPROVAL_MAX_TIMEOUT_MS, Math.max(APPROVAL_MIN_TIMEOUT_MS, Math.trunc(Number(options.timeoutMs)) || APPROVAL_DEFAULT_TIMEOUT_MS));
    const createdMs = now();
    const buildBody = (args: unknown): ApprovalRequestBody => {
      const body: ApprovalRequestBody = {
        v: 1,
        id: randomBytes(16).toString('hex'),
        createdAt: new Date(createdMs).toISOString(),
        timeoutMs,
        pid: process.pid,
        source: options.source,
        kind: options.kind,
        tool: options.tool,
        application: options.application,
        risk: options.risk,
        arguments: args,
        writeSteps: options.writeSteps,
      };
      if (options.summary !== undefined) body.summary = options.summary;
      return body;
    };
    let record = sign(store.key, buildBody(options.arguments));
    if (Buffer.byteLength(encodeRecord(record), 'utf8') > MAX_RECORD_BYTES) record = sign(store.key, buildBody({ truncated: true }));
    req = record;
    if (decodeRequest(encodeRecord(req)) === undefined) return { decision: 'unavailable' };
    if ((await createExclusive(store.dir, join(store.dir, `req-${req.id}.json`), encodeRecord(req))) !== 'written') return { decision: 'unavailable' };

    const deadline = createdMs + timeoutMs;
    const settle = async (decision: ApprovalDecisionValue): Promise<ApprovalOutcome> => {
      const live = store as ApprovalStore;
      const mine = req as ApprovalRequestRecord;
      await writeDecision(live, mine, decision, 'requester', now()).catch(() => undefined);
      const winner = await readDecisionFor(live, mine);
      return { decision: winner?.decision ?? (decision === 'approved' ? 'denied' : decision), id: mine.id };
    };
    for (; ;) {
      const decided = await readDecisionFor(store, req);
      if (decided !== undefined) return { decision: decided.decision, id: req.id };
      if (options.signal?.aborted === true) return await settle('withdrawn');
      const t = now();
      if (t >= deadline) return await settle('timeout');
      const beat = await readHeartbeat(store);
      if (beat === undefined || t - beat > WAIT_STALE_MS) {
        const outcome = await settle('withdrawn');
        return outcome.decision === 'withdrawn' ? { decision: 'unavailable', id: req.id } : outcome;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - t)));
    }
  } catch {
    if (store !== undefined && req !== undefined) {
      await writeDecision(store, req, 'withdrawn', 'requester').catch(() => undefined);
    }
    return { decision: 'unavailable', id: req?.id };
  } finally {
    if (store !== undefined && req !== undefined) {
      await unlink(join(store.dir, `req-${req.id}.json`)).catch(() => undefined);
      await unlink(join(store.dir, `dec-${req.id}.json`)).catch(() => undefined);
    }
  }
}
