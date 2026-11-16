import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AdminerStack {
  url: string;
  port: number;
  /** Password of the demo database user (random for each run, never stored) */
  password: string;
  user: string;
  database: string;
  server: string;
  /** Docker Compose project name of this run */
  project: string;
  /** Runs one SQL statement as the demo user in the database container and returns its output (unaligned, no header). */
  psql(sql: string): string;
  stop(): Promise<void>;
}

interface Scripts {
  up(o: { port?: number; project?: string; password?: string }): Promise<{ port: number; project: string }>;
  down(project?: string): boolean;
}

const exampleDir = resolve(import.meta.dirname, '../../examples/adminer');
const scriptsDir = resolve(exampleDir, 'scripts');

/** Why the stack cannot run here, or null when it can. */
export function adminerSkipReason(): string | null {
  if (process.env.DAEMONIZE_DOCKER_TESTS !== '1') {
    return 'Adminer example skipped: set DAEMONIZE_DOCKER_TESTS=1 to run it (needs Docker with the images adminer and postgres:16)';
  }
  const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return 'Adminer example skipped: Docker Compose is not available';
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf-8', timeout: 20_000 });
  if (info.error || info.status !== 0) return 'Adminer example skipped: the Docker daemon is not running';
  return null;
}

/**
 * Starts examples/adminer on a free loopback port with a random database password.
 * Returns null (and logs why) when Docker is unavailable or DAEMONIZE_DOCKER_TESTS is not 1.
 * `stop()` runs `docker compose down -v`, so no container, network or volume stays behind.
 */
export async function startAdminerStack(): Promise<AdminerStack | null> {
  const reason = adminerSkipReason();
  if (reason) {
    console.warn(reason);
    return null;
  }
  const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve(scriptsDir, 'up.mjs')).href)) as Pick<Scripts, 'up'>;
  const downMod = (await import(/* @vite-ignore */ pathToFileURL(resolve(scriptsDir, 'down.mjs')).href)) as Pick<Scripts, 'down'>;
  const project = `adminer-e2e-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(12).toString('hex')}`;
  let started: { port: number } | undefined;
  try {
    started = await mod.up({ project, password });
  } catch (e) {
    downMod.down(project);
    throw e;
  }
  let stopped = false;
  return {
    url: `http://127.0.0.1:${started.port}/`,
    port: started.port,
    password,
    user: 'demo',
    database: 'demo',
    server: 'db',
    project,
    psql(sql) {
      const r = spawnSync('docker', ['compose', '-p', project, 'exec', '-T', 'db', 'psql', '-U', 'demo', '-d', 'demo', '-tA', '-c', sql], {
        cwd: exampleDir,
        env: { ...process.env, DEMO_DB_PASSWORD: password, ADMINER_PORT: String(started!.port) },
        encoding: 'utf-8',
      });
      if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
      return r.stdout.trim();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      downMod.down(project);
    },
  };
}
