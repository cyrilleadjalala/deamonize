# Requirements Document

## Introduction

Daemonize is a tool that wraps legacy or closed software — TUI/CLI programs and web-based admin
interfaces — behind a generated MCP server and OpenAPI specification. A user navigates the target
application once inside an isolated headless browser or terminal emulator. Daemonize records every
screen transition, infers the input/output schema for each state, compiles a typed OpenAPI spec,
and emits a functional MCP server that AI agents can call immediately as a Kiro Power. The result
is any "dead" or API-less software turned into a first-class agenttic callable.

---

## Glossary

- **Daemonize**: The overall system described in this document.
- **Target_Application**: The legacy TUI/CLI program or web interface being wrapped.
- **Session**: A single recording run in which a user navigates the Target_Application inside the
  Sandbox.
- **Sandbox**: The isolated environment (headless browser or terminal emulator container) that
  hosts the Target_Application during a Session.
- **Screen**: A discrete visual state of the Target_Application, identified by its DOM snapshot
  (web) or terminal buffer (TUI/CLI).
- **Transition**: A user action (keystroke, click, form submission) that moves the
  Target_Application from one Screen to another.
- **State_Graph**: The directed graph whose nodes are Screens and whose edges are Transitions,
  built by the State_Machine_Builder during a Session.
- **State_Machine_Builder**: The Daemonize component that constructs and updates the State_Graph
  in real time as Transitions are recorded.
- **Schema_Inferencer**: The Daemonize component that derives input fields and output shapes from
  each Screen and Transition in the State_Graph.
- **Compiler**: The Daemonize component that transforms the State_Graph and inferred schemas into
  an OpenAPI specification and an MCP server.
- **MCP_Server**: The generated Model Context Protocol server that exposes Target_Application
  actions as callable tools.
- **OpenAPI_Spec**: The generated OpenAPI 3.1 document describing the MCP_Server's tool
  endpoints.
- **Kiro_Power**: A folder that Kiro IDE imports as a Custom Power. It contains `plugin.json`, `mcp.json` and a skill (`skills/<name>/SKILL.md`), plus a `POWER.md` for older Kiro versions, and registers the MCP_Server as a reusable tool provider.
- **Action**: A single callable operation on the MCP_Server corresponding to one Workflow.
- **Payload**: The JSON object passed to an Action at call time.
- **Validator**: The Daemonize component responsible for schema-validating Payloads before they
  are forwarded to the Sandbox.
- **Workflow**: A complete recorded path of Transitions, starting from a known start state, in
  which the user has marked the variable fields. Each Workflow is exposed as one Action.
- **Variable**: A field of a Workflow that the user marked as variable while recording; its value
  is supplied by the Payload at call time.
- **Replayer**: The Daemonize component that executes a Workflow inside a fresh Sandbox by
  resetting to the known start state and replaying the recorded steps with the Payload values.
- **Replay_Level**: One of three ways to execute a Workflow step: `api` (Level 1, recorded HTTP
  call), `accessibility` (Level 2, accessibility locator with an Anchor) or `vision` (Level 3,
  screenshot-based location by a multimodal model).
- **Strict_Mode**: The default, deterministic replay mode (`--strict`) that uses only Replay_Level
  `api` and `accessibility` and never guesses an element.
- **Heal_Mode**: The opt-in replay mode (`--heal`) that additionally allows Replay_Level `vision`
  when every deterministic locator has failed or the UI has no DOM.
- **Anchor**: The stable description of a web element made of its ARIA role, its accessible name
  and its parent context (enclosing dialog name, section heading or neighbouring label).
- **Visual_Anchor**: A thumbnail of the targeted zone, its coordinates relative to the viewport
  and a short description of the intent of the step, recorded for vision healing.
- **Result_Zone**: The part of a Screen (a selector, a terminal rectangle, or a small JSON
  extractor over the DOM) from which an Action returns structured data.
- **Secret_Reference**: A placeholder naming a secret (for example `DAEMONIZE_SECRET_<NAME>`)
  stored in a compiled artifact in place of the secret value, resolved at run time.
- **Screen_Pattern**: An expected prompt or text pattern of a terminal Screen that the Replayer
  waits for before continuing.
- **Studio**: The lightweight local web interface that displays Workflows, the State_Graph and
  test results, and offers an MCP playground.

---

## Requirements

### Requirement 1: Sandbox Isolation

**User Story:** As a developer, I want the Target_Application to run inside an isolated Sandbox,
so that Daemonize can intercept all interactions without affecting the host system.

#### Acceptance Criteria

