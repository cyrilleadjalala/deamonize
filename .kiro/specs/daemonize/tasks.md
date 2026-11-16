# Implementation Plan: Daemonize

## Overview

Build a TypeScript/Node.js CLI tool that wraps legacy and API-less software into callable MCP tools. Tasks are ordered by dependency: project scaffolding and core data models first, then sandbox drivers, then the recording pipeline, then schema inference and compilation, then the serve-time runtime (Validator + Replayer), then the PBT generator, then integration wiring. All eight correctness properties from the design document are covered by required property-based test sub-tasks placed close to the components they verify.

## Tasks

- [x] 1. Scaffold project structure and core type definitions
  - Create the top-level directory layout: `src/`, `src/sandbox/`, `src/state/`, `src/schema/`, `src/compiler/`, `src/validator/`, `src/replayer/`, `src/pbt/`, `src/cli/`, `tests/unit/`, `tests/property/`, `tests/integration/`
  - Initialise `package.json` with `"type": "module"`, add dependencies: `typescript`, `vitest`, `fast-check`, `json-schema-fast-check`, `ajv`, `ajv-formats`, `@modelcontextprotocol/sdk`, `zod`, `dockerode`, `playwright`, `node-pty`, `commander`, `chalk`; add dev-dependencies: `@types/node`, `@types/dockerode`
  - Create `tsconfig.json` targeting `ES2022`, `NodeNext` module resolution, `strict: true`, `outDir: dist`
  - Create `vitest.config.ts` with separate project entries for unit and property test directories
  - Define shared TypeScript interfaces and enums in `src/types.ts`: `ScreenId`, `ScreenContent`, `RecordedAction`, `Transition`, `Screen`, `StateGraph`, `AnnotatedStateGraph`, `DaemonizeConfig`, `CompileResult`, `ReplayResult`, `ValidationError`
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1_

  - [x] 1.1 Create project scaffold and `src/types.ts`
    - Implement all shared interfaces and enums listed above
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1_

