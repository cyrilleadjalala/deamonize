export interface Handshake { origin: string; token: string; pid: number }
export type ProcessState = 'stopped' | 'starting' | 'running' | 'crashed';
export type Risk = 'read' | 'write' | 'delete';
export type RecordingState = 'idle' | 'recording' | 'saving' | 'compiling' | 'done' | 'error';
export type InstallScope = 'global' | 'project';

export interface WorkflowRow { id: string; label: string; toolName?: string; risk: Risk }
export interface SecretRow { name: string; kind: 'password' | 'totp' | 'token'; configured: boolean }
export interface InstallRow { scope: InstallScope; slug: string; kiroPath: string }
export interface PowerInfo { kiroHomeExists: boolean; installs: InstallRow[]; available: boolean }
export interface PreviewAnswer {
  confirmationId: string; scope: InstallScope; kiroPath: string;
  files: Array<{ path: string; outcome: 'create' | 'merge' | 'replace' }>;
  replacesEntry: boolean; placeholders: string[]; missingSecrets: string[];
  requiredSecrets?: string[]; backup: boolean;
}
export interface InstallAnswer { written: string[]; placeholders: string[]; missingSecrets: string[]; requiredSecrets?: string[]; scope: InstallScope }
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