1. THE Sandbox SHALL run each Target_Application process in an isolated container with no access
   to the host network or filesystem beyond the mount points explicitly configured by the user.
2. WHEN a web-based Target_Application is specified, THE Sandbox SHALL launch a headless browser
   instance and load the target URL.
3. WHEN a TUI/CLI Target_Application is specified, THE Sandbox SHALL launch the program inside a
   terminal emulator with a captured pty (pseudo-terminal) stream.
4. WHEN the Sandbox process terminates unexpectedly, THE Daemonize SHALL log the exit code and
   surface an error to the user within 5 seconds.
5. THE Sandbox SHALL enforce a configurable memory limit (default 512 MB) and a configurable CPU
   quota (default 1 vCPU) per session.

---

### Requirement 2: Session Recording

**User Story:** As a developer, I want Daemonize to record every Screen and Transition during my
navigation session, so that the State_Graph captures the full behavior of the Target_Application.

#### Acceptance Criteria

1. WHEN the user performs an interaction inside the Sandbox, THE State_Machine_Builder SHALL
   record a Transition containing: the source Screen identifier, the action type (click, keypress,
   form submit), the action parameters, and the destination Screen identifier.
2. WHEN a new Screen is first observed, THE State_Machine_Builder SHALL assign a unique,
   deterministic identifier based on a hash of the Screen's DOM snapshot or terminal buffer.
3. WHEN a Screen with an identical identifier already exists in the State_Graph, THE
   State_Machine_Builder SHALL merge the new observation with the existing node rather than
   creating a duplicate.
4. THE State_Machine_Builder SHALL capture Screen snapshots at a frequency no greater than one
   snapshot per 100 ms to avoid redundant states from animation frames.
5. WHEN the user ends the Session, THE Daemonize SHALL persist the complete State_Graph to a
   versioned JSON file in the project directory.
6. WHEN the user ends the Session, THE Daemonize SHALL report the total number of unique Screens
   and Transitions recorded.
7. WHEN the user marks a field as variable during recording, THE Daemonize SHALL store it as a
   Variable of the Workflow being recorded and use it to build the Workflow's input schema.
8. THE Daemonize SHALL record, for each Workflow step, an ordered list of candidate selectors
   (accessibility role and name first, CSS selector as fallback).
9. WHEN a Terminal Target_Application is recorded, THE Daemonize SHALL forward what the user types
   to the program, record text typed between two keys as one step and every other key as a named
   key step, and let the user mark the last typed text as a Variable or end the recording from a
   menu whose keys are never sent to the program.
10. WHEN the Sandbox stops, or the program exits, before the user ended the recording, THE
    Daemonize SHALL log the cause (and the exit code when there is one), report it to the user
    at once, and keep the steps recorded so far in a recovery file that is itself a valid
    workflow file.

---

### Requirement 3: State Graph Persistence and Round-Trip

**User Story:** As a developer, I want to save and reload the State_Graph, so that I can
incrementally build the graph across multiple sessions without losing prior work.

#### Acceptance Criteria

1. THE Daemonize SHALL serialize the State_Graph to a JSON document conforming to a published
   JSON Schema.
2. WHEN a State_Graph JSON document is loaded, THE Daemonize SHALL deserialize it into an
   in-memory State_Graph that is structurally equivalent to the one that was serialized.
3. FOR ALL valid State_Graph objects, serializing then deserializing SHALL produce a State_Graph
   that is equal to the original (round-trip property).
4. WHEN a malformed or schema-invalid State_Graph JSON document is provided, THE Daemonize SHALL
   return a descriptive error identifying the invalid field and its location in the document.
5. THE Daemonize SHALL pretty-print the State_Graph JSON document with 2-space indentation for
   human readability.

---

### Requirement 4: Schema Inference

**User Story:** As a developer, I want Daemonize to automatically infer input and output schemas
from the recorded interactions, so that the generated MCP server has typed, accurate tool
definitions.

#### Acceptance Criteria

1. WHEN the State_Graph is complete, THE Schema_Inferencer SHALL derive a JSON Schema for the
   input parameters of each Workflow, built from its Variables and any observed Payloads.
2. WHEN the State_Graph is complete, THE Schema_Inferencer SHALL derive a JSON Schema for the
   output shape of the final Screen of each Workflow.
3. WHERE a Workflow was observed with multiple distinct Payloads across Session replays, THE
   Schema_Inferencer SHALL widen the inferred input JSON Schema to accept all observed variants.
4. WHEN a field value observed across multiple Workflows consistently matches a recognisable
   pattern (email, ISO 8601 date, UUID), THE Schema_Inferencer SHALL annotate the field with the
   corresponding JSON Schema `format` keyword.