- [x] 2. Implement State_Graph JSON Schema and StateMachineBuilder
  - [x] 2.1 Define and publish the State_Graph JSON Schema
    - Create `src/state/state-graph.schema.json` matching the schema in the design document
    - Export a typed `StateGraphSchema` constant from `src/state/schema.ts`
    - _Requirements: 3.1, 3.5_

  - [x] 2.2 Implement `ScreenHasher` in `src/state/screen-hasher.ts`
    - Implement DOM normalisation: strip dynamic attributes (UUID-containing `id`, `nonce`, `data-reactid`, CSRF tokens), sort attributes alphabetically, remove whitespace-only text nodes
    - Implement terminal normalisation: strip ANSI escape codes, trim trailing whitespace per line, remove cursor-position lines
    - SHA-256 hash the UTF-8 encoded canonical string; truncate to first 16 hex characters
    - _Requirements: 2.2_

  - [x] 2.3 Write property test for `ScreenHasher` — Property 2: Screen ID Determinism
    - **Property 2: Screen ID Determinism**
    - Generate random DOM strings and terminal buffers; assert that computing the ID twice from the same content returns the same 16-character hex string
    - **Validates: Requirements 2.2**
    - _Tag comment: `// Feature: daemonize, Property 2: Screen ID determinism`_

  - [x] 2.4 Implement `StateMachineBuilder` in `src/state/state-machine-builder.ts`
    - Implement `recordTransition(sourceId, action, destinationContent): ScreenId`: hash destination, merge or insert Screen node, append Transition edge
    - Implement snapshot deduplication: skip recording when the previous snapshot hash matches the new one and elapsed time is < 100 ms
    - Implement `merge(other: StateGraph): StateGraph`: union screen sets (deduplicate by screen ID), union transition sets (deduplicate by source + action type + params + destination), return merged graph
    - Implement `serialize(): string` — JSON.stringify with 2-space indentation, validate output against State_Graph JSON Schema before returning
    - Implement `static deserialize(json: string): StateMachineBuilder` — validate against schema via AJV, throw `DescriptiveParseError` with `instancePath` and `schemaPath` on failure
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.4, 3.5, 10.1, 10.2, 10.3_

  - [x] 2.5 Write property test for `StateMachineBuilder` — Property 1: State_Graph Serialization Round-Trip
    - **Property 1: State_Graph Serialization Round-Trip**
    - Generate random `StateGraph` objects using `fc.record` over `fc.dictionary` for screens and `fc.array` for transitions; serialize then deserialize; assert deep structural equality
    - **Validates: Requirements 3.3**
    - _Tag comment: `// Feature: daemonize, Property 1: State_Graph round-trip`_

  - [x] 2.6 Write property tests for `StateMachineBuilder.merge` — Properties 5 and 6
    - **Property 5: Merge Commutativity** — Generate two random graphs A and B; assert `merge(A, B)` equals `merge(B, A)` (same node set, same edge set)
    - **Property 6: Merge Idempotence** — Generate random graph A; assert `merge(A, A)` equals A
    - **Validates: Requirements 10.4, 10.5**
    - _Tag comment: `// Feature: daemonize, Property 5: merge commutativity; Property 6: merge idempotence`_

  - [x] 2.7 Write Vitest unit tests for `ScreenHasher` and `StateMachineBuilder`
    - `ScreenHasher`: two semantically identical DOMs with different whitespace hash to the same ID; a one-character change produces a different ID
    - `StateMachineBuilder.merge`: union of node sets, deduplication of identical transitions, preservation of distinct transitions from both inputs
    - `StateMachineBuilder.deserialize`: malformed JSON throws `DescriptiveParseError` identifying the invalid field
    - _Requirements: 2.2, 2.3, 3.4_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement SandboxManager and drivers
  - [x] 4.1 Implement `SandboxManager` base and `SandboxDriver` interface in `src/sandbox/`
    - Define `SandboxDriver` interface from the design document in `src/sandbox/driver.ts`
    - Implement `SandboxManager` in `src/sandbox/sandbox-manager.ts` using `dockerode` to launch, monitor, and stop containers
    - Wire the `onUnexpectedExit` event emitter: on container exit, emit the exit code; the CLI will catch this event to log and surface the error within 5 seconds
    - Enforce configurable `memoryMb` (default 512) and `cpuCount` (default 1) resource limits on container creation
    - An exit the caller did not ask for is logged with its exit code and reported at once; the exit that follows `stopContainer` is not
    - Verified against a fake Docker only: the Docker daemon was not running on the development machine, so no real container was started
    - _Requirements: 1.1, 1.4, 1.5_

  - [x] 4.2 Implement `PlaywrightDriver` in `src/sandbox/playwright-driver.ts`
    - Launches headless Chromium on the host through Playwright and loads the target URL (`DAEMONIZE_CHROMIUM_PATH` selects an installed browser)
    - `captureScreen()` returns the DOM after network idle; `execute(action)` dispatches click, keypress, form_submit, type or select and returns the resulting `ScreenContent`
    - Recording runs the browser on the host, in a visible window; replaying in a container is done by the generated server (see 4.5)
    - _Requirements: 1.2_

  - [x] 4.3 Implement `PtyDriver` in `src/sandbox/pty-driver.ts`
    - Runs the program in a pty on the host (`node-pty`) and renders its screen with the headless xterm renderer (`TerminalScreen`), so the screen is what the user would see, not the history of everything printed
    - Waits for the first text, then for silence after each input; named keys come from the shared table in `src/sandbox/keys.ts`
    - A stop requested by the caller is not reported as an unexpected exit
    - Recording runs the program on the host; replaying in a container is done by the generated server (see 4.5)
    - On Windows, `node-pty` prints a harmless "AttachConsole failed" trace when it kills a live process
    - _Requirements: 1.3_

  - [x]* 4.4 Write unit tests for `SandboxManager`
    - `onUnexpectedExit` fires with the exit code when the container exits by itself, and the code is logged; a stop requested by the caller is not reported
    - Memory and CPU limits and `NetworkMode: none` are set on the container creation options
    - Uses a fake Docker (`tests/unit/sandbox-manager.test.ts`)
    - _Requirements: 1.4, 1.5_

  - [x] 4.5 Replay in a Docker container
    - The generated server replays each call in a throw-away container (`docker run --rm`) when `DAEMONIZE_SANDBOX=docker` or `daemonize serve --sandbox docker`; the replay code is the same module (`replay.ts`) as on the host, started with `--container`
    - Isolation of every container: memory limit (default 512 MB) and CPU limit (default 1), all capabilities dropped, `no-new-privileges`, at most 256 processes, no implicit image download (`--pull never`), only the folders the user mounts (`--mount host:container[:ro]`)
    - Terminal targets: no network, read-only file system with a scratch `/tmp`, unprivileged user. Web targets: `bridge` network (the browser has to reach the application), 512 MB of shared memory, Playwright image of the exact version
    - A missing image, a missing `docker` command or an unreachable daemon is reported as `sandbox_unavailable`; a program recorded with a path of the host needs `--sandbox-command` (the command inside the container)
    - `daemonize sandbox build [dir]` builds the image (`sandbox/Dockerfile`, written by the compiler); `serve --sandbox docker` checks the daemon and the image first
    - Verified with a real Docker daemon (`tests/integration/docker-sandbox.test.ts`, run with `DAEMONIZE_DOCKER_TESTS=1`): a probe program sees Linux on a Windows host, a non-root user, the requested memory and CPU limits, a read-only root file system, no host files and no network; the web browser that fetches the pages is a Linux one; no container is left behind
    - Not done: recording inside a container (a browser needs a visible window to record, and terminal recording stays on the host)
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

