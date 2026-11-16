import { rm } from 'node:fs/promises';

/**
 * Remove a temporary directory. On Windows a directory can stay busy for a moment after the
 * process that used it exited (EBUSY, EPERM), so removal is retried. Close clients and wait
 * for child processes (`closeClient`) before calling this.
 */
export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close an MCP client and wait for the server process it started to exit, so that the
 * directory that process used as its working directory is no longer locked.
 */
export async function closeClient(
  client: { close(): Promise<void> } | undefined,
  transport: { pid: number | null } | undefined,
  timeoutMs = 10000,
): Promise<void> {
  const pid = transport?.pid ?? null;
  await client?.close();
  if (pid === null) return;
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
