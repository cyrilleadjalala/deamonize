# Implementation Plan: user-journey-improvements

## Overview

The implementation language is TypeScript for `src/`, `kiro-extension/` and the tests, and plain ES modules for `src/studio/ui/js` (as the design states). Work follows the design's "Implementation groups" in this order.

- **Group P0** (regression fixtures and snapshot) runs first, serial, at the current HEAD, before any file under `src/` changes. Its tests are required, not optional.
- **Group G0** (the seam: types, workflow-set schema, pure modules, protocol and Studio contracts, `server.ts`, `routes/index.ts`, `api.js`, `copy.js`, per-group css and copy stubs) is serial and runs after P0. A checkpoint follows.
- **Groups G-A, G-B, G-C, G-D, G-E, G-F, G-H, G-I, G-J, G-K** then run in parallel (there is no group G-G). Each group edits only the files listed after "Owns:", and the lists are disjoint. A group that needs a change in a file it does not own writes the request in its hand-off note for checkpoint C. No group after G0 edits `src/types.ts`, `workflow-set.ts`, `contracts.ts`, `server.ts`, `routes/index.ts`, `api.js` or `copy.js`. The regression snapshot is read-only after P0.
- After each feature (F1 to F9, see the design's commit table) a group copies its owned files to `%TEMP%\uji-snapshots\<group>\F<k>\<same relative path>`, so that checkpoint C can build one commit per feature. Edit in feature order F1 to F9 inside each task.
- **Checkpoint C** runs last: the root and extension verification commands with exact results, then the nine feature commits. Nothing is pushed unless the user asks.
- Requirement conflicts are resolved as the design says (RC-1 outline shield with contrast measured per mark; RC-2 recorder name limit 64 and Studio limit 60 both kept; RC-3 the origin check wins on replace; RC-4 normalized round-trip; RC-5 the Check_Step is Requirement 7). Task 13.3 amends `requirements.md` so the spec matches.
- Property tests use `fast-check` with at least 100 runs (200 for Properties 5, 7, 10, 20, 23) and a tag comment `// Feature: user-journey-improvements, Property N: <title>`. Each property test has its own file so parallel tasks never share a file. Tests never touch the real `~/.kiro`, hold no secret value and use no network.
- Test sub-tasks marked `*` are optional. Not optional: the regression test (Requirement 24.3, task 1.1 and 1.2) and the old-file compatibility tests (tasks 3.7, 5.3, 6.3, 7.4, 8.7, 9.4, 10.2, 11.3, 12.3, 14.3).
- Cross-group dependencies: tests that run generated code (6.11) need G-A and G-B. G-C `live-recorder.ts` (7.2) needs `variable-settings.ts` and `workflow-recorder.ts` (7.1). G-D `record.ts` (8.3) needs `kiroHomeExists` in `LiveRecorderOptions` (7.2). Browser tests need the local fixture pages and Playwright, as in earlier specs.

## Tasks

- [x] 1. P0 regression fixture and snapshot (serial, first, no change under `src/`)
  - Owns: `tests/fixtures/regression/pre-change.workflows.json` (new), `tests/fixtures/regression/pre-change-tui.workflows.json` (new), `tests/fixtures/regression/snapshot/**` (new), `tests/helpers/regression-snapshot.ts` (new), `tests/unit/regression-fixture.test.ts` (new).
  - Do not touch any file under `src/`.

  - [x] 1.1 Write the fixtures, the snapshot helper and the regression test
    - Create the two fixtures with fixed UUIDs: a web set with `type`, `select`, `click`, a row binding, an optional Variable, an HTTP recipe and workflows without `description`; and a terminal set. Neither holds `whenOmitted`, a `check` step, a workflow `startUrl` or a workflow `storageState`.
    - Create `tests/helpers/regression-snapshot.ts` with `buildSnapshot(file)`: load with `deserializeWorkflowSet`, compile with `Compiler` into a temporary folder for the option sets `{}`, `{ http: 'auto' }`, `{ healSupport: true }`, and return canonical JSON holding the loaded set, the tool names (`nameMap`), the input schemas, the full text of `mcp-server.ts`, `replay.ts` and `docker-replay.ts` per option set, the list of copied runtime files and a pure replay trace (`planLocators` descriptions for fixed arguments, `planSteps`, `buildRequest` results for the recipe, `buildRowLocator`, and, when Playwright is available, one real replay of the web fixture page without `elapsedMs`).
    - Create `tests/unit/regression-fixture.test.ts`: with `UPDATE_REGRESSION=1` it writes `tests/fixtures/regression/snapshot/*`; without it, it compares and fails on any difference that is not in the closed `ALLOWED_DIFFERENCES` (the extra `omission.ts` and `omission.js` in the copied-file list and the `omission.js` entry in the sandbox `copy` list).
    - _Requirements: 24.3_

  - [x] 1.2 Capture the snapshot at the current HEAD
    - Before any other group changes a file, run `UPDATE_REGRESSION=1 npx vitest run tests/unit/regression-fixture.test.ts` at the current HEAD and record `git rev-parse HEAD` in the hand-off note (the F1 commit message cites it).
    - Run `npx vitest run tests/unit/regression-fixture.test.ts` once without the variable and require it to pass.
    - From now on the snapshot and `ALLOWED_DIFFERENCES` are read-only. A group that needs another difference reports it to checkpoint C.
    - _Requirements: 24.3_

- [x] 2. Checkpoint - P0 done
  - Require the regression test to pass with no `src/` change in `git status`. G0 does not start before this passes.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. G0 seam (serial, after the P0 checkpoint)
  - Owns: `src/types.ts`, `src/workflow/workflow-set.ts`, `src/workflow/merge.ts` (new, the current `mergeWorkflowSets` moved unchanged), `src/workflow/workflow-scope.ts` (new), `src/workflow/origin-guard.ts` (new), `src/workflow/variable-edit.ts` (new), `src/replay/runtime/omission.ts` (new), `src/recorder/panel-protocol.ts` (new), `src/studio/contracts.ts`, `src/studio/inert-services.ts`, `src/studio/server.ts` (the compiler wrapper only), `src/studio/routes/index.ts`, `src/studio/routes/workflows.ts` (stub returning `[]`), `src/studio/messages/workflows.ts` (stub), `src/studio/messages/index.ts`, `src/studio/ui/js/api.js`, `src/studio/ui/js/copy.js` (aggregation only), `src/studio/ui/js/copy-record.js` (stub), `src/studio/ui/js/copy-editor.js` (stub), `src/studio/ui/js/copy-compile.js` (stub), `src/studio/ui/css/record.css` (stub), `src/studio/ui/css/editor.css` (stub), `src/studio/ui/css/compile.css` (stub), `src/studio/ui/index.html` (three `<link>` tags only), `tests/helpers/workflow-arbitraries.ts` (new), `tests/unit/studio-ui-copy.test.ts`, `tests/unit/studio-ui-contrast.test.ts`, `tests/unit/workflow-set*.test.ts`, `tests/unit/workflow-set-compat.test.ts` (new), `tests/unit/workflow-schema-rules.test.ts` (new), `tests/unit/workflow-scope.test.ts` (new), `tests/property/variable-fields.property.test.ts` (new), `tests/property/when-omitted-validity.property.test.ts` (new), `tests/property/description-limits.property.test.ts` (new), `tests/property/check-step-value.property.test.ts` (new), `tests/property/start-login-fields.property.test.ts` (new), `tests/property/skip-plan.property.test.ts` (new), `tests/property/origin-guard.property.test.ts` (new), `tests/property/variable-edit.property.test.ts` (new), `tests/property/payload-coercion.property.test.ts` (new), `scripts/lib/secret-scan.mjs` (only if a new fixture must hold a synthetic secret).
  - Do not add `omission.js` to the compile copy: that is G-B's. Report any regression difference that results.

  - [x] 3.1 Add the shared types and the workflow-set schema
    - `types.ts`: `check` in `StepActionType`, `WhenOmitted`, `WorkflowVariable.whenOmitted`, `Workflow.description`, `Workflow.startUrl`, `Workflow.storageState`, `ReplayResult.skippedSteps`.
    - `workflow-set.ts`: schema additions of the design (`check` action with `value` `"true"`/`"false"`, `whenOmitted` only with `optional: true`, `description` up to 1000 characters, workflow `startUrl` and `storageState`), `describeSchemaError` naming the workflow id and the Variable or field, the `new URL()` http(s) check of each workflow `startUrl`, and a re-export of `mergeWorkflowSets` from the new `merge.ts` (body moved unchanged).
    - A file with none of the new fields must serialize to the same bytes as before.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 7.2, 10.1, 10.2, 10.3_

  - [x] 3.2 Add the pure modules
    - `workflow-scope.ts`: `skipListOf`, `findSkippedPathBinding`, `SKIP_IN_PATH_MESSAGE`, `startUrlOf`, `storageStateOf`, `originOf`, `validateWorkflowScopes`, `usesWorkflowCall`.
    - `origin-guard.ts`: `checkSameOrigin`, `foreignOriginMessage`, `saveOriginMessage` (no file path in any message).
    - `variable-edit.ts`: `VARIABLE_NAME_RE`, `renameVariable` (steps, row bindings, recipe bindings, `{{name}}` in url, query and headers, `$var` leaves and string leaves of bodies, observed payload keys), `coercePayloadValue`, `retypePayloads`.
    - `omission.ts` (standalone, no import): `isOmitted`, `omittedSkips`, `planSkips`.
    - _Requirements: 1.9, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.7, 4.6, 4.7, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 10.11, 12.1, 12.2, 12.3, 12.4, 12.5, 14.13, 14.14_

  - [x] 3.3 Add the protocol and the Studio contracts seam
    - `panel-protocol.ts` (types only, as the design): `VariableType`, `PanelRequest`, `PanelField`, `FieldsAnswer`, `MarkVariableRequest`, `EditVariableRequest`, `VariableAnswer`, `FinishRequest`, `RadioInfo`, `PanelSummary` (with `files`), `PanelState` (with `kiroHomeExists`).
    - `contracts.ts`, `inert-services.ts`: `CompileOptionsInput`, `CompileRunner` (`tryStart(options?)`, `options()`), `RecordingStatus.kiro` fields (`scope`, `missingSecrets`, `requiredSecrets`).
    - `server.ts`: the `services.compiler` wrapper forwards `options` and `tryStart(options)`.
    - `routes/index.ts` registers `workflowRoutes`; `routes/workflows.ts` returns `[]`; `messages/workflows.ts` and `messages/index.ts` carry stubs.
    - _Requirements: 5.3, 6.3, 9.4, 13.1, 15.1, 19.7, 20.1, 21.5, 21.6_

  - [x] 3.4 Add the UI seam (copy modules, css stubs, api helpers)
    - `api.js`: `workflowUpdate(body)`, `workflowDelete(id)`, `compileStart(options?)`.
    - Create `copy-record.js`, `copy-editor.js`, `copy-compile.js` and `css/record.css`, `css/editor.css`, `css/compile.css` as empty stubs with a comment. `copy.js` aggregates the three copy modules in `allCopyTexts()`. `index.html` gains the three `<link>` tags only.
    - Check that `scripts/copy-studio-ui.mjs` copies `ui/css/` and that `server.ts` `resolveInside` serves a file in a subfolder.
    - _Requirements: 16.16, 22.8_

  - [x] 3.5 Add the shared property arbitraries
    - `tests/helpers/workflow-arbitraries.ts`: Variables with the new fields, recipes with bindings, base and new set pairs, workflows with per-workflow `startUrl` and `storageState`. Other groups import it and do not edit it. No generated value is a secret.
    - _Requirements: 24.2_

  - [x] 3.6 Widen the copy and contrast tests
    - `studio-ui-copy.test.ts` scans `messages/*` and `copy-*.js`; `studio-ui-contrast.test.ts` scans `app.css` and every file of `src/studio/ui/css/` (no literal colour outside `:root`, text contrast at least 4.5:1).
    - _Requirements: 16.16, 22.8_

  - [x] 3.7 Write the old-file compatibility test for the schema
    - File: `tests/unit/workflow-set-compat.test.ts`. A Workflow_File with no new field (including `optional: true` without `whenOmitted`) loads with no error, serializes to the same bytes, and the existing `tests/unit/workflow-set*.test.ts` keep passing. Add a case for a file with `check`-free steps.
    - _Requirements: 1.4, 7.11, 10.3_

  - [x]* 3.8 Write unit tests for the schema rules of Requirement 1
    - File: `tests/unit/workflow-schema-rules.test.ts`. Each of: `whenOmitted` valid values, `null`, `''`, wrong case, non-string, without `optional`; `description` 0, 1000 and 1001 characters and a non-string; `check` with `value` other than `"true"`/`"false"`; workflow `startUrl` and `storageState` accepted and refused values; error text names workflow id and Variable.
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 7.2, 10.1, 10.2_

  - [x]* 3.9 Write property test for Variable field round trip
    - File: `tests/property/variable-fields.property.test.ts`.
    - **Feature: user-journey-improvements, Property 1: Variable fields round trip**
    - **Validates: Requirements 1.4, 1.5, 10.3**

  - [x]* 3.10 Write property test for whenOmitted validity
    - File: `tests/property/when-omitted-validity.property.test.ts`.
    - **Feature: user-journey-improvements, Property 2: whenOmitted validity**
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x]* 3.11 Write property test for the description limits (loader part)
    - File: `tests/property/description-limits.property.test.ts`. The lead part of Property 3 is tested in 6.9.
    - **Feature: user-journey-improvements, Property 3: Description lead and limits**
    - **Validates: Requirements 1.6, 1.7, 1.8**

  - [x]* 3.12 Write property test for check step values
    - File: `tests/property/check-step-value.property.test.ts`.
    - **Feature: user-journey-improvements, Property 13: A check step holds true or false**
    - **Validates: Requirements 7.2**

  - [x]* 3.13 Write property test for start page and login fields
    - File: `tests/property/start-login-fields.property.test.ts`.
    - **Feature: user-journey-improvements, Property 18: Start page and login of a workflow**
    - **Validates: Requirements 10.1, 10.2**

  - [x]* 3.14 Write property test for skip planning
    - File: `tests/property/skip-plan.property.test.ts` (200 runs).
    - **Feature: user-journey-improvements, Property 5: Skip planning**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.6, 4.7**

  - [x]* 3.15 Write property test for the origin guard
    - File: `tests/property/origin-guard.property.test.ts`.
    - **Feature: user-journey-improvements, Property 22: Origin guard**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.9, 12.10**

  - [x]* 3.16 Write property test for the rename
    - File: `tests/property/variable-edit.property.test.ts`.
    - **Feature: user-journey-improvements, Property 25: A rename reaches every place**
    - **Validates: Requirements 14.13**

  - [x]* 3.17 Write property test for payload coercion
    - File: `tests/property/payload-coercion.property.test.ts`.
    - **Feature: user-journey-improvements, Property 26: Payload coercion**
    - **Validates: Requirements 14.14**

  - [x]* 3.18 Write unit tests for the scope helpers
    - File: `tests/unit/workflow-scope.test.ts`. `skipListOf`, `findSkippedPathBinding`, `startUrlOf`, `storageStateOf`, `originOf`, `validateWorkflowScopes`, `usesWorkflowCall`. Tag the path-binding cases: **Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused (helper part)**.
    - **Validates: Requirements 3.7, 10.10, 10.11**