- [x] 5. Implement SchemaInferencer
  - [x] 5.1 Implement `SchemaAccumulator` and schema widening in `src/schema/schema-accumulator.ts`
    - Implement per-Transition payload accumulation: convert each observed payload to a minimal JSON Schema
    - Implement the widening algorithm: fields present in all observations stay required; fields present in only some become optional; conflicting primitive types become `anyOf` branches; `integer` widens to `number` on decimal observation
    - _Requirements: 4.1, 4.3_

  - [x] 5.2 Implement format annotation pass in `src/schema/format-annotator.ts`
    - After merging observations, test each string field's observed values against RFC 5322 (email), ISO 8601 (date-time), and RFC 4122 (UUID) regexes
    - Annotate with the corresponding `format` keyword only when ≥ 80% of non-null observations match
    - _Requirements: 4.4_

  - [x] 5.3 Implement `LabelExtractor` in `src/schema/label-extractor.ts`
    - For DOM screens: find the nearest `<label>` whose `for` attribute matches the input field name; fall back to the `placeholder` attribute
    - For terminal screens: use the text on the same line preceding the cursor position
    - Assign the extracted text as the `description` on each inferred field
    - _Requirements: 4.5_

  - [x] 5.4 Implement `SchemaInferencer` in `src/schema/schema-inferencer.ts`
    - Wire `SchemaAccumulator`, format annotation, and `LabelExtractor` together
    - Implement `infer(graph: StateGraph): AnnotatedStateGraph` — process all Transitions and Screens, return annotated graph with `inputSchema` and `outputSchema` populated on each Transition
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x]* 5.5 Write unit tests for `SchemaAccumulator` and `FormatAnnotator`
    - `SchemaAccumulator`: primitive type widening (`integer` → `number`), `anyOf` generation on conflicting types, `additionalProperties` behavior when a field is absent from some observations
    - `FormatAnnotator`: format annotation at the ≥ 80% threshold, no annotation below threshold; the format of a field that is sometimes null goes on its string alternative
    - `tests/unit/schema-inference.test.ts`
    - _Requirements: 4.3, 4.4_

