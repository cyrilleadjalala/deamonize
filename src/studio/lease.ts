/**
 * The Studio_Lease: a small file in the App_Data_Dir that lets the Studio_MCP find a Studio that already runs for a
 * workspace folder. It holds the address, the pid and the AGENT token (never the owner token, which stays in memory).
 *
 * - `<dataDir>/leases/lease-<16 hex of sha256(workspace key)>.json`, folder 0700, file 0600, written atomically;
 * - written only for a loopback listener (the caller never writes one in sample mode);
 * - `readLease` is total: a complete lease or `undefined`, never an exception. A lease is used only when its schema is
 *   complete, its origin is loopback, its process is alive and `GET /api/health` answers within 1.5 s;
 * - a stale file is removed only when its content is still the one that was judged stale.
 */
import { createHash } from 'node:crypto';
import { realpathSync, unlinkSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StudioLease {
  v: 1;
  origin: string;
  agentToken: string;
  pid: number;
  workspace: string;
  startedAt: string;
}

export interface LeaseDeps {
  isAlive(pid: number): boolean;
  health(lease: StudioLease): Promise<boolean>;
}

const LEASE_DIR = 'leases';
const HEALTH_TIMEOUT_MS = 1500;
const MAX_LEASE_BYTES = 8 * 1024;
const LOOPBACK_ORIGIN = /^http:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\]):(\d{1,5})$/i;

/** True for `http://127.x.x.x:N`, `http://localhost:N` and `http://[::1]:N`, with a port from 1 to 65535. */
export function isLoopbackOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  const match = LOOPBACK_ORIGIN.exec(origin);
  if (match === null) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 && (!/^127/.test(match[1]) || match[1].split('.').every((part) => Number(part) <= 255));
}

/** The real path of the workspace, with case folded on Windows and macOS. */
export function workspaceKey(workspace: string): string {
  let real: string;
  try {
    real = realpathSync(workspace);
  } catch {
    real = resolve(workspace);
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

export function leasePath(dataDir: string, workspace: string): string {
  const hash = createHash('sha256').update(workspaceKey(workspace)).digest('hex').slice(0, 16);
  return join(dataDir, LEASE_DIR, `lease-${hash}.json`);
}

const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The lease in the text, or undefined for anything that is not a complete lease. */
export function parseLease(text: string): StudioLease | undefined {
  if (text.length > MAX_LEASE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || !isLoopbackOrigin(v.origin)) return undefined;
  if (typeof v.agentToken !== 'string' || v.agentToken.length < 8 || v.agentToken.length > 256 || /[\s\u0000-\u001f]/.test(v.agentToken)) return undefined;
  if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid < 1) return undefined;
  if (typeof v.workspace !== 'string' || v.workspace === '' || v.workspace.length > 4096) return undefined;
  if (typeof v.startedAt !== 'string' || v.startedAt === '' || v.startedAt.length > 64) return undefined;
  return { v: 1, origin: v.origin, agentToken: v.agentToken, pid: v.pid, workspace: v.workspace, startedAt: v.startedAt };
}

export interface WrittenLease {
  /** Removes the file, but only when it still holds what this call wrote. Never throws. */
  remove(): Promise<void>;
  /** The same, synchronously, for the `exit` event. Never throws. */
  removeSync(): void;
  path: string;
}

/** Writes the lease (temp file, then rename). Throws for a non-loopback origin or an unusable folder. */
export async function writeLease(dataDir: string, lease: StudioLease): Promise<WrittenLease> {
  if (!isLoopbackOrigin(lease.origin)) throw new Error('A lease is written only for a loopback address.');
  const path = leasePath(dataDir, lease.workspace);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const text = `${JSON.stringify({ v: 1, origin: lease.origin, agentToken: lease.agentToken, pid: lease.pid, workspace: lease.workspace, startedAt: lease.startedAt })}\n`;
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  const mine = contentHash(text);
  return {
    path,
    remove: async () => {
      try {
        if (contentHash(await readFile(path, 'utf-8')) === mine) await unlink(path);
      } catch {
        // Already gone, or replaced by a newer Studio: nothing to do
      }
    },
    removeSync: () => {
      try {
        if (contentHash(readFileSync(path, 'utf-8')) === mine) unlinkSync(path);
      } catch {
        // Already gone, or replaced by a newer Studio: nothing to do
      }
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function healthy(lease: StudioLease, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${lease.origin}/api/health`, {
      headers: { 'x-studio-token': lease.agentToken },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export const defaultLeaseDeps: LeaseDeps = { isAlive: pidAlive, health: (lease) => healthy(lease) };

/**
 * The live lease of a workspace, or undefined. Never throws. A well-formed lease whose process is gone, or whose
 * Studio does not answer, is removed (only when its content is unchanged since it was read).
 */
export async function readLease(dataDir: string, workspace: string, deps: LeaseDeps = defaultLeaseDeps): Promise<StudioLease | undefined> {
  try {
    const path = leasePath(dataDir, workspace);
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch {
      return undefined;
    }
    const lease = parseLease(text);
    if (lease === undefined) return undefined;
    if (workspaceKey(lease.workspace) !== workspaceKey(workspace)) return undefined;
    let live = false;
    try {
      live = deps.isAlive(lease.pid) && (await deps.health(lease));
    } catch {
      live = false;
    }
    if (live) return lease;
    await removeIfUnchanged(path, text);
    return undefined;
  } catch {
    return undefined;
  }
}

async function removeIfUnchanged(path: string, judged: string): Promise<void> {
  try {
    if (contentHash(await readFile(path, 'utf-8')) === contentHash(judged)) await unlink(path);
  } catch {
    // Gone already, or replaced: leave it
  }
}
