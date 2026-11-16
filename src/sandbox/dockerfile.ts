/**
 * The Dockerfile of the sandbox image, from a target type and the `sandbox` block of a Workflow set.
 *
 * Supported base images (`sandbox.image`): the Debian and Ubuntu families (apt) and Alpine (apk).
 * The base image does not need Node: the runtime (Node 20 and the node_modules, with node-pty compiled)
 * is built in a first stage and copied in. The glibc runtime is built on node:20-bookworm, so a Debian
 * base older than bookworm (glibc 2.36) may not start; an image whose name contains "alpine" gets the
 * musl runtime. Web targets need a Playwright image (browsers and fonts), so they only take
 * `mcr.microsoft.com/playwright` images.
 *
 * Everything that reaches the Dockerfile is validated here: the file is text, and a package name, an
 * image reference or a user name with a newline or a shell metacharacter would add instructions to it.
 */
import type { SandboxSpec } from '../types.js';

export const MAX_INSTALL_COMMANDS = 20;
export const MAX_INSTALL_LENGTH = 500;
export const MAX_PACKAGES = 100;

export const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.+_:-]*$/;
const USER_NAME = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/;
const WORKDIR = /^\/[A-Za-z0-9._/@+-]*$/;
// host:container[:ro]. The container path is absolute, with no ':' and no control characters.
const MOUNT = /^[^\0\r\n]+:\/[^:\0\r\n]*(?::ro)?$/;

