# Implementation Plan

## Overview

Three parallel groups fix the defects of `bugfix.md` with the bug condition methodology: exploration test (fails on unfixed code), preservation tests (pass on unfixed code), fix, then verification. A checkpoint group runs the full build and test commands.

## Parallel execution rules

Three groups (G1, G2, G3) edit DISJOINT files and run in parallel, one agent per group. Tasks inside a group run in order, by the same agent. Only the checkpoint group (Task 20) runs after all three. Every task lists the files it may edit. No agent edits a file owned by another group, and no test file is edited by two groups.

| Group | Tasks | Owned files |
|---|---|---|
| **G1 Secrets** | 1-8 | `src/compiler/mcp-generator.ts`, `src/compiler/tool-description.ts`, `src/compiler/kiro-power-generator.ts`, `src/studio/model.ts`, `src/studio/playground.ts`, `src/studio/server.ts`, `src/studio/sample-data.ts`, new `src/studio/ui/js/secrets-view.js`; tests `tests/unit/compiler-outputs.test.ts`, `tests/unit/http-replay.test.ts`, `tests/unit/studio-model.test.ts`, `tests/unit/playground.test.ts`, `tests/integration/http-replay-e2e.test.ts`, `tests/integration/kiro-power-mcp.test.ts`, `tests/integration/studio-server.test.ts`, `tests/integration/studio-playground.test.ts`, new `tests/property/secrets-studio.property.test.ts`; `docs/secrets.md` |
| **G2 Recording** | 9-13 | `src/recorder/capture-script.ts`, `src/recorder/live-recorder.ts`, `src/recorder/workflow-recorder.ts` (`replaceValue` only), `src/recorder/visual-anchor.ts` (one option), `src/cli/commands/record.ts`; tests `tests/unit/capture-script.test.ts`, `tests/integration/live-recorder.test.ts`, `tests/integration/result-zone.test.ts`, `tests/integration/cli.test.ts` (only if a locator needs an update), new `tests/integration/recording-panel.test.ts`, new `tests/integration/record-recovery.test.ts`, new `tests/property/recording.property.test.ts` |
| **G3 Correlation and Studio UI** | 14-19 | new `src/recorder/navigation-rule.ts`, `src/studio/ui/js/views/workflows.js`, `src/studio/ui/js/views/playground.js`, `src/studio/ui/app.css`; tests new `tests/unit/navigation-rule.test.ts`, new `tests/integration/navigation-finalize.test.ts`, new `tests/property/navigation-rule.property.test.ts`, `tests/integration/studio-ui.test.ts`, `tests/integration/studio-ui-playground.test.ts`, `tests/unit/studio-ui-modules.test.ts`; `docs/studio.md` |
| **Checkpoint** | 20 | No source or test file. Runs commands and reports counts |

Notes for all groups:
- The design lists two property files for G1 and two for G2. This plan uses ONE property file per group (`secrets-studio`, `recording`, `navigation-rule`), as required. Each property keeps the design's number (1 to 11).
- Property tests carry the tag `// Feature: studio-first-recording-fixes, Property N: <title>` on the line above the property. `tests/property/**/*.test.ts` is already included by the vitest config.
- Not changed by anyone: `src/recorder/select-recipe.ts`, `src/recorder/network-capture.ts`, `src/cli/commands/record-tui.ts`, `tests/property/nextjs-fix-recipe.property.test.ts`. They must keep passing.
- Generated runtime files (`replay.ts`, `docker-replay.ts`, `http-replay.ts`, `step-plan.ts`) import nothing from `src/`. `capture-script.ts` stays one injected string.
- Run only your own test files while working (`npx vitest run <file>`). The full `npm test` runs only in Task 20.
- **Cross-group contracts (frozen in the design):**
  1. G3 Task 14 lands `navigation-rule.ts` first (wave 0). G2 Task 12.5 (wires `finalizeNetwork`) depends on it.
  2. G1 Tasks 7.2 and 7.3 add `WorkflowView` fields `secrets`, `unusedSecrets`, `secretsBasis`, `writeSteps`, `writeSummary` (and the same fields on each playground tool). G1 Task 7.4 adds `secrets-view.js`. G3 hook-ins (Tasks 19.2 and 19.3, its last implementation tasks) depend on them. The UI treats every field as optional.
  3. Never pass `secretEnvNames` bare to `flatMap` (it would receive the index as `options`).

## Tasks

## G1: Phantom HTTP secrets and Studio secret status

- [x] 1. Write bug condition exploration test for phantom HTTP secrets (runtime and listings)
  - **Property 1: Bug Condition** - Only HTTP-planned steps need HTTP secrets
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `tests/property/secrets-studio.property.test.ts` (new), `tests/integration/http-replay-e2e.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 1: Bug Condition - Only HTTP-planned steps need HTTP secrets`
  - **Scoped PBT Approach**: workflows whose steps plan as `ui, ui, ui, http`, with `{"$secret":"TOTP"}` / `{"$secret":"CHALLENGE_TOKEN"}` in the `http` of a `ui` step (isBugCondition_A1)
  - Property: `secretEnvNames(workflow, { http })` contains the recipe-only names only when `http === true` and the step is HTTP-planned; `describeTool(workflow, { http: false })` does not contain `DAEMONIZE_SECRET_TOTP`
  - Add to `http-replay-e2e.test.ts` (existing harness): generated `--http` `replayCore` with the phantom-secret workflow and an environment lacking the secrets must not return `missing_secret`
  - Check `generateDockerReplay` with `http: 'auto'`: `HTTP_MISSING_SECRETS(steps)` is empty for the same workflow
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (`missing_secret` for `DAEMONIZE_SECRET_CHALLENGE_TOKEN` after 0 ms; listings name the phantom secrets)
  - Document the counterexamples found
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

