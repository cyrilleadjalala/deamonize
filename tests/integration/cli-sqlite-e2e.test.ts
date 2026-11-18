/**
 * Task 21.3: the REAL `sqlite3` shell, recorded, compiled and called through MCP (requirements 19.2, 19.3, 19.4).
 *
 * The workflows come from examples/cli-sqlite/record-workflows.mjs, which drives `recordTui` like a person at the keyboard
 * (keystrokes into the recorder's input, the Ctrl+] menu to mark the Variables, the sqlite> prompt as the screen wait).
 *
 *   - Always: the committed workflow file is compiled and the server refuses SQL injection before any replay; a program that
 *     never prints the prompt fails with the right diagnostic; nothing secret reaches an artifact. No sqlite3 is needed.
 *   - Host path: only when a sqlite3 >= 3.33 is on the PATH (skipped with a message otherwise).
 *   - Docker path: DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/cli-sqlite-e2e.test.ts
 *     Records inside a container, builds the sandbox image with `sandbox.packages: ['sqlite3']`, mounts the folder of the
 *     database and replays every call in a throw-away container with no network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 900000 });
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile } from '../../src/cli/commands/compile.js';
import { recordTui, type TerminalInput } from '../../src/cli/commands/record-tui.js';
import { buildSandboxImage } from '../../src/cli/commands/sandbox.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';
import { ISOLATED_VAULT_ENV } from '../helpers/isolated-vault.js';

const dockerEnabled = process.env.DAEMONIZE_DOCKER_TESTS === '1';
const workspaceRoot = resolve(import.meta.dirname, '../..');
const exampleDir = join(workspaceRoot, 'examples', 'cli-sqlite');
const committedFile = join(exampleDir, 'daemonize.workflows.json');

interface Script {
  SESSIONS: Array<{ label: string }>;
  CONSTANT_TEXTS: string[];
  SAMPLE: { title: string; body: string };
  VALUE_PATTERN: string;
  DB_FILE: string;
  CONTAINER_DIR: string;
  COLS: number;
  ROWS: number;
  RECORD_IMAGE: string;
  ensureRecordImage(log?: (message: string) => void): string;
  scriptedTerminal(): { input: TerminalInput; output: { write(data: string): unknown; columns: number; rows: number }; prompt(timeoutMs?: number, from?: number): Promise<void>; line(text: string): Promise<void>; end(): Promise<void> };
  hostSqlite(): { version: string; major: number; minor: number } | undefined;
  supportsJsonMode(info: unknown): boolean;
  recordSqliteWorkflows(options: { recordTui: typeof recordTui; out: string; docker?: boolean; log?: (m: string) => void }): Promise<Array<{ steps: number; screenWaits: number; cols: number; rows: number; variables: string[] }>>;
}

const script = (await import(/* @vite-ignore */ pathToFileURL(join(exampleDir, 'record-workflows.mjs')).href)) as Script;
const host = script.hostSqlite();
const hostReady = host !== undefined && script.supportsJsonMode(host);

interface Result {
  success: boolean;
  drifted?: boolean;
  error?: string;
  text?: string;
  data?: unknown;
  failure?: { stepIndex: number; pattern: string; mode: string; screenExcerpt: string };
  [key: string]: unknown;
}

