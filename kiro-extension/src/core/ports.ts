import type {
  ActivityRow, ApiResult, ApprovalRow, DaemonizePowerPlanRow, Handshake, InstallAnswer, InstallScope, PowerInfo,
  PreviewAnswer, ProcessState, RecordingStatus, SecretRow, WorkflowRow,
} from './types';

export type StudioRoute = 'playground' | 'credentials' | 'overview' | 'workflows' | 'activity';
/** Where the Studio opens inside a route: a tool in the Playground, or one workflow. */
export type StudioTarget = { kind: 'tool'; name: string } | { kind: 'workflow'; id: string };

export interface Redactor { (text: string): string }

export interface StudioClient {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

export interface StudioApi {
  health(): Promise<ApiResult<{ ok: boolean }>>;
  workflows(): Promise<ApiResult<WorkflowRow[]>>;
  secrets(): Promise<ApiResult<SecretRow[]>>;
  setSecret(name: string, value: string): Promise<ApiResult<{ name: string; configured: boolean }>>;
  forgetSecret(name: string): Promise<ApiResult<{ name: string; configured: boolean }>>;
  deleteWorkflow(id: string): Promise<ApiResult<{ ok: boolean; remaining: number; recompile?: string }>>;
  recordStart(i: { name: string; url: string; reuseSession: boolean }): Promise<ApiResult<{ state: string }>>;
  recordStatus(): Promise<ApiResult<RecordingStatus>>;
  recordStop(): Promise<ApiResult<{ state: string }>>;
  powerInfo(): Promise<ApiResult<PowerInfo>>;
  powerPreview(scope: InstallScope, workspacePath?: string): Promise<ApiResult<PreviewAnswer>>;
  powerInstall(p: { confirmationId: string; kiroPath: string; scope: InstallScope }): Promise<ApiResult<InstallAnswer>>;
  powerRemove(scope: InstallScope): Promise<ApiResult<{ removed: string[] }>>;
}

/** The approvals and the activity: `GET /api/approvals`, `POST /api/approvals/decide`, `GET /api/activity`, `POST /api/power/approval`. */
export interface ActivityApi {
  approvals(): Promise<ApiResult<ApprovalRow[]>>;
  decide(id: string, decision: 'approved' | 'denied'): Promise<ApiResult<{ id: string; decision: string }>>;
  activity(limit: number): Promise<ApiResult<ActivityRow[]>>;
  setAskBeforeChanges(scope: InstallScope, value: boolean): Promise<ApiResult<{ scope: InstallScope; askBeforeChanges: boolean }>>;
}

/** The Daemonize Power and agent: `/api/power/daemonize/*`, and the browser check `GET /api/system/browser`. */
export interface PowerApi {
  info(): Promise<ApiResult<{ installs: Array<{ scope: InstallScope; parts: 'power' | 'agent' }>; agentPresent: { project: boolean; global: boolean } }>>;
  preview(i: { scope: InstallScope; parts: 'power' | 'agent'; workspacePath?: string }): Promise<ApiResult<DaemonizePowerPlanRow>>;
  install(i: { confirmationId: string; kiroPath: string; scope: InstallScope; replace?: string[] }): Promise<ApiResult<{ written: string[]; skipped: string[]; alreadyInstalled: boolean }>>;
  remove(scope: InstallScope, parts: 'power' | 'agent'): Promise<ApiResult<{ removed: string[] }>>;
  browser(): Promise<ApiResult<{ available: boolean }>>;
}

/** What the glue sees of a running Studio_Process. The class `StudioSession` in process-manager.ts implements it. */
export interface StudioSessionLike {
  readonly origin: string;
  readonly pid: number;
  readonly client: StudioClient;
  /** The only way the token leaves the session, besides the client. */
  browserUrl(route?: StudioRoute, target?: StudioTarget): string;
  /** For the redactor. */
  sensitiveValues(): string[];
}

export interface ProcessManager {
  readonly state: ProcessState;
  readonly session: StudioSessionLike | undefined;
  onDidChangeState(listener: (s: ProcessState) => void): { dispose(): void };
  /** Lazy; one pending start is shared by all callers. */
  ensureStarted(): Promise<StudioSessionLike>;
  /** Stop, wait for exit, start. */
  restart(): Promise<StudioSessionLike>;
  /** A requested stop. */
  stop(): Promise<void>;
  /** After a 401: the next ensureStarted starts a new process. */
  markStale(): void;
}

export interface RecordingPoller { start(): void; stop(): void; readonly running: boolean }

export type { Handshake };