- [x] 6. Implement Compiler
  - [x] 6.1 Implement tool name derivation in `src/compiler/tool-name-deriver.ts`
    - Implement `snake_case` transform: lowercase, replace non-alphanumeric runs with `_`, collapse repeated `_`, strip leading/trailing `_`
    - Truncate to 64 characters at the last word boundary (`_`) before position 64
    - Conflict resolution: iterate Transitions in topological order; append `_2`, `_3`, … when the base name exists in the output name set
    - _Requirements: 5.3, 5.4_

  - [x] 6.2 Implement OpenAPI 3.1 document generation in `src/compiler/openapi-generator.ts`
    - Emit a valid OpenAPI 3.1 document: each Transition becomes a POST endpoint under `/actions/{action_id}`
    - Set `info.title` to the target application name; set `info.version` to `StateGraph.updatedAt`
    - Validate the generated document against the OpenAPI 3.1 JSON Meta Schema using AJV; abort and throw if validation fails (do not write to disk)
    - _Requirements: 5.1, 5.5_

  - [x] 6.3 Implement MCP server source generation in `src/compiler/mcp-generator.ts`
    - Emit a standalone TypeScript source file that imports `@modelcontextprotocol/sdk/server/index.js` and `zod`
    - Register each tool using `server.tool(name, description, zodSchema, handler)` and start `StdioServerTransport`
    - The generated file must require no Daemonize runtime dependency — only `@modelcontextprotocol/sdk` and `zod`
    - _Requirements: 5.2_

  - [x] 6.4 Implement Kiro Power generation in `src/compiler/kiro-power-generator.ts`
    - Emit the Kiro Power files described in the design document: `plugin.json`, `mcp.json` (stdio, `node` running `mcp-server.js`), `skills/<name>/SKILL.md` and `POWER.md` (reworked in task 15.1)
    - Include `description` for each tool derived from the inferred schema descriptions
    - _Requirements: 8.1, 8.2_

  - [x] 6.5 Implement `Compiler` orchestrator in `src/compiler/compiler.ts`
    - Wire `ToolNameDeriver`, `OpenApiGenerator`, `McpGenerator`, and `KiroPowerGenerator`
    - On success: write `openapi.json`, `mcp-server.ts`, `mcp-server.js` (transpiled, what `mcp.json` runs), the Kiro Power files (`plugin.json`, `mcp.json`, `skills/<name>/SKILL.md`, `POWER.md`) and `name-map.json` to the output directory; report file paths to the user
    - Also writes `package.json` (ES module, run-time dependencies for the target type, `vitest` and `fast-check` for the tests) and `vitest.config.ts`, only when they do not exist yet
    - The OpenAPI document is validated against the official OpenAPI 3.1 meta-schema (`@seriousme/openapi-schema-validator`); nothing is written when it fails
    - Tool descriptions list the inferred inputs and their descriptions (`describeTool`)
    - Implement `name-map.json` sidecar: `{ [workflowId]: toolName }` for all workflows
    - _Requirements: 5.6, 8.3_

  - [x]* 6.6 Write unit tests for `ToolNameDeriver` and `Compiler`
    - `ToolNameDeriver`: snake_case conversion, 64-character truncation at word boundary, suffix generation for up to five conflicting names
    - `Compiler`: the emitted OpenAPI document passes the OpenAPI 3.1 meta-schema, names are suffixed and truncated as specified, existing `package.json` and `vitest.config.ts` are left alone (`tests/unit/compiler-outputs.test.ts`)
    - _Requirements: 5.3, 5.4, 5.5_

- [x] 7. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Validator
  - [x] 8.1 Implement `Validator` in `src/validator/validator.ts`
    - Import AJV v8 (`Ajv2020`) with `ajv-formats`
    - On construction, compile all action schemas once using `ajv.compile()`; cache `ValidateFunction` instances in a `Map<actionId, ValidateFunction>`
    - Implement `validate(actionId, payload): ValidationError | null` — return null on pass; return `ValidationError` with `{ instancePath, schemaPath, message }[]` from AJV on failure (never throw)
    - Unit tests in `tests/unit/validator.test.ts`, including a 1 MB payload validated within 50 ms
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 8.2 Write property test for `Validator` — Property 3: Payload Validation Idempotence (valid)
    - **Property 3: Payload Validation Idempotence (valid)**
    - Generate valid payloads satisfying the schema with `tests/helpers/schema-arbitrary.ts`; validate twice; assert both calls return null
    - `json-schema-fast-check` is not used: it bundles fast-check 1.x, incompatible with the fast-check 3 of this project
    - **Validates: Requirements 6.4**
    - _Tag comment: `// Feature: daemonize, Property 3: validator idempotence (valid)`_

  - [x] 8.3 Write property test for `Validator` — Property 4: Payload Validation Idempotence (invalid)
    - **Property 4: Payload Validation Idempotence (invalid)**
    - Generate invalid payloads (at least one constraint violation) using `fc.oneof` with intentional violations; validate twice with the same schema; assert both calls return a non-null `ValidationError`
    - **Validates: Requirements 6.5**
    - _Tag comment: `// Feature: daemonize, Property 4: validator idempotence (invalid)`_

