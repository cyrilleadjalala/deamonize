import type { ChildLike, ProcessManagerDeps, SpawnOptions } from '../../../../kiro-extension/src/core/process-manager';
import type { Handshake } from '../../../../kiro-extension/src/core/types';

export const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

export function handshakeLine(port = 5000, pid = 4242, token = TOKEN): string {
  return `${JSON.stringify({ origin: `http://127.0.0.1:${port}`, token, pid })}\n`;
}

/** A child whose streams and events the test drives by hand. */
export class FakeChild implements ChildLike {
  readonly pid: number;
  exited = false;
  killed = false;
  private out: Array<(b: Buffer | string) => void> = [];
  private err: Array<(b: Buffer | string) => void> = [];
  private exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  private errorHandlers: Array<(e: Error) => void> = [];
  readonly stdout = { on: (_e: 'data', f: (b: Buffer | string) => void): void => void this.out.push(f) };
  readonly stderr = { on: (_e: 'data', f: (b: Buffer | string) => void): void => void this.err.push(f) };
  constructor(pid: number) {
    this.pid = pid;
  }
  on(e: 'exit', f: (code: number | null, signal: string | null) => void): void;
  on(e: 'error', f: (err: Error) => void): void;
  on(e: string, f: (...args: never[]) => void): void {
    if (e === 'exit') this.exitHandlers.push(f as never);
    else this.errorHandlers.push(f as never);
  }
  emitStdout(text: string): void {
    for (const f of this.out) f(text);
  }
  emitStderr(text: string): void {
    for (const f of this.err) f(text);
  }
  emitExit(code: number | null = 0): void {
    if (this.exited) return;
    this.exited = true;
    for (const f of this.exitHandlers) f(code, null);
  }
  emitError(error: Error): void {
    for (const f of this.errorHandlers) f(error);
  }
}

export interface Harness {
  deps: ProcessManagerDeps;
  children: FakeChild[];
  spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }>;
  killed: number[];
  stderrLines: string[];
  clientsCreated: Handshake[];
  live(): FakeChild[];
}

/** Timers never fire here: tests drive every event themselves. */
export function createHarness(overrides: Partial<ProcessManagerDeps> = {}, autoExitOnKill = true): Harness {
  const children: FakeChild[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const killed: number[] = [];
  const stderrLines: string[] = [];
  const clientsCreated: Handshake[] = [];
  let nextPid = 100;
  const deps: ProcessManagerDeps = {
    locate: async () => ({ kind: 'ok', command: 'node', baseArgs: ['cli.js'], extraEnv: {}, cliFile: 'cli.js', usedElectronNode: false }),
    workspaceFolder: () => '/ws',
    spawn: (command, args, options) => {
      const child = new FakeChild(nextPid++);
      children.push(child);
      spawnCalls.push({ command, args, options });
      return child;
    },
    killTree: async (pid) => {
      killed.push(pid);
      const child = children.find((c) => c.pid === pid);
      if (child !== undefined) {
        child.killed = true;
        if (autoExitOnKill) queueMicrotask(() => child.emitExit(null));
      }
    },
    env: { PATH: '/bin' },
    platform: 'linux',
    setTimeout: (() => ({ unref() { } })) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    onStderr: (line) => void stderrLines.push(line),
    createClient: (h) => {
      clientsCreated.push(h);
      return { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) };
    },
    ...overrides,
  };
  return { deps, children, spawnCalls, killed, stderrLines, clientsCreated, live: () => children.filter((c) => !c.exited) };
}

/** Lets promise chains and queued microtasks run. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
