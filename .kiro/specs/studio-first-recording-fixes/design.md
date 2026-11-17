# Studio First Recording Fixes Bugfix Design

## Overview

A first recording of a real Next.js 15 / React 19 app (TOTP login, live search) exposed three groups of defects. Each group has its own files, so the implementation splits into three parallel groups (G1, G2, G3) that edit disjoint files.

- **A1, phantom HTTP secrets (G1).** In a server compiled with `--http`, `replayCore` checks the `{"$secret":NAME}` references of every recorded request before it knows which steps run over HTTP. The login steps stay on `ui`, yet the call fails with `missing_secret`. `secretEnvNames()` lists the same names for the tool description, `mcp.json`, `SKILL.md` and the Kiro power, and Studio lists them as required without a configured/missing state. Fix: compute `planSteps` first and use only the `http` steps; give `secretEnvNames` an `options` argument; add a mode-aware, status-aware secret list to the Studio model.
- **A2, recording panel and losses (G2).** The page shows no recording indicator, the "Make variable" chip survives route changes and loses the "Mark result" button, live-search text is not flushed, and a closed window after a marked result zone loses every step. Fix: one persistent floating panel owned by `capture-script.ts`, a `__daemonizeFinish` binding that ends the session on an open page, a debounced flush of typed text, and a recovery rule in `record.ts` that writes `<out>.recovery.json` for every failure after steps exist.
- **A3, SPA correlation and Studio polish (G3).** A navigation click receives a mount `GET` of the new screen as its HTTP recipe, the VARIABLES table wraps `{{query}}` over three lines, and nothing says which steps write. Fix: a pure rule module `navigation-rule.ts` that drops read requests of a screen-navigation click, CSS and markup changes in the workflow view, and a write-step list in the workflow view and the playground confirmation dialog.

Hard constraints that hold for every group: the generated runtime files (`replay.ts`, `docker-replay.ts`, `http-replay.ts`, `step-plan.ts` and the other copied modules) never import from `src/`; `capture-script.ts` stays one injected string; Studio security (token, Host and Origin checks, `x-studio-request`, CSP, `redactForStudio`) is unchanged and no secret value is ever returned.

### Corrections to the first requirements draft

The first draft of `bugfix.md` only grepped the code. Reading the files showed these differences, now corrected in `bugfix.md` (numbering kept):

| Draft claim | What the code does | Effect on the design |
|---|---|---|
| Without `--http`, the generated server requires HTTP secrets (1.2) | `WEB_RUNTIME` (no `--http`) has no HTTP secret check and `docker-replay.ts` has empty `HTTP_*`. Only `secretEnvNames` lists them | 2.2 becomes a listing fix plus a regression test. No runtime change for the no-`--http` case |
| Only `replayCore` is affected | `docker-replay.ts` of a `--http` server (`HTTP_MISSING_SECRETS`, `HTTP_SECRET_VARIABLES`) checks all steps too | Fixed in the same `mcp-generator.ts` change |
| The chip "survives SPA navigation" because of a missing reset | The script has no `pushState`, `popstate` or Navigation API hook at all. Only the 15 s timer removes the chip | The panel adds the route-change hook (Navigation API with a `history` patch fallback) |
| The write badge "and warning" lack step detail | `workflows.js` has only `riskBadge(highest)`. No warning text exists | G3 adds the note |
| Studio secrets come from `secretNames()` | `secretNames()` reads `redacted[].secret`, query and headers but not the body `$secret`; `httpSecretNames` reads all three | The new model function uses `httpSecretNames` and the plan |
| `record-tui.ts` may share the loss-on-close defect | Its `readResultZone` reads the in-memory terminal screen, which stays readable after the pty exits. It has no window to close | Excluded (see 3.13) |
| The existing tests only need "a chip" | `live-recorder.test.ts`, `cli.test.ts` and `result-zone.test.ts` locate `[data-daemonize-action=...]`, and call `page.locator('[data-daemonize-ui]').textContent()` in strict mode, which needs exactly one match | One root `data-daemonize-ui` element per frame (see A2) |

## Glossary

- **Bug_Condition (C)**: The condition that triggers a defect. Defined per group below (`isBugCondition_A1`, `_A2`, `_A3`).
- **Property (P)**: The behavior wanted when the bug condition holds.
- **Preservation**: Behavior for inputs outside the bug condition. It must be identical before and after the fix.
- **replayCore**: The function in the generated `replay.ts` (`WEB_RUNTIME_HTTP` in `src/compiler/mcp-generator.ts`) that runs one call.
- **planSteps**: `src/replay/runtime/http-replay.ts`. Returns `http`, `prep` or `ui` per step, and makes every step up to the last `ui` step `ui`.
- **HTTP-planned step**: A step with `planSteps(steps)[i] === 'http'`. Only these steps read `$secret` references at run time.
- **secretEnvNames**: `src/compiler/tool-description.ts`. The list of `DAEMONIZE_SECRET_<NAME>` names a workflow needs.
- **Compiled mode**: `ui-only` (compiled without `--http`) or `http` (compiled with `--http`), read by Studio from the output directory.
- **Recording panel**: The persistent floating panel of the capture script. One root element with `data-daemonize-ui`.
- **Offer**: The "Make variable" proposal bound to the last typed or selected field of the current route.
- **End path**: `LiveRecorder.requestEnd(reason)` resolving `LiveRecorder.ended`, which `record()` awaits. The panel, an `AbortSignal` and a future Studio recording all go through it.
- **Recovery file**: `<out>.recovery.json`, a valid workflow set written by `saveWorkflow()` when a recording cannot complete.
- **Screen navigation**: A click after which the route (`origin + pathname`) of the page differs from the route before it.
- **Mount request**: A read request the new screen sends when it renders. It is not the action of the click.
- **Write step**: A step whose `risk` is `write` or `delete`.

## Bug Details

### Bug Condition

**A1.** The bug manifests when a workflow has a step with `$secret` references in `step.http` that the compiled mode does not execute over HTTP. The runtime (`replayCore`, `docker-replay.ts` host side) checks them anyway, and the listings (`secretEnvNames`, Studio model) name them.

**A2.** The bug manifests when a recording session has no visible panel, offers a field from an earlier route, loses the result button after a variable is made, does not flush a live search, or ends with steps recorded and neither the workflow nor the recovery file written.

**A3.** The bug manifests when a click changes the route, carries no variable, and the only reads after it are mount requests of the new screen, or when Studio shows write steps and variable names without the detail described in 2.14 to 2.16.

**Formal Specification:**
```
FUNCTION isBugCondition_A1(X)
  INPUT: X of type CompileOrStudioInput { workflow, options: { http: boolean }, plan = planSteps(workflow.steps) }
  OUTPUT: boolean

  RETURN EXISTS i IN X.workflow.steps WHERE
         httpSecretNames(X.workflow.steps[i].http) IS NOT EMPTY
         AND (X.options.http != true OR X.plan[i] != 'http')
         AND secretEnvName IS NOT ALSO NEEDED BY secretRef, secrets list, or an HTTP-planned step
END FUNCTION

FUNCTION isBugCondition_A2(X)
  INPUT: X of type RecordingSession
  OUTPUT: boolean

  RETURN X.panelMissing
      OR X.offerFieldFromPreviousRoute
      OR X.markResultButtonRemoved
      OR X.variableNameTruncated
      OR (X.textTyped AND X.quietMs >= 600 AND NOT X.flushed)
      OR (X.stepCount > 0 AND X.sessionEnded AND NOT X.workflowOrRecoveryWritten)
END FUNCTION

FUNCTION isBugCondition_A3(X)
  INPUT: X of type ClickStepWithRequests { step, nav: { from, to }, used, submit, requests }
  OUTPUT: boolean

  RETURN X.step.actionType = 'click'
         AND NOT X.submit
         AND routeKey(X.nav.from) != routeKey(X.nav.to)
         AND X.used IS EMPTY
         AND EXISTS r IN X.requests WHERE NOT isWrite(r.method)
END FUNCTION
```

