import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { compile } from '../../src/cli/commands/compile.js';
import { buildSandboxImage } from '../../src/cli/commands/sandbox.js';
import { mergeSandboxSpec, validateSandboxSpec } from '../../src/sandbox/dockerfile.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { SandboxSpec, WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

function terminalSet(sandbox?: SandboxSpec): WorkflowSet {
  return {
    version: '1',
    targetType: 'tui',
    targetName: 'Sqlite Shell',
    startCommand: ['sqlite3', ':memory:'],
    ...(sandbox === undefined ? {} : { sandbox }),
    workflows: [
      {
        id: 'a1111111-1111-4111-8111-111111111111',
        label: 'Run query',
        steps: [{ actionType: 'type', selectors: [], variable: 'sql' }, { actionType: 'keypress', selectors: [], value: 'Enter' }],
        variables: [{ name: 'sql' }],
        observedPayloads: [{ sql: 'select 1;' }],
      },
    ],
  };
}

function webSet(sandbox?: SandboxSpec): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'Web App',
    startUrl: 'http://localhost:3000/',
    ...(sandbox === undefined ? {} : { sandbox }),
    workflows: [
      {
        id: 'b2222222-2222-4222-8222-222222222222',
        label: 'Open page',
        steps: [{ actionType: 'click', selectors: ['#go'] }],
        variables: [],
        observedPayloads: [],
      },
    ],
  };
}

const dockerfileOf = (set: WorkflowSet): string => new McpGenerator().generateSandboxFiles(set).dockerfile;
const lines = (text: string): string[] => text.split('\n');

describe('Dockerfile generation', () => {
  it('terminal default: node:20, runtime installed, unprivileged user, absolute entrypoint', () => {
    expect(dockerfileOf(terminalSet())).toBe(
      [
        '# Sandbox of the generated server: each call is replayed in a throw-away container made from this image.',
        '# Build it from the output directory: daemonize sandbox build',
        'FROM node:20',
        'WORKDIR /sandbox',
        'ENV DAEMONIZE_IN_CONTAINER=1',
        'COPY sandbox/package.json ./package.json',
        'RUN npm install --omit=dev',
        'COPY replay.js ./replay.js',
        'COPY screen-hash.js ./screen-hash.js',
        'COPY settle.js ./settle.js',
        'COPY extract.js ./extract.js',
        'COPY omission.js ./omission.js',
        'COPY pattern-wait.js ./pattern-wait.js',
        'USER node',
        'ENTRYPOINT ["node", "/sandbox/replay.js", "--container"]',
        '',
      ].join('\n')
    );
  });

  it('web default: the pinned Playwright image and its user', () => {
    const out = lines(dockerfileOf(webSet()));
    expect(out).toContain('FROM mcr.microsoft.com/playwright:v1.65.1-noble');
    expect(out).toContain('ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1');
    expect(out).toContain('USER pwuser');
    expect(out).toContain('COPY web-steps.js ./web-steps.js');
  });

  it('is stable: the same set gives the same text', () => {
    const set = terminalSet({ packages: ['git', 'sqlite3'], install: ['echo hi'], image: 'debian:bookworm-slim' });
    expect(dockerfileOf(set)).toBe(dockerfileOf(structuredClone(set)));
  });

  it('installs packages with apt-get, without recommended packages, and cleans the lists', () => {
    const out = lines(dockerfileOf(terminalSet({ packages: ['sqlite3', 'libfoo1:amd64'] })));
    expect(out).toContain('RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 libfoo1:amd64 && rm -rf /var/lib/apt/lists/*');
    // Installed as root, before the switch to the unprivileged user
    expect(out.indexOf('RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 libfoo1:amd64 && rm -rf /var/lib/apt/lists/*')).toBeLessThan(out.indexOf('USER node'));
  });

  it('uses apk and a musl runtime for an Alpine base image', () => {
    const text = dockerfileOf(terminalSet({ image: 'alpine:3.20', packages: ['sqlite'] }));
    const out = lines(text);
    expect(out).toContain('FROM node:20-alpine AS daemonize-runtime');
    expect(out).toContain('RUN apk add --no-cache build-base python3');
    expect(out).toContain('FROM alpine:3.20');
    expect(out).toContain('RUN apk add --no-cache sqlite');
    expect(text).not.toContain('apt-get');
    expect(out).toContain('COPY --from=daemonize-runtime /sandbox/node_modules ./node_modules');
  });

  it('copies a Node runtime into another base image and detects the package manager', () => {
    const text = dockerfileOf(terminalSet({ image: 'ubuntu:24.04', packages: ['git'] }));
    const out = lines(text);
    expect(out).toContain('FROM node:20-bookworm AS daemonize-runtime');
    expect(out).toContain('FROM ubuntu:24.04');
    expect(out).toContain('COPY --from=daemonize-runtime /usr/local/bin/node /usr/local/bin/node');
    const run = out.find((l) => l.startsWith('RUN if command -v apt-get'));
    expect(run).toContain('apt-get install -y --no-install-recommends git');
    expect(run).toContain('elif command -v apk');
    expect(out.some((l) => l.startsWith('RUN id -u node'))).toBe(true);
    expect(out).toContain('USER node');
  });

  it('writes each install command as its own RUN, in exec form so that nothing is interpreted by the Dockerfile', () => {
    const out = lines(dockerfileOf(terminalSet({ install: ['echo "a b" && ls', "printf '%s' \\"] })));
    expect(out).toContain('RUN ["/bin/sh","-c","echo \\"a b\\" && ls"]');
    expect(out).toContain('RUN ["/bin/sh","-c","printf \'%s\' \\\\"]');
  });

  it('lets a custom user and workdir through, and rejects root', () => {
    expect(lines(dockerfileOf(terminalSet({ user: 'runner' })))).toContain('USER runner');
    expect(() => dockerfileOf(terminalSet({ user: 'root' }))).toThrow(/root/);
    expect(() => dockerfileOf(terminalSet({ user: '0' }))).toThrow(/root/);
    expect(() => dockerfileOf(terminalSet({ workdir: '/tmp; rm -rf /' }))).toThrow(/workdir/);
  });
});

