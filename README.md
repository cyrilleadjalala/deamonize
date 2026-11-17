# Daemonize

**Live demo:** [Daemonize Studio](https://cyrilleadjalala.github.io/deamonize/), sample data only.

**Turn software that has no API into tools an AI agent can call.**

You use a legacy web admin or a terminal program once. Daemonize records what you did, lets you mark the fields that change as typed
inputs, and compiles an MCP server, an OpenAPI 3.1 document and a Kiro Power. Kiro can then run the same task on its own, with a
validated payload, in a fresh sandbox, and get back structured data.

Built with [Kiro](https://kiro.dev) for Kiroween 2026, category **Frankenstein**: a headless browser, a terminal emulator, a recorded
workflow model and a server compiler stitched into one tool.

## Why

An agent can call an MCP tool or an HTTP API. It cannot call a PHP admin page, a vendor console or a command-line shell that only
exists as a screen. Rewriting those tools is not an option, and asking a model to click through them on every run is slow, costly and
unsafe. Daemonize records the path once and replays it deterministically.

## The loop

```
record  ->  compile  ->  import the Power in Kiro  ->  the agent calls the tool
```

1. **Record.** Use the application in a browser window (web) or in your terminal (`--type tui`). Mark inputs as **Variables** and passwords as **secrets**. The path is a **Workflow**.
2. **Compile.** Daemonize infers a JSON Schema per workflow and writes the output folder.
3. **Call.** The server validates the payload first, then starts a fresh sandbox at the recorded start state, replays every step, and returns `data`, `text` and flags such as `drifted`.

| Generated in the output folder (default `daemonize-out/`) | What it is |
| --- | --- |
| `mcp-server.js`, `package.json` | One MCP tool per workflow, with run-time modules; does not import from `src/` |
| `openapi.json` | OpenAPI 3.1 document, validated against the official meta schema |
| `plugin.json`, `mcp.json`, `POWER.md`, `skills/<name>/SKILL.md` | The Kiro Power |
| `tests/` | A fast-check property suite per tool: valid payloads pass, invalid ones fail |
| `name-map.json` | Which workflow became which tool name |
| `sandbox/` | Dockerfile inputs for `--sandbox docker` |

## Requirements and install

- Node.js 20 or newer
- Chromium for web targets: `npx playwright install chromium` (or set `DAEMONIZE_CHROMIUM_PATH`)
- Docker, only for `--sandbox docker` and the Docker examples

```bash
npm install
npm run build
node dist/cli/index.js --help      # or `daemonize` after `npm link`
```

Commands: `record`, `compile`, `merge`, `serve`, `studio`, `sandbox build`. Each has `--help`.

## Quick start

Terminal program:

```bash
# Ctrl+] opens a menu while recording: v marks the last typed text as a Variable, e ends.
node dist/cli/index.js record --type tui -l greet_someone -n "Greeter" -- node tests/fixtures/greeter.mjs
node dist/cli/index.js compile --install
```

Web application (a browser opens; press Enter in the terminal or close the window to finish):

```bash
node dist/cli/index.js record http://localhost:3000 -l create_customer -n "Legacy CRM"
node dist/cli/index.js compile --install --http auto      # --http auto records Level 1 requests when the app has any
```

Repeat `record` with other labels to add workflows to the same file (`daemonize.workflows.json`). `merge <base> <newer>` combines two files.

Use in Kiro: **Powers** panel, **Add Custom Power**, **Import power from a folder**, choose `daemonize-out`. `mcp.json` holds the absolute
path of `mcp-server.js`, so recompile if you move the folder. Or run it directly:

```bash
node dist/cli/index.js serve daemonize-out                       # replay on this machine
node dist/cli/index.js sandbox build daemonize-out               # build the replay image once
node dist/cli/index.js serve daemonize-out --sandbox docker      # one throw-away container per call
```

## Works on real software

Two programs we did not write, each recorded, compiled and called over MCP.

| Example | Target | Outcome |
| --- | --- | --- |
| [`examples/adminer`](examples/adminer/README.md) | Adminer 6.1.1 on PostgreSQL 16, started with Docker Compose | Four tools: `list_customers`, `find_customers`, `open_customer_for_edit`, `rename_customer`. **Every step replays at Level 2 only**: Adminer is server-rendered, so there is no fetch/XHR to record and `--http auto` produces no Level 1 recipe. The password is a secret reference, rows are found by name (`AMBIGUOUS_ROW` on duplicates), and `status` is limited to an enum |
| [`examples/cli-sqlite`](examples/cli-sqlite/README.md) | The real `sqlite3` shell | Three tools: `add_note`, `list_notes`, `count_notes`. Screen-pattern waits on the `sqlite>` prompt, a 300x40 recorded size, a regex result zone. Values are validated by `pattern` and `maxLength` before any SQL is typed. `data` values are strings, and an empty table gives `result_zone_not_found` |

What the end-to-end tests cover: `adminer-e2e.test.ts` records the four workflows with Playwright, compiles, calls the server over MCP and checks data,
drift and the absence of the password in every artifact. `cli-sqlite-e2e.test.ts` does the same for `sqlite3` on the host (needs `sqlite3` on the PATH) and
in Docker. `examples-no-leak.test.ts` searches the outputs for secret values.

Reproduce:

```bash
npm run build
DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/adminer-e2e.test.ts      # starts its own Adminer + PostgreSQL stack
DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/cli-sqlite-e2e.test.ts
```

Step-by-step commands (record, compile, serve) are in each example's README.

## Replay model

Detail: [docs/replay-model.md](docs/replay-model.md).

Each step is replayed by the most stable means available:

1. **Level 1, HTTP recipe.** The recorded fetch/XHR request with Variables and secrets bound in. Web only, with `compile --http`.
2. **Level 2, accessibility.** Role and name, with relational anchors and row bindings (a table row is found by a Variable, never by position).
3. **Level 3, vision.** Only with `--heal`, when Levels 1 and 2 failed or the page has no DOM.

| | STRICT (default, `--strict`) | HEAL (opt-in, `--heal`) |
| --- | --- | --- |
| A step that no locator can perform | Fails the call cleanly: `drifted: true`, `error: "step_failed"`, a diagnostic and a screenshot. Later steps do not run | Cache, recorded coordinates, then a vision model look for the element |
| Flag | `mode: "strict"` | `mode: "heal"`, `healed: true` |
| Write or delete steps | Never healed | Healed only with `allowHeal` on the step |
| Needs | Nothing | `compile --heal-support`, and `DAEMONIZE_MODEL_PROVIDER`, `_NAME`, `_API_KEY`, `_BASE_URL` |

| Result field | Meaning |
| --- | --- |
| `success`, `error` | Outcome and, on failure, a code |
| `drifted`, `driftChecked` | Final screen differs from the recorded one; `false` when no final screen was recorded to compare with |
| `healed`, `levels`, `mode` | Heal flag, level used per step, strict or heal |
| `data`, `text`, `title` | Structured result, visible text, page title |
| `failure` | Diagnostic: step, locators tried, screenshot path, last text, missing secret name |

Error codes: `validation`, `missing_secret`, `storage_state_missing`, `step_failed`, `pattern_timeout`, `http_failed`, `heal_unavailable`,
`result_zone_not_found`, `result_extraction_failed`, `sandbox_unavailable`, `timeout`. Their causes are in the detail page.

## Secrets and security

Detail: [docs/secrets.md](docs/secrets.md).

- Secrets come from `DAEMONIZE_SECRET_<NAME>` in the environment of the server (in Kiro, the `env` of `mcp.json`, which holds `${NAME}`, never a value). A TOTP seed is a secret too; the code is computed at replay time.
- A saved login (`storageState`) is referenced by path, and mounted read-only in Docker. It is never copied into the output.
- Workflows hold secret names only. Recorded HTTP requests are redacted. Typed text you did not mark is stored as typed, and the CLI warns about it.
- `npm run check:secrets` scans tracked and to-be-committed files for credential shapes and prints file, line and rule, never the value.
- `--sandbox docker`: one container per call, memory and CPU limits, capabilities dropped, no new privileges, no implicit image pull, no network for terminal targets, only the folders you `--mount`.
- Strict is the default. In heal mode the model only locates an element; it never decides the workflow and never edits the workflow file.
- Studio: loopback by default, per-run token, Host and Origin checks, no CORS header, CSP `default-src 'self'`.

## Terminal programs

- **Size.** The terminal size is recorded (`--cols`, `--rows`, default: your terminal, or 80x24) and replayed. A different size reports drift.
- **Waits.** After each step the replay waits for a screen pattern instead of a silence timer. `--wait-after <regex>` sets it, `--wait-timeout <ms>` bounds it (default 15000). Without the flag the prompt seen after each step is stored. Patterns that can backtrack catastrophically are refused. A miss returns `pattern_timeout`.
- **Recording menu.** `Ctrl+]` then `v` (last typed text becomes a Variable), `e` (end), `w` (set a wait pattern). Only whole typed text can be a Variable.
- **Result.** `--result-rect` and `--result-regex` (named groups become `data`, flag `g` gives an array), `--final-rect` for the drift region.
- **Sandbox.** `record` and `compile` store `--sandbox-image`, `--sandbox-package`, `--sandbox-install`, `--sandbox-network` in the workflow file. `sandbox build [dir]` accepts `--image`, `--package`, `--install`, `--network`, `--tag`, `--no-cache` and `--print` (prints the Dockerfile and builds nothing).

## Studio-first

You can run the whole cycle from the Studio, without a terminal after the first command.

```bash
daemonize          # no command: the same as `daemonize studio --open`; Ctrl+C stops it
```

1. **Start.** `daemonize` opens the Studio in your browser. With no workflow file yet, the first screen is a welcome screen. Nothing is created on disk until you record.
2. **New action.** Press **+ New action**, give the action a name and the web address where the task starts. Tick **Reuse my signed-in session** to keep your sign-in between recordings.
3. **Record.** A browser window opens on that address. Do the task once, then press **Finish and save** in the page panel or in the Studio. Closing the window early keeps a recovery file.
4. **Build.** The recording is turned into a tool at once. The Studio shows the progress and a **Recompile** button on the Overview.
5. **Credentials.** Open **Credentials** and type each password, authenticator key (paste the key or the full `otpauth://` text) or access code once. Values are write-only: no screen or route shows them again.
6. **Test.** **Test it** opens the playground with the new tool selected. It shows which credentials are configured or missing.
7. **Connect.** **Connect to Kiro** first asks where Kiro should offer the tool. **All my projects** (the default when you have a ~/.kiro folder) writes into ~/.kiro, so the tool shows in every Kiro project. **Only this project** writes into the .kiro/ folder of the project folder you type. Either way the Studio previews the exact folder and each file (settings/mcp.json and skills/<name>/SKILL.md, as create, merge or replace), says whether your existing settings file is backed up (mcp.json.bak), and writes only after you confirm. Your other Kiro tools are kept as they are. After connecting, reload the tool servers panel in Kiro or restart it. **Remove from Kiro** undoes one install: it restores the backup when nothing changed since, or else takes out only this tool's entry. **Keep Kiro up to date** (off by default) repeats the install after each successful try in the playground. Each application gets its own name, derived from its address (for example cycyly-vercel-app), so two applications never share a Kiro entry or a set of credentials. The generated tool reads the credentials you saved in the Studio from the encrypted vault, so mcp.json holds only placeholders and never a value. **Copy MCP configuration** copies the settings for another assistant. **Add as a Kiro Power instead** shows the output folder to import from the Powers panel. No command line option changed.

Browser for recording: bundled Chromium first, then Google Chrome, then Microsoft Edge. To use another browser, set `DAEMONIZE_CHROMIUM_PATH` to its executable; it is then the only browser tried.

Where data lives: saved sessions and the credential vault are stored in a per-user folder outside your project (Windows `%LOCALAPPDATA%\Daemonize`, macOS `~/Library/Application Support/Daemonize`, Linux `$XDG_DATA_HOME/daemonize` or `~/.local/share/daemonize`). Set `DAEMONIZE_DATA_DIR` (an absolute path) to choose another folder. The folder is refused when it is the current directory, inside it, inside a git repository or inside the output folder, and then sessions and credentials are unavailable (the Studio says so). If your home folder is itself a git repository, set `DAEMONIZE_DATA_DIR` to a folder outside it.

Details, routes and guard rules: [docs/studio.md](docs/studio.md).

## Studio

```bash
node dist/cli/index.js studio --sample                       # fictitious data, nothing read from disk
node dist/cli/index.js studio daemonize-out --open           # your workflows, replay levels, graph, schemas, test results
```

Options: `--workflows`, `--graph`, `--port`, `--host`, `--allow-remote`, `--open`, `--sample`. Open the printed address; it carries the token.

Static demo with no server: `npm run build && npm run studio:build` writes `dist-demo/` (git-ignored). The playground there is a simulation and says so.
`.github/workflows/studio-demo.yml` publishes it to GitHub Pages on a push to `main`, but only after you enable Pages once
(Settings > Pages > Source: GitHub Actions). Until then there is no public URL.

Live demo: [https://cyrilleadjalala.github.io/deamonize/](https://cyrilleadjalala.github.io/deamonize/) (sample data and a simulated playground: no real application is driven).

Views, keyboard use and screenshots: [docs/studio.md](docs/studio.md). Screenshots are generated by `STUDIO_SCREENSHOTS=1 npx vitest run tests/integration/studio-ui.test.ts` and are not committed.

## Testing

```bash
npx tsc --noEmit
npx vitest run                                  # everything; Docker tests are skipped
npm run test:unit
npm run test:property
npm run test:integration
DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/docker-sandbox.test.ts   # needs Docker
```

`vitest.config.ts` has two projects. `fast` (unit and property) runs at full parallelism. `integration` starts browsers, pseudo-terminals,
MCP servers and containers, so it runs with `maxWorkers: 2` after the fast group; under heavier load, time-based assertions can still flake, and
re-running the one file is the first thing to try.

Properties with a test labelled `// Feature: daemonize, Property N` (`tests/property/`):

| P | Meaning |
| --- | --- |
| 1 | State_Graph serialize/deserialize round-trip |
| 2 | Screen ID is deterministic |
| 3, 4 | The validator gives the same answer on repeat, for valid and invalid payloads |
| 5, 6 | Graph merge is commutative and idempotent |
| 9 | The generated server's screen hash equals `ScreenHasher` |
| 10 | The generated Zod schema accepts exactly what AJV accepts |
| 11 | Redaction removes sensitive values from recorded requests |
| 12 | No env-supplied secret value appears in any compiled artifact |
| 13 | Row resolution does not depend on row order |
| 14 | A strict failure never runs later steps |
| 15 | Heal never changes the workflow file |
| 16 | A pattern wait returns as soon as the pattern appears; catastrophic patterns are refused |
| 17 | Visual-anchor rectangles stay within [0, 1] |
| 18 | Variables in a recorded HTTP recipe are bound exactly where the recorded value was |
| 19 | Applying suggestions never changes the replayed steps |
| 20 | Studio responses never contain secret values |
| 21 | Playground responses never contain secret values |

Properties 7 and 8 (valid payloads pass, invalid ones fail, for the generated suite) have no `// Feature:` tag. They are exercised by the suite that
`compile` writes into each output folder and by `tests/unit/pbt.test.ts` and `tests/integration/pbt-generated.test.ts`. The design document numbers the
secret-leak and redaction properties 11 and 12 the other way round from the test labels above; the table follows the test labels.

## Built with Kiro

The [`.kiro/`](.kiro) folder is part of the repository.

- **Specs** (`.kiro/specs/daemonize/`): `requirements.md`, `design.md` and `tasks.md`, now 21 task groups, executed one task at a time. The second round (requirements 11 to 19: strict and heal, secrets, real-software proof) was added to the spec before it was built.
- **Steering** (`.kiro/steering/`): `product.md` (principles such as strict by default and models never replacing the recording), `tech.md`, `structure.md`, `testing-pbt.md`.
- **Hooks** (`.kiro/hooks/`): `typecheck-on-save`, `tests-on-core-change` (fast tests when a core module is saved), `keep-spec-in-sync` (check the spec when the data model changes), `secret-scan-on-save`.
- **Kiro Power**: the compiler emits a Power that Kiro imports from a folder. `tests/integration/kiro-power-mcp.test.ts` starts the server from the generated `mcp.json`.
- **Property-based testing found real defects**, fixed in the code and kept as tests:
  - Graph merge was not commutative when one graph already held duplicate edges (first checkpoint).
  - Run-time screen hashing and DOM normalization: the idempotence and equals-`ScreenHasher` properties (P9) guard it. Changing hidden CSRF token values (seen on Adminer) do not change the hash (`tests/unit/adminer-regressions.test.ts`).
  - A pattern wait could be stalled by a regular expression that backtracks catastrophically. The matcher is now time-boxed and refuses such patterns (P16).
  - The heal cache path could alias the workflow file through a junction or symlink. Aliasing paths are refused (P15).
  - The recorder's own UI caused false drift on replay. It is excluded from the hash (commit `9aee1e9`).

## Known limitations

- Adminer has no Level 1: server-rendered pages give no HTTP recipe. Every step runs at Level 2.
- Recording happens on the host. Recording inside a container is not implemented.
- Terminal Variables are whole typed texts. A value inside an SQL statement is typed in pieces, and the safety comes from the `pattern` and `maxLength` of the Variable.
- Terminal `data` values are strings. An empty result gives `result_zone_not_found`, not an empty array.
- Heal mode is tested with scripted healers and a fake model only, not against a real model.
- Canvas steps (no DOM) only replay in heal mode, through recorded coordinates or the model.
- Replay in Docker of a web target that listens on the host loopback was verified on Docker Desktop for Windows only.
- Windows `sqlite3.exe` was not tried. The generated server drives Docker with the `docker` command; `SandboxManager` (dockerode) is a library tested against a fake Docker.
- On Windows, `node-pty` prints an `AttachConsole failed` trace when it stops a process. It is harmless.
- The first call in Docker is slow (a container and a Node process per call).

## License

[MIT](LICENSE)