### Examples

- **A1.** A 2FA login records `POST /api/auth/login/verify` with `{"challengeToken":{"$secret":"CHALLENGE_TOKEN"},"totp":{"$secret":"TOTP"}}`. The workflow ends with a search `GET`, so `planSteps` is `['ui','ui','ui','http']`. Expected: the call runs and needs only the secrets of the typed fields and of the HTTP-planned search step. Actual: `missing_secret` for `DAEMONIZE_SECRET_CHALLENGE_TOKEN` and `DAEMONIZE_SECRET_TOTP` after 0 ms.
- **A1, no `--http`.** The same workflow compiled without `--http`. Expected: the tool description, `mcp.json` env and `SKILL.md` list only typed and declared secrets. Actual: they also list the two phantom names.
- **A1, Studio.** The workflow view shows "4 secrets needed" with no state. Expected: the required list shows `configured` or `missing` for each name (names only), and recipe-only names appear under "Recorded in HTTP recipes, not read by this server".
- **A2, offer.** The user types the email on `/connexion`, then the route becomes `/clients`. Expected: no offer. Actual: the chip for the email stays for 15 s.
- **A2, live search.** The user types `ada` in the client search box and pauses. Expected: a `type` step with `ada` is recorded after 600 ms and the offer names the search box. Actual: nothing is recorded until blur.
- **A2, window X.** The user marks a result zone, then closes the window. Expected: `.recovery.json` exists with every step and the unchecked zone, and the error names the file. Actual: no file.
- **A3.** Clicking `<a href="/clients">` loads `/clients`, which sends `GET /api/merchants/audience`. Expected: the step has no recipe and reports "screen navigation". Actual: that `GET` is its recipe.
- **A3, edge.** Clicking a link that sends `POST /api/logout` keeps the `POST` as a candidate. A click that changes only `?q=` (same pathname) is not a screen navigation.
- **A3, Studio.** `{{query}}` renders on three lines. A workflow whose only write is the login submit shows only a `write` badge.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- An HTTP-planned step of a `--http` server still requires, resolves and scrubs its `$secret` names and still returns `missing_secret` when one is absent (3.1).
- `secretRef`, the `secrets` list, TOTP steps and `COOKIE_HEADER_VARIABLE` are listed and required as before (3.2).
- Studio exposes secret names and configured/missing state only, and its security checks are unchanged (3.3, 3.9).
- Recorded steps, anchors, row bindings, thumbnails, `switch_page` steps, screen hashes and recorded results are the same with and without the panel (3.4, 3.6).
- `selectRecipe`, `isFollowUpRead`, `followUpReads` and `network-capture.ts` are not modified, and requests that carry a variable or write are captured as before (3.5).
- Alt+Shift+R, Enter in the terminal, `options.drive`, and closing the window with no marked zone end the recording as before (3.7). Zero recorded steps still fails with "Nothing had been recorded yet" and writes no file (3.8).
- Read-only workflows show no write warning; the playground still requires `confirm: true` for write and delete tools (3.10).
- Test hooks stay: one `data-daemonize-ui` root per frame, the `data-daemonize-action` values and the "Make variable" button name (3.12).

**Scope:**
All inputs that do NOT satisfy a bug condition above are unaffected. This includes:
- Workflows whose `$secret` names all belong to HTTP-planned steps of a `--http` server.
- Typed text recorded by blur or Enter, clicks, selects, hovers and popups.
- Clicks that carry a variable, submit steps, and write requests.
- `record-tui.ts` and terminal workflows.

## Hypothesized Root Cause

1. **Secret check before the plan (A1).** In `WEB_RUNTIME_HTTP`, `missingHttpSecrets(steps, …)` runs at the top of `replayCore` and `const plan = planSteps(steps)` runs later. The check cannot know which steps are `http`. `docker-replay.ts` has no plan at all. `secretEnvNames` has no `options` argument, so it cannot know the mode. `kiro-power-generator.ts` calls `set.workflows.flatMap(secretEnvNames)`, which would pass the array index as the new second argument if the signature only gained a parameter.
2. **No mode in the Studio model (A1).** `secretNames()` has no access to `flags.http` or the plan, and the PlaygroundSession environment is never consulted, so no status exists.
3. **Timer-only chip, no route hook (A2).** `showChip` clears itself after `CHIP_LIFETIME_MS`. `askName` rebuilds the chip with `box.textContent = ''`. The input has a fixed width. There is no `input` listener, so text is flushed only on `change` and Enter. The session end waits on the terminal or on the window, never on the page.
4. **Post-session steps are not covered by the recovery rule (A2).** `interrupted()` is reached only for `BrowserStoppedError`. Any other error thrown after the session ends (`readResultZone` on a closed page, `finalizeNetwork`, `saveWorkflow`) escapes. `interrupted()` also calls `recorder.finish()` without the marked zone.
5. **No route knowledge in the recorder (A3).** `finalizeNetwork` sees only requests per action id. `selectRecipe` accepts any GET with a recipe when `used` is empty, so a mount `GET` of the next screen qualifies.
6. **CSS (A3).** `.chip { white-space: normal; overflow-wrap: anywhere }` and a four-column table in a 320 px column. The name cell shrinks to min-content and the chip breaks at each character group.
7. **Write detail is not in the view model (A3).** `WorkflowView.risk` has counts and `highest` only, and the tool list passes `risk.highest` to the playground.

## Correctness Properties

Property 1: Bug Condition - Only HTTP-planned steps need HTTP secrets

_For any_ workflow and compiled mode where isBugCondition_A1 holds, the fixed generator and runtime SHALL NOT require, check, forward, scrub or list the `$secret` names that belong only to steps not executed over HTTP: `replayCore` and the host side of `docker-replay.ts` pass only steps with `plan[i] === 'http'` to `missingHttpSecrets`, `httpSecretValues` and `HTTP_SECRET_VARIABLES`, and `secretEnvNames(workflow, { http })` (and so the tool description, `mcp.json` env, `SKILL.md` and the Kiro power) lists such names only when `http === true` and the step is HTTP-planned.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Secrets that are used stay required

_For any_ workflow where isBugCondition_A1 does NOT hold for a name, the fixed code SHALL produce the same result as the original code for that name: HTTP-planned `$secret` names of a `--http` server, `secretRef` names, entries of `secrets`, TOTP steps and `COOKIE_HEADER_VARIABLE` are listed, required (`missing_secret` when absent) and scrubbed exactly as before.

**Validates: Requirements 3.1, 3.2, 3.14**

Property 3: Bug Condition - Studio shows the secrets of the compiled mode with a status

