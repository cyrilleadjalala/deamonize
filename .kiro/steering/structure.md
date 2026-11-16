---
inclusion: always
---

# Project structure

```
src/
  types.ts            shared types (Workflow, WorkflowSet, StateGraph, CompileResult...)
  cli/                commander commands: record, record-tui, compile, merge, serve, sandbox
  recorder/           LiveRecorder (browser), TerminalRecorder, WorkflowRecorder, selector builder
  sandbox/            PlaywrightDriver, PtyDriver, key table, SandboxManager (library)
  replayer/           Replayer (fresh sandbox per call), result extractor
  schema/             SchemaAccumulator (widening), FormatAnnotator, LabelExtractor, SchemaInferencer
  validator/          AJV validator, compiled once
  compiler/           tool names, OpenAPI, MCP server source, Kiro Power files, orchestrator
  pbt/                generator of the property-based suite and its support modules
  state/              State_Graph schema, ScreenHasher, StateMachineBuilder
  workflow/           WorkflowSet persistence and merge
tests/
  unit/ property/ integration/ fixtures/
.kiro/
  specs/daemonize/    requirements.md, design.md, tasks.md (source of truth)
  steering/ hooks/
```

- Specs are the source of truth. When behavior changes, update `requirements.md` and `design.md` first, then the tasks.
- One class or concern per file, named in kebab-case after the class (`tool-name-deriver.ts`).
- Generated output goes to `daemonize-out/` (ignored by git). Never commit it.