// Image reference grammar of the OCI distribution spec: [domain/]path[:tag][@digest]
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST = '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}';
const IMAGE_REFERENCE = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*(?::${TAG})?(?:@${DIGEST})?$`);

export type TargetType = 'web' | 'tui';

/** The network of a replay container when the set does not say: a terminal program needs none, a browser needs one. */
export function defaultNetwork(targetType: TargetType): 'none' | 'bridge' {
  return targetType === 'tui' ? 'none' : 'bridge';
}

/** Throws a message naming the first invalid field. */
export function validateSandboxSpec(spec: SandboxSpec | undefined, targetType: TargetType): void {
  if (spec === undefined) return;
  if (spec.image !== undefined) {
    if (typeof spec.image !== 'string' || spec.image.length > 255 || !IMAGE_REFERENCE.test(spec.image)) {
      throw new Error(`sandbox.image "${String(spec.image)}" is not a valid image reference (expected [registry/]name[:tag][@digest], e.g. debian:bookworm-slim)`);
    }
    if (targetType === 'web' && !/(^|\/)playwright(:|@|$)/.test(spec.image)) {
      throw new Error(`sandbox.image "${spec.image}": a web target needs a Playwright image (mcr.microsoft.com/playwright:...)`);
    }
  }
  const packages = spec.packages ?? [];
  if (packages.length > MAX_PACKAGES) throw new Error(`sandbox.packages: at most ${MAX_PACKAGES} packages`);
  for (const name of packages) {
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
      throw new Error(`sandbox.packages: "${String(name)}" is not a valid package name (letters, digits and . + _ : -, starting with a letter or digit)`);
    }
  }
  const install = spec.install ?? [];
  if (install.length > MAX_INSTALL_COMMANDS) throw new Error(`sandbox.install: at most ${MAX_INSTALL_COMMANDS} commands`);
  for (const command of install) {
    if (typeof command !== 'string' || command.trim() === '') throw new Error('sandbox.install: a command is empty');
    if (/[\0\r\n]/.test(command)) throw new Error('sandbox.install: a command contains a newline or a NUL character; use one entry per command');
    if (command.length > MAX_INSTALL_LENGTH) throw new Error(`sandbox.install: a command is longer than ${MAX_INSTALL_LENGTH} characters`);
  }
  if (spec.network !== undefined && spec.network !== 'none' && spec.network !== 'bridge') {
    throw new Error(`sandbox.network "${String(spec.network)}": use none or bridge`);
  }
  if (spec.user !== undefined) {
    if (typeof spec.user !== 'string' || !USER_NAME.test(spec.user)) throw new Error(`sandbox.user "${String(spec.user)}" is not a valid user name or id`);
    if (spec.user === 'root' || /^0+$/.test(spec.user)) throw new Error('sandbox.user: the program must not run as root');
  }
  if (spec.workdir !== undefined && (typeof spec.workdir !== 'string' || !WORKDIR.test(spec.workdir))) {
    throw new Error(`sandbox.workdir "${String(spec.workdir)}" must be an absolute path in the container`);
  }
  for (const mount of spec.mounts ?? []) {
    if (typeof mount !== 'string' || !MOUNT.test(mount)) {
      throw new Error(`sandbox.mounts: "${String(mount)}" is not host:container[:ro] with an absolute container path`);
    }
  }
}

/** The set's block with the overrides applied: scalars replace, lists add (without duplicates). */
export function mergeSandboxSpec(base: SandboxSpec | undefined, overrides: SandboxSpec | undefined): SandboxSpec | undefined {
  if (base === undefined && overrides === undefined) return undefined;
  const union = (a?: string[], b?: string[]): string[] | undefined => {
    const all = [...(a ?? []), ...(b ?? [])];
    return all.length === 0 ? undefined : [...new Set(all)];
  };
  const merged: SandboxSpec = { ...base };
  for (const key of ['image', 'network', 'user', 'workdir'] as const) {
    if (overrides?.[key] !== undefined) (merged as Record<string, unknown>)[key] = overrides[key];
  }
  for (const key of ['packages', 'install', 'mounts'] as const) {
    const list = union(base?.[key], overrides?.[key]);
    if (list !== undefined) merged[key] = list;
  }
  return merged;
}

export interface DockerfileInput {
  targetType: TargetType;
  /** Files and folders of the output directory copied into the image, in order (e.g. `replay.js`, `heal`). */
  copy: string[];
  sandbox?: SandboxSpec;
  playwrightVersion: string;
}

/** `RUN` that installs packages with whichever package manager the image has. */
function packagesRun(packages: string[], family: 'apt' | 'apk' | 'detect'): string {
  const list = packages.join(' ');
  const apt = `apt-get update && apt-get install -y --no-install-recommends ${list} && rm -rf /var/lib/apt/lists/*`;
  const apk = `apk add --no-cache ${list}`;
  if (family === 'apt') return `RUN ${apt}`;
  if (family === 'apk') return `RUN ${apk}`;
  return `RUN if command -v apt-get >/dev/null 2>&1; then ${apt}; elif command -v apk >/dev/null 2>&1; then ${apk}; else echo "no apt-get or apk in the base image: packages cannot be installed" >&2; exit 1; fi`;
}

export function renderDockerfile(input: DockerfileInput): string {
  validateSandboxSpec(input.sandbox, input.targetType);
  const terminal = input.targetType === 'tui';
  const spec = input.sandbox ?? {};
  const packages = spec.packages ?? [];
  const install = spec.install ?? [];
  const custom = spec.image !== undefined;
  const alpine = custom && /alpine/i.test(spec.image as string);
  const family = alpine ? 'apk' : custom && terminal ? 'detect' : 'apt';
  const user = spec.user ?? (terminal ? 'node' : 'pwuser');
  // A user that the base image may not have is created; the default users exist in the default images
  const createUser = (custom && terminal) || (spec.user !== undefined && !/^[0-9]+$/.test(user) && user !== 'node' && user !== 'pwuser');

  const lines: string[] = [
    '# Sandbox of the generated server: each call is replayed in a throw-away container made from this image.',
    '# Build it from the output directory: daemonize sandbox build',
  ];

  const copies = input.copy.map((file) => `COPY ${file} ./${file}`);
  const installRuns = install.map((command) => `RUN ${JSON.stringify(['/bin/sh', '-c', command])}`);
  const packageRuns = packages.length > 0 ? [packagesRun(packages, family)] : [];
  const userRuns = !createUser || /^[0-9]+$/.test(user)
    ? []
    : [`RUN id -u ${user} >/dev/null 2>&1 || if command -v useradd >/dev/null 2>&1; then useradd --create-home --uid 10001 ${user}; else adduser -D -u 10001 ${user}; fi`];
  const tail = [
    `USER ${user}`,
    // Absolute, so that a program started in another working directory still finds the replayer
    'ENTRYPOINT ["node", "/sandbox/replay.js", "--container"]',
    '',
  ];

  if (!custom) {
    lines.push(
      terminal ? 'FROM node:20' : `FROM mcr.microsoft.com/playwright:v${input.playwrightVersion}-noble`,
      ...packageRuns,
      ...installRuns,
      ...userRuns,
      'WORKDIR /sandbox',
      'ENV DAEMONIZE_IN_CONTAINER=1',
      ...(terminal ? [] : ['ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1']),
      'COPY sandbox/package.json ./package.json',
      'RUN npm install --omit=dev',
      ...copies,
      ...tail
    );
    return lines.join('\n');
  }

  if (!terminal) {
    // A Playwright image of the user's choice: same layout as the default one
    lines.push(
      `FROM ${spec.image}`,
      ...packageRuns,
      ...installRuns,
      ...userRuns,
      'WORKDIR /sandbox',
      'ENV DAEMONIZE_IN_CONTAINER=1',
      'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
      'COPY sandbox/package.json ./package.json',
      'RUN npm install --omit=dev',
      ...copies,
      ...tail
    );
    return lines.join('\n');
  }

  // A terminal program in a base image of the user's choice: the runtime comes from a build stage
  lines.push(
    `FROM ${alpine ? 'node:20-alpine' : 'node:20-bookworm'} AS daemonize-runtime`,
    ...(alpine ? ['RUN apk add --no-cache build-base python3'] : []),
    'WORKDIR /sandbox',
    'COPY sandbox/package.json ./package.json',
    'RUN npm install --omit=dev',
    '',
    `FROM ${spec.image}`,
    'COPY --from=daemonize-runtime /usr/local/bin/node /usr/local/bin/node',
    ...(alpine ? ['RUN apk add --no-cache libstdc++'] : []),
    ...packageRuns,
    ...installRuns,
    ...userRuns,
    'WORKDIR /sandbox',
    'ENV DAEMONIZE_IN_CONTAINER=1',
    'COPY --from=daemonize-runtime /sandbox/node_modules ./node_modules',
    'COPY sandbox/package.json ./package.json',
    ...copies,
    ...tail
  );
  return lines.join('\n');
}
