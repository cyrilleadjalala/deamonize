import type {
  ApiResult, Handshake, InstallAnswer, InstallScope, PowerInfo, PreviewAnswer, ProcessState,
  RecordingStatus, SecretRow, WorkflowRow,
} from './types';

export type StudioRoute = 'playground' | 'credentials' | 'overview' | 'workflows';
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
