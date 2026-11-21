# Requirements Document

## Introduction

Daemonize records an action in a browser (or a terminal program), compiles it into a generated MCP server, and lets the user test it in the Studio and add it to Kiro. A review of the project against the Kiroween 2026 judging criteria scored Design 5.5/10 and Innovation 6/10, and noted that several Kiro features are used by the project's users but not by the project itself: custom agents (`.kiro/agents/`), skills (`.kiro/skills/`), an MCP server that extends Kiro during development, and the project as a Kiro Power. This spec closes that gap with five items. The codes match the order of the request.

1. **I1, an agent that builds its own tools.** A new MCP server, the Studio_MCP, exposes the Studio API to an agent. A custom agent (`.kiro/agents/daemonize.md`) and a skill (`.kiro/skills/daemonize-builder/SKILL.md`) guide the agent from a user goal to a compiled, tested tool added to Kiro. The Kiro_Extension offers "Build a tool with the Daemonize agent".
2. **I2, a semantic firewall.** A generated tool of risk `write` or `delete` called from Kiro waits for a human decision when the Approval_Setting is on. Every call from Kiro is written to an Audit_Log that the Studio shows in a new Activity_View and the Kiro_Extension summarises.
3. **D1, onboarding inside Kiro.** The Kiro_Extension installs the Daemonize program in one click, checks that a browser exists, shows a Walkthrough and an empty-state welcome.
4. **D2, visible replay.** The Playground shows a Replay_Timeline with one row per step: label, level, duration, status, a thumbnail when one exists, and visible drift, blocked and skipped steps. The Activity_View shows a simplified timeline.
5. **D4, Daemonize as a Kiro Power.** A `power/` folder packages Daemonize (the Studio_MCP, steering, skill and agent) in the real Kiro Power format, installable from Kiro's Powers panel and from the Kiro_Extension.

The README section "Built with Kiro" is rewritten as a feature table (Requirement 29). The two items out of scope are I3 (a Kiro crew application) and D3 (a full visual unification beyond what the items above need).

Facts the requirements rely on, verified in the code:

- The Studio is one `node:http` server per process (`src/studio/server.ts`). Routes are registered in `src/studio/routes/` (`record`, `sessions`, `secrets`, `compile`, `power`, `workflows`) and in `handlePlayground`. A route is `GET` or `POST` only, carries `remote: 'blocked'`, answers 409 in sample mode when it writes, and every JSON answer passes through `redactForStudio`.
- `daemonize studio --machine` prints one JSON line `{ origin, token, pid }` on stdout and sends messages to stderr (`src/cli/commands/studio.ts`). The Kiro_Extension parses it with `parseHandshakeLine` and starts the Studio in `process-manager.ts`. The token lives in memory only.
- The Playground (`src/studio/playground.ts`) starts the generated server over stdio from `mcp.json`, validates arguments against the input schema, refuses a call to a `write` or `delete` tool without `confirm: true` (409 `confirmation_required`), keeps the last 50 calls with secret-typed arguments shown as `***`, and starts the child with `DAEMONIZE_MODE` and, when asked, `DAEMONIZE_SCREENSHOT=final`.
- The risk of a tool is `risk.highest` of `buildWorkflowView` (`src/studio/model.ts`): `read`, `write` or `delete`. `writeStepsOf` lists the write steps with `index`, `label`, `risk` and `kind` (`login` or `action`).
- A generated `mcp-server.ts` registers one tool per workflow with `server.tool(name, description, zodShape, handler)`, adds a reserved `_timeoutMs` argument, validates the payload with Ajv, calls `runReplay`, and answers one JSON text block with `success`, `drifted`, `driftChecked`, `mode`, `levels` (when compiled with `--http auto`), `skippedSteps` and `failure`. It carries no per-tool risk and no per-step trace today. A write or delete HTTP request that failed is not repeated on another level (`levels` then holds `not_run`).
- The Kiro install entry written by the Power_Installer (`mcp-snippet.ts`) holds `type`, `command`, `args` and an `env` with `DAEMONIZE_MODE`, `DAEMONIZE_DATA_DIR`, `DAEMONIZE_APP_KEY` and `${NAME}` placeholders for missing secrets.
- The compiler writes `plugin.json`, `mcp.json`, `skills/<name>/SKILL.md` and `POWER.md` per application (`src/compiler/kiro-power-generator.ts`). `POWER.md` has a front matter with `name`, `displayName`, `description` and `keywords`.
- Kiro custom agents are a Markdown file (front matter holds the configuration, the body is the system prompt) or a JSON file in `.kiro/agents/` or `~/.kiro/agents/`. The configuration reference lists `name`, `description`, `model`, `tools` (selectors such as `read`, `write`, `shell`, `@server`, `@server/tool`), `excludedTools`, `includeMcpJson`, `includePowers`, `mcpServers`, `resources` (`file://` and `skill://`), `permissions.rules` (`capability`, `match`, `exclude`, `effect` of `allow`, `ask` or `deny`) and `welcomeMessage`. Capabilities include `fs_read`, `fs_write`, `shell`, `mcp` and `skill`. A deny in any scope wins.
- A skill is `.kiro/skills/<name>/SKILL.md` that starts with a YAML front matter holding `name` and `description`.

Constraints that apply to every requirement:

- Old `daemonize.workflows.json` files load without change. CLI commands, flags and default output stay as they are, and Studio routes keep their paths, methods and answers, except where a requirement names the change.
- A generated server compiled before this change keeps working and behaves as before. A generated server compiled after this change behaves as before unless the Approval_Setting, the Audit_Log or the trace opt-in is on (Requirements 11, 15 and 22).
- `src/replay/runtime/*` stays copyable into the output folder and imports nothing from `src/` (`tests/unit/generated-no-src-import.test.ts`). The generated server imports nothing from `src/` either.
- `kiro-extension/src/core/` imports neither `vscode` nor the root `src/` (`tests/extension/static/imports.test.ts`). No hard-coded hex colour appears in the extension UI code (`tests/extension/static/no-hardcoded-colors.test.ts`). The extension bundles no `playwright` and no `node-pty`.
- Text on the main screens of the Studio and of the extension uses Plain_Language (`kiro-extension/src/core/plain-language.ts`, `src/studio/ui/js/copy.js`, `tests/extension/static/plain-language.test.ts`).
- `src/studio/ui/app.css` holds no literal colour outside `:root` and every text colour keeps a contrast ratio of at least 4.5:1 (`tests/unit/studio-ui-contrast.test.ts`).
- No secret value appears in a file, a log, a URL, an MCP result, an approval, the Audit_Log, a notification or a test fixture. `npm run check:secrets` and `findPlainSecrets` keep passing.
- The Studio security model stays in force: loopback listener, per-process token, no CORS header, `remote: 'blocked'` on every new route that reads or changes the user's data.
- Each requirement is delivered as its own commit. Nothing is pushed unless the user asks.

Assumptions (taken from the code and the request, not asked):

- The Studio_MCP is a command of the existing CLI that speaks MCP over stdio. Its exact name (for example `daemonize mcp`) is decided in the design. It calls the Studio over loopback with the token, the way the Kiro_Extension does, and adds no route that is open to a remote listener.
- One Studio serves one workspace folder at a time. The Studio_MCP uses the Studio that already runs for the folder (the Studio_Lease, Requirement 1) and starts its own with `daemonize studio --machine` only when none runs.
- The Approval_Setting is a property of one Kiro install (one application, one scope). It is stored as a non-secret setting in the install entry and in the install record, and the Generated_Server reads it at start. The exact storage is decided in the design.
- The approval channel is shared through the App_Data_Dir, so that a Generated_Server started by Kiro needs no Studio address or token. The design decides between a file queue and a loopback broker. The requirements fix the behaviour. When no approver is available, the call fails closed (Requirement 12), and no Studio is started automatically, because a Generated_Server imports nothing from `src/`.
- A call made by the Studio itself (the Playground, a human clicking "Run") is a decision of the person at the screen. The Playground keeps its own confirmation dialog, and its calls are recorded in the Audit_Log with the decision `auto` and the source `studio`.
- The Studio_MCP never approves, denies or confirms on behalf of the user. Approval is a human action in the Kiro_Extension or the Studio_UI.
- The trace of a call is collected by the Generated_Server for every call and written into the Audit_Log entry in compact form. It is added to the MCP result only when the Studio asks for it, the same way `DAEMONIZE_SCREENSHOT=final` is asked for today. The step thumbnails shown in the Replay_Timeline are the recorded thumbnails served by the whitelisted assets route (steps with a secret excluded) and the failure picture the Playground already keeps. No new picture is taken.
- The Published_Package of the Daemonize program (its npm name and version) is a single constant in the extension, chosen at publication time. The CLI_Installer installs it with `npm` into a folder owned by the extension, without administrator rights. The extension bundles no copy of the program, because the program depends on `playwright` and `node-pty`.
- The `power/` folder is installable by "Install from folder" or "Install from repository URL" in the Kiro Powers panel, and by a command of the Kiro_Extension that copies it into the Kiro folder through the same transaction code as the Power_Installer.
- A tool is Read_Only when its risk is `read`. The default of the Approval_Setting is on for a tool whose risk is `write` or `delete`, and off for a `read` tool.
- Default values: approval timeout 120 s (allowed range 5 s to 600 s), Audit_Log retention 1000 entries or 1 MiB, whichever is reached first, argument values clipped to 200 characters in the Audit_Log and in an approval.
- The Studio logs nothing of the arguments of a call except through the Redactor.

## Glossary

