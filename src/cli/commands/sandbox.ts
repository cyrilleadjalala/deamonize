import { spawn, spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxSpec } from '../../types.js';
import { mergeSandboxSpec, renderDockerfile } from '../../sandbox/dockerfile.js';
import { PLAYWRIGHT_VERSION } from '../../compiler/mcp-generator.js';

const DOCKER = process.env.DAEMONIZE_DOCKER ?? 'docker';

/** What `sandbox/image.json` records of the build: the tag, and what the Dockerfile is generated from. */
export interface SandboxImageInfo {
  tag: string;
  targetType?: 'web' | 'tui';
  copy?: string[];
  sandbox?: SandboxSpec;
}

export async function readSandboxImageInfo(dir: string): Promise<SandboxImageInfo> {
  try {
    return JSON.parse(await readFile(join(dir, 'sandbox', 'image.json'), 'utf-8')) as SandboxImageInfo;
  } catch {
    throw new Error(`${join(dir, 'sandbox', 'image.json')} not found. Run "daemonize compile" first.`);
  }
}

/** The tag of the sandbox image of a compiled project, as written by the compiler (or `sandbox build --tag`). */
export async function sandboxImageTag(dir: string): Promise<string> {
  return (await readSandboxImageInfo(dir)).tag;
}

export interface SandboxBuildOptions extends SandboxSpec {
  /** Name of the image (default: the one the compiler chose; `serve --sandbox docker` then uses it). */
  tag?: string;
  noCache?: boolean;
  /** Return the Dockerfile without building anything and without touching the output directory. */
  print?: boolean;
  /** Where messages go (default: stdout). */
  log?: (message: string) => void;
}

const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

/**
 * Build the image each call is replayed in. The output directory is the build
 * context. This downloads the base image and installs the packages inside it,
 * so it only happens when the user asks for it. The options are added to the
 * `sandbox` block the project was compiled with and the Dockerfile is generated again.
 * With `print`, only returns the Dockerfile.
 */
export async function buildSandboxImage(dir: string, options: SandboxBuildOptions = {}): Promise<string> {
  const info = await readSandboxImageInfo(dir);
  const { tag: tagOption, noCache, print, log = console.log, ...overrides } = options;
  const tag = tagOption ?? info.tag;
  if (!TAG_PATTERN.test(tag)) throw new Error(`"${tag}" is not a valid image name`);

  const hasOverrides = Object.values(overrides).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
  let dockerfile: string | undefined;
  let spec = info.sandbox;
  if (hasOverrides || print) {
    if (info.targetType === undefined || info.copy === undefined) {
      throw new Error(`${join(dir, 'sandbox', 'image.json')} comes from an older version: run "daemonize compile" again.`);
    }
    spec = mergeSandboxSpec(info.sandbox, overrides);
    dockerfile = renderDockerfile({ targetType: info.targetType, copy: info.copy, sandbox: spec, playwrightVersion: PLAYWRIGHT_VERSION });
  }
  if (print) return dockerfile as string;

  if (dockerfile !== undefined) {
    await writeFile(join(dir, 'sandbox', 'Dockerfile'), dockerfile);
  }
  if (dockerfile !== undefined || tag !== info.tag) {
    await writeFile(join(dir, 'sandbox', 'image.json'), JSON.stringify({ ...info, tag, ...(spec === undefined ? {} : { sandbox: spec }) }, null, 2));
  }
  await access(join(dir, 'replay.js')).catch(() => {
    throw new Error(`${join(dir, 'replay.js')} not found. Run "daemonize compile" first.`);
  });

  // The commands of the user run as root in the image: show them before they run
  for (const command of spec?.install ?? []) log(`sandbox install command: ${command}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(DOCKER, ['build', ...(noCache ? ['--no-cache'] : []), '-f', join('sandbox', 'Dockerfile'), '-t', tag, '.'], {
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
