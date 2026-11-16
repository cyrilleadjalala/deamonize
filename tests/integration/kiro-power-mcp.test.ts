import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import type { WorkflowSet } from '../../src/types.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');

const set: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Greeter',
  startCommand: [process.execPath, greeter],
  workflows: [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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

describe('Kiro Power import: mcp.json launches the generated server (Requirement 8.6)', () => {
  let outputDir: string;
  let otherCwd: string;
  let client: Client;
  let transport: StdioClientTransport;
  let mcp: { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };

  beforeAll(async () => {
    // Outside the workspace, like a Power imported by Kiro
    outputDir = await mkdtemp(join(tmpdir(), 'daemonize-power-'));
    otherCwd = await mkdtemp(join(tmpdir(), 'daemonize-cwd-'));

    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), outputDir);
    } finally {
      console.log = log;
    }

    // Stand-in for "npm install": link the workspace's installed dependencies (no network needed)
    await symlink(join(workspaceRoot, 'node_modules'), join(outputDir, 'node_modules'), 'junction');

    mcp = JSON.parse(await readFile(join(outputDir, 'mcp.json'), 'utf-8'));
    const entries = Object.values(mcp.mcpServers);
    expect(entries).toHaveLength(1);
    const { command, args, env } = entries[0];

    // Exactly what Kiro does: spawn command + args from a directory unrelated to the Power
    client = new Client({ name: 'kiro-power-test', version: '1.0.0' });
    transport = new StdioClientTransport({
      command,
      args,
      env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
      cwd: otherCwd,
    });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    // The server runs in otherCwd: it must have exited before that directory can be removed
    await closeClient(client, transport);
    for (const dir of [outputDir, otherCwd]) {
      if (dir) {
        await removeDir(dir);
      }
    }
  });

  it('names the Power, the MCP server and the skill directory identically', async () => {
    const plugin = JSON.parse(await readFile(join(outputDir, 'plugin.json'), 'utf-8'));

    expect(Object.keys(mcp.mcpServers)).toEqual([plugin.name]);
    expect(await readdir(join(outputDir, 'skills'))).toEqual([plugin.name]);
  });

  it('serves exactly the tools listed in SKILL.md and name-map.json', async () => {
    const plugin = JSON.parse(await readFile(join(outputDir, 'plugin.json'), 'utf-8'));
    const skill = await readFile(join(outputDir, 'skills', plugin.name, 'SKILL.md'), 'utf-8');
    const nameMap = JSON.parse(await readFile(join(outputDir, 'name-map.json'), 'utf-8')) as Record<string, string>;
    const skillTools = [...skill.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);

    const { tools } = await client.listTools();
    const served = tools.map((t) => t.name).sort();

    expect(served).toEqual(['greet_someone']);
    expect(served).toEqual([...skillTools].sort());
    expect(served).toEqual(Object.values(nameMap).sort());
  });

  it('runs a tool with a valid payload', async () => {
    const response = await client.callTool({ name: 'greet_someone', arguments: { your_name: 'Ada' } });
    const content = response.content as Array<{ type: string; text: string }>;
    const result = JSON.parse(content[0].text);

    expect(response.isError).toBe(false);
    expect(result).toMatchObject({ success: true, screenType: 'terminal' });
    expect(result.text).toContain('Hello Ada!');
  }, 60000);

  it('refuses an invalid payload with a validation error', async () => {
    let refused = false;
    try {
      const response = await client.callTool({ name: 'greet_someone', arguments: { your_name: 5 } });
      refused = response.isError === true;
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
  }, 30000);
});
