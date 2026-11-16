// Starts the stack on a free loopback port. Prints the port. Usage: node up.mjs
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { waitReady } from './wait-ready.mjs';

export const PROJECT = 'daemonize-adminer-example';
export const exampleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export function compose(args, env) {
  return spawnSync('docker', ['compose', '-p', env.COMPOSE_PROJECT_NAME ?? PROJECT, ...args], {
    cwd: exampleDir,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

/** Starts the stack. `project` makes parallel runs independent. Returns { port, project }. */
export async function up({ port, project = PROJECT, password } = {}) {
  port ??= await freePort();
  const env = { ADMINER_PORT: String(port), COMPOSE_PROJECT_NAME: project };
  if (password) env.DEMO_DB_PASSWORD = password;
  const r = compose(['up', '-d', '--wait', '--pull', 'missing'], env);
  if (r.status !== 0) {
    compose(['down', '-v', '--remove-orphans'], env);
    throw new Error(`docker compose up failed: ${r.stderr || r.stdout}`);
  }
  await waitReady(port);
  return { port, project };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  up().then(
    ({ port }) => console.log(`Adminer: http://127.0.0.1:${port}/`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