- [x] 4. Checkpoint - seam done
  - Run `npx tsc --noEmit`, the G0 tests and `npx vitest run tests/unit/regression-fixture.test.ts`. The regression test passes with only the allowed differences; G0 reports any difference.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. G-A replay runtime
  - Owns: `src/replay/runtime/http-replay.ts`, `src/replay/runtime/step-plan.ts`, `src/replay/runtime/web-steps.ts`, `src/replay/runtime/row-resolver.ts`, `tests/fixtures/web/check-radio.html` (new), `tests/unit/replay-runtime-compat.test.ts` (new), `tests/unit/http-skip.test.ts` (new), `tests/property/http-skip-request.property.test.ts` (new), `tests/property/http-skip-path.property.test.ts` (new), `tests/property/row-resolution.property.test.ts`, `tests/property/check-idempotence.property.test.ts` (new), `tests/property/check-preparatory.property.test.ts` (new), `tests/integration/check-radio-replay.test.ts` (new), `tests/integration/row-binding.test.ts`, `tests/integration/http-replay-e2e.test.ts`, `tests/integration/http-mixed-workflow.test.ts`.
  - Every file stays standalone and imports nothing from `src/`.

  - [x] 5.1 Implement skipped Variables in HTTP replay and the row fallback
    - `http-replay.ts` (F1): `buildRequest(recipe, variables, env, skipped?)` drops whole query keys and headers that mention a skipped placeholder, uses a `REMOVE` sentinel in `fillBody` (object property, array item with order kept, form field, root body, no `content-type` added), and throws `HttpReplayError('invalid', ...)` naming the Variable for a skipped path placeholder. `withRecordedDefaults(steps, args, skipped?)` does not restore a skipped name. `runHttpStep` takes `options.skipped`. Entries bound to a `secretRef` are never touched. With an empty or absent set the request equals today's.
    - `http-replay.ts` (F3): `PREPARATORY` gains `check`.
    - `row-resolver.ts` (F1): `buildRowLocator` falls back to `binding.key.text` when `binding.variable` has no value and `key.text` is non-empty, else throws `ROW_VARIABLE_MISSING` as today.
    - _Requirements: 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 7.9_

  - [x] 5.2 Implement the check action, radio by value and heal exclusion
    - `web-steps.ts` (F3): `checkTarget`, `needsClick`, `NonRetryableAction`, and `act` case `check` (read state from `checked`, or `aria-checked === 'true'` for role checkbox, switch and menuitemcheckbox; click at most once when the state differs; poll every 50 ms until the target or the step timeout; no click when already at target; a disabled control fails the step with the standard failure naming index and action `check`).
    - `step-plan.ts` (F3): `healEligible` is false for `check` in every mode; `OPTION_ROLES` gains `radio` so a radio is located by role and exact accessible name. A radio with no Variable replays as today.
    - Create `tests/fixtures/web/check-radio.html` (checkbox, role switch, role checkbox, radio group, disabled control, re-rendering control).
    - _Requirements: 7.4, 7.5, 7.6, 7.8, 7.10, 7.12, 8.7, 8.8, 8.11, 8.12, 8.13_

  - [x] 5.3 Write the compatibility test for the runtime (required)
    - File: `tests/unit/replay-runtime-compat.test.ts`. With no skipped set, `buildRequest` and `withRecordedDefaults` equal the old results for the regression recipe; a `click` on a checkbox and a radio click without a Variable plan and locate as before; a row binding with a Variable behaves as before. Run `tests/integration/row-binding.test.ts`, `http-replay-e2e.test.ts` and `http-mixed-workflow.test.ts` and require them to pass.
    - _Requirements: 3.5, 7.11, 8.12, 2.11_

  - [x]* 5.4 Write property test for HTTP requests with skipped Variables
    - File: `tests/property/http-skip-request.property.test.ts` (200 runs).
    - **Feature: user-journey-improvements, Property 7: HTTP request with skipped Variables**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.9**

  - [x]* 5.5 Write property test for a skipped Variable in a path (runtime part)
    - File: `tests/property/http-skip-path.property.test.ts`. The compile and Studio parts are tested in 6.6 and 11.4.
    - **Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused**
    - **Validates: Requirements 3.7, 3.8**

  - [x]* 5.6 Write property test for row selection
    - File: `tests/property/row-resolution.property.test.ts`.
    - **Feature: user-journey-improvements, Property 6: Row selection by an omitted Variable**
    - **Validates: Requirements 2.10, 2.11**

  - [x]* 5.7 Write property test for check idempotence
    - File: `tests/property/check-idempotence.property.test.ts`, with a fake control (no Playwright).
    - **Feature: user-journey-improvements, Property 14: A check step is idempotent**
    - **Validates: Requirements 7.4, 7.5, 7.8, 7.12**

  - [x]* 5.8 Write property test for check steps in the plan
    - File: `tests/property/check-preparatory.property.test.ts`.
    - **Feature: user-journey-improvements, Property 15: Check steps are preparatory**
    - **Validates: Requirements 7.9, 7.10**

  - [x]* 5.9 Write unit tests for HTTP skipping
    - File: `tests/unit/http-skip.test.ts`. Query, body (object, array, form, root) and header, each with `skip` removing the entry and `useRecorded` keeping it; mixed text (`Bearer {{token}}`) removed whole; a path placeholder of a skipped Variable refused with `invalid` and no secret in the text; the planning of a `check` step as preparatory.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 7.9_

  - [x]* 5.10 Write the browser test for check and radio replay
    - File: `tests/integration/check-radio-replay.test.ts` on `check-radio.html`: already-checked control gets no click; a control that never reaches the state fails with the step failure; a disabled control fails; a `check` step is not healed; a radio chosen by name, an already selected radio, a missing radio name fails without clicking another.
    - _Requirements: 7.4, 7.5, 7.6, 7.10, 8.7, 8.8, 8.13_

