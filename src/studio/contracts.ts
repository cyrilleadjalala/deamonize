/**
 * Cross-group contracts of the Studio first flow. The only coupling between the modules that different groups own.
 * Change this file only through the foundation owner.
 */

// ---- app data -------------------------------------------------------------
export type AppDataProblem = 'unresolved' | 'inside-working-dir' | 'inside-git-repo' | 'inside-output-dir' | 'not-writable';
export type AppDataCheck = { ok: true; dir: string } | { ok: false; problem: AppDataProblem };
export interface AppData {
  /** Resolved folder, even when excluded (for tests and messages that never print it). */
  readonly dir: string | undefined;
  /** Re-evaluated on every call: `.git` may appear later. Creates the folder (mode 0700) when ok. */
  ensure(): Promise<AppDataCheck>;
  /** Same decision without creating anything. */
  check(): Promise<AppDataCheck>;
}

// ---- secrets ----------------------------------------------------------------
/** OS protection or App_Data_Dir unusable: the routes answer 503. */
export class VaultUnavailableError extends Error { }
/** The file exists but the key is missing or decryption failed. */
export class VaultUnreadableError extends Error { }
export interface SecretVault {
  /** Names with a non-empty value. Unreadable vault -> empty set, never throws. */
  names(): Promise<ReadonlySet<string>>;
  /** Sync snapshot of every value held or just stored, plus normalized TOTP keys, for the Redactor. */
  values(): readonly string[];
  /** Throws VaultUnavailableError (nothing written, old values kept). Warms the cache before returning. */
  set(name: string, value: string): Promise<void>;
  /** Returns true when a value existed. Throws VaultUnavailableError. */
  remove(name: string): Promise<boolean>;
  has(name: string): Promise<boolean>;
  /** Name to value, for the Child_Server only. {} when no vault file. Throws VaultUnreadableError. */
  snapshot(): Promise<Record<string, string>>;

  /** Replaces the scoped value of (applicationKey, name). Throws VaultUnavailableError. */
  setFor(applicationKey: string, name: string, value: string): Promise<void>;
  /** Deletes only the scoped entry. true when it existed. */
  removeFor(applicationKey: string, name: string): Promise<boolean>;
  /** Names with a non-empty scoped or generic value. Unreadable vault -> empty set. Never returns a value. */
  namesFor(applicationKey: string): Promise<ReadonlySet<string>>;
  /** name -> value, scoped over generic, only non-empty values. For the Child_Server. Throws VaultUnreadableError. */
  snapshotFor(applicationKey: string): Promise<Record<string, string>>;
}

export interface RequiredSecret {
  name: string;
  kind: 'password' | 'totp' | 'token';
}

// ---- sessions ---------------------------------------------------------------
export class SessionSaveError extends Error { }
export interface SessionStore {
  /** Application_Key (normalized origin) for a URL, or undefined when it is not http(s). Pure. */
  keyFor(url: string): string | undefined;
  available(key: string): Promise<boolean>;
  /** Path of a usable saved storage state, or undefined (none, invalid, or App_Data_Dir excluded). */
  pathFor(key: string): Promise<string | undefined>;
  /** Atomic write (temp file plus rename). Throws SessionSaveError. */
  save(key: string, state: unknown): Promise<void>;
  /** Deletes the file when it exists. Never throws for a missing file. */
  forget(key: string): Promise<void>;
  /** Cookie and local-storage values of every saved state, from a cache refreshed by `refresh()`. */
  knownValues(): readonly string[];
  refresh(): Promise<void>;
  /** Plain-language problem when the App_Data_Dir is excluded, else undefined. */
  problem(): Promise<string | undefined>;
}

// ---- recording --------------------------------------------------------------
export type RecordingState = 'idle' | 'recording' | 'saving' | 'compiling' | 'done' | 'error';
export interface RecordingStatus {
  state: RecordingState;
  steps: number;
  /** At most 3, scrubbed. */
  labels: string[];
  /** Only in state 'error'. */
  error?: string;
  /** Only in state 'error', when a file was written. */
  recoveryFile?: string;
  /** Plain-language note: session not used, not saved, or storage unavailable. */
  sessionNote?: string;
}
/** Already validated. */
export interface StartInput {
  name: string;
  url: string;
  reuseSession: boolean;
}
export type StartOutcome = { status: 202 } | { status: 409; message: string };
export type StopOutcome = { status: 202 } | { status: 409; message: string };
export interface RecordingManager {
  /** Synchronous accept or refuse: the single-flight guard. */
  start(input: StartInput): StartOutcome;
  /** Synchronous: sets 'saving' before returning 202. */
  stop(): StopOutcome;
  status(): RecordingStatus;
  /** recording | saving | compiling */
  isActive(): boolean;
  /** Ends the session through the signal path, 10 s deadline. */
  close(): Promise<void>;
}

