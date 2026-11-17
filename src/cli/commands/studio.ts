import { spawn } from 'node:child_process';
import { startStudio, isLoopbackHost, type StudioHandle } from '../../studio/server.js';

export interface StudioCommandOptions {
  workflows: string;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  open?: boolean;
  sample?: boolean;
  graph?: string;
  /** Print to this function (default console.log); the URL line carries the token. */
  log?: (line: string) => void;
}

/** The value of `--port`: a whole number from 0 to 65535. */
export function parsePort(text: string): number {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid --port "${text}": expected a whole number from 0 to 65535`);
  return n;
}

function openInBrowser(url: string): void {
  const [command, args, shell] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], false] : process.platform === 'darwin' ? ['open', [url], false] : ['xdg-open', [url], false];
  const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, shell: shell as boolean });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Start the Studio and print the address with its token. Resolves with the running server; the caller keeps the
 * process alive (the CLI waits for Ctrl+C).
 */
export async function studio(dir: string, options: StudioCommandOptions): Promise<StudioHandle> {
  const log = options.log ?? ((line: string) => console.log(line));
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    if (options.allowRemote !== true) {
      throw new Error(`--host ${host} is not a loopback address: the Studio has no authentication besides its token. Add --allow-remote to accept that.`);
    }
    log(`Warning: the Studio listens on ${host}. Anyone who can reach it and knows the token can read your workflows and run the property tests.`);
  }
  const handle = await startStudio({
    workflowFile: options.workflows,
    outDir: dir,
    port: options.port,
    host,
    allowRemote: options.allowRemote,
    sampleData: options.sample,
    graphFile: options.graph,
  });
  log(`Studio${options.sample ? ' (sample data)' : ''}: ${handle.url}`);
  log('Open that address: the token in it is valid for this run only. Press Ctrl+C to stop.');
  if (options.sample !== true) {
    log('The Playground page starts the compiled server (mcp-server.js) on demand, with the DAEMONIZE_* variables of this shell (secrets included, never shown).');
  }
  if (options.open === true) openInBrowser(handle.url);
  return handle;
}

const SHUTDOWN_DEADLINE_MS = 4500;

/**
 * Keep the process alive until SIGINT or SIGTERM, then close the Studio (at most 4.5 s, so the exit stays within 5 s even
 * when an active recording takes longer to stop: the browser dies with its parent). With `exit` (default) the process
 * then exits with code 0; the `studio` subcommand passes `exit: false` and simply returns.
 */
export async function untilInterrupted(handle: Pick<StudioHandle, 'close'>, options: { exit?: boolean; deadlineMs?: number } = {}): Promise<void> {
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
      });
      void Promise.race([handle.close().catch(() => undefined), deadline]).then(() => {
        if (timer !== undefined) clearTimeout(timer);
        done();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  if (options.exit !== false) process.exit(0);
}
