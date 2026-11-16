import { spawn, spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DOCKER = process.env.DAEMONIZE_DOCKER ?? 'docker';

/** The tag of the sandbox image of a compiled project, as written by the compiler. */
export async function sandboxImageTag(dir: string): Promise<string> {
  try {
    const { tag } = JSON.parse(await readFile(join(dir, 'sandbox', 'image.json'), 'utf-8')) as { tag: string };
    return tag;
  } catch {
    throw new Error(`${join(dir, 'sandbox', 'image.json')} not found. Run "daemonize compile" first.`);
  }
}

/**
 * Build the image each call is replayed in. The output directory is the build
 * context. This downloads the base image and installs the packages inside it,
 * so it only happens when the user asks for it.
 */
export async function buildSandboxImage(dir: string): Promise<string> {
  const tag = await sandboxImageTag(dir);
  await access(join(dir, 'replay.js')).catch(() => {
    throw new Error(`${join(dir, 'replay.js')} not found. Run "daemonize compile" first.`);
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(DOCKER, ['build', '-f', join('sandbox', 'Dockerfile'), '-t', tag, '.'], {
      cwd: dir,
      stdio: 'inherit',
    });
    child.on('error', (err) => reject(new Error(`Cannot run ${DOCKER}: ${err.message}. Is Docker installed and running?`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker build failed (exit code ${code})`))));
  });
  return tag;
}

/** Fail with an explanation, instead of at the first call, when the sandbox cannot be used. */
export async function assertSandboxReady(dir: string): Promise<string> {
  const tag = await sandboxImageTag(dir);

  const daemon = spawnSync(DOCKER, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf-8' });
  if (daemon.error || daemon.status !== 0) {
    throw new Error('The Docker daemon is not reachable. Start Docker, or serve without --sandbox.');
  }

  const image = spawnSync(DOCKER, ['image', 'inspect', tag], { encoding: 'utf-8' });
  if (image.status !== 0) {
    throw new Error(`The sandbox image "${tag}" does not exist. Run "daemonize sandbox build ${dir}" first.`);
  }
  return tag;
}