- [x] 6. G-B generator and compiler
  - Owns: `src/compiler/mcp-generator.ts`, `src/compiler/compiler.ts`, `src/compiler/tool-description.ts`, `src/suggest/apply.ts`, `src/schema/schema-inferencer.ts` and `src/compiler/zod-translator.ts` (only if Property 4 finds a defect), `tests/fixtures/web/optional-fields.html` (new), `tests/unit/generated-compat.test.ts` (new), `tests/unit/generated-call-block.test.ts` (new), `tests/unit/tool-description-lead.test.ts` (new), `tests/unit/generated-no-src-import.test.ts`, every existing compiler, generator or sandbox test that asserts generated text or a copy list, `tests/property/skip-list-embedded.property.test.ts` (new), `tests/property/workflow-scope-compile.property.test.ts` (new), `tests/property/skip-in-path-compile.property.test.ts` (new), `tests/property/schema-independence.property.test.ts` (new), `tests/property/radio-schema.property.test.ts` (new), `tests/integration/optional-skip-replay.test.ts` (new).

  - [x] 6.1 Generate the call block, Skip_List, per-workflow start page and login
    - `mcp-generator.ts`: `withCall = usesWorkflowCall(set)` once. When false every emitted line equals today's. When true: `replay.ts` imports `planSkips`, exports `WorkflowCall`, `replay(steps, args, final, limits, overrides, call)` computes `skippedSet` once and returns `skippedSteps` only when not empty; every web, HTTP and terminal loop tests `skippedSet.has(index)` before `settle`, the plan branch and `waitFor`; `resolveStorageState(call)` (`null` ignores `DAEMONIZE_STORAGE_STATE` too); start URL and `rebaseOrigin` use `call.startUrl ?? START_URL`; HTTP mode passes `skipped` to `withRecordedDefaults` and `runHttpStep`. `mcp-server.ts` embeds `{ skip, startUrl?, storageState? }` (names, a URL, a path or `null`, never a value). `docker-replay.ts` takes the `call`, sends it on stdin, and the container entry passes `request.call ?? {}`. `generateSandboxFiles` adds `omission.js` to `copy` for both targets.
    - `compiler.ts`: reads and writes `omission.ts` and `omission.js`; before any file, `validateWorkflowScopes` (10.10, 10.11) and, with `--http auto`, the skip-in-path refusal with `SKIP_IN_PATH_MESSAGE` naming workflow and Variable.
    - Order: F1 (Skip_List, omission copy, path check), snapshot, then F4 (per-workflow start page and login, scope validation), snapshot.
    - _Requirements: 2.12, 2.13, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.8, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11_

  - [x] 6.2 Use the user description in the tool text and keep it over suggestions
    - `tool-description.ts`: lead is `workflow.description.trim()` when not empty, else the label. `apply.ts` `applyEntry` skips an accepted suggestion for a workflow whose trimmed `description` is non-empty and records a `skipped` line. Touch `schema-inferencer.ts` or `zod-translator.ts` only if Property 4 finds a defect.
    - _Requirements: 1.7, 1.8, 1.9, 1.10_

  - [x] 6.3 Write the compatibility test for generated code (required)
    - File: `tests/unit/generated-compat.test.ts`. For a set with no Skip_List Variable, no workflow `startUrl` and no workflow `storageState`: the generated `mcp-server.ts`, `replay.ts` and `docker-replay.ts` contain no `call` parameter and equal the regression snapshot text; the sandbox copy list differs only by `omission.js`; a set with `click` on a checkbox and no `check` step compiles to the same code. Update every existing compiler, generator and sandbox test that asserts generated text or a copy list, and keep `generated-no-src-import.test.ts` passing.
    - _Requirements: 4.2, 7.11, 10.9, 24.3_

  - [x]* 6.4 Write property test for the embedded Skip_List
    - File: `tests/property/skip-list-embedded.property.test.ts`.
    - **Feature: user-journey-improvements, Property 9: The Skip_List embedded in generated code**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.8, 10.9**

  - [x]* 6.5 Write property test for per-workflow start page and login
    - File: `tests/property/workflow-scope-compile.property.test.ts`.
    - **Feature: user-journey-improvements, Property 19: The Compiler resolves start page and login per workflow**
    - **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 10.11**

  - [x]* 6.6 Write property test for a skipped Variable in a path (compile part)
    - File: `tests/property/skip-in-path-compile.property.test.ts`: `--http auto` refuses with the same message and writes no file.
    - **Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused**
    - **Validates: Requirements 3.7**

  - [x]* 6.7 Write property test for schema independence
    - File: `tests/property/schema-independence.property.test.ts`.
    - **Feature: user-journey-improvements, Property 4: The input schema ignores whenOmitted and description**
    - **Validates: Requirements 1.9, 1.10, 8.14**

  - [x]* 6.8 Write property test for the radio input schema (schema part)
    - File: `tests/property/radio-schema.property.test.ts`. The group validation part is tested in 7.8.
    - **Feature: user-journey-improvements, Property 16: Radio group validity (schema part)**
    - **Validates: Requirements 8.14**

  - [x]* 6.9 Write unit tests for the tool description lead
    - File: `tests/unit/tool-description-lead.test.ts`. Trimmed description as lead, empty or whitespace description gives today's lead, accepted suggestion skipped for a workflow with a user description. Tag: **Feature: user-journey-improvements, Property 3: Description lead and limits (lead part)**.
    - **Validates: Requirements 1.7, 1.8**

  - [x]* 6.10 Write unit tests for the generated call block
    - File: `tests/unit/generated-call-block.test.ts`. Skip_List names only, once each in workflow order; start page and login per workflow; `storageState: null`; terminal target; container request carries `call`; a workflow `startUrl` on another origin or in a terminal set stops before any file is written.
    - _Requirements: 4.1, 4.3, 4.5, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 10.11_

  - [x]* 6.11 Write the replay test for optional Variables through generated code
    - File: `tests/integration/optional-skip-replay.test.ts` on `tests/fixtures/web/optional-fields.html` (new): `useRecorded` and `skip` for a page step, a row binding and a terminal step; `skippedSteps` present only when a step was skipped; supplied `''`, `0`, `false` are used; a `secretRef` step is never skipped; host and container give the same `skippedSteps` when Docker tests are enabled.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.12, 2.13_