5. THE Schema_Inferencer SHALL assign a human-readable `description` to each inferred field,
   derived from the nearest visible label text in the Screen snapshot.

---

### Requirement 5: MCP Server and OpenAPI Compilation

**User Story:** As a developer, I want Daemonize to compile the State_Graph into a functional MCP
server and an OpenAPI spec, so that I can expose the Target_Application as a callable tool
immediately.

#### Acceptance Criteria

1. WHEN compilation is triggered, THE Compiler SHALL emit a valid OpenAPI 3.1 document where each
   Workflow is represented as a POST endpoint under `/actions/{action_id}`.
2. WHEN compilation is triggered, THE Compiler SHALL emit an MCP_Server that implements the MCP
   2025-03-26 specification and exposes one tool per Workflow.
3. THE Compiler SHALL name each tool using the snake_case form of the Workflow's human-readable
   label, truncated to 64 characters.
4. WHEN two Workflows share the same inferred tool name, THE Compiler SHALL suffix the
   conflicting names with `_2`, `_3`, … in the order they appear in the State_Graph to preserve
   uniqueness.
5. THE OpenAPI_Spec emitted by THE Compiler SHALL pass validation against the OpenAPI 3.1 JSON
   Schema without errors.
6. WHEN compilation succeeds, THE Daemonize SHALL write the OpenAPI_Spec and the MCP_Server
   source to the project output directory and report the output file paths to the user.

---

### Requirement 6: Payload Validation

**User Story:** As a developer, I want every Payload sent to the MCP server to be validated
against the inferred schema before execution, so that malformed inputs do not corrupt the
Target_Application state.

#### Acceptance Criteria

1. WHEN an Action is called with a Payload, THE Validator SHALL validate the Payload against the
   JSON Schema for that Action's Workflow before forwarding it to the Replayer.
2. IF a Payload fails schema validation, THEN THE Validator SHALL return a structured error
   response containing the list of validation violations and SHALL NOT forward the Payload to the
   Replayer.
3. THE Validator SHALL complete schema validation within 50 ms for Payloads up to 1 MB in size.
4. FOR ALL valid Payloads, applying THE Validator SHALL return a pass result when re-applied to
   the same Payload (idempotence property).
5. FOR ALL invalid Payloads, applying THE Validator SHALL return a fail result when re-applied to
   the same Payload (idempotence property).
6. WHERE a Variable declares `enum`, `pattern` or `maxLength`, THE generated MCP_Server SHALL
   validate the Payload value against these constraints before any replay starts, and SHALL
   return `error: "validation"` without running a step when a value violates them.

---

### Requirement 7: Workflow Replay

**User Story:** As a developer, I want the MCP server to replay a recorded Workflow from a known
start state on every call, so that results do not depend on what earlier calls did to the
Target_Application.

#### Acceptance Criteria

1. WHEN an Action is called with a valid Payload, THE Replayer SHALL start a fresh Sandbox at the
   Workflow's known start state and replay every recorded step, using the Payload values for the
   Workflow's Variables.
2. WHEN a step has several candidate selectors, THE Replayer SHALL try them in order and use the
   first one that resolves.
3. WHEN a Workflow replay completes, THE Replayer SHALL return the page title and visible text of
   the resulting Screen (or the terminal text) as the Action response, not the raw DOM.
4. WHEN the resulting Screen differs from the Screen recorded at the end of the Workflow, THE
   Replayer SHALL flag the response as `drifted: true` without failing the call.
5. WHEN a Workflow replay does not complete within a configurable timeout (default 10 seconds),
   THE Replayer SHALL abort the replay, discard the Sandbox, and return a timeout error to the
   caller.
6. WHEN the Sandbox cannot be started, THE Replayer SHALL return a service-unavailable error
   without attempting replay.
7. WHEN a replay is aborted due to timeout, THE Daemonize SHALL log the failed Action identifier,
   the Payload, and the elapsed time.
8. THE Replayer SHALL run in Strict_Mode by default, replaying each step only through recorded,
   deterministic means (Requirement 12).
9. IF a step cannot be executed in Strict_Mode, THEN THE Replayer SHALL fail the call cleanly and
   return `drifted: true`, `success: false`, `error: "step_failed"` and a `failure` diagnostic,
   without guessing the element.
10. THE Replayer SHALL return a result made of the fields `success`, `drifted`, `driftChecked`,
    `healed`, `healedSteps`, `levels`, `levelFallback`, `mode`, `data`, `text`, `title`,
    `terminalSize`, `driftReason` and `failure`, where `driftChecked` is `false` when the
    Workflow has no recorded final Screen.
