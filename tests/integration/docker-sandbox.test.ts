/**
 * Replays calls in a real Docker container. Needs a running Docker daemon and the
 * base image `node:20`, and builds an image (a few minutes the first time: it installs
 * packages inside it), so it only runs when asked:
 *
 *   DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/docker-sandbox.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildSandboxImage, assertSandboxReady } from '../../src/cli/commands/sandbox.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const enabled = process.env.DAEMONIZE_DOCKER_TESTS === '1';
const workspaceRoot = resolve(import.meta.dirname, '../..');
const fixtures = join(workspaceRoot, 'tests', 'fixtures');

// The program as it is started inside the container: the fixtures folder is mounted at /app
const inContainer = (script: string) => ['node', `/app/${script}`];

const set: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Docker Sandbox Test',
  startCommand: [process.execPath, join(fixtures, 'greeter.mjs')], // a path of the host, on purpose
  workflows: [
    {
      id: 'f1111111-1111-4111-8111-111111111111',
      label: 'Greet someone',
      steps: [
        { actionType: 'type', selectors: [], variable: 'your_name' },
        { actionType: 'keypress', selectors: [], value: 'Enter' },
        { actionType: 'type', selectors: [], value: '1' },
        { actionType: 'keypress', selectors: [], value: 'Enter' },
      ],
      variables: [{ name: 'your_name' }],
      observedPayloads: [{ your_name: 'Ada' }],
    },
  ],
};

describe.skipIf(!enabled)('Replay in a Docker container', () => {
  let dir: string;
  let tag: string;

  /** Start the generated server with the given sandbox settings and return a connected client. */
  async function connectServer(env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'docker-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(dir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: { DAEMONIZE_SANDBOX: 'docker', ...env },
      })
    );
    return client;
  }

  const call = async (client: Client, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: 'greet_someone', arguments: args });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  };

  beforeAll(async () => {
    // Under the workspace so the generated server finds its modules in node_modules
    dir = await mkdtemp(join(workspaceRoot, '.docker-e2e-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
    } finally {
      console.log = log;
    }
    tag = await buildSandboxImage(dir);
  }, 900000);

  afterAll(async () => {
    if (dir) {
      await removeDir(dir);
    }
    if (tag) {
      spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
    }
  });

  it('finds the image it was told to build', async () => {
    await expect(assertSandboxReady(dir)).resolves.toBe(tag);
  });

  it('replays a terminal workflow in a container, with the payload value', async () => {
    const client = await connectServer({
      DAEMONIZE_SANDBOX_MOUNTS: JSON.stringify([`${fixtures}:/app:ro`]),
      DAEMONIZE_SANDBOX_COMMAND: JSON.stringify(inContainer('greeter.mjs')),
    });
    try {
      const result = await call(client, { your_name: 'Ada' });

      expect(result).toMatchObject({ success: true, screenType: 'terminal' });
      // The container reports drift like the host: this workflow has no recorded final screen
      expect(result).toMatchObject({ drifted: false, driftChecked: false });
      expect(result.text).toContain('Hello again Ada!');
    } finally {
      await client.close();
    }
  }, 120000);

  it('leaves no container behind', async () => {
    const left = spawnSync('docker', ['ps', '-a', '--filter', 'name=daemonize-', '--format', '{{.Names}}'], {
      encoding: 'utf-8',
    });

    expect(left.stdout.trim()).toBe('');
  });

  it('runs the program as an unprivileged user on Linux, with the limits, a read-only file system and no network', async () => {
    const probeSet: WorkflowSet = {
      ...set,
      workflows: [
        {
          ...set.workflows[0],
          id: 'f2222222-2222-4222-8222-222222222222',
          label: 'Greet someone',
          steps: [{ actionType: 'keypress', selectors: [], value: 'Enter' }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
    const probeDir = await mkdtemp(join(workspaceRoot, '.docker-probe-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(probeSet), probeDir);
    } finally {
      console.log = log;
    }
    // Same image: only the generated server differs, and it takes the image from its settings
    const client = new Client({ name: 'docker-probe', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(probeDir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: {
          DAEMONIZE_SANDBOX: 'docker',
          DAEMONIZE_SANDBOX_IMAGE: tag,
          DAEMONIZE_SANDBOX_MOUNTS: JSON.stringify([`${fixtures}:/app:ro`]),
          DAEMONIZE_SANDBOX_COMMAND: JSON.stringify(inContainer('probe.mjs')),
          DAEMONIZE_SANDBOX_MEMORY_MB: '256',
          DAEMONIZE_SANDBOX_CPUS: '0.5',
        },
      })
    );
    try {
      const response = await client.callTool({ name: 'greet_someone', arguments: {} });
      const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
      expect(result.success, JSON.stringify(result)).toBe(true);

      const facts = Object.fromEntries(
        (result.text as string)
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => line.split('=') as [string, string])
      );

      expect(facts.platform).toBe('linux'); // the host is Windows
      expect(Number(facts.uid)).toBeGreaterThan(0); // not root
      expect(facts.memory_max).toBe(String(256 * 1024 * 1024));
      expect(facts.cpu_max).toBe('50000 100000'); // half a CPU
      expect(facts.write_root).toBe('denied'); // read-only file system
      expect(facts.write_tmp).toBe('allowed'); // with a scratch /tmp
      expect(facts.host_files).toBe('absent');
      expect(facts.network).toBe('unreachable');
    } finally {
      await client.close();
      await removeDir(probeDir);
    }
  }, 180000);

  it('reports a missing image as an unavailable sandbox, and never downloads one', async () => {
    const client = await connectServer({
      DAEMONIZE_SANDBOX_IMAGE: 'daemonize-no-such-image:never',
      DAEMONIZE_SANDBOX_COMMAND: JSON.stringify(inContainer('greeter.mjs')),
    });
    try {
      const result = await call(client, { your_name: 'Ada' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^sandbox_unavailable:/);
    } finally {
      await client.close();
    }
  }, 60000);

  it('reports Docker not being installed as an unavailable sandbox', async () => {
    const client = await connectServer({
      DAEMONIZE_DOCKER: 'docker-that-does-not-exist',
      DAEMONIZE_SANDBOX_COMMAND: JSON.stringify(inContainer('greeter.mjs')),
    });
    try {
      const result = await call(client, { your_name: 'Ada' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^sandbox_unavailable: cannot run docker-that-does-not-exist/);
    } finally {
      await client.close();
    }
  }, 60000);

  it('asks for the command inside the container when the recorded one is a path of the host', async () => {
    const client = await connectServer({});
    try {
      const result = await call(client, { your_name: 'Ada' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('DAEMONIZE_SANDBOX_COMMAND');
    } finally {
      await client.close();
    }
  }, 60000);
});

describe.skipIf(!enabled)('Replay of a web target in a Docker container', () => {
  let httpServer: Server;
  let port: number;
  const userAgents = new Set<string>();
  let dir: string;
  let tag: string;

  const webSet = (): WorkflowSet => ({
    version: '1',
    targetType: 'web',
    targetName: 'Docker Web Test',
    startUrl: `http://127.0.0.1:${port}/`, // the address on the host; the container cannot use it
    workflows: [
      {
        id: 'f3333333-3333-4333-8333-333333333333',
        label: 'Create customer',
        steps: [
          { actionType: 'type', selectors: ['role=textbox[name="Customer name"]', '#n'], variable: 'name' },
          { actionType: 'click', selectors: ['role=button[name="Save"]', 'button[type=submit]'] },
        ],
        variables: [{ name: 'name' }],
        observedPayloads: [{ name: 'Ada' }],
      },
    ],
  });

  async function connectServer(env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'docker-web-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(dir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: { DAEMONIZE_SANDBOX: 'docker', DAEMONIZE_SANDBOX_IMAGE: tag, ...env },
      })
    );
    return client;
  }

  const call = async (client: Client, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: 'create_customer', arguments: args });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  };

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      userAgents.add(String(req.headers['user-agent'] ?? ''));
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'text/html');
      res.end(
        url.pathname === '/result'
          ? `<html><head><title>Saved</title></head><body>Customer ${url.searchParams.get('name')} created</body></html>`
          : '<html><head><title>New</title></head><body><form action="/result"><label for="n">Customer name</label><input id="n" name="name"><button type="submit">Save</button></form></body></html>'
      );
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    port = (httpServer.address() as AddressInfo).port;

    dir = await mkdtemp(join(workspaceRoot, '.docker-web-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(webSet()), dir);
    } finally {
      console.log = log;
    }
    tag = await buildSandboxImage(dir);
  }, 1200000);

  afterAll(async () => {
    await new Promise<void>((done) => httpServer?.close(() => done()));
    if (dir) {
      await removeDir(dir);
    }
    if (tag) {
      spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
    }
  });

  it('replays the workflow with a browser that runs in the container, not on this machine', async () => {
    userAgents.clear();
    const client = await connectServer({ DAEMONIZE_SANDBOX_URL: `http://host.docker.internal:${port}/` });
    try {
      const result = await call(client, { name: 'Ada' });

      expect(result, JSON.stringify(result)).toMatchObject({ success: true, title: 'Saved' });
      expect(result.text).toContain('Customer Ada created');
      // The browser that asked for the pages is a Linux one: a browser started on this
      // (Windows) machine would say so. The address cannot tell: Docker Desktop relays the
      // connections of the container through the loopback of the host.
      expect(userAgents.size).toBeGreaterThan(0);
      for (const userAgent of userAgents) {
        expect(userAgent).toContain('Linux');
        expect(userAgent).not.toContain('Windows');
      }
    } finally {
      await client.close();
    }
  }, 180000);

  it('cannot reach anything when the container has no network', async () => {
    const client = await connectServer({
      DAEMONIZE_SANDBOX_URL: `http://host.docker.internal:${port}/`,
      DAEMONIZE_SANDBOX_NETWORK: 'none',
    });
    try {
      const result = await call(client, { name: 'Ada' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/ERR_|net::|resolve|Timeout/i);
    } finally {
      await client.close();
    }
  }, 180000);

  it('leaves no container behind', () => {
    const left = spawnSync('docker', ['ps', '-a', '--filter', 'name=daemonize-', '--format', '{{.Names}}'], {
      encoding: 'utf-8',
    });

    expect(left.stdout.trim()).toBe('');
  });
});