- [x] 9. Implement Replayer (workflow model)
  - [x] 9.1 Implement `Replayer` in `src/replayer/replayer.ts`
    - Implement `replay(workflow, payload, timeoutMs): Promise<ReplayResult>`: create a fresh `SandboxDriver` per call, replay every step with Payload values, try each step's candidate selectors in order
    - Return the title and visible text of the final screen (`result-extractor.ts`), flag `drifted` when the final screen differs from `finalScreenId`
    - On timeout: log `{ actionId, payload, elapsedMs }` at WARN level, stop and discard the sandbox, return `{ success: false, error: "timeout", elapsedMs }`
    - On sandbox unavailable (sandbox cannot start): return `{ success: false, error: "sandbox_unavailable" }` immediately
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 9.2 Write unit tests for `Replayer`
    - Fresh sandbox per call, selector fallback, timeout, sandbox-unavailable, result extraction (`tests/unit/replayer.test.ts`)
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_

  - [x] 9.3 Add the Workflow model and adapt inference and compilation
    - `Workflow`, `WorkflowStep`, `WorkflowVariable`, `WorkflowSet` in `src/types.ts`
    - `SchemaInferencer.inferWorkflows`; `Compiler`, OpenAPI, MCP and Kiro generators take a `WorkflowSet`; generated MCP server embeds a standalone Playwright replay runtime
    - _Requirements: 2.7, 2.8, 4.1, 4.2, 5.1, 5.2, 8.1_

  - [x] 9.4 Workflow recording model and persistence
    - `WorkflowRecorder` (`src/recorder/`): ordered steps, user-marked Variables, `finalScreenId`; `buildSelectors` orders candidate selectors (role/name, stable attributes, CSS)
    - Workflow set JSON Schema, serialize/deserialize and merge by Workflow id (`src/workflow/workflow-set.ts`)
    - _Requirements: 2.7, 2.8, 10.6_

  - [x] 9.5 Capture user interactions live in the browser
    - `CAPTURE_SCRIPT` (`src/recorder/capture-script.ts`) is injected in every page: clicks, typed values (recorded when the field is left or on Enter), selections and Enter presses, with role, accessible name, id, test id, name attribute and CSS path; password values are never captured
    - `LiveRecorder` (`src/recorder/live-recorder.ts`) turns captured events into `WorkflowRecorder` steps; `markVariable` marks a typed or selected value as a Variable
    - Integration test records in a real browser, then replays with new values (`tests/integration/live-recorder.test.ts`)
    - _Requirements: 2.7, 2.8, 10.6_

- [x] 10. Implement PBT Generator
  - [x] 10.1 Implement `PbtGenerator` in `src/pbt/pbt-generator.ts`
    - For each compiled Action, writes `<outputDir>/tests/<tool_name>.property.test.ts`: one property for payloads generated from the schema (must be accepted) and one for payloads with an intentional violation (must be rejected, chosen with `fc.oneof`)
    - Two support modules are copied next to the tests: `schema-arbitrary` (schema → `fc.Arbitrary` for valid payloads, and `invalidPayloadArbitrary` for sound violations) and `property-runner` (runs each property, records passing and failing counts and the shrunk counterexample, prints them in `afterAll`)
    - `json-schema-fast-check` is not used: it bundles fast-check 1.x, incompatible with the fast-check 3 of this project
    - Generated files import only `vitest`, `fast-check`, `ajv`, `ajv-formats` and their sibling modules; the compiler also writes `package.json` (with `vitest` and `fast-check` as dev dependencies) and `vitest.config.ts` so `vitest run` works in the output directory whatever its location
    - Supported schema subset: objects (`required`, `additionalProperties`), arrays (`items`, `minItems`, `maxItems`, `uniqueItems`), strings (`minLength`, `maxLength`, `pattern`, `email`/`uuid`/`date-time` formats), `integer`/`number` bounds, `boolean`, `null`, `enum`, `const`, `anyOf`, `oneOf` (only with branches that cannot overlap), simple object `allOf` and type lists
    - Anything else is refused with an `UnsupportedSchemaError` naming the keyword and its location; the generator then writes explicitly skipped tests (reason in the title) and `compile` prints a warning, instead of properties that pass without proving anything
    - `compile` calls the generator after the compiler
    - Integration test runs the generated suite untouched (`tests/integration/pbt-generated.test.ts`); the real generated server is also called with payloads generated to break each schema and must never replay one (`tests/integration/workflow-e2e.test.ts`)
    - Checked outside the workspace: `daemonize compile --install` in a system temp folder, then `npm test` (generated suite) and the generated server over stdio
    - _Requirements: 9.1, 9.4, 9.5_

  - [x] 10.2 Write property tests for PBT Generator — Properties 7 and 8
    - **Property 7: Schema Round-Trip (PBT suite generation)** — every payload generated from each compiled schema is accepted by AJV, for schemas with bounds, required fields, formats, enum, alternatives and arrays (`tests/unit/pbt.test.ts`)
    - **Property 8: Invalid Payload Rejection (PBT suite generation)** — every payload built with an intentional violation is rejected; a test checks that all the kinds of violation (not an object, missing field, wrong type, out of range, unexpected field) are produced
    - **Validates: Requirements 9.2, 9.3**
    - _Tag comment: `// Feature: daemonize, Property 7: PBT valid round-trip; Property 8: PBT invalid rejection`_

