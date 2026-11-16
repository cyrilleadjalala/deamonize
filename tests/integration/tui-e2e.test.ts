import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');

// A terminal workflow, as the recorder produces it
const set: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Greeter',
  startCommand: [process.execPath, greeter],
  workflows: [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      label: 'Greet someone',
      steps: [
        { actionType: 'type', selectors: [], variable: 'your_name', label: 'Type at "Your name"' },
        { actionType: 'keypress', selectors: [], value: 'Enter' },
        { actionType: 'type', selectors: [], value: '1' },
        { actionType: 'keypress', selectors: [], value: 'Enter' },
      ],
      variables: [{ name: 'your_name', description: 'Your name' }],
      observedPayloads: [{ your_name: 'Ada' }],
    },
  ],
};

describe('Terminal workflow end to end (compile → serve → call)', () => {
  let outputDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Under the workspace so the generated server finds node-pty and @xterm/headless in node_modules
    outputDir = await mkdtemp(join(workspaceRoot, '.tui-e2e-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), outputDir);
    } finally {
      console.log = log;
    }

    // The generated TypeScript must type-check strictly
    try {
      execFileSync(
        process.execPath,
        [
          join(workspaceRoot, 'node_modules/typescript/bin/tsc'),
          join(outputDir, 'mcp-server.ts'),
          '--noEmit',
          '--target', 'ES2022',
          '--module', 'NodeNext',
          '--moduleResolution', 'NodeNext',
          '--strict',
          '--skipLibCheck',
          '--types', 'node',
        ],
        { cwd: workspaceRoot, stdio: 'pipe' },
      );
    } catch (err) {
      throw new Error(`The generated server does not type-check:
${(err as { stdout?: Buffer }).stdout?.toString()}`);
    }

    client = new Client({ name: 'tui-e2e-test', version: '1.0.0' });
    transport = new StdioClientTransport({ command: process.execPath, args: [join(outputDir, 'mcp-server.js')], cwd: workspaceRoot });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    await closeClient(client, transport);
    if (outputDir) {
      await removeDir(outputDir);
    }
  });

  it('depends on a pty and a screen renderer, not on a browser', async () => {
    const pkg = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf-8'));

    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining(['node-pty', '@xterm/headless', 'ajv', 'zod'])
    );
    expect(pkg.dependencies.playwright).toBeUndefined();
  });

  it('registers the tool with the recorded variable as its input', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['greet_someone']);
    expect(tools[0].inputSchema.required).toEqual(['your_name']);
  });

  it('starts the program, replays the keys with the payload value and returns its screen', async () => {
    const response = await client.callTool({ name: 'greet_someone', arguments: { your_name: 'Ada' } });
    const content = response.content as Array<{ type: string; text: string }>;
    const result = JSON.parse(content[0].text);

    expect(response.isError).toBe(false);
    expect(result).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.text).toContain('Hello Ada!');
    expect(result.text).toContain('Hello again Ada!');
  }, 60000);

  it('starts the program afresh on every call', async () => {
    const response = await client.callTool({ name: 'greet_someone', arguments: { your_name: 'Bob' } });
    const content = response.content as Array<{ type: string; text: string }>;
    const text = JSON.parse(content[0].text).text as string;

    expect(text).toContain('Hello again Bob!');
    expect(text).not.toContain('Ada');
  }, 60000);

  it('refuses a payload that breaks the schema without starting the program', async () => {
    const startedAt = Date.now();
    let refused = false;
    try {
      const response = await client.callTool({ name: 'greet_someone', arguments: { your_name: 5 } });
      refused = response.isError === true;
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