- **Studio**: The local web application and JSON API started by `daemonize`.
- **Studio_Server**: `src/studio/server.ts` with the routes of `src/studio/routes/`.
- **Studio_UI**: The pages under `src/studio/ui/`.
- **Studio_Lease**: A record, in the App_Data_Dir, that a running Studio writes at start and removes at exit. It holds the address, the token and the process id for one workspace folder. The file is readable by its owner only and is never written inside a workspace folder.
- **Studio_MCP**: The new MCP server, started by a CLI command, that exposes Studio operations as MCP tools to an agent.
- **Studio_MCP_Tool**: One tool of the Studio_MCP.
- **Redactor**: `redactForStudio` and the argument redaction of `src/studio/playground.ts` (`redactArguments`, `sensitiveValues`, `isSensitiveKey`).
- **Workflow_File**: The JSON file `daemonize.workflows.json` holding one Workflow_Set.
- **Action**: One workflow of the Workflow_File, shown to the user as an action and to an agent as a tool.
- **Tool_Risk**: `risk.highest` of an Action: `read`, `write` or `delete`.
- **Generated_Server**: The `mcp-server.js` that `daemonize compile` writes into the output folder, with its `replay.js` and `docker-replay.js`.
- **Generated_Tool**: One tool of a Generated_Server.
- **Playground**: The Studio view and the routes under `/api/playground` that call a Generated_Server.
- **Kiro_Extension**: The extension in `kiro-extension/`.
- **Power_Installer**: `StudioPowerInstaller` in `src/studio/power-installer.ts`, which writes the Kiro install entry and skill for one application.
- **Install_Scope**: `global` ("All my projects") or `project` ("Only this project").
- **Builder_Agent**: The custom agent file `.kiro/agents/daemonize.md`.
- **Builder_Skill**: The skill file `.kiro/skills/daemonize-builder/SKILL.md`.
- **Daemonize_Power**: The folder `power/` of the repository, packaging Daemonize itself as a Kiro Power.
- **Approval_Setting**: The option "Ask before changes" of a Kiro install. Values: on, off.
- **Approval_Gate**: The check inside a Generated_Server that holds a call of a `write` or `delete` Generated_Tool until the Approval_Decision is known.
- **Approval_Request**: One pending question to the user: a request id, the tool, the application, the Tool_Risk, the Redacted_Arguments, the write steps, the time it was created and its timeout.
- **Approval_Decision**: `approved`, `denied` or `timeout`.
- **Approver**: The human interface that shows an Approval_Request and records an Approval_Decision: the Kiro_Extension sidebar or the Activity_View of the Studio_UI.
- **Approval_Channel**: The mechanism that carries an Approval_Request from a Generated_Server to an Approver and the Approval_Decision back. The mechanism is decided in the design.
- **Redacted_Arguments**: A copy of the call arguments where every secret-typed argument (declared by the workflow, or whose name matches `isSensitiveKey`) is `***`, every known secret value is removed, and every text value is clipped to 200 characters.
- **Write_Steps**: The result of `writeStepsOf` for an Action: the steps of risk `write` or `delete`, each with `index`, `label`, `risk` and `kind`.
- **App_Data_Dir**: The per-user folder of `src/studio/app-data.ts` that holds the vault and the saved sessions, never inside a workspace or a git work tree.
- **Audit_Log**: The append-only file of Audit_Entries in the App_Data_Dir, one JSON object per line.
- **Audit_Entry**: One line of the Audit_Log with the fields of Requirement 15.
- **Activity_View**: The new Studio view "Activity" that lists Audit_Entries and pending Approval_Requests.
- **Activity_Summary**: The short section of the Kiro_Extension sidebar that summarises recent Audit_Entries and pending Approval_Requests.
- **Trace**: The per-step record of one call: an array of Trace_Steps.
- **Trace_Step**: One element of a Trace with `index`, `label`, `level`, `durationMs`, `status` and, when the status explains it, `note`.
- **Step_Level**: One of `http`, `accessibility`, `vision`, `terminal`, `skipped`, `not_run`.
- **Step_Status**: One of `ok`, `failed`, `skipped`, `not_run`, `blocked`, `drifted`.
- **Trace_Opt_In**: The setting by which the Studio asks a Generated_Server to return the Trace in its result.
- **Replay_Timeline**: The Studio_UI component that shows a Trace as one row per step.
- **CLI_Installer**: The Kiro_Extension code that installs the Daemonize program for the user.
- **Published_Package**: The npm package that holds the Daemonize program.
- **Browser_Check**: The Kiro_Extension check that a Chromium, Google Chrome or Microsoft Edge browser is available for replay.
- **Walkthrough**: The `contributes.walkthroughs` entry "Get started with Daemonize" of the Kiro_Extension.
- **Welcome_State**: The empty-state text and button of the Actions view of the Kiro_Extension.
- **Plain_Language**: The rule of `kiro-extension/src/core/plain-language.ts`: none of record, compile, storage state, environment variable, MCP, JSON, token, CLI as a whole word on main screens.
- **Secret_Name**: The upper-case name of a credential (for example `PASSWORD`), matching `^[A-Z][A-Z0-9_]*$`. Never the value.
- **Built_With_Kiro_Table**: The feature table that replaces the README section "Built with Kiro".
- **Regression_Snapshot**: The snapshot built by `tests/helpers/regression-snapshot.ts`: what the loader, the compiler and the pure replay runtime make of one Workflow_File, including the text of `mcp-server.ts`, `replay.ts` and `docker-replay.ts`.
- **Verification_Suite**: The commands listed in Requirement 30.

## Requirements

### Requirement 1: Start the Studio_MCP and attach to a Studio

**User Story:** As a Kiro user, I want an agent to reach Daemonize through one MCP server that starts by itself, so that I do not run a Studio by hand before asking the agent to build a tool.

#### Acceptance Criteria

1. THE Daemonize CLI SHALL provide one command that starts the Studio_MCP and serves the MCP protocol over stdio, with no output on stdout other than MCP messages.
2. WHEN the Studio_MCP starts and a Studio_Lease for the workspace folder exists and the process in it is alive, THE Studio_MCP SHALL use that Studio and SHALL start no second Studio for the folder.
3. WHEN the Studio_MCP starts and no live Studio_Lease exists for the workspace folder, THE Studio_MCP SHALL start `daemonize studio --machine` as a child process in the workspace folder, read the one JSON handshake line (`origin`, `token`, `pid`), and use that Studio.
4. WHEN a Studio starts for a workspace folder, THE Studio_Server SHALL write a Studio_Lease into the App_Data_Dir readable by its owner only, and WHEN the Studio ends, THE Studio_Server SHALL remove that Studio_Lease.
5. IF a Studio_Lease names a process that is not alive, THEN THE Studio_MCP SHALL ignore that Studio_Lease, SHALL remove it, and SHALL start its own Studio.
6. WHEN the Studio_MCP started its own Studio and the Studio_MCP ends, THE Studio_MCP SHALL stop that Studio within 5 seconds, and SHALL leave a Studio it only attached to running.
7. IF the Studio cannot be reached or started within 20 seconds, THEN THE Studio_MCP SHALL answer every tool call with a plain error that says the Studio did not start and names the Kiro_Extension "Show log" command as the next step, without a path, an address or a token.
8. THE Studio_MCP SHALL send the Studio token only in the `x-studio-token` header of loopback requests, SHALL accept only a loopback origin, and SHALL write the token to no file other than the Studio_Lease, no log and no MCP result.
9. WHEN `daemonize studio --machine` is run by a Daemonize program that does not know the Studio_Lease, THE Studio_MCP SHALL fall back to starting its own Studio, so that an older Studio keeps working.
10. FOR ALL Studio_Lease contents, THE Studio_Lease reader SHALL return either a complete lease (address, token, pid) or nothing, and a corrupt or truncated file SHALL return nothing and SHALL not throw (error condition).

### Requirement 2: Read actions, credentials and activity through the Studio_MCP

**User Story:** As an agent, I want to see which actions exist, what they need and what happened, so that I can decide the next step without guessing.

#### Acceptance Criteria

1. THE Studio_MCP SHALL expose the read tools `list_actions`, `get_action`, `list_credentials` and `get_activity`, each with a title, a description in plain English and a JSON input schema.
2. WHEN `list_actions` is called, THE Studio_MCP SHALL answer, for each Action, the workflow id, the tool name, the label, the description, the Tool_Risk, the variables (name, type, optional) and whether the output folder is compiled.
3. WHEN `get_action` is called with a workflow id, THE Studio_MCP SHALL answer the same fields as `list_actions` for that Action plus the step labels and the Write_Steps, and no recorded value.
4. IF `get_action` is called with an unknown workflow id, THEN THE Studio_MCP SHALL answer an error result with the text "No action has this id." and the list of known ids.
5. WHEN `list_credentials` is called, THE Studio_MCP SHALL answer the Secret_Names the actions need, each with its kind and a `configured` flag, and SHALL answer no secret value.
6. WHEN `list_credentials` finds a Secret_Name that is not configured, THE Studio_MCP SHALL add a plain instruction that the user enters the value in the Credentials screen of the Studio or the Daemonize sidebar of Kiro, and SHALL include no address and no token in that instruction.
7. THE Studio_MCP SHALL expose no tool, and no argument of any tool, that accepts a secret value.
8. WHEN `get_activity` is called with an optional `limit` from 1 to 100 (default 20), THE Studio_MCP SHALL answer the newest Audit_Entries in newest-first order, each already redacted as in Requirement 15.
9. IF `get_activity` is called with a `limit` outside 1 to 100 or not a whole number, THEN THE Studio_MCP SHALL answer an error result that names the field and the allowed range.
10. FOR ALL answers of the read tools, THE Studio_MCP SHALL pass the answer through the Redactor, so that no known secret value appears in it.

### Requirement 3: Record an action through the Studio_MCP