_For any_ workflow, `flags.http` value and set of environment names, the fixed Studio model SHALL return as `secrets` exactly the names of `secretEnvNames(workflow, { http: flags.http })` (without the prefix), SHALL return the recorded-but-unused HTTP names as `unusedSecrets`, and SHALL give each required secret `status: 'configured'` when its `DAEMONIZE_SECRET_<NAME>` is non-empty in the environment the PlaygroundSession passes to the child and `status: 'missing'` otherwise, carrying names and statuses only.

**Validates: Requirements 2.4**

Property 4: Preservation - Studio never exposes a value and its security is unchanged

_For any_ environment values, the fixed Studio responses SHALL contain no secret value, and the token, Host, Origin, `x-studio-request` and CSP behavior SHALL remain exactly as before.

**Validates: Requirements 3.3, 3.9**

Property 5: Bug Condition - The recording panel, the offer, the live flush and the finish binding

_For any_ sequence of page events (type in a field, select, SPA route change, full navigation, collapse, choose result, cancel) where isBugCondition_A2 would hold in the original code, the fixed capture script SHALL keep one panel root present with a "Recording" indicator, step counter, "Choose the result to capture" button and "Finish and save" button after every event; SHALL hold an offer equal to the last typed or selected field of the current route, or none after a route change or an input in another field; SHALL record a typed text 600 ms after its last `input` event (updating the same step when no other step intervened); and SHALL end the session through `__daemonizeFinish` with the page still open.

**Validates: Requirements 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.12**

Property 6: Bug Condition - No recorded step is lost after the session ends

_For any_ failing stage of `record()` after the session ended (`captureFinalScreen`, `readResultZone`, `finalizeNetwork`, `saveWorkflow`, window closed with a marked zone) and any recorded step count N, the fixed `record()` SHALL write `<out>.recovery.json` containing all N steps (and the marked zone, unchecked) when N > 0, SHALL name the file and the cause in the thrown error, and SHALL write no file when N = 0.

**Validates: Requirements 2.11**

Property 7: Preservation - Recorded steps and screens do not change

_For any_ sequence of user interactions where isBugCondition_A2 does NOT hold, the fixed recorder SHALL record the same steps (action types, selectors, anchors, values, row bindings, risk), the same thumbnails and the same screen hash as the original, with the panel present, and a successful session SHALL write the workflow file and no recovery file.

**Validates: Requirements 3.4, 3.6, 3.7, 3.8, 3.12**

Property 8: Bug Condition - A navigation click does not take a mount read as its recipe

_For any_ list of request attempts and any click step where isBugCondition_A3 holds, `dropNavigationReads` SHALL remove every read (GET or HEAD) attempt and keep every write attempt, and `finalizeNetwork` SHALL leave the step without an HTTP recipe when no write remains, reporting level `accessibility` with a reason that names the screen navigation.

**Validates: Requirements 2.13**

Property 9: Preservation - Other recipe selection is unchanged

_For any_ attempts, `used` and step where isBugCondition_A3 does NOT hold (not a click, a submit, the same route, or a variable carried), `dropNavigationReads` SHALL return the attempts unchanged, and `selectRecipe` SHALL return what it returned before (it is not modified).

**Validates: Requirements 3.5**

Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line

_For any_ workflow, `writeSteps` of the workflow view SHALL list, in order, exactly the steps whose risk is not `read` with their number and label, SHALL classify the first write that follows a secret step as `login`, and SHALL set `writeSummary` to `none`, `login-only` or `actions`; the playground confirmation dialog SHALL list those steps and no value; and a `{{name}}` chip of the VARIABLES table SHALL render on one line at any column width.

**Validates: Requirements 2.14, 2.15, 2.16**

Property 11: Preservation - Read-only tools and the confirmation flow are unchanged

_For any_ workflow with no write step, the Studio SHALL show no write note, and the playground SHALL run `read` tools without a dialog and SHALL still refuse a write or delete tool without `confirm: true`.

**Validates: Requirements 3.10, 3.11**

## Fix Implementation

### Ownership and parallel plan

Three groups edit disjoint files. A file listed once belongs to that group only.

| Group | Owned files (source) | Owned files (tests and docs) |
|---|---|---|
| **G1 Secrets** | `src/compiler/mcp-generator.ts`, `src/compiler/tool-description.ts`, `src/compiler/kiro-power-generator.ts`, `src/studio/model.ts`, `src/studio/playground.ts`, `src/studio/server.ts`, `src/studio/sample-data.ts`, new `src/studio/ui/js/secrets-view.js` | `tests/unit/compiler-outputs.test.ts`, `tests/unit/http-replay.test.ts`, `tests/unit/studio-model.test.ts`, `tests/unit/playground.test.ts`, `tests/integration/http-replay-e2e.test.ts`, `tests/integration/kiro-power-mcp.test.ts`, `tests/integration/studio-server.test.ts`, `tests/integration/studio-playground.test.ts`, new `tests/property/secrets-plan.property.test.ts`, new `tests/property/studio-secret-status.property.test.ts`, `docs/secrets.md` |
| **G2 Recording** | `src/recorder/capture-script.ts`, `src/recorder/live-recorder.ts`, `src/recorder/workflow-recorder.ts` (one method), `src/recorder/visual-anchor.ts` (one option), `src/cli/commands/record.ts` | `tests/unit/capture-script.test.ts`, `tests/integration/live-recorder.test.ts`, `tests/integration/result-zone.test.ts`, `tests/integration/cli.test.ts` (only if a locator needs an update), new `tests/integration/recording-panel.test.ts`, new `tests/integration/record-recovery.test.ts`, new `tests/property/recording-panel.property.test.ts`, new `tests/property/record-recovery.property.test.ts` |
| **G3 Correlation and Studio UI** | new `src/recorder/navigation-rule.ts`, `src/studio/ui/js/views/workflows.js`, `src/studio/ui/js/views/playground.js`, `src/studio/ui/app.css` | new `tests/unit/navigation-rule.test.ts`, new `tests/property/navigation-rule.property.test.ts`, `tests/integration/studio-ui.test.ts`, `tests/integration/studio-ui-playground.test.ts`, `tests/unit/studio-ui-modules.test.ts`, `docs/studio.md` |

`record-tui.ts` is owned by nobody (not changed). `select-recipe.ts` and `network-capture.ts` are not changed, so Properties 5 and 6 of `tests/property/nextjs-fix-recipe.property.test.ts` and the network-capture tests keep passing as they are.

**Cross-group contracts (frozen here so the groups can start together).** There are exactly three, and each has one producer and one consumer.

| Contract | Producer | Consumer | What is frozen |
|---|---|---|---|
| `navigation-rule.ts` API | G3 (lands first, it is small) | G2, only in `finalizeNetwork` | The four exports in "A3" below |
| `WorkflowView` fields `secrets`, `unusedSecrets`, `secretsBasis`, `writeSteps`, `writeSummary`, and the same fields on each playground tool | G1 (`model.ts`, `server.ts`) | G3 (`workflows.js`, `playground.js`) | The shapes in "A1, Studio model" and "A3, write steps" below. The UI treats every field as optional, because the static demo and `sample-data.ts` may lack them |
| `secrets-view.js` | G1 | G3 imports it in the two views | `secretsSection(secrets, unusedSecrets, options)`, described in "A1, Studio UI" |

G2 has no other dependency. G3's three hook-ins (`secretsSection` in two views, and the write list) are its last tasks, after G1 merged its module and fields.