11. WHEN a call fails, THE Replayer SHALL set `error` to one of `step_failed`, `missing_secret`,
    `pattern_timeout`, `http_failed`, `heal_unavailable`, `result_zone_not_found`,
    `result_extraction_failed`, `storage_state_missing`, `sandbox_unavailable`, `timeout` or
    `validation`.

---

### Requirement 8: Kiro Power Integration

**User Story:** As a Kiro IDE user, I want the generated MCP server to be immediately registrable
as a Kiro Power, so that I can call Target_Application actions from within Kiro without manual
configuration.

#### Acceptance Criteria

1. WHEN compilation succeeds, THE Compiler SHALL emit a Kiro_Power in the output directory made of
   `plugin.json` (name in kebab-case, version, description, author, keywords), `mcp.json` (one
   stdio MCP_Server running the generated `mcp-server.js`) and one skill `skills/<name>/SKILL.md`.
2. THE `plugin.json` keywords SHALL be derived from the target application name and the tool
   names, so that Kiro activates the Kiro_Power when the user mentions the application.
3. THE `mcp.json` SHALL reference `mcp-server.js` by absolute path resolved at compile time, so
   that the MCP_Server starts whatever the working directory of Kiro and wherever Kiro copies the
   Kiro_Power.
4. THE `SKILL.md` SHALL list each tool with its description and inputs, and explain that results
   flagged `drifted` mean the application changed since recording.
5. THE Compiler SHALL also emit a `POWER.md` (frontmatter `name`, `displayName`, `description`,
   `keywords`) for Kiro versions that predate `plugin.json`.
6. WHEN the user imports the output directory as a Custom Power from a folder, THE MCP_Server
   SHALL start and list its tools without manual configuration other than `npm install` (or
   `compile --install`).

---

### Requirement 9: Property-Based Test Generation for Schemas

**User Story:** As a developer, I want Daemonize to generate property-based tests for the
inferred schemas, so that schema regressions are caught automatically before the MCP server is
deployed.

#### Acceptance Criteria

1. WHEN compilation succeeds, THE Daemonize SHALL generate a property-based test suite that
   exercises every Action's input JSON Schema with both valid and invalid generated Payloads.
2. FOR ALL valid generated Payloads (those satisfying the inferred JSON Schema), THE Validator
   SHALL accept the Payload (round-trip property between schema generation and validation).
3. FOR ALL invalid generated Payloads (those violating at least one constraint in the inferred
   JSON Schema), THE Validator SHALL reject the Payload.
4. WHEN a generated test suite is executed, THE Daemonize SHALL report the number of passing
   properties, failing properties, and any shrunk counterexamples.
5. THE generated test suite SHALL be written as self-contained files that require no changes to
   run after compilation.

---

### Requirement 10: Incremental Session Merging

**User Story:** As a developer, I want to run multiple recording sessions and merge their results,
so that I can cover different workflows of the Target_Application without redoing earlier
navigation.

#### Acceptance Criteria

1. WHEN the user triggers a merge of two State_Graphs, THE State_Machine_Builder SHALL produce a
   merged State_Graph whose node set is the union of the two input node sets.
2. WHEN two nodes from different State_Graphs share the same Screen identifier, THE
   State_Machine_Builder SHALL unify them into a single node and union their outgoing Transition
   sets.
3. WHEN two Transitions from different State_Graphs share the same source Screen, action type,
   action parameters, and destination Screen, THE State_Machine_Builder SHALL deduplicate them
   into a single Transition.
4. FOR ALL pairs of valid State_Graphs A and B, merging A into B and merging B into A SHALL
   produce State_Graphs with identical node and edge sets (commutativity property).
5. FOR ALL valid State_Graphs A, merging A with itself SHALL produce a State_Graph equal to A
   (idempotence property).
6. WHEN the user triggers a merge of two Workflow sets, THE Daemonize SHALL keep the union of
   their Workflows, replacing a Workflow by the one from the newer set when both share the same
   identifier.

---

### Requirement 11: Drift Detection at Run Time

**User Story:** As an agent developer, I want every call to tell me whether the application still
looks like it did at recording time, so that I can trust or distrust the result.

#### Acceptance Criteria

1. WHEN a web or terminal Action completes, THE MCP_Server SHALL return `drifted: boolean` in the
   response.
2. THE MCP_Server SHALL compute `drifted` by normalizing and hashing the final Screen with the
   same algorithm as the ScreenHasher and comparing the hash with the Workflow's `finalScreenId`.