**User Story:** As an agent, I want to start a recording and follow it while the user does the clicks, so that the tool is made from the user's real actions.

#### Acceptance Criteria

1. THE Studio_MCP SHALL expose the tools `start_recording`, `get_recording_status` and `finish_recording`.
2. WHEN `start_recording` is called with `name`, `url` and an optional boolean `reuseSession`, THE Studio_MCP SHALL send the same request as `POST /api/record/start` and SHALL answer the state `recording` and a plain sentence that the user now does the steps in the browser window that opened.
3. IF `start_recording` is called with a field other than `name`, `url` and `reuseSession`, a `name` or `url` that the Studio refuses, or a second origin in one file, THEN THE Studio_MCP SHALL answer an error result that carries the plain message of the Studio and the field name.
4. WHEN `get_recording_status` is called, THE Studio_MCP SHALL answer the state of `GET /api/record/status` (`idle`, `recording`, `saving`, `compiling`, `done` or `error`) with the plain text of the Studio, and SHALL add the variables found so far when the Studio reports them.
5. WHEN `finish_recording` is called while a recording is active, THE Studio_MCP SHALL send the same request as `POST /api/record/stop` and SHALL answer the state `saving`.
6. IF `finish_recording` is called while no recording is active, THEN THE Studio_MCP SHALL answer an error result with the plain message of the Studio.
7. THE Studio_MCP SHALL leave the user in control of the browser: THE Studio_MCP SHALL expose no tool that clicks, types or navigates in the recorded page.
8. WHEN a recording ends in the state `error`, THE Studio_MCP SHALL answer the plain error text of the Studio and SHALL answer no stack trace and no path.
9. WHERE the Studio runs in sample mode, THE Studio_MCP SHALL answer the 409 message of the Studio for `start_recording` and `finish_recording`.

### Requirement 4: Compile and test an action through the Studio_MCP

**User Story:** As an agent, I want to compile the actions and test one with arguments, so that I can show the user a working tool before it is added to Kiro.

#### Acceptance Criteria

1. THE Studio_MCP SHALL expose the tools `compile` and `test_action`.
2. WHEN `compile` is called with optional `http` (`off` or `auto`) and optional boolean `healSupport`, THE Studio_MCP SHALL send the same request as `POST /api/compile`, wait until `GET /api/compile/status` leaves `running` or 120 seconds pass, and answer the final state with the plain text of the Studio.
3. IF `compile` is called while a compile or a recording runs, THEN THE Studio_MCP SHALL answer an error result with the plain message of the Studio.
4. WHEN `test_action` is called with `tool`, optional `arguments`, optional `mode` and optional `timeoutMs`, THE Studio_MCP SHALL send the same request as `POST /api/playground/call` and SHALL answer the summary of the result (`success`, `drifted`, `driftChecked`, `healed`, `mode`, `levels`, `skippedSteps`, `text`, `data`, `error`), without a screenshot path.
5. WHEN `test_action` is called for a Generated_Tool of Tool_Risk `read`, THE Studio_MCP SHALL run it without a confirmation.
6. WHEN `test_action` is called for a Generated_Tool of Tool_Risk `write` or `delete` without `confirm: true`, THE Studio_MCP SHALL not run it and SHALL answer the error `confirmation_required` with the Tool_Risk, the Write_Steps and the sentence that the user must confirm.
7. WHEN `test_action` is called for a Generated_Tool of Tool_Risk `write` or `delete` with `confirm: true`, THE Studio_MCP SHALL create an Approval_Request with the source `studio-mcp`, SHALL wait for the Approval_Decision, and SHALL send the call to the Playground only after the decision `approved`.
8. IF the Approval_Decision of a `test_action` call is `denied` or `timeout`, THEN THE Studio_MCP SHALL run no step and SHALL answer an error result with the code `approval_denied` or `approval_timeout` and a plain sentence.
9. IF `test_action` is called with arguments that do not fit the input schema of the tool, THEN THE Studio_MCP SHALL answer the validation errors of the Playground and SHALL not start the Generated_Server.
10. IF the Generated_Server answers `missing_secret`, THEN THE Studio_MCP SHALL answer the Secret_Name that is missing and the instruction of Requirement 2 criterion 6, and SHALL answer no value.
11. THE Studio_MCP SHALL scrub the answer of `test_action` with the Redactor, so that no known secret value appears in it.

### Requirement 5: Connect to Kiro and edit actions through the Studio_MCP

**User Story:** As an agent, I want to add a tested tool to Kiro and fix or remove an action, so that the whole journey ends in Kiro with no manual file edits.

#### Acceptance Criteria

1. THE Studio_MCP SHALL expose the tools `preview_kiro_install`, `install_to_kiro`, `update_action` and `delete_action`.
2. WHEN `preview_kiro_install` is called with `scope` (`global` or `project`), THE Studio_MCP SHALL send the same request as `POST /api/power/preview` and SHALL answer the plan in plain words (the application, the scope, the tools, the credentials still missing by name) and a `confirmationId`.
3. WHEN `install_to_kiro` is called with `scope` and a `confirmationId`, THE Studio_MCP SHALL create an Approval_Request with the source `studio-mcp` that names the application and the scope, and SHALL send `POST /api/power/install` only after the decision `approved`.
4. IF the decision of an `install_to_kiro` call is `denied` or `timeout`, THEN THE Studio_MCP SHALL write no file and SHALL answer an error result with the code `approval_denied` or `approval_timeout`.
5. WHEN `install_to_kiro` succeeds, THE Studio_MCP SHALL answer the names of the credentials still missing and a plain sentence that Kiro has to be reloaded or the server enabled, and SHALL answer no value.
6. WHEN `update_action` is called with `id`, `confirm: true` and the fields that `POST /api/workflows/update` accepts, THE Studio_MCP SHALL send that request and SHALL answer the updated Action in the form of Requirement 2 criterion 2.
7. IF `update_action` is called without `confirm: true`, THEN THE Studio_MCP SHALL change nothing and SHALL answer the error `confirmation_required`.
8. WHEN `delete_action` is called with `id` and `confirm: true`, THE Studio_MCP SHALL create an Approval_Request with the source `studio-mcp`, and SHALL send `POST /api/workflows/delete` only after the decision `approved`.
9. IF `delete_action` is called without `confirm: true`, or the decision is `denied` or `timeout`, THEN THE Studio_MCP SHALL delete nothing and SHALL answer the error `confirmation_required`, `approval_denied` or `approval_timeout`.
10. THE Studio_MCP SHALL expose no tool that removes an install from Kiro, reads or writes the vault, changes the Approval_Setting, approves or denies an Approval_Request, or forgets a saved session.

### Requirement 6: Keep the Studio_MCP inside the Studio security model

**User Story:** As a user, I want the agent to have exactly the powers listed and no more, so that giving it Daemonize does not open a new door.

#### Acceptance Criteria

1. THE Studio_MCP SHALL reach the Studio only through its documented routes, over a loopback address, and SHALL add no new Studio route that a remote listener can call.
2. THE Studio_MCP SHALL answer every failure as an MCP result with `isError: true` and a plain English message, with no stack trace, no file path of the user's machine, no address and no token.
3. WHEN a Studio route answers a status of 400 to 599, THE Studio_MCP SHALL use the `error` text of the answer, passed through the Redactor, as the message of the error result.
4. THE Studio_MCP SHALL limit the text of one answer to 20000 characters and SHALL mark a longer answer as cut.
5. THE Studio_MCP SHALL answer each tool call within the time of the underlying request plus 5 seconds, and SHALL answer a plain timeout error when the Studio does not answer.
6. FOR ALL tool calls and answers, THE Studio_MCP SHALL leave every value of the vault, of the environment `DAEMONIZE_SECRET_*` variables and of a storage state out of the answer, the log and the Approval_Request.
7. IF a tool is called with a field that its input schema does not list, THEN THE Studio_MCP SHALL refuse the call with an error result that names the field and SHALL send no request to the Studio.
8. FOR ALL tool names the Studio_MCP lists, THE name SHALL match `^[a-z][a-z0-9_]*$` and be at most 64 characters, and the list SHALL equal the tools named in Requirements 2 to 5.

### Requirement 7: A custom agent that builds tools with Daemonize

**User Story:** As a Kiro user, I want to pick a "Daemonize" agent in the chat, so that I can say what software task I need and get a tool without learning the Studio.

#### Acceptance Criteria

1. THE repository SHALL contain the Builder_Agent at `.kiro/agents/daemonize.md` as a Markdown file whose front matter parses as YAML and whose body is the system prompt.
2. THE Builder_Agent front matter SHALL define `name: daemonize`, a `description` of at most 200 characters, `tools`, `resources`, `permissions` and a `welcomeMessage`.
3. THE Builder_Agent `tools` SHALL list `read` and the Studio_MCP server (`@daemonize-studio`), and SHALL not list `write`, `shell`, `web` or `*`.
4. THE Builder_Agent `permissions.rules` SHALL deny the `shell` and `fs_write` capabilities with the match `**`, SHALL allow `fs_read`, and SHALL set the effect `allow` for the read tools of Requirements 2 and 3 and the effect `ask` for `test_action`, `install_to_kiro`, `update_action` and `delete_action`.
5. THE Builder_Agent `resources` SHALL include `file://.kiro/steering/product.md`, `file://README.md` and `skill://.kiro/skills/daemonize-builder/SKILL.md`, and every `file://` and `skill://` path in `resources` SHALL name a file that exists in the repository.
6. THE Builder_Agent `mcpServers` or `includeMcpJson` SHALL make the Studio_MCP available to the agent without a copy of any secret, and any `env` value SHALL be a `${NAME}` placeholder.
7. THE Builder_Agent prompt SHALL instruct the agent, in this order, to understand the user's goal, ask the user to confirm the application and address, start the recording and let the user do the clicks, review the variables (name, type, optional), compile, test in the Playground, add the tool to Kiro, and explain which credentials the user still has to enter.
8. THE Builder_Agent prompt SHALL instruct the agent to ask the user to enter every secret in the Credentials screen, never to ask the user to type a secret in the chat, and never to put a secret in any tool argument.
9. THE Builder_Agent prompt SHALL instruct the agent to call a tool of Tool_Risk `write` or `delete` only after the user said so in the chat, and to tell the user that a human approval follows.
10. THE Builder_Agent prompt, description and welcome message SHALL pass the Plain_Language rule where they address the user.
11. THE repository SHALL contain a copy of the Builder_Agent as a template in `power/agents/daemonize.md` (Requirement 24) that differs from `.kiro/agents/daemonize.md` only in the paths of its `resources`.
12. FOR ALL files of `.kiro/agents/`, THE test suite SHALL check that the front matter parses, that every field name is in the list of the Kiro configuration reference, and that no `permissions.rules` entry has the effect `allow` for a capability of `shell` or `fs_write`.

