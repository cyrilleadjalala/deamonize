import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { Replayer } from '../../src/replayer/replayer.js';
import { PtyDriver } from '../../src/sandbox/pty-driver.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const sizeprog = join(workspaceRoot, 'tests', 'fixtures', 'sizeprog.mjs');
const WIDE_LINE = '<' + '-'.repeat(98) + '>';

function fakeTerminal(columns: number, rows: number) {
  const stream = new PassThrough();
  stream.setEncoding('utf8');
  let shown = '';
  return {
    input: stream as unknown as TerminalInput,
    output: { write: (data: string) => (shown += data), columns, rows },
    type: (bytes: string) => stream.write(bytes),
    async waitFor(text: string, timeoutMs = 10000) {
      const startedAt = Date.now();
      while (!shown.includes(text)) {
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for "${text}"; saw: ${JSON.stringify(shown)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

async function compileTo(dir: string, set: WorkflowSet): Promise<void> {
  const log = console.log;
  console.log = () => { };
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
  } finally {
    console.log = log;
  }
}

async function callTool(dir: string, name: string): Promise<Record<string, any>> {
  const client = new Client({ name: 'size-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'mcp-server.js')], cwd: workspaceRoot });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name, arguments: {} });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  } finally {
    await closeClient(client, transport);
  }
}

describe('terminal size: record at 120x40, replay at 120x40', () => {
  let dir: string;
  let recorded: WorkflowSet;
  const outDirs: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-size-'));
    const out = join(dir, 'workflows.json');
    // The injectable output reports 120x40; --cols/--rows would override it
    const terminal = fakeTerminal(120, 40);
    const recording = recordTui({
      command: [process.execPath, sizeprog],
      name: 'Sizeprog',
      label: 'Check size',
      out,
      input: terminal.input,
      output: terminal.output,
    });
    await terminal.waitFor('Press Enter');
    terminal.type('\r');
    const summary = await recording;
    expect(summary).toMatchObject({ cols: 120, rows: 40, resized: false });
    recorded = deserializeWorkflowSet(await readFile(out, 'utf-8'));
  }, 90000);

  afterAll(async () => {
    await removeDir(dir);
    for (const d of outDirs) await removeDir(d);
  });

  it('stores the size in the workflow file', () => {
    expect(recorded.workflows[0]).toMatchObject({ cols: 120, rows: 40 });
  });

  it('lets --cols and --rows override the size of the terminal', async () => {
    const terminal = fakeTerminal(120, 40);
    const recording = recordTui({
      command: [process.execPath, sizeprog],
      name: 'Sizeprog',
      label: 'Override size',
      out: join(dir, 'override.json'),
      cols: 60,
      rows: 10,
      input: terminal.input,
      output: terminal.output,
    });
    await terminal.waitFor('Press Enter');
    terminal.type('\r');
    expect(await recording).toMatchObject({ cols: 60, rows: 10 });
    const set = deserializeWorkflowSet(await readFile(join(dir, 'override.json'), 'utf-8'));
    expect(set.workflows[0]).toMatchObject({ cols: 60, rows: 10 });
  });

  it('rejects a size out of range', async () => {
    const terminal = fakeTerminal(80, 24);
    await expect(
      recordTui({ command: [process.execPath, sizeprog], name: 'x', label: 'x', out: join(dir, 'bad.json'), cols: 10, input: terminal.input, output: terminal.output })
    ).rejects.toThrow(/--cols/);
  });

  it('the host Replayer gives the PtyDriver the recorded size', async () => {
    const replayer = new Replayer((size) => new PtyDriver(process.execPath, [sizeprog], size));
    const result = await replayer.replay(recorded.workflows[0], {}, 30000);

    expect(result.success).toBe(true);
    expect(result.result?.text).toContain('size 120x40');
    expect(result.result?.text).toContain(WIDE_LINE);
    expect(result.terminalSize).toEqual({ cols: 120, rows: 40 });
    expect(result.drifted).toBe(false);
  });

  it('flags a screen rendered at another size as drifted, with the sizes', async () => {
    const replayer = new Replayer(() => new PtyDriver(process.execPath, [sizeprog])); // ignores the size: 80x24
    const result = await replayer.replay(recorded.workflows[0], {}, 30000);

    expect(result.success).toBe(true);
    expect(result.drifted).toBe(true);
    expect(result.driftReason).toBe('terminal size: recorded 120x40, replayed at 80x24');
  });

  it('the generated server starts the program at 120x40 and does not cut the wide line', async () => {
    const out = await mkdtemp(join(workspaceRoot, '.size-e2e-'));
    outDirs.push(out);
    await compileTo(out, recorded);

    const result = await callTool(out, 'check_size');

    expect(result.success).toBe(true);
    expect(result.text).toContain('size 120x40');
    expect(result.text).toContain('done 120x40');
    expect(result.text).toContain(WIDE_LINE);
    expect(result.terminalSize).toEqual({ cols: 120, rows: 40 });
    expect(result.drifted).toBe(false);
    expect(result.driftReason).toBeUndefined();
  });

  it('DAEMONIZE_COLS/ROWS override the recorded size and the result says it drifted', async () => {
    const out = outDirs[0];
    const client = new Client({ name: 'size-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(out, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: { ...(process.env as Record<string, string>), DAEMONIZE_COLS: '90', DAEMONIZE_ROWS: '30' },
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'check_size', arguments: {} });
      const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
      expect(result.text).toContain('size 90x30');
      expect(result.terminalSize).toEqual({ cols: 90, rows: 30 });
      expect(result.drifted).toBe(true);
      expect(result.driftReason).toBe('terminal size: recorded 120x40, replayed at 90x30');
    } finally {
      await closeClient(client, transport);
    }
  });

  it('an old workflow file without cols/rows still replays at 80x24', async () => {
    const old = deserializeWorkflowSet(serializeWorkflowSet(recorded));
    delete old.workflows[0].cols;
    delete old.workflows[0].rows;
    const oldFile = join(dir, 'old.json');
    await writeFile(oldFile, serializeWorkflowSet(old));
    const reloaded = deserializeWorkflowSet(await readFile(oldFile, 'utf-8'));
    expect(reloaded.workflows[0].cols).toBeUndefined();

    const out = await mkdtemp(join(workspaceRoot, '.size-e2e-'));
    outDirs.push(out);
    await compileTo(out, reloaded);
    const result = await callTool(out, 'check_size');

    expect(result.success).toBe(true);
    expect(result.text).toContain('size 80x24');
    expect(result.text).not.toContain(WIDE_LINE); // wrapped at 80 columns
    expect(result.terminalSize).toEqual({ cols: 80, rows: 24 });
  });

  it('carries the size to the docker replay: in the request and as environment variables', async () => {
    const out = outDirs[0];
    const server = await readFile(join(out, 'mcp-server.ts'), 'utf-8');
    // The final of the tool call (sent to the container in the request) holds the size
    expect(server).toMatch(/"cols":120,"rows":40/);

    const generated = await readFile(join(out, 'replay.ts'), 'utf-8');
    expect(generated).not.toMatch(/const COLS = \d/);
    expect(generated).not.toMatch(/const ROWS = \d/);

    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(out, 'docker-replay.js')).href)) as {
      buildDockerArgs: (o: unknown) => string[];
    };
    const before = { cols: process.env.DAEMONIZE_COLS, rows: process.env.DAEMONIZE_ROWS };
    process.env.DAEMONIZE_COLS = '100';
    process.env.DAEMONIZE_ROWS = '33';
    try {
      const args = mod.buildDockerArgs({ name: 'n', timeoutEnv: [], steps: [] });
      expect(args).toContain('DAEMONIZE_COLS=100');
      expect(args[args.indexOf('DAEMONIZE_COLS=100') - 1]).toBe('-e');
      expect(args).toContain('DAEMONIZE_ROWS=33');
      process.env.DAEMONIZE_COLS = 'wide;rm';
      expect(mod.buildDockerArgs({ name: 'n', timeoutEnv: [], steps: [] }).join(' ')).not.toContain('DAEMONIZE_COLS');
    } finally {
      for (const [key, value] of [['DAEMONIZE_COLS', before.cols], ['DAEMONIZE_ROWS', before.rows]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