- [x] 7. G-C page recorder
  - Owns: `src/recorder/capture-script.ts`, `src/recorder/live-recorder.ts`, `src/recorder/workflow-recorder.ts`, `src/recorder/variable-settings.ts` (new), `tests/fixtures/web/recorder-controls.html` (new), `tests/unit/recorder-compat.test.ts` (new), `tests/unit/live-recorder-requests.test.ts` (new), `tests/unit/capture-panel-logic.test.ts` (new), `tests/property/variable-request.property.test.ts` (new), `tests/property/offer-model.property.test.ts` (new), `tests/property/fields-answer.property.test.ts` (new), `tests/property/radio-group.property.test.ts` (new), `tests/property/file-counter.property.test.ts` (new), `tests/property/finish-scope-live.property.test.ts` (new), `tests/integration/recorder-variables.test.ts` (new), `tests/integration/recorder-check-radio-file.test.ts` (new), `tests/integration/live-recorder.test.ts`, `tests/integration/recording-panel.test.ts`, `tests/integration/record-studio-hooks.test.ts`, `tests/unit/*capture*`, `tests/unit/*live-recorder*`, `tests/unit/*workflow-recorder*`.
  - `capture-script.ts` is a template string: no backtick and no `${` may appear inside it.

  - [x] 7.1 Add the validators and the recorder edits
    - `variable-settings.ts`: `validateVariableSettings`, `validateEdit`, `validateRadioGroup`, `safeFieldLabel` (never contains `step.value`, at most 200 characters), with Plain_Language messages. A request with none of the three settings yields `settings: {}`.
    - `workflow-recorder.ts`: `markChoiceVariable`, `editVariable` (one atomic step through `renameVariable` and `retypePayloads`), `variableList`. `markVariable` and `defineVariable` keep their signatures and build the same Variable as today without the new settings.
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.10, 6.10, 6.11, 6.15, 7.3, 8.3, 8.5, 8.6_

  - [x] 7.2 Add the bindings, fields answer, scope and file count to the Live_Recorder
    - `live-recorder.ts`: `__daemonizeMarkVariable` with the new validation and coercion, new `__daemonizeEditVariable`, `{ type: 'fields' }` (`panelFields()`: type, select, check and radio-click steps without `secretRef`, no password, one-time-code or file field, last 100 ascending, no value), `{ type: 'file', fieldId }` (distinct (frame, field) count, no step, no Variable, `summary.files`), `finishScope` kept only for `intent: 'kiro'` with exactly `'global'` or `'project'`, `LiveRecorderOptions.kiroHomeExists` and `PanelState.kiroHomeExists`. A refused request returns before any mutation.
    - Order: F2 (variables, fields), F3 (check, radio, file), F7 (scope).
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.9, 6.3, 6.4, 6.5, 6.6, 6.10, 6.11, 7.3, 8.3, 8.5, 8.6, 9.4, 9.5, 9.6, 19.3, 19.4, 19.5, 19.6, 19.7, 19.13_

  - [x] 7.3 Build the panel in the capture script
    - `capture-script.ts` (F2): "Make variable" box (name, type text/number/true or false, Optional checkbox, omitted choice with skip preselected; accessible names, Tab order, Enter confirms; an `{ ok: false }` answer keeps the box open with the error beside the name); `createOfferModel` with `earlier` (at most 100, unique by `fieldId`); Field_Drawer with "Review fields", edit form sending only changed settings, and the open-edit guard on "Save and add to Kiro".
    - `capture-script.ts` (F3): a click on a checkbox, `role=checkbox` or `role=switch` records `actionType: 'check'` with `"true"`/`"false"` read from the state after the click; a radio click without an ancestor row sends `event.radio` (`RadioInfo`) and offers "Make variable" without the type choice; a `change` on `input[type=file]` shows the status text within 500 ms for at least 5 seconds with `role=status`, sends only `{ type: 'file', fieldId }`, and contains no file detail.
    - `capture-script.ts` (F7): End_Sheet file-count line when `summary.files >= 1`; a native `radiogroup` "Where to add the tool" ("All my projects" preselected, "Only this project") when `kiroHomeExists`, else the static text "Only this project"; `finishWith('kiro')` sends `{ intent: 'kiro', scope }`, `save` and `test` send `{ intent }` only.
    - Create `tests/fixtures/web/recorder-controls.html`.
    - _Requirements: 5.1, 5.2, 5.3, 5.9, 5.11, 6.1, 6.2, 6.7, 6.8, 6.9, 6.12, 7.1, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4, 9.7, 19.1, 19.2, 19.3, 19.4, 19.14_

  - [x] 7.4 Write the compatibility test for the recorder (required)
    - File: `tests/unit/recorder-compat.test.ts`. A request with none of `type`, `optional`, `whenOmitted` builds the same Variable as before and writes the same Workflow_File content; a recording that uses no Field_Drawer, no edit binding and no new terminal question carries no `optional` and no `whenOmitted`; a `click` on a plain button stays a `click`. Update the existing live-recorder, recording-panel and capture tests to the new panel shape.
    - _Requirements: 5.8, 6.15, 7.11_

  - [x]* 7.5 Write property test for variable requests
    - File: `tests/property/variable-request.property.test.ts` (200 runs).
    - **Feature: user-journey-improvements, Property 10: Variable requests are validated before any change**
    - **Validates: Requirements 5.4, 5.5, 5.6, 5.7, 5.8, 5.10, 6.10, 6.11, 6.15, 7.3**

  - [x]* 7.6 Write property test for the offer model
    - File: `tests/property/offer-model.property.test.ts`.
    - **Feature: user-journey-improvements, Property 11: The offer model keeps earlier fields**
    - **Validates: Requirements 6.1, 6.2**

  - [x]* 7.7 Write property test for the fields answer
    - File: `tests/property/fields-answer.property.test.ts`.
    - **Feature: user-journey-improvements, Property 12: The fields answer reveals no value**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

  - [x]* 7.8 Write property test for radio group validity
    - File: `tests/property/radio-group.property.test.ts`.
    - **Feature: user-journey-improvements, Property 16: Radio group validity**
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.14**

  - [x]* 7.9 Write property test for the file counter
    - File: `tests/property/file-counter.property.test.ts`.
    - **Feature: user-journey-improvements, Property 17: File fields are counted, not recorded**
    - **Validates: Requirements 9.5, 9.6**

  - [x]* 7.10 Write property test for the finish scope (recorder part)
    - File: `tests/property/finish-scope-live.property.test.ts`. The manager part is tested in 9.5.
    - **Feature: user-journey-improvements, Property 31: Install scope resolution (recorder part)**
    - **Validates: Requirements 19.3, 19.4, 19.5, 19.6, 19.7**

  - [x]* 7.11 Write unit tests for the Live_Recorder requests and edits
    - File: `tests/unit/live-recorder-requests.test.ts`. Success and refusal for each rule of 5.4 to 5.7, the edit of 6.10 and 6.11 (unknown name, duplicate, length 64 accepted and 65 refused, bad pattern), check and radio Variables (7.3, 8.3, 8.5, 8.6), the fields answer limits, the file signal, and `finishScope` handling.
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 6.3, 6.6, 6.10, 6.11, 7.3, 8.3, 8.5, 8.6, 9.5, 9.6, 19.5, 19.6_

  - [x]* 7.12 Write unit tests for the panel logic
    - File: `tests/unit/capture-panel-logic.test.ts`. `createOfferModel` for `input`, `typed`, `route`, `clear`; the Make-variable request shape for each control state; the file notice text (no file detail); check value read (`aria-checked` `false`, `mixed`, absent give `"false"`); radio offer rules; the scope radiogroup markup and keyboard behaviour.
    - _Requirements: 5.3, 5.11, 6.1, 6.2, 7.1, 8.1, 8.2, 9.1, 9.2, 9.3, 19.1, 19.2, 19.14_

  - [x]* 7.13 Write the browser test for recorder variables
    - File: `tests/integration/recorder-variables.test.ts` on `recorder-controls.html`: make an earlier field a Variable after typing in another, edit and rename in the drawer, keep the box open on a refused request, the open-edit guard, keyboard-only completion.
    - _Requirements: 5.1, 5.2, 5.9, 5.11, 6.1, 6.7, 6.8, 6.9, 6.12_

  - [x]* 7.14 Write the browser test for check, radio and file capture
    - File: `tests/integration/recorder-check-radio-file.test.ts`: a checkbox and a switch become `check` steps, a radio group becomes an `enum` Variable, a refused group keeps the click, a file choice records no step and shows the notice and the End_Sheet count.
    - _Requirements: 7.1, 7.3, 8.1, 8.3, 8.5, 8.6, 9.1, 9.5, 9.7_