### A1. Phantom HTTP secrets (G1)

**File**: `src/compiler/mcp-generator.ts`

**1. `replayCore` of `WEB_RUNTIME_HTTP`.** Compute the plan before any secret check, filter, and keep the typed-secret checks on all steps:

```
const plan = planSteps(steps);
// A step that stays on the page never reads its recorded {"$secret":NAME} references: only the steps run over HTTP need them
const httpSteps = steps.filter((_, index) => plan[index] === "http");
const missing = [...new Set([...missingSecrets(steps, process.env), ...missingHttpSecrets(httpSteps, process.env)])];
...
const secrets: string[] = [...secretValues(steps, process.env), ...httpSecretValues(httpSteps, process.env)];
```

The later `const plan = planSteps(steps);` line is removed. `missingSecrets` and `secretValues` (typed secrets) keep all steps: those steps run on the page. The generated code stays free of template literals and imports nothing from `src/`.

**2. `WEB_RUNTIME` (no `--http`).** No change. It has no HTTP secret check. A test pins this.

**3. `generateDockerReplay` (host side).** When `http` is true, import `planSteps` too and filter:

```
import { planSteps, httpSecretNames, missingHttpSecrets, secretVariable, COOKIE_HEADER_VARIABLE } from "./http-replay.js";
const httpStepsOf = (steps: Step[]): Step[] => { const plan = planSteps(steps); return steps.filter((_, index) => plan[index] === "http"); };
const HTTP_SECRET_VARIABLES = (steps: Step[]): string[] => [...httpStepsOf(steps).flatMap((s) => httpSecretNames(s.http).map(secretVariable)), ...(process.env[COOKIE_HEADER_VARIABLE] ? [COOKIE_HEADER_VARIABLE] : [])];
const HTTP_MISSING_SECRETS = (steps: Step[]): string[] => missingHttpSecrets(httpStepsOf(steps), process.env);
```

`http-replay.js` is already in the sandbox `copy` list when `http` is true, so the container side (`replay.js --container`, same fixed `replayCore`) needs nothing more. When `http` is false, the two constants stay `() => []`.

**File**: `src/compiler/tool-description.ts`

**4. New `secretEnvNames(workflow, options)` signature.**

```ts
export interface SecretEnvOptions {
  /** The server is compiled with --http: only then is a recorded request ever executed. */
  http?: boolean;
}
export function secretEnvNames(workflow: Workflow, options: SecretEnvOptions = {}): string[]
```

Rules: names from `step.secretRef` and from `workflow.secrets` are always included (unchanged). `httpSecretNames(step.http)` is included only when `options.http === true` and `planSteps(workflow.steps)[i] === 'http'`. Omitting `options` means no HTTP names (the safe reading: nothing is executed over HTTP). The same file gets a helper for Studio and tests:

```ts
/** The `$secret` names of the recipes, split by whether the compiled mode executes the step over HTTP. */
export function httpSecretSplit(workflow: Workflow, options: SecretEnvOptions = {}): { used: string[]; unused: string[] }
```

`secretEnvNames` is built on `httpSecretSplit`, so the compiler and Studio cannot disagree.

**5. Every caller.**

| Caller | Change |
|---|---|
| `describeTool(workflow, options)` in `tool-description.ts` | `secretEnvNames(workflow, options)`. `options` already is `{ http?: boolean }` |
| `McpGenerator.generateToolBlock` | Already calls `describeTool(workflow, { http })`. No change |
| `KiroPowerGenerator.generate`: `mcp.json` env, the `## Secrets` section of `SKILL.md`, per-tool descriptions | Compute `const secretVariables = [...new Set(set.workflows.flatMap((workflow) => secretEnvNames(workflow, { http })))].sort();` with an explicit arrow. Never pass `secretEnvNames` bare to `flatMap`, which would pass the index as `options` |
| `describeTool(workflow, { http })` in `KiroPowerGenerator` tool sections | Already passes `http` |
| Studio model | Uses `httpSecretSplit` (below) |

`compiler.ts` needs no change: it already passes `http` and `healSupport` to the generators.

**File**: `src/studio/model.ts` (Studio model).

**6. How the model knows the compiled mode.** `StudioOutputs.flags.http` already exists and is set in `server.ts` `readOutputs` from `http-replay.js` in the output directory. Make it stricter, so a stale file from an older compile does not count: `http = exists('http-replay.js') AND replay.js imports './http-replay.js'` (read `replay.js` as text, 1 MB cap, no JSON). If the compiled `replay.js` does not keep that import, G1 falls back to the file test and notes it in the tests. When `flags.compiled` is false, the basis is `not-compiled` and recipe-only names are shown as unused.

**7. Required names and status.**

```ts
export interface SecretName {
  name: string;
  kind?: SecretReference['kind'];
  envVariable: string;                       // DAEMONIZE_SECRET_<name>
  status?: 'configured' | 'missing';         // absent: unknown (sample data, static demo)
}
export interface SecretStatusSource { configured: ReadonlySet<string> }   // upper-case variable names, no values

export function workflowSecrets(workflow: Workflow, options: { http: boolean }, status?: SecretStatusSource):
  { required: SecretName[]; unused: SecretName[] }
```

`required` = declared (`workflow.secrets`) + `step.secretRef` (kind `totp` for TOTP) + names from `httpSecretSplit(workflow, { http }).used`. `unused` = `httpSecretSplit(...).unused` minus names already required. `status` is `configured` when `status.configured.has('DAEMONIZE_SECRET_' + name.toUpperCase())`, else `missing`, and left undefined without a source. The existing `secretNames(workflow)` stays exported and unchanged (all names, as before) for `sensitiveArgs` and for tests.

`WorkflowView` gains:

```ts
secrets: SecretName[];            // required for the compiled mode, with status when known
unusedSecrets: SecretName[];      // recorded in HTTP recipes, not read by the compiled mode
secretsBasis: 'not-compiled' | 'ui-only' | 'http';
```

`buildWorkflowView(set, workflow, outputs, status?)` and `buildWorkflows(targets, status?)` take the optional status source. `buildTargetOverview.secrets` uses the required names. Only names, kinds, variable names and statuses are copied: no value.

**8. Where "configured" comes from.** New method on `PlaygroundSession` in `playground.ts`:

```ts
/** Upper-case names of the DAEMONIZE_SECRET_* variables that are non-empty in the environment this session passes to the server. Names only. */
async configuredSecretVariables(): Promise<Set<string>> {
  const env = (await this.launchSpec().catch(() => undefined))?.env
    ?? buildChildEnv({ processEnv: this.options.processEnv ?? process.env, studioEnv: this.studioEnv, mode: this.currentMode });
  return new Set(Object.entries(env).filter(([name, value]) => value !== '' && /^DAEMONIZE_SECRET_/i.test(name)).map(([name]) => name.toUpperCase()));
}
```

It reuses `launchSpec()`, so it sees exactly what the child sees: allow-listed `DAEMONIZE_*` names from the Studio and process environment, and the literal (non-`${VAR}`) entries of the `mcp.json` env. The values never leave the method. In `server.ts`, `/api/workflows` and `/api/playground` build the status source with `playground?.configuredSecretVariables()` (or from `env` alone when the playground is disabled) and pass it to `buildWorkflows`. In sample mode no source is passed (status unknown), because the sample environment is fictitious. Everything still goes through `sendJson`, so `redactForStudio` and `knownSecretValues` apply, and the new fields hold names and the two words `configured` and `missing`.