### Requirement 8: A skill that teaches the agent the journey

**User Story:** As an agent, I want a skill that says when and how to use Daemonize, so that I follow the safe path.

#### Acceptance Criteria

1. THE repository SHALL contain the Builder_Skill at `.kiro/skills/daemonize-builder/SKILL.md`, starting with a YAML front matter that holds `name: daemonize-builder` and a `description` of at most 300 characters that says when to use it.
2. THE Builder_Skill SHALL contain the sections "When to use", "Steps", "Safety rules" and "Troubleshooting".
3. THE Builder_Skill "When to use" section SHALL describe software with no API (a web admin, a terminal program) and SHALL say when not to use Daemonize (an application that has an API or an MCP server).
4. THE Builder_Skill "Steps" section SHALL list the Studio_MCP tools in the order of Requirement 7 criterion 7, each with the plain result the agent expects.
5. THE Builder_Skill "Safety rules" section SHALL state that a write or delete call needs the user's explicit word and a human approval, that secrets go through the Credentials screen only, that the agent never reads or asks for a secret value, and that a result with `drifted: true` is reported to the user before the result is used.
6. THE Builder_Skill "Troubleshooting" section SHALL cover the results `missing_secret`, `drifted`, `approval_denied`, `approval_timeout`, `approval_unavailable` and `storage_state_missing`, each with the next action for the user.
7. THE Builder_Skill SHALL contain no secret value, no absolute path of a user machine and no token.
8. THE Builder_Skill SHALL use the same tool names as the Studio_MCP, and the test suite SHALL fail when the Builder_Skill names a tool that the Studio_MCP does not list, or the Studio_MCP lists a tool that the Builder_Skill does not name.
9. THE `daemonize-builder` skill file in `power/skills/daemonize-builder/SKILL.md` SHALL be identical to the file in `.kiro/skills/daemonize-builder/SKILL.md`.

### Requirement 9: "Build a tool with the Daemonize agent" in the Kiro sidebar

**User Story:** As a Kiro user, I want a button in the Daemonize sidebar that starts the agent, so that I do not look for the agent picker.

#### Acceptance Criteria

1. THE Kiro_Extension SHALL contribute the command `daemonize.buildWithAgent` with the title "Build a tool with the Daemonize agent", shown in the Actions view title and in the Welcome_State.
2. WHEN the user runs `daemonize.buildWithAgent` and the Kiro or VS Code API provides a command that opens the chat with a named custom agent, THE Kiro_Extension SHALL run that command with the agent `daemonize`.
3. IF no command of the host can open the chat with a named agent, THEN THE Kiro_Extension SHALL show a plain notification that says "Open the chat and pick the Daemonize agent from the agent list" and SHALL offer the button "Open the chat" that runs the chat-opening command the host provides, when there is one.
4. IF the file `.kiro/agents/daemonize.md` does not exist in the open folder and not in the user's `~/.kiro/agents/`, THEN THE Kiro_Extension SHALL offer the button "Add the Daemonize agent", and WHEN the user confirms, THE Kiro_Extension SHALL copy the agent and its skill from the extension's bundled templates into the scope the user chooses (Install_Scope), without overwriting an existing file.
5. WHEN the Kiro_Extension copies the agent, THE Kiro_Extension SHALL write the Studio_MCP entry to the Kiro settings through the transaction code of the Power_Installer (backup, all-or-nothing), with `${NAME}` placeholders only.
6. THE Kiro_Extension SHALL show the notification and the buttons of this requirement in Plain_Language.
7. THE Kiro_Extension SHALL log no path and no token in the "Daemonize" output when it runs `daemonize.buildWithAgent`.
8. THE bundled agent and skill templates SHALL be the same bytes as `power/agents/daemonize.md` and `power/skills/daemonize-builder/SKILL.md` (checked by a test).

### Requirement 10: Choose "Ask before changes" per install

**User Story:** As a Kiro user, I want changes to my software to wait for my approval, so that an agent cannot change data on its own.

#### Acceptance Criteria

1. WHEN the Power_Installer installs a Kiro entry for an application whose Tool_Risk is `write` or `delete` for at least one tool, THE Power_Installer SHALL set the Approval_Setting on by default.
2. WHEN the Power_Installer installs a Kiro entry for an application whose tools are all `read`, THE Power_Installer SHALL leave the Approval_Setting off and SHALL show no approval option.
3. THE Power_Installer SHALL show the Approval_Setting in the preview (`POST /api/power/preview`) as a boolean `askBeforeChanges` with the list of tool names it applies to, and SHALL accept `askBeforeChanges` as an optional boolean in `POST /api/power/install`.
4. IF `POST /api/power/install` carries an `askBeforeChanges` that is not a boolean, THEN THE Studio_Server SHALL answer 400 with the plain message of the Power_Installer and SHALL write nothing.
5. WHEN a Kiro install already exists and the user installs it again ("Add to Kiro" again), THE Power_Installer SHALL apply the default of criterion 1 or 2 unless the install record holds an explicit user choice, in which case THE Power_Installer SHALL keep that choice.
6. WHILE a Kiro install exists that was written before this change, THE Power_Installer SHALL leave its entry unchanged until the user adds the tool again, and the Approval_Setting of that install SHALL read as off.
7. WHEN the user turns the Approval_Setting off for an install, THE Kiro_Extension SHALL ask for a confirmation in Plain_Language that says changes will run without a question, and THE Studio_Server SHALL write the choice to the install record and the entry.
8. THE Approval_Setting SHALL be readable by the Generated_Server as a non-secret value of its environment, and SHALL appear in the install entry and the install record as a plain `true` or `false`.
9. THE Kiro_Extension SHALL show the Approval_Setting of each install in the Kiro view as "Ask before changes: on" or "off", with a command to change it.
10. FOR ALL installs, THE Approval_Setting SHALL concern only Generated_Tools of Tool_Risk `write` or `delete`, and a Generated_Tool of Tool_Risk `read` SHALL run with no question whatever the setting.

### Requirement 11: The Approval_Gate in the Generated_Server

**User Story:** As a user, I want the generated server itself to hold a risky call until I decide, so that no client can skip the question.

#### Acceptance Criteria

1. WHEN the Compiler writes a Generated_Server, THE Compiler SHALL embed the Tool_Risk of each Generated_Tool in the generated source and SHALL embed the Write_Steps (index, label, risk) of each tool.
2. WHEN the Approval_Setting of a Generated_Server is on and a call reaches a Generated_Tool of Tool_Risk `write` or `delete`, THE Approval_Gate SHALL validate the payload first, SHALL then create an Approval_Request, and SHALL start no replay step before the Approval_Decision is `approved`.
3. WHEN the Approval_Decision is `approved`, THE Approval_Gate SHALL start the replay with the arguments of the call, unchanged.
4. IF the Approval_Decision is `denied`, THEN THE Approval_Gate SHALL start no step and SHALL answer an error result with `success: false`, `error: "approval_denied"` and a plain `message` that says the user said no.
5. IF the Approval_Decision is `timeout`, THEN THE Approval_Gate SHALL start no step and SHALL answer an error result with `success: false`, `error: "approval_timeout"` and a plain `message` that says nobody answered in time.
6. IF the payload does not fit the input schema, THEN THE Approval_Gate SHALL answer the existing `validation` error and SHALL create no Approval_Request.
7. WHEN the Approval_Setting is off, or the Generated_Tool has Tool_Risk `read`, THE Generated_Server SHALL run the call with no Approval_Request and SHALL return the same result fields as a server compiled before this change.
8. WHERE the Generated_Server runs with `DAEMONIZE_SANDBOX=docker`, THE Approval_Gate SHALL run on the host before the container starts, and THE container SHALL receive the call only after `approved`.
9. THE Approval_Gate SHALL be one function in the generated `mcp-server.ts` that imports nothing from `src/`, and `tests/unit/generated-no-src-import.test.ts` SHALL keep passing.
10. FOR ALL calls where the Approval_Decision is `denied` or `timeout`, THE number of replay steps run SHALL equal 0 and THE number of requests sent to the target application SHALL equal 0.
11. IF a call is cancelled by the client while an Approval_Request is pending, THEN THE Approval_Gate SHALL withdraw the Approval_Request, SHALL start no step, and THE Approver SHALL stop showing it within 5 seconds.
12. FOR ALL tool names, THE Generated_Tool names, descriptions and input schemas SHALL be the same with the Approval_Setting on and off (invariant).

### Requirement 12: The approval channel, timeout and failing closed

**User Story:** As a user, I want an unanswered or unreachable question to mean "no", so that silence never lets a change through.

#### Acceptance Criteria