- [x] 8. G-D merge, save and record preflight
  - Owns: `src/workflow/merge.ts`, `src/cli/commands/save-workflow.ts`, `src/cli/commands/record.ts`, `tests/unit/merge-compat.test.ts` (new), `tests/unit/record-origin-preflight.test.ts` (new), `tests/unit/save-workflow*.test.ts`, `tests/property/merge-invariant.property.test.ts` (new), `tests/property/save-stamping.property.test.ts` (new), `tests/integration/record-recovery.test.ts`, `tests/integration/navigation-finalize.test.ts`.

  - [x] 8.1 Keep the base target when a base workflow survives
    - `merge.ts`: `keepsBase = base.workflows.some(w => !replaced.has(w.id))`; when true `targetName`, `startUrl`, `storageState` come from the base (absent stays absent), else from the new set as today. A replaced workflow keeps its position, new ones are appended, neither input is mutated.
    - _Requirements: 11.1, 11.2, 11.8, 11.9, 11.10, 11.12_

  - [x] 8.2 Check the origin and stamp the new workflow on save
    - `save-workflow.ts`: after loading `existing`, for web targets with at least one base workflow `checkSameOrigin` runs first and a failure throws `saveOriginMessage(...)` before any write (RC-3: the origin check wins on replace). When a base workflow survives, stamp `startUrl` only when it differs from the base, `storageState` equal to the recording's value when it differs, `null` when the recording has none and the base has one. Then merge. When no base workflow survives nothing is stamped.
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x] 8.3 Refuse a second origin before `daemonize record` opens a browser
    - `record.ts`: before launching a browser, tolerant read of `options.out`; unreadable or unparsable throws the `LOAD_UNREADABLE` message; `checkSameOrigin(existing, options.url)` failure throws `check.message`; same origin, no file or no workflow proceed as before. `RecordOptions.kiroHomeExists` is passed to `LiveRecorder`. No other CLI command, flag or default output changes.
    - _Requirements: 12.9, 12.10, 12.12, 19.13_

  - [x]* 8.4 Write property test for the merge invariant
    - File: `tests/property/merge-invariant.property.test.ts` (200 runs).
    - **Feature: user-journey-improvements, Property 20: Merging keeps earlier workflows**
    - **Validates: Requirements 11.1, 11.2, 11.8, 11.9, 11.10, 11.12**

  - [x]* 8.5 Write property test for save stamping
    - File: `tests/property/save-stamping.property.test.ts`.
    - **Feature: user-journey-improvements, Property 21: Saving stamps only what differs**
    - **Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7**

  - [x]* 8.6 Write unit tests for the record origin preflight
    - File: `tests/unit/record-origin-preflight.test.ts`. Another origin fails before any browser with the message, same origin (including a default port) proceeds, no file or an empty file proceeds, an unreadable file fails with the standard message, the Workflow_File is unchanged.
    - _Requirements: 12.9, 12.10, 12.12_

  - [x] 8.7 Write the compatibility test for merge and save (required)
    - File: `tests/unit/merge-compat.test.ts`. Merging a recording with the same `startUrl` and `storageState` into a file without per-workflow fields writes old workflows byte-identical to their serialized form before (11.11) and stamps nothing. Keep the existing `save-workflow*`, `record-recovery` and `navigation-finalize` tests passing, updated where they asserted the old top-level overwrite.
    - _Requirements: 11.7, 11.11_

- [x] 9. G-E Studio recording
  - Owns: `src/studio/routes/record.ts`, `src/studio/messages/record.ts`, `src/studio/install-scope.ts` (new), `src/studio/recording-manager.ts`, `src/studio/ui/js/views/new-action.js`, `src/studio/ui/js/copy-record.js`, `src/studio/ui/css/record.css`, `src/studio/ui/js/views/record-status.js`, `tests/unit/record-route-compat.test.ts` (new), `tests/unit/record-route-origin.test.ts` (new), `tests/unit/recording-manager-scope.test.ts` (new), `tests/unit/new-action-origin.test.ts` (new), `tests/unit/record-status-view.test.ts` (new), `tests/property/install-scope.property.test.ts` (new), `tests/property/missing-secrets.property.test.ts` (new), `tests/integration/studio-record.test.ts`, `tests/property/studio-recording.property.test.ts`.

  - [x] 9.1 Refuse a second origin in the record route and add the scope helpers
    - `routes/record.ts`: `POST /api/record/start` becomes `writes: false`. Handler order: unexpected field, name, url, `reuseSession` (400), then `ctx.loadSet()` (failure 409 `{ error: LOAD_UNREADABLE, field: 'url' }`), `checkSameOrigin` (409 `{ error, field: 'url' }`), then the sample-mode 409 as the dispatcher did. The same check runs against the sample set in sample mode. Same origin and the no-file cases are accepted as before. `messages/record.ts` carries the message text (no file path).
    - `install-scope.ts`: `resolveInstallScope(finishScope, kiroHomeExistsNow)` and `normalizeSecretNames` (regex `^[A-Z][A-Z0-9_]*$`, unique, sorted by code point, at most 100).
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.11, 12.13, 19.6, 19.8, 19.9, 20.1, 20.2, 20.3_

  - [x] 9.2 Update the new-action page and the record status view
    - `new-action.js`: 300 ms after the last keystroke compare `new URL(value).origin` with `new URL(overview.targets[0].start).origin` when `targets[0].workflows >= 1`; show the message in a `role="alert"` element linked by `aria-describedby`, disable the start button while shown, remove both when the address is empty, invalid or the same origin.
    - `record-status.js`: scroll rule (once, `block: 'start'`, `behavior` from `prefers-reduced-motion`; `outcome` container when `#kiro-result` exists, else `#connect-card`; no scroll for another intent; a missing target makes no call); a `role="alert"` block before `connectCard()` when `kiro.added` and `kiro.missingSecrets.length > 0`, listing names and one keyboard-reachable link `href('credentials')`; an absent `missingSecrets` is `[]`.
    - `copy-record.js` holds the new texts in Plain_Language. `record.css`: `.record-outcome { scroll-margin-top: <header height + 8px>; padding-bottom: 96px; }`, no literal colour outside `:root`.
    - _Requirements: 12.6, 12.7, 12.8, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.9_

  - [x] 9.3 Add the scope choice and the credentials fields to the Recording_Manager
    - `recording-manager.ts`: `RecordCallOptions.kiroHomeExists`, `LiveLike.finishScope`; call `power.info()` at the start of `run()` (a failure counts as `false`) and pass `kiroHomeExists` to `record()`; read `finishScope` in `takeSnapshot` like `finishIntent`; in `addToKiro()` use `resolveInstallScope(finishScope, info.kiroHomeExists)` for both `power.preview` and `power.install`; on success set `kiro = { added: true, message, scope, missingSecrets, requiredSecrets }` from the normalized install answer; on failure `{ added: false, message }` with no scope and no arrays.
    - _Requirements: 19.6, 19.7, 19.8, 19.9, 19.10, 19.11, 19.12, 19.13, 19.15, 20.1, 20.2, 20.3, 20.4, 20.5, 20.12_

  - [x] 9.4 Write the compatibility test for the record route and status (required)
    - File: `tests/unit/record-route-compat.test.ts`. Same origin (different path, query, fragment), no file, a file with no workflow and a set `startUrl` that is absent or invalid are accepted exactly as before; an old status without `kiro.missingSecrets` renders no credentials block; no change to `daemonize.workflows.json` is written. Keep `tests/integration/studio-record.test.ts` and `tests/property/studio-recording.property.test.ts` passing, updated for `writes: false` on the start route.
    - _Requirements: 12.3, 12.4, 20.10, 22.9_

  - [x]* 9.5 Write property test for install scope resolution (manager part)
    - File: `tests/property/install-scope.property.test.ts`.
    - **Feature: user-journey-improvements, Property 31: Install scope resolution**
    - **Validates: Requirements 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9**

  - [x]* 9.6 Write property test for the missing secrets fields
    - File: `tests/property/missing-secrets.property.test.ts`.
    - **Feature: user-journey-improvements, Property 32: Missing secrets are names, sorted and bounded**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.12**

  - [x]* 9.7 Write unit tests for the record route origin refusal
    - File: `tests/unit/record-route-origin.test.ts`. Another origin gives 409 with `field: 'url'` and the message of 12.2; a default port equals no port; unreadable file gives `LOAD_UNREADABLE`; sample mode gives the same 409 for another origin and `SAMPLE_MODE` otherwise; no recording starts and the file is unchanged.
    - _Requirements: 12.1, 12.2, 12.3, 12.11, 12.13_

  - [x]* 9.8 Write unit tests for the scope and credentials fields
    - File: `tests/unit/recording-manager-scope.test.ts`. `global` and `project` used for preview and install, `global` falls back to `project` when the home folder is gone, `power.info` failure at start gives `false`, `kiro.scope` absent on failure, arrays normalized, no secret value in the status.
    - _Requirements: 19.8, 19.9, 19.10, 19.11, 19.12, 19.13, 20.1, 20.4, 20.5_

  - [x]* 9.9 Write unit tests for the new-action origin message
    - File: `tests/unit/new-action-origin.test.ts`. Message within 300 ms, button disabled and enabled, `role="alert"` and `aria-describedby`.
    - _Requirements: 12.6, 12.7, 12.8_

  - [x]* 9.10 Write unit tests for the record status view
    - File: `tests/unit/record-status-view.test.ts`. One `scrollIntoView` call with `block: 'start'` on `#connect-card` or on the outcome container, never `block: 'center'`, reduced-motion behaviour, no call for another intent, `scroll-margin-top` at least the measured header height, bottom padding, the credentials alert with names and link, no alert when `missingSecrets` is empty, absent or the install failed.
    - _Requirements: 20.6, 20.7, 20.8, 20.9, 20.10, 22.1, 22.2, 22.3, 22.4, 22.6, 22.7_