`toolMeta().sensitiveArgs` becomes `[...usesSecret variables, ...view.secrets names, ...view.unusedSecrets names]`, so redaction of typed arguments keeps covering every recorded name.

`playgroundStatus` adds `secrets`, `unusedSecrets`, `secretsBasis`, `writeSteps` and `writeSummary` of the matching view to each tool object.

**9. A1, Studio UI.** New `src/studio/ui/js/secrets-view.js`, built with the safe `h()` builders:

```js
/** @param {any[]} secrets @param {any[]} unusedSecrets @param {{ basis?: string, variant: 'workflow' | 'playground' }} options */
export function secretsSection(secrets, unusedSecrets, options) { ... }
```

For each required secret: the name chip, `DAEMONIZE_SECRET_<NAME>`, and a status chip (`chip pass` "configured", `chip fail` "missing", nothing when `status` is undefined). The `playground` variant keeps the title "Provided by env" and the sentence about the Studio environment, adding a line when any secret is missing ("Set it before calling the tool: the call fails with missing_secret"). The `workflow` variant keeps "Secrets needed". `unusedSecrets` render in a collapsed `<details>` titled "Recorded in HTTP recipes, not read by this server". The basis `not-compiled` shows "Compile to see which secrets the server reads". No value, no `innerHTML`.

### A2. Recording panel, finish binding and recovery (G2)

**File**: `src/recorder/capture-script.ts` (still one string; backslashes in regular expressions stay doubled).

**1. DOM structure.** One root, mounted in `document.documentElement` (not in `body`, so a hydrating framework does not remove it), light DOM (no shadow root, because the existing tests read `[data-daemonize-ui]` `textContent`):

```
<div data-daemonize-ui data-daemonize-panel role="region" aria-label="Daemonize recorder" style="all:initial; position:fixed; right:12px; bottom:12px; z-index:2147483647; ...">
  <div header>   red dot + "Recording" + "<n> steps"  + [toggle]   data-daemonize-action="toggle-panel", aria-expanded
  <div body>     (hidden when collapsed)
     <ol>        last 3 step labels (no typed values)          data-daemonize-action="last-steps"
     <div offer> "Field: <name>"  [Make variable]              data-daemonize-action="make-variable"
                 (after click) <input variable-name> [OK] <message>
     <div result> [Choose the result to capture]               data-daemonize-action="mark-result"
                 selection mode: "Click the element that holds the result" [Cancel]   data-daemonize-action="cancel-mark-result"
                 zone set: "Result zone:" <select result-kind>  and the button reads "Choose another result"
     <div footer> [Finish and save] (primary)                  data-daemonize-action="finish"
     <p status aria-live="polite">                             notices and errors
</div>
```

Only the root carries `data-daemonize-ui`. Every child is inside it, so `inUi()` (`closest`) and `normalizeDom` (which drops the whole subtree) already exclude it. A second attributed node would break the strict-mode locator `page.locator('[data-daemonize-ui]')` used by existing tests (3.12). Styles are inline on each node (`all:initial` first on the root), so page CSS does not reach it. The button that offers a variable keeps the visible name "Make variable" (an existing test uses `getByRole('button', { name: 'Make variable' })`), with the field name in a label next to it. The saved message stays `Variable "<name>" saved`, and the panel stays in place after it.

**2. Mounting and survival.** `ensurePanel()` appends the root when it is not connected. It runs at install, on `DOMContentLoaded` and `load`, on every route change, and from a `MutationObserver` on `document` with `{ childList: true }` (not on the subtree), which fires when `document.documentElement` is replaced (`page.setContent`, `document.write`). A full navigation re-runs the init script, which mounts a new panel and pulls the state from Node. A top frame shows the full panel. A sub-frame mounts only a compact offer row (the former chip), because the typed field lives in that frame.

**3. State from Node.** The page pulls, Node never needs to push: after each `__daemonizeRecord` promise resolves, on mount, on a route change, and on `visibilitychange`, the script calls `window.__daemonizePanel({ type: 'state' })` and renders the `PanelState` it gets back. Collapse is stored in Node (`{ type: 'collapse', collapsed }`), not in `sessionStorage`, so the recorded page is never touched.

```ts
// live-recorder.ts
export const PANEL_BINDING = '__daemonizePanel';
export const FINISH_BINDING = '__daemonizeFinish';
export type PanelRequest = { type: 'state' } | { type: 'collapse'; collapsed: boolean };
export interface PanelState { steps: number; last: string[]; collapsed: boolean; zone?: { kind: string }; ending: boolean }
```

`last` holds the labels of the last three steps (`click Save`, `type Email`), kept in a small ring buffer filled in `handle()` and `switchTo()`. A typed value never appears in the panel. `steps` is `stepCount`.

**4. Event protocol between page and Node.**

| Binding | Direction and payload | Result |
|---|---|---|
| `__daemonizeRecord(event)` | page to Node, existing. `event` may carry `replaces?: number` (step index of the previous flush of the same field) | step index, or `null` |
| `__daemonizeMarkVariable(request)` | page to Node, existing | `{ ok }` |
| `__daemonizeMarkResult(request)` | page to Node, existing | `{ ok, selector, kind }` |
| `__daemonizePanel(request)` | page to Node, new: `PanelRequest` | `PanelState` for `state`, `{ ok: true }` for `collapse` |
| `__daemonizeFinish()` | page to Node, new | `{ ok: true }` once `requestEnd('panel')` is called, else `{ ok: false, error }` |

All five are registered in `LiveRecorder.bind()` for every page (popups included), before `addInitScript`. Without the two new bindings (`adminer-regressions.test.ts` exposes only the first three), the script hides the footer button and the step counter and keeps working: it tests `typeof window.__daemonizeFinish === 'function'`.

**5. The offer and its reset.** The offer is held by a small pure model created inside the script and exposed as `window.__daemonizeHelpers.offerModel` so it can be property-tested:

```
offer = { fieldId, stepIndex, suggestion, label, route, rowText? } | null
apply({ t: 'typed',  fieldId, stepIndex, route, ... })  -> offer := that, only if route = current route
apply({ t: 'input',  fieldId })                         -> if offer AND offer.fieldId != fieldId: offer := null
apply({ t: 'route',  route })                           -> offer := null; current route := route
apply({ t: 'row',    route, text, ... })                -> offer := row offer
```

Wiring: `emit()` for `type` and `select` returns the record promise; when it resolves with a number, it applies `typed` with a sequence number and ignores a result that is no longer the latest (the user already typed elsewhere). `input` events in another field apply `input`. The route is `location.pathname` (a `?q=` change by a live search must not clear the offer). Route-change detection, which does not exist today:

- `window.navigation.addEventListener('currententrychange', …)` when the Navigation API exists (Chromium, the only browser `record()` launches). It sees `pushState`, `replaceState`, back and forward, and hash changes without patching the page.
- Fallback: wrap `history.pushState` and `history.replaceState` (call the original with the same arguments, then check the route) and listen to `popstate` and `hashchange`.
- A full navigation needs no hook: the new document has no offer.

The text-selection offer for a table row (`showChip(-1, …, rowText)` today) becomes the same offer row with `rowText`, cleared by the same rules.

