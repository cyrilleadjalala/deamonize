/**
 * Real programs in the sandbox image: sqlite3 and git are installed in the image from the `sandbox` block of the
 * workflow set (apt-get / apk), and the workflow is replayed in a container. Needs a running Docker daemon, access
 * to the Docker registry and to the Debian/Alpine package mirrors (the image is built), so it only runs when asked:
 *
 *   DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/sandbox-real-binaries.test.ts
 *
 * The workflows are written by hand (they do not depend on a sqlite3 or git installed on the host).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildSandboxImage } from '../../src/cli/commands/sandbox.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { SandboxSpec, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const enabled = process.env.DAEMONIZE_DOCKER_TESTS === '1';
if (!enabled) {
  console.warn('sandbox-real-binaries: skipped. Set DAEMONIZE_DOCKER_TESTS=1 (and start Docker) to build images with sqlite3 and git and replay them.');
}

const workspaceRoot = resolve(import.meta.dirname, '../..');

const line = (text: string): WorkflowStep[] => [
  { actionType: 'type', selectors: [], value: text },
  { actionType: 'keypress', selectors: [], value: 'Enter' },
];

function terminalSet(name: string, startCommand: string[], steps: WorkflowStep[], sandbox: SandboxSpec): WorkflowSet {
  return {
    version: '1',
    targetType: 'tui',
    targetName: name,
    startCommand,
    sandbox,
    workflows: [
      { id: 'c1111111-1111-4111-8111-111111111111', label: 'Run session', steps, variables: [], observedPayloads: [] },
    ],
  };
}

describe.skipIf(!enabled)('Real binaries installed by the sandbox block', () => {
  const dirs: string[] = [];
  const tags: string[] = [];

  afterAll(async () => {
    for (const dir of dirs) await removeDir(dir);
    for (const tag of tags) spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
  });

  /** Compile the set, build its image with the packages of the block, and run its only tool in a container. */
  async function replay(set: WorkflowSet, tag: string, env: Record<string, string> = {}): Promise<Record<string, any>> {
    const dir = await mkdtemp(join(workspaceRoot, '.docker-bin-'));
    dirs.push(dir);
    const log = console.log;
    console.log = () => {};
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
      tags.push(tag);
      await buildSandboxImage(dir, { tag, log: () => {} });
    } finally {
      console.log = log;
    }
    const client = new Client({ name: 'real-binaries', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(dir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: { DAEMONIZE_SANDBOX: 'docker', DAEMONIZE_SANDBOX_IMAGE: tag, ...env },
      })
    );
    try {
      const [tool] = (await client.listTools()).tools;
      const response = await client.callTool({ name: tool.name, arguments: {} });
      return JSON.parse((response.content as Array<{ text: string }>)[0].text);
    } finally {
      await client.close();
    }
  }

  it('sqlite3 (apt-get on the default image): create, insert and select in :memory:', async () => {
    const set = terminalSet(
      'Sqlite Memory',
      ['sqlite3', ':memory:'],
      [...line('create table t(x);'), ...line('insert into t values (42);'), ...line('select * from t;')],
      { packages: ['sqlite3'] }
    );

    const result = await replay(set, 'daemonize-test-sqlite');

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.text).toMatch(/^\s*42\s*$/m);
  }, 900000);

  it('git on debian:bookworm-slim (runtime copied into the base image), in a tmpfs workdir', async () => {
    const set = terminalSet(
      'Git Shell',
      ['/bin/sh'],
      [...line('git --version'), ...line('git init -q'), ...line('pwd; ls -d .git')],
      { image: 'debian:bookworm-slim', packages: ['git'], workdir: '/tmp' }
    );

    const result = await replay(set, 'daemonize-test-git');

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.text).toMatch(/git version \d+\.\d+/);
    expect(result.text).toMatch(/^\/tmp$/m);
    expect(result.text).toMatch(/^\.git$/m);
  }, 900000);

  it('sqlite on alpine (apk, musl runtime)', async () => {
    const set = terminalSet(
      'Sqlite Alpine',
      ['sqlite3', ':memory:'],
      [...line('create table t(x);'), ...line('insert into t values (42);'), ...line('select * from t;')],
      { image: 'alpine:3.20', packages: ['sqlite'] }
    );

    const result = await replay(set, 'daemonize-test-sqlite-alpine');

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.text).toMatch(/^\s*42\s*$/m);
  }, 900000);

  it('gives a terminal program no network by default', async () => {
    const probe = () =>
      terminalSet(
        'Net Probe',
        ['/bin/sh'],
        line(`node -e "require('dns').lookup('example.com',(e)=>console.log(e?'NET-DOWN':'NET-UP'))"`),
        { image: 'debian:bookworm-slim' }
      );

    const isolated = await replay(probe(), 'daemonize-test-net-none');
    expect(isolated, JSON.stringify(isolated)).toMatchObject({ success: true });
    expect(isolated.text).toContain('NET-DOWN');
  }, 900000);
});
