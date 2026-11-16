/**
 * Screen pattern waits (requirements 17.2 to 17.5), end to end through MCP: a slow program, a program that
 * never stops redrawing, a pattern that never shows up, the latency, and (opt in) a Docker container.
 *
 *   DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/tui-wait.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { recordTui, type RecordTuiOptions, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { buildSandboxImage } from '../../src/cli/commands/sandbox.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const dockerEnabled = process.env.DAEMONIZE_DOCKER_TESTS === '1';
const workspaceRoot = resolve(import.meta.dirname, '../..');
const fixtures = join(workspaceRoot, 'tests', 'fixtures');
const slowcli = join(fixtures, 'slowcli.mjs');
const refreshtui = join(fixtures, 'refreshtui.mjs');

// The fixture is deterministic through its options: a start-up delay and a delay between two lines.
// Lines arrive every 400 ms, longer than the 150 ms of silence the old rule takes for "the program is done".
const START_DELAY_MS = 400;
const LINE_DELAY_MS = 400;
const slowArgs = [`--delay=${START_DELAY_MS}`, `--line-delay=${LINE_DELAY_MS}`];
const SLOW_LINES = ['item 1', 'item 2', 'item 3', 'done 3'];

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

interface CallResult {
  success: boolean;
  drifted?: boolean;
  error?: string;
  text?: string;
  data?: unknown;
  failure?: { stepIndex: number; pattern: string; mode: string; screenExcerpt: string };
  [key: string]: unknown;
}

describe('screen pattern waits through MCP', () => {
  let tmp: string;
  const outputDirs: string[] = [];
  const connections: Array<{ client: Client; transport: StdioClientTransport }> = [];

  /** Record a workflow of a program in a fake terminal and return its set. */
  async function record(
    name: string,
    command: string[],
    options: Partial<RecordTuiOptions>,
    script: (terminal: ReturnType<typeof fakeTerminal>) => Promise<void>
  ): Promise<WorkflowSet> {
    const out = join(tmp, `${name}.json`);
    const terminal = fakeTerminal();
    const recording = recordTui({ command, name, label: 'Run it', out, input: terminal.input, output: terminal.output, ...options });
    await script(terminal);
    await recording;
    return new SchemaInferencer().inferWorkflows(deserializeWorkflowSet(await readFile(out, 'utf-8')));
  }

  /** Compile a set (under the workspace, where the server finds node_modules) and connect to its server. */
  async function serve(set: WorkflowSet, env: Record<string, string> = {}) {
    const outputDir = await mkdtemp(join(workspaceRoot, '.tui-wait-'));
    outputDirs.push(outputDir);
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(set, outputDir);
    } finally {
      console.log = log;
    }
    const client = new Client({ name: 'tui-wait', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: { ...(process.env as Record<string, string>), ...env },
    });
    await client.connect(transport);
    connections.push({ client, transport });
    return { client, outputDir };
  }

  async function call(client: Client, name = 'run_it', args: Record<string, unknown> = {}): Promise<CallResult & { tookMs: number }> {
    const startedAt = Date.now();
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
    const tookMs = Date.now() - startedAt;
    return { ...(JSON.parse((response.content as Array<{ text: string }>)[0].text) as CallResult), tookMs };
  }

  const withoutWaits = (set: WorkflowSet): WorkflowSet => {
    const copy = structuredClone(set);
    for (const workflow of copy.workflows) for (const step of workflow.steps) delete step.waitFor;
    return copy;
  };

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'daemonize-tui-wait-'));
  });

  afterAll(async () => {
    for (const { client, transport } of connections) await closeClient(client, transport);
    for (const dir of outputDirs) await removeDir(dir);
    if (tmp) await removeDir(tmp);
  });

  // -------------------------------------------------------------------------------------------------
  describe('a slow command line program', () => {
    let slowSet: WorkflowSet;
    let waiting: Client;
    let silent: Client;

    beforeAll(async () => {
      slowSet = await record('Slow', [process.execPath, slowcli, ...slowArgs], {}, async (t) => {
        await t.waitFor('slow>');
        t.type('count 3');
        t.type('\r');
        await t.waitFor('done 3');
        await new Promise((r) => setTimeout(r, 700)); // the prompt after the output
        t.type('\x1d');
        t.type('e');
      });
      waiting = (await serve(slowSet)).client;
      silent = (await serve(withoutWaits(slowSet))).client;
    });

    it('recorded the prompt after the command as the wait of its Enter', () => {
      const steps = slowSet.workflows[0].steps;
      expect(steps.map((s) => s.value)).toEqual(['count 3', 'Enter']);
      expect(steps[1].waitFor).toMatchObject({ pattern: '^slow>$', mode: 'appear' });
    });

    it('returns the complete output on 5 calls in a row, without drift', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await call(waiting);
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(result.drifted, `call ${i}: ${result.text}`).toBe(false);
        for (const line of SLOW_LINES) expect(result.text, `call ${i}`).toContain(line);
      }
    });

    it('is better than the silence rule alone, which cuts the output of a program slower than its window', async () => {
      let truncated = 0;
      for (let i = 0; i < 3; i++) {
        const result = await call(silent);
        expect(result.success, JSON.stringify(result)).toBe(true);
        if (!SLOW_LINES.every((line) => result.text?.includes(line))) truncated += 1;
      }
      // The lines come every 400 ms, the silence window is 150 ms: the call returns before "done 3"
      expect(truncated).toBeGreaterThanOrEqual(1);
    });

    it('does not wait longer than the program needs', async () => {
      const result = await call(waiting);

      expect(result.success).toBe(true);
      // Start-up delay + 4 lines (the last one is "done 3") + the prompt, each of 400 ms at most, plus 3 s for the pty and the server
      expect(result.tookMs).toBeLessThan(START_DELAY_MS + 5 * LINE_DELAY_MS + 3000);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('a program that redraws all the time', () => {
    // The menu, then the message of the key just pressed: the menu alone is already on screen when "1" is
    // sent (the program redraws 100 ms later), so a wait for it would return on the screen before the key.
    const MENU = 'Menu: \\[1\\] Start[\\s\\S]*Started';
    const baseOptions: Partial<RecordTuiOptions> = {
      waitAfter: MENU,
      resultRect: { row: 1, col: 0, rows: 1, cols: 80 },
      resultRegex: 'Menu: \\[(?<key>\\d)\\] (?<action>\\w+)',
    };
    const script = async (t: ReturnType<typeof fakeTerminal>) => {
      await t.waitFor('Menu:');
      t.type('1');
      await t.waitFor('Started');
      t.type('\x1d');
      t.type('e');
    };
    let stable: Client;
    let whole: Client;
    let stableSet: WorkflowSet;

    beforeAll(async () => {
      // The clock is on row 0: the final zone is the menu and the message below it
      stableSet = await record('Refresh', [process.execPath, refreshtui], { ...baseOptions, finalRect: { row: 1, col: 0, rows: 2, cols: 80 } }, script);
      stable = (await serve(stableSet)).client;
      // The same recording, judged on the whole screen, clock included
      const wholeSet = await record('RefreshWhole', [process.execPath, refreshtui], baseOptions, script);
      whole = (await serve(wholeSet)).client;
    });

    it('recorded the wait for the menu and the final zone without the clock row', () => {
      const workflow = stableSet.workflows[0];
      expect(workflow.steps[0].waitFor).toMatchObject({ pattern: MENU, mode: 'appear' });
      expect(workflow.finalZone?.rect).toEqual({ row: 1, col: 0, rows: 2, cols: 80 });
    });

    it('returns once the menu is visible, with no drift judged on the stable zone', async () => {
      const result = await call(stable);

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.drifted).toBe(false);
      expect(result.text).toContain('Menu: [1] Start  [2] Quit');
      expect(result.text).not.toContain('Clock:'); // the call returns the result zone: the menu row
    });

    it('extracts the result zone from the stable part', async () => {
      const result = await call(stable);

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.data).toMatchObject({ key: '1', action: 'Start' });
    });

    it('reports drift for the same replay judged on the whole screen, because of the clock', async () => {
      const result = await call(whole);

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.drifted).toBe(true);
      expect(result.text).toContain('Menu: [1] Start  [2] Quit');
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('a pattern that never shows up', () => {
    const TIMEOUT_MS = 1500;
    let marker: string;
    let client: Client;

    beforeAll(async () => {
      marker = join(tmp, 'later-step-ran.txt');
      const program = join(tmp, 'sideeffect.mjs');
      // Prints a prompt; the command "touch" writes the marker file, which only a later step can do
      await writeFile(
        program,
        [
          "import { writeFileSync } from 'node:fs';",
          "import readline from 'node:readline';",
          `const marker = ${JSON.stringify(marker)};`,
          "const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'side> ' });",
          "rl.on('line', (line) => { if (line.trim() === 'touch') writeFileSync(marker, 'ran'); rl.prompt(); });",
          "rl.on('close', () => process.exit(0));",
          'rl.prompt();',
        ].join('\n')
      );
      const set: WorkflowSet = {
        version: '1',
        targetType: 'tui',
        targetName: 'Side effect',
        startCommand: [process.execPath, program],
        workflows: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            label: 'Run it',
            steps: [
              { actionType: 'type', selectors: [], value: 'hello' },
              { actionType: 'keypress', selectors: [], value: 'Enter', waitFor: { pattern: '^never>$', flags: 'm', mode: 'appear', timeoutMs: TIMEOUT_MS } },
              { actionType: 'type', selectors: [], value: 'touch' },
              { actionType: 'keypress', selectors: [], value: 'Enter' },
            ],
            variables: [],
            observedPayloads: [{}],
          },
        ],
      };
      client = (await serve(set)).client;
    });

    it('stops with pattern_timeout and drift, runs no later step, and returns within the timeout plus 3 s', async () => {
      const result = await call(client);

      expect(result).toMatchObject({ success: false, error: 'pattern_timeout', drifted: true });
      expect(result.failure).toMatchObject({ stepIndex: 1, pattern: '^never>$', mode: 'appear' });
      expect(result.failure?.screenExcerpt).toContain('side> hello');
      expect(existsSync(marker)).toBe(false); // the "touch" step never ran
      expect(result.tookMs).toBeLessThan(TIMEOUT_MS + 3000);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe.skipIf(!dockerEnabled)('in a Docker container (DAEMONIZE_DOCKER_TESTS=1)', () => {
    let tag: string;
    let outputDir: string;
    let set: WorkflowSet;

    beforeAll(async () => {
      set = await record('SlowDocker', [process.execPath, slowcli, ...slowArgs], {}, async (t) => {
        await t.waitFor('slow>');
        t.type('count 3');
        t.type('\r');
        await t.waitFor('done 3');
        await new Promise((r) => setTimeout(r, 700));
        t.type('\x1d');
        t.type('e');
      });
      outputDir = await mkdtemp(join(workspaceRoot, '.tui-wait-docker-'));
      outputDirs.push(outputDir);
      const log = console.log;
      console.log = () => { };
      try {
        await new Compiler().compile(set, outputDir);
      } finally {
        console.log = log;
      }
      tag = await buildSandboxImage(outputDir);
    }, 900000);

    afterAll(() => {
      if (tag) spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
    });

    it('replays the slow program in the container and returns the same complete output', async () => {
      const client = new Client({ name: 'tui-wait-docker', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(outputDir, 'mcp-server.js')],
        cwd: workspaceRoot,
        env: {
          ...(process.env as Record<string, string>),
          DAEMONIZE_SANDBOX: 'docker',
          DAEMONIZE_SANDBOX_IMAGE: tag,
          DAEMONIZE_SANDBOX_MOUNTS: JSON.stringify([`${fixtures}:/app:ro`]),
          DAEMONIZE_SANDBOX_COMMAND: JSON.stringify(['node', '/app/slowcli.mjs', ...slowArgs]),
        },
      });
      await client.connect(transport);
      try {
        const result = await call(client);

        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(result.drifted).toBe(false);
        for (const line of SLOW_LINES) expect(result.text).toContain(line);
      } finally {
        await closeClient(client, transport);
      }
    }, 180000);
  });

  if (!dockerEnabled) {
    it.skip('Docker replay of the slow program: skipped, set DAEMONIZE_DOCKER_TESTS=1 (needs a running Docker daemon and the node:20 image)', () => { });
  }
});