3. THE generated MCP_Server SHALL contain its own copy of the normalization and hashing code and
   SHALL import nothing from `src/`.
4. WHERE a target zone is configured (a selector for web, a row and column rectangle for
   terminal), THE MCP_Server SHALL compute the hash only over that zone.
5. FOR ALL Screens, THE run-time hash computed by the generated MCP_Server SHALL equal the hash
   computed by the ScreenHasher (equivalence property).
6. THE generated MCP_Server SHALL translate the JSON Schema keywords `enum`, `items`, `minItems`,
   `maxItems`, `properties`, `required`, `additionalProperties`, `minLength`, `maxLength`,
   `pattern`, `minimum`, `maximum`, `anyOf`, `oneOf` and type lists into Zod, without using
   `z.unknown()` for them.
7. IF a JSON Schema keyword cannot be expressed in Zod, THEN THE generated MCP_Server SHALL keep
   the AJV validation as the authority for that keyword and SHALL state this in a code comment.
8. FOR ALL schemas in the supported keyword subset, THE generated Zod schema SHALL accept exactly
   the Payloads that AJV accepts (equivalence property).

---

### Requirement 12: Replay Levels, Cascade and Strict/Heal Modes

**User Story:** As an agent developer, I want replay to be deterministic by default and to heal
only when I allow it, so that the tool never silently acts on the wrong element.

#### Acceptance Criteria

1. WHEN a step is replayed, THE Replayer SHALL try the Replay_Levels in this order: Level 1
   recorded HTTP call, Level 2 accessibility locator with Anchor, Level 3 vision.
2. THE Replayer SHALL use Strict_Mode unless the user enables Heal_Mode with `--heal`.
3. WHILE the Replayer is in Strict_Mode, THE Replayer SHALL use only Level 1 and Level 2.
4. IF a step classified as write or delete is replayed and the user has not explicitly allowed
   healing for that step, THEN THE Replayer SHALL use Strict_Mode for that step even when
   Heal_Mode is enabled.
5. IF Level 1 and Level 2 fail in Strict_Mode, THEN THE Replayer SHALL return `success: false`
   and `drifted: true` with `error: "step_failed"` and a diagnostic containing the failing step,
   the locators tried, and a screenshot path or an inline thumbnail.
6. IF Level 1 and Level 2 fail in Strict_Mode, THEN THE Replayer SHALL execute no further step.
7. WHILE Heal_Mode is enabled, WHEN all deterministic locators of a step fail or the UI has no
   DOM (Canvas, Flutter Web), THE Replayer SHALL capture a screenshot with set-of-mark overlays,
   send it with the recorded Visual_Anchor and the step's intent to a multimodal model, and
   receive a locator or x,y coordinates.
8. WHEN the Replayer executes an action located by Level 3, THE Replayer SHALL return
   `healed: true` in the response.
9. WHEN a repaired locator is obtained in Heal_Mode, THE Replayer SHALL store it in a local cache
   file separate from the Workflow file and SHALL use the cached locator on later calls before
   calling the model again.
10. THE Replayer SHALL complete Strict_Mode replay without calling any model.
11. IF Heal_Mode is enabled and no model or API key is configured, THEN THE Replayer SHALL report
    that Heal_Mode is unavailable.
12. FOR ALL Workflows, THE Workflow file SHALL be byte-identical before and after any replay in
    Heal_Mode (the cache never modifies the Workflow).
13. THE `daemonize serve` command SHALL select the mode with `--strict` or `--heal`, and the
    generated MCP_Server SHALL read the mode from `DAEMONIZE_MODE`.
14. WHERE the user compiles with `--heal-support`, THE Compiler SHALL copy `src/heal/**` into
    `<out>/heal/` and the recorded thumbnails into `<out>/.daemonize/anchors/`, and WHEN the
    user compiles without `--heal-support`, THE Compiler SHALL emit no model code.
15. WHILE Heal_Mode is enabled, THE Replayer SHALL locate a healed step from the heal cache, from
    the recorded coordinates (`visual.rect`) or from the model, in that order, and SHALL report
    the source of each healed step in `healedSteps`.
16. THE Replayer SHALL never heal a step that has a `rowBinding`.
17. WHERE a step targets a canvas, THE Replayer SHALL replay it only in Heal_Mode, and THE
    recorder SHALL classify canvas steps as `read` by default so that the user can edit `risk`
    and `allowHeal`.
18. THE Replayer SHALL honour the test seam `DAEMONIZE_HEALER_MODULE` only WHEN `NODE_ENV` equals
    `test` or `DAEMONIZE_UNSAFE_HEALER_MODULE` equals `1`.