- [ ] 2. Write bug condition exploration test for the Studio secret list and status
  - **Property 3: Bug Condition** - Studio shows the secrets of the compiled mode with a status
  - **CRITICAL**: This test MUST FAIL on unfixed code
  - **Files owned**: `tests/property/secrets-studio.property.test.ts`, `tests/unit/studio-model.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 3: Bug Condition - Studio shows the secrets of the compiled mode with a status`
  - Property: for random workflows, `flags.http` and configured-name sets, `buildWorkflowView(...).secrets` names equal `secretEnvNames(workflow, { http })` without the `DAEMONIZE_SECRET_` prefix, `unusedSecrets` holds the recipe-only names, and each required secret has `status` `configured` iff its variable is in the set, else `missing`; the JSON holds names and statuses only
  - Run on UNFIXED code. **EXPECTED OUTCOME**: FAIL (no `unusedSecrets`, no `status`, recipe-only names listed as required)
  - Document the counterexamples found
  - _Requirements: 1.4, 2.4_

- [ ] 3. Write bug condition exploration test for write steps data
  - **Property 10: Bug Condition** - Studio names the write steps (data part)
  - **CRITICAL**: This test MUST FAIL on unfixed code
  - **Files owned**: `tests/property/secrets-studio.property.test.ts`, `tests/unit/studio-model.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line (data)`
  - Property: for random risk arrays and secret steps, `writeSteps` indices equal the non-`read` step indices in order, label is `step.label` clipped to 80 characters or `<action> <n>`, `login` appears at most once and only for the first write after a secret step, `writeSummary` is `none` / `login-only` / `actions` accordingly, and `risk.highest` is unchanged
  - Run on UNFIXED code. **EXPECTED OUTCOME**: FAIL (`writeSteps` and `writeSummary` do not exist)
  - _Requirements: 1.14, 2.15_

- [ ] 4. Write preservation property tests for secrets (BEFORE implementing the fix)
  - **Property 2: Preservation** - Secrets that are used stay required
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/secrets-studio.property.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 2: Preservation - Secrets that are used stay required`
  - Observe on UNFIXED code: HTTP-planned `$secret` names of a `--http` workflow, `secretRef` names, `secrets` entries, TOTP steps and `COOKIE_HEADER_VARIABLE` are listed and required; `missing_secret` is returned when an HTTP-planned name is absent; values are scrubbed
  - Write properties: for workflows where isBugCondition_A1 is false for a name (all `$secret` steps HTTP-planned on a `--http` server), the listing and `missingHttpSecrets` result equal the original (kept in the test as `originalSecretEnvNames`) ; generated `replay.ts` and `docker-replay.ts` contain no `src/` import
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.1, 3.2, 3.14_

- [ ] 5. Write preservation property tests for Studio security
  - **Property 4: Preservation** - Studio never exposes a value and its security is unchanged
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/secrets-studio.property.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 4: Preservation - Studio never exposes a value and its security is unchanged`
  - Observe on UNFIXED code: `/api/workflows` and `/api/playground` contain no secret value for random environment values; token, Host, Origin, `x-studio-request` and CSP checks answer as today
  - Write property: random secret values put in the environment never appear in either response
  - The existing `studio-no-secrets.property.test.ts` and `playground-redaction.property.test.ts` are not edited
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.3, 3.9_

