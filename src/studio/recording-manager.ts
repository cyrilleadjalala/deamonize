/**
 * Group G3: the Recording_Manager. One session at a time, driven by a six-state machine:
 * idle|done|error -> recording -> saving -> compiling -> done, with error reachable from the three active states.
 */
import { storageStateValues, makeScrubber } from './redact.js';
import type { CompileRunner, PowerInstaller, RecordingManager, RecordingStatus, RecordingState, SessionStore, StartInput, StartOutcome, StopOutcome } from './contracts.js';
import { InertRecordingManager } from './inert-services.js';
import {
  COMPILE_FAILED,
  NOTHING_RECORDED,
  RECORD_BUSY,
  RECORD_FAILED,
  RECORD_NOT_RUNNING,
  KIRO_ADDED,
  KIRO_NOT_ADDED,
  SESSION_NOT_CAPTURED,
  SESSION_NOT_FOUND,
  SESSION_NOT_SAVED,
  SESSION_STORE_UNAVAILABLE,
} from './messages/record.js';

/** What the manager needs from the live recorder (a structural subset of `LiveRecorder`). */
export interface LiveLike {
  readonly stepCount: number;
  /** What the user chose on the end sheet of the panel. */
  readonly finishIntent?: 'save' | 'test' | 'kiro';
  panelState(): { last: string[] };
}
export interface BrowserLike {
  close(): Promise<void>;
}
export type EndReason = 'panel' | 'signal' | 'api' | 'closed';

/** The options of `record()` that the manager uses, including the Studio hooks that G1 adds. */
export interface RecordCallOptions {
  url: string;
  name: string;
  label: string;
  out: string;
  headless: boolean;
  windowMode: 'studio';
  signal: AbortSignal;
  sessionStorageState?: string;
  captureSessionState?: (state: unknown) => void | Promise<void>;
  onLive: (live: LiveLike) => void;
  onBrowser: (browser: BrowserLike) => void;
  onEnding: (reason: EndReason) => void;
  launch?: unknown;
}
export type RecordFn = (options: RecordCallOptions) => Promise<{ sessionCaptured?: boolean } | void>;

/** The real `record()`, loaded on first use so this module does not pull Playwright in at import time. */
export const defaultRecord: RecordFn = async (options) => {
  const module = (await import('../cli/commands/record.js')) as unknown as { record: RecordFn };
  return module.record(options);
};

export interface RecordingManagerDeps {
  /** Absolute path of the Workflow_File. */
  workflowFile: string;
  sessions: SessionStore;
  compiler: CompileRunner;
  /** Removes known secret values and paths from a text. */
  scrub: (text: string) => string;
  /** Adds the built tool to Kiro when the user chose "Save and add to Kiro" on the end sheet of the panel. */
  power?: Pick<PowerInstaller, 'info' | 'preview' | 'install'>;
  /** Test seam: replaces the real `record()`. */
  record?: RecordFn;
  /** Passed to `record()` as `launch` (test seam for the Browser_Launcher). */
  launch?: unknown;
  /** Deadline of `close()` in milliseconds (default 10 000). */
  closeDeadlineMs?: number;
}

export class NullRecordingManager extends InertRecordingManager { }

const ACTIVE: ReadonlySet<RecordingState> = new Set(['recording', 'saving', 'compiling']);
const STEP_LABEL_COUNT = 3;
const KEPT_SENTENCE = /\s*The \d+ step\(s\) recorded so far were saved to (.+)\.\s*$/;
const COULD_NOT_SAVE = /\s*The \d+ step\(s\) recorded so far could not be saved:.*$/;

class StudioRecordingManager implements RecordingManager {
  private state: RecordingState = 'idle';
  private controller: AbortController | undefined;
  private live: LiveLike | undefined;
  private browser: BrowserLike | undefined;
  private snapshot: { steps: number; labels: string[] } = { steps: 0, labels: [] };
  private error: string | undefined;
  private recoveryFile: string | undefined;
  private sessionNote: string | undefined;
  private intent: 'test' | 'kiro' | undefined;
  private kiro: RecordingStatus['kiro'];
  private pendingSession: unknown;
  private running: Promise<void> | undefined;

