import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSandboxReady } from './sandbox.js';

export interface ServeOptions {
  /** Replay every call in a throw-away Docker container instead of on this machine. */
  sandbox?: 'docker';
  memoryMb?: number;           // default 512
  cpus?: number;               // default 1
  /** Folders of the host the container may see: `host:container[:ro]`. Nothing else is shared. */
  mounts?: string[];
  /** What to start in the container when it differs from what was recorded (a terminal program). */
  command?: string[];
  /** Where the browser starts in the container when the recorded address is not reachable from it. */
  url?: string;
  /** Timeout of a whole call (DAEMONIZE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Timeout of a step (DAEMONIZE_STEP_TIMEOUT_MS). */
  stepTimeoutMs?: number;
}

/**
 * Run the compiled MCP server of an output directory over stdio. Resolves with
 * the server's exit code. Everything this command prints goes to stderr, since
 * stdout carries the MCP protocol.
 */
export async function serve(dir: string, options: ServeOptions = {}): Promise<number> {
  const server = join(dir, 'mcp-server.js');
  try {
    await access(server);
  } catch {
    throw new Error(`${server} not found. Run "daemonize compile" first.`);
  }

  try {
    await access(join(dir, 'node_modules'));
  } catch {
    console.error(`No node_modules in ${dir}. If the server fails to start, run "npm install" there first.`);
  }

  // The timeouts reach the server (and, in Docker mode, the container) through the environment
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.timeoutMs !== undefined) env.DAEMONIZE_TIMEOUT_MS = String(options.timeoutMs);
  if (options.stepTimeoutMs !== undefined) env.DAEMONIZE_STEP_TIMEOUT_MS = String(options.stepTimeoutMs);
  if (options.sandbox === 'docker') {
    const tag = await assertSandboxReady(dir);
    console.error(`Replaying every call in a Docker container of the image "${tag}".`);
    env.DAEMONIZE_SANDBOX = 'docker';
    if (options.memoryMb !== undefined) env.DAEMONIZE_SANDBOX_MEMORY_MB = String(options.memoryMb);
    if (options.cpus !== undefined) env.DAEMONIZE_SANDBOX_CPUS = String(options.cpus);
    if (options.mounts !== undefined) env.DAEMONIZE_SANDBOX_MOUNTS = JSON.stringify(options.mounts);
    if (options.command !== undefined) env.DAEMONIZE_SANDBOX_COMMAND = JSON.stringify(options.command);
    if (options.url !== undefined) env.DAEMONIZE_SANDBOX_URL = options.url;
  }

  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [server], { cwd: dir, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
