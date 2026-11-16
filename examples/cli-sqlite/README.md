# Example: the real `sqlite3` shell

Proof of Daemonize on a **real command line program that we did not write**: the `sqlite3` shell
(3.40.1 from Debian bookworm when this was written). Three tools are recorded from a session in the real shell,
compiled to an MCP server and replayed, each call in its own `sqlite3` process.

| Tool                       | Variables       | Risk  | Returns                                                       |
| -------------------------- | --------------- | ----- | ------------------------------------------------------------- |
| `add_note(title, body)`    | `title`, `body` | write | `data`: `{ "id": "<new id>" }` (from `last_insert_rowid()`)    |
| `list_notes()`             | none            | read  | `data`: the 5 newest rows, `[{ "id", "title", "body" }, ...]`  |
| `count_notes()`            | none            | read  | `data`: `{ "notes": "<number of rows>" }`                      |

The program is `sqlite3 notes.db`. **The state is the file `notes.db`** in the working directory of the program:
every call starts a new `sqlite3`, so `add_note` followed by `list_notes` shows the note only because the file persists.

- On this machine the file is in the working directory of the server (`daemonize serve` runs it in the output folder; give it
  another one by starting `node out/mcp-server.js` from that folder).
- In the Docker sandbox the working directory is `/data` (`sandbox.workdir` of the workflow file) and you mount a folder of the
  host there: `daemonize serve out --sandbox docker --mount /path/to/folder:/data`. The container has **no network**
  (the default of a terminal program), runs as the unprivileged user `node`, and sees nothing else of the host.

`list_notes` and `count_notes` only read: they need the table, which `add_note` creates on its first call
(`create table if not exists`). Before that, `list_notes` fails with `result_zone_not_found` (the shell prints
`Parse error: no such table: notes`, no row matches the result pattern).

## Record, compile, run

```sh
npm run build                                   # the script uses dist/

# 1. Record. With a sqlite3 >= 3.33 on the PATH it is used; otherwise (or with --docker) the recording runs the sqlite3 of a
#    throw-away container (image daemonize-example-sqlite = node:20 + the sqlite3 package, built once).
node examples/cli-sqlite/record-workflows.mjs [--docker]

# 2. Compile (examples/cli-sqlite/out/ is git-ignored). The file already says `sandbox.packages: ["sqlite3"]`; the flag adds it again if you wish.
node dist/cli/index.js compile examples/cli-sqlite/daemonize.workflows.json --out examples/cli-sqlite/out --sandbox-package sqlite3

# 3a. Run on this machine (needs sqlite3 on the PATH), the database is ./notes.db of the folder you start it from
node examples/cli-sqlite/out/mcp-server.js

# 3b. Or in Docker: build the image (installs sqlite3), then serve with the folder of the database mounted
node dist/cli/index.js sandbox build examples/cli-sqlite/out
node dist/cli/index.js serve examples/cli-sqlite/out --sandbox docker --mount "$PWD/db:/data"
```

`tests/integration/cli-sqlite-e2e.test.ts` does all of it: `npx vitest run tests/integration/cli-sqlite-e2e.test.ts`
(the host part runs only when `sqlite3` is on the PATH, the Docker part only with `DAEMONIZE_DOCKER_TESTS=1`;
the checks that need no sqlite3 always run).

## How the session is recorded

`record-workflows.mjs` calls `recordTui` with an input and an output it controls, and types like a person: it waits for the
`sqlite> ` prompt on the screen, types a statement, presses Enter, and uses the real `Ctrl+]` menu (`v` = make the last typed
text a Variable, `e` = end). Nothing is simulated or hand-written: every step, wait and size in the workflow file comes from the
recorder.

- **Screen waits.** After each Enter the recorder stores the prompt it saw: `^sqlite>$` (`   ...> ` for a statement continued
  on a second line is stored as `^   \.\.\.>$`, leading spaces included). At replay the call goes on when the prompt is on the
  rendered screen, so a slow statement is waited for, not cut by a silence timer.