describe('sqlite3 example through MCP', () => {
  const dirs: string[] = [];
  const open: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const received: string[] = [];
  /** Looks like a secret; put in the environment of every server: it must not appear in any artifact or answer. */
  const CANARY = `canary-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  async function tempDir(prefix: string, inWorkspace = false): Promise<string> {
    const dir = await mkdtemp(join(inWorkspace ? workspaceRoot : tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** Compile a workflow file into a folder of the workspace (where the server finds node_modules). */
  async function compileFile(file: string, prefix: string): Promise<string> {
    const outDir = await tempDir(prefix, true);
    const log = console.log;
    console.log = () => { };
    try {
      await compile(file, outDir);
    } finally {
      console.log = log;
    }
    return outDir;
  }

  async function connect(outDir: string, cwd: string, env: Record<string, string> = {}) {
    const client = new Client({ name: 'cli-sqlite', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outDir, 'mcp-server.js')],
      cwd,
      env: { ...(process.env as Record<string, string>), ...ISOLATED_VAULT_ENV, DAEMONIZE_SECRET_CANARY: CANARY, DAEMONIZE_COOKIE: CANARY, ...env },
    });
    await client.connect(transport);
    open.push({ client, transport });
    return {
      client,
      tools: (await client.listTools()).tools,
      async call(name: string, args: Record<string, unknown> = {}) {
        const startedAt = Date.now();
        const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
        const text = (response.content as Array<{ text: string }>)[0].text;
        received.push(text);
        let result: Result = { success: false };
        try {
          result = JSON.parse(text) as Result;
        } catch {
          // an input refused by the schema is plain text, not a replay result
        }
        return { response, text, result, tookMs: Date.now() - startedAt };
      },
    };
  }

  afterAll(async () => {
    for (const { client, transport } of open) await closeClient(client, transport);
    for (const dir of dirs) await removeDir(dir);
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('the committed workflow file (no sqlite3 needed)', () => {
    let set: WorkflowSet;
    let outDir: string;
    let dbDir: string;
    let server: Awaited<ReturnType<typeof connect>>;
    const INJECTION = `'); drop table notes;--`;

    beforeAll(async () => {
      set = JSON.parse(readFileSync(committedFile, 'utf8')) as WorkflowSet;
      outDir = await compileFile(committedFile, '.cli-sqlite-static-');
      dbDir = await tempDir('daemonize-sqlite-db-');
      server = await connect(outDir, dbDir);
    });

    it('has the three tools of the example, the Variables with their pattern, and the real prompt as screen wait', () => {
      expect(set.workflows.map((w) => w.label)).toEqual(['add_note', 'list_notes', 'count_notes']);
      expect(set.startCommand).toEqual(['sqlite3', script.DB_FILE]);
      expect(set.sandbox).toMatchObject({ packages: ['sqlite3'], workdir: script.CONTAINER_DIR });
      expect(set.sandbox?.network).toBeUndefined(); // the default of a terminal program: none

      const add = set.workflows[0];
      expect(add.variables.map((v) => v.name)).toEqual(['title', 'body']);
      for (const variable of add.variables) {
        expect(variable).toMatchObject({ pattern: script.VALUE_PATTERN, maxLength: 80 });
      }
      for (const workflow of set.workflows) {
        expect([workflow.cols, workflow.rows]).toEqual([script.COLS, script.ROWS]); // the size is recorded
        const enters = workflow.steps.filter((s) => s.actionType === 'keypress');
        expect(enters.length).toBeGreaterThan(0);
        for (const enter of enters) {
          expect(enter.waitFor).toMatchObject({ pattern: '^sqlite>$', mode: 'appear' });
        }
        expect(workflow.finalZone?.rect).toBeDefined();
        expect(workflow.resultZone?.extractor?.kind).toBe('regex');
      }
      expect(set.workflows.map((w) => w.steps.some((s) => s.risk === 'write'))).toEqual([true, false, false]);
    });

    it('types no literal other than the documented SQL, and no secret exists in the file', () => {
      for (const workflow of set.workflows) {
        for (const step of workflow.steps.filter((s) => s.actionType === 'type')) {
          if (step.variable !== undefined) {
            expect(Object.values(script.SAMPLE)).toContain(step.value);
          } else {
            expect(script.CONSTANT_TEXTS).toContain(step.value);
          }
        }
        expect(workflow.secrets ?? []).toEqual([]);
        expect(workflow.steps.some((s) => s.secretRef !== undefined)).toBe(false);
      }
    });

    it('describes the Variables with a pattern and a maximum length in the input schema', () => {
      const add = server.tools.find((t) => t.name === 'add_note')!;
      const schema = add.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
      expect(schema.required.sort()).toEqual(['body', 'title']);
      // maxLength is enforced by the server (the 81-character case below) but zod does not export it; the pattern says {1,80} as well
      expect(schema.properties.title).toMatchObject({ type: 'string', pattern: script.VALUE_PATTERN });
      expect(schema.properties.body).toMatchObject({ type: 'string', pattern: script.VALUE_PATTERN });
      expect(server.tools.map((t) => t.name).sort()).toEqual(['add_note', 'count_notes', 'list_notes']);
    });

    it.each([
      ['a quote and a statement (SQL injection through the title)', { title: INJECTION, body: 'fine' }, /title/],
      ['a quote and a statement (SQL injection through the body)', { title: 'fine', body: INJECTION }, /body/],
      ['a semicolon alone', { title: 'a;b', body: 'fine' }, /title/],
      ['a backslash', { title: 'fine', body: 'a\\b' }, /body/],
      ['a newline (a second statement)', { title: 'fine', body: 'a\n.shell calc' }, /body/],
      ['an empty value', { title: '', body: 'fine' }, /title/],
      ['a value of 81 characters', { title: 'a'.repeat(81), body: 'fine' }, /title/],
      ['a missing Variable', { title: 'fine' }, /body/],
      ['a number instead of text', { title: 5, body: 'fine' }, /title/],
    ])('refuses %s before any replay', async (_name, args, field) => {
      const started = Date.now();
      const refused = await server.call('add_note', args as Record<string, unknown>);

      expect(refused.response.isError).toBe(true);
      expect(refused.text).toMatch(field);
      expect(refused.text).not.toMatch(/step_failed|pattern_timeout|screenType/); // no replay ran
      expect(existsSync(join(dbDir, script.DB_FILE))).toBe(false); // sqlite3 never started
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('fails strictly with the pattern diagnostic when the program never prints the prompt', async () => {
      const TIMEOUT_MS = 1500;
      const dir = await tempDir('daemonize-sqlite-fake-');
      const fake = join(dir, 'fake-sqlite3.mjs');
      // Prints a banner like sqlite3 does, then reads its input forever without ever showing `sqlite> `
      await writeFile(fake, "console.log('SQLite version 0.0 (a program that never prints its prompt)');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n");
      const broken = structuredClone(set);
      broken.startCommand = [process.execPath, fake];
      for (const workflow of broken.workflows) {
        for (const step of workflow.steps) if (step.waitFor !== undefined) step.waitFor.timeoutMs = TIMEOUT_MS;
      }
      const file = join(dir, 'daemonize.workflows.json');
      await writeFile(file, JSON.stringify(broken, null, 2));
      const brokenServer = await connect(await compileFile(file, '.cli-sqlite-fake-'), dir);

      const { result, tookMs } = await brokenServer.call('list_notes');

      expect(result).toMatchObject({ success: false, error: 'pattern_timeout', drifted: true });
      // `.mode json` is step 0, its Enter step 1 waits for the prompt
      expect(result.failure).toMatchObject({ stepIndex: 1, pattern: '^sqlite>$', mode: 'appear' });
      expect(result.failure?.screenExcerpt).toContain('never prints its prompt');
      expect(tookMs).toBeLessThan(TIMEOUT_MS + 6000);
    });

    it('leaves no secret, cookie or environment value in the file, the compiled artifacts or the answers', async () => {
      const secretLike = Object.entries(process.env)
        .filter(([name, value]) => /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|COOKIE|CREDENTIAL)/i.test(name) && (value ?? '').length >= 8)
        .map(([, value]) => value as string);
      const found = await scanForValues(outDir, [CANARY, ...secretLike], { skipDirs: ['node_modules', '.git'] });
      expect(found.map((m) => m.file), 'artifacts').toEqual([]);
      expect((await scanForValues(exampleDir, [CANARY, ...secretLike], { skipDirs: ['node_modules', 'out'] })).map((m) => m.file), 'example folder').toEqual([]);
      expect(received.join('\n')).not.toContain(CANARY);
      expect(readFileSync(committedFile, 'utf8')).not.toMatch(/Bearer |password|cookie|secretRef/i);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  /** The behaviour every path must show: the same workflows, the same database, through MCP. */
  function behaviour(mode: () => { outDir: string; dbDir: string; connect: () => Promise<Awaited<ReturnType<typeof connect>>>; recorded: Awaited<ReturnType<Script['recordSqliteWorkflows']>> }): void {
    let server: Awaited<ReturnType<typeof connect>>;
    beforeAll(async () => {
      server = await mode().connect();
    });

    it('recorded each workflow with the real prompt as wait and the size of the terminal', () => {
      const { recorded } = mode();
      expect(recorded).toHaveLength(3);
      // One wait for the prompt after each Enter: 4 in add_note, 2 in the two reads
      expect(recorded.map((s) => s.screenWaits)).toEqual([4, 2, 2]);
      for (const summary of recorded) expect([summary.cols, summary.rows]).toEqual([script.COLS, script.ROWS]);
      expect(recorded[0].variables).toEqual(['title', 'body']);
    });

    it('reads nothing from a database that does not exist yet, and says so', async () => {
      const { result, text } = await server.call('list_notes');

      expect(result, text).toMatchObject({ success: false, drifted: true });
      expect(String(result.error)).toBe('result_zone_not_found'); // the table is missing: no row to read
    });

    it('add_note writes a row; list_notes then returns it as structured data, with no drift', async () => {
      const first = await server.call('add_note', { title: 'First note', body: 'Hello from MCP' });
      expect(first.result, first.text.slice(0, 1500)).toMatchObject({ success: true, drifted: false, data: { id: '1' } });

      const second = await server.call('add_note', { title: 'Second, note.', body: 'a_b-c 2' });
      expect(second.result, second.text.slice(0, 1500)).toMatchObject({ success: true, drifted: false, data: { id: '2' } });

      const listed = await server.call('list_notes');
      expect(listed.result, listed.text.slice(0, 1500)).toMatchObject({ success: true, drifted: false });
      // Newest first, one object per row; the values are the ones that were sent
      expect(listed.result.data).toEqual([
        { id: '2', title: 'Second, note.', body: 'a_b-c 2' },
        { id: '1', title: 'First note', body: 'Hello from MCP' },
      ]);

      // The calls are independent: every call started its own sqlite3, the state is the file
      expect(existsSync(join(mode().dbDir, script.DB_FILE))).toBe(true);
      expect(statSync(join(mode().dbDir, script.DB_FILE)).size).toBeGreaterThan(0);
    });

    it('count_notes returns the number of rows as data', async () => {
      const counted = await server.call('count_notes');
      expect(counted.result, counted.text.slice(0, 1500)).toMatchObject({ success: true, drifted: false, data: { notes: '2' } });
    });

    it('refuses an injection and an invalid payload before any replay, and the table is intact', async () => {
      const injected = await server.call('add_note', { title: `'); drop table notes;--`, body: 'x' });
      expect(injected.response.isError).toBe(true);
      expect(injected.text).not.toMatch(/step_failed|screenType/);

      const missing = await server.call('add_note', { title: 'only a title' });
      expect(missing.response.isError).toBe(true);

      const tooLong = await server.call('add_note', { title: 'x'.repeat(81), body: 'y' });
      expect(tooLong.response.isError).toBe(true);

      const counted = await server.call('count_notes');
      expect(counted.result.data).toEqual({ notes: '2' });
    });

    it('stores a value with a space and the characters . , _ - as it is, and keeps only 5 rows in the listing', async () => {
      for (let i = 3; i <= 7; i++) {
        const added = await server.call('add_note', { title: `Note ${i}`, body: `Body ${i}.` });
        expect(added.result, added.text.slice(0, 800)).toMatchObject({ success: true, data: { id: String(i) } });
      }
      const listed = await server.call('list_notes');
      const rows = listed.result.data as Array<{ id: string; title: string }>;
      expect(rows.map((r) => r.id)).toEqual(['7', '6', '5', '4', '3']); // limit 5, newest first
      expect(rows[0]).toEqual({ id: '7', title: 'Note 7', body: 'Body 7.' });
      expect((await server.call('count_notes')).result.data).toEqual({ notes: '7' });
    });

    it('keeps the longest accepted values on one line (80 + 80 characters)', async () => {
      const title = `T${'a'.repeat(79)}`;
      const body = `B${'b'.repeat(79)}`;
      const added = await server.call('add_note', { title, body });
      expect(added.result, added.text.slice(0, 800)).toMatchObject({ success: true, drifted: false, data: { id: '8' } });
      const listed = await server.call('list_notes');
      expect((listed.result.data as Array<Record<string, string>>)[0]).toEqual({ id: '8', title, body });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  describe.skipIf(!hostReady)('on this machine (a sqlite3 of 3.33 or later on the PATH)', () => {
    let context: Parameters<typeof behaviour>[0] extends () => infer C ? C : never;

    beforeAll(async () => {
      const dbDir = await tempDir('daemonize-sqlite-host-');
      const recordedFile = join(await tempDir('daemonize-sqlite-rec-'), 'daemonize.workflows.json');
      const log = console.log;
      console.log = () => { };
      let recorded;
      try {
        recorded = await script.recordSqliteWorkflows({ recordTui, out: recordedFile, docker: false, log: () => { } });
      } finally {
        console.log = log;
      }
      const outDir = await compileFile(recordedFile, '.cli-sqlite-host-');
      context = { outDir, dbDir, recorded, connect: () => connect(outDir, dbDir) };
    });

    behaviour(() => context);
  });

  if (!hostReady) {
    it.skip(`Host replay of sqlite3: skipped, no sqlite3 >= 3.33 on the PATH (${host === undefined ? 'sqlite3 not found' : `found ${host.version}`}); install it or use DAEMONIZE_DOCKER_TESTS=1`, () => { });
  }

  // ---------------------------------------------------------------------------------------------------------------
  describe.skipIf(!dockerEnabled)('in a Docker container with the sqlite3 package (DAEMONIZE_DOCKER_TESTS=1)', () => {
    const tag = 'daemonize-test-cli-sqlite';
    let context: Parameters<typeof behaviour>[0] extends () => infer C ? C : never;
    let outDir: string;

    beforeAll(async () => {
      const dbDir = await tempDir('daemonize-sqlite-docker-');
      const recordedFile = join(await tempDir('daemonize-sqlite-rec-docker-'), 'daemonize.workflows.json');
      // The recording itself runs the real sqlite3 of a throw-away container (there may be none on this machine)
      const recorded = await script.recordSqliteWorkflows({ recordTui, out: recordedFile, docker: true, log: () => { } });
      // The recorded file holds `sandbox.packages: ['sqlite3']` and `workdir: /data`; `compile --sandbox-package sqlite3` says it again
      const log = console.log;
      console.log = () => { };
      outDir = await tempDir('.cli-sqlite-docker-', true);
      try {
        await compile(recordedFile, outDir, { sandbox: { packages: ['sqlite3'] } });
        await buildSandboxImage(outDir, { tag, log: () => { } });
      } finally {
        console.log = log;
      }
      context = {
        outDir,
        dbDir,
        recorded,
        connect: () =>
          connect(outDir, workspaceRoot, {
            DAEMONIZE_SANDBOX: 'docker',
            DAEMONIZE_SANDBOX_IMAGE: tag,
            DAEMONIZE_SANDBOX_MOUNTS: JSON.stringify([`${dbDir}:${script.CONTAINER_DIR}`]),
          }),
      };
    });

    afterAll(() => {
      spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
    });

    behaviour(() => context);

    it('runs the program as an unprivileged user, with no network, on a mounted folder only', async () => {
      const uid = spawnSync('docker', ['run', '--rm', '--entrypoint', 'id', tag, '-u'], { encoding: 'utf8' });
      expect(Number(uid.stdout.trim()), uid.stderr).toBeGreaterThan(0);
      const version = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sqlite3', tag, '--version'], { encoding: 'utf8' });
      expect(version.stdout, version.stderr).toMatch(/^3\.\d+\.\d+/);

      const module = (await import(/* @vite-ignore */ pathToFileURL(join(outDir, 'docker-replay.js')).href)) as {
        buildDockerArgs(options: { name: string; timeoutEnv: string[]; steps: unknown[] }): string[];
      };
      const args = module.buildDockerArgs({ name: 'daemonize-cli-sqlite-probe', timeoutEnv: [], steps: [] });
      expect(args[args.indexOf('--network') + 1]).toBe('none');
      expect(args).toContain('-w');
      expect(args[args.indexOf('-w') + 1]).toBe(script.CONTAINER_DIR);
      expect(args).toContain('--cap-drop');
    });

    // What the real shell does that a hand-made fixture does not: the `   ...> ` continuation prompt, `.mode column` with
    // aligned columns, the bracketed-paste and cursor sequences of the line editor, and a statement echoed over two lines.
    describe('shell features that stress the recorder (real sqlite3, in memory)', () => {
      const shellTag = `${tag}-shell`;
      let shell: Awaited<ReturnType<typeof connect>>;
      let set: WorkflowSet;

      afterAll(() => {
        spawnSync('docker', ['rmi', shellTag], { stdio: 'ignore' });
      });

      beforeAll(async () => {
        const dir = await tempDir('daemonize-sqlite-shell-');
        const file = join(dir, 'daemonize.workflows.json');
        const command = ['docker', 'run', '--rm', '-it', '--network', 'none', script.ensureRecordImage(() => { }), 'sqlite3', ':memory:'];
        const record = async (label: string, drive: (t: ReturnType<Script['scriptedTerminal']>) => Promise<void>) => {
          const t = script.scriptedTerminal();
          const recording = recordTui({
            command,
            startCommand: ['sqlite3', ':memory:'],
            name: 'sqlite shell',
            label,
            out: file,
            cols: script.COLS,
            rows: script.ROWS,
            input: t.input,
            output: t.output,
            sandbox: { packages: ['sqlite3'] },
            ...(label === 'column_table'
              ? { resultRegex: '^(?<id>\\d+)\\s+(?<name>\\S.*?)\\s*$', resultRegexFlags: 'gm' }
              : { resultRegex: label === 'slow_count' ? '"total":(?<total>\\d+)' : '"one":(?<one>\\d+)' }),
          });
          await Promise.all([recording, drive(t)]);
        };
        await record('split_statement', async (t) => {
          await t.prompt();
          await t.line('.mode json');
          await t.line('select 1'); // no semicolon: sqlite3 shows its continuation prompt
          await t.line('as one;');
          await t.end();
        });
        await record('column_table', async (t) => {
          await t.prompt();
          await t.line('.mode column');
          await t.line('.headers on');
          await t.line("create table k(id integer, name text); insert into k values (1,'alpha beta'),(22,'gamma');");
          await t.line('select * from k;');
          await t.end();
        });
        await record('slow_count', async (t) => {
          await t.prompt();
          await t.line('.mode json');
          // About a second of work: the prompt of the PREVIOUS statement is still on screen while this one runs
          await t.line('with recursive c(x) as (select 1 union all select x+1 from c where x < 3000000) select count(*) as total from c;');
          await t.end();
        });
        set = JSON.parse(readFileSync(file, 'utf8')) as WorkflowSet;
        const out = await compileFile(file, '.cli-sqlite-shell-');
        shell = await connect(out, workspaceRoot, { DAEMONIZE_SANDBOX: 'docker', DAEMONIZE_SANDBOX_IMAGE: tag });
        await buildSandboxImage(out, { tag, log: () => { } });
      });

      it('recorded the continuation prompt as the wait of the Enter that did not end the statement', () => {
        const steps = set.workflows.find((w) => w.label === 'split_statement')!.steps;
        expect(steps.map((s) => s.value)).toEqual(['.mode json', 'Enter', 'select 1', 'Enter', 'as one;', 'Enter']);
        expect(steps[1].waitFor?.pattern).toBe('^sqlite>$');
        expect(steps[3].waitFor?.pattern).toBe('^   \\.\\.\\.>$'); // the three leading spaces are part of the prompt
        expect(steps[5].waitFor?.pattern).toBe('^sqlite>$');
      });

      it('replays the statement written on two lines', async () => {
        const { result, text } = await shell.call('split_statement');

        expect(result, text.slice(0, 1500)).toMatchObject({ success: true, drifted: false, data: { one: '1' } });
        expect(result.text).toContain('...> as one;');
      });

      it('waits for the output of a slow statement, not for the prompt of the previous one', async () => {
        const { result, text, tookMs } = await shell.call('slow_count');

        expect(result, text.slice(0, 1500)).toMatchObject({ success: true, drifted: false, data: { total: '3000000' } });
        expect(tookMs).toBeLessThan(60000);
      });

      it('reads the aligned columns of .mode column as rows', async () => {
        const { result, text } = await shell.call('column_table');

        expect(result, text.slice(0, 1500)).toMatchObject({ success: true, drifted: false });
        expect(result.text).toMatch(/^id\s+name$/m);
        expect(result.text).toMatch(/^--\s+-+$/m);
        expect(result.data).toEqual([
          { id: '1', name: 'alpha beta' },
          { id: '22', name: 'gamma' },
        ]);
      });
    });

    it('keeps the compiled project and the Dockerfile free of secrets and installs sqlite3 from the sandbox block', () => {
      const dockerfile = readFileSync(join(outDir, 'sandbox', 'Dockerfile'), 'utf8');
      expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends sqlite3/);
      expect(dockerfile).toMatch(/^USER node$/m);
      expect(dockerfile).not.toContain(CANARY);
    });
  });

  if (!dockerEnabled) {
    it.skip('Docker replay of sqlite3: skipped, set DAEMONIZE_DOCKER_TESTS=1 (needs a running Docker daemon, the node:20 image and the Debian package mirror)', () => { });
  }
});
