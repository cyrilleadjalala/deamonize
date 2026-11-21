# Implementation Plan: kiro-native-agent-and-firewall

## Overview

The implementation language is TypeScript for `src/`, `kiro-extension/` and the tests, plain ES modules for `src/studio/ui/js`, and Markdown and JSON for the agent, skill and `power/` files (as the design states). Work follows the design's "Implementation groups" in this order.

- **Group G0** (the seam) runs first and serial: Studio contracts and wiring, runtime stubs with the final signatures, `firewall-markers.ts`, the UI and extension seams, the shared arbitraries and the regression-test hook. It ends with its own checkpoint and the commit **CG-0** (`chore: seams for the Kiro-native agent and firewall`). Every other group starts from that commit.
- **Parallel groups** then run in the design's order: G-B and G-C (CG-1); G-D, G-S, G-U1, G-E2 (CG-2); G-U2 (CG-3); G-A, G-P, G-F1, G-E1 (CG-4); G-O, G-E3 (CG-5); G-F2, G-E4 (CG-6); **G-Z last** (CG-7), once all others report done. Each group edits only the files listed after "Owns:", and the lists are disjoint. A group that needs a change in a file it does not own stops and asks the conductor. Groups do not commit, push or change the root `package.json`.
- A group's own tests must pass without another group's code (use the G0 stubs and the test doubles). A test that needs another group's real code begins with `// checkpoint-only: needs G-x` and runs at the final checkpoint.
- The **final checkpoint** runs the Verification_Suite with exact results, then commits CG-1 to CG-7 in order with `git add` of the paths of their groups only. Nothing is pushed unless the user asks.
- Requirement conflicts are resolved as the design says. **RC-1**: extension and Studio text uses "New action" and "Create your first action"; task 18.2 amends Requirements 20.2 and 21.1 so the spec matches. **RC-2**: the gate logic lives in the copied runtime modules (`approval-queue.ts`, `firewall.ts`); `mcp-server.ts` holds one three-line function `approvalGate` that calls them. **RC-3**: new installs with the setting on write `DAEMONIZE_APPROVAL_TIMEOUT_MS=90000`; the Builder_Agent entry sets `requestTimeout: 300000`; both are documented as unverified for Kiro settings entries. **RC-4**: `blocked` stays in the Step_Status type and the UI only; `buildTrace` never produces it. **RC-6**: one commit per group batch, CG-0 to CG-7.
- Property tests use `fast-check` with at least 100 runs and a tag comment `// Feature: kiro-native-agent-and-firewall, Property N: <title>`. The design maps several properties to one file, so a property sub-task covers one file and lists each property it holds; each property is still one separate fast-check test. Generators come from `tests/helpers/firewall-arbitraries.ts` (G0) and include secret-like strings, 0 to 5000 characters, Unicode, and `"`, `\` and newline. Tests never touch the real `~/.kiro`, hold no real secret and use no network.
- Test sub-tasks marked `*` are optional. **Not optional:**
  - the regression snapshot test with the narrowly extended `ALLOWED_DIFFERENCES` (the `//#fw` marked lines), task 1.6;
  - old-install and old-generated-server compatibility checks: tasks 4.3, 4.4, 5.4 and 6.3;
  - the fail-closed approval tests (deny, timeout and no approver run zero steps): tasks 3.5 and 4.6;
  - the no-secret checks on the Audit_Log (task 3.6) and on MCP results (tasks 10.6 and 10.10).
- The Playground, the Studio_MCP and every generated server never receive a secret value in any file, log, URL, MCP result, approval or fixture. The `dogfooding.md` table "Calls recorded during development" stays empty.

## Tasks

