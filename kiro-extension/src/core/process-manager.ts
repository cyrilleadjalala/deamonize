import { parseHandshakeLine } from './handshake';
import type { LocatorResult } from './cli-locator';
import type { ProcessManager, StudioClient, StudioSessionLike } from './ports';
import { buildBrowserUrl } from './studio-url';
import type { StudioRoute } from './studio-url';
import type { Handshake, ProcessState } from './types';

export type { ProcessManager };

export interface ChildLike {
  pid?: number;
  stdout: { on(e: 'data', f: (b: Buffer | string) => void): void };
  stderr: { on(e: 'data', f: (b: Buffer | string) => void): void };
  on(e: 'exit', f: (code: number | null, signal: string | null) => void): void;
  on(e: 'error', f: (err: Error) => void): void;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
  detached: boolean;
}

export interface ProcessManagerDeps {
  locate(): Promise<LocatorResult>;
  workspaceFolder(): string | undefined;
  spawn(command: string, args: string[], options: SpawnOptions): ChildLike;
  /** `taskkill /pid N /T /F` on Windows, else SIGTERM to the group and SIGKILL after 5 s. */
  killTree(pid: number, platform: NodeJS.Platform): Promise<void>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** One stderr line. The glue redacts it. */
  onStderr(line: string): void;
  createClient(h: Handshake): StudioClient;
  /** Default 30000. */
  handshakeTimeoutMs?: number;
}

/** A running Studio_Process. The token stays in a private field. */
export class StudioSession implements StudioSessionLike {
  readonly origin: string;
  readonly pid: number;
  readonly client: StudioClient;
  readonly #token: string;

  constructor(h: Handshake, client: StudioClient) {
    this.origin = h.origin;
    this.pid = h.pid;
    this.client = client;
    this.#token = h.token;
  }