- **Terminal size.** 300 columns by 40 rows, recorded in the file. A statement with two 80-character values would wrap on 80
  columns, and the rows of the screen (hashed for drift) would move.
- **Drift.** `finalRect` hashes only rows that do not depend on the data: the banner, the echo of the typed statements and the
  last prompt of `add_note`; rows 0 to 3 of the two readers. The banner holds the version of sqlite3: another version reports
  drift, which is the point of the check.
- **Result.** A regular expression on the final screen. `.mode json` (sqlite3 >= 3.33) makes every row one `{"id":...}` object:
  `list_notes` uses the global flag, so `data` is an array of objects. The groups are strings (`"id": "2"`), not numbers: the
  terminal extractor only offers `text` and `regex` (see "What does not work").

## Variables inside an SQL statement, and SQL injection

The recorder turns a **whole typed text** into a Variable. A value inside a statement is therefore typed as separate pieces
with the `Ctrl+]` menu between them, so the statement is four constants and two Variables:

```
insert into notes(title, body) values ('      constant
<title>                                        Variable title
', '                                           constant
<body>                                         Variable body
');                                            constant, then Enter
```

At replay the value is pasted into the SQL text as it is. A title of `'); drop table notes;--` would close the string and run
a second statement. The recorder cannot prevent that, so the workflow file carries the rule:

```json
{ "name": "title", "pattern": "^[A-Za-z0-9 .,_-]{1,80}$", "maxLength": 80, "description": "..." }
```

`pattern` and `maxLength` are part of a Variable (added for this example). They go to the input schema, and the generated server
refuses any other value **before anything is replayed**: no quote, semicolon, backslash, newline or control character can get
in, and sqlite3 is not even started (the tests check that the database file does not exist after a refused call). The record
script writes them into the file after recording, the way a person editing the file would, because the `Ctrl+]` menu only names
a Variable. The file therefore says honestly what the workflow accepts: letters, digits, spaces and `. , _ -`, 1 to 80 characters.
Widen the pattern only if the characters are harmless in an SQL string and in the `sqlite>` line editor.

The workflow file contains no secret (none is needed) and no typed text other than the SQL above; the two sample values
(`Sample title`, `Sample body`) are the defaults of the Variables.

## What was observed on the real program

- The `sqlite3` of Debian uses readline: it enables bracketed paste (`ESC[?2004h`) and rewrites the prompt line while typing.
  The terminal screen (xterm.js) renders that correctly and the tokenizer keeps the text of a bracketed paste and drops its
  markers (`tests/unit/cli-sqlite-regressions.test.ts`).
- The continuation prompt, `.mode column` with aligned columns read with a regular expression, and a statement that takes about
  a second (the prompt of the previous statement is still on screen) all replay correctly
  (`shell features that stress the recorder` in the integration test).
- Recording through `docker run -it` from Windows uses ConPTY, which prints `sqlite>` followed by a cursor move instead of
  a trailing space. The record script accepts both; the stored prompt pattern is the same (`^sqlite>$`).

## What does not work, or only partly

- **`data` values are strings.** `"id": "2"`, not `2`: a terminal result zone is `text` or `regex`, and regex groups are text.
- **An empty table gives an error, not `[]`.** With no row the shell prints nothing in JSON mode, the regex matches nothing and the
  call fails with `result_zone_not_found` (the action itself already ran).
- **A value can not contain a quote or a semicolon.** That is the price of typing values into SQL text; a safer design would not
  build SQL from text at all (a program with real parameters, for example an `.parameter set` statement, is not covered here).
- **Windows `sqlite3.exe`** was not tried: no `sqlite3` is installed on the machine this was written on. The host path of the
  integration test is skipped with a message when there is none.
- The first call of the Docker path is slow (a container and a Node process per call, about 1 to 2 seconds).
