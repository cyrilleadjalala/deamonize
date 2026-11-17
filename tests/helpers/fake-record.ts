import type { CompileOutcome, CompileRunner, SessionStore } from '../../src/studio/contracts.js';
import { InertSessionStore } from '../../src/studio/inert-services.js';
import type { RecordCallOptions, RecordFn } from '../../src/studio/recording-manager.js';

/** A fake `record()` that the test drives by hand, through the same hooks as the real one. */
export class FakeRecord {
  calls: RecordCallOptions[] = [];
  steps = 0;
  labels: string[] = [];
  browserClosed = false;
  /** When true, an abort of the signal ends the session successfully (like "Finish and save"). */
  endOnAbort = true;
  /** When set, `record()` fails at once, before any hook runs (the browser cannot open). */
  launchError: string | undefined;
  private settle: { resolve: (v: { sessionCaptured?: boolean }) => void; reject: (e: Error) => void } | undefined;
  private options: RecordCallOptions | undefined;

  readonly fn: RecordFn = (options) => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    this.calls.push(options);
    if (this.launchError !== undefined) return Promise.reject(new Error(this.launchError));
    this.options = options;
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      options.onBrowser({ close: async () => { this.browserClosed = true; } });
      options.onLive({
        get stepCount(): number { return owner.steps; },
        panelState: () => ({ last: this.labels.slice(-3) }),
      });
      options.signal.addEventListener('abort', () => {
        if (!this.endOnAbort) return;
        this.end('signal');
        if (this.steps === 0) this.fail(new Error('Cannot finish a workflow without steps'));
        else this.succeed();
      }, { once: true });
    });
  };

  end(reason: 'panel' | 'signal' | 'api' | 'closed'): void {
    this.options?.onEnding(reason);
  }
  async captureSession(state: unknown): Promise<void> {
    await this.options?.captureSessionState?.(state);
  }
  succeed(summary: { sessionCaptured?: boolean } = {}): void {
    this.settle?.resolve(summary);
  }
  fail(error: Error): void {
    this.settle?.reject(error);
  }
}
export class FakeCompiler implements CompileRunner {
  runs = 0;
  outcome: CompileOutcome = { ok: true };
  gate: Promise<void> | undefined;
  /** Called when a run starts, before it waits: lets a test see the state the caller set just before. */
  onRun: (() => void) | undefined;
  status() { return { state: 'idle' as const, phase: null }; }
  tryStart(): boolean { return true; }
  async runExclusive(): Promise<CompileOutcome> {
    this.runs++;
    this.onRun?.();
    if (this.gate !== undefined) await this.gate;
    return this.outcome;
  }
  async close(): Promise<void> { /* nothing */ }
}

/** An in-memory session store. */
export class MemorySessions extends InertSessionStore implements SessionStore {
  files = new Map<string, unknown>();
  failSave = false;
  excluded = false;
  saves: Array<[string, unknown]> = [];
  pathCalls = 0;
  override async pathFor(key: string): Promise<string | undefined> {
    this.pathCalls++;
    return !this.excluded && this.files.has(key) ? `/memory/${key}` : undefined;
  }
  override async available(key: string): Promise<boolean> { return (await this.pathFor(key)) !== undefined; }
  override async save(key: string, state: unknown): Promise<void> {
    if (this.failSave) throw new Error('disk full');
    this.saves.push([key, state]);
    this.files.set(key, state);
  }
  override async forget(key: string): Promise<void> { this.files.delete(key); }
  override async problem(): Promise<string | undefined> { return this.excluded ? 'excluded' : undefined; }
}