- [x] 1. G0 seams (serial, first, commit CG-0)
  - Owns: `src/studio/contracts.ts`, `src/studio/model.ts`, `src/studio/server.ts`, `src/studio/agent-access.ts` (new), `src/studio/services.ts`, `src/studio/inert-services.ts`, `src/studio/playground.ts` (option and result types only), `src/studio/sample-activity.ts` (new), `src/studio/messages/{approvals,activity,system}.ts` (new), `src/studio/mcp/tool-names.ts` (new), `src/studio/{approvals-service,activity-service,browser-check,daemonize-power}.ts` (stubs), `src/studio/routes/{approvals,activity,system,power-daemonize}.ts` (stubs returning `[]`), `src/studio/routes/index.ts`, `src/studio/routes/types.ts`, `src/replay/runtime/{approval-queue,audit-log,trace,firewall}.ts` (stubs with final signatures), `src/compiler/firewall-markers.ts` (new, complete), `src/studio/ui/index.html`, `src/studio/ui/js/features.js`, `src/studio/ui/js/views/activity.js` (empty body), `src/studio/ui/js/{timeline,approval-banner,copy-activity,copy-timeline}.js` (empty bodies), `src/studio/ui/css/{activity,timeline}.css` (stubs), `kiro-extension/package.json`, `kiro-extension/package.nls.json`, `kiro-extension/src/core/{strings,types,ports,studio-api,studio-url}.ts`, `kiro-extension/src/extension.ts`, `kiro-extension/src/core/{cli-installer,install-constants,welcome-model,approval-watcher,activity-model,activity-api,power-api,chat-launch}.ts` (stubs), `kiro-extension/src/ui/commands/{agent,approvals,onboarding,power}.ts` (stubs), `kiro-extension/src/ui/views/activity-view.ts` (stub), `kiro-extension/src/ui/context-keys.ts` (stub), `kiro-extension/media/walkthrough/{install,studio,action,test,kiro,agent}.md` (one heading each), `kiro-extension/tests/extension/fake-vscode.ts` or `tests/extension/fake-vscode.ts` (as the repository holds it), `tests/helpers/firewall-arbitraries.ts` (new), `tests/unit/regression-fixture.test.ts`, `scripts/lib/secret-scan.mjs`.
  - Functions that belong to another group throw `Error('not implemented: <group>')`. Final signatures are those of the design's "Components and Interfaces". Later groups may add exports and may not change one.

  - [x] 1.1 Add the Studio contracts, principals and wiring
    - `contracts.ts`: the types of design Section 4. `model.ts`: add `toolRiskOf(workflow)` and make `buildWorkflowView` use it. `server.ts`: `StudioOptions.agentToken`, `StudioHandle.agentToken`, `principalOf(req)` returning `owner`, `agent` or nothing (agent only through the `x-studio-token` header), the `AGENT_ALLOWED` check answering 403 `This action needs you, not an assistant.` before any handler, services start and close, new `PlaygroundOptions` fields passed through. `agent-access.ts` complete (default deny; the not-allowed routes of design decision 5). `services.ts`, `inert-services.ts`, `routes/types.ts`, `routes/index.ts` register the four route stubs. `playground.ts`: option and result types only.
    - Create `sample-activity.ts` (`sampleAuditEntries`, `sampleApprovals`, `sampleTrace`), `messages/{approvals,activity,system}.ts` with the plain texts, and `mcp/tool-names.ts` with `STUDIO_MCP_TOOL_NAMES` (the thirteen names of Requirements 2 to 5).
    - Create the stubs `approvals-service.ts`, `activity-service.ts`, `browser-check.ts`, `daemonize-power.ts` and the four route stubs.
    - _Requirements: 1.4, 6.1, 6.8, 10.1, 12.1, 13.10, 14.3, 14.5, 16.2, 22.7_

  - [x] 1.2 Add the runtime stubs and the firewall markers
    - Create `approval-queue.ts`, `audit-log.ts`, `trace.ts`, `firewall.ts` in `src/replay/runtime/` with the final types and signatures (stubs throw `not implemented: G-B`). Each imports only `node:*` and its siblings.
    - Create `src/compiler/firewall-markers.ts`: `FW_MARK = '//#fw'`, `FirewallMeta`, and the line patterns used by the regression table.
    - _Requirements: 11.1, 11.9, 12.1, 15.1, 22.1, 28.6, 28.9_

  - [x] 1.3 Add the Studio UI seam
    - `index.html`: nav item `nav-activity` (outside the static demo's hidden set) and two `<link>` tags for `activity.css` and `timeline.css`. `features.js`: route `activity`. Empty-bodied `views/activity.js` (exporting `renderActivity`), `timeline.js` (exporting `renderTimeline`, `renderSimpleTimeline`), `approval-banner.js`, `copy-activity.js`, `copy-timeline.js`; stub `css/activity.css` and `css/timeline.css`.
    - Check that `scripts/copy-studio-ui.mjs` copies the new files and that `studio-ui-copy.test.ts` and `studio-ui-contrast.test.ts` scan them.
    - _Requirements: 16.1, 23.1, 27.1, 27.3_

  - [x] 1.4 Add the extension seam
    - `package.json`: every new command, the `daemonize.activity` view, the walkthrough `daemonize.getStarted` (six steps, completion events, media paths), `viewsWelcome` entries with mutually exclusive `when` clauses, activation events and menus. `package.nls.json` and `strings.ts`: every new text, using "New action" and "Create your first action" (RC-1) so the plain-language test passes. `types.ts`, `ports.ts`, `studio-api.ts` (`parsePowerInfo` reads `askBeforeChanges` only), `studio-url.ts` (route `activity`), `extension.ts` (calls each `register*`), the stubs and one-heading walkthrough media files, and `fake-vscode.ts` (`commands.getCommands`, `env.clipboard`, buttons on `showInformationMessage`, `withProgress`, `globalState`).
    - _Requirements: 9.1, 10.7, 17.1, 19.1, 20.1, 20.2, 20.3, 20.9, 21.6, 25.1, 27.2, 27.7_

  - [x] 1.5 Add the shared test arbitraries and secret-scan names
    - `tests/helpers/firewall-arbitraries.ts`: secret-like strings (`sk-...`, JWT shapes, base64 runs), text of 0 to 5000 characters, Unicode, strings with `"`, `\` and newline, argument objects with sensitive names, audit entries, approval requests, traces, leases, route sets. Other groups import it and do not edit it. No generated value is a real secret.
    - `scripts/lib/secret-scan.mjs`: add the names of the planned test files that plant fake credentials.
    - _Requirements: 30.11_

  - [x] 1.6 Extend the regression test with the named `//#fw` differences (required)
    - File: `tests/unit/regression-fixture.test.ts`. Add the `removeFromTexts(files)` hook next to `remove(snapshot)` and these named entries, each removing only what it names: runtime files of the firewall and trace (`approval-queue`, `audit-log`, `firewall`, `trace`, `.ts` and `.js`) from `files` of every option set; `trace.js` from `sandboxImage.copy`; `//#fw` lines matching the firewall import, `const FIREWALL =`, `const firewall =`, `async function approvalGate`, `const registerTool =` and `(server as any).tool =` from `*.mcp-server.ts.txt`; `//#fw` lines matching the `trace.js` import and `traceStep(index);` from `*.replay.ts.txt`; `//#fw` lines matching `enterTraceScope();` and `Object.assign(result, { trace:` from `*.replay.ts.txt`.
    - After all entries run, the test fails if any line ending with `//#fw` is left. The entries are no-ops while the lines are absent. Keep the existing three entries. Do not regenerate the expected snapshot files.
    - _Requirements: 18.7, 28.6, 30.5_

  - [x] 1.7 Verify the seam and commit CG-0
    - Run `npx tsc --noEmit` and the existing test suite; both must pass with the seam in place.
    - Commit with `git add` of the G0 paths only: `chore: seams for the Kiro-native agent and firewall` (CG-0). No `--no-verify`. Do not push.
    - _Requirements: 28.1, 28.4, 28.5_

- [x] 2. Checkpoint - G0 seam done and committed as CG-0
  - Require `npx tsc --noEmit`, the existing suite and the regression test to pass, and `git log -1` to show CG-0. No other group starts before this passes.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. G-B runtime: approval queue, audit log, trace, firewall (CG-1)
  - Owns: `src/replay/runtime/{approval-queue,audit-log,trace,firewall}.ts`, `tests/unit/{approval-queue,audit-log,trace,firewall,firewall-runtime-drift}.test.ts`, `tests/property/{approval-queue,audit-log,trace,firewall}.property.test.ts`, `tests/helpers/approver-sim.ts` (new).
  - Every runtime file imports only `node:*` and its siblings.

  - [x] 3.1 Implement the approval queue and the approver simulator
    - `approval-queue.ts`: record encode, decode and `verify` with HMAC-SHA256 over canonical JSON, key file `approvals/.key` (mode `0600`, created with `wx`), `reqMac` binding, `writeDecision` with `wx` (first wins, `written` or `exists`), `approverAvailable` (valid mac, `at` within 6 s, pid alive), `requestApproval` with its exits (approved, denied, timeout, withdrawn, unavailable; poll 250 ms; give up when the heartbeat is stale for 10 s), `parseApprovalTimeout` (default 120000, range 5000 to 600000), `listPending`, queue limit. A bad folder or wrong mac fails closed.
    - `tests/helpers/approver-sim.ts`: watches a queue folder and writes decisions through the real API, with a test-chosen delay and decision.
    - _Requirements: 11.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.11, 12.12_

  - [x] 3.2 Implement the audit log
    - `audit-log.ts`: `redactArguments` (copy of the `isSensitiveKey` pattern, declared secret names, resolved secret values, texts clipped to 200 characters), `formatAuditLine` and `parseAuditLine` (no newline, at most 16384 bytes, `steps` trimmed only when needed), `appendAudit` under the `audit/audit.lock` directory lock (stale after 10 s, 1 s of retries, entry dropped with one stderr line on failure), `applyRetention` (1000 entries or 1 MiB), `readAuditEntries` (skips corrupt lines, newest first).
    - _Requirements: 13.2, 15.1, 15.2, 15.5, 15.6, 15.7, 15.8, 15.10, 15.12, 15.13, 15.14_

  - [x] 3.3 Implement the trace
    - `trace.ts`: `traceStep(index)` marks, `enterTraceScope` with `AsyncLocalStorage` (two concurrent calls never mix), pure `buildTrace` (levels, skipped, healed, failed or drifted, `not_run` after the failing step or in a refused call, `NOT_REPEATED_NOTE` for a failed HTTP write step, 200 step cap with `truncated`, labels and notes scrubbed and at most 120 characters). `buildTrace` never produces the status `blocked` (RC-4).
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.9, 22.10, 22.12, 22.13_

  - [x] 3.4 Implement the firewall wrapper
    - `firewall.ts`: `wrap(name, handler)` validates the payload with the existing `validatePayload`, decides whether to ask (risk `write` or `delete`, `DAEMONIZE_ASK_BEFORE_CHANGES` exactly `true`, source not `studio`), asks through `approval-queue`, runs the untouched handler inside a trace scope only after `approved`, builds the Audit_Entry (`decision`, `outcome`, `cancelled` for withdrawn), removes `trace` unless `DAEMONIZE_TRACE` is `1`, and never lets a log failure change the result or skip the question. Refused calls answer `approval_denied`, `approval_timeout` or `approval_unavailable` with the plain messages and run no handler. Reserved argument keys never change the gate.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.10, 11.11, 12.5, 14.4, 15.3, 15.4, 15.8, 15.9, 15.11, 18.2, 18.3, 22.5, 22.6_

  - [x] 3.5 Write the fail-closed approval tests (required)
    - File: `tests/unit/firewall.test.ts`. With a counting fake handler and `approver-sim`: `denied` runs zero steps; `timeout` (short timeout) runs zero steps; no approver (no heartbeat, stale heartbeat, wrong mac, unusable folder) runs zero steps and answers within 5 s; `withdrawn` runs zero steps; `approved` runs the handler once with unchanged arguments; a `read` tool is never held; setting off and source `studio` create no request file. Each refused case writes the right Audit_Entry.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.10, 12.5, 15.3, 18.2_

  - [x] 3.6 Write the no-secret test for the Audit_Log (required)
    - File: `tests/unit/audit-log.test.ts`. Arguments with sensitive names, declared secret names and planted fake secret values (environment and vault) never appear in a written line, a read entry, the Redacted_Arguments or the text built for an approval; every text is at most 200 characters; retention at 1000 entries and 1 MiB; a corrupt line is skipped; concurrent appends never interleave.
    - _Requirements: 13.2, 13.14, 15.6, 15.7, 15.10, 15.12, 15.13_

  - [x]* 3.7 Write unit tests for the queue, the trace and the drift guard
    - Files: `tests/unit/approval-queue.test.ts`, `tests/unit/trace.test.ts`, `tests/unit/firewall-runtime-drift.test.ts` (compares the `SENSITIVE_KEY` source of `audit-log.ts` and `playground.ts`). Queue: first decision wins, wrong mac ignored, request after timeout not listed. Trace: examples for http, accessibility, vision, terminal, skipped, drifted and the 200 cap.
    - _Requirements: 12.4, 12.7, 12.12, 13.2, 22.1, 22.4_

  - [x]* 3.8 Write property tests for the approval queue
    - File: `tests/property/approval-queue.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 11: Approval records round trip and resist change**
    - **Feature: kiro-native-agent-and-firewall, Property 12: The first decision wins**
    - **Feature: kiro-native-agent-and-firewall, Property 13: Requests are independent**
    - **Feature: kiro-native-agent-and-firewall, Property 17: The approval timeout is bounded**
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.6, 12.7, 12.9, 12.11, 12.12**

  - [x]* 3.9 Write property tests for the audit log
    - File: `tests/property/audit-log.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 19: Shown text holds no secret and is bounded**
    - **Feature: kiro-native-agent-and-firewall, Property 20: An Audit_Entry round trips and fits one line**
    - **Feature: kiro-native-agent-and-firewall, Property 21: Retention keeps a suffix**
    - **Feature: kiro-native-agent-and-firewall, Property 22: Concurrent appends never interleave**
    - **Validates: Requirements 13.1, 13.2, 13.14, 15.2, 15.5, 15.6, 15.7, 15.10, 15.12, 15.13, 15.14, 22.9**

  - [x]* 3.10 Write property tests for the trace
    - File: `tests/property/trace.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 24: Trace invariants**
    - **Feature: kiro-native-agent-and-firewall, Property 25: Trace levels and statuses follow the result**
    - **Feature: kiro-native-agent-and-firewall, Property 26: Trace is opt-in and changes nothing else**
    - **Validates: Requirements 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.8, 22.10, 22.12, 22.13, 28.7**

  - [x]* 3.11 Write property tests for the firewall wrapper
    - File: `tests/property/firewall.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 14: A refused call runs nothing**
    - **Feature: kiro-native-agent-and-firewall, Property 15: Without a reason to ask, nothing changes**
    - **Feature: kiro-native-agent-and-firewall, Property 16: Validation comes first**
    - **Feature: kiro-native-agent-and-firewall, Property 18: Reserved arguments cannot change the gate**
    - **Feature: kiro-native-agent-and-firewall, Property 23: Decision and outcome follow the gate**
    - **Validates: Requirements 10.10, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.10, 12.5, 14.4, 15.3, 15.4, 15.8, 15.9, 15.11, 18.2, 18.3, 18.6, 28.7**

- [x] 4. G-C generated code: marked lines in the generator (CG-1)
  - Owns: `src/compiler/{mcp-generator,compiler,kiro-power-generator}.ts`, `tests/unit/{generator-firewall,generated-no-src-import}.test.ts`, `tests/property/generated-firewall.property.test.ts`, `tests/integration/firewall-e2e.test.ts`.

  - [x] 4.1 Add the marked lines to the generated code
    - `mcp-generator.ts`, through the existing `patchLines`, only lines that end with `FW_MARK`. `mcp-server.ts`: the `firewall.js` import, the embedded `FIREWALL` table (risk from `toolRiskOf`, write steps from `writeStepsOf`, declared secret names, step labels per tool, sorted so that a permutation of the workflows gives the same bytes), the `const firewall =` object, the wrapper of `server.tool`, and the one three-line function `approvalGate` that calls `requestApproval` of the copied runtime (RC-2). `replay.ts`: the `trace.js` import, one `traceStep(index);` in each step loop (web, `--http`, terminal, call-block variants), and in the container entry `enterTraceScope();` and `Object.assign(result, { trace: ... })`. A step skipped by `skippedSet` is marked first and skipped after. Existing lines are only added to, never edited.
    - _Requirements: 11.1, 11.8, 11.9, 11.12, 22.14, 28.6, 28.8_

  - [x] 4.2 Copy the runtime files and extend the generated SKILL.md
    - `compiler.ts`: copy `approval-queue`, `audit-log`, `firewall`, `trace` as `.ts` and `.js`; add `trace.js` to the container `copy` list (from `generateSandboxFiles`). `kiro-power-generator.ts`: the two generated `SKILL.md` paragraphs about "Ask before changes" and the Activity view. Compiling twice gives the same bytes.
    - _Requirements: 11.8, 18.1, 28.1, 28.8_

  - [x] 4.3 Write the old-generated-server compatibility test (required)
    - File: `tests/unit/generator-firewall.test.ts`. For the regression fixture, the generated `mcp-server.ts`, `replay.ts` and `docker-replay.ts` differ from the snapshot only by lines ending with `//#fw`; the tool names, descriptions, input schemas and OpenAPI document equal a compile without the table; compiling twice gives equal bytes; with the setting off, no data folder and no trace, a call through the compiled wrapper returns the same result as the unwrapped handler; a server compiled before this change (the snapshot text) still starts and answers.
    - _Requirements: 11.12, 18.1, 28.1, 28.2, 28.6, 28.7, 28.8_

  - [x] 4.4 Update the no-src-import guard (required)
    - File: `tests/unit/generated-no-src-import.test.ts`. Add the four new runtime files and keep the guard passing: no file copied next to `mcp-server.js` imports from `src/`.
    - _Requirements: 28.9, 30.8_

  - [x]* 4.5 Write property test for the embedded risk table
    - File: `tests/property/generated-firewall.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 31: Risk and write steps are embedded once and deterministically**
    - **Validates: Requirements 11.1, 11.12, 28.8**

  - [x] 4.6 Write the compiled-server fail-closed test (required, checkpoint-only)
    - File: `tests/integration/firewall-e2e.test.ts`, first line `// checkpoint-only: needs G-B`. Compile a fixture workflow, start the generated server with the SDK client against a local HTTP page (no Docker) and run: approve (replay runs), deny and timeout (zero steps), no approver (answers in under 5 s), a read tool (never held), and check the Audit_Entry of each case for `decision` and `outcome`. No secret value in any result or entry.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 12.5, 15.3, 15.6, 30.3_

- [x] 5. G-D Studio services, routes and Playground (CG-2)
  - Owns: `src/studio/{approvals-service,activity-service,playground,sample-playground}.ts`, `src/studio/routes/{approvals,activity}.ts`, `tests/unit/{approvals-service,activity-service,approvals-routes,studio-agent-access,playground}.test.ts`, `tests/property/studio-approvals-routes.property.test.ts`.

  - [x] 5.1 Implement the approvals service and routes
    - `approvals-service.ts`: heartbeat of `approver.json` every 2 s, list with the mac check and `secondsLeft`, decide through `writeDecision` (first wins), sweep of old files. `routes/approvals.ts`: `GET /api/approvals`, `POST /api/approvals/decide` (only `id` of 32 hex characters and `decision` of `approved` or `denied`; 400 otherwise; 404 for an unknown or ended id). Routes carry `remote: 'blocked'`, answer 409 in sample mode when they write, and pass `redactForStudio`.
    - _Requirements: 12.4, 12.8, 13.10, 13.11, 13.12, 14.3_

  - [x] 5.2 Implement the activity service and route
    - `activity-service.ts` and `routes/activity.ts`: `GET /api/activity` reads through `readAuditEntries`, newest first, `limit` 1 to 200, filters `tool` and `decision` (five values); an unknown query name, bad `limit` or bad `decision` answers 400 naming the field. The answer passes `redactForStudio`.
    - _Requirements: 16.2, 16.3, 16.9_

  - [x] 5.3 Update the Playground and the sample Playground
    - `playground.ts`: set `DAEMONIZE_CALL_SOURCE=studio`, `DAEMONIZE_DATA_DIR` and, when asked, `DAEMONIZE_TRACE=1` in the child environment (never written to an install entry); `summarizeResult` copies `trace` and `skippedSteps`; the Playground keeps its own `confirmation_required` dialog and still works when the server returns no `trace`. `sample-playground.ts`: the sample trace from `sampleTrace()`.
    - _Requirements: 15.11, 22.7, 22.11, 23.8, 23.13, 28.2, 28.4_

  - [x] 5.4 Update the Playground tests for an old server (required)
    - File: `tests/unit/playground.test.ts`. A result with no `trace` and no `skippedSteps` (an old generated server) is summarized with no error; with a trace the summary carries it; the three new child environment names are set only as the design says; secret-typed arguments stay `***`; `confirmation_required` is unchanged.
    - _Requirements: 18.4, 22.7, 23.8, 28.2, 28.4_

  - [x]* 5.5 Write unit tests for the services and routes
    - Files: `tests/unit/{approvals-service,activity-service,approvals-routes,studio-agent-access}.test.ts` (first line `// checkpoint-only: needs G-B` where the real queue is used). The agent token gets 403 on every route outside `AGENT_ALLOWED`; a second decision changes nothing.
    - _Requirements: 12.8, 13.11, 14.3, 16.2, 16.3_

  - [x]* 5.6 Write property tests for the routes
    - File: `tests/property/studio-approvals-routes.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 28: Decide accepts only a valid decision**
    - **Feature: kiro-native-agent-and-firewall, Property 29: Activity filters and errors**
    - **Feature: kiro-native-agent-and-firewall, Property 30: The agent principal is confined**
    - **Validates: Requirements 6.1, 12.8, 13.11, 14.3, 16.2, 16.3**

- [x] 6. G-S Ask before changes in the install (CG-2)
  - Owns: `src/studio/{power-installer,install-records,mcp-snippet}.ts`, `src/studio/routes/power.ts`, `src/studio/messages/power.ts`, `tests/unit/{power-installer,mcp-snippet,install-records}.test.ts`, `tests/property/ask-before-changes.property.test.ts`, `tests/integration/studio-power.test.ts`.

  - [x] 6.1 Add the record fields and the entry env keys
    - `install-records.ts`: optional `askBeforeChanges` and `askBeforeChangesChosen` (a record without the field reads as off). `mcp-snippet.ts`: write `DAEMONIZE_ASK_BEFORE_CHANGES` (`true` or `false`) and, when `true`, `DAEMONIZE_APPROVAL_TIMEOUT_MS=90000` (RC-3, documented as unverified for Kiro settings entries). Never write `DAEMONIZE_CALL_SOURCE` or `DAEMONIZE_TRACE`.
    - _Requirements: 10.2, 10.3, 10.4, 10.8, 12.2_

  - [x] 6.2 Add the default, the toggle route and the answers
    - `power-installer.ts`, `routes/power.ts`, `messages/power.ts`: the default is on when any tool has risk `write` or `delete` (through `toolRiskOf`) and no option is shown otherwise; a re-install keeps an explicit choice; `POST /api/power/approval` rewrites the entry and the record in one transaction and answers 400 for a non-boolean value with the files unchanged; `preview` and `install` answers add `askBeforeChanges` and `askBeforeChangesTools`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.9_

  - [x] 6.3 Update the install tests and check old installs (required)
    - Files: `tests/unit/{power-installer,mcp-snippet,install-records}.test.ts`. The two new env keys are asserted; a record written before this change reads as `askBeforeChanges` off, keeps working, and the entry for it writes no audit setting that turns the gate on; existing install, update and remove tests keep passing.
    - _Requirements: 10.8, 28.3, 28.4_

  - [x]* 6.4 Write property test for the setting
    - File: `tests/property/ask-before-changes.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 27: Ask before changes has a default, a memory and a strict input**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6**

  - [x]* 6.5 Write the integration test for the install route
    - File: `tests/integration/studio-power.test.ts`. Install with the setting on and off, toggle, a bad value answers 400, settings bytes unchanged on failure.
    - _Requirements: 10.4, 10.5, 10.6_

- [x] 7. G-U1 Activity view and approval banner (CG-2)
  - Owns: `src/studio/ui/js/{api,copy-activity,approval-banner}.js`, `src/studio/ui/js/views/activity.js`, `src/studio/ui/css/activity.css`, `scripts/build-studio-demo.mjs`, `tests/integration/studio-ui-activity.test.ts`, `tests/unit/studio-copy-activity.test.ts`.

  - [x] 7.1 Add the API helpers, copy, banner and styles
    - `api.js`: `approvals()`, `approvalDecide(id, decision)`, `activity(query)` and the static map entries `/api/activity` and `/api/approvals`. `copy-activity.js`: all new text in Plain_Language ("No calls yet. When Kiro uses one of your tools, it appears here."). `approval-banner.js`: tool, application, "Changes data", Redacted_Arguments, write steps, seconds left, Approve and Deny buttons with accessible names, and a live region announcing a new request and a changed decision. `css/activity.css` uses only existing `:root` tokens and a visible focus.
    - _Requirements: 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 27.1, 27.3, 27.4, 27.5_

  - [x] 7.2 Implement the Activity view
    - `views/activity.js`: `renderActivity(route)` with filters `tool` and `decision` kept in the hash, rows (time, tool, risk, decision, outcome, duration, as text and chip), an expandable row with Redacted_Arguments and, when `steps` exist, `renderSimpleTimeline(steps)`, the empty state, and no control that edits or deletes an entry.
    - _Requirements: 16.1, 16.4, 16.5, 16.6, 16.7, 16.8, 16.10, 16.11_

  - [x] 7.3 Write the sample data for the static demo
    - `scripts/build-studio-demo.mjs`: write `data/activity.json` and `data/approvals.json` from `sample-activity.ts` so the static demo shows the Activity view and a pending approval.
    - _Requirements: 27.6_

  - [x]* 7.4 Write tests for the Activity view and its copy
    - Files: `tests/integration/studio-ui-activity.test.ts`, `tests/unit/studio-copy-activity.test.ts` (Plain_Language lint, no literal colour). The view shows no control that edits or deletes an entry.
    - _Requirements: 16.11, 27.1, 27.3_

- [x] 8. G-E2 Activity summary and approvals in the extension (CG-2)
  - Owns: `kiro-extension/src/core/{approval-watcher,activity-model,activity-api}.ts`, `kiro-extension/src/core/models/kiro-model.ts`, `kiro-extension/src/ui/commands/approvals.ts`, `kiro-extension/src/ui/views/{activity-view,kiro-view}.ts`, `tests/extension/pure/{activity-model.property,approval-watcher}.test.ts`, `tests/extension/glue/{approvals,approvals-never-leak}.test.ts`.

  - [x] 8.1 Implement the pure core
    - `approval-watcher.ts` (poll every 2 s, new request detection), `activity-model.ts` (pending requests first, then at most 5 entries with the tool, one of four decision labels, "Worked" or "Failed" and a relative time; no argument value; "Start Daemonize to see activity" when no Studio runs; "Nothing yet" with no entry), `activity-api.ts` (reads only `GET /api/activity` and `GET /api/approvals`), `models/kiro-model.ts` (the Approval_Setting row and the Power rows). No `vscode` and no root `src/` import.
    - _Requirements: 10.7, 13.6, 17.1, 17.2, 17.4, 17.5, 17.7, 25.9_

  - [x] 8.2 Implement the commands and views
    - `ui/commands/approvals.ts`: the notification with Approve and Deny, and the commands that call `POST /api/approvals/decide`; `views/activity-view.ts`; `views/kiro-view.ts` (setting row and toggle, Power rows). No notification text holds an argument value.
    - _Requirements: 10.7, 10.9, 13.6, 13.8, 17.3, 17.6, 25.9_

  - [x]* 8.3 Write unit and glue tests for approvals
    - Files: `tests/extension/pure/approval-watcher.test.ts`, `tests/extension/glue/approvals.test.ts`, `tests/extension/glue/approvals-never-leak.test.ts` (no argument value or token in any notification or log).
    - _Requirements: 13.6, 17.7_

  - [x]* 8.4 Write property test for the Activity summary
    - File: `tests/extension/pure/activity-model.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 34: The Activity summary shows facts, not values**
    - **Validates: Requirements 17.1, 17.2, 17.4, 17.5, 17.7**

- [x] 9. G-U2 Replay_Timeline (CG-3)
  - Owns: `src/studio/ui/js/{timeline,copy-timeline}.js`, `src/studio/ui/css/timeline.css`, `src/studio/ui/js/views/playground.js`, `src/studio/ui/js/sim/{simulate.js,simulate.d.ts,static-session.js}`, `tests/property/studio-timeline.property.test.ts`, `tests/integration/studio-ui-timeline.test.ts`.

  - [x] 9.1 Implement the timeline component and its copy
    - `timeline.js`: `renderTimeline(trace)` with one list item per step (number, label, level text, duration, status text, thumbnail when one exists) and `renderSimpleTimeline(steps)`; labels escaped, no HTML from a label; drifted, skipped and not-run steps visible; `blocked` accepted and shown as "Blocked: not run again" (RC-4). `copy-timeline.js` in Plain_Language. `css/timeline.css` with `:root` tokens only.
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.9, 23.15, 27.1, 27.3_

  - [x] 9.2 Hook the timeline into the Playground and the static simulation
    - `views/playground.js` renders the timeline from the result `trace` (nothing when absent, for an old server); `sim/*` returns the sample trace in the static demo, with the failed write step carrying the not-repeated note.
    - _Requirements: 23.8, 23.10, 23.11, 23.12, 23.13, 23.14, 27.4, 27.6_

  - [x]* 9.3 Write property test for the timeline
    - File: `tests/property/studio-timeline.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 35: The timeline has one row per step and adds no markup**
    - **Validates: Requirements 23.1, 23.2, 23.15**

  - [x]* 9.4 Write the integration test for the timeline
    - File: `tests/integration/studio-ui-timeline.test.ts` (first line `// checkpoint-only: needs G-U1` where the Activity view is used). Rows, order, texts, and the Activity view's simplified timeline.
    - _Requirements: 23.1, 23.7, 23.13, 30.6_

- [x] 10. G-A Studio_MCP, lease and CLI (CG-4)
  - Owns: `src/cli/index.ts`, `src/cli/commands/{mcp,studio}.ts`, `src/studio/lease.ts`, `src/studio/mcp/{server,tools,connection,schemas,texts}.ts`, `tests/helpers/fake-studio.ts`, `tests/unit/{studio-mcp,studio-lease,cli-mcp,studio-machine}.test.ts`, `tests/property/{studio-mcp,studio-lease}.property.test.ts`, `tests/integration/studio-mcp.test.ts`.

  - [x] 10.1 Implement the Studio_Lease
    - `lease.ts`: file `leases/lease-<16 hex of sha256(workspace)>.json` (folder `0700`, file `0600`, atomic write, loopback listener only, never in sample mode), a total `readLease` (complete lease or nothing, never throws), the agent token only, removal at close and `exit`. Accept a lease only when the schema is complete, the origin is loopback, the process is alive and `GET /api/health` answers within 1.5 s; remove a stale file only when its content hash is unchanged.
    - _Requirements: 1.2, 1.4, 1.5, 1.8, 1.10_

  - [x] 10.2 Implement connection, schemas and texts
    - `connection.ts`: attach order (live lease, else `daemonize studio --machine` child), retry once on a network error, 20 s limit with the plain "Studio did not start" error naming "Show log", loopback origins only, token only in `x-studio-token`, stop an owned child within 5 s, workspace from `--workspace`, `DAEMONIZE_WORKSPACE` or `process.cwd()`, refusal of writing tools in the home folder or a drive root. `schemas.ts`: one closed JSON Schema per tool (`additionalProperties: false`), Ajv validators. `texts.ts`: plain titles, descriptions and messages.
    - _Requirements: 1.2, 1.3, 1.6, 1.7, 1.8, 1.9, 6.2, 6.7_

  - [x] 10.3 Implement the server and the thirteen tools
    - `server.ts` and `tools.ts`: low-level `Server` with `ListTools` and `CallTool`, names from `STUDIO_MCP_TOOL_NAMES`; read tools, recording tools, `compile` (waits up to 120 s), `test_action` (`confirmation_required` for `write` or `delete` without `confirm: true`, approval through the queue before the Playground call), `preview_kiro_install`, `install_to_kiro`, `update_action`, `delete_action`. Unknown field or bad value is refused before any request; answers pass `redactForStudio`, are cut at 20000 characters with `truncated: true`, errors are `isError: true` with plain text and no stack, path, address or token. No tool approves, decides, writes the vault or changes the setting.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.1, 6.3, 6.4, 6.5, 6.6, 6.8_

  - [x] 10.4 Add the `mcp` command, `--version` and the lease in `studio`
    - `cli/index.ts`, `commands/mcp.ts` (`daemonize mcp [--workspace <dir>]`, `console.log` rebound to stderr so stdout carries MCP messages only), `commands/studio.ts` (write and remove the lease; the handshake line is unchanged), `daemonize --version`. Existing commands, flags and default output stay as they are.
    - _Requirements: 1.1, 1.4, 19.6, 28.5_

  - [x] 10.5 Add the fake Studio test double
    - `tests/helpers/fake-studio.ts`: an `http` server that answers the documented routes from fixtures and records `(method, path, body, header)` so a test can assert zero requests.
    - _Requirements: 30.2_

  - [x] 10.6 Write the no-secret and closed-schema tests for MCP results (required)
    - File: `tests/unit/studio-mcp.test.ts`. With the fake Studio and planted fake secret values in Studio answers and error bodies: no tool answer holds a secret value, a path of the machine, an address, a token or a stack trace; the error text equals the redacted `error` text of the Studio; a bad or unlisted argument is refused with zero requests; the list of tools equals Requirements 2 to 5 and every schema is closed.
    - _Requirements: 2.5, 2.7, 2.10, 4.11, 6.2, 6.3, 6.6, 6.7, 6.8_

  - [x]* 10.7 Write unit tests for the lease, the CLI and the machine handshake
    - Files: `tests/unit/{studio-lease,cli-mcp,studio-machine}.test.ts`. A corrupt lease returns nothing; a stale lease is removed and replaced; `daemonize mcp` writes only MCP messages to stdout; the `--machine` handshake line is unchanged.
    - _Requirements: 1.1, 1.5, 1.9, 1.10, 28.5_

  - [x]* 10.8 Write property tests for the lease
    - File: `tests/property/studio-lease.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 1: Lease reader is total and round trips**
    - **Feature: kiro-native-agent-and-firewall, Property 2: A stale lease is never used**
    - **Feature: kiro-native-agent-and-firewall, Property 3: The token never leaves the loopback header**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 1.9, 1.10, 6.2**

  - [x]* 10.9 Write property tests for the Studio_MCP
    - File: `tests/property/studio-mcp.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 4: The tool list is exactly the specified list and every schema is closed**
    - **Feature: kiro-native-agent-and-firewall, Property 5: A bad argument is refused before any request**
    - **Feature: kiro-native-agent-and-firewall, Property 6: The Studio_MCP touches only allowed routes**
    - **Feature: kiro-native-agent-and-firewall, Property 7: Answers hold no secret, path, address or stack**
    - **Feature: kiro-native-agent-and-firewall, Property 8: An answer is bounded and valid**
    - **Feature: kiro-native-agent-and-firewall, Property 9: A change runs only after a human said yes**
    - **Feature: kiro-native-agent-and-firewall, Property 10: Tool answers and requests match the Studio's own data**
    - **Validates: Requirements 2.2, 2.3, 2.5, 2.7, 2.8, 2.9, 2.10, 3.1, 3.2, 3.7, 3.8, 4.1, 4.4, 4.5, 4.6, 4.7, 4.8, 4.11, 5.1, 5.3, 5.4, 5.6, 5.7, 5.8, 5.9, 5.10, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.8, 14.1, 14.5, 14.6**

  - [x] 10.10 Write the real-Studio integration test with no-secret checks (required, checkpoint-only)
    - File: `tests/integration/studio-mcp.test.ts`, first line `// checkpoint-only: needs G-B, G-D`. Start a real Studio over loopback with a temp workflow file and a stub Playground: attach through a real lease, the agent token is refused on `POST /api/approvals/decide`, `confirmation_required` is enforced, the approval wait works with `approver-sim`, and no answer of any tool holds a planted fake secret value or the token.
    - _Requirements: 4.6, 4.7, 4.8, 5.3, 6.6, 14.3, 30.2_

- [x] 11. G-P Daemonize Power install route (CG-4)
  - Owns: `src/studio/daemonize-power.ts`, `src/studio/routes/power-daemonize.ts`, `src/studio/messages/daemonize-power.ts`, `tests/unit/daemonize-power.test.ts`, `tests/property/daemonize-power.property.test.ts`, `tests/integration/studio-daemonize-power.test.ts`.

  - [x] 11.1 Implement the `/api/power/daemonize/*` routes
    - Plan, install and remove for scope `global` or `project`, reusing the all-or-nothing transaction of `power-fs.ts` (backup of the Kiro settings, no change when one write fails). Files come from the package's own `power/` folder; the entry uses the command of the located program; the same content writes nothing the second time and says so; an existing file with other content is reported for confirmation; only `${NAME}` placeholders and non-secret settings are written. Remove deletes only what was written and leaves other servers unchanged.
    - _Requirements: 9.4, 9.5, 25.2, 25.3, 25.4, 25.5, 25.6, 25.8, 25.10_

  - [x]* 11.2 Write unit tests for the Power install
    - File: `tests/unit/daemonize-power.test.ts`. Plan text, already-installed case, existing file with other content, a failing write rolls back.
    - _Requirements: 25.3, 25.4, 25.5_

  - [x]* 11.3 Write property test for install and remove
    - File: `tests/property/daemonize-power.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 36: Installing the Daemonize Power and removing it restores the settings**
    - **Validates: Requirements 25.3, 25.5, 25.8, 25.11**

  - [x]* 11.4 Write the integration test for the Power routes
    - File: `tests/integration/studio-daemonize-power.test.ts`, first line `// checkpoint-only: needs G-F1, G-F2` (reads the real `power/` folder).
    - _Requirements: 24.4, 25.3, 25.5_

- [x] 12. G-F1 Builder_Agent and Builder_Skill (CG-4)
  - Owns: `.kiro/agents/daemonize.md`, `.kiro/skills/daemonize-builder/SKILL.md`, `power/agents/daemonize.md`, `power/skills/daemonize-builder/SKILL.md`, `tests/unit/{agent-files,skill-file}.test.ts`.

  - [x] 12.1 Write the Builder_Agent
    - `.kiro/agents/daemonize.md` in the form of design Section 7: front matter with `name: daemonize`, a `description` of at most 200 characters, `tools: ["read", "@daemonize-studio"]` (no `write`, `shell`, `web` or `*`), `includeMcpJson`, `mcpServers["daemonize-studio"]` with `requestTimeout: 300000` and a YAML comment that Kiro's use of this value is unverified (RC-3), `resources`, `permissions.rules` (deny `shell` for `**` and `*`, deny `fs_write` `**`, allow `fs_read`, deny `fs_read` of the three App_Data_Dir locations, `mcp` allow for the seven read and recording tools, `mcp` ask for the six others), and a `welcomeMessage`; the body is the system prompt. Only fields of the Kiro configuration reference. `power/agents/daemonize.md` holds the same bytes.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 24.8_

  - [x] 12.2 Write the Builder_Skill
    - `.kiro/skills/daemonize-builder/SKILL.md` with front matter `name` and `description`, and the journey: goal, record, compile, test, confirm, install to Kiro, with secrets entered only by the user in Credentials, writes only after the user's word, `drifted` reported, call again after a client timeout. Every tool name it mentions is in `STUDIO_MCP_TOOL_NAMES`. `power/skills/daemonize-builder/SKILL.md` holds the same bytes.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_

  - [x]* 12.3 Write tests for the agent and skill files
    - Files: `tests/unit/{agent-files,skill-file}.test.ts`: front matter parses as YAML, every field name is in the configuration reference list, no `allow` rule for `shell` or `fs_write`, tool names equal the Studio_MCP list, the two copies are byte-equal, no secret pattern from `findPlainSecrets`.
    - _Requirements: 7.12, 8.9, 30.7_

- [x] 13. G-E1 "Build a tool with the Daemonize agent" (CG-4)
  - Owns: `kiro-extension/src/core/{chat-launch,power-api}.ts`, `kiro-extension/src/ui/commands/agent.ts`, `kiro-extension/scripts/bundle.mjs`, `kiro-extension/.vscodeignore`, `tests/extension/pure/chat-launch.test.ts`, `tests/extension/glue/agent-command.test.ts`, `tests/extension/packaging.test.ts`.

  - [x] 13.1 Implement the agent command and the Power API client
    - `chat-launch.ts`: pure choice from `CHAT_OPEN_COMMANDS` (data; `workbench.action.chat.open` with `{ query: "/daemonize " }` as the one candidate) probed through `vscode.commands.getCommands()`, else the documented fallback text including "You can also type /daemonize." `power-api.ts`: calls the `/api/power/daemonize/*` routes with the owner token. `ui/commands/agent.ts`: `daemonize.buildWithAgent`. Plain-language text only.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 13.2 Bundle the templates
    - `scripts/bundle.mjs` copies `power/agents/daemonize.md` and `power/skills/daemonize-builder/SKILL.md` into `kiro-extension/templates/`; `.vscodeignore` lets only those into the package. The extension bundles no `playwright` and no `node-pty`.
    - _Requirements: 9.8, 24.11_

  - [x]* 13.3 Write unit and glue tests
    - Files: `tests/extension/pure/chat-launch.test.ts`, `tests/extension/glue/agent-command.test.ts`.
    - _Requirements: 9.2, 9.3_

  - [x]* 13.4 Write the packaging test
    - File: `tests/extension/packaging.test.ts`, first line `// checkpoint-only: needs G-F1`. Template bytes equal `power/agents/daemonize.md` and `power/skills/daemonize-builder/SKILL.md`; no `playwright` or `node-pty` in the package.
    - _Requirements: 9.8, 24.11_

- [x] 14. G-O Browser check route (CG-5)
  - Owns: `src/studio/browser-check.ts`, `src/studio/routes/system.ts`, `tests/unit/browser-check.test.ts`.

  - [x] 14.1 Implement `GET /api/system/browser`
    - `browser-check.ts`: starts the same launch chain as a replay (`launchReplayBrowser`: Playwright Chromium, Chrome, Edge or `DAEMONIZE_CHROMIUM_PATH`), closes the browser at once, caches the answer for 30 s, answers a browser name and never a path. `routes/system.ts` is `remote: 'blocked'`, read-only, and passes `redactForStudio`.
    - _Requirements: 19.9, 19.10_

  - [x]* 14.2 Write unit tests for the browser check
    - File: `tests/unit/browser-check.test.ts` with an injected launcher: found, not found, cache for 30 s, no path in the answer.
    - _Requirements: 19.9, 19.10_

- [x] 15. G-E3 One-click install, walkthrough and welcome (CG-5)
  - Owns: `kiro-extension/src/core/{cli-locator,cli-installer,install-constants,welcome-model}.ts`, `kiro-extension/src/ui/commands/onboarding.ts`, `kiro-extension/src/ui/context-keys.ts`, `kiro-extension/media/walkthrough/*.md`, `tests/extension/pure/{cli-locator,cli-installer,welcome-model,onboarding.property}.test.ts`, `tests/extension/static/manifest.test.ts`.

  - [x] 15.1 Implement the locator, the constants and the installer
    - `cli-locator.ts`: pure, same answer for the same input, first match wins among `daemonize.cliPath`, the extension-owned folder, the workspace `node_modules`, the PATH. `install-constants.ts`: `DAEMONIZE_PACKAGE`. `cli-installer.ts`: `npm install --prefix <globalStorage>/cli.new-<rand> --no-audit --no-fund <PACKAGE>` through `node` plus `npm-cli.js` with an argument array and no shell, check `--version` and that `studio --help` lists `--machine`, then rename to `cli`; a failure shows the redacted npm tail. Neither core file imports `vscode` or the root `src/`.
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.12, 19.13_

  - [x] 15.2 Implement the welcome function, the context keys and the walkthrough media
    - `welcome-model.ts`: pure `welcomeFor(state)` over (program found, browser found, number of actions, number of installs) with the texts "Create your first action", "Show Daemonize the first thing you do in your software." and the buttons "New action" and "Build a tool with the Daemonize agent" (RC-1). `context-keys.ts` sets `daemonize.cliFound`, `daemonize.browserMissing`, `daemonize.actionCount`, `daemonize.installCount`. `media/walkthrough/*.md`: the six step pages in Plain_Language.
    - _Requirements: 20.2, 20.5, 20.8, 20.9, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8_

  - [x] 15.3 Implement the onboarding commands
    - `ui/commands/onboarding.ts`: `daemonize.installCli`, the browser check command, "Daemonize: Get started", and the first-run opening of the Walkthrough once (flag in global state, never in a workspace file).
    - _Requirements: 19.3, 19.9, 19.11, 20.6, 20.7_

  - [x]* 15.4 Write unit tests and the manifest test
    - Files: `tests/extension/pure/{cli-locator,cli-installer,welcome-model}.test.ts` (installer with fakes), `tests/extension/static/manifest.test.ts` (unique step ids, declared commands, completion events, media paths, and that exactly one `viewsWelcome` `when` clause matches each state).
    - _Requirements: 19.2, 19.3, 19.4, 20.10, 21.8_

  - [x]* 15.5 Write property tests for the locator and the welcome state
    - File: `tests/extension/pure/onboarding.property.test.ts`.
    - **Feature: kiro-native-agent-and-firewall, Property 32: The locator is pure and ordered**
    - **Feature: kiro-native-agent-and-firewall, Property 33: The welcome state is a pure function**
    - **Validates: Requirements 19.1, 19.13, 21.1, 21.2, 21.3, 21.4, 21.8**

- [x] 16. G-F2 Power folder and dogfooding guide (CG-6)
  - Owns: `power/{POWER.md,plugin.json,mcp.json}`, `power/steering/daemonize-rules.md`, `.kiro/settings/mcp.json.example`, `.gitignore`, `docs/dogfooding.md`, `tests/unit/{power-folder,dogfooding-doc}.test.ts`.

  - [x] 16.1 Write the Power files
    - `power/POWER.md` (front matter `name: "daemonize-studio"`, `displayName: "Daemonize"`, `description`, `keywords`), `plugin.json` (`name`, `version`, `description`, `author`, `keywords`, `$schema`), `mcp.json` (`mcpServers["daemonize-studio"]` of `type: "stdio"`, `command: "daemonize"`, `args: ["mcp"]`, `env: {}`; RC-12), and `steering/daemonize-rules.md` (secrets only in Credentials, writes need the user's word, report `drifted`, plain language). The same kebab-case name is in the three places. The agent and skill copies from G-F1 are the files of `power/`. No value matches a secret pattern.
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10, 24.12_

  - [x] 16.2 Write the settings example, `.gitignore` and the dogfooding guide
    - `.kiro/settings/mcp.json.example` with the Studio_MCP entry (placeholders only); `.gitignore` keeps the real `.kiro/settings/mcp.json` out. `docs/dogfooding.md`: plain steps and commands with the expected result of each, for the Builder_Agent recording, compiling and testing an action on `examples/adminer`, and which parts were not done with the agent. The table headed "Calls recorded during development" is **left empty** and the document says why: the calls have not happened yet and the maintainers fill it from the Audit_Log. No secret, token or absolute user path.
    - _Requirements: 26.1, 26.2, 26.3, 26.4_

  - [x]* 16.3 Write tests for the Power folder and the guide
    - Files: `tests/unit/{power-folder,dogfooding-doc}.test.ts`: JSON parses with required keys, names agree, paths exist, no secret; every Studio_MCP tool name in `docs/dogfooding.md` exists in the Studio_MCP list.
    - _Requirements: 24.12, 26.5, 30.7_

- [x] 17. G-E4 Install and remove the Daemonize Power from the extension (CG-6)
  - Owns: `kiro-extension/src/ui/commands/power.ts`, `tests/extension/glue/install-power.test.ts`.

  - [x] 17.1 Implement `daemonize.installPower` and `daemonize.removePower`
    - Ask for the Install_Scope, show the plan in plain words before any write, confirm, install through the Studio route (G-E1 `power-api`), ask before replacing a differing file and leave it unchanged on decline, say plainly when the Power is already installed, tell the user to reload the window or enable the server and offer "Build a tool with the Daemonize agent". Removal removes only what was written. No secret value, no token.
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10_

  - [x]* 17.2 Write the glue test
    - File: `tests/extension/glue/install-power.test.ts`, first line `// checkpoint-only: needs G-P`. Install then remove returns the settings to their earlier content; a decline changes nothing.
    - _Requirements: 25.4, 25.8, 25.11_

- [x] 18. G-Z README and amended requirements (CG-7, last)
  - Owns: `README.md`, `kiro-extension/README.md`, `.kiro/steering/{structure,tech}.md`, `.kiro/specs/kiro-native-agent-and-firewall/requirements.md`, `tests/unit/readme-built-with-kiro.test.ts`.
  - Starts only after every other group reports done.

  - [x] 18.1 Rewrite "Built with Kiro" and add the sections
    - `README.md`: the section "Built with Kiro" as a table with the columns "Kiro feature", "What we did", "Why it mattered" and "Numbers", with a row for every spec folder of `.kiro/specs/` by name, the steering files, the four hooks, the defects found by property tests, the sub-agents, the Builder_Agent, the Builder_Skill, the Studio_MCP and the Daemonize_Power. Every count is computed from the repository on the day. Add "How MCP extended Kiro while we built this" (linking `docs/dogfooding.md`), "What Kiro did not do" (what was written or fixed by hand, discarded agent output, Kiro features not used, and the two unverified assumptions: the per-call timeout of a settings entry and the working directory of a Kiro-started server), and numbered steps to install the Daemonize_Power and pick the Daemonize agent. Update `kiro-extension/README.md` and the steering files `structure.md` and `tech.md`. No secret, no token, no claim the tests do not support.
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7_

  - [x] 18.2 Amend requirements 20.2 and 21.1 to the RC-1 wording
    - In `.kiro/specs/kiro-native-agent-and-firewall/requirements.md`: Requirement 20.2 step 3 "Record your first action" becomes "Create your first action"; Requirement 21.1 sentence "Record the first thing you do in your software." becomes "Show Daemonize the first thing you do in your software." and the button "Record an action" becomes "New action". Change nothing else, then call `validate_spec_format` on the file.
    - _Requirements: 20.2, 21.1_

  - [x]* 18.3 Write the README table test
    - File: `tests/unit/readme-built-with-kiro.test.ts`: every spec folder of `.kiro/specs/` appears by name in the table, every file path named in the table exists, and the hooks named equal the files of `.kiro/hooks/`.
    - _Requirements: 29.8_

- [x] 19. Final checkpoint - verification suite, then commits CG-1 to CG-7
  - Run `git status --porcelain` and require that it lists only files of the ownership lists above (a file touched by two groups, or by none, is fixed first).
  - Run, in order, each with exit code 0, and report the exact result (exit code and pass or fail counts) of each:
    - repository root: `npm run build`, `npx tsc --noEmit`, `npm run check:secrets`, `npm run studio:build`;
    - `kiro-extension/`: `npm run typecheck`, `npm run build`, `npm run package`;
    - repository root: `$env:DAEMONIZE_REQUIRE_EXTENSION_BUILD='1'; npm test` (this also runs the checkpoint-only tests).
  - Read the regression test output: every removed line of the three generated files is accounted for by a named entry and no `//#fw` line is left.
  - Commit CG-1 to CG-7 in order (CG-0 is already done after G0), `git add` of the paths of their groups only, no `--no-verify`:
    - CG-1 `feat(firewall): approval gate, audit log and trace in the generated server` (G-B, G-C)
    - CG-2 `feat(firewall): ask before changes in the Studio and in Kiro` (G-D, G-S, G-U1, G-E2)
    - CG-3 `feat(studio): replay timeline in the Playground and the Activity view` (G-U2)
    - CG-4 `feat(agent): Studio_MCP, Builder_Agent and Builder_Skill` (G-A, G-P, G-F1, G-E1)
    - CG-5 `feat(onboarding): one-click install, browser check, walkthrough and welcome` (G-O, G-E3)
    - CG-6 `feat(power): Daemonize Power, install command and dogfooding guide` (G-F2, G-E4)
    - CG-7 `docs: Built with Kiro as a feature table` (G-Z, including the amended requirements.md)
  - Do not push unless the user asks. Report the commits, open points OP-6 to OP-9, the conflicts that still need a decision, and the two unverified assumptions.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. The required tests are listed in the Overview.
- Each task references specific requirements for traceability.
- Property tests validate universal correctness properties; unit tests validate examples and edge cases.
- A test marked `checkpoint-only` runs at the final checkpoint because it needs another group's real code.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.5", "1.6"] },
    { "id": 2, "tasks": ["1.7"] },
    { "id": 3, "tasks": ["3.1", "3.2", "3.3", "4.1", "4.2", "5.1", "5.2", "5.3", "6.1", "7.1", "7.3", "8.1", "9.1", "10.1", "10.2", "10.5", "11.1", "12.1", "12.2", "13.1", "13.2", "14.1", "15.1", "15.2"] },
    { "id": 4, "tasks": ["3.4", "3.6", "3.7", "3.8", "3.9", "3.10", "4.3", "4.4", "4.5", "5.4", "6.2", "7.2", "8.2", "9.2", "10.3", "10.8", "11.2", "11.3", "12.3", "13.3", "14.2", "15.3", "16.1", "16.2", "17.1"] },
    { "id": 5, "tasks": ["3.5", "3.11", "4.6", "5.5", "5.6", "6.3", "6.4", "6.5", "7.4", "8.3", "8.4", "9.3", "9.4", "10.4", "10.6", "10.9", "13.4", "15.4", "15.5", "16.3", "17.2"] },
    { "id": 6, "tasks": ["10.7", "10.10", "11.4"] },
    { "id": 7, "tasks": ["18.1", "18.2"] },
    { "id": 8, "tasks": ["18.3"] }
  ]
}
```