---

### Requirement 13: Level 1 Network Capture and Direct HTTP Replay

**User Story:** As a developer, I want Daemonize to detect the HTTP calls behind a UI action, so
that calls run in milliseconds and do not depend on the front-end framework.

#### Acceptance Criteria

1. WHEN the user performs an action while recording a web Target_Application, THE recorder SHALL
   observe the fetch and XHR requests triggered by that action.
2. WHEN a marked Variable value matches a request parameter (a GET query parameter, a field of a
   JSON body of POST, PUT or PATCH, or a path segment) and the response is JSON, THE recorder
   SHALL record that request as a Level 1 candidate for the step.
3. WHERE the user compiles with `--http auto` (the option `--http [auto|off]`, default `off`), THE
   Replayer SHALL execute the recorded request with the cookies and headers read from a
   storageState file referenced by path, and SHALL report the Replay_Level of each step in
   `levels`.
4. WHEN the action depends on an SSR form, an opaque Server Action or pure DOM state, THE
   Replayer SHALL fall back to Level 2.
5. THE recorder SHALL replace the values of Authorization, Cookie and Set-Cookie headers and
   token-like values in recorded requests by a Secret_Reference.
6. WHEN a recorded request is replayed, THE Replayer SHALL obtain the secret values from the
   storageState file or from environment variables at run time.
7. FOR ALL recorded requests, THE serialized request SHALL contain none of the values it was
   redacted from (redaction property).
8. IF a Level 1 request of a `read` step fails, THEN THE Replayer SHALL fall back to Level 2 and
   report `levelFallback: true`.
9. IF a Level 1 request of a `write` or `delete` step fails, THEN THE Replayer SHALL fail the
   call with `error: "http_failed"` and SHALL NOT repeat the step at Level 2, so that no action
   runs twice.
10. FOR ALL recorded requests, THE variables bound in the HTTP recipe SHALL be exactly the
    places (query parameter, JSON body field or path segment) where the recorded Variable value
    appeared (binding property).

---

### Requirement 14: Level 2 Accessibility and Relational Anchoring

**User Story:** As a developer, I want locators that survive layout changes and work on modern
component libraries, so that replay does not depend on CSS structure.

#### Acceptance Criteria

1. WHEN the recorder records a web step, THE recorder SHALL store the ARIA role, the accessible
   name, the parent context, and the frame path (iframe index chain) of the targeted element.
2. WHEN a step opens a new page or popup, THE recorder SHALL record that page opening, and THE
   Replayer SHALL continue the following steps on that page.
3. THE Replayer SHALL support non-native components: `[role=combobox]`, `[role=listbox]`,
   portals of Radix, MUI and HeadlessUI, and contenteditable elements.
4. WHEN a step requires a preparatory scroll or hover, THE recorder SHALL record it and THE
   Replayer SHALL execute it before the step.
5. WHEN the targeted element is in a row or card of a dynamic list or table, THE recorder SHALL
   record a relational locator made of the row or card containing a value and the action inside
   it.
6. WHERE the user marks the value of a relational locator as a Variable, THE recorder SHALL bind
   that value to the Workflow Variable (for example the row containing `{{customer}}`).
7. THE recorder SHALL record locators without `.first()` and without positional `:nth-of-type`
   selectors.
8. THE Replayer SHALL base each wait on the observable effect of the preceding action, and SHALL
   use no `networkidle` wait with a fixed timeout.
9. THE Replayer SHALL accept a configurable timeout per step and a configurable timeout per
   Workflow, neither fixed at 10 seconds.
10. FOR ALL recorded Workflows, THE Replayer SHALL execute the same steps in the same order on a
    page with WebSocket, SSE or polling traffic as on a page without it.

---

### Requirement 15: Visual Anchors

**User Story:** As a developer, I want each step to keep a picture of what it targeted, so that
Heal_Mode can find the element again when the DOM locators fail.

#### Acceptance Criteria

1. WHEN the recorder records a web step, THE recorder SHALL capture a Visual_Anchor containing a
   thumbnail of the targeted zone, its relative coordinates as fractions of the viewport, and a
   short human-readable description of the intent.
2. THE recorder SHALL store thumbnails as files in the `<workflow>.assets/` directory next to the
   Workflow file and SHALL reference them by relative path from the Workflow file.
3. THE compiled artifacts SHALL contain no inline thumbnail data and no thumbnail file, except
   the copy placed in `<out>/.daemonize/anchors/` by `compile --heal-support`.
4. WHEN the targeted element is a password field or a one-time-code field, THE recorder SHALL
   capture no thumbnail of that region.