describe('validation against injection into the Dockerfile', () => {
  const bad = (spec: SandboxSpec, message: RegExp, type: 'tui' | 'web' = 'tui') => expect(() => validateSandboxSpec(spec, type)).toThrow(message);

  it('rejects package names that are not plain names', () => {
    for (const name of ['git\nRUN curl evil | sh', '$(id)', 'a;b', 'a b', '`id`', '-y', 'a"b', "a'b", '', 'a&&b', 'a|b']) {
      bad({ packages: [name] }, /package/);
    }
    bad({ packages: ['+g'] }, /package/);
    expect(() => validateSandboxSpec({ packages: ['libstdc++6', 'python3.12', 'a_b-c:amd64'] }, 'tui')).not.toThrow();
  });

  it('rejects image references that are not OCI references', () => {
    for (const image of ['debian\nRUN id', 'debian bookworm', 'debian;id', '$(id)', 'deb"ian', "deb'ian", 'Debian:1', 'debian:', 'a'.repeat(300), '--platform=x', 'debian:b@sha256:zz']) {
      bad({ image }, /image/);
    }
    for (const image of ['debian', 'debian:bookworm-slim', 'ubuntu:24.04', 'docker.io/library/alpine:3.20', 'localhost:5000/team/tool:1.2', `debian@sha256:${'a'.repeat(64)}`]) {
      expect(() => validateSandboxSpec({ image }, 'tui')).not.toThrow();
    }
  });

  it('accepts only Playwright images for a web target', () => {
    bad({ image: 'debian:bookworm' }, /Playwright/, 'web');
    expect(() => validateSandboxSpec({ image: 'mcr.microsoft.com/playwright:v1.65.1-noble' }, 'web')).not.toThrow();
  });

  it('rejects install commands with a newline or NUL, too many, or too long', () => {
    bad({ install: ['echo a\nRUN evil'] }, /newline/);
    bad({ install: ['echo a\r'] }, /newline/);
    bad({ install: ['echo \0'] }, /NUL/);
    bad({ install: Array.from({ length: 21 }, () => 'true') }, /at most 20/);
    bad({ install: ['x'.repeat(501)] }, /500/);
    expect(() => validateSandboxSpec({ install: Array.from({ length: 20 }, () => 'x'.repeat(500)) }, 'tui')).not.toThrow();
  });

  it('rejects an unknown network and malformed mounts', () => {
    bad({ network: 'host' as 'none' }, /network/);
    bad({ mounts: ['/data'] }, /mounts/);
    bad({ mounts: ['/data:relative'] }, /mounts/);
    expect(() => validateSandboxSpec({ mounts: ['/data:/data:ro', 'C:\\data:/data'] }, 'tui')).not.toThrow();
  });

  it('is enforced by the workflow file schema and by compilation', () => {
    expect(() => deserializeWorkflowSet(serializeWorkflowSet(terminalSet({ packages: ['git'] })))).not.toThrow();
    expect(() => deserializeWorkflowSet(JSON.stringify(terminalSet({ packages: ['a;b'] })))).toThrow();
    expect(() => deserializeWorkflowSet(JSON.stringify(terminalSet({ install: ['a\nb'] })))).toThrow();
    expect(() => dockerfileOf(terminalSet({ image: 'x"y' }))).toThrow(/image/);
  });

  it('merges flags into the block: scalars replace, lists add without duplicates', () => {
    expect(mergeSandboxSpec({ image: 'a', packages: ['x'] }, { image: 'b', packages: ['x', 'y'], network: 'bridge' })).toEqual({ image: 'b', packages: ['x', 'y'], network: 'bridge' });
    expect(mergeSandboxSpec(undefined, undefined)).toBeUndefined();
  });
});