  browserUrl(route?: StudioRoute): string {
    return buildBrowserUrl({ origin: this.origin, token: this.#token }, route);
  }

  sensitiveValues(): string[] {
    return [this.#token];
  }
}

export type StartFailure = 'no-folder' | 'locator' | 'spawn' | 'handshake-invalid' | 'timeout' | 'exited-early' | 'old-cli';

export class StartError extends Error {
  constructor(readonly reason: StartFailure, readonly locator?: LocatorResult) {
    super(`start failed: ${reason}`);
    this.name = 'StartError';
  }
}

const MAX_LINE_BYTES = 64 * 1024;
const STDERR_TAIL = 4096;
const EXIT_WAIT_MS = 10_000;

export function createProcessManager(deps: ProcessManagerDeps): ProcessManager {
  let state: ProcessState = 'stopped';
  let session: StudioSession | undefined;
  let child: ChildLike | undefined;
  let exited: Promise<void> | undefined;
  let pending: Promise<StudioSession> | undefined;
  let stopRequested = false;
  let stale = false;
  /** Bumped by every requested stop, so a start that is still locating the program does not spawn afterwards. */
  let epoch = 0;
  const listeners = new Set<(s: ProcessState) => void>();

  const setState = (next: ProcessState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener(next);
  };

  const kill = (target: ChildLike): void => {
    if (typeof target.pid === 'number') void deps.killTree(target.pid, deps.platform).catch(() => undefined);
  };

  const waitExit = async (promise: Promise<void> | undefined): Promise<void> => {
    if (promise === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = deps.setTimeout(resolve, EXIT_WAIT_MS);
    });
    await Promise.race([promise, cap]);
    if (timer !== undefined) deps.clearTimeout(timer);
  };

  const start = async (): Promise<StudioSession> => {
    const folder = deps.workspaceFolder();
    if (folder === undefined || folder === '') throw new StartError('no-folder');
    await waitExit(exited);
    const startEpoch = epoch;
    stopRequested = false;
    stale = false;
    setState('starting');
    const fail = (error: StartError): never => {
      setState('stopped');
      throw error;
    };

    let located: LocatorResult;
    try {
      located = await deps.locate();
    } catch {
      return fail(new StartError('spawn'));
    }
    if (located.kind !== 'ok') return fail(new StartError('locator', located));
    if (epoch !== startEpoch) return fail(new StartError('exited-early'));

    let proc: ChildLike;
    try {
      proc = deps.spawn(located.command, [...located.baseArgs, 'studio', '--machine'], {
        cwd: folder,
        env: { ...deps.env, ...located.extraEnv },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: deps.platform !== 'win32',
      });
    } catch {
      return fail(new StartError('spawn'));
    }
    child = proc;
    let onExited!: () => void;
    const thisExited = new Promise<void>((resolve) => {
      onExited = resolve;
    });
    exited = thisExited;

    return new Promise<StudioSession>((resolve, reject) => {
      let buffer = '';
      let decided = false;
      let settled = false;
      let stderrTail = '';
      let stderrPartial = '';
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = (): void => {
        if (timer !== undefined) deps.clearTimeout(timer);
        timer = undefined;
      };
      const rejectStart = (error: StartError, killChild: boolean): void => {
        if (settled) return;
        settled = true;
        decided = true;
        clearTimer();
        if (killChild) kill(proc);
        setState('stopped');
        reject(error);
      };

      timer = deps.setTimeout(() => rejectStart(new StartError('timeout'), true), deps.handshakeTimeoutMs ?? 30_000);

      proc.stdout.on('data', (chunk) => {
        if (decided) return;
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          if (buffer.length > MAX_LINE_BYTES) rejectStart(new StartError('handshake-invalid'), true);
          return;
        }
        decided = true;
        const parsed = parseHandshakeLine(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = '';
        if (parsed === undefined) {
          rejectStart(new StartError('handshake-invalid'), true);
          return;
        }
        settled = true;
        clearTimer();
        session = new StudioSession(parsed, deps.createClient(parsed));
        setState('running');
        resolve(session);
      });

      proc.stderr.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
        const lines = (stderrPartial + text).split(/\r?\n/);
        stderrPartial = lines.pop() ?? '';
        for (const line of lines) if (line !== '') deps.onStderr(line);
      });

      proc.on('exit', () => {
        clearTimer();
        if (stderrPartial !== '') deps.onStderr(stderrPartial);
        stderrPartial = '';
        if (child === proc) child = undefined;
        if (exited === thisExited) exited = undefined;
        onExited();
        if (!settled) {
          rejectStart(new StartError(/unknown option '--machine'/i.test(stderrTail) ? 'old-cli' : 'exited-early'), false);
          return;
        }
        if (session !== undefined && state === 'running') {
          session = undefined;
          setState(stopRequested ? 'stopped' : 'crashed');
        }
      });

      proc.on('error', () => {
        if (!settled) {
          if (child === proc) child = undefined;
          if (exited === thisExited) exited = undefined;
          onExited();
          rejectStart(new StartError('spawn'), false);
        }
      });
    });
  };

  const stopNow = async (): Promise<void> => {
    stopRequested = true;
    epoch += 1;
    const target = child;
    const wait = exited;
    if (target !== undefined) {
      kill(target);
      await waitExit(wait);
    }
    if (state === 'running' || state === 'crashed' || state === 'starting') {
      session = undefined;
      setState('stopped');
    }
  };

  const ensureStarted = (): Promise<StudioSession> => {
    if (state === 'running' && session !== undefined && !stale) return Promise.resolve(session);
    if (pending === undefined) {
      const run = (async (): Promise<StudioSession> => {
        if (state === 'running' && stale) await stopNow();
        return start();
      })();
      const clear = (): void => {
        if (pending === run) pending = undefined;
      };
      run.then(clear, clear);
      pending = run;
    }
    return pending;
  };

  return {
    get state() {
      return state;
    },
    get session() {
      return session;
    },
    onDidChangeState(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    ensureStarted,
    async restart() {
      if (pending !== undefined) await pending.catch(() => undefined);
      await stopNow();
      return ensureStarted();
    },
    stop: stopNow,
    markStale() {
      if (state === 'running') stale = true;
    },
  };
}