5. FOR ALL Visual_Anchors, THE relative coordinates SHALL lie between 0 and 1 inclusive
   (invariant).
6. WHERE the user passes `--no-visual` to `record`, THE recorder SHALL capture no Visual_Anchor.

---

### Requirement 16: Secrets, Authentication and Result Extraction

**User Story:** As a security-conscious developer, I want secrets to stay out of every generated
file and to be injected only at run time, so that publishing a Kiro_Power never leaks credentials.

#### Acceptance Criteria

1. THE Daemonize SHALL write no password, cookie, token or TOTP secret in a workflow file, an
   OpenAPI_Spec, a Kiro_Power file or a generated test.
2. WHEN a step needs a password or 2FA value, THE Replayer SHALL read it at run time from the
   environment variable `DAEMONIZE_SECRET_<NAME>`, or from the `env` entry of `mcp.json`.
3. WHERE a step has `totp: true` and a `secretRef`, THE Replayer SHALL derive the current TOTP
   code from the base32 seed held in `DAEMONIZE_SECRET_<NAME>` and type that code.
4. IF a required `DAEMONIZE_SECRET_<NAME>` variable is not set, THEN THE Replayer SHALL return an
   error naming the missing variable, without replaying any step.
5. WHEN a typed value is not marked as a Variable or a Secret_Reference, THE CLI SHALL warn the
   user that the value is stored as typed.
6. WHERE a storageState is defined, THE generateSandboxFiles function and the docker replay SHALL
   mount or copy the file into the container read-only, by path.
7. THE docker replay SHALL leave the storageState file out of every image layer.
8. WHERE the user marks a Result_Zone, THE Replayer SHALL return the structured data of that zone
   instead of the whole `document.body.innerText`.
9. FOR ALL Workflows and all values supplied through `DAEMONIZE_SECRET_*` variables, no compiled
   artifact SHALL contain any of those values (no-leak property).
10. THE `mcp.json` env SHALL contain `${NAME}` placeholders for secrets (never values) and
    `DAEMONIZE_MODE`.
11. WHERE a storageState is defined, THE docker replay SHALL mount it read-only at
    `/run/daemonize/storage-state.json` and set `DAEMONIZE_STORAGE_STATE`, and a relative
    storageState path SHALL resolve against the compiled output directory.
12. THE Compiler SHALL emit a `.dockerignore` that excludes authentication files.
13. THE repository SHALL provide the guard `npm run check:secrets`, which scans tracked and
    to-be-committed files for credential shapes and reports file, line and rule but never the
    value, and a Kiro hook SHALL run it when an example, a document or a workflow file is saved.
14. IF the storageState file is absent, THEN THE Replayer SHALL return `error:
    "storage_state_missing"`.
15. IF a TOTP seed is not valid base32, THEN THE Replayer SHALL return `error: "missing_secret"`
    naming the variable only.
---

### Requirement 17: Real CLI/TUI Reliability

**User Story:** As a developer wrapping a real command-line tool, I want replay to stay in sync
with slow or continuously refreshing programs, so that calls do not depend on fixed delays.

#### Acceptance Criteria

1. WHEN the recorder records a terminal Target_Application, THE recorder SHALL store the terminal
   columns and rows in the Workflow.
2. WHEN the Replayer replays a terminal Workflow, THE Replayer SHALL use the recorded columns and
   rows instead of 80x24.
3. WHEN the user adds a wait to a step, THE recorder SHALL store in the step a `waitFor` made of
   `pattern` or `text`, optional `flags`, optional `region`, `mode` (`appear` or `disappear`),
   `timeoutMs` and optional `when`, and WHEN the recorder detects a prompt on a keypress step,
   THE recorder SHALL store `pattern: "^<escaped prompt>$"`, `flags: "m"`, `mode: "appear"` and
   `timeoutMs: 15000`.
4. WHEN a step has a Screen_Pattern, THE Replayer SHALL wait until the terminal text matches the
   pattern (`waitForPattern`) before continuing.
5. IF a Screen_Pattern does not match within its timeout, THEN THE Replayer SHALL return
   `success: false`, `drifted: true` and `error: "pattern_timeout"` with a `failure.screenExcerpt`
   of the terminal text as diagnostic.
6. THE generated Dockerfile SHALL accept a configurable base image, configurable system packages
   or install commands, and a configurable network profile.
7. WHERE the user configures the packages of a real binary (sqlite3, git, psql, a Python or Go
   CLI), THE generated Dockerfile SHALL install them so that the binary runs in the Sandbox.
