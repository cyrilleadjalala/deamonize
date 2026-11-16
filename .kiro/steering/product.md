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
- **Execution stays deterministic.** Language models may suggest names, descriptions and candidate Variables at compile time. They never decide what is replayed at call time.
- **Replay is isolated.** With `--sandbox docker` each call runs in a throw-away container with limits and no host access beyond what the user mounts.
- **Never store secrets silently.** Password values are never captured. Typed values not marked as Variables are stored as they are, and the CLI warns about them.