1. THE Approval_Channel SHALL carry an Approval_Request from a Generated_Server started by Kiro to an Approver without the Generated_Server knowing a Studio address or a Studio token.
2. THE Approval_Gate SHALL wait for an Approval_Decision at most the approval timeout, which is 120 seconds, or the value of the setting `DAEMONIZE_APPROVAL_TIMEOUT_MS` when it is a whole number from 5000 to 600000.
3. IF `DAEMONIZE_APPROVAL_TIMEOUT_MS` is set to any other value, THEN THE Approval_Gate SHALL use 120 seconds.
4. WHEN the approval timeout elapses with no decision, THE Approval_Channel SHALL record the Approval_Decision `timeout` and THE Approver SHALL stop offering that Approval_Request.
5. IF no Approver is available when the Approval_Request is created (no Studio is running for the user), THEN THE Approval_Gate SHALL start no step and SHALL answer within 5 seconds an error result with `success: false`, `error: "approval_unavailable"` and a plain `message` that tells the user to open the Daemonize sidebar in Kiro.
6. WHEN two Approval_Requests are pending, THE Approval_Channel SHALL keep them separate, each with its own request id, and a decision for one SHALL leave the other pending.
7. WHEN a decision is recorded for a request id, THE Approval_Channel SHALL ignore every later decision for that request id, so that the first decision wins.
8. IF an Approval_Decision names a request id that does not exist or has ended, THEN THE Approval_Channel SHALL ignore it and THE Studio_Server SHALL answer 404 with a plain message.
9. THE Approval_Channel SHALL be readable and writable by the current user only, and SHALL hold no secret value, no token and no recorded step value.
10. WHEN the Generated_Server process ends while an Approval_Request is pending, THE Approval_Channel SHALL mark that request as withdrawn within the approval timeout, and THE Approver SHALL stop showing it.
11. FOR ALL orders of two Approval_Requests and their decisions, THE Approval_Gate SHALL run a call if and only if its own request was `approved` (confluence).
12. FOR ALL Approval_Requests, THE record of the request SHALL be encoded and decoded without change of its fields (round trip).

### Requirement 13: What the user sees before approving

**User Story:** As a user, I want the question to show exactly what will happen, so that I can say yes or no with the facts.

#### Acceptance Criteria

1. THE Approver SHALL show, for each pending Approval_Request, the tool name, the application name, the Tool_Risk in words ("Changes data" or "Deletes data"), the Redacted_Arguments and the Write_Steps with their labels.
2. THE Approver SHALL show the value of a secret-typed argument as `***`, and SHALL show no secret value anywhere in the question.
3. THE Approver SHALL show the time left before the request ends as a number of seconds that decreases, and SHALL show the buttons "Approve" and "Deny".
4. WHEN the user chooses "Approve", THE Approver SHALL send the decision `approved` for that request id and SHALL show the outcome of the call when the Audit_Entry exists.
5. WHEN the user chooses "Deny", THE Approver SHALL send the decision `denied` for that request id.
6. THE Kiro_Extension SHALL show a pending Approval_Request as a notification with the buttons "Approve" and "Deny" and as an entry at the top of the Activity_Summary, and SHALL poll for new requests every 2 seconds while the Studio runs.
7. THE Activity_View SHALL show a pending Approval_Request as a banner that carries `role="alert"`, with the same content and buttons, and SHALL poll every 2 seconds while the view is open.
8. WHEN a request is approved, denied, timed out or withdrawn, THE Approver SHALL remove it from the list of pending requests within 5 seconds.
9. THE Approver SHALL be operable with the keyboard alone: every control has an accessible name, Tab reaches "Approve" and "Deny" in that order, and the focus does not move to "Approve" when a request appears.
10. THE Studio_Server SHALL provide `GET /api/approvals` (pending requests), `POST /api/approvals/decide` (body `id` and `decision` of `approved` or `denied`), each with `remote: 'blocked'`, and SHALL pass every answer through the Redactor.
11. IF `POST /api/approvals/decide` carries a field other than `id` and `decision`, or a `decision` other than `approved` or `denied`, THEN THE Studio_Server SHALL answer 400 and SHALL change nothing.
12. WHILE the Studio runs in sample mode, THE Studio_Server SHALL answer `GET /api/approvals` with a fictitious pending request and SHALL answer 409 `SAMPLE_MODE` to `POST /api/approvals/decide`.
13. THE text of the notification, the banner and the buttons SHALL pass the Plain_Language rule.
14. FOR ALL Approval_Requests, THE text shown by the Approver SHALL contain no known secret value after the Redactor is applied.

### Requirement 14: The agent cannot approve its own request

**User Story:** As a user, I want an approval to come from me and from no tool the agent can call, so that the firewall means something.

#### Acceptance Criteria

1. THE Studio_MCP SHALL expose no tool that reaches `POST /api/approvals/decide`.
2. THE Generated_Server SHALL expose no tool and no argument that sets, skips or answers an Approval_Request.
3. IF the Studio receives `POST /api/approvals/decide` without the Studio token, or with the cookie and without the `x-studio-request` header and a matching Origin, THEN THE Studio_Server SHALL answer 401 or 403 and SHALL change nothing, the same as every other POST.
4. THE Approval_Gate SHALL ignore any reserved argument other than `_timeoutMs`, so that a call cannot ask for the Approval_Setting to be turned off.
5. THE Approval_Setting SHALL change only through the Power_Installer routes of Requirement 10, which a human reaches from the Studio_UI or the Kiro_Extension.
6. FOR ALL tools of the Studio_MCP, THE test suite SHALL check that none of them reaches a route that writes an approval decision, the vault or the Approval_Setting.

### Requirement 15: The Audit_Log

**User Story:** As a user, I want a record of every call an agent made through Kiro, so that I can see what changed and when.

#### Acceptance Criteria

1. WHERE the environment of a Generated_Server names the App_Data_Dir (`DAEMONIZE_DATA_DIR`), WHEN a call to a Generated_Tool ends, THE Generated_Server SHALL append one Audit_Entry to the Audit_Log.
2. THE Audit_Entry SHALL hold `at` (ISO 8601 UTC time), `tool`, `application`, `risk`, `source` (`kiro` or `studio`), `arguments` (the Redacted_Arguments), `decision`, `outcome`, `durationMs` and, when the call started a replay, a compact `steps` array of Trace_Steps without pictures.
3. THE Audit_Entry `decision` SHALL be one of `auto` (no question was needed or asked), `approved`, `denied`, `timeout` or `unavailable`.
4. THE Audit_Entry `outcome` SHALL be `success`, or the error code of the call (`validation`, `missing_secret`, `approval_denied`, `approval_timeout`, `approval_unavailable`, `timeout`, `http_failed`, `heal_unavailable` or the replay error text clipped to 200 characters).
5. THE Audit_Log SHALL be written append-only as JSON lines in the App_Data_Dir, and one Audit_Entry SHALL be one line of at most 16384 bytes.
6. THE Audit_Log SHALL hold no secret value: THE arguments SHALL be the Redacted_Arguments, THE outcome text SHALL be scrubbed with the known secret values, and THE `steps` SHALL hold no typed value.
7. WHEN the Audit_Log holds more than 1000 entries or more than 1 MiB, THE writer SHALL remove the oldest whole lines until both limits hold, and SHALL leave every remaining line unchanged.
8. IF the Audit_Log cannot be written, THEN THE Generated_Server SHALL still return the call result, SHALL write one plain warning line without arguments to stderr, and SHALL not turn a successful call into a failed one.
9. IF the call to a `write` or `delete` Generated_Tool needs approval and the Audit_Log cannot be written, THEN THE Approval_Gate SHALL still apply the Approval_Decision and SHALL not skip the question.
10. WHEN two Generated_Servers append at the same time, THE writer SHALL keep each Audit_Entry on its own complete line and SHALL not interleave two entries.
11. THE Playground SHALL start its Generated_Server with the App_Data_Dir and the setting `DAEMONIZE_CALL_SOURCE=studio`, so that each call it makes produces an Audit_Entry with `source: "studio"` and `decision: "auto"`, and a Generated_Server started without that setting SHALL write `source: "kiro"`.
12. FOR ALL Audit_Entries, THE reader SHALL parse a line and write it again to an equal object (round trip), and SHALL skip a corrupt line without failing the read.
13. FOR ALL argument objects, THE `arguments` of an Audit_Entry SHALL contain no value that `sensitiveValues` returns for those arguments and no known secret value (invariant).
14. FOR ALL sequences of appends, THE number of Audit_Entries after retention SHALL be at most 1000 and the newest entry SHALL be the last line (invariant).

### Requirement 16: The Activity view in the Studio

**User Story:** As a Studio user, I want an Activity view that shows what agents did, so that I can review it after a session.

#### Acceptance Criteria

1. THE Studio_UI SHALL provide a view "Activity" in the main navigation, reachable at `#/activity`.
2. THE Studio_Server SHALL provide `GET /api/activity` with the optional query `limit` (1 to 200, default 50), `tool` and `decision`, with `remote: 'blocked'`, answering the newest Audit_Entries first and passing the answer through the Redactor.
3. IF `GET /api/activity` receives an unknown query name, a `limit` outside 1 to 200, or a `decision` outside the values of Requirement 15 criterion 3, THEN THE Studio_Server SHALL answer 400 with a plain message that names the field.
4. THE Activity_View SHALL show each Audit_Entry as a row with the time, the tool, the Tool_Risk, the decision, the outcome and the duration, and SHALL show the Redacted_Arguments when the user expands the row.
5. THE Activity_View SHALL show the decision `denied`, `timeout` and `unavailable` and a failed outcome with text as well as colour.
6. WHERE a row has `steps`, THE Activity_View SHALL show the simplified timeline of Requirement 23 when the user expands the row.
7. WHEN the Audit_Log is empty, THE Activity_View SHALL show the empty state "No calls yet. When Kiro uses one of your tools, it appears here." and no table.
8. THE Activity_View SHALL provide filters for the tool and for the decision, and SHALL keep the filter in the address (`#/activity?tool=...&decision=...`).
9. WHILE the Studio runs in sample mode, THE Studio_Server SHALL answer `GET /api/activity` with fictitious entries that include one of each decision, and THE static demo (`studio:build`) SHALL show the same entries.
10. THE Activity_View text SHALL pass the Plain_Language rule, and THE view SHALL meet the contrast, keyboard and focus guards of `app.css` and `tests/unit/studio-ui-contrast.test.ts`.
11. THE Activity_View SHALL provide no control that edits or deletes an Audit_Entry.

