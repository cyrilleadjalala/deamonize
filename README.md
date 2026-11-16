# Daemonize

**Turn software that has no API into tools an AI agent can call.**

Thousands of critical tools (an old web admin, a terminal program in a container) expose nothing an agent can use. With Daemonize you use the tool once. It records what you did, infers a typed schema for the fields that change, and compiles a working **MCP server** and a **Kiro Power**. Kiro can then drive the application on its own.

Built with [Kiro](https://kiro.dev) for the Kiroween 2026 hackathon, category **Frankenstein**: a headless browser, a terminal emulator, a recorded state machine and a server compiler stitched into one tool.

## How it works

```
record  ->  compile  ->  import the Power in Kiro  ->  the agent calls the tools
```

1. **Record.** Use the application in a browser window (or, for a terminal program, in your own terminal). Mark the fields that should become inputs (**Variables**). The recorded path is a **Workflow**.
2. **Compile.** Daemonize infers a JSON Schema per Workflow and writes, to `daemonize-out/`:
   - `mcp-server.js`: one MCP tool per Workflow,
   - `openapi.json`: an OpenAPI 3.1 document,
   - a Kiro Power: `plugin.json`, `mcp.json`, `skills/<name>/SKILL.md` and `POWER.md`,
   - `tests/`: a property-based test suite for every tool's input schema.
3. **Call.** On each call the server validates the payload, starts a **fresh** sandbox at the recorded start state, replays every step with the payload values, and returns the title and visible text of the final screen. The result is flagged `drifted` when the final screen differs from the recorded one.

Why this is safe for the target application:

- An invalid payload is refused **before** anything is replayed.
- Each call starts from a known state, so a failure leaves nothing behind.
- With `--sandbox docker`, each call runs in a throw-away container: memory and CPU limits, all capabilities dropped, no new privileges, no implicit image download, and only the folders you mount. Terminal targets get no network and a read-only file system.
- Password values are never captured. Typed values you did not mark as Variables are stored as they are, and the CLI warns about them. Check that none is a secret.

## Requirements

- Node.js 20 or newer
- A Chromium for web targets: `npx playwright install chromium` (or set `DAEMONIZE_CHROMIUM_PATH`)
- Docker, only for `--sandbox docker`

## Install

```bash
npm install
npm run build
```

The CLI is `node dist/cli/index.js` (or `daemonize` after `npm link`).

## Quick start: a terminal program

```bash
# 1. Record. Type as usual. Ctrl+] opens a menu: v marks the last typed text as a Variable, e ends.
node dist/cli/index.js record --type tui -l greet_someone -n "Greeter" -- node tests/fixtures/greeter.mjs

# 2. Compile and install the run-time dependencies of the generated server
node dist/cli/index.js compile --install
```

## Quick start: a web application

```bash
# 1. Record. A browser opens. Type in fields, then use the "Make variable" box to mark inputs.
#    Press Enter in the terminal (or close the window) to finish.
node dist/cli/index.js record http://localhost:3000 -l create_customer -n "Legacy CRM"

# 2. Compile
node dist/cli/index.js compile --install
```

Record several workflows into the same file by repeating `record` with other labels. Use `merge <base> <newer>` to combine two workflow files.

## Use it in Kiro

1. Open the **Powers** panel, choose **Add Custom Power**, then **Import power from a folder**, and select `daemonize-out`.
2. Mention the application in a chat (its name or a tool word). Kiro activates the Power and can call its tools.

`mcp.json` holds the absolute path of `mcp-server.js`, so the output folder must stay where it was compiled. Recompile if you move it.

You can also run the server directly over stdio:

```bash
node dist/cli/index.js serve daemonize-out                  # replay on this machine
node dist/cli/index.js sandbox build daemonize-out          # build the replay image once
node dist/cli/index.js serve daemonize-out --sandbox docker # replay in a container per call
```

## Tests

```bash
npx tsc --noEmit
npx vitest run
DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/docker-sandbox.test.ts   # needs Docker
```

On Windows, `node-pty` prints an `AttachConsole failed` trace when it stops a process. It is harmless.

## Built with Kiro

The repository keeps the Kiro configuration in [`.kiro/`](.kiro):

- **Specs** (`.kiro/specs/daemonize/`): requirements, design and a task plan with 15 groups, executed task by task.
- **Property-based testing**: eight correctness properties with `fast-check` (round-trip, determinism, idempotence, commutativity, schema-valid payloads accepted, invalid payloads rejected). The property tests found a real bug in the graph merge during the first checkpoint: duplicates already present in one graph broke commutativity.
- **Steering** (`.kiro/steering/`): product principles, stack, structure and testing rules.
- **Hooks** (`.kiro/hooks/`): type-check on save, run the core test suites when a core module changes, and ask the agent to check the spec when the data model changes.
- **Kiro Power**: the compiler emits a real Power that Kiro imports from a folder.

## License

[MIT](LICENSE)