- [x] 10. G-F terminal recorder
  - Owns: `src/recorder/terminal-recorder.ts`, `src/cli/commands/record-tui.ts` (only if the prompt flow needs it), `tests/unit/terminal-recorder-compat.test.ts` (new), `tests/unit/terminal-recorder-variables.test.ts` (new), `tests/integration/record-tui.test.ts`, `tests/integration/tui-e2e.test.ts`, `tests/unit/*terminal-recorder*`.

  - [x] 10.1 Ask optional, type and omitted behavior after the name
    - After a valid name ask one key at a time: `optional? (y/n, Enter = n)`, `type? (s/n/b, Enter = s)`, and only for an optional Variable the omitted behavior (`s` skip, `r` use recorded, Enter = s). An answer outside the offered keys repeats the same question and changes nothing. The Variable is created with `type` always and `optional: true` and `whenOmitted` only when optional. A number or boolean type whose typed text does not convert answers a Plain_Language message and asks the type again.
    - _Requirements: 6.13, 6.14, 6.15_

  - [x] 10.2 Write the compatibility test for the terminal recorder (required)
    - File: `tests/unit/terminal-recorder-compat.test.ts`. Pressing Enter at each question builds the Variable the recorder built before (no `optional`, no `whenOmitted`); existing `tests/integration/record-tui.test.ts`, `tui-e2e.test.ts` and `tests/unit/*terminal-recorder*` pass, updated for the new questions.
    - _Requirements: 6.15_

  - [x]* 10.3 Write unit tests for the terminal questions
    - File: `tests/unit/terminal-recorder-variables.test.ts`. Defaults on Enter, `y` then each omitted key, a wrong key repeats the question without creating a Variable, number and boolean conversion refusal.
    - _Requirements: 6.13, 6.14_

- [x] 11. G-H Studio workflow editor
  - Owns: `src/studio/model.ts`, `src/studio/workflow-editor.ts` (new), `src/studio/routes/workflows.ts`, `src/studio/messages/workflows.ts`, `src/studio/ui/js/views/workflows.js`, `src/studio/ui/js/copy-editor.js`, `src/studio/ui/css/editor.css`, `tests/unit/workflow-editor-compat.test.ts` (new), `tests/unit/workflow-routes.test.ts` (new), `tests/unit/workflows-view-editor.test.ts` (new), `tests/property/workflow-update-invalid.property.test.ts` (new), `tests/property/workflow-update-valid.property.test.ts` (new), `tests/property/workflow-update-roundtrip.property.test.ts` (new), `tests/property/workflow-delete.property.test.ts` (new), `tests/property/workflow-view-variables.property.test.ts` (new), `tests/integration/studio-ui.test.ts` (where it concerns the Workflows view).

  - [x] 11.1 Implement the editor, the two routes and the workflow view
    - `workflow-editor.ts`: `applyUpdate` (clone, validate everything in the order of the design, then apply; RC-2: `newName` at most 60 characters here, recorded names up to 64 stay editable for other settings; RC-4: `optional: false` removes `optional` and `whenOmitted`), `applyDelete`, `referencedAssets`, `writeWorkflowFileAtomic` (`serializeWorkflowSet`, temporary file `<file>.tmp-<pid>-<random>` with flag `wx`, `rename`, `unlink` in `finally`, in-process promise lock), `cleanAssets` (only regular non-symlink files matching `ASSET_NAME` that no remaining workflow references).
    - `routes/workflows.ts`: `POST /api/workflows/update` and `POST /api/workflows/delete`, `remote: 'blocked'`, sample mode 409 `SAMPLE_MODE`, running recording or compile 409, unreadable file 409 `LOAD_UNREADABLE`, 404 for an unknown id, 400 with `field` and `index`, `GET` on delete answers 405 with `Allow: POST`, recompile through `compiler.tryStart()` (`started`, `busy`, `not-needed`), delete answers `{ ok: true, remaining, recompile, cleanup? }` and 500 when the atomic write fails. `messages/workflows.ts` carries the Plain_Language texts. Every answer passes through `redactForStudio`.
    - `model.ts`: Variables carry `optional` and, only when optional, `whenOmitted` (`useRecorded` when the file has none); `startPage` is `displayUrl(workflow.startUrl)` only when it differs from the set `startUrl`.
    - Order: F4 (view `startPage`), snapshot, then F5 (editor and routes), snapshot.
    - _Requirements: 10.12, 10.13, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17, 13.18, 13.19, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15, 14.17, 14.18, 14.19, 14.20, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 15.12, 15.13, 15.14, 15.15, 16.15_

  - [x] 11.2 Add the editor controls to the Workflows view
    - `workflows.js`: the start page line (path only, no query or fragment) only when it differs; three `button`s "Rename and describe", "Edit inputs", "Delete this action" (not rendered in sample mode or the static demo); the forms of 16.2 to 16.5 sending only what changed; errors in `role=alert` beside the submitted control keeping the entered values; the delete dialog through `openDialog` with focus on "Cancel", focus trap, Escape and "Cancel" returning focus to the opener, one pending delete request, 404 and 409 kept in the dialog, 5xx or no answer showing the "not saved" message; after a 200 re-render, `announce`, and the recompile state when `recompile === 'started'`.
    - `copy-editor.js` holds the Plain_Language texts; `editor.css` has no literal colour outside `:root`.
    - _Requirements: 10.12, 10.13, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14, 16.16_

  - [x] 11.3 Write the compatibility test for the editor (required)
    - File: `tests/unit/workflow-editor-compat.test.ts`. An update on a file recorded before this change writes only the changed fields and the result loads with the schema; a delete keeps every other workflow and every unknown top-level field; an invalid or failing write leaves the original file and no temporary file; the last workflow deleted leaves a loadable file with `workflows: []`.
    - _Requirements: 13.10, 13.12, 14.19, 14.20, 15.5, 15.10_

  - [x]* 11.4 Write property test for invalid updates
    - File: `tests/property/workflow-update-invalid.property.test.ts` (200 runs). Also covers the Studio refusal of a skip Variable in a path (14.15, Property 8 Studio part).
    - **Feature: user-journey-improvements, Property 23: An invalid update changes nothing**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.8, 13.12, 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.8, 14.9, 14.12, 14.14, 14.15, 14.18**

  - [x]* 11.5 Write property test for valid updates
    - File: `tests/property/workflow-update-valid.property.test.ts`.
    - **Feature: user-journey-improvements, Property 24: A valid update touches only what it names**
    - **Validates: Requirements 13.7, 13.9, 13.10, 14.6, 14.10, 14.11, 14.17, 14.19, 14.20**

  - [x]* 11.6 Write property test for update then inverse update
    - File: `tests/property/workflow-update-roundtrip.property.test.ts` (compares canonical forms, RC-4).
    - **Feature: user-journey-improvements, Property 27: Update then inverse update**
    - **Validates: Requirements 14.16**

  - [x]* 11.7 Write property test for delete
    - File: `tests/property/workflow-delete.property.test.ts`.
    - **Feature: user-journey-improvements, Property 28: Delete keeps the rest**
    - **Validates: Requirements 15.5, 15.7, 15.10, 15.11**

  - [x]* 11.8 Write property test for the workflow view of Variables
    - File: `tests/property/workflow-view-variables.property.test.ts`.
    - **Feature: user-journey-improvements, Property 29: The workflow view of Variables**
    - **Validates: Requirements 16.15**

  - [x]* 11.9 Write unit tests for the two routes
    - File: `tests/unit/workflow-routes.test.ts`. For each route: valid request, invalid request, unknown workflow (404), sample mode (409 `SAMPLE_MODE`), a plain secret refused with 400 and no value in the answer, a method other than `POST` refused (405 with `Allow`), recording or compile running (409), unreadable file (409), `recompile` values `started`, `not-needed`, `busy`, `cleanup: 'partial'`.
    - _Requirements: 13.2, 13.5, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17, 13.18, 13.19, 15.3, 15.4, 15.6, 15.12, 15.13, 15.14, 15.15_

  - [x]* 11.10 Write unit tests for the Workflows view controls
    - File: `tests/unit/workflows-view-editor.test.ts`. Controls present and absent (sample mode, static demo), forms prefilled, only changed Variables sent, `whenOmitted` hidden and unsent when Optional is cleared, `role=alert` errors keep values, dialog focus and Escape, one pending delete, start page line shown only when it differs, Plain_Language of every text.
    - _Requirements: 10.12, 10.13, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.8, 16.9, 16.10, 16.11, 16.13, 16.14, 16.16_