### Requirement 17: The Activity summary in the Kiro sidebar

**User Story:** As a Kiro user, I want to see in the sidebar what the agent just did, so that I do not open the browser to check.

#### Acceptance Criteria

1. THE Kiro_Extension SHALL add a section "Activity" to the Daemonize view container, showing the pending Approval_Requests first and then the 5 newest Audit_Entries.
2. THE Activity_Summary SHALL show, for each entry, the tool name, a plain label of the decision ("Approved", "Denied", "No answer", "Ran without a question"), the outcome as "Worked" or "Failed", and the time as a relative phrase.
3. THE Activity_Summary SHALL provide the command "Open all activity" that opens the Studio at `#/activity`, with no token shown, logged or copied.
4. WHEN the Studio is not running, THE Activity_Summary SHALL show the plain line "Start Daemonize to see activity" and no entries.
5. WHEN there is no entry, THE Activity_Summary SHALL show the plain line "Nothing yet".
6. THE Kiro_Extension SHALL read the activity through `GET /api/activity` and `GET /api/approvals` only, and SHALL read no file of the App_Data_Dir.
7. THE Activity_Summary text SHALL pass the Plain_Language rule and SHALL show no argument value.

### Requirement 18: Keep strict mode and existing safety unchanged

**User Story:** As a maintainer, I want the firewall to add a layer without weakening what exists, so that safe replay stays safe.

#### Acceptance Criteria

1. THE Approval_Gate SHALL run before the replay and SHALL leave the replay itself unchanged: strict mode, drift checks, the `allowHeal` rule for write steps and the rule that a failed write or delete HTTP request is not repeated on another level SHALL behave as before.
2. WHEN the Approval_Decision is `approved`, THE Generated_Server SHALL return the replay result with the same fields as before this change, plus no field that names the approval.
3. WHILE the Approval_Setting is on, THE Generated_Server SHALL keep the check of the payload against the input schema before any other work, as before.
4. THE Studio SHALL keep the Playground confirmation (`confirmation_required` and its dialog) for a call made by a person at the Studio.
5. THE Generated_Server compiled with `--heal-support` SHALL ask for approval for a `write` or `delete` tool the same way as one compiled without it.
6. FOR ALL Generated_Tools of Tool_Risk `read`, THE Generated_Server SHALL not send an Approval_Request, whatever the Approval_Setting, the mode or the compile options.
7. THE existing tests for strict mode, drift, `confirmation_required` and the write step rules SHALL keep passing with no change other than the allowed differences of the Regression_Snapshot (Requirement 30 criterion 5).

### Requirement 19: Install and locate the Daemonize program from the extension

**User Story:** As a new user, I want the extension to find or install Daemonize with one click, so that I do not need `npm link` or a terminal.

#### Acceptance Criteria

1. THE Kiro_Extension SHALL look for the Daemonize program in this order: the `daemonize.cliPath` setting, the folder owned by the extension (the CLI_Installer target), the workspace `node_modules`, and the PATH.
2. WHEN no Daemonize program is found, THE Kiro_Extension SHALL show in the Actions view the Welcome_State with the button "Install Daemonize" and the plain sentence "Daemonize is not installed yet."
3. THE Kiro_Extension SHALL contribute the command `daemonize.installCli` with the title "Install Daemonize", and WHEN the user chooses "Install Daemonize" or runs that command, THE CLI_Installer SHALL run `npm install` of the Published_Package with `--prefix` set to a folder under the extension's global storage, with an argument array and no shell, and SHALL show the progress in a notification.
4. IF `npm` or `node` is not found, THEN THE CLI_Installer SHALL show the plain message "Node.js 20 or newer is needed. Install it, then try again." and a button that opens the Node.js download page, and SHALL install nothing.
5. IF the installation fails, THEN THE CLI_Installer SHALL show a plain message with the next step ("Check your internet connection, then try again."), SHALL write the redacted tail of the npm output to the "Daemonize" output panel, and SHALL leave no half-installed folder in use.
6. WHEN the installation ends, THE Kiro_Extension SHALL run the program with `--version`, SHALL accept it only when it answers a version and knows `studio --machine`, and SHALL start the Studio.
7. THE CLI_Installer SHALL use no administrator rights and SHALL write only into the folder owned by the extension.
8. THE extension package SHALL contain no copy of the Daemonize program, no `playwright` and no `node-pty` (checked by `tests/extension/packaging.test.ts`).
9. THE Kiro_Extension SHALL provide the command "Daemonize: Check the browser" and SHALL run the Browser_Check once after a successful installation and at the first start after an update.
10. THE Browser_Check SHALL ask the Daemonize program (not a copy of its code) whether replay can start one of Chromium, Google Chrome or Microsoft Edge, through a documented read-only command or Studio route, and SHALL show "A browser is ready." when one is found.
11. IF the Browser_Check finds no browser, THEN THE Kiro_Extension SHALL show the plain message "Daemonize needs Google Chrome or Microsoft Edge. Install one, then try again." with a button "Check again", and SHALL not start a download by itself.
12. THE Kiro_Extension messages of this requirement SHALL pass the Plain_Language rule and SHALL contain no path and no token.
13. FOR ALL outcomes of the locator, THE function SHALL give the same answer for the same input (it stays pure), and `kiro-extension/src/core/cli-locator.ts` SHALL import neither `vscode` nor the root `src/`.

### Requirement 20: The walkthrough "Get started with Daemonize"

**User Story:** As a new user, I want a guided first run inside Kiro, so that I finish my first tool in a few minutes.

#### Acceptance Criteria

1. THE Kiro_Extension `package.json` SHALL declare one walkthrough with the id `daemonize.getStarted` and the title "Get started with Daemonize" in `contributes.walkthroughs`, with its texts in `package.nls.json`.
2. THE Walkthrough SHALL have six steps, in this order: "Install Daemonize", "Open the Studio", "Create your first action", "Test it", "Add it to Kiro", "Try the Daemonize agent".
3. THE Walkthrough steps SHALL each hold a title, a description of at most 200 characters, a command link that runs the matching command (`daemonize.installCli`, `daemonize.openStudio`, `daemonize.newAction`, `daemonize.testInStudio`, `daemonize.connectToKiro`, `daemonize.buildWithAgent`), and at least one completion event.
4. THE completion events SHALL be: `onCommand:daemonize.installCli` or a found program, `onCommand:daemonize.openStudio`, `onCommand:daemonize.finishRecording`, `onCommand:daemonize.testInStudio`, `onCommand:daemonize.connectToKiro` and `onCommand:daemonize.buildWithAgent`.
5. THE Kiro_Extension SHALL contribute a context key `daemonize.cliFound` that is true when the locator finds a program, and the first step SHALL complete on that key as well.
6. WHEN the extension runs for the first time (no stored flag), THE Kiro_Extension SHALL open the Walkthrough once and SHALL store the flag in the extension's global state, never in a workspace file.
7. THE Kiro_Extension SHALL provide the command "Daemonize: Get started" that opens the Walkthrough at any time.
8. THE Walkthrough texts SHALL pass the Plain_Language rule.
9. THE Walkthrough SHALL use no hard-coded hex colour and SHALL reference media files that exist in `kiro-extension/media/`, and every command it links SHALL be declared in `contributes.commands`.
10. FOR ALL steps, THE manifest test SHALL check that the step id is unique, that the command is declared, that a completion event names a declared command or a known context key, and that the media path exists.

### Requirement 21: Empty-state welcome in the sidebar

**User Story:** As a new user, I want the sidebar to tell me the next step, so that an empty panel does not leave me stuck.

#### Acceptance Criteria

1. WHEN the open folder has no Action and a Daemonize program is found, THE Actions view SHALL show the Welcome_State with the sentence "Show Daemonize the first thing you do in your software." and the buttons "New action" and "Build a tool with the Daemonize agent".
2. WHEN no Daemonize program is found, THE Actions view SHALL show the Welcome_State of Requirement 19 criterion 2.
3. WHEN the Browser_Check found no browser, THE Actions view SHALL show the message of Requirement 19 criterion 11 above the buttons.
4. WHEN the open folder has at least one Action, THE Actions view SHALL show the list and no Welcome_State.
5. WHEN there is at least one Action and no Kiro install, THE Kiro view SHALL show the sentence "Add a tool to Kiro to use it in chat." and the button "Add to Kiro".
6. THE Welcome_State SHALL be a `viewsWelcome` contribution or a tree node of the existing models, with its text in `package.nls.json` or `strings.ts`, passing the Plain_Language rule.
7. THE Welcome_State SHALL hold no hard-coded hex colour and no path.
8. THE choice of the Welcome_State SHALL be a pure function of the state (program found, browser found, number of Actions, number of installs), and for each combination the test suite SHALL check the text and the buttons.

### Requirement 22: Trace of a replay, opt-in in the result