**6. Variable name input.** Width `max(220px, (suggestion.length + 4) ch)` capped at `min(360px, 60vw)`, `title` = suggestion. `askName` no longer rebuilds the whole box: it swaps only the offer row, so "Choose the result" and "Finish and save" stay.

**7. Live-search flush.** A capture-phase `input` listener (trusted events, not in the UI, text fields and editable hosts) records the field as the active one and arms a 600 ms timer (`LIVE_FLUSH_MS`). On expiry it calls `flush(el)`. A different field's `input` flushes the previous one at once. `emit()` for any non-`type` action first flushes the pending field, and so does the Finish click, so order is kept. A `pagehide` listener flushes best-effort. `flush()` dedupes through `lastValues`, so blur, `change` and Enter after a debounced flush record nothing more.

To avoid one step per pause, the page sends `replaces: <index of the previous flush of this field>`. In `LiveRecorder.handle()`, when `replaces` equals the index of the last recorded step and that step is a `type` of the same field, the step value is updated through a new `WorkflowRecorder.replaceValue(index, value)` and the same index is returned. Otherwise a new step is added. The action id already begun for the replaced event is dropped.

**8. Result selection.** "Choose the result to capture" calls `startMarkResult()`, which shows the selection message and a Cancel button in the panel. Esc and Cancel call `cancelMarkResult()`. Alt+Shift+R calls the same function (3.7). After a zone is set, the panel shows the `result-kind` select (`data-daemonize-action="result-kind"`) and keeps the choose button. Transient notices use a 6 s timer in the status line (`NOTICE_LIFETIME_MS`). `CHIP_LIFETIME_MS` no longer removes the offer.

**9. Finish and save.** The click handler (a) flushes the pending live field, (b) awaits every outstanding record promise, (c) calls `window.__daemonizeFinish()`, (d) on `{ ok: true }` shows "Saving…" and disables the buttons. Nothing closes the page: `record()` still runs `captureFinalScreen`, `readResultZone`, `finalizeNetwork` and `saveWorkflow` on an open page, then closes the browser.

**File**: `src/recorder/live-recorder.ts`

**10. The end path and the future Studio recording.**

```ts
export type EndReason = 'panel' | 'signal' | 'api';
class LiveRecorder {
  readonly ended: Promise<EndReason>;            // resolves once, on the first requestEnd
  requestEnd(reason: EndReason = 'api'): void;    // idempotent; sets the panel state to ending
}
```

The `__daemonizeFinish` binding calls `requestEnd('panel')`. `record()` awaits `Promise.race([session, live.ended, stopped])`. A Studio-driven recording later calls `requestEnd('api')` from Node (or aborts `RecordOptions.signal`, which `record()` maps to `requestEnd('signal')`) and takes the same path, with the page open. Nothing in the end path depends on the terminal.

**11. Route bookkeeping for A3.** `enqueue()` stores `urlBefore` per recorded step (`source.frame.page().url()` at the moment the page reports the event, which is before the navigation of a click). A `framenavigated` listener on each page's main frame keeps `lastUrl` (same-document navigations included). `navigationOf(index)` returns `{ from: urlBefore(index), to: urlBefore(next step of the same page) ?? lastUrl(page) }`.

**12. `finalizeNetwork` call site** (uses the G3 module, see A3):

```
const screenNav = isScreenNavigation({ actionType: step.actionType, submit: (step.risk ?? 'read') !== 'read', nav: this.navigationOf(index) });
const { kept, dropped } = dropNavigationReads(attempts, { screenNavigation: screenNav, used });
if (kept.length === 0 && dropped.length > 0) {
  this.recorder.setHttp(index, undefined, 'read');
  reports.push({ ...base, level: 'accessibility', reason: navigationReason(dropped) });
  return;
}
// continue with `kept` in place of `attempts` (selectRecipe, followUpReads and the closest-attempt report are unchanged)
```

**File**: `src/recorder/visual-anchor.ts` (one option). `takeThumbnail` passes `style: '[data-daemonize-ui] { visibility: hidden !important }'` to `page.screenshot`, so the panel never appears in a thumbnail. Playwright 1.65 supports the `style` option. The existing visual-anchor tests keep their expectations apart from the extra option.

**File**: `src/recorder/workflow-recorder.ts`: one method, `replaceValue(index, value)`, that changes the `value` of a recorded `type` step.

**File**: `src/cli/commands/record.ts`

**13. A2.6 recovery rules.** After the session ends the work is a staged function with a single rescue block:

```
stage 'idle'      await live.idle()
stage 'screen'    finalScreen = page open ? captureFinalScreen(...) : undefined
stage 'zone'      marked = options.resultZone flag ?? live.resultZone
                  if marked AND page closed  -> throw ZoneUnverifiedError("the window was closed before the result zone could be checked")
                  resultZone = marked ? readResultZone(page, marked) : undefined
stage 'network'   network = live.finalizeNetwork()      (flag networkDone = true)
stage 'finish'    workflow = recorder.finish(finalScreen, finalZone, resultZone)
stage 'save'      saveWorkflow(out, target, workflow)
catch (err) -> throw await rescue(err, stage)
```

Rules:

1. Every failure at or after stage `idle`, and every `BrowserStoppedError`, goes to `rescue()`. This includes `captureFinalScreen`, `readResultZone`, `finalizeNetwork`, `saveWorkflow`, a crash, and the window X.
2. `rescue()` does nothing when `live.stepCount === 0`: the error is "Recording interrupted: <reason>. Nothing had been recorded yet." and no file is written (3.8).
3. Otherwise it builds the best workflow available: the one already finished if `recorder.finish` succeeded, else `recorder.finish(finalScreen, finalZone, markedZone)` with the marked zone unchecked (no schema), after a best-effort `finalizeNetwork` (skipped when `networkDone`, bounded to 5 s, errors ignored).
4. It writes `${out}.recovery.json` with `saveWorkflow`. If that write fails, it writes the plain workflow JSON to `<tmpdir>/daemonize-recovery-<workflowId>.json` and reports that path. A step is never dropped.
5. The thrown error keeps the existing wording for browser stops (`Recording interrupted: <reason>. The N step(s) recorded so far were saved to <file>.`) and for other failures reads `Recording failed after the session ended: <cause>. The N step(s) recorded so far were saved to <file>.`, with the original error as `cause`.
6. The window X with a marked zone writes the recovery file and says that "Finish and save" avoids this. The window X with no marked zone still saves the workflow normally (3.7).
7. A successful session writes no recovery file. The browser is closed in `finally`, after the recovery file is written.
8. `RecordOptions` gains `signal?: AbortSignal`. `waitForUser(page, ended)` also resolves on `live.ended`, so the terminal prompt no longer holds the process after the panel finished the session, and its text mentions the panel button. For testing, the staged function is exported as `completeRecording(context, hooks?)` with optional stage overrides.

`record-tui.ts` is not changed.

### A3. SPA correlation and Studio polish (G3)

**New file**: `src/recorder/navigation-rule.ts`, pure (no Playwright, no I/O), frozen API:

