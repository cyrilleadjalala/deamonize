---
inclusion: always
---

# Project structure

```
src/
  types.ts            shared types (Workflow, WorkflowSet, StateGraph, CompileResult...)
  cli/                commander commands: record, record-tui, compile, merge, serve, studio, mcp, sandbox
  recorder/           LiveRecorder (browser), TerminalRecorder, WorkflowRecorder, selector builder
  sandbox/            PlaywrightDriver, PtyDriver, key table, SandboxManager (library)
  replayer/           Replayer (fresh sandbox per call), result extractor
  replay/runtime/     modules copied into every generated server (no import from src/): web and HTTP replay,
                      and the firewall: firewall.ts (gate, audit entry, trace of each call), approval-queue.ts
                      (approval records, first decision wins), audit-log.ts, trace.ts
  schema/             SchemaAccumulator (widening), FormatAnnotator, LabelExtractor, SchemaInferencer
  validator/          AJV validator, compiled once
  compiler/           tool names, OpenAPI, MCP server source, Kiro Power files, orchestrator
  pbt/                generator of the property-based suite and its support modules
  state/              State_Graph schema, ScreenHasher, StateMachineBuilder
  workflow/           WorkflowSet persistence and merge
  studio/             the Studio server, routes/, ui/, approvals-service.ts (approvals), activity-service.ts (audit view),
                      power-installer.ts (installs the Daemonize_Power)
  studio/mcp/         the Studio_MCP (`daemonize mcp`): server, tools, schemas, texts, tool-names (13 tools)
power/                the Daemonize_Power: POWER.md, mcp.json, plugin.json, agents/, skills/, steering/
kiro-extension/       the Kiro extension (.vsix); kiro-extension/src/core imports neither vscode nor src/
examples/             adminer (web), cli-sqlite (terminal)
docs/                 studio.md, replay-model.md, secrets.md, dogfooding.md, design-tokens.md
tests/
  unit/ property/ integration/ extension/ fixtures/
.kiro/
  specs/              one folder per spec (requirements.md or bugfix.md, design.md, tasks.md)
  steering/ hooks/
  agents/             daemonize.md, the Builder_Agent
  skills/             daemonize-builder/SKILL.md, the Builder_Skill
  settings/           mcp.json.example (the real mcp.json is ignored by git)
```

- Specs are the source of truth. When behavior changes, update `requirements.md` and `design.md` first, then the tasks.
- One class or concern per file, named in kebab-case after the class (`tool-name-deriver.ts`).
- `src/replay/runtime/*` imports nothing from `src/`. The approvals and the audit log are files in the Daemonize data folder, read by the Studio and written by generated servers.
- `power/agents` and `power/skills` mirror `.kiro/agents` and `.kiro/skills`, and differ only in `resources` paths.
- Generated output goes to `daemonize-out/` (ignored by git). Never commit it.
