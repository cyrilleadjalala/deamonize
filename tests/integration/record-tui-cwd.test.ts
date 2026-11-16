/**
 * recordTui options added for the sqlite3 example: the working directory of the program (where `sqlite3 notes.db` finds its
 * file) and the command stored in the file when the recorded one is a wrapper such as `docker run -it ... sqlite3 notes.db`.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';

describe('recordTui cwd and startCommand', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await removeDir(dir);
  });

  it('starts the program in the given folder and stores the command of the program, not the wrapper', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'daemonize-cwd-')));
    dirs.push(dir);
    const out = join(dir, 'daemonize.workflows.json');
    const input = new PassThrough();
    input.setEncoding('utf8');
    let shown = '';
    const recording = recordTui({
      command: [process.execPath, '-e', "console.log('cwd=' + process.cwd().split(/[\\\\/]/).pop()); process.stdin.resume(); setInterval(() => {}, 1000);"],
      startCommand: ['sqlite3', 'notes.db'],
      cwd: dir,
      name: 'wrapped',
      label: 'Run it',
      out,
      cols: 100,
      rows: 10,
      input: input as unknown as TerminalInput,
      output: { write: (data: string) => (shown += data), columns: 100, rows: 10 },
    });
    const folder = dir.split(/[\\/]/).pop() as string;
    for (let i = 0; i < 400 && !shown.includes(`cwd=${folder}`); i++) await new Promise((r) => setTimeout(r, 25));
    input.write('hello\r'); // a workflow needs a step
    await new Promise((r) => setTimeout(r, 150));
    input.write('\x1d');
    input.write('e');
    await recording;

    expect(shown).toContain(`cwd=${folder}`);
    const set = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    expect(set.startCommand).toEqual(['sqlite3', 'notes.db']);
  });
});
