---
inclusion: always
---

# Product: Daemonize

Daemonize turns software that has no API (a legacy web admin, a terminal program) into tools an AI agent can call.

A developer uses the target application once. Daemonize records the steps as a **Workflow**, lets the developer mark the fields that change (**Variables**), infers a typed JSON Schema for them, and compiles:

- an MCP server (one tool per Workflow),
- an OpenAPI 3.1 document,
- a Kiro Power (`plugin.json`, `mcp.json`, `skills/<name>/SKILL.md`, `POWER.md`),
- a property-based test suite for every tool's input schema.

## Principles that drive decisions

- **A tool is a whole recorded path, not a single click.** Every call starts a fresh sandbox at the known start state and replays all steps. The server never needs to know which screen it is on. Do not reintroduce screen-to-screen navigation at call time.
- **The State_Graph is for drift detection only.** It does not drive execution.
- **An agent must not be able to break the target application.** A payload is validated against the inferred schema before anything is replayed. An invalid payload must never reach the sandbox.
- **Replay is deterministic by default (`--strict`).** In strict mode every call is replayed only through recorded, deterministic means: a recorded HTTP request, then accessibility-based locators with relational anchors. If they fail, the call fails cleanly with `drifted: true` and a diagnostic. Nothing is guessed. `--strict` is the default, and it is mandatory for steps that write or delete.
- **Vision healing is opt-in (`--heal`).** Only when the user turns on `--heal` may a multimodal model look at a screenshot, compared with the recorded thumbnail and the step's intent, to find an element when every deterministic locator failed (or when the UI has no DOM, such as Canvas). The repaired locator is cached, then replayed deterministically on later calls. A healed result is always flagged (`healed: true`) so the agent and the user can tell it apart. A healed step never runs unattended on a write or delete step unless the user allows it explicitly.
- **Language models never replace the recording.** At compile time they may suggest names, descriptions, candidate Variables and result zones. Without an API key everything falls back to deterministic rules. At call time a model can intervene only through `--heal`, and only to locate an element, never to decide what the workflow does.
- **Replay is isolated.** With `--sandbox docker` each call runs in a throw-away container with limits and no host access beyond what the user mounts.
- **Never store secrets.** Password values, cookies, tokens and TOTP secrets never appear in a workflow file or any compiled artifact. Secrets are read at run time from environment variables (`DAEMONIZE_SECRET_*`, or the `env` of `mcp.json`). A saved login (`storageState`) is a local file referenced by path, never embedded. Typed values not marked as Variables are stored as they are, and the CLI warns about them.
- **Prefer the most stable layer.** Replay tries, in order: recorded HTTP call, accessibility locator with relational anchor, then (only with `--heal`) vision. The generated server must not depend on a front-end framework or on CSS structure.