- [x] 11. Implement CLI / Orchestrator
  - [x] 11.1 Implement `record` command in `src/cli/commands/record.ts`
    - Opens a visible browser on the URL (optionally from a saved login with `--storage-state`), attaches a `LiveRecorder`, waits for the user to press Enter or close the window
    - On session end: finishes the Workflow with the final screen, adds it to the workflow file (created, or merged when it exists) and reports steps, variables and workflow count
    - When the browser stops or the page crashes during a recording, the error is logged at once and the steps recorded so far are saved to `<file>.recovery.json`, itself a valid workflow file
    - `--type tui -- <command>` records a terminal program instead (see 11.6)
    - _Requirements: 1.4, 2.5, 2.7, 2.8, 10.6_

  - [x] 11.6 Record a terminal program
    - `recordTui` (`src/cli/commands/record-tui.ts`) runs the program in a pty, forwards what the user types, and turns it into steps with `TerminalRecorder`: text typed between two keys is one `type` step, every other key a `keypress` step named from `src/sandbox/keys.ts`; a Backspace in typed text edits the text instead of being recorded
    - Ctrl+] opens a menu: `v` marks the last typed text as a variable (name suggested from the prompt shown on screen), `e` ends the recording; the menu keys are never sent to the program
    - The recording also ends when the program exits, and says so with its exit code; typed values that were not marked as variables are stored as they are, and the command warns about them
    - Input is handled in order, after the screen has rendered what the program printed, so the suggested name does not depend on timing
    - `tests/unit/terminal-recorder.test.ts` and `tests/integration/record-tui.test.ts` (records a real interactive program, then replays it with another value)
    - _Requirements: 1.3, 1.4, 2.1, 2.7_

  - [x] 11.2 Implement `merge` command in `src/cli/commands/merge.ts`
    - Merges two Workflow set files by Workflow id (the newer wins) and writes the result
    - _Requirements: 10.6_

  - [x] 11.3 Implement `compile` command in `src/cli/commands/compile.ts`
    - Loads the Workflow set, runs `SchemaInferencer.inferWorkflows` and `Compiler.compile`; reports the output file paths
    - Also runs `PbtGenerator.generate` and reports the number of test files written
    - `--install` runs `npm install` in the output directory; without it nothing is downloaded and the command prints the next steps
    - The state graph schema is now imported as JSON (`resolveJsonModule`), so `tsc` copies it to `dist`; before, the built CLI failed at startup because `dist` lacked `state-graph.schema.json`
    - _Requirements: 5.6, 8.1_

  - [x] 11.4 Implement `serve` command in `src/cli/commands/serve.ts`
    - Runs the compiled `mcp-server.js` of an output directory over stdio (everything the command prints goes to stderr)
    - Payload validation, replay and error mapping happen inside the generated server: each call is validated with AJV against the inferred schema before any replay, and a violation returns `{ success: false, error: "validation", errors }`; replay timeouts and sandbox failures return `{ success: false, error }`
    - The compiler now also emits `mcp-server.js` and a `package.json` (ES module, run-time dependencies) so the Kiro Power's `mcp.json` can run `mcp-server.js` and it works after `npm install`
    - _Requirements: 6.1, 6.2, 7.1, 7.2, 8.3_

  - [x] 11.5 Implement `src/cli/index.ts` entry point
    - Registers `record`, `compile` and `merge` with `commander`; exports `buildProgram()`; `bin` entry in `package.json` points to `dist/cli/index.js`
    - `serve` is registered with task 11.4
    - Integration tests in `tests/integration/cli.test.ts`

