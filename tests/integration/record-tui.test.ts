import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { Replayer } from '../../src/replayer/replayer.js';
import { PtyDriver } from '../../src/sandbox/pty-driver.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';

const greeter = join(resolve(import.meta.dirname, '..'), 'fixtures', 'greeter.mjs');

/** A user at a terminal: bytes in, what the program shows out. */
function fakeTerminal() {
  const stream = new PassThrough();
  stream.setEncoding('utf8');
  let shown = '';
  return {
    input: stream as unknown as TerminalInput,
    output: { write: (data: string) => (shown += data), columns: 80, rows: 24 },
    type: (bytes: string) => stream.write(bytes),
    shown: () => shown,
    async waitFor(text: string, timeoutMs = 10000) {
      const startedAt = Date.now();
      while (!shown.includes(text)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`Timed out waiting for "${text}"; saw: ${JSON.stringify(shown)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

describe('recordTui: record a terminal program, then replay it', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-tui-'));
  });

  afterAll(async () => {
    await removeDir(dir);
  });

  it('records the keys, a variable named from the menu, and the final screen', async () => {
    const out = join(dir, 'workflows.json');
    const terminal = fakeTerminal();

    const recording = recordTui({
      command: [process.execPath, greeter],
      name: 'Greeter',
      label: 'Greet someone',
      out,
      input: terminal.input,
      output: terminal.output,
    });

    await terminal.waitFor('Your name:');
    terminal.type('Ada');
    terminal.type('\r');
    await terminal.waitFor('Hello Ada!');

    // Mark "Ada" as a variable, keeping the name suggested from the prompt
    terminal.type(MENU_KEY);
    await terminal.waitFor('make the last typed text a variable');
    terminal.type('v');
    await terminal.waitFor('variable name: your_name');
    terminal.type('\r');
    await terminal.waitFor('optional? (y/n, Enter = n)');
    terminal.type('\r');
    await terminal.waitFor('type? (s/n/b, Enter = s)');
    terminal.type('\r');
    await terminal.waitFor('variable "your_name" saved');

    terminal.type('1\r');
    await terminal.waitFor('Hello again Ada!');
    terminal.type(MENU_KEY);
    terminal.type('e');

    const summary = await recording;

    expect(summary).toMatchObject({ steps: 4, variables: ['your_name'], totalWorkflows: 1, constantTypedValues: 1 });

    const set = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    expect(set).toMatchObject({ targetType: 'tui', targetName: 'Greeter', startCommand: [process.execPath, greeter] });

    const [workflow] = set.workflows;
    expect(workflow.steps.map((s) => [s.actionType, s.variable ?? s.value])).toEqual([
      ['type', 'your_name'],
      ['keypress', 'Enter'],
      ['type', '1'],
      ['keypress', 'Enter'],
    ]);
    expect(workflow.variables).toEqual([{ name: 'your_name', description: 'Your name' }]);
    expect(workflow.finalScreenId).toMatch(/^[0-9a-f]{16}$/);

    // Replay it from scratch with another value
    const replayer = new Replayer(() => new PtyDriver(process.execPath, [greeter]));
    const result = await replayer.replay(workflow, { your_name: 'Bob' }, 20000);

    expect(result.success).toBe(true);
    expect(result.result?.screenType).toBe('terminal');
    expect(result.result?.text).toContain('Hello Bob!');
    expect(result.result?.text).toContain('Hello again Bob!');
  }, 90000);

  it('ends by itself, and says so, when the program exits', async () => {
    const out = join(dir, 'exits.json');
    const terminal = fakeTerminal();

    const recording = recordTui({
      command: [process.execPath, greeter],
      name: 'Greeter',
      label: 'Quit at once',
      out,
      input: terminal.input,
      output: terminal.output,
    });

    await terminal.waitFor('Your name:');
    terminal.type('Eve\r');
    await terminal.waitFor('Choose [1]');
    terminal.type('2\r');

    const summary = await recording;

    expect(summary.programExitCode).toBe(0);
    expect(summary.steps).toBe(4);
  }, 60000);

  it('refuses to save a recording in which nothing was done', async () => {
    const terminal = fakeTerminal();
    const recording = recordTui({
      command: [process.execPath, greeter],
      name: 'Greeter',
      label: 'Nothing',
      out: join(dir, 'empty.json'),
      input: terminal.input,
      output: terminal.output,
    });

    await terminal.waitFor('Your name:');
    terminal.type(MENU_KEY);
    terminal.type('e');

    await expect(recording).rejects.toThrow(/without steps/);
  }, 60000);
});