- [ ] 6. Write preservation property tests for read-only tools (server side)
  - **Property 11: Preservation** - Read-only tools and the confirmation flow are unchanged (server part)
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/secrets-studio.property.test.ts`, `tests/unit/playground.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 11: Preservation - Read-only tools and the confirmation flow are unchanged (server)`
  - Observe on UNFIXED code: `read` tools run without `confirm`; write and delete tools return 409 `confirmation_required` without `confirm: true`; `risk.highest` is unchanged
  - Write property: for random workflows with no write step, the view has no write step data and the playground behavior above holds
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.10, 3.11_

- [ ] 7. Fix for phantom HTTP secrets, Studio secret status and write-step data

  - [ ] 7.1 Add the mode-aware secret list in `src/compiler/tool-description.ts`
    - Add `SecretEnvOptions` and `httpSecretSplit(workflow, options)`. Build `secretEnvNames(workflow, options = {})` on it: `secretRef` and `workflow.secrets` always; `httpSecretNames(step.http)` only when `options.http === true` and `planSteps(workflow.steps)[i] === 'http'`
    - `describeTool(workflow, options)` calls `secretEnvNames(workflow, options)`
    - _Bug_Condition: isBugCondition_A1(input) from design (recipe-only `$secret` names of a step not executed over HTTP)_
    - _Expected_Behavior: secretEnvNames lists such names only for HTTP-planned steps of a `--http` server_
    - _Preservation: secretRef, secrets list, TOTP, COOKIE_HEADER_VARIABLE unchanged_
    - _Requirements: 2.2, 2.3, 3.2_

  - [ ] 7.2 Add the secret and write-step view model in `src/studio/model.ts` (contract for G3)
    - Add `SecretName`, `SecretStatusSource`, `workflowSecrets(workflow, { http }, status?)`; keep `secretNames()` exported and unchanged
    - `WorkflowView` gains `secrets`, `unusedSecrets`, `secretsBasis` (`not-compiled` | `ui-only` | `http`), `writeSteps` (`WriteStepView`), `writeSummary` (`none` | `login-only` | `actions`)
    - `buildWorkflowView(set, workflow, outputs, status?)` and `buildWorkflows(targets, status?)` take the optional status source. `buildTargetOverview.secrets` uses the required names
    - `toolMeta().sensitiveArgs` covers required and unused names. Names, kinds, variable names and statuses only: no value
    - _Bug_Condition: isBugCondition_A1(input) from design; Studio shows write badge only_
    - _Expected_Behavior: required list for the compiled mode with status, unused list, writeSteps and writeSummary_
    - _Preservation: risk.highest unchanged; no secret value in any field_
    - _Requirements: 2.4, 2.15, 3.3, 3.10_

  - [ ] 7.3 Pass status and fields through `src/studio/playground.ts`, `src/studio/server.ts`, `src/studio/sample-data.ts` (contract for G3)
    - Add `PlaygroundSession.configuredSecretVariables()` (reuses `launchSpec()`, returns upper-case `DAEMONIZE_SECRET_*` names with a non-empty value, names only)
    - `server.ts`: `readOutputs` sets `flags.http` only when `http-replay.js` exists and `replay.js` imports it (1 MB cap, text read, fallback to the file test); `/api/workflows` and `/api/playground` build the status source (none in sample mode) and `playgroundStatus` adds `secrets`, `unusedSecrets`, `secretsBasis`, `writeSteps`, `writeSummary` to each tool
    - `sample-data.ts`: add the new fields where the sample shape needs them (all stay optional for the UI)
    - Token, Host, Origin, `x-studio-request`, CSP and `redactForStudio` unchanged
    - _Bug_Condition: isBugCondition_A1(input) from design_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 3)_
    - _Preservation: Studio security unchanged (Property 4)_
    - _Requirements: 2.4, 3.3, 3.9_

  - [ ] 7.4 Create `src/studio/ui/js/secrets-view.js` (contract for G3)
    - Export `secretsSection(secrets, unusedSecrets, { basis, variant })` built with the safe `h()` builders (no `innerHTML`)
    - Each required secret: name chip, `DAEMONIZE_SECRET_<NAME>`, a status chip (`chip pass` "configured", `chip fail` "missing", none when `status` is undefined)
    - `playground` variant keeps the title "Provided by env" and adds the "fails with missing_secret" line when any is missing; `workflow` variant keeps "Secrets needed"
    - Unused names in a collapsed `<details>` titled "Recorded in HTTP recipes, not read by this server"; basis `not-compiled` shows "Compile to see which secrets the server reads"
    - Tolerates absent arrays and absent `status`
    - _Requirements: 2.4, 3.3_

  - [ ] 7.5 Filter HTTP secrets by the plan in `src/compiler/mcp-generator.ts`
    - `WEB_RUNTIME_HTTP` `replayCore`: compute `const plan = planSteps(steps)` before the check, `const httpSteps = steps.filter((_, index) => plan[index] === "http")`, pass `httpSteps` to `missingHttpSecrets` and `httpSecretValues`, keep `missingSecrets` and `secretValues` on all steps, remove the later duplicate `const plan`
    - `generateDockerReplay` with `http`: import `planSteps`, add `httpStepsOf`, filter in `HTTP_SECRET_VARIABLES` and `HTTP_MISSING_SECRETS`; without `http` they stay `() => []`. `WEB_RUNTIME` (no `--http`) unchanged
    - No template literals in the generated code, no import from `src/`
    - _Bug_Condition: isBugCondition_A1(input) from design_
    - _Expected_Behavior: only HTTP-planned steps feed the secret check (Property 1)_
    - _Preservation: HTTP-planned `$secret` names still required, resolved and scrubbed (Property 2)_
    - _Requirements: 2.1, 2.2, 3.1, 3.14_

  - [ ] 7.6 Use the mode-aware list in `src/compiler/kiro-power-generator.ts`
    - `const secretVariables = [...new Set(set.workflows.flatMap((workflow) => secretEnvNames(workflow, { http })))].sort();` with the explicit arrow; use it for `mcp.json` env and the `SKILL.md` secrets section
    - _Requirements: 2.2, 2.3_

  - [ ] 7.7 Update existing G1 tests and `docs/secrets.md`
    - Update `tests/unit/compiler-outputs.test.ts`, `tests/unit/http-replay.test.ts`, `tests/unit/studio-model.test.ts`, `tests/unit/playground.test.ts`, `tests/integration/kiro-power-mcp.test.ts`, `tests/integration/studio-server.test.ts`, `tests/integration/studio-playground.test.ts` for the new signature and fields; add unit tests for `httpSecretSplit`, `workflowSecrets`, `configuredSecretVariables` (literal `mcp.json` entries counted, `${VAR}` placeholders and non-allow-listed names ignored, empty value is missing), both modes of `mcp.json` and `SKILL.md`, and a test that `WEB_RUNTIME` has no HTTP secret check
    - `docs/secrets.md`: document the used / unused split and the configured / missing status
    - _Requirements: 2.2, 2.3, 2.4, 3.11_

  - [ ] 7.8 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Only HTTP-planned steps need HTTP secrets
    - **Property 3: Expected Behavior** - Studio shows the secrets of the compiled mode with a status
    - **Property 10: Expected Behavior** - Studio names the write steps (data)
    - **IMPORTANT**: Re-run the SAME tests from Tasks 1, 2 and 3 - do NOT write new tests
    - Also run `tests/integration/http-replay-e2e.test.ts`: the phantom-secret workflow returns a result, and an absent HTTP-planned secret still returns `missing_secret`
    - **EXPECTED OUTCOME**: Tests PASS
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.15_

  - [ ] 7.9 Verify preservation tests still pass
    - **Property 2: Preservation** - Secrets that are used stay required
    - **Property 4: Preservation** - Studio never exposes a value and its security is unchanged
    - **Property 11: Preservation** - Read-only tools and the confirmation flow are unchanged (server)
    - **IMPORTANT**: Re-run the SAME tests from Tasks 4, 5 and 6 - do NOT write new tests
    - Also run `tests/property/studio-no-secrets.property.test.ts` and `tests/property/playground-redaction.property.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (no regressions)

- [ ] 8. G1 checkpoint - Ensure G1 tests pass
  - Run `npx vitest run` on every G1 test file listed in the ownership table, and `npx tsc --noEmit` on the files G1 edited
  - Ensure all pass, ask the user if questions arise.