- [x] 12. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Integration tests and final wiring
  - [x] 13.1 Write integration test: web recording round-trip
    - Records in a real browser against a local form, compiles, and the generated OpenAPI passes the OpenAPI 3.1 meta-schema (`tests/integration/cli.test.ts`, `live-recorder.test.ts`)
    - _Requirements: 5.1, 5.5_

  - [x]* 13.2 Write integration test: TUI recording round-trip
    - Records an interactive program (`tests/fixtures/greeter.mjs`), replays the recorded workflow, and runs the generated terminal server end to end (`record-tui.test.ts`, `tui-e2e.test.ts`)
    - _Requirements: 1.3, 2.1_

  - [x]* 13.3 Write integration test: MCP server tool registration
    - Runs the generated server over stdio with an MCP client, lists its tools, calls them, and checks that payloads generated to break each schema are never replayed (`workflow-e2e.test.ts`, `tui-e2e.test.ts`)
    - _Requirements: 5.2, 8.3_

  - [x]* 13.4 Write integration test: Kiro Power output validation
    - After compilation, `plugin.json` and `mcp.json` exist with a stdio server running `mcp-server.js`, the tools have schema-derived descriptions, and the file `mcp.json` runs exists (`compiler-outputs.test.ts`)
    - _Requirements: 8.1, 8.2_

- [x] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Emit a real Kiro Power
  - [x] 15.1 Rewrite `src/compiler/kiro-power-generator.ts` to emit the Kiro Power files
    - Emit `plugin.json`, `mcp.json` (absolute path to `mcp-server.js`, `type: "stdio"`, `command: "node"`), `skills/<name>/SKILL.md` and `POWER.md`; kebab-case name; keywords from the target name and the tool names
    - Update `src/types.ts` (`CompileResult.kiroPower`) and `src/compiler/compiler.ts` (write the files, stop writing `kiro-power.json`)
    - Update every caller and test that references `kiro-power.json`: grep the whole repo, including `src/cli`, README-like text and tests
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 15.2 Update tests for the Kiro Power output
    - `tests/unit/compiler-outputs.test.ts` (and any test naming `kiro-power.json`): assert the new files, that the absolute path in `mcp.json` exists, that keywords are non-empty and that `SKILL.md` lists every tool
    - Add a unit test for kebab-case naming and for a target name with spaces and accents
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 15.3 Integration test: start the server from `mcp.json`
    - Compile a sample, spawn the command from `mcp.json` with the working directory set to another directory, connect an MCP client, and assert the listed tools equal the tools in `SKILL.md`
    - _Requirements: 8.6_

  - [x] 15.4 Checkpoint — `npx tsc --noEmit` and `npx vitest run` pass
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Verified outside the workspace: a web project and a terminal project were generated, installed with `daemonize compile --install`, their generated property tests were run, `npm audit` reported no vulnerability, and their generated servers were called over stdio with a valid payload (replayed) and an invalid one (refused).
- Replay in Docker (4.5) was verified with a real Docker daemon, for a terminal target and for a web target. `SandboxManager` (dockerode) is still only exercised against a fake Docker: the generated server drives Docker with the `docker` command instead.
- Not done: recording inside a container.

- Sub-tasks postfixed with `*` are optional and can be skipped for a faster MVP; core property-based tests (2.3, 2.5, 2.6, 8.2, 8.3, 10.2) are **not** marked optional because they verify the eight correctness properties that are a core correctness guarantee of the system.
- Each task references specific requirements for traceability.
- Use `vitest --run` (not `vitest --watch`) when running tests from the CLI.
- The generated MCP server (`mcp-server.ts`) and test suite files are standalone — do not import from `src/` at runtime.
- All eight design-document properties are covered: P1 → 2.5, P2 → 2.3, P3 → 8.2, P4 → 8.3, P5 → 2.6, P6 → 2.6, P7 → 10.2, P8 → 10.2.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 5, "tasks": ["4.4", "5.2", "5.3"] },
    { "id": 6, "tasks": ["5.4", "6.1"] },
    { "id": 7, "tasks": ["5.5", "6.2", "6.3", "6.4"] },
    { "id": 8, "tasks": ["6.5", "8.1"] },
    { "id": 9, "tasks": ["6.6", "8.2", "8.3", "9.1"] },
    { "id": 10, "tasks": ["9.2", "10.1"] },
    { "id": 11, "tasks": ["10.2", "11.1", "11.2", "11.3"] },
    { "id": 12, "tasks": ["11.4", "11.5"] },
    { "id": 13, "tasks": ["13.1", "13.2", "13.3", "13.4"] },
    { "id": 14, "tasks": ["9.3", "9.4", "9.5", "11.6"] },
    { "id": 15, "tasks": ["4.5"] },
    { "id": 16, "tasks": ["15.1"] },
    { "id": 17, "tasks": ["15.2", "15.3"] }
  ]
}
```
