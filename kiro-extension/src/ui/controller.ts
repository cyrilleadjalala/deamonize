import * as vscode from 'vscode';
import { locateCli, type LocatorResult } from '../core/cli-locator';
import type { ProcessManager, Redactor, StudioApi, StudioSessionLike } from '../core/ports';
import { StartError } from '../core/process-manager';
import { createRedactor } from '../core/redactor';
import { StudioClientError } from '../core/studio-client';
import { S } from '../core/strings';
import type { ApiResult, ProcessState, RecordingStatus } from '../core/types';
import { createLogger, type Logger } from './logger';
import { buildLocatorInput, chooseCliFile, openDaemonizeSettings } from './settings';

/** What the composition root hands to the real process manager. */
export interface ManagerHooks {
  locate(): Promise<LocatorResult>;
  workspaceFolder(): string | undefined;
  /** One line of the Studio process stderr (the logger redacts it). */
  onStderr(line: string): void;
  /** One failed-request line from the client (the logger redacts it). */
  log(line: string): void;
}

export interface ExtensionDeps {
  createProcessManager(hooks: ManagerHooks): ProcessManager;
  createApi(session: StudioSessionLike): StudioApi;
  env: NodeJS.ProcessEnv;
}

export type FolderState =
  | { kind: 'none' }
  | { kind: 'remote' }
  | { kind: 'local'; path: string; count: number };

export function currentFolder(): FolderState {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return { kind: 'none' };
  const first = folders[0];
  if (first.uri.scheme !== 'file') return { kind: 'remote' };
  return { kind: 'local', path: first.uri.fsPath, count: folders.length };
}

/** Holds the process manager, the redactor and the logger, and maps failures to plain messages. */
export class Controller {
  readonly redact: Redactor;
  readonly logger: Logger;
  readonly manager: ProcessManager;
  recording: RecordingStatus | undefined;
  lastActionName: string | undefined;

  private readonly refreshListeners = new Set<() => void>();
  private readonly seenSensitive = new Set<string>();
  private warnedSeveralFolders = false;
  private startedOnFirstView = false;

  constructor(readonly deps: ExtensionDeps) {
    this.redact = createRedactor({
      sensitiveValues: () => [...this.seenSensitive, ...(this.manager?.session?.sensitiveValues() ?? [])],
      env: () => deps.env,
    });
    this.logger = createLogger(this.redact);
    this.manager = deps.createProcessManager({
      locate: async () => {
        const folder = currentFolder();
        return locateCli(buildLocatorInput(folder.kind === 'local' ? folder.path : '', deps.env));
      },
      workspaceFolder: () => {
        const folder = currentFolder();
        return folder.kind === 'local' ? folder.path : undefined;
      },
      onStderr: (line) => this.logger.logStderr(line),
      log: (line) => this.logger.log(line),
    });
    this.manager.onDidChangeState((state) => this.onState(state));
  }

  get state(): ProcessState { return this.manager.state; }

  private onState(state: ProcessState): void {
    const session = this.manager.session;
    if (state === 'running' && session) for (const v of session.sensitiveValues()) this.seenSensitive.add(v);
    this.refresh();
  }

  onDidRefresh(listener: () => void): { dispose(): void } {
    this.refreshListeners.add(listener);
    return { dispose: () => { this.refreshListeners.delete(listener); } };
  }

  /** Tells every view and the status bar to redraw. */
  refresh(): void {
    for (const listener of [...this.refreshListeners]) listener();
  }

  setRecording(status: RecordingStatus | undefined): void {
    this.recording = status;
    this.refresh();
  }

  /** True when a local folder is open. Otherwise shows the matching plain message. */
  async ensureFolder(): Promise<boolean> {
    const folder = currentFolder();
    if (folder.kind === 'local') {
      if (folder.count > 1 && !this.warnedSeveralFolders && this.manager.state !== 'running') {
        this.warnedSeveralFolders = true;
        void vscode.window.showInformationMessage(S.severalFolders);
      }
      return true;
    }
    if (folder.kind === 'remote') {
      void vscode.window.showErrorMessage(S.folderNotLocal);
      return false;
    }
    const choice = await vscode.window.showInformationMessage(S.noWorkspaceFolder, S.openFolder);
    if (choice === S.openFolder) await vscode.commands.executeCommand('workbench.action.files.openFolder');
    return false;
  }

