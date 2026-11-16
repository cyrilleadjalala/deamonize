#!/usr/bin/env node
/**
 * Records the sqlite3 workflows of this example, without any manual typing.
 *
 * It drives the Daemonize terminal recorder (`recordTui`) like a person at the keyboard: the real `sqlite3` shell runs in a
 * pseudo-terminal, the script sends keystrokes to the recorder's input, waits for the `sqlite> ` prompt like a person
 * would, and uses the `Ctrl+]` menu (`v` = make the last typed text a variable) to name the values that change at every
 * call. Nothing is simulated: the program is the sqlite3 of this machine, or the one of a throw-away Docker container.
 *
 *   npm run build                                       # once: this script uses dist/
 *   node examples/cli-sqlite/record-workflows.mjs       # writes examples/cli-sqlite/daemonize.workflows.json
 *
 * Options (all optional):
 *   --out <file>      workflow file (default examples/cli-sqlite/daemonize.workflows.json); it is replaced
 *   --docker          record inside a throw-away container (image `daemonize-example-sqlite`, built when missing)
 *                     instead of the sqlite3 on this machine. Without this flag the script uses the sqlite3 of the PATH and
 *                     falls back to Docker when there is none.
 *
 * Workflows (the program is `sqlite3 notes.db`: the database file is `notes.db` in the working directory of the replay):
 *   add_note(title, body)   create the table when missing, insert a row, return the id of the new row        (write)
 *   list_notes()            return the 5 newest rows as `data` (JSON mode); needs a table with rows            (read)
 *   count_notes()           return the number of rows as `data`; needs the table, so run add_note first    (read)
 *
 * About the Variables. The recorder turns a WHOLE typed text into a Variable. A value inside an SQL statement is therefore
 * typed as separate pieces, with the `Ctrl+]` menu between them:
 *
 *     insert into notes(title, body) values ('     <- constant text of the statement
 *     <title>                                      <- Variable `title`
 *     ', '                                         <- constant
 *     <body>                                       <- Variable `body`
 *     ');  + Enter                                 <- constant
 *
 * The replay types the pieces one after the other, so the Variable is pasted into the SQL text as it is: a value with a
 * quote would end the string and let a caller add SQL (`'); drop table notes;--`). That is why the recorder can not be
 * trusted alone: after recording, this script writes a `pattern` and a `maxLength` on each Variable in the workflow file
 * (see VALUE_PATTERN), and the generated server refuses any other value BEFORE anything is replayed.
 */
import { readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_OUT = resolve(here, 'daemonize.workflows.json');
/** Name of the database file, in the working directory of the program. */
export const DB_FILE = 'notes.db';
/** Where the folder of the database is in the container of the sandbox (mount it with `serve --mount <host folder>:/data`). */
export const CONTAINER_DIR = '/data';
/** The image of the recording container (the replay image is built by `compile` + `sandbox build`). */
export const RECORD_IMAGE = 'daemonize-example-sqlite';

/**
 * What a value of a Variable may be: letters, digits, space and `. , _ -`, 1 to 80 characters. No quote, semicolon, backslash,
 * parenthesis or control character: the value can not leave the SQL string it is typed in.
 */
export const VALUE_PATTERN = '^[A-Za-z0-9 .,_-]{1,80}$';
export const VALUE_MAX_LENGTH = 80;

/** The terminal is wide: a statement with two 80-character values must not wrap, or the rows of the screen move. */
export const COLS = 300;
export const ROWS = 40;

/** Every text typed into sqlite3 that is not a Variable: the only literals of the workflow file. */
export const CREATE_TABLE = 'create table if not exists notes(id integer primary key, title text, body text);';
export const INSERT_PREFIX = "insert into notes(title, body) values ('";
export const INSERT_MIDDLE = "', '";
export const INSERT_SUFFIX = "');";
export const SET_JSON_MODE = '.mode json';
export const LAST_ID = 'select last_insert_rowid() as id;';
export const SELECT_NOTES = 'select id, title, body from notes order by id desc limit 5;';
export const SELECT_COUNT = 'select count(*) as notes from notes;';
export const QUIT = '.quit';
export const CONSTANT_TEXTS = [CREATE_TABLE, INSERT_PREFIX, INSERT_MIDDLE, INSERT_SUFFIX, SET_JSON_MODE, LAST_ID, SELECT_NOTES, SELECT_COUNT, QUIT];

/** The sample values typed while recording; they are the defaults of the Variables, nothing secret. */
export const SAMPLE = { title: 'Sample title', body: 'Sample body' };

/** The prompt of sqlite3 (or its continuation prompt    ...> ) at the end of what the program printed (escape sequences of the terminal may follow it). */
const PROMPT_AT_END = /(?:sqlite>| {3}\.\.\.>)(?: |\x1b\[\d*C)(?:\x1b\[[?0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*$/;

/** A terminal the recorder reads from and writes to: what a person's keyboard and screen are, as streams. */
export function scriptedTerminal() {
  const input = new PassThrough();
  input.setEncoding('utf8');
  let shown = '';
  let lastWrite = Date.now();
  const output = {
    write(data) {
      shown += data;
      lastWrite = Date.now();
    },
    columns: COLS,
    rows: ROWS,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const terminal = {
    input,
    output,
    /** Keystrokes of the person. */
    type: (bytes) => input.write(bytes),
    /** Wait until the program shows its prompt again (and has been quiet for a moment), like a person reading the screen. */
    async prompt(timeoutMs = 20000, from = 0) {
      const startedAt = Date.now();
      for (;;) {
        if (shown.length > from && PROMPT_AT_END.test(shown) && Date.now() - lastWrite >= 250) return;
        if (Date.now() - startedAt > timeoutMs) throw new Error(`The sqlite> prompt did not come back; the screen ended with ${JSON.stringify(shown.slice(-200))}`);
        await sleep(25);
      }
    },
    get length() {
      return shown.length;
    },
    /** The `Ctrl+]` menu, then one key. */
    async menu(key) {
      input.write('\x1d');
      await sleep(40);
      input.write(key);
      await sleep(60);
    },
    /** Type a line and press Enter, then wait for the prompt. */
    async line(text) {
      const from = shown.length;
      input.write(text);
      await sleep(40);
      input.write('\r');
      await terminal.prompt(20000, from);
    },
    /** Type a piece of a statement without pressing Enter; the next menu key makes it a step. */
    async piece(text) {
      input.write(text);
      await sleep(60);
    },
    /** `Ctrl+] v`, the name of the Variable (the menu suggests one from the prompt: it is erased first), Enter. */
    async makeVariable(name) {
      await terminal.menu('v');
      input.write('\x7f'.repeat(120));
      await sleep(40);
      input.write(name);
      await sleep(40);
      input.write('\r');
      await sleep(60);
    },
    /** `Ctrl+] e`: end the recording. */
    async end() {
      await terminal.menu('e');
    },
    sleep,
    screenTail: () => shown.slice(-400),
  };
  return terminal;
}

/**
 * The three sessions. `finalRect` is the part of the final screen the drift check hashes: rows that do not depend on the
 * data (the banner of sqlite3, the echo of the typed statements, the last prompt). The rows are the ones of the screen when
 * the recorder ends; they stay the same at every call because each call starts a new sqlite3.
 */
/** Rows 0 to 3 of a read workflow: the banner, its hint, the echo of .mode json and the echo of the query. The rows after that hold the data. */
const LISTING_RECT = { row: 0, col: 0, rows: 4, cols: 120 };

export const SESSIONS = [
  {
    label: 'add_note',
    description: 'Add a note to the database (a write)',
    // banner (2 rows), create table, insert, .mode json, select last id, the answer, the prompt = row 7
    finalRect: { row: 7, col: 0, rows: 1, cols: 40 },
    resultRegex: '"id":(?<id>\\d+)',
    async drive(t) {
      await t.prompt();
      await t.line(CREATE_TABLE);
      await t.piece(INSERT_PREFIX);
      await t.menu('c');
      await t.piece(SAMPLE.title);
      await t.makeVariable('title');
      await t.piece(INSERT_MIDDLE);
      await t.menu('c');
      await t.piece(SAMPLE.body);
      await t.makeVariable('body');
      await t.piece(INSERT_SUFFIX);
      await t.line('');
      await t.line(SET_JSON_MODE);
      await t.line(LAST_ID);
      await t.end();
    },
  },
  {
    label: 'list_notes',
    description: 'List the 5 newest notes (a read)',
    finalRect: LISTING_RECT,
    resultRegex: '\\{"id":(?<id>\\d+),"title":"(?<title>[^"]*)","body":"(?<body>[^"]*)"\\}',
    resultRegexFlags: 'gm',
    async drive(t) {
      await t.prompt();
      await t.line(SET_JSON_MODE);
      await t.line(SELECT_NOTES);
      await t.end();
    },
  },
  {
    label: 'count_notes',
    description: 'Count the notes (a read)',
    finalRect: LISTING_RECT,
    resultRegex: '"notes":(?<notes>\\d+)',
    async drive(t) {
      await t.prompt();
      await t.line(SET_JSON_MODE);
      await t.line(SELECT_COUNT);
      await t.end();
    },
  },
];

/** Is a sqlite3 program on the PATH of this machine, and which version? */
export function hostSqlite() {
  const run = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return undefined;
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(run.stdout.trim());
  return version ? { version: run.stdout.trim().split(' ')[0], major: Number(version[1]), minor: Number(version[2]) } : undefined;
}

/** `.mode json` needs sqlite 3.33. */
export function supportsJsonMode(info) {
  return info !== undefined && (info.major > 3 || (info.major === 3 && info.minor >= 33));
}

/** Build the image used to record in a container: Debian with the sqlite3 package. Does nothing when it exists. */
export function ensureRecordImage(log = console.log) {
  if (spawnSync('docker', ['image', 'inspect', RECORD_IMAGE], { stdio: 'ignore' }).status === 0) return RECORD_IMAGE;
  log(`Building the image ${RECORD_IMAGE} (node:20 + the sqlite3 package) ...`);
  const dockerfile = ['FROM node:20', 'RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*', ''].join('\n');
  const build = spawnSync('docker', ['build', '-t', RECORD_IMAGE, '-'], { input: dockerfile, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`docker build of ${RECORD_IMAGE} failed: ${build.stderr || build.stdout}`);
  return RECORD_IMAGE;
}

/**
 * Record the three workflows into `out` (replaced).
 *
 * @param recordTui  the `recordTui` function of Daemonize (`dist/cli/commands/record-tui.js`); a parameter so that tests can give the TypeScript source
 * @param docker     record in a throw-away container instead of with the sqlite3 of this machine
 * @param extra      other options for `recordTui`, e.g. `sandbox`
 */
export async function recordSqliteWorkflows({ recordTui, out = DEFAULT_OUT, docker = false, log = console.log, extra = {} }) {
  await rm(out, { force: true });
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-sqlite-'));
  await chmod(dir, 0o777).catch(() => {});
  const startCommand = ['sqlite3', DB_FILE];
  const command = docker
    ? ['docker', 'run', '--rm', '-it', '--network', 'none', '-v', `${dir}:${CONTAINER_DIR}`, '-w', CONTAINER_DIR, ensureRecordImage(log), ...startCommand]
    : startCommand;
  const summaries = [];
  try {
    for (const session of SESSIONS) {
      log(`Recording ${session.label} ...`);
      const terminal = scriptedTerminal();
      const recording = recordTui({
        command,
        startCommand,
        cwd: docker ? undefined : dir,
        name: 'sqlite',
        label: session.label,
        out,
        cols: COLS,
        rows: ROWS,
        input: terminal.input,
        output: terminal.output,
        finalRect: session.finalRect,
        resultRegex: session.resultRegex,
        resultRegexFlags: session.resultRegexFlags,
        ...extra,
      });
      // A failure of the script must not leave the program running and the recorder waiting
      const driven = session.drive(terminal).catch((error) => {
        terminal.type('\x1d');
        terminal.type('e');
        throw error;
      });
      const [summary] = await Promise.all([recording, driven]);
      summaries.push(summary);
      log(`  ${summary.steps} steps, variables: ${summary.variables.join(', ') || '-'}, waits: ${summary.screenWaits}`);
    }
    await editWorkflowFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return summaries;
}

/**
 * What the recorder can not know, said in the file as a person editing it would: how a call may fill each Variable (the
 * pattern that keeps SQL out of it), what each tool does, which workflows only read, where the program keeps its file.
 */
async function editWorkflowFile(out) {
  const set = JSON.parse(await readFile(out, 'utf8'));
  const describe = {
    title: 'Title of the note: letters, digits, spaces and . , _ - only (1 to 80 characters)',
    body: 'Text of the note: letters, digits, spaces and . , _ - only (1 to 80 characters)',
  };
  for (const workflow of set.workflows) {
    for (const variable of workflow.variables) {
      variable.description = describe[variable.name];
      variable.pattern = VALUE_PATTERN;
      variable.maxLength = VALUE_MAX_LENGTH;
    }
    for (const step of workflow.steps) {
      // The recorder labels a step with the screen line before it, which holds the SQL typed so far
      if (step.variable !== undefined) step.label = `Type ${step.variable}`;
      else if (step.actionType === 'type') step.label = `Type "${step.value}"`;
    }
    // The recorder can not tell what a statement does: only the INSERT of add_note writes, everything else reads
    const insertAt = workflow.steps.findIndex((s) => s.value === INSERT_SUFFIX);
    workflow.steps.forEach((step, i) => {
      step.risk = workflow.label === 'add_note' && i <= insertAt + 1 ? 'write' : 'read';
    });
  }
  // Where the file of the database is: a folder of the host mounted in the container, the working directory on the host
  set.sandbox = { ...set.sandbox, packages: [...new Set([...(set.sandbox?.packages ?? []), 'sqlite3'])], workdir: CONTAINER_DIR };
  await writeFile(out, `${JSON.stringify(set, null, 2)}\n`);
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { recordTui } = await import(pathToFileURL(resolve(here, '../../dist/cli/commands/record-tui.js')).href).catch(() => {
    throw new Error('dist/ is missing: run "npm run build" in the repository root first');
  });
  const host = hostSqlite();
  const docker = process.argv.includes('--docker') || host === undefined;
  if (!docker && !supportsJsonMode(host)) {
    console.error(`sqlite3 ${host?.version} is too old: .mode json needs 3.33 or later. Use --docker.`);
    process.exit(1);
  }
  console.log(docker ? 'Recording in a Docker container.' : `Recording with the sqlite3 ${host.version} of this machine.`);
  recordSqliteWorkflows({ recordTui, out: resolve(option('out', DEFAULT_OUT)), docker }).then(
    () => console.log('Done.'),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