  constructor(private readonly deps: RecordingManagerDeps) { }

  start(input: StartInput): StartOutcome {
    if (ACTIVE.has(this.state)) return { status: 409, message: RECORD_BUSY };
    // The check above and the assignments below run in one synchronous turn: this is the single-flight guard
    this.state = 'recording';
    this.snapshot = { steps: 0, labels: [] };
    this.error = undefined;
    this.recoveryFile = undefined;
    this.sessionNote = undefined;
    this.intent = undefined;
    this.kiro = undefined;
    this.pendingSession = undefined;
    this.live = undefined;
    this.browser = undefined;
    this.controller = new AbortController();
    this.running = this.run(input, this.controller).catch(() => undefined);
    return { status: 202 };
  }

  stop(): StopOutcome {
    if (this.state !== 'recording' || this.controller === undefined) return { status: 409, message: RECORD_NOT_RUNNING };
    this.state = 'saving';
    this.controller.abort();
    return { status: 202 };
  }

  status(): RecordingStatus {
    const live = this.live;
    let steps = this.snapshot.steps;
    let labels = this.snapshot.labels;
    if (live !== undefined) {
      const read = this.read(live);
      steps = read.steps;
      labels = read.labels;
    }
    const state = this.state;
    return {
      state,
      steps: state === 'idle' ? 0 : steps,
      labels: labels.slice(-STEP_LABEL_COUNT).map((label) => this.clean(label)),
      ...(state === 'error' && this.error !== undefined ? { error: this.error } : {}),
      ...(state === 'error' && this.recoveryFile !== undefined ? { recoveryFile: this.recoveryFile } : {}),
      ...(this.sessionNote === undefined ? {} : { sessionNote: this.sessionNote }),
      ...(state === 'done' && this.intent !== undefined ? { intent: this.intent } : {}),
      ...(state === 'done' && this.kiro !== undefined ? { kiro: this.kiro } : {}),
    };
  }

  isActive(): boolean {
    return ACTIVE.has(this.state);
  }