**User Story:** As a Studio user, I want the Generated_Server to say what each step did, so that the Playground can show it, while Kiro results stay as small as today.

#### Acceptance Criteria

1. THE Generated_Server SHALL collect a Trace_Step for each step of a call: `index`, `label` (the step label, or the action type when the step has none), `level`, `durationMs`, `status` and an optional `note`.
2. THE Generated_Server SHALL set `level` to `http` for a step run as a recorded request, `accessibility` for a step run through accessibility locators, `vision` for a healed step, `terminal` for a step of a terminal program, `skipped` for a Skipped_Step and `not_run` for a step that did not start.
3. WHEN a step ends in drift (the step failed because no locator could perform it, or the final screen differs), THE Generated_Server SHALL set the `status` of that step to `failed` or `drifted` and SHALL set `drifted: true` on the result as before.
4. WHEN a write or delete HTTP step failed and the call stops without repeating it on another level, THE Generated_Server SHALL set the `status` of that step to `failed`, SHALL set the `note` to "Not repeated: this step changes data", and SHALL set the later steps to `not_run`.
5. WHEN a Generated_Server is started with the Trace_Opt_In, THE Generated_Server SHALL add a `trace` field, an array of Trace_Steps, to the JSON result of every call.
6. WHEN a Generated_Server is started without the Trace_Opt_In, THE Generated_Server SHALL return a result with no `trace` field, so that its fields equal those of a result before this change.
7. THE Trace_Opt_In SHALL be an environment setting of the server process that the Playground sets, the way it sets `DAEMONIZE_SCREENSHOT=final`, and the Kiro install entry SHALL never carry it.
8. THE Generated_Server SHALL leave the input schema, the tool description and the reserved arguments unchanged by the Trace_Opt_In.
9. THE Trace SHALL hold no typed value, no secret value and no cookie, and each `label` and `note` SHALL be scrubbed with the known secret values and clipped to 120 characters.
10. THE Trace SHALL hold at most 200 Trace_Steps, and WHEN a workflow has more steps, THE Generated_Server SHALL keep the first 200 and add `traceTruncated: true`.
11. THE Playground SHALL pass the `trace` field of the result to the answer of `POST /api/playground/call`, and SHALL ask for the Trace_Opt_In when it starts the Generated_Server (restarting it once when the setting changes).
12. FOR ALL calls, THE `index` values of the Trace SHALL be strictly increasing, THE number of Trace_Steps SHALL be at most the number of steps of the workflow, and every step that ran SHALL have exactly one Trace_Step (invariant).
13. FOR ALL Trace_Steps, THE `durationMs` SHALL be a whole number from 0 to the call timeout, and the sum of `durationMs` SHALL not exceed `elapsedMs` of the result plus 50 ms (invariant).
14. WHERE the Generated_Server runs with `DAEMONIZE_SANDBOX=docker`, THE container SHALL return the same Trace as a replay on the host for the same arguments.

### Requirement 23: The replay timeline in the Playground and the Activity view

**User Story:** As a Studio user, I want to see the replay as a timeline, so that I understand what happened step by step and where it went wrong.

#### Acceptance Criteria

1. WHEN a Playground result holds a `trace`, THE Playground SHALL show a Replay_Timeline in the Result panel, one row per Trace_Step, in the order of the steps.
2. THE Replay_Timeline row SHALL show the step number, the step label, the level as text and badge (`http`, `accessibility`, `vision`, `terminal`, `skipped`, `not run`), the duration, and the status as text and badge.
3. WHERE the recorded step has a thumbnail that the whitelisted assets route serves (a step with a secret excluded), THE row SHALL show that thumbnail with the alternative text "Recorded screen of step N", and WHERE the call failed on that step and the Playground kept a failure picture, THE row SHALL show it with the alternative text "Page at the failing step".
4. WHEN a Trace_Step has `status: "drifted"` or `"failed"` and the result has `drifted: true`, THE row SHALL be marked with the text "Drifted" and SHALL show the reason of the failure when the result has one.
5. WHEN a Trace_Step has the `note` "Not repeated: this step changes data", THE row SHALL show that note and the text "Blocked: not run again".
6. WHEN a Trace_Step has `status: "skipped"`, THE row SHALL show "Skipped (optional value left out)".
7. WHEN the call was refused by the Approval_Gate (`approval_denied`, `approval_timeout` or `approval_unavailable`), THE Playground SHALL show the Replay_Timeline with every step as "Not run" and the text "Stopped by Ask before changes".
8. WHEN a Playground result holds no `trace`, THE Playground SHALL show no Replay_Timeline and SHALL keep the present Result panel unchanged.
9. THE Replay_Timeline SHALL be an ordered list (`<ol>`) with an accessible name "Replay timeline", with the status and level readable as text for a screen reader, and with no information carried by colour alone.
10. THE Replay_Timeline SHALL use only colour tokens of `:root`, SHALL keep a contrast ratio of at least 4.5:1 for each text, and SHALL keep a visible focus ring on every focusable element.
11. WHEN a thumbnail cannot be loaded, THE row SHALL show the text "No picture" and SHALL remain readable.
12. THE Activity_View SHALL show a simplified timeline for an Audit_Entry that has `steps`: one line per step with the number, label, level, status and duration, and no thumbnail.
13. WHILE the Studio runs in sample mode, THE Playground sample session SHALL return a `trace` that includes one `http` step, one `accessibility` step, one `skipped` step, one drifted step and one blocked write step, and THE static demo SHALL show the same Replay_Timeline.
14. THE text of the Replay_Timeline SHALL pass the Plain_Language rule.
15. FOR ALL traces, THE number of rows shown SHALL equal the number of Trace_Steps (invariant), and the Replay_Timeline SHALL escape every label so that it adds no HTML.

### Requirement 24: Daemonize as a Kiro Power

**User Story:** As a Kiro user, I want to install Daemonize itself as a Power, so that the agent gets its tools, steering, skill and agent in one step.

#### Acceptance Criteria

1. THE repository SHALL contain a folder `power/` with the files `POWER.md`, `plugin.json`, `mcp.json`, `steering/`, `skills/daemonize-builder/SKILL.md` and `agents/daemonize.md`.
2. THE `power/POWER.md` SHALL start with a front matter that holds `name`, `displayName`, `description` and `keywords`, in the same shape as the `POWER.md` of `KiroPowerGenerator`, and SHALL describe, in plain English, what the Power does, the Studio_MCP tools and the safety rules.
3. THE `power/plugin.json` SHALL hold `$schema`, `name`, `version`, `description`, `author` and `keywords`, in the same shape as `KiroPlugin`.
4. THE `power/mcp.json` SHALL hold one server entry for the Studio_MCP of the form `{ type: "stdio", command, args, env }`, and every `env` value SHALL be a `${NAME}` placeholder or a non-secret plain setting.
5. THE `power/steering/` folder SHALL hold at least one Markdown file that tells the agent the rules of Requirement 8 criterion 5 and the Plain_Language rule for the text it shows the user.
6. THE `power/` folder SHALL contain no secret value, no token, no absolute path of a user machine and no file outside the list of criterion 1 and the steering files.
7. WHEN the files of the `power/` folder are compared with the Power format that `KiroPowerGenerator` writes, THE test suite SHALL find the same required keys and the same file layout (`plugin.json`, `mcp.json`, `POWER.md`, `skills/<name>/SKILL.md`).
8. THE name in `power/plugin.json`, in the front matter of `power/POWER.md` and in the key of `power/mcp.json` SHALL be the same kebab-case string of at most 64 characters.
9. THE `power/skills/daemonize-builder/SKILL.md` and `power/agents/daemonize.md` SHALL satisfy Requirements 7 and 8.
10. THE `power/` folder SHALL be usable by "Install from folder" and "Install from repository URL" in the Kiro Powers panel, and THE README SHALL say how, in plain steps.
11. THE `.vscodeignore` and the extension build SHALL bundle `power/agents/daemonize.md` and `power/skills/daemonize-builder/SKILL.md` as templates for Requirement 9, and SHALL leave the rest of the folder out.
12. FOR ALL JSON files of `power/`, THE test suite SHALL parse the file, check the required keys and check that no value matches a secret pattern of `findPlainSecrets`.

### Requirement 25: Install the Daemonize Power from the extension

**User Story:** As a Kiro user, I want the extension to install the Daemonize Power for me, so that I do not copy files by hand.

#### Acceptance Criteria

1. THE Kiro_Extension SHALL contribute the command `daemonize.installPower` with the title "Install the Daemonize Power", shown in the Kiro view and in the Welcome_State.
2. WHEN the user runs `daemonize.installPower`, THE Kiro_Extension SHALL ask for the Install_Scope (`global` or `project`) and SHALL show the plan in plain words (the folder and the files that will be added) before any write.
3. WHEN the user confirms, THE Kiro_Extension SHALL write the Power files and the Studio_MCP entry through the all-or-nothing transaction of the Power_Installer (backup of the Kiro settings, no change when one write fails).
4. IF a file of the Power already exists with other content, THEN THE Kiro_Extension SHALL ask before it replaces the file and SHALL leave it unchanged when the user declines.
5. WHEN the Power is already installed with the same content, THE Kiro_Extension SHALL write nothing and SHALL tell the user in plain words that it is already installed.
6. THE Kiro_Extension SHALL write no secret value and no token, and SHALL write only `${NAME}` placeholders and non-secret settings.
7. WHEN the install ends, THE Kiro_Extension SHALL tell the user in plain words to reload the window or enable the server in Kiro, and SHALL show a button "Build a tool with the Daemonize agent".
8. WHEN the user chooses "Remove the Daemonize Power", THE Kiro_Extension SHALL remove the files and the Studio_MCP entry that it wrote and SHALL leave every other entry of the Kiro settings unchanged.
9. THE Kiro_Extension SHALL show the Daemonize Power in the Kiro view as an install with its scope and a command to remove it.
10. THE messages of this requirement SHALL pass the Plain_Language rule and SHALL contain no token.
11. FOR ALL Kiro settings files that hold other servers, THE install followed by the removal SHALL return the settings file to its earlier content (round trip).

