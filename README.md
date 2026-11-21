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

Details, routes and guard rules: [docs/studio.md](docs/studio.md). Colours and components: [docs/design-tokens.md](docs/design-tokens.md).

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

## Kiro extension
`kiro-extension/` holds a small Kiro extension (a `.vsix`) that lists your tools, records new ones, manages credentials and connects tools to Kiro from the sidebar. It starts `daemonize studio --machine` in the background and opens the Studio in your browser. Build, install and settings: [kiro-extension/README.md](kiro-extension/README.md).

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

The [`.kiro/`](.kiro) folder is part of the repository. The table lists each Kiro feature the project used. Every number in the last column was counted in the repository on 21 November 2026 and can be checked with the command given under the table.

| Kiro feature | What we did | Why it mattered | Numbers |
| --- | --- | --- | --- |
| Spec: `daemonize` (`.kiro/specs/daemonize/`) | The first spec: record, schema, compile to an MCP server, OpenAPI and a Kiro Power, replay in a sandbox. A second round (strict and heal, secrets, real software) was added to the spec before it was built. | Everything else builds on it. Tasks ran one at a time against the requirements. | 19 requirements, 116 task lines (115 checked), 21 properties |
| Spec: `studio-first-flow` | The Studio: record, mark variables, compile and test in one browser page. | Gave a person without a terminal a way to use the tool. | 14 requirements, 104 task lines (104 checked), 25 properties |
| Spec: `studio-first-recording-fixes` (bugfix spec) | Bug conditions for the first-recording path of the Studio. | A bugfix spec states the defect before the fix. | 15 current-behaviour defects listed, 49 task lines (4 checked), 11 properties. Most tasks are not done. |
| Spec: `nextjs-spa-replay-fixes` (bugfix spec) | Bug conditions for replaying Next.js single-page applications. | Same bugfix method, on replay. | 12 current-behaviour defects listed, 33 task lines (33 checked), 8 properties |
| Spec: `kiro-global-connect-vault-bridge` | Connecting a tool to Kiro for all projects and sharing the secret vault with the generated server. | Credentials stay out of Kiro's settings files. | 10 requirements, 96 task lines (96 checked), 21 properties |
| Spec: `kiro-thin-extension` | The small Kiro extension (`kiro-extension/`). | The Studio is reachable from the Kiro sidebar. | 17 requirements, 66 task lines (66 checked), 22 properties |
| Spec: `user-journey-improvements` | Plain-language screens, first-action help, activity views. | Reduced the steps a new user needs. | 24 requirements, 118 task lines (118 checked), 33 properties |
| Spec: `kiro-native-agent-and-firewall` | The Builder_Agent, the Builder_Skill, the Studio_MCP, the Daemonize_Power, and the firewall of generated servers (approvals, audit log, trace). This README section is its last task group (G-Z). | Lets Kiro build and run tools with a person approving each write. | 30 requirements, 102 task lines (97 checked when counted), 36 properties |
| Steering (`.kiro/steering/`) | `product.md`, `tech.md`, `structure.md`, `testing-pbt.md`, always loaded. | Fixed the rules (strict by default, ES modules, how to write properties) so each task did not restate them. | 4 files |
| Hooks (`.kiro/hooks/`) | `typecheck-on-save`, `tests-on-core-change`, `keep-spec-in-sync`, `secret-scan-on-save`. | Type errors, broken core tests, spec drift and committed secrets showed up at save time. | 4 files |
| Property-based testing defects | Properties written from the specs found real defects (listed below). | They were not found by the example tests. | 5 defects listed below. 130 test files carry a `Feature:` tag, 127 use `fast-check`, 102 files sit in `tests/property/`. |
| Parallel sub-agents (spec-task-execution) | The `kiro-native-agent-and-firewall` design splits the work into one serial seam group and fifteen groups that run in parallel, each owning disjoint files. A conductor dispatches one sub-agent per group, and G-Z runs last. | Disjoint file ownership let groups run at the same time without edit conflicts. | 1 plan, 16 groups (`design.md`, the work-split section). Each group's task lines are in `tasks.md`. |
| Builder_Agent (`.kiro/agents/daemonize.md`) | A custom Kiro agent that builds a tool by calling the Studio_MCP. It cannot write files or run commands. Reads and recording are allowed. Compile, test and install ask first. | A person can say what they want and approve the risky steps. | 1 agent file, 7 tools allowed, 6 tools ask, shell and file writes denied |
| Builder_Skill (`.kiro/skills/daemonize-builder/SKILL.md`) | A skill with the journey the agent follows and the secret rules. | The agent loads the guide only when the task needs it. | 1 file |
| Studio_MCP (`daemonize mcp`, `src/studio/mcp/`) | An MCP server over the Studio: list, record, compile, test and install actions. It is Daemonize's own use of Kiro's MCP feature. | The agent drives the same Studio a person uses, so the approvals are the same. | 13 tools, 6 source files |
| Daemonize_Power (`power/`) | A Kiro Power: `POWER.md`, `mcp.json`, the agent, the skill and a steering file. | One install gives Kiro the server, the agent and the rules. | 6 files |