```ts
import type { RecipeCandidate } from './select-recipe.js';
export interface NavigationInfo { from: string; to: string }
/** origin + pathname, trailing slash removed; undefined when the URL cannot be parsed. Query and hash are ignored. */
export function routeKey(url: string): string | undefined;
/** A click that is not a submit, after which the route of the page differs from the route before it. */
export function isScreenNavigation(input: { actionType: string; submit: boolean; nav?: NavigationInfo }): boolean;
/**
 * For a screen navigation with no variable carried, remove every read (GET or HEAD) attempt: whatever it binds, it is a
 * mount request of the new screen, not the action. Writes are kept. Anything else is returned unchanged (same array contents).
 */
export function dropNavigationReads<T extends RecipeCandidate & { request: { method: string; url: string } }>(
  attempts: readonly T[],
  input: { screenNavigation: boolean; used: readonly string[] },
): { kept: T[]; dropped: T[] };
/** "screen navigation: GET /api/merchants/audience is a mount request of the new screen, not an action". */
export function navigationReason(dropped: ReadonlyArray<{ request: { method: string; url: string } }>): string;
```

Why a separate module and not a change in `selectRecipe`: `selectRecipe` and its two properties (P5, P6 of `nextjs-fix-recipe.property.test.ts`) call it with `{ submit, used }` only and must keep their exact results. The rule runs before `selectRecipe` in `finalizeNetwork`, so those properties and `network-capture.test.ts` do not see it. The rule keeps reads that carry a variable for steps that are not navigations, writes of a navigation click, and every request of a submit step. A route change that only alters the query (`?q=`) is not a navigation, so a live search that updates the URL keeps its recipe.

**File**: `src/studio/ui/app.css` (VARIABLES table).

- `.vars-table td:first-child, .vars-table th:first-child { white-space: nowrap }` and `.vars-table .chip.variable { white-space: nowrap; overflow-wrap: normal; word-break: keep-all }`. These two rules scope the fix to the table, so other `.chip` uses keep wrapping.
- `.vars-table td:last-child { white-space: nowrap }`; the description column keeps `overflow-wrap: anywhere`.
- `.detail-grid { grid-template-columns: minmax(0, 1fr) minmax(320px, 26rem) }` so the side column can grow on wide screens.
- The table sits inside `.table-wrap` (`overflow-x: auto`), so a very narrow column scrolls instead of wrapping.

**File**: `src/studio/ui/js/views/workflows.js`. The variables table gets `class: 'table compact vars-table'` and the `.table-wrap` wrapper. A write note under the header meta:

- `writeSummary === 'none'` (or the field is absent): nothing.
- `login-only`: "The only write is the login form: step 3, “click Sign in”. The other steps only read."
- `actions`: "Writes data in N step(s):" and a list "Step 3: click Save (write)", with the login submit marked "login form".

The two secrets blocks of the view call `secretsSection(wf.secrets, wf.unusedSecrets, { basis: wf.secretsBasis, variant: 'workflow' })` from G1.

**G1 data for the write note** (`src/studio/model.ts`, `server.ts`; the UI is G3):

```ts
export interface WriteStepView { index: number; label: string; risk: 'write' | 'delete'; kind: 'login' | 'action' }
WorkflowView.writeSteps: WriteStepView[];
WorkflowView.writeSummary: 'none' | 'login-only' | 'actions';
```

`writeSteps` lists, in order, the steps whose `risk` is not `read`. `label` is `step.label` clipped to 80 characters, or `<action> <n>`. A write is `login` when it is the first write of the workflow and some step before it satisfies `isSecretStep`. `writeSummary` is `none` with no write, `login-only` when all writes are `login`, else `actions`. `risk.highest` is unchanged (3.10). The playground tool objects in `playgroundStatus` carry the same two fields.

**File**: `src/studio/ui/js/views/playground.js`. `confirmDialog(tool, onConfirm)` keeps its title, focus handling and buttons, and adds, under the sentence, a list built from `tool.writeSteps` (`Step 3: click Save (write)`), or the login-only sentence. When the tool has no `writeSteps` (static demo, old server) the dialog shows the generic sentence as today. The list holds step numbers and labels only: no argument or secret value. The secrets block calls `secretsSection(tool.secrets, tool.unusedSecrets, { basis: tool.secretsBasis, variant: 'playground' })`.

## Testing Strategy

### Validation Approach

The strategy is two-phase: surface counterexamples on the unfixed code first, then verify the fix and preservation. Property tests carry the tag `// Feature: studio-first-recording-fixes, Property N: <title>` on the line above the property. The vitest config already includes `tests/property/**/*.test.ts`. Each group runs only its own files while working (`npx vitest run <file>`); the full `npm test` runs once after the three groups merged.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If it is refuted, re-hypothesize.

**Test Plan**: Write the tests below first, run them on the unfixed code, and keep the failing output as evidence.

**Test Cases**:
1. **Phantom secret (G1)**: generate `replay.ts` with `--http` for a workflow whose steps are `ui, ui, ui, http` and whose first `http` recipe has `{"$secret":"TOTP"}` on a `ui` step, run the generated `replayCore` with an environment that lacks the secret (the existing `http-replay-e2e.test.ts` harness), and assert no `missing_secret` (will fail on unfixed code).
2. **Listing (G1)**: `secretEnvNames(workflow)` and `describeTool(workflow, { http: false })` for the same workflow must not contain `DAEMONIZE_SECRET_TOTP` (will fail on unfixed code).
3. **Docker host side (G1)**: `generateDockerReplay` with `http: 'auto'` and the same workflow: `HTTP_MISSING_SECRETS(steps)` is empty (will fail on unfixed code).
4. **Studio (G1)**: `buildWorkflowView` for the same workflow with `flags.http = false` lists no recipe-only secret and shows `unusedSecrets` (will fail on unfixed code).
5. **Panel (G2)**: open a page with the recorder attached and assert one `[data-daemonize-panel]` with the "Recording" text, the choose button and the finish button; push an SPA route, assert the panel is still there and the offer is gone (will fail on unfixed code).
6. **Live search (G2)**: type into an input that filters on `input`, wait 700 ms with no blur, assert a `type` step exists (will fail on unfixed code).
7. **Window X (G2)**: mark a result zone, close the page, assert `<out>.recovery.json` exists with all steps (will fail on unfixed code).
8. **Navigation click (G3)**: `dropNavigationReads` does not exist yet, so the exploratory test is an integration test of `finalizeNetwork` on a page with a link and a `fetch('/api/merchants/audience')` on mount: the step must have no `http` (will fail on unfixed code).
9. **Studio UI (G3)**: at 1280 px, a `{{query}}` chip of the VARIABLES table has a height under 1.6 lines (will fail on unfixed code); the confirmation dialog lists the write steps (will fail on unfixed code).