## G2: Recording panel, finish binding and recovery

- [x] 9. Write bug condition exploration test for the recording panel, live flush and finish binding
  - **Property 5: Bug Condition** - The recording panel, the offer, the live flush and the finish binding
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `tests/property/recording.property.test.ts` (new), `tests/integration/recording-panel.test.ts` (new)
  - Tag the property `// Feature: studio-first-recording-fixes, Property 5: Bug Condition - The recording panel, the offer, the live flush and the finish binding`
  - **Scoped PBT Approach**: scope to isBugCondition_A2 cases: panel missing, offer from a previous route, result button removed after "Make variable", name input truncated, typed text not flushed after 600 ms, no `__daemonizeFinish`
  - Integration (route-fulfilled fake SPA): one `[data-daemonize-panel]` with "Recording", a step counter, "Choose the result to capture" and "Finish and save"; it survives `history.pushState`, `popstate`, `document.body.replaceWith`, `page.setContent` and a full navigation; the offer for the email on `/connexion` is gone on `/clients`; a 40-character suggestion is fully visible; after "Make variable" the choose button is still clickable; a live search typed with no blur gives one `type` step 600 ms after the last key and a second pause updates the same step; `__daemonizeFinish` ends `record()` with the page open
  - Property: offer model sequences of `typed`, `input`, `route`, `row` events evaluated in one page through `window.__daemonizeHelpers.offerModel`: the offer equals the last `typed` field when no later `route` and no later `input` of another field exists, else none
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (no panel, chip left after `pushState`, no step without blur)
  - Document the counterexamples found
  - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.12_

- [ ] 10. Write bug condition exploration test for lost steps after the session ends
  - **Property 6: Bug Condition** - No recorded step is lost after the session ends
  - **CRITICAL**: This test MUST FAIL on unfixed code
  - **Files owned**: `tests/property/recording.property.test.ts`, `tests/integration/record-recovery.test.ts` (new)
  - Tag the property `// Feature: studio-first-recording-fixes, Property 6: Bug Condition - No recorded step is lost after the session ends`
  - Property: `completeRecording` with a forced failing stage (`captureFinalScreen`, `readResultZone`, `finalizeNetwork`, `saveWorkflow`, closed page with a marked zone) and N steps in 0..20 writes `<out>.recovery.json` with all N steps (and the zone, unchecked) when N > 0, names the file and cause in the error, and writes no file when N = 0
  - Integration: window X after a marked zone; the same with `--result-zone`; `saveWorkflow` failing on `out`; `finalizeNetwork` failing; `RecordOptions.signal` ends the recording
  - Run on UNFIXED code. **EXPECTED OUTCOME**: FAIL (`completeRecording` is not exported, no recovery file after the window closes)
  - _Requirements: 1.10, 1.11, 2.10, 2.11_