8. THE recorder menu opened with Ctrl+] SHALL offer `v` (mark the last typed text as a Variable),
   `e` (end the recording) and `w` (add a wait), and SHALL never send these keys to the program.
9. THE Replayer SHALL evaluate a pattern wait in a `node:vm` script with a 50 ms budget, and SHALL
   reject an over-long or catastrophic pattern (ReDoS protection).
10. WHERE the user passes `--cols` and `--rows` to `record`, THE recorder SHALL record that size,
    and WHEN a terminal Workflow is replayed at a different size, THE Replayer SHALL report
    `drifted: true` with a `driftReason`.
11. THE `daemonize sandbox build` command SHALL accept `--image`, `--package`, `--install`,
    `--network`, `--tag`, `--no-cache` and `--print`, and THE `compile` command SHALL accept
    `--sandbox-image`, `--sandbox-package`, `--sandbox-install` and `--sandbox-network`.
12. IF a sandbox image, package, install command or network value does not pass validation, THEN
    THE Compiler SHALL refuse it with an error, so that no Dockerfile injection is possible.

---

### Requirement 18: Compile-Time AI Suggestions and Studio

**User Story:** As a developer, I want optional model suggestions at compile time and a visual
tool to inspect my workflows, so that I can review them before agents call them.

#### Acceptance Criteria

1. WHERE an API key is available, THE Compiler SHALL ask a language model for tool names,
   descriptions, candidate Variables, correlated network parameters and a Result_Zone selector.
2. IF no API key is available, THEN THE Compiler SHALL use deterministic rules and report that it
   did so.
3. WHERE the user passes `compile --suggest[=auto|deterministic|model]`, THE Compiler SHALL write
   `<file>.suggestions.json` with every entry set to `accepted: false`, and SHALL apply only the
   entries the user set to `accepted: true` (tool names, tool descriptions and Variable
   descriptions).
4. THE generated MCP_Server SHALL execute without calling a language model unless Heal_Mode is
   enabled.
5. THE Studio SHALL run as a local web interface that can also be deployed as a demo.
6. THE Studio SHALL display a WorkflowSet and its State_Graph as a graph, the Replay_Level used
   by each step, the generated schemas, and the property-based test results.
7. THE Studio SHALL provide an MCP playground that calls a tool and shows `drifted`, `healed` and
   a Screen preview.
8. THE Studio SHALL display no secret value.
9. THE `daemonize studio [dir]` command SHALL accept `--workflows`, `--port`, `--host`,
   `--allow-remote`, `--graph`, `--open` and `--sample`, SHALL require a per-run token, a valid
   Host header and a Content-Security-Policy of `default-src 'self'`, and SHALL accept a `--host`
   other than loopback only with `--allow-remote`.
10. WHEN the playground calls a `write` or `delete` tool, THE Studio SHALL ask the user for
    confirmation before the call.
11. WHERE `DAEMONIZE_SCREENSHOT=final` is set, THE playground SHALL return a screenshot of the
    final Screen.
12. THE repository SHALL provide `npm run studio:build`, which writes a static demo to
    `dist-demo` that uses a simulation module shared with `studio --sample`, and the file
    `.github/workflows/studio-demo.yml` SHALL publish it.
13. FOR ALL suggestion files and all accepted-entry subsets, applying the suggestions SHALL leave
    the replayed steps of every Workflow unchanged (invariant).
14. FOR ALL Studio API responses, THE Studio SHALL return no value of any `DAEMONIZE_SECRET_*`
    variable.
15. FOR ALL playground responses, THE Studio SHALL return no value of any `DAEMONIZE_SECRET_*`
    variable.

---

### Requirement 19: End-to-End Proof on Real Software

**User Story:** As a maintainer, I want Daemonize proven on real applications, so that its claims
hold beyond a toy form.

#### Acceptance Criteria

1. THE repository SHALL contain `examples/adminer/`, which wraps the real, existing web
   application Adminer (with PostgreSQL, through Docker Compose) and exercises authentication
   and a dynamic table. Adminer is server-rendered, so its steps replay at Level 2 only and no
   Level 1 recipe is recorded.
2. THE repository SHALL contain `examples/cli-sqlite/`, which wraps the real `sqlite3` shell and
   restricts its Variables by `pattern` and `maxLength`. An example for `git` is optional and is
   not implemented.
3. THE integration tests SHALL record, compile and call through MCP each example.
4. IF Docker or the example tool is unavailable, THEN THE integration tests SHALL skip with a
   message naming the missing dependency.
5. THE compiled artifacts of the examples SHALL contain no plain password, cookie or secret.
