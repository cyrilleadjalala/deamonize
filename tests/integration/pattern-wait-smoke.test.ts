import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { Replayer } from '../../src/replayer/replayer.js';
import { PtyDriver } from '../../src/sandbox/pty-driver.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const slowcli = join(workspaceRoot, 'tests', 'fixtures', 'slowcli.mjs');
// Lines arrive every 400 ms: longer than the 150 ms of silence the old rule takes for "the program is done"
const LINE_DELAY_MS = 400;
const program = [process.execPath, slowcli, `--line-delay=${LINE_DELAY_MS}`];

function fakeTerminal() {
  const stream = new PassThrough();
  stream.setEncoding('utf8');
  let shown = '';
  return {
    input: stream as unknown as TerminalInput,
    output: { write: (data: string) => (shown += data), columns: 80, rows: 24 },
    type: (bytes: string) => stream.write(bytes),
    async waitFor(text: string, timeoutMs = 20000) {
      const startedAt = Date.now();
      while (!shown.includes(text)) {
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for "${text}"; saw: ${JSON.stringify(shown)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

describe('screen pattern waits: record a slow program, replay it', () => {
  let dir: string;
  let outputDir: string;
  let set: WorkflowSet;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-wait-'));
    const out = join(dir, 'workflows.json');
    const terminal = fakeTerminal();
    const recording = recordTui({ command: program, name: 'Slow', label: 'Count items', out, input: terminal.input, output: terminal.output });

    await terminal.waitFor('slow>');
    terminal.type('count 3');
    terminal.type('\r');
    await terminal.waitFor('done 3');
    await new Promise((r) => setTimeout(r, 400)); // the prompt after the output
    terminal.type('quit\r');
    const summary = await recording;
    expect(summary.screenWaits).toBeGreaterThanOrEqual(1);

    set = new SchemaInferencer().inferWorkflows(deserializeWorkflowSet(await readFile(out, 'utf-8')));

    outputDir = await mkdtemp(join(workspaceRoot, '.wait-smoke-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(set, outputDir);
    } finally {
      console.log = log;
    }
    client = new Client({ name: 'wait-smoke', version: '1.0.0' });
    transport = new StdioClientTransport({ command: process.execPath, args: [join(outputDir, 'mcp-server.js')], cwd: workspaceRoot });
    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    if (client) await closeClient(client, transport);
    if (outputDir) await removeDir(outputDir);
    if (dir) await removeDir(dir);
  });

  it('recorded the prompt shown after the command as the pattern its Enter waits for', () => {
    const steps = set.workflows[0].steps;
    expect(steps[0].waitFor).toBeUndefined();
    expect(steps.map((s) => s.value)).toEqual(['count 3', 'Enter', 'quit', 'Enter']);
    expect(steps[1].waitFor).toEqual({ pattern: '^slow>$', flags: 'm', mode: 'appear', timeoutMs: 15000 });
  });

  it('copies pattern-wait.ts verbatim into the output and the Docker context', async () => {
    const original = await readFile(join(workspaceRoot, 'src/replay/runtime/pattern-wait.ts'), 'utf-8');
    expect(await readFile(join(outputDir, 'pattern-wait.ts'), 'utf-8')).toBe(original);
    expect(await readFile(join(outputDir, 'sandbox', 'Dockerfile'), 'utf-8')).toContain('COPY pattern-wait.js');
  });

  it('through MCP returns the complete output, without more waiting than the program needs', async () => {
    const startedAt = Date.now();
    const response = await client.callTool({ name: 'count_items', arguments: {} });
    const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
    const took = Date.now() - startedAt;

    expect(result.success).toBe(true);
    for (const line of ['item 1', 'item 2', 'item 3', 'done 3']) expect(result.text).toContain(line);
    // Start (up to 1.5 s) + 4 lines at 400 ms + start-up of the server and the pty, with no fixed grace on top
    expect(took).toBeLessThan(1500 + 4 * LINE_DELAY_MS + 5000);
  });

  it('on the host stops with pattern_timeout and no later step when the pattern never shows up', async () => {
    const workflow = structuredClone(set.workflows[0]);
    workflow.steps[1].waitFor = { pattern: '^never>$', flags: 'm', mode: 'appear', timeoutMs: 700 };

    const replayer = new Replayer(() => new PtyDriver(program[0], program.slice(1)));
    const result = await replayer.replay(workflow, {}, 30000);

    expect(result).toMatchObject({ success: false, error: 'pattern_timeout', drifted: true });
    expect(result.failure).toMatchObject({ stepIndex: 1, pattern: '^never>$', mode: 'appear' });
    expect((result.failure as { screenExcerpt: string }).screenExcerpt).toContain('slow> count 3');
    expect(result.elapsedMs).toBeLessThan(15000);
  });

  it('on the host waits for the prompt and returns the whole output', async () => {
    const replayer = new Replayer(() => new PtyDriver(program[0], program.slice(1)));
    const result = await replayer.replay(set.workflows[0], {}, 30000);

    expect(result.success).toBe(true);
    for (const line of ['item 3', 'done 3']) expect(result.result?.text).toContain(line);
  });
});