- [ ] 11. Write preservation property tests for recorded steps and screens (BEFORE implementing the fix)
  - **Property 7: Preservation** - Recorded steps and screens do not change
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/recording.property.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 7: Preservation - Recorded steps and screens do not change`
  - Observe on UNFIXED code: steps (action types, selectors, anchors, values, row bindings, risk), `screenId('dom', page.content())`, thumbnails, `switch_page` steps for random scripted interactions of a small fixed page; Alt+Shift+R and blur/Enter flushes; zero steps fails with "Nothing had been recorded yet" and no file; a successful session writes the workflow and no recovery file
  - Write property: the same interaction gives the same recorded steps and screen hash. The "with panel" half is asserted after the fix; on unfixed code the baseline half is recorded and the test passes
  - Run existing `live-recorder`, `row-binding`, `result-zone`, `anchors-record`, `cli`, `adminer-regressions` tests as the baseline
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.4, 3.6, 3.7, 3.8, 3.12, 3.13_

- [ ] 12. Fix for the recording panel, finish binding and recovery

  - [ ] 12.1 Add bindings, end path and route bookkeeping in `src/recorder/live-recorder.ts` and `src/recorder/workflow-recorder.ts`
    - Export `PANEL_BINDING`, `FINISH_BINDING`, `PanelRequest`, `PanelState`, `EndReason`. Register `__daemonizePanel` and `__daemonizeFinish` in `bind()` for every page, popups included, before `addInitScript`
    - Add `ended`, idempotent `requestEnd(reason)`, last-3 step labels ring buffer (no typed values) filled in `handle()` and `switchTo()`, `collapse` state kept in Node
    - `handle()` honors `replaces` (same index, same field, last step) through new `WorkflowRecorder.replaceValue(index, value)`
    - `enqueue()` stores `urlBefore` per step; a `framenavigated` listener keeps `lastUrl`; add `navigationOf(index)`
    - _Bug_Condition: isBugCondition_A2(input) from design_
    - _Expected_Behavior: expectedBehavior(result) from design (Properties 5, 6)_
    - _Preservation: Preservation Requirements from design (Property 7)_
    - _Requirements: 2.8, 2.10, 2.11, 3.4_

  - [ ] 12.2 Build the panel, offer model and live flush in `src/recorder/capture-script.ts`
    - One root `data-daemonize-ui` `data-daemonize-panel` in `document.documentElement` with inline styles (`all:initial` first); header (dot, "Recording", step counter, `toggle-panel`), last steps, offer row ("Make variable" with the field name), result row, "Finish and save" (`finish`), `aria-live` status line
    - `ensurePanel()` at install, `DOMContentLoaded`, `load`, route change, and a `MutationObserver` on `document` (`childList` only). State is pulled through `__daemonizePanel({type:'state'})`. A sub-frame mounts only the compact offer row
    - `offerModel` exposed as `window.__daemonizeHelpers.offerModel`; route hook through `window.navigation` `currententrychange` with a `pushState`/`replaceState`/`popstate`/`hashchange` fallback; route is `location.pathname`
    - Name input width `max(220px, (suggestion.length + 4) ch)` capped at `min(360px, 60vw)`; `askName` swaps only the offer row
    - Capture-phase `input` listener with a 600 ms `LIVE_FLUSH_MS` debounce, flush on another field's input, before any non-`type` action, on Finish and on `pagehide`; send `replaces`
    - "Choose the result to capture" starts selection with a Cancel button (Esc and Alt+Shift+R use the same function); `result-kind` select after a zone is set; `CHIP_LIFETIME_MS` no longer removes the offer
    - "Finish and save": flush, await outstanding record promises, call `__daemonizeFinish()`, show "Saving…". Hide the finish button and counter when the new bindings are absent
    - Keep the `data-daemonize-action` values `make-variable`, `variable-name`, `confirm-variable`, `mark-result`, `result-kind`, the "Make variable" button name and `Variable "<name>" saved`; exactly one `data-daemonize-ui` element per frame; no import, backslashes in regexes stay doubled
    - _Bug_Condition: isBugCondition_A2(input) from design_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 5)_
    - _Preservation: captured steps, anchors, hashes unchanged (Property 7)_
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.12, 3.4, 3.12_

  - [ ] 12.3 Hide the panel in thumbnails in `src/recorder/visual-anchor.ts`
    - `takeThumbnail` passes `style: '[data-daemonize-ui] { visibility: hidden !important }'` to `page.screenshot`
    - _Requirements: 3.4_

  - [ ] 12.4 Add staged recovery in `src/cli/commands/record.ts`
    - Export `completeRecording(context, hooks?)` with stages `idle`, `screen`, `zone`, `network`, `finish`, `save` and one `rescue()` for every failure at or after `idle` and every `BrowserStoppedError`
    - Closed page with a marked zone throws `ZoneUnverifiedError`; `rescue()` does nothing when `stepCount === 0` ("Nothing had been recorded yet.", no file); otherwise best-effort `finalizeNetwork` (skipped if done, 5 s bound), `recorder.finish` with the marked zone unchecked, write `<out>.recovery.json`, fall back to `<tmpdir>/daemonize-recovery-<workflowId>.json`
    - Error wording as in the design (names the file and the cause, original error as `cause`); window X with no marked zone still saves normally; success writes no recovery file; browser closed in `finally`
    - `RecordOptions.signal` maps to `requestEnd('signal')`; `waitForUser(page, ended)` also resolves on `live.ended` and mentions the panel button
    - `record-tui.ts` is not changed
    - _Bug_Condition: isBugCondition_A2(input) from design (stepCount > 0 and nothing written)_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 6)_
    - _Preservation: Alt+Shift+R, Enter, `options.drive`, window X with no zone, zero steps (Property 7)_
    - _Requirements: 2.10, 2.11, 3.7, 3.8, 3.13_

  - [ ] 12.5 Wire `finalizeNetwork` to `navigation-rule.ts` (DEPENDS ON Task 14, G3)
    - In `src/recorder/live-recorder.ts` `finalizeNetwork`: `isScreenNavigation({ actionType, submit: (step.risk ?? 'read') !== 'read', nav: this.navigationOf(index) })`, then `dropNavigationReads(attempts, { screenNavigation, used })`; when `kept` is empty and `dropped` is not, call `this.recorder.setHttp(index, undefined, 'read')`, report level `accessibility` with `navigationReason(dropped)` and return; otherwise continue with `kept`
    - `selectRecipe`, `isFollowUpRead`, `followUpReads`, `network-capture.ts` are not modified
    - Import only the four frozen exports of `navigation-rule.ts`
    - _Bug_Condition: isBugCondition_A3(input) from design_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 8)_
    - _Preservation: Properties 5 and 6 of nextjs-fix-recipe.property.test.ts keep passing_
    - _Requirements: 2.13, 3.5_

  - [ ] 12.6 Update existing G2 tests
    - Update `tests/unit/capture-script.test.ts` (panel markup, `offerModel`, debounce constant, name input width, fallbacks when the new bindings are absent), `tests/integration/live-recorder.test.ts` (`replaceValue`, `requestEnd` idempotence, `PanelState`), `tests/integration/result-zone.test.ts`, `tests/integration/cli.test.ts` (only if a locator needs an update, justified in the diff)
    - _Requirements: 3.11, 3.12_

  - [ ] 12.7 Verify bug condition exploration tests now pass
    - **Property 5: Expected Behavior** - The recording panel, the offer, the live flush and the finish binding
    - **Property 6: Expected Behavior** - No recorded step is lost after the session ends
    - **IMPORTANT**: Re-run the SAME tests from Tasks 9 and 10 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12_

  - [ ] 12.8 Verify preservation tests still pass
    - **Property 7: Preservation** - Recorded steps and screens do not change
    - **IMPORTANT**: Re-run the SAME tests from Task 11 (including the "with panel" half) and the existing `live-recorder`, `row-binding`, `result-zone`, `anchors-record`, `cli`, `adminer-regressions`, `network-capture` tests and `tests/property/nextjs-fix-recipe.property.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (no regressions)

- [ ] 13. G2 checkpoint - Ensure G2 tests pass
  - Run `npx vitest run` on every G2 test file listed in the ownership table, and `npx tsc --noEmit`
  - Ensure all pass, ask the user if questions arise.

## G3: SPA correlation rule and Studio UI