  async close(): Promise<void> {
    if (!this.isActive()) return;
    if (this.state === 'recording') {
      this.state = 'saving';
      this.controller?.abort();
    }
    const running = this.running;
    if (running === undefined) return;
    const deadline = this.deps.closeDeadlineMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      running.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), deadline);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) await this.browser?.close().catch(() => undefined);
  }

  // ---- the session -----------------------------------------------------------------------------------------

  private async run(input: StartInput, controller: AbortController): Promise<void> {
    const { sessions, compiler, workflowFile } = this.deps;
    const key = input.reuseSession ? sessions.keyFor(input.url) : undefined;
    let recordResult: { sessionCaptured?: boolean } | void = undefined;
    try {
      let sessionPath: string | undefined;
      if (input.reuseSession && key !== undefined) {
        try {
          sessionPath = await sessions.pathFor(key);
          if (sessionPath === undefined) {
            this.sessionNote = (await sessions.problem()) === undefined ? SESSION_NOT_FOUND : SESSION_STORE_UNAVAILABLE;
          }
        } catch {
          this.sessionNote = SESSION_STORE_UNAVAILABLE;
        }
      }
      const capture = input.reuseSession && key !== undefined && (await sessions.problem()) === undefined;
      let host = input.url;
      try {
        host = new URL(input.url).host;
      } catch {
        // The route validated the address already
      }
      const record = this.deps.record ?? defaultRecord;
      recordResult = await record({
        url: input.url,
        name: host,
        label: input.name,
        out: workflowFile,
        headless: false,
        windowMode: 'studio',
        signal: controller.signal,
        ...(sessionPath === undefined ? {} : { sessionStorageState: sessionPath }),
        ...(capture
          ? {
            captureSessionState: (state: unknown): void => {
              this.pendingSession = state;
            },
          }
          : {}),
        onLive: (live) => {
          this.live = live;
        },
        onBrowser: (browser) => {
          this.browser = browser;
        },
        onEnding: () => {
          this.takeSnapshot();
          if (this.state === 'recording') this.state = 'saving';
        },
        ...(this.deps.launch === undefined ? {} : { launch: this.deps.launch }),
      });
    } catch (err) {
      this.takeSnapshot();
      this.fail(err, this.live?.stepCount === 0);
      this.cleanup();
      return;
    }

    this.takeSnapshot();
    this.state = 'compiling';
    if (input.reuseSession && key !== undefined && recordResult?.sessionCaptured === false && this.pendingSession === undefined) {
      this.sessionNote = SESSION_NOT_CAPTURED;
    }
    let compiled: Awaited<ReturnType<CompileRunner['runExclusive']>>;
    try {
      compiled = await compiler.runExclusive();
    } catch (err) {
      compiled = { ok: false, message: err instanceof Error ? err.message : String(err), outputMayBeIncomplete: false };
    }
    if (!compiled.ok) {
      this.error = `${COMPILE_FAILED} ${this.plain(compiled.message)}`.trim();
      this.state = 'error';
      this.cleanup();
      return;
    }
    // The click on "Save and add to Kiro" is the consent: the tool is installed before the Studio shows 'done'
    if (this.intent === 'kiro') await this.addToKiro();
    this.state = 'done';
    if (this.pendingSession !== undefined && key !== undefined) {
      try {
        await sessions.save(key, this.pendingSession);
      } catch {
        this.sessionNote = SESSION_NOT_SAVED;
      }
    }
    this.cleanup();
  }

  private async addToKiro(): Promise<void> {
    const power = this.deps.power;
    if (power === undefined) return;
    try {
      // The Kiro of this computer when it has a home folder, else the open project
      const info = await power.info();
      const scope = info.kiroHomeExists ? 'global' : 'project';
      const preview = await power.preview({ scope });
      await power.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope });
      this.kiro = { added: true, message: KIRO_ADDED, scope };
    } catch (err) {
      const reason = err instanceof Error ? this.plain(err.message) : '';
      this.kiro = { added: false, message: `${KIRO_NOT_ADDED} ${reason}`.trim() };
    }
  }

  private fail(err: unknown, noSteps: boolean): void {
    const raw = err instanceof Error ? err.message : String(err);
    const kept = KEPT_SENTENCE.exec(raw);
    if (noSteps || /without steps/i.test(raw) || /Nothing had been recorded/i.test(raw)) {
      this.error = NOTHING_RECORDED;
    } else {
      if (kept?.[1] !== undefined) this.recoveryFile = kept[1];
      const text = this.plain(raw.replace(KEPT_SENTENCE, '').replace(COULD_NOT_SAVE, ''));
      this.error = text === '' ? RECORD_FAILED : text;
    }
    this.state = 'error';
  }

  private cleanup(): void {
    this.live = undefined;
    this.browser = undefined;
    this.controller = undefined;
    this.pendingSession = undefined;
  }

  private takeSnapshot(): void {
    if (this.live === undefined) return;
    try {
      this.snapshot = this.read(this.live);
      const intent = this.live.finishIntent;
      if (intent === 'test' || intent === 'kiro') this.intent = intent;
    } catch {
      // The page is gone: keep the last snapshot
    }
  }

  private read(live: LiveLike): { steps: number; labels: string[] } {
    try {
      return { steps: live.stepCount, labels: live.panelState().last.slice(-STEP_LABEL_COUNT) };
    } catch {
      return this.snapshot;
    }
  }

  /** Removes secret values (known ones, and the session being saved) from a text. */
  private clean(text: string): string {
    const extra = this.pendingSession === undefined ? [] : storageStateValues(this.pendingSession);
    const scrubbed = this.deps.scrub(text);
    return extra.length === 0 ? scrubbed : makeScrubber(extra)(scrubbed);
  }

  /** A message for the user: no absolute path, no secret value. */
  private plain(text: string): string {
    const noPaths = text
      .replace(/[A-Za-z]:[\\/][^\s'")]*/g, 'a file')
      .replace(/(^|[\s'"(])\/[^\s'")]+/g, '$1a file');
    return this.clean(noPaths).trim();
  }
}

export function createRecordingManager(deps: RecordingManagerDeps): RecordingManager {
  return new StudioRecordingManager(deps);
}