Commands used: spec folders `Get-ChildItem .kiro/specs -Directory`; requirements `Select-String -Pattern '^### Requirement \d+'` on `requirements.md`; task lines `Select-String -Pattern '^\s*- \[[ x~-]\]'` on `tasks.md` (sub-tasks included), checked lines `'^\s*- \[x\]'`; properties are the distinct `Property N` numbers in `design.md`; bugfix defects are the `1.N` items of "Current Behavior" in `bugfix.md`; test files `Get-ChildItem tests -Recurse -Filter *.test.ts` (347 files, of which 143 unit, 102 property, 66 integration and 36 extension); Studio_MCP tool names in `src/studio/mcp/tool-names.ts`; the repository has 108 commits (`git rev-list --count HEAD`), 14 of them start with `fix`. The task counts of `kiro-native-agent-and-firewall` change while it is being built.

Defects found by property tests, fixed in the code and kept as tests:
- Graph merge was not commutative when one graph already held duplicate edges (first checkpoint).
- Run-time screen hashing and DOM normalization: the idempotence and equals-`ScreenHasher` properties (P9) guard it. Changing hidden CSRF token values (seen on Adminer) do not change the hash (`tests/unit/adminer-regressions.test.ts`).
- A pattern wait could be stalled by a regular expression that backtracks catastrophically. The matcher is now time-boxed and refuses such patterns (P16).
- The heal cache path could alias the workflow file through a junction or symlink. Aliasing paths are refused (P15).
- The recorder's own UI caused false drift on replay. It is excluded from the hash (commit `9aee1e9`).

## How MCP extended Kiro while we built this

Daemonize gives Kiro an MCP server of its own, `daemonize mcp` (the Studio_MCP). The Daemonize agent (`.kiro/agents/daemonize.md`) uses it to record, compile and test a tool on a real application, Adminer in `examples/adminer`. The agent lists existing actions, starts a recording, reads its status, builds the tool and tests it. Compile, test and install each raise an approval request in the Studio (or in the Activity panel of the Kiro extension) that only a person can answer. The agent never receives a secret value.

The steps are in [docs/dogfooding.md](docs/dogfooding.md). That page has a table of the calls made during development, and the table is still empty. The steps have been written and checked against the tool names in the code, but the maintainers have not yet run them with the agent and copied the Audit Log into the table. Until they do, this README makes no claim about what the agent built.

## What Kiro did not do

- The code of Daemonize, its tests and its documentation were written and fixed by hand, with Kiro's help in the editor and through spec tasks. The 14 commits that start with `fix` are repairs made after the first version of a feature.
- The Adminer workflows in `examples/adminer/daemonize.workflows.json` come from `examples/adminer/record-workflows.mjs`, a script that drives the recorder. The Daemonize agent did not record them.
- Docker for the Adminer stack, and every approval and every typed password, are done by a person.
- Agent output was sometimes wrong and was corrected or discarded by hand. No log of these cases was kept, so there is no count and no list, and we do not claim one.
- Kiro features not used: the Kiro Crew application (out of scope in the spec of `kiro-native-agent-and-firewall`), and a full visual unification of the Studio and the extension beyond what the specs needed.
- Two assumptions are not verified:
  1. Whether Kiro applies the `requestTimeout` of a settings entry (set to 300000 in `.kiro/agents/daemonize.md`) to the per-call timeout of an MCP server. The documented default is 120000. A long compile or test could time out if it does not.
  2. The working directory of a server that Kiro starts. The Studio_MCP is started with `daemonize mcp` and may assume a folder that Kiro does not use.

## Install the Daemonize Power and pick the Daemonize agent

1. Build and put the program on your PATH: run `npm install` and `npm run build`, then make the `daemonize` command available (for example `npm link`). The Power starts it as `daemonize mcp`.
2. In Kiro, open the Powers panel and choose "Install from folder". Pick the `power` folder of this repository. As an alternative, choose "Install from repository URL" and give the address of this repository.
3. Or, with the Kiro extension installed, run the command "Install the Daemonize Power" (see [kiro-extension/README.md](kiro-extension/README.md)).
4. For this repository only, copy `.kiro/settings/mcp.json.example` to `.kiro/settings/mcp.json` (the copy is ignored by git).
5. Reload the Kiro window if the server `daemonize-studio` is not listed in the MCP settings.
6. Start the Studio with `daemonize studio` and keep it open, because approvals appear there.
7. In the Kiro chat, choose the agent `daemonize` in the agent list. The extension command "Build a tool with the Daemonize agent" opens it for you. The agent greets you and asks for the task.

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