- [x] 14. Land `src/recorder/navigation-rule.ts` FIRST (wave 0, unblocks G2 Task 12.5)
  - **Files owned**: `src/recorder/navigation-rule.ts` (new), `tests/unit/navigation-rule.test.ts` (new)
  - Pure module: no Playwright, no I/O. Frozen exports: `NavigationInfo`, `routeKey(url)` (origin + pathname, trailing slash removed, query and hash ignored, `undefined` when unparsable), `isScreenNavigation({ actionType, submit, nav })`, `dropNavigationReads(attempts, { screenNavigation, used })` returning `{ kept, dropped }`, `navigationReason(dropped)`
  - `dropNavigationReads` drops GET and HEAD attempts only when `screenNavigation` is true and `used` is empty; writes are kept; everything else is returned unchanged in `kept`. `kept` plus `dropped` is the input, in order
  - Unit tests: `routeKey` (trailing slash, query, hash, default ports, invalid URL); `isScreenNavigation` (click, submit, same route, `?q=` only change, other actions); `dropNavigationReads`; `navigationReason` text ("screen navigation: GET /api/merchants/audience is a mount request of the new screen, not an action")
  - Run `npx vitest run tests/unit/navigation-rule.test.ts`. Nothing else is edited; `finalizeNetwork` is not wired yet, so the bug still reproduces until G2 Task 12.5
  - _Bug_Condition: isBugCondition_A3(input) from design_
  - _Expected_Behavior: expectedBehavior(result) from design (Property 8, rule part)_
  - _Requirements: 2.13_

- [x] 15. Write bug condition exploration test for navigation clicks
  - **Property 8: Bug Condition** - A navigation click does not take a mount read as its recipe
  - **CRITICAL**: The integration part MUST FAIL on unfixed code (until G2 Task 12.5 wires the rule). Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `tests/property/navigation-rule.property.test.ts` (new), `tests/integration/navigation-finalize.test.ts` (new)
  - Tag the property `// Feature: studio-first-recording-fixes, Property 8: Bug Condition - A navigation click does not take a mount read as its recipe`
  - Property (pure, passes once Task 14 landed): for random attempts (GET, HEAD, POST, PUT, PATCH, DELETE; bound subsets; with or without recipe), a screen navigation and empty `used`, `kept` has no read and keeps every write in order, `dropped` has the reads, `kept` plus `dropped` is the input
  - Integration on a fake SPA: `<a href="/clients">` loads a route whose mount does `fetch('/api/merchants/audience')`; `finalizeNetwork` must leave the step without `http` and report level `accessibility` with a reason naming the screen navigation. The same click followed by a `POST` keeps the `POST`. A `?q=` only change keeps its recipe. A search click that carries a variable keeps its recipe
  - Run on UNFIXED wiring. **EXPECTED OUTCOME**: integration test FAILS (the mount `GET` is the recipe)
  - Document the counterexample ("`GET /api/merchants/audience` attached to the navigation click")
  - _Requirements: 1.12, 2.13_

- [ ] 16. Write bug condition exploration test for the Studio UI polish
  - **Property 10: Bug Condition** - Studio names the write steps and keeps variable names on one line (rendering)
  - **CRITICAL**: This test MUST FAIL on unfixed code
  - **Files owned**: `tests/property/navigation-rule.property.test.ts`, `tests/integration/studio-ui.test.ts`, `tests/integration/studio-ui-playground.test.ts`, `tests/unit/studio-ui-modules.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line (rendering)`
  - `studio-ui.test.ts`: at 1280 px and 700 px every `.chip.variable` of the VARIABLES table (for example `{{query}}`) is one line high
  - Property (rendering): for random given `writeSteps` and `writeSummary` (fed directly, not from G1), the write note and the `confirmDialog` list show step number and label for each write, say "login form" for a `login` kind, and contain no argument or secret value
  - `studio-ui-playground.test.ts`: the dialog for a tool with a login-only write and for a tool with writes lists them
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (chip wraps over three lines, dialog has the generic sentence only)
  - _Requirements: 1.13, 1.14, 1.15, 2.14, 2.15, 2.16_

- [ ] 17. Write preservation property tests for recipe selection
  - **Property 9: Preservation** - Other recipe selection is unchanged
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/navigation-rule.property.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 9: Preservation - Other recipe selection is unchanged`
  - Observe: `selectRecipe` results for random attempts, `used` and `submit`
  - Write property: `dropNavigationReads` returns the attempts unchanged (`dropped` empty) when `screenNavigation` is false or `used` is not empty; `isScreenNavigation` is false for non-click, submit and same-route inputs; `selectRecipe` output equals the observed one
  - `tests/property/nextjs-fix-recipe.property.test.ts` is not edited and still passes
  - Run on current code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.5_

- [ ] 18. Write preservation property tests for read-only UI
  - **Property 11: Preservation** - Read-only tools and the confirmation flow are unchanged (UI part)
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/navigation-rule.property.test.ts`, `tests/unit/studio-ui-modules.test.ts`
  - Tag the property `// Feature: studio-first-recording-fixes, Property 11: Preservation - Read-only tools and the confirmation flow are unchanged (UI)`
  - Observe: a workflow with no write step shows no note; a `read` tool runs with no dialog; the dialog for a tool without `writeSteps` shows the generic sentence; other `.chip` uses keep wrapping
  - Write property: for random read-only workflows and tools missing the new fields, the rendered output has no write note, no dialog for `read`, and the generic dialog text for tools without `writeSteps`
  - Run on current code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.10, 3.11_

