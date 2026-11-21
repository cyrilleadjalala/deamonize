/**
 * Approval queue: a signed file queue in `<App_Data_Dir>/approvals/` between a generated server (or the Studio_MCP)
 * and the Studio. Standalone runtime module: imports only `node:*` and its siblings.
 *
 * G0 seam: types, constants and signatures are final; the bodies belong to group G-B.
 */

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

/** A whole number of milliseconds from 5000 to 600000 as text, else 120000. */
export function parseApprovalTimeout(_value: string | undefined): number {
  throw new Error('not implemented: G-B');
}
/** Sorted keys, no spaces. */
export function canonicalJson(_value: unknown): string {
  throw new Error('not implemented: G-B');
}
export function sign<T extends object>(_key: Buffer, _body: T): T & { mac: string } {
  throw new Error('not implemented: G-B');
}
/** Constant time. */
export function verify(_key: Buffer, _record: unknown): boolean {
  throw new Error('not implemented: G-B');
}
export function encodeRecord(_record: ApprovalRequestRecord | ApprovalDecisionRecord): string {
  throw new Error('not implemented: G-B');
}
/** Shape only, never throws. */
export function decodeRequest(_text: string): ApprovalRequestRecord | undefined {
  throw new Error('not implemented: G-B');
}
export function decodeDecision(_text: string): ApprovalDecisionRecord | undefined {
  throw new Error('not implemented: G-B');
}

export interface ApprovalStore {
  dir: string;
  key: Buffer;
}
/**
 * `<dataDir>/approvals`, created `0700`; the key is created with `wx` (0600). On POSIX the folder must be owned by the
 * user and not group or world accessible. undefined = unusable.
 */
export function openApprovalStore(_dataDir: string): Promise<ApprovalStore | undefined> {
  throw new Error('not implemented: G-B');
}
export function writeHeartbeat(_store: ApprovalStore, _now?: number): Promise<void> {
  throw new Error('not implemented: G-B');
}
export function removeHeartbeat(_store: ApprovalStore): Promise<void> {
  throw new Error('not implemented: G-B');
}
export function approverAvailable(_store: ApprovalStore, _now?: number): Promise<boolean> {
  throw new Error('not implemented: G-B');
}
export function listPending(_store: ApprovalStore, _now?: number): Promise<ApprovalRequestRecord[]> {
  throw new Error('not implemented: G-B');
}
/** `exists` when a decision file is already there (first wins). */
export function writeDecision(
  _store: ApprovalStore,
  _req: ApprovalRequestRecord,
  _decision: ApprovalDecisionValue,
  _by: 'studio' | 'requester',
  _now?: number
): Promise<'written' | 'exists'> {
  throw new Error('not implemented: G-B');
}
/** Removes decided, expired and orphaned files older than the retention (10 min), and temp files older than 1 min. */
export function sweep(_store: ApprovalStore, _now?: number): Promise<void> {
  throw new Error('not implemented: G-B');
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
export function requestApproval(_options: RequestApprovalOptions): Promise<ApprovalOutcome> {
  throw new Error('not implemented: G-B');
}