  /**
   * Starts the Studio when needed and runs `fn`. Failures become plain messages and the result is `undefined`.
   * A GET (`idempotent`) is retried once, transparently, after a 401. A POST is never replayed.
   */
  async withStudio<T>(
    fn: (api: StudioApi, session: StudioSessionLike) => Promise<T>,
    options: { idempotent?: boolean } = {},
  ): Promise<T | undefined> {
    if (!(await this.ensureFolder())) return undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const session = await this.manager.ensureStarted();
        return await fn(this.deps.createApi(session), session);
      } catch (error) {
        if (error instanceof StudioClientError && error.kind === 'unauthorized') {
          this.manager.markStale();
          if (options.idempotent && attempt === 0) continue;
          try { await this.manager.ensureStarted(); } catch { /* the message below is enough */ }
          void vscode.window.showErrorMessage(S.restartedTryAgain);
          return undefined;
        }
        await this.reportError(error);
        return undefined;
      }
    }
  }

  /** Like `withStudio` for commands that manage the process itself (start, restart). */
  async guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      await this.reportError(error);
      return undefined;
    }
  }

  /** For tree views: runs a read only call when the Studio is already running. Never starts it. */
  async query<T>(fn: (api: StudioApi) => Promise<ApiResult<T>>): Promise<ApiResult<T> | undefined> {
    let session = this.manager.session;
    if (this.manager.state !== 'running' || !session) return undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn(this.deps.createApi(session));
      } catch (error) {
        const unauthorized = error instanceof StudioClientError && error.kind === 'unauthorized';
        if (unauthorized) {
          this.manager.markStale();
          if (attempt === 0) {
            // One transparent retry of a read only call, on a fresh process.
            try { session = await this.manager.ensureStarted(); continue; } catch { /* fall through to the plain answer */ }
          }
        }
        this.logger.log(`list failed: ${error instanceof StudioClientError ? error.kind : 'error'}`);
        return { ok: false, status: 0, error: S.loadFailed };
      }
    }
  }

  /** The first time a Daemonize view opens, start the Studio once. */
  startOnFirstView(): void {
    if (this.startedOnFirstView) return;
    if (currentFolder().kind !== 'local') return;
    this.startedOnFirstView = true;
    void this.guarded(async () => { await this.manager.ensureStarted(); });
  }

  async reportError(error: unknown): Promise<void> {
    if (error instanceof StartError) {
      await this.reportStartError(error);
      return;
    }
    if (error instanceof StudioClientError) {
      this.logger.log(`request failed: ${error.kind}`);
      void vscode.window.showErrorMessage(error.kind === 'timeout' ? S.startTimeout : S.networkError);
      return;
    }
    this.logger.log(error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(S.startFailed);
  }

  private async reportStartError(error: StartError): Promise<void> {
    const locator = error.locator;
    switch (error.reason) {
      case 'no-folder':
        await this.ensureFolder();
        return;
      case 'locator': {
        if (locator?.kind === 'configured-missing') {
          await this.offerCliChoice(S.cliConfiguredMissing(locator.path));
        } else if (locator?.kind === 'unsupported-shim') {
          await this.offerCliChoice(S.cliUnsupportedShim(locator.path));
        } else {
          await this.offerCliChoice(S.cliMissing(''));
        }
        return;
      }
      case 'old-cli':
        void vscode.window.showErrorMessage(S.cliTooOld);
        return;
      case 'timeout': {
        const pick = await vscode.window.showErrorMessage(S.startTimeout, S.tryAgain);
        if (pick === S.tryAgain) void this.guarded(async () => { await this.manager.ensureStarted(); });
        return;
      }
      case 'exited-early':
        void vscode.window.showErrorMessage(S.exitedEarly);
        return;
      default:
        void vscode.window.showErrorMessage(S.startFailed);
    }
  }

  private async offerCliChoice(message: string): Promise<void> {
    const pick = await vscode.window.showErrorMessage(message, S.chooseFile, S.openSettings);
    if (pick === S.chooseFile) await chooseCliFile();
    else if (pick === S.openSettings) await openDaemonizeSettings();
  }

  dispose(): void {
    this.logger.dispose();
    this.refreshListeners.clear();
  }
}