// ---- compile ----------------------------------------------------------------
export type CompileState = 'idle' | 'running' | 'done' | 'error';
export type CompilePhaseView = 'generating' | 'installing' | null;
export interface CompileStatus {
  state: CompileState;
  phase: CompilePhaseView;
  error?: string;
}
export type CompileOutcome = { ok: true } | { ok: false; message: string; outputMayBeIncomplete: boolean };
export interface CompileRunner {
  status(): CompileStatus;
  /** Sync: false when a compile is running (route answers 409). Otherwise starts and returns true. */
  tryStart(): boolean;
  /** For the RecordingManager: waits for a running compile, then runs one and resolves with its outcome. */
  runExclusive(): Promise<CompileOutcome>;
  /** Kills a running installation. */
  close(): Promise<void>;
}

// ---- power ------------------------------------------------------------------
/** `path` is relative to `.kiro`, with forward slashes. */
export interface PowerFilePlan {
  path: string;
  outcome: 'create' | 'merge' | 'replace';
}
export type InstallScope = 'global' | 'project';
export interface InstallSummary {
  scope: InstallScope;
  slug: string;
  kiroPath: string;
}
export interface PowerInfo {
  available: boolean;
  defaultWorkspace: string;
  outputPath: string;
  /** The slug. */
  serverName?: string;
  /** Absolute path of <home>/.kiro. */
  kiroHome: string;
  kiroHomeExists: boolean;
  /** For "Remove from Kiro". */
  installs: InstallSummary[];
}
export interface PowerPreview {
  confirmationId: string;
  scope: InstallScope;
  /** Absolute, exactly what the UI shows. */
  kiroPath: string;
  files: PowerFilePlan[];
  /** settings/mcp.json already holds this server key. */
  replacesEntry: boolean;
  serverName: string;
  /** Variables that will be written as ${...}. */
  placeholders: string[];
  /** Secret_Names with no value yet, for the warning. */
  missingSecrets: string[];
  /** True when settings/mcp.json exists and will be copied. */
  backup: boolean;
  otherScopeInstalled?: InstallScope;
}
export interface AutoAddOutcome {
  status: 'disabled' | 'added' | 'unchanged' | 'failed';
  message?: string;
}
export interface AutoAddState {
  enabled: boolean;
  scope?: InstallScope;
  writable: boolean;
  last?: AutoAddOutcome;
}
export class PowerError extends Error {
  constructor(readonly status: 400 | 409 | 500, message: string) {
    super(message);
  }
}
export interface PowerInstaller {
  info(): Promise<PowerInfo>;
  /** Throws PowerError. */
  preview(request: { scope: unknown; workspacePath?: unknown }): Promise<PowerPreview>;
  install(request: { confirmationId: unknown; kiroPath: unknown; scope: unknown; autoAdd?: unknown }): Promise<{
    written: string[];
    placeholders: string[];
    missingSecrets: string[];
    scope: InstallScope;
    /** Only when `autoAdd` was requested: false when the consent could not be stored. */
    autoAddSaved?: boolean;
  }>;
  remove(request: { scope: unknown }): Promise<{ removed: string[] }>;
  /** JSON text, placeholders only. */
  snippet(): Promise<string>;
  getAutoAdd(): Promise<AutoAddState>;
  disableAutoAdd(): Promise<AutoAddState>;
  /** Called by the server after a successful Playground call. Never throws. */
  runAutoAdd(): Promise<AutoAddOutcome>;
}

// ---- application location ---------------------------------------------------
export interface ActiveApplication {
  /** Application_Key, undefined for a non-http target. */
  applicationKey?: string;
  slug: string;
  /** Absolute, where the compiled tool is or will be. */
  outDir: string;
  /** True while the base folder (daemonize-out) is the one in use. */
  legacy: boolean;
}
export interface ApplicationLocator {
  /** Reads only. Compiled Name_Map folder, else compiled base folder (legacy), else the peeked slug. */
  current(): Promise<ActiveApplication>;
  /** Called by the compile runner before writing: creates the Name_Map entry and returns the target. Throws AppNamesError. */
  prepareCompile(): Promise<ActiveApplication>;
}
export interface StudioServices {
  appData: AppData;
  vault: SecretVault;
  sessions: SessionStore;
  recording: RecordingManager;
  compiler: CompileRunner;
  power: PowerInstaller;
  locator: ApplicationLocator;
}