**Expected Counterexamples**:
- `missing_secret` naming `DAEMONIZE_SECRET_CHALLENGE_TOKEN` after 0 ms.
- Listings that contain names no step reads.
- No `[data-daemonize-panel]`, a chip left after `history.pushState`, no step for typed text without blur, no recovery file after the window closes.
- `GET /api/merchants/audience` as the recipe of the navigation click.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed code produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)
END FOR
```

Per group:
- **G1**: for any generated workflow (steps with random `secretRef`, `secrets`, and recipes with `$secret` in query, headers and body, random `http` mode), `secretEnvNames(w, { http })` equals typed ∪ declared ∪ names of HTTP-planned steps when `http` is true, and typed ∪ declared otherwise; `missingHttpSecrets(httpSteps, env)` never names a variable that belongs only to non-HTTP-planned steps. Property 1 and Property 3 (the model's required list equals `secretEnvNames` without the prefix; `status` is `configured` exactly when the name is in the configured set; the JSON contains no value).
- **G2**: Property 5 on the offer model: a random sequence of `typed`, `input`, `route` and `row` events gives an offer equal to the last `typed` field when no later `route` and no later `input` of another field exist, else none. The model is evaluated inside one Playwright page through `window.__daemonizeHelpers.offerModel`, so a few hundred sequences run in seconds. Property 6: `completeRecording` with a stage forced to fail (`captureFinalScreen`, `readResultZone`, `finalizeNetwork`, `saveWorkflow`, closed page with a marked zone), N steps drawn from 0 to 20: N > 0 gives a recovery file with N steps and an error naming it; N = 0 gives no file.
- **G3**: Property 8: for random attempts (methods GET, HEAD, POST, PUT, PATCH, DELETE; bound subsets; with or without recipe), a screen navigation and empty `used`, `kept` has no read and keeps every write in order, `dropped` has the reads, and `kept ∪ dropped` is the input. Property 10: for random risk arrays and secret steps, `writeSteps` indices equal the non-read indices, `login` appears at most once and only after a secret step.

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation because it generates many cases across the input domain, catches edge cases that hand-written unit tests miss, and gives strong guarantees that behavior is unchanged for non-buggy inputs.

**Test Plan**: Observe the behavior of the unfixed code first (existing tests are the baseline), then write the property tests.

**Test Cases**:
1. **HTTP-planned secrets (G1)**: Property 2. For a `--http` workflow whose `$secret` steps are HTTP-planned, `missingHttpSecrets` on the filtered steps equals the old result on all steps, and the generated `replay.ts` returns `missing_secret` for an absent name exactly as before. `secretRef`, `secrets`, TOTP and `COOKIE_HEADER_VARIABLE` listings equal the old output for random workflows.
2. **Studio security (G1)**: Property 4. The existing `studio-no-secrets.property.test.ts` and `playground-redaction.property.test.ts` stay unchanged and pass; a new check feeds random secret values to the environment and asserts none appears in `/api/workflows` or `/api/playground`.
3. **Recorded steps (G2)**: Property 7. The existing `live-recorder`, `row-binding`, `result-zone`, `anchors-record`, `cli` and `adminer-regressions` tests pass unchanged (except a locator update that is justified in its diff). A new check records the same scripted interaction with and without the panel and compares the steps, and compares `screenId('dom', page.content())` with the panel mounted and unmounted. A third check verifies that a thumbnail taken near the panel does not contain it (the panel is hidden by the `style` option).
4. **Recipe selection (G3)**: Property 9. `dropNavigationReads` returns the input unchanged for random inputs where `screenNavigation` is false or `used` is not empty; the file `nextjs-fix-recipe.property.test.ts` is not edited and passes; `network-capture.test.ts` passes. A route change that only alters the query is not a navigation (`routeKey` equal).
5. **Studio UI (G3)**: Property 11. A workflow without write steps shows no note and no dialog; a write tool still returns 409 `confirmation_required` without `confirm: true`; `read` tools run without a dialog.

### Unit Tests

- G1: `secretEnvNames` and `httpSecretSplit` for each branch (no options, `http: false`, `http: true` with `ui`, `prep` and `http` steps, body `$secret`, header `$secret`); `describeTool` text; `KiroPowerGenerator` `mcp.json` env and `SKILL.md` section for both modes (and the `flatMap` call with the explicit arrow); `generateReplay` and `generateDockerReplay` source contains the plan before the check and the filter, and contains no `src/` import; `workflowSecrets` with and without a status source; `PlaygroundSession.configuredSecretVariables` with `mcp.json` literals, `${VAR}` placeholders (ignored), non-allow-listed names (ignored) and empty values (missing).
- G2: `capture-script.test.ts` for the panel markup, `offerModel`, the debounce constant, the width rule of the name input, and the fallbacks when the new bindings are absent; `WorkflowRecorder.replaceValue`; `LiveRecorder.requestEnd` idempotence and `ended`; `PanelState` after `handle()`; `completeRecording` stage by stage.
- G3: `routeKey` (trailing slash, query, hash, default ports, invalid URL); `isScreenNavigation` (click, submit, same route, other actions); `dropNavigationReads` and `navigationReason`; the DOM builders of the write note, `secretsSection` hook-ins and `confirmDialog` list (`studio-ui-modules.test.ts`), with the absent-field fallbacks.

### Property-Based Tests

- `tests/property/secrets-plan.property.test.ts` (G1): Properties 1 and 2.
- `tests/property/studio-secret-status.property.test.ts` (G1): Properties 3 and 4.
- `tests/property/recording-panel.property.test.ts` (G2): Property 5 (offer model sequences in a page) and Property 7 (same steps with and without the panel on random scripted interactions of a small fixed page).
- `tests/property/record-recovery.property.test.ts` (G2): Property 6.
- `tests/property/navigation-rule.property.test.ts` (G3): Properties 8, 9 and the data part of Property 10 (`writeSteps` is G1's `model.ts`, so its property lives in `tests/unit/studio-model.test.ts` or G1's property file; G3 tests the rendering of the list from given `writeSteps`).

### Integration Tests

- **G2, `recording-panel.test.ts`** (Playwright, route-fulfilled fake SPA): the panel persists across `history.pushState`, `popstate`, `document.body.replaceWith`, `page.setContent` and a full navigation; the offer for the email on `/connexion` is gone on `/clients` and the offer follows the search box; the name input shows a 40-character suggestion without truncation; "Make variable" then "Choose the result to capture" is still clickable; the selection mode shows Cancel and Cancel restores the panel; Alt+Shift+R still opens selection; a live search typed with no blur produces one `type` step 600 ms after the last key, a second pause updates the same step, and typing then clicking another control keeps the order; `__daemonizeFinish` ends `record()` with the page open (`captureFinalScreen` and `readResultZone` succeed) and writes the workflow; the panel is absent from `page.content()` hashes and from thumbnails; the panel works in a popup page.
- **G2, `record-recovery.test.ts`**: window X after a marked zone writes `.recovery.json` with all steps and the zone; the same with `--result-zone`; `saveWorkflow` forced to fail on `out` still gives a recovery file; `finalizeNetwork` forced to fail; no steps gives "Nothing had been recorded yet" and no file; a normal finish writes no recovery file; `RecordOptions.signal` ends the recording through the same path.
- **G3**: `finalizeNetwork` on a fake SPA: the link click with a mount `GET` has no recipe and reports "screen navigation"; the same click followed by a `POST` keeps the `POST`; a search click that carries a variable keeps its recipe (existing test); `studio-ui.test.ts` renders the VARIABLES table at 1280 px and 700 px and asserts every `.chip.variable` fits one line, and a screenshot is refreshed in `tests/__screenshots__` only if the existing test already compares one; `studio-ui-playground.test.ts` opens the dialog for a tool with a login-only write and for a tool with writes and checks the lists and that no argument value appears.
- **G1**: `http-replay-e2e.test.ts` runs a generated `--http` server against a local HTTP stub with the phantom-secret workflow and gets a result, not `missing_secret`; with an HTTP-planned secret absent it still returns `missing_secret`. `kiro-power-mcp.test.ts` checks `mcp.json` env and `SKILL.md` for both modes. `studio-server.test.ts` and `studio-playground.test.ts` check the status fields with a configured and a missing secret, and that the response text contains the names and not the values.