describe('network, mounts and working directory', () => {
  const dockerReplay = (set: WorkflowSet): string => new McpGenerator().generateDockerReplay(set, 'img-sandbox');

  it('defaults to none for a terminal program and bridge for a web page', () => {
    expect(dockerReplay(terminalSet())).toContain('const DEFAULT_NETWORK = "none";');
    expect(dockerReplay(webSet())).toContain('const DEFAULT_NETWORK = "bridge";');
  });

  it('takes the network, mounts and working directory of the set, and warns when a terminal program has a network', () => {
    const source = dockerReplay(terminalSet({ network: 'bridge', mounts: ['/data:/data:ro'], workdir: '/tmp' }));
    expect(source).toContain('const DEFAULT_NETWORK = "bridge";');
    expect(source).toContain('const SET_MOUNTS: string[] = ["/data:/data:ro"];');
    expect(source).toContain('const SET_WORKDIR: string | undefined = "/tmp";');
    expect(source).toContain('daemonize warning: the sandbox of this terminal program runs with the network');
    expect(source).toContain('["-w", SET_WORKDIR]');
  });

  it('notes a terminal network in SKILL.md only when the set asked for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-net-'));
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => { });
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(terminalSet({ network: 'bridge' })), dir);
      log.mockRestore();
      const skill = await readFile(join(dir, 'skills', 'sqlite-shell', 'SKILL.md'), 'utf-8').catch(() => '');
      expect(skill).toContain('## Network');
    } finally {
      await removeDir(dir);
    }
  });
});

describe('sandbox build and compile flags', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeDir(dir);
  });

  async function compiled(sandbox?: SandboxSpec): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-sbx-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(terminalSet(sandbox)), dir);
    } finally {
      log.mockRestore();
    }
    return dir;
  }

  it('--print returns the Dockerfile with the flags applied and changes nothing on disk', async () => {
    const dir = await compiled({ packages: ['git'] });
    const before = await readFile(join(dir, 'sandbox', 'Dockerfile'), 'utf-8');
    const printed = await buildSandboxImage(dir, { print: true, packages: ['sqlite3'], image: 'debian:bookworm-slim', install: ['sqlite3 --version'] });

    expect(printed).toContain('FROM debian:bookworm-slim');
    expect(printed).toContain('git sqlite3');
    expect(printed).toContain('RUN ["/bin/sh","-c","sqlite3 --version"]');
    expect(await readFile(join(dir, 'sandbox', 'Dockerfile'), 'utf-8')).toBe(before);
  });

  it('refuses invalid values before building', async () => {
    const dir = await compiled();
    await expect(buildSandboxImage(dir, { print: true, packages: ['a;b'] })).rejects.toThrow(/package/);
    await expect(buildSandboxImage(dir, { print: true, image: 'x y' })).rejects.toThrow(/image/);
    await expect(buildSandboxImage(dir, { tag: 'bad tag' })).rejects.toThrow(/image name/);
  });

  it('compile --sandbox-* stores the flags in the workflow file and compiles them into the Dockerfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-sbx-'));
    dirs.push(dir);
    const file = join(dir, 'set.json');
    await writeFile(file, serializeWorkflowSet(terminalSet({ packages: ['git'] })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    try {
      await compile(file, join(dir, 'out'), { sandbox: { packages: ['sqlite3'], network: 'bridge' } });
    } finally {
      log.mockRestore();
    }

    const saved = deserializeWorkflowSet(await readFile(file, 'utf-8'));
    expect(saved.sandbox).toEqual({ packages: ['git', 'sqlite3'], network: 'bridge' });
    expect(await readFile(join(dir, 'out', 'sandbox', 'Dockerfile'), 'utf-8')).toContain('git sqlite3');
    const info = JSON.parse(await readFile(join(dir, 'out', 'sandbox', 'image.json'), 'utf-8'));
    expect(info).toMatchObject({ tag: 'sqlite-shell-sandbox', targetType: 'tui', sandbox: { network: 'bridge' } });
  });

  it('compile rejects an invalid flag without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-sbx-'));
    dirs.push(dir);
    const file = join(dir, 'set.json');
    const original = serializeWorkflowSet(terminalSet());
    await writeFile(file, original);

    await expect(compile(file, join(dir, 'out'), { sandbox: { packages: ['$(id)'] } })).rejects.toThrow(/package/);
    expect(await readFile(file, 'utf-8')).toBe(original);
  });
});
