/**
 * How the Studio_MCP reaches a Studio. Order: a live Studio_Lease for the workspace, else `daemonize studio --machine`
 * started as a child. The token goes only into the `x-studio-token` header of a loopback request; it is never written,
 * logged or returned. Only routes of `AGENT_ALLOWED` are ever requested.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { agentMayCall } from '../agent-access.js';
import { defaultAppDataDir } from '../app-data.js';
import { isLoopbackOrigin, readLease, type LeaseDeps, type StudioLease } from '../lease.js';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type ApiOutcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unavailable' }
  | { kind: 'timeout' };

/** What the tools need from a Studio. */
export interface StudioApi {
  request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<ApiOutcome>;
  /** Values that must never leave in an answer (the token and the address). */
  secretValues(): string[];
  close(): Promise<void>;
}

export interface ConnectionOptions {
  workspace: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The App_Data_Dir (default: the platform folder, or `DAEMONIZE_DATA_DIR`). */
  dataDir?: string;
  /** The command that starts a Studio (default: this Node with the compiled CLI). */
  studioCommand?: { command: string; args: string[] };
  /** Default 20000. */
  attachTimeoutMs?: number;
  /** Default 5000. */
  stopTimeoutMs?: number;
  /** Test seam: how a lease is judged alive (default: the pid exists and `/api/health` answers). */
  leaseDeps?: LeaseDeps;
}

const ATTACH_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_MS = 25_000;
const GRACE_MS = 5_000;
const MAX_BODY_CHARS = 5_000_000;
const NEVER_REACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

interface Target {
  origin: string;
  token: string;
}

class AttachError extends Error { }

/** True when the workspace is the home folder or a drive root: tools that write refuse to run there. */
export function isUnsafeWorkspace(workspace: string, home: string = homedir()): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const fold = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const here = fold(real(workspace));
  return here === fold(real(home)) || here === fold(parse(here).root);
}

/** The folder of the workspace: `--workspace`, else `DAEMONIZE_WORKSPACE`, else the current folder. */
export function resolveWorkspace(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const chosen = explicit !== undefined && explicit !== '' ? explicit : env.DAEMONIZE_WORKSPACE !== undefined && env.DAEMONIZE_WORKSPACE !== '' ? env.DAEMONIZE_WORKSPACE : cwd;
  return resolve(chosen);
}

function defaultStudioCommand(): { command: string; args: string[] } {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'index.js');
  return { command: process.execPath, args: [cli, 'studio', '--machine'] };
}

function parseHandshake(line: string): { origin: string; token: string; pid: number } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.origin === 'string' && typeof v.token === 'string' && typeof v.pid === 'number') return { origin: v.origin, token: v.token, pid: v.pid };
  } catch {
    // Not the handshake line
  }
  return undefined;
}

export class StudioConnection implements StudioApi {
  private target: Target | undefined;
  private child: ChildProcess | undefined;
  private attaching: Promise<Target> | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly options: ConnectionOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  secretValues(): string[] {
    return this.target === undefined ? [] : [this.target.token, this.target.origin];
  }

  private dataDir(): string | undefined {
    return this.options.dataDir ?? defaultAppDataDir({ env: this.env });
  }

  /** The Studio to use: the cached one, else a live lease, else a child. Ends within the attach limit. */
  private async ensure(): Promise<Target> {
    if (this.target !== undefined) return this.target;
    this.attaching ??= this.attachWithin().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  private async attachWithin(): Promise<Target> {
    const limit = this.options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AttachError('timeout')), limit);
    });
    try {
      const target = await Promise.race([this.attach(), deadline]);
      this.target = target;
      return target;
    } catch (error) {
      await this.stopChild();
      throw error instanceof AttachError ? error : new AttachError('failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async attach(): Promise<Target> {
    const dir = this.dataDir();
    if (dir !== undefined) {
      const lease = await readLease(dir, this.options.workspace, this.options.leaseDeps);
      if (lease !== undefined) return { origin: lease.origin, token: lease.agentToken };
    }
    return this.startChild(dir);
  }

  private async startChild(dir: string | undefined): Promise<Target> {
    const { command, args } = this.options.studioCommand ?? defaultStudioCommand();
    const child = this.spawnFn(command, args, { cwd: this.options.workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.env });
    this.child = child;
    child.stderr?.on('data', () => undefined);
    const handshake = await new Promise<{ origin: string; token: string; pid: number }>((resolveLine, reject) => {
      let buffered = '';
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const parsed = parseHandshake(buffered.slice(0, newline).trim());
          buffered = buffered.slice(newline + 1);
          if (parsed !== undefined) return resolveLine(parsed);
          newline = buffered.indexOf('\n');
        }
        if (buffered.length > 8192) reject(new AttachError('bad handshake'));
      });
      child.once('error', () => reject(new AttachError('spawn')));
      child.once('exit', () => reject(new AttachError('exited')));
    });
    if (!isLoopbackOrigin(handshake.origin)) throw new AttachError('not loopback');
    // The Studio wrote its lease before the handshake line: take the agent token from it, else keep the owner token in memory
    let lease: StudioLease | undefined;
    if (dir !== undefined) lease = await readLease(dir, this.options.workspace, this.options.leaseDeps);
    if (lease !== undefined && lease.pid === handshake.pid && lease.origin === handshake.origin) return { origin: lease.origin, token: lease.agentToken };
    return { origin: handshake.origin, token: handshake.token };
  }

  private drop(): void {
    this.target = undefined;
  }

  /** Stops a Studio this connection started, within the stop limit. A Studio that was only attached stays up. */
  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.kill('SIGTERM');
    });
  }

  async close(): Promise<void> {
    this.drop();
    await this.stopChild();
  }

  async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<ApiOutcome> {
    const pathname = path.split('?')[0];
    // Only the documented routes of the agent principal; anything else is a programming error, never sent
    if (!path.startsWith('/api/') || !agentMayCall(method, pathname)) throw new Error('route not allowed');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let target: Target;
      try {
        target = await this.ensure();
      } catch {
        return { kind: 'unavailable' };
      }
      const outcome = await this.send(target, method, path, body, (options.timeoutMs ?? DEFAULT_REQUEST_MS) + GRACE_MS);
      if (outcome.kind !== 'network') return outcome;
      this.drop();
      // A POST is repeated only when the request never reached the Studio
      if (attempt === 1 || (method === 'POST' && !outcome.neverReached)) return { kind: 'unavailable' };
      if (this.child !== undefined && this.child.exitCode !== null) this.child = undefined;
    }
    return { kind: 'unavailable' };
  }

  private async send(
    target: Target,
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<ApiOutcome | { kind: 'network'; neverReached: boolean }> {
    if (!isLoopbackOrigin(target.origin)) return { kind: 'unavailable' };
    try {
      const response = await this.fetchImpl(`${target.origin}${path}`, {
        method,
        headers: { 'x-studio-token': target.token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      const text = (await response.text()).slice(0, MAX_BODY_CHARS);
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { kind: 'response', status: response.status, body: parsed };
    } catch (error) {
      const e = error as { name?: string; cause?: { code?: string } };
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'network', neverReached: NEVER_REACHED.has(e.cause?.code ?? '') };
    }
  }
}