- [ ] 19. Fix for the navigation rule wiring checks and Studio UI polish

  - [ ] 19.1 Keep variable names on one line (`src/studio/ui/app.css`, `src/studio/ui/js/views/workflows.js`)
    - CSS: `.vars-table td:first-child, .vars-table th:first-child { white-space: nowrap }`, `.vars-table .chip.variable { white-space: nowrap; overflow-wrap: normal; word-break: keep-all }`, `.vars-table td:last-child { white-space: nowrap }`, `.detail-grid { grid-template-columns: minmax(0, 1fr) minmax(320px, 26rem) }`; other `.chip` uses unchanged
    - `workflows.js`: the variables table gets `class: 'table compact vars-table'` inside `.table-wrap` (`overflow-x: auto`)
    - _Bug_Condition: isBugCondition_A3(input) from design (variable names wrapped)_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 10, one-line chips)_
    - _Preservation: Preservation Requirements from design (Property 11)_
    - _Requirements: 2.14, 3.10_

  - [-] 19.2 Hook in the write-step list (DEPENDS ON G1 Tasks 7.2 and 7.3)
    - `workflows.js`: write note under the header meta: nothing for `none` or absent; `login-only` sentence ("The only write is the login form: step N, “label”. The other steps only read."); `actions` list "Writes data in N step(s):" with "Step N: label (write)" and the login submit marked "login form"
    - `playground.js`: `confirmDialog(tool, onConfirm)` keeps title, focus handling and buttons and adds the list from `tool.writeSteps` (or the login-only sentence); without `writeSteps` the generic sentence stays. Step numbers and labels only, no argument or secret value
    - Every new field is optional; builders are the safe `h()` ones
    - _Bug_Condition: isBugCondition_A3(input) from design (write steps not listed)_
    - _Expected_Behavior: expectedBehavior(result) from design (Property 10)_
    - _Preservation: read-only workflows show no note, `read` tools no dialog (Property 11)_
    - _Requirements: 2.15, 2.16, 3.10_

  - [ ] 19.3 Hook in `secretsSection` (DEPENDS ON G1 Task 7.4)
    - `workflows.js`: replace the "Secrets needed" block with `secretsSection(wf.secrets, wf.unusedSecrets, { basis: wf.secretsBasis, variant: 'workflow' })`
    - `playground.js`: replace the "Provided by env" block with `secretsSection(tool.secrets, tool.unusedSecrets, { basis: tool.secretsBasis, variant: 'playground' })`
    - Fallback to the previous rendering when the fields are absent (static demo, old server)
    - _Requirements: 2.4, 3.3_

  - [ ] 19.4 Update `docs/studio.md` and the existing UI tests
    - Document the write note, the confirmation list and the one-line variable names
    - Update `tests/integration/studio-ui.test.ts`, `tests/integration/studio-ui-playground.test.ts`, `tests/unit/studio-ui-modules.test.ts` for the new markup (screenshot only if the existing test already compares one)
    - _Requirements: 3.11_

  - [ ] 19.5 Verify bug condition exploration tests now pass
    - **Property 8: Expected Behavior** - A navigation click does not take a mount read as its recipe
    - **Property 10: Expected Behavior** - Studio names the write steps and keeps variable names on one line (rendering)
    - **IMPORTANT**: Re-run the SAME tests from Tasks 15 and 16 - do NOT write new tests
    - Requires G2 Task 12.5 merged (the `navigation-finalize.test.ts` integration test needs the wiring) and G1 Tasks 7.2 to 7.4
    - **EXPECTED OUTCOME**: Tests PASS
    - _Requirements: 2.13, 2.14, 2.15, 2.16_

  - [ ] 19.6 Verify preservation tests still pass
    - **Property 9: Preservation** - Other recipe selection is unchanged
    - **Property 11: Preservation** - Read-only tools and the confirmation flow are unchanged (UI)
    - **IMPORTANT**: Re-run the SAME tests from Tasks 17 and 18, plus `tests/property/nextjs-fix-recipe.property.test.ts` and `tests/integration/network-capture.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (no regressions)

## Checkpoint group (after G1, G2 and G3 are merged)

- [ ] 20. Checkpoint - Full build and test run
  - **Files owned**: none (no source or test edit). Report only
  - Use one run stamp for unique log names: `$s = Get-Date -Format yyyyMMddHHmmss` (PowerShell; `%TEMP%` is `$env:TEMP`)

  - [ ] 20.1 `npm run build`
    - `npm run build > "$env:TEMP\sfrf-$s-build.log" 2>&1`
    - Report the exit code and the log path. Expect no `tsc` error
    - _Requirements: 3.11, 3.14_

  - [ ] 20.2 `npm run studio:build`
    - `npm run studio:build > "$env:TEMP\sfrf-$s-studio-build.log" 2>&1`
    - Report the exit code and the log path. The static demo must still build with the optional new fields absent
    - _Requirements: 3.3, 3.11_

  - [ ] 20.3 `npm run check:secrets`
    - `npm run check:secrets > "$env:TEMP\sfrf-$s-check-secrets.log" 2>&1`
    - Report the exit code and the log path
    - _Requirements: 3.3_

  - [ ] 20.4 `npm test`
    - `npm test > "$env:TEMP\sfrf-$s-test.log" 2>&1`, with a long timeout (up to 1800000 ms)
    - Read the log and report the EXACT counts from the vitest summary: test files (passed / failed / skipped / total) and tests (passed / failed / skipped / total). Do not estimate
    - Any failure: list the file and test name, do not fix other groups' files without asking
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.10, 3.11_

  - [ ] 20.5 Docker integration tests (only when Docker is up)
    - Check first with `docker info > "$env:TEMP\sfrf-$s-docker-info.log" 2>&1`; if it fails, report "Docker not available, skipped" and the log path
    - If Docker is up (`docker-replay.ts` changed in G1): `$env:DAEMONIZE_DOCKER_TESTS = '1'; npx vitest run tests/integration/docker-sandbox.test.ts tests/integration/http-replay-e2e.test.ts > "$env:TEMP\sfrf-$s-docker-tests.log" 2>&1`, then remove the variable
    - Report the exact counts (files and tests: passed / failed / skipped / total) and the log path
    - _Requirements: 2.1, 3.1, 3.14_

  - [ ] 20.6 Report
    - Give the exit code and log path of each command and the exact counts from 20.4 and 20.5
    - Ensure all pass, ask the user if questions arise.

## Task Dependency Graph

Waves are cross-group milestones. Inside a group, tasks run in listed order (same agent). `after` lists the cross-group or gating dependencies that matter.

```json
{
  "groups": {
    "G1": ["1", "2", "3", "4", "5", "6", "7", "8"],
    "G2": ["9", "10", "11", "12", "13"],
    "G3": ["14", "15", "16", "17", "18", "19"],
    "CHECKPOINT": ["20"]
  },
  "waves": [
    {
      "wave": 0,
      "description": "Tests first in each group; G3 lands navigation-rule.ts as its first task",
      "tasks": [
        { "id": "14", "group": "G3", "title": "Land navigation-rule.ts", "after": [] },
        { "id": "1", "group": "G1", "after": [] },
        { "id": "2", "group": "G1", "after": ["1"] },
        { "id": "3", "group": "G1", "after": ["2"] },
        { "id": "4", "group": "G1", "after": ["3"] },
        { "id": "5", "group": "G1", "after": ["4"] },
        { "id": "6", "group": "G1", "after": ["5"] },
        { "id": "9", "group": "G2", "after": [] },
        { "id": "10", "group": "G2", "after": ["9"] },
        { "id": "11", "group": "G2", "after": ["10"] },
        { "id": "15", "group": "G3", "after": ["14"] },
        { "id": "16", "group": "G3", "after": ["15"] },
        { "id": "17", "group": "G3", "after": ["16"] },
        { "id": "18", "group": "G3", "after": ["17"] }
      ]
    },
    {
      "wave": 1,
      "description": "Fixes; G1 delivers the Studio contract (7.2, 7.3, 7.4); G2 wires finalizeNetwork once task 14 is done",
      "tasks": [
        { "id": "7.1", "group": "G1", "after": ["6"] },
        { "id": "7.2", "group": "G1", "after": ["7.1"], "contract": "WorkflowView fields" },
        { "id": "7.3", "group": "G1", "after": ["7.2"], "contract": "server and playground fields" },
        { "id": "7.4", "group": "G1", "after": ["7.3"], "contract": "secrets-view.js" },
        { "id": "7.5", "group": "G1", "after": ["7.4"] },
        { "id": "7.6", "group": "G1", "after": ["7.5"] },
        { "id": "7.7", "group": "G1", "after": ["7.6"] },
        { "id": "7.8", "group": "G1", "after": ["7.7"] },
        { "id": "7.9", "group": "G1", "after": ["7.8"] },
        { "id": "8", "group": "G1", "after": ["7.9"] },
        { "id": "12.1", "group": "G2", "after": ["11"] },
        { "id": "12.2", "group": "G2", "after": ["12.1"] },
        { "id": "12.3", "group": "G2", "after": ["12.2"] },
        { "id": "12.4", "group": "G2", "after": ["12.3"] },
        { "id": "12.5", "group": "G2", "after": ["12.4", "14"], "contract": "navigation-rule.ts" },
        { "id": "12.6", "group": "G2", "after": ["12.5"] },
        { "id": "12.7", "group": "G2", "after": ["12.6"] },
        { "id": "12.8", "group": "G2", "after": ["12.7"] },
        { "id": "13", "group": "G2", "after": ["12.8"] },
        { "id": "19.1", "group": "G3", "after": ["18"] }
      ]
    },
    {
      "wave": 2,
      "description": "G3 hook-ins (last G3 implementation tasks) and verification, after G1 contract and G2 wiring",
      "tasks": [
        { "id": "19.2", "group": "G3", "after": ["19.1", "7.2", "7.3"] },
        { "id": "19.3", "group": "G3", "after": ["19.2", "7.4"] },
        { "id": "19.4", "group": "G3", "after": ["19.3"] },
        { "id": "19.5", "group": "G3", "after": ["19.4", "12.5"] },
        { "id": "19.6", "group": "G3", "after": ["19.5"] }
      ]
    },
    {
      "wave": 3,
      "description": "Checkpoint after all groups",
      "tasks": [
        { "id": "20.1", "group": "CHECKPOINT", "after": ["8", "13", "19.6"] },
        { "id": "20.2", "group": "CHECKPOINT", "after": ["20.1"] },
        { "id": "20.3", "group": "CHECKPOINT", "after": ["20.2"] },
        { "id": "20.4", "group": "CHECKPOINT", "after": ["20.3"] },
        { "id": "20.5", "group": "CHECKPOINT", "after": ["20.4"] },
        { "id": "20.6", "group": "CHECKPOINT", "after": ["20.5"] }
      ]
    }
  ],
  "crossGroupEdges": [
    { "from": "14", "to": "12.5", "contract": "navigation-rule.ts API (G3 produces, G2 consumes in finalizeNetwork only)" },
    { "from": "7.2", "to": "19.2", "contract": "WorkflowView writeSteps, writeSummary (G1 produces, G3 consumes)" },
    { "from": "7.3", "to": "19.2", "contract": "playground tool fields (G1 produces, G3 consumes)" },
    { "from": "7.4", "to": "19.3", "contract": "secrets-view.js secretsSection (G1 produces, G3 consumes)" },
    { "from": "12.5", "to": "19.5", "contract": "finalizeNetwork wiring needed by navigation-finalize.test.ts" },
    { "from": "8", "to": "20.1", "contract": "all groups merged" },
    { "from": "13", "to": "20.1", "contract": "all groups merged" },
    { "from": "19.6", "to": "20.1", "contract": "all groups merged" }
  ]
}
```

## Notes

- Task 14 is the first G3 task and is in wave 0. G2 Task 12.5 is the only G2 use of it.
- G3 Tasks 19.2 and 19.3 are the last G3 implementation tasks and wait for G1 Tasks 7.2 to 7.4.
- Task 15 integration test fails until G2 Task 12.5 lands. Its pure property part passes as soon as Task 14 lands.
