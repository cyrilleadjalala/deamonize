export interface Handshake { origin: string; token: string; pid: number }
export type ProcessState = 'stopped' | 'starting' | 'running' | 'crashed';
export type Risk = 'read' | 'write' | 'delete';
export type RecordingState = 'idle' | 'recording' | 'saving' | 'compiling' | 'done' | 'error';
export type InstallScope = 'global' | 'project';

export interface WorkflowRow { id: string; label: string; toolName?: string; risk: Risk }
export interface SecretRow { name: string; kind: 'password' | 'totp' | 'token'; configured: boolean }
export interface InstallRow { scope: InstallScope; slug: string; kiroPath: string; askBeforeChanges?: boolean }
export interface PowerInfo { kiroHomeExists: boolean; installs: InstallRow[]; available: boolean }
export interface PreviewAnswer {
  confirmationId: string; scope: InstallScope; kiroPath: string;
  files: Array<{ path: string; outcome: 'create' | 'merge' | 'replace' }>;
  replacesEntry: boolean; placeholders: string[]; missingSecrets: string[];
  requiredSecrets?: string[]; backup: boolean;
}
export interface InstallAnswer { written: string[]; placeholders: string[]; missingSecrets: string[]; requiredSecrets?: string[]; scope: InstallScope }
/** A question waiting for an answer, as `GET /api/approvals` gives it (the arguments hold `***` for a secret, never a value). */
export interface ApprovalRow {
  id: string; tool: string; application: string; riskText: string; summary?: string; arguments: unknown;
  writeSteps: Array<{ index: number; label: string; risk: 'write' | 'delete' }>; secondsLeft: number; kind: string;
}
/** One line of the Audit_Log, reduced to what the Activity section shows. */
export interface ActivityRow { at: string; tool: string; decision: 'auto' | 'approved' | 'denied' | 'timeout' | 'unavailable'; success: boolean }
/** The plan the Studio gives before the Daemonize Power or agent is written (`POST /api/power/daemonize/preview`). */
export interface DaemonizePowerPlanRow {
  confirmationId: string; scope: InstallScope; parts: 'power' | 'agent'; kiroPath: string;
  files: Array<{ path: string; outcome: 'create' | 'merge' | 'replace' }>;
  conflicts: string[]; alreadyInstalled: boolean; replacesEntry: boolean;
}
export interface RecordingStatus { state: RecordingState; steps: number; labels: string[]; error?: string; sessionNote?: string }

/** A request outcome that the Studio answered. Network failures throw StudioClientError. */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; field?: string };

/** Plain data for a tree row. The glue turns it into a vscode.TreeItem. */
export interface TreeNode {
  id: string; label: string; description?: string; tooltip?: string;
  icon: 'play' | 'sync' | 'warning' | 'read' | 'write' | 'delete' | 'key' | 'check' | 'plug' | 'folder' | 'add' | 'info';
  contextValue?: string; command?: { id: string; args?: unknown[] };
  children?: TreeNode[];
}