- [x] 12. G-I compile options
  - Owns: `src/studio/compile-runner.ts`, `src/studio/routes/compile.ts`, `src/studio/messages/compile.ts`, `src/studio/ui/js/views/recompile.js`, `src/studio/ui/js/views/overview.js`, `src/studio/ui/js/copy-compile.js`, `src/studio/ui/css/compile.css`, `tests/unit/compile-body-compat.test.ts` (new), `tests/unit/compile-runner-options.test.ts` (new), `tests/unit/advanced-options-ui.test.ts` (new), `tests/property/compile-body.property.test.ts` (new), `tests/property/studio-compile-power.property.test.ts`.

  - [x] 12.1 Validate the compile body and pass the options to the runner
    - `routes/compile.ts`: accept an empty body or only `http` (`'off'`/`'auto'`) and `healSupport` (boolean); an unexpected field gives 400 `UNEXPECTED_FIELD` with the first field name; an invalid value gives 400 with the field; validation precedes the busy check; a running compile gives 409 `COMPILE_BUSY` with the stored options unchanged; valid gives 202 `{ state: 'running' }` and `tryStart({ http: body.http ?? 'off', healSupport: body.healSupport ?? false })`.
    - `compile-runner.ts`: `stored` options (default `{ http: 'off', healSupport: false }`), replaced in `tryStart(options)` when the compile starts, `options()`, `runExclusive()` and an argument-less `tryStart()` use the stored options, `compile()` receives `{ http: stored.http, healSupport: stored.healSupport }`. Nothing is written to a file.
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.15, 21.16_

  - [x] 12.2 Add the Advanced options group
    - `recompile.js`: "Advanced options" before "Recompile" with the two checkboxes, both unchecked on load with no compiled output, the two explanatory sentences, and the body sent to `compileStart`. `overview.js`: set the checkboxes from `targets[0].modes` (`http === 'auto'`, `healSupport === true`), refresh the HTTP and Heal flags within 2 seconds of `done`, disable and uncheck both for a terminal target with the sentence that they apply to web actions, render neither in sample mode or the static demo. `copy-compile.js` texts in Plain_Language; `compile.css` with no literal colour outside `:root`.
    - _Requirements: 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.14_

  - [x] 12.3 Write the compatibility test for compile requests (required)
    - File: `tests/unit/compile-body-compat.test.ts`. A request with no body, or a body from an earlier Studio version, compiles with `{ http: 'off', healSupport: false }` and writes nothing to `daemonize.workflows.json`; stored options reset to the defaults for a new runner. Keep `tests/property/studio-compile-power.property.test.ts` passing.
    - _Requirements: 21.4, 21.7, 21.15_

  - [x]* 12.4 Write property test for the compile body
    - File: `tests/property/compile-body.property.test.ts`.
    - **Feature: user-journey-improvements, Property 33: Compile body validation**
    - **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 21.15, 21.16**

  - [x]* 12.5 Write unit tests for the compile runner options
    - File: `tests/unit/compile-runner-options.test.ts`. Stored options used by a recording compile and by the editor recompile, replaced only when a compile starts, unchanged after a 400 or 409, never written to disk.
    - _Requirements: 21.2, 21.3, 21.5, 21.6, 21.7_

  - [x]* 12.6 Write unit tests for the Advanced options UI
    - File: `tests/unit/advanced-options-ui.test.ts`. Defaults, sentences, checkboxes set from `modes`, terminal target disabled, flags refreshed within 2 seconds after `done`, group absent in sample mode and the static demo.
    - _Requirements: 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.14_

- [x] 13. G-J logo, tokens, documentation, requirements amendment
  - Owns: `src/studio/ui/favicon.svg`, `src/studio/ui/index.html` (logo markup), `src/studio/ui/app.css`, `docs/design-tokens.md`, `docs/studio.md`, `docs/replay-model.md`, root `README.md` (only if it lists commands), `.kiro/specs/user-journey-improvements/requirements.md`, `tests/unit/studio-logo.test.ts` (new), `tests/integration/studio-static.test.ts`, `tests/integration/studio-ui-features.test.ts`.
  - `index.html` belongs to G0 until G0 is done and to this group during the parallel phase.

  - [x] 13.1 Replace the logo
    - `favicon.svg`: `viewBox="0 0 24 24"`, a `<rect>` surface `#19161d`, one `<path d="M12 3 4 7v6c0 4.2 3.2 7.2 8 8 4.8-.8 8-3.8 8-8V7l-8-4Z">` as an outline (`fill="none"`, stroke `#9147ff`, RC-1), one check `<path d="m9 12 2 2 4-4">` stroke `#c59eff`; no `ellipse`, no `circle`, no ghost path, no `id` containing `ghost`.
    - `index.html`: one `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` with the same two paths and `stroke="var(--logo-shield)"`, `stroke="var(--logo-check)"`; remove the `ghost-body` gradient, the ellipses and any `url(#ghost-body)`; the `Daemonize <strong>Studio</strong>` text stays byte-identical.
    - `app.css`: `--logo-shield` and `--logo-check` in each `:root` block (pointing at `--kiro-purple-500` and `--kiro-purple-300`, darker tokens where a theme has a light header), `.logo` rules, no literal colour outside `:root`.
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.8, 23.9, 23.10_

  - [x] 13.2 Update the documentation
    - `docs/design-tokens.md`: replace the line "The Studio logo (a ghost) looks close to the Kiro one: decide whether to redraw it." with a line stating the Studio logo is an original shield with a check mark, and list `src/studio/ui/favicon.svg` and the inline logo among the uses of `kiro-extension/media/icon.svg`.
    - `docs/studio.md`: each new route (`POST /api/workflows/update`, `POST /api/workflows/delete`, the changed `POST /api/compile` body, the 409 of `POST /api/record/start`, the `kiro` fields of the record status) and each Advanced option. `docs/replay-model.md`: `whenOmitted` with its two values and the default, `skippedSteps`, the per-workflow start page and login, and the `check` step. `README.md` only if it lists commands. Checkpoint C reconciles the text with what the other groups delivered.
    - _Requirements: 23.7, 24.8_

  - [x] 13.3 Amend `requirements.md` so the spec matches the implementation
    - Requirement 23.5 and 23.6: the shield is an outline (stroke `#9147ff`, `fill="none"`) as in `kiro-extension/media/icon.svg`; the check mark keeps `#c59eff`; the 3:1 contrast is measured between each mark and its backdrop (the surface, or the header behind the inline logo), not between shield and check mark.
    - Introduction and Assumptions: change the reference "Requirement 8" for the Check_Step to "Requirement 7".
    - Touch nothing else. Run `validate_spec_format` on the file and fix errors.
    - _Requirements: 23.5, 23.6, 7.1_

  - [x]* 13.4 Write unit tests for the logo
    - File: `tests/unit/studio-logo.test.ts`. Favicon has exactly one shield path equal to the path of `kiro-extension/media/icon.svg` and one check path, no `ellipse` or `circle`, no ghost path or id; the inline logo has class `logo`, `aria-hidden="true"`, `focusable="false"`, only `var(--…)` paints, no `ghost-body`, no `<ellipse>`; the brand text is byte-identical; the contrast of each mark against its backdrop (surface and header, both themes) is at least 3:1. Update `studio-static.test.ts` and `studio-ui-features.test.ts` where they assert the old markup.
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.8, 23.9_