### Requirement 26: Dogfooding, the Studio_MCP used during development

**User Story:** As a maintainer and as a jury member, I want proof that the project used Kiro's MCP feature while it was built, so that the project is shown as a real Kiro user.

#### Acceptance Criteria

1. THE repository SHALL contain a workspace Kiro settings example `.kiro/settings/mcp.json.example` with the Studio_MCP entry (placeholders only), and THE `.gitignore` SHALL keep the real `.kiro/settings/mcp.json` out of the repository.
2. THE repository SHALL contain `docs/dogfooding.md` that explains, in plain steps, how the Builder_Agent uses the Studio_MCP to record, compile and test an action on `examples/adminer`, with the commands to run and the expected result of each step.
3. THE document `docs/dogfooding.md` SHALL list the real calls made during development (date, tool, outcome) that the maintainers record from the Audit_Log with the secrets removed, and SHALL say which parts were not done with the agent.
4. THE document SHALL contain no secret value, no token and no absolute path of a user machine.
5. THE test suite SHALL check that every Studio_MCP tool name that `docs/dogfooding.md` names exists in the Studio_MCP.

### Requirement 27: Plain language, accessibility and design tokens for new screens

**User Story:** As a user, I want every new screen to read plainly and work with a keyboard, so that the product feels finished and not like a prototype.

#### Acceptance Criteria

1. THE new Studio_UI text (Activity_View, approval banner, Replay_Timeline, labels and empty states) SHALL be defined in `src/studio/ui/js/copy.js` or a copy module it imports, and SHALL pass the Plain_Language lint of the Studio.
2. THE new Kiro_Extension text (Welcome_State, Walkthrough, notifications, Activity_Summary, buttons) SHALL be defined in `package.nls.json` or `kiro-extension/src/core/strings.ts`, and SHALL pass `tests/extension/static/plain-language.test.ts`.
3. THE new CSS SHALL use only the tokens of `:root` in `src/studio/ui/app.css`, SHALL add no literal colour outside `:root`, and SHALL pass `tests/unit/studio-ui-contrast.test.ts`.
4. THE new Studio_UI and Kiro_Extension controls SHALL have an accessible name, SHALL be reachable by Tab in reading order, and SHALL show a visible focus.
5. THE new Studio_UI SHALL announce a new pending Approval_Request and a changed decision through a polite or assertive live region.
6. THE new Studio_UI SHALL work in the static demo built by `studio:build`, with the fictitious data of Requirements 13, 16 and 23.
7. THE new Kiro_Extension code SHALL add no hard-coded hex colour, and SHALL pass `tests/extension/static/no-hardcoded-colors.test.ts`.

### Requirement 28: Backward compatibility

**User Story:** As an existing user, I want my files, servers and commands to keep working, so that this release does not break what I built.

#### Acceptance Criteria

1. WHEN a Workflow_File recorded before this change is loaded, THE loader SHALL load it with no error and no change, and the compiler SHALL produce the same input schema, the same OpenAPI document and the same tool names as before.
2. WHEN a Generated_Server compiled before this change runs, THE server SHALL behave as before, and the Playground SHALL call it with no error when the server returns no `trace` (Requirement 23 criterion 8).
3. WHEN a Kiro install written before this change exists, THE install SHALL keep working, its Approval_Setting SHALL read as off, and no Audit_Entry SHALL be written for it.
4. THE existing Studio routes (`/api/overview`, `/api/workflows`, `/api/graph`, `/api/schemas`, `/api/pbt`, `/api/playground/*`, `/api/record/*`, `/api/sessions*`, `/api/secrets*`, `/api/compile*`, `/api/power/*`, `/api/workflows/update`, `/api/workflows/delete`) SHALL keep their paths, methods and answer fields, except that `POST /api/power/preview` and the install answer add `askBeforeChanges` and `POST /api/playground/call` adds `trace`.
5. THE CLI commands and flags that exist before this change SHALL keep their names, their flags and their default output, and the new Studio_MCP command SHALL be an addition.
6. WHEN the Compiler runs with the default options on a Workflow_File, THE generated `mcp-server.ts`, `replay.ts` and `docker-replay.ts` SHALL differ from the Regression_Snapshot only by: the embedded Tool_Risk and Write_Steps, the Approval_Gate, the Audit_Log writer, and the Trace collection with its opt-in field. Every other line SHALL be identical.
7. WHEN the Approval_Setting is off and the Trace_Opt_In is off and no Audit_Log folder is configured, THE result of every call SHALL equal the result of the server compiled before this change, for the same arguments (metamorphic).
8. THE `compile` output of a Workflow_File SHALL be the same bytes when compiled twice (determinism), and the embedded Tool_Risk SHALL not depend on the order of the workflows.
9. THE generated `replay.ts` and the files of `src/replay/runtime/` SHALL import nothing from `src/`, and `kiro-extension/src/core/` SHALL import neither `vscode` nor the root `src/`.

### Requirement 29: README "Built with Kiro" as a feature table

**User Story:** As a jury member, I want to see exactly which Kiro features the project used, what they did and what they did not do, so that I can judge the technical use of Kiro with facts.

#### Acceptance Criteria

1. THE README section "Built with Kiro" SHALL be rewritten as a table with the columns "Kiro feature", "What we did", "Why it mattered" and "Numbers".
2. THE table SHALL have a row for each of: every spec in `.kiro/specs/` (one row per spec folder, by name), the steering files, the hooks, the property-based testing defects that were found, the parallel sub-agents, the Builder_Agent, the Builder_Skill, the Studio_MCP, and the Daemonize_Power.
3. THE "Numbers" column SHALL hold counts that a reader can check in the repository (number of requirements, tasks, properties, tests, files, commits or defects), and each count SHALL be correct on the day of the commit.
4. THE README SHALL contain a section "How MCP extended Kiro while we built this" that describes the Builder_Agent using the Studio_MCP on `examples/adminer` and links to `docs/dogfooding.md`.
5. THE README SHALL contain a section "What Kiro did not do" that states, in plain words and without defence, the parts that were written or fixed by hand, the points where an agent output was wrong or discarded, and the features of Kiro that the project does not use.
6. THE README SHALL explain how to install the Daemonize_Power and how to pick the Daemonize agent, in numbered steps.
7. THE README SHALL contain no secret value, no token and no claim that the tests do not support.
8. THE test suite SHALL check that every spec folder of `.kiro/specs/` appears by name in the Built_With_Kiro_Table, that every file path named in the table exists, and that the hooks named in the table equal the files of `.kiro/hooks/`.

### Requirement 30: Tests and verification

**User Story:** As a maintainer, I want each new behaviour covered by tests and the whole suite green, so that the features can be shipped one commit at a time.

#### Acceptance Criteria

1. THE test suite SHALL include unit tests, property tests with fast-check at 100 runs or more per property, and integration tests for each behaviour of Requirements 1 to 29, with each property test tagged `Feature: kiro-native-agent-and-firewall, Property N`.
2. THE test suite SHALL test the Studio_MCP with a fake Studio and with a real Studio over loopback: the tool list equals Requirements 2 to 5, every tool answers with the specified fields, `confirmation_required` and the approval wait are enforced, and no answer holds a secret value.
3. THE test suite SHALL test the firewall with a Generated_Server compiled from a fixture workflow: approve runs the replay, deny and timeout run no step, an unavailable Approver fails within 5 seconds, a read tool is never held, and the Audit_Entry of each case holds the right `decision` and `outcome`.
4. THE test suite SHALL test the Audit_Log: redaction, retention at 1000 entries and 1 MiB, concurrent appends, a corrupt line, and the round trip of an entry.
5. THE Regression_Snapshot test SHALL keep passing, and its expected files SHALL change only by the differences named in Requirement 28 criterion 6, regenerated once in a commit that says so.
6. THE test suite SHALL test that `trace` is absent from a result by default and present with the Trace_Opt_In, and that the Replay_Timeline DOM has one row per Trace_Step with the texts of Requirement 23.
7. THE test suite SHALL test the files `.kiro/agents/*`, `.kiro/skills/*/SKILL.md` and `power/**` for validity (front matter, field names, paths that exist, tool names equal to the Studio_MCP list, no secret) and the walkthrough manifest (Requirement 20 criterion 10).
8. THE test suite SHALL include a test per Requirement of the static guards: `tests/unit/generated-no-src-import.test.ts`, `tests/extension/static/imports.test.ts`, `tests/extension/static/no-hardcoded-colors.test.ts`, `tests/extension/static/plain-language.test.ts` and `tests/unit/studio-ui-contrast.test.ts` SHALL keep passing with the new files included.
9. WHEN the work of each feature (I1, I2, D1, D2, D4, the README) is complete, THE maintainer SHALL run the Verification_Suite and SHALL commit that feature on its own, and SHALL push nothing unless the user asks.
10. THE Verification_Suite SHALL be: at the repository root `npm run build`, `npx tsc --noEmit`, `npm run check:secrets` and `npm run studio:build`; in `kiro-extension/` `npm run typecheck`, `npm run build` and `npm run package`; and at the root `npm test` with `DAEMONIZE_REQUIRE_EXTENSION_BUILD=1`, with every command exiting with code 0.
11. FOR ALL new property tests, THE generators SHALL include secret-like strings, strings of 0 to 5000 characters, Unicode text and the JSON characters `"`, `\` and newline, so that redaction and line framing are exercised.
