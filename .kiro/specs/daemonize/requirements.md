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
   Replayer SHALL flag the response as drifted without failing the call.
5. WHEN a Workflow replay does not complete within a configurable timeout (default 10 seconds),
   THE Replayer SHALL abort the replay, discard the Sandbox, and return a timeout error to the
   caller.
6. WHEN the Sandbox cannot be started, THE Replayer SHALL return a service-unavailable error
   without attempting replay.
7. WHEN a replay is aborted due to timeout, THE Daemonize SHALL log the failed Action identifier,
   the Payload, and the elapsed time.

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