- [x] 14. G-K Kiro extension
  - Owns: everything under `kiro-extension/` (`src/core/ports.ts`, `src/core/studio-url.ts`, `src/core/studio-api.ts`, `src/core/strings.ts`, `src/core/with-timeout.ts` (new), `src/ui/commands/studio.ts`, `src/ui/commands/delete.ts` (new), `src/extension.ts`, `package.json`, `package.nls.json`), `tests/extension/**` (`pure/studio-url.property.test.ts`, `pure/studio-url-compat.test.ts` (new), `glue/commands.test.ts`, `static/manifest.test.ts`, `static/plain-language.test.ts`).
  - `src/core/` imports neither `vscode` nor the root `src/`; no hard-coded hex colour in the extension UI code. G-K reads `src/studio/ui/js/router.js` in its round-trip test and does not change it.

  - [x] 14.1 Add the core pieces
    - `ports.ts`: `StudioRoute` gains `workflows`, `StudioTarget`, `browserUrl(route?, target?)`, `StudioApi.deleteWorkflow(id)`. `studio-url.ts`: `TARGET_NAME_RE`, `buildBrowserUrl(h, route?, target?)` (token in the query only; a valid tool target gives `#/playground?tool=<encodeURIComponent(name)>`, a workflow target `#/workflows/<encodeURIComponent(id)>`; an invalid name or id is ignored and the URL equals the one without a target). `with-timeout.ts`: `withTimeout(work, ms)`. `studio-api.ts`: `deleteWorkflow`. `strings.ts`: titles and messages in Plain_Language, no path, no token.
    - Order: F5 (delete pieces), snapshot, then F6 (`buildBrowserUrl`), snapshot.
    - _Requirements: 17.4, 17.12, 18.1, 18.2, 18.3, 18.4, 18.5, 18.13_

  - [x] 14.2 Add the commands and the manifest entries
    - `ui/commands/studio.ts`: `daemonize.testInStudio(node?)`. For `action:<id>` call `withTimeout(api.workflows(), 5000)` once, match `<id>` exactly with `WorkflowRow.id` (never the label), open `{ kind: 'tool', name }` when `toolName` matches `TARGET_NAME_RE`, `{ kind: 'workflow', id }` when the workflow has no `toolName`, and plain `playground` when the id is unknown or the call fails, times out or returns a malformed body (no notification). Any other row or none opens `playground` without calling the Studio. The address is never logged, copied or shown.
    - `ui/commands/delete.ts`: `daemonize.deleteAction(node?)` needs `node.id` matching `^action:.+$` and a running Studio, else does nothing. Modal warning naming the label with detail "This action cannot be recovered from the Studio." and the button "Delete". One `api.deleteWorkflow(id)` under `withTimeout(…, 10000)` and an in-flight `Set<string>` per id. 200: refresh and information message (adds that tools are being updated when `recompile === 'started'`); 404: refresh and "this action no longer exists"; 409: the answer's message after redaction; other status, timeout or unreachable: a plain error message.
    - `extension.ts` registers both commands. `package.json`: the command, an inline `view/item/context` entry for `viewItem == action`, hidden from the command palette; `package.nls.json` titles. No rename or variable editing on the row.
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12, 18.14_

  - [x] 14.3 Write the compatibility test for the extension URL (required)
    - File: `tests/extension/pure/studio-url-compat.test.ts`. `buildBrowserUrl` without a target returns the same URL as before for every existing route; a Workflow_File recorded before this change gives the same result as a new one for the three `testInStudio` cases. The static tests `imports.test.ts`, `no-hardcoded-colors.test.ts`, `plain-language.test.ts` and the manifest test keep passing.
    - _Requirements: 18.5, 18.14_

  - [x]* 14.4 Write property test for the browser URL and its route
    - File: `tests/extension/pure/studio-url.property.test.ts`.
    - **Feature: user-journey-improvements, Property 30: The browser URL and its route**
    - **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.13**

  - [x]* 14.5 Write unit tests for the commands
    - File: `tests/extension/glue/commands.test.ts`. `daemonize.testInStudio` for a tool name, a workflow without `toolName`, an unknown id, a failing, timing-out and malformed `GET /api/workflows`, a row without `action:`, and no row; `daemonize.deleteAction` cancel (no request), 200 (with and without `recompile`), 404, 409, other status, timeout, unreachable, a second invocation while pending, no row, a bad row id, Studio not running; no token or path in any message.
    - _Requirements: 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12_

  - [x]* 14.6 Write static tests for the manifest and the texts
    - Files: `tests/extension/static/manifest.test.ts`, `tests/extension/static/plain-language.test.ts`. The command, its inline entry for `viewItem == action` only, hidden from the palette, titles in `package.nls.json`, and every new string passes the Plain_Language rule with no path and no token.
    - _Requirements: 17.1, 17.11, 17.12_

- [x] 15. Checkpoint C - verification and commits (serial, last)
  - Do not push. Nothing in this group changes a feature file except to fix a failing check or to record a documented deviation.

  - [x] 15.1 Run the verification suite and report exact results
    - At the repository root, run and report the exit code of each: `npm run build`, `npx tsc --noEmit`, `npm run check:secrets`, `npm run studio:build`.
    - In `kiro-extension/`, run and report: `npm run typecheck`, `npm run build`, `npm run package` (regenerates `daemonize-kiro-0.1.0.vsix`; confirm the file exists and its modification time is later than the start of the command).
    - At the repository root, run `DAEMONIZE_REQUIRE_EXTENSION_BUILD=1 npm test` (on PowerShell set `$env:DAEMONIZE_REQUIRE_EXTENSION_BUILD='1'` first) and report the exact counts of passed, failed and skipped tests; only Docker-gated (`DAEMONIZE_DOCKER_TESTS`) or platform-gated tests may be skipped.
    - Reconcile `docs/studio.md` and `docs/replay-model.md` with the delivered routes and options, check RC-1 to RC-5 against the implementation and the amended `requirements.md`, and list every deviation from the design.
    - _Requirements: 24.4, 24.5, 24.6, 24.8_

  - [x] 15.2 Build the nine feature commits
    - Create `git worktree add ..\uji-commits HEAD`. For k = 1 to 9 copy, for every group and file, the newest snapshot of `%TEMP%\uji-snapshots\<group>\F<k>` with index at most k, run `npx tsc --noEmit` and the tests of that feature, and commit once per feature group with the tests in the same commit: F1 Requirements 1 to 4 (the message cites the P0 `git rev-parse HEAD`), F2 5 and 6, F3 7 to 9, F4 10 to 12, F5 13 to 17, F6 18, F7 19 and 20, F8 21, F9 22 and 23.
    - A file whose earlier snapshot does not typecheck with the other groups' snapshot of the same feature moves to the earliest commit whose build needs it; record every move in the report.
    - The tree after commit 9 must equal the finished working tree (`git diff --no-index` empty). After the last commit run the checks of 15.1 again in the worktree: they must all pass.
    - Do not push unless the user asks.
    - _Requirements: 24.4, 24.5, 24.6, 24.7_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. The regression test (1.1, 1.2) and the compatibility tests (3.7, 5.3, 6.3, 7.4, 8.7, 9.4, 10.2, 11.3, 12.3, 14.3) are required.
- Each task references granular requirements for traceability. Properties 1 to 33 each have one test task, except Properties 3, 8 and 16 and 31, which have a part in each of two groups (3.11 and 6.9; 3.18, 5.5, 6.6 and 11.4; 6.8 and 7.8; 7.10 and 9.5).
- The six property tests of Requirement 24.2 are Properties 1 (3.9), 20 (8.4), 14 (5.7), 27 (11.6), 30 (14.4) and 7 (5.4).
- Checkpoints ensure incremental validation. Property tests validate universal correctness properties; unit tests validate examples and edge cases.
- The workflow only creates the plan. Start a task by opening this file and choosing "Start task".

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5"] },
    { "id": 4, "tasks": ["3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "3.12", "3.13", "3.14", "3.15", "3.16", "3.17", "3.18"] },
    { "id": 5, "tasks": ["5.1", "5.2", "6.1", "6.2", "7.1", "7.3", "8.1", "9.1", "9.2", "10.1", "11.1", "12.1", "13.1", "13.2", "13.3", "14.1"] },
    { "id": 6, "tasks": ["5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9", "6.10", "7.2", "8.2", "8.4", "9.3", "10.2", "10.3", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "11.8", "11.9", "12.2", "12.3", "12.4", "12.5", "13.4", "14.2"] },
    { "id": 7, "tasks": ["6.11", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10", "7.11", "7.12", "7.13", "7.14", "8.3", "8.5", "9.4", "9.5", "9.6", "9.7", "9.8", "9.9", "9.10", "11.10", "12.6", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 8, "tasks": ["8.6", "8.7"] },
    { "id": 9, "tasks": ["15.1"] },
    { "id": 10, "tasks": ["15.2"] }
  ]
}
```
