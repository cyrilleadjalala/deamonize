# Bugfix Requirements Document

## Introduction

Recording and compiling a real Next.js 15 / React 19 application with a 2FA (TOTP) login and a live search exposed three groups of defects.

**A1. Phantom HTTP secrets.** During the 2FA login, `LiveRecorder` captures `POST /api/auth/login/verify`. `redactor.ts` replaces `challengeToken` and `totp` in the body with `{"$secret":"CHALLENGE_TOKEN"}` and `{"$secret":"TOTP"}` in `step.http`. In a server compiled with `--http`, `replayCore` in `src/compiler/mcp-generator.ts` (`WEB_RUNTIME_HTTP`) calls `missingHttpSecrets(steps, process.env)` on all steps and `httpSecretValues(steps, process.env)` on all steps, and only afterwards calls `planSteps(steps)`. The generated MCP server therefore fails after 0 ms with `missing_secret` (`DAEMONIZE_SECRET_CHALLENGE_TOKEN`, `DAEMONIZE_SECRET_TOTP`) even when `planSteps()` keeps the login steps on `ui`. The host-side `docker-replay.ts` of a server compiled with `--http` has the same defect (`HTTP_MISSING_SECRETS` and `HTTP_SECRET_VARIABLES` look at all steps). Independently of the runtime, `secretEnvNames()` in `src/compiler/tool-description.ts` adds `httpSecretNames(step.http)` for every step without checking `options.http` or the plan, so the tool description, `mcp.json`, `SKILL.md` and the Kiro power name secrets the compiled mode never reads. Studio (`src/studio/model.ts` `secretNames()`, `workflows.js` "Secrets needed", `playground.js` "Provided by env") lists those secrets as required and does not say which are configured.

**A2. Recording overlay losses and defects.** The in-page recorder (`src/recorder/capture-script.ts`, `src/cli/commands/record.ts`) shows no indicator that recording is active. The "Make variable / Mark result" chip (`CHIP_LIFETIME_MS = 15000`) is only removed by a timer: the script has no SPA navigation hook (no `pushState`, `popstate` or Navigation API listener), so the chip of an earlier field stays after a route change. The chip loses its "Mark result" button after "Make variable", and has a name input fixed at `width:140px`. Text fields are recorded on `change` (blur) and on Enter only, so a live search is not flushed. The Alt+Shift+R shortcut is the only reliable way to mark a result zone. If the user closes the window after marking a result zone (or when `--result-zone` is given), `readResultZone()` throws on `page.isClosed()` before `saveWorkflow()` runs, and neither the workflow nor `.recovery.json` is written.

**A3. SPA network correlation and Studio polish.** `LiveRecorder.finalizeNetwork()` can attach, as the HTTP recipe of a SPA navigation click, a secondary mount request of the new screen (for example `GET /api/merchants/audience`). The recorder keeps no route information per step, so nothing can tell a navigation click from a search click. In Studio, the VARIABLES table breaks names like `{{query}}` over three lines. The Studio shows a `write` risk badge (the highest risk of the workflow) but no list of the steps that write, and the playground confirmation dialog shows a generic sentence.

**Scope.** This spec covers only these fixes. The Studio-first flow without a terminal is a separate later spec. The new recording panel must stay compatible with that later flow: its "Finish and save" action must be a Playwright binding (exposed with `page.exposeBinding`, like `__daemonizeRecord`) that ends the session while the page is still open, and the same end path must be reachable from Node, so that a Studio-driven recording can reuse it. `record-tui.ts` is not part of this spec: its result zone is read from the in-memory terminal screen, which stays readable after the program exits, so the loss-on-close defect does not apply to it.

## Bug Analysis

### Current Behavior (Defect)

**A1. Phantom HTTP secrets**

1.1 WHEN a workflow has a step whose `step.http` carries `{"$secret":NAME}` references (for example `CHALLENGE_TOKEN`, `TOTP`), the server is compiled with `--http`, and `planSteps(steps)` assigns `ui` to that step THEN `replayCore` calls `missingHttpSecrets(steps, process.env)` and `httpSecretValues(steps, process.env)` on all steps before `planSteps`, and fails after 0 ms with `missing_secret` for `DAEMONIZE_SECRET_CHALLENGE_TOKEN` and `DAEMONIZE_SECRET_TOTP`; the host side of `docker-replay.ts` (`HTTP_MISSING_SECRETS`, `HTTP_SECRET_VARIABLES`) does the same on all steps

1.2 WHEN the server is compiled without `--http` and a step has an HTTP recipe with `$secret` references THEN the generated `replay.ts` and `docker-replay.ts` never read those secrets (the web runtime without `--http` has no HTTP secret check, and `HTTP_*` are empty), but `secretEnvNames` still lists them, so the tool description, `mcp.json` env placeholders, `SKILL.md` and the Kiro power name secrets that are never read

1.3 WHEN `secretEnvNames(workflow)` is called for a step that has `step.http` with `$secret` references THEN it adds `httpSecretNames(step.http)` without checking `options.http === true` or `plan[index] === 'http'`, so even in a server compiled with `--http` the listings name secrets of steps that stay on `ui`

1.4 WHEN Studio shows a workflow whose HTTP-recipe secrets are not used by the compiled mode THEN `secretNames()` in `src/studio/model.ts` lists them (for example 4 required secrets) under "Secrets needed" (`workflows.js`) and "Provided by env" (`playground.js`), and the Studio UI does not show, for each secret, whether it is configured or missing in the environment given to the server

**A2. Recording overlay**

1.5 WHEN `record()` opens the page THEN no visible indicator in the page says that recording is in progress

1.6 WHEN the user types in a field on one screen and then navigates (full load or SPA route change, for example from `/connexion` to `/clients`) THEN the "Make variable" chip for the earlier field stays for up to `CHIP_LIFETIME_MS` (15 s), because only a timer removes it and the script has no route-change listener, so the user can make the earlier field (the email) a variable instead of the field of the current screen (the client search box)

1.7 WHEN the user clicks "Make variable" THEN `askName()` clears `box.textContent`, which removes the "Mark result" button, and the chip disappears about 1.5 s after OK, so no button is left to mark the result and the user must know the Alt+Shift+R shortcut, which conflicts with browser reading view and read aloud

1.8 WHEN the suggested variable name is long THEN the name input (`input.style.cssText = 'width:140px'`) truncates it

1.9 WHEN the user types into a live search field (a React input that filters on `onChange`, with no Enter and no blur) THEN no `input` listener exists and `flush()` is only reached from `change` (blur) and Enter, so the typed value is not recorded or cannot be made a variable before the user ends the session

1.10 WHEN the user closes the browser window with the window X after marking a result zone (or when `--result-zone` was given) and the page `close` event wins the race against the browser `disconnected` event THEN `readResultZone()` throws because `page.isClosed()` is true, before `saveWorkflow()` runs, and neither the workflow file nor `<out>.recovery.json` is written, so all recorded steps are lost

1.11 WHEN the post-session steps of `record()` fail (`captureFinalScreen`, `readResultZone`, `finalizeNetwork`, `saveWorkflow`) while steps were recorded THEN the error is thrown without writing `<out>.recovery.json`, because `interrupted()` is only reached for `BrowserStoppedError`; and when `interrupted()` is reached, the result zone already marked is not kept

**A3. SPA correlation and Studio polish**

1.12 WHEN a click on an SPA link (for example `<a href="/clients">`) loads a new route, no variable is carried, and the new screen sends a mount request (for example `GET /api/merchants/audience`) THEN `finalizeNetwork()` and `selectRecipe()` attach that request as the Level 1 HTTP recipe of the navigation step, because the recorder keeps no route information per step and `selectRecipe()` accepts any GET with a recipe when `used` is empty

1.13 WHEN the Studio workflow view shows the VARIABLES table in the 320 px right column THEN variable names such as `{{query}}` wrap over three lines, because `.chip` sets `white-space: normal; overflow-wrap: anywhere` and the four-column table gives the name cell its minimum width

1.14 WHEN a workflow is read-only except for a preliminary login form submit THEN the Studio shows only the `write` risk badge (highest risk) and says nothing about which steps write, so the workflow looks like it changes data

1.15 WHEN the playground asks for confirmation before running a tool whose risk is not `read` THEN `confirmDialog()` shows only a generic message ("This tool can write data…") and does not list the steps that write

### Expected Behavior (Correct)

**A1. Phantom HTTP secrets**

2.1 WHEN `replayCore` of a server compiled with `--http` runs THEN the generated server SHALL compute `const plan = planSteps(steps)` before the HTTP secret check, and SHALL pass to `missingHttpSecrets` and `httpSecretValues` only the steps with `plan[i] === 'http'`, so that a step kept on `ui` never causes `missing_secret` for its recorded `$secret` names; the host side of `docker-replay.ts` SHALL apply the same filter in `HTTP_MISSING_SECRETS` and `HTTP_SECRET_VARIABLES`

2.2 WHEN the server is compiled without `--http` THEN no generated file SHALL require, check, forward or list a secret that only appears in `step.http` (`replay.ts` and `docker-replay.ts` keep reading none, `HTTP_SECRET_VARIABLES` and `HTTP_MISSING_SECRETS` stay empty), and the tool description, `mcp.json`, `SKILL.md` and the Kiro power SHALL NOT name it

2.3 WHEN `secretEnvNames(workflow, options)` is called THEN it SHALL include `httpSecretNames(step.http)` only when `options.http === true` and `plan[index] === 'http'` for that step, and the tool description, the `mcp.json` env placeholders, `SKILL.md` and `kiro-power-generator.ts` SHALL list exactly this same set of secret names

2.4 WHEN Studio builds a workflow view (`src/studio/model.ts`) and shows it (`workflows.js`, `playground.js`) THEN it SHALL list the secrets actually required for the compiled mode (using `flags.http` of `StudioOutputs` and `planSteps()`), SHALL list the recorded-but-unused ones separately, and for each required secret SHALL show whether it is configured or missing in the environment that the playground session passes to the server, without ever returning or displaying the value

**A2. Recording overlay**

2.5 WHEN `record()` opens the page THEN the page SHALL show a persistent, collapsible floating panel (a single root element marked `data-daemonize-ui`, so everything inside it is excluded from capture by `inUi()` and from screen hashes) with a visible "Recording" indicator, a step counter, and a preview of the last recorded step labels; the panel SHALL survive SPA route changes and full navigations

2.6 WHEN the user types or selects in a field THEN the panel SHALL offer a "Make variable" button (showing the field name) bound to the last typed or selected field on the current screen, and SHALL clear that offer when a full navigation or an SPA route change happens or when another field is typed in

2.7 WHEN the user makes a field a variable THEN the panel SHALL stay in place with the "Choose the result to capture" button still available, and the variable name input SHALL be wide enough to show a long suggestion without truncation

2.8 WHEN the user types in a text field THEN the capture script SHALL flush the field value after a light debounce (600 ms after the last `input` event, and track it as the last active field), so that its value is recorded, can be made a variable, and is flushed before the session ends, without requiring Enter or blur; successive flushes of the same field with no other step in between SHALL update the same step instead of adding steps

2.9 WHEN the user wants to mark the result THEN the panel SHALL have a permanent "Choose the result to capture" button that starts a clickable selection mode with a visible Cancel button, and no keyboard shortcut SHALL be required

2.10 WHEN the user clicks the primary "Finish and save" button THEN the capture script SHALL end the session through a Playwright binding while the page is still open, so that `captureFinalScreen()` and `readResultZone()` run on an open page and always succeed when the zone is valid; the same end path SHALL be reachable from Node (`LiveRecorder.requestEnd`, `RecordOptions.signal`)

2.11 WHEN the browser is closed early, the page crashes, or a post-session step of `record()` fails while at least one step was recorded THEN `record()` SHALL always write `<out>.recovery.json` through `saveWorkflow()` with the steps captured so far (including any result zone already marked, unchecked if the page is closed), SHALL report the path and the cause in the error, and SHALL NOT lose captured steps silently

2.12 WHEN the user presses Alt+Shift+R THEN the shortcut SHALL still start result marking as it does today, but SHALL NOT be the only way to do it

**A3. SPA correlation and Studio polish**

2.13 WHEN a click is a screen navigation (the route, `origin + pathname`, of the page changes after the click), it is not a submit, no variable is carried (`used` is empty), and the requests after it include read requests (GET or HEAD) THEN `finalizeNetwork()` SHALL NOT attach any of those reads as the HTTP recipe of that step, and when no other request remains the step SHALL be reported at the `accessibility` level with a reason that says it is a screen navigation; write requests (POST, PUT, PATCH, DELETE) of such a click are still eligible

2.14 WHEN Studio shows the VARIABLES table THEN the layout (`app.css`, `workflows.js`) SHALL keep each variable name such as `{{query}}` on one line, with a column wide enough or with horizontal overflow handled, without wrapping the name over several lines

2.15 WHEN a workflow has write steps THEN the Studio SHALL show, next to the write badge, a note listing which steps are writes (step number and label), and when the only write in an otherwise read-only workflow is the preliminary login form, SHALL say so clearly

2.16 WHEN the playground confirmation dialog is shown for a tool that is not `read` THEN it SHALL list the steps that write (step number and label, taken from the risk of each step) and SHALL NOT include any argument or secret value

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a step has `plan[i] === 'http'` and the server is compiled with `--http` THEN the system SHALL CONTINUE TO require the `$secret` names of that step through `missingHttpSecrets`, resolve them through `httpSecretValues`, return `missing_secret` when they are absent, and scrub their values

3.2 WHEN a workflow uses `secretRef`, the `secrets` list, TOTP steps or `COOKIE_HEADER_VARIABLE` THEN the system SHALL CONTINUE TO list and require them exactly as before (`DAEMONIZE_SECRET_<NAME>`)

3.3 WHEN Studio returns any response, writes any artifact, or renders any view THEN the system SHALL CONTINUE TO expose secret names and configured/missing state only, and never a secret value

3.4 WHEN the user types, clicks, selects, hovers or switches pages in the recorded page THEN the system SHALL CONTINUE TO capture the same steps, anchors, row bindings, thumbnails and `switch_page` steps as before, and the panel SHALL NOT appear in a recorded step, a screen hash or a thumbnail

3.5 WHEN a click or submit makes a real search or submit request that carries a variable, or a write request THEN the system SHALL CONTINUE TO capture it as the Level 1 HTTP recipe through `finalizeNetwork()`, `selectRecipe()`, `isFollowUpRead()` and `followUpReads()` with the rules from `nextjs-spa-replay-fixes` (Properties 5 and 6 of `tests/property/nextjs-fix-recipe.property.test.ts` keep passing unchanged)

3.6 WHEN the user marks a result zone, or passes `--result-zone` / `--result-kind`, THEN the system SHALL CONTINUE TO check it on the final page with `readResultZone()` and store the zone with its schema as before

3.7 WHEN the user presses Alt+Shift+R, finishes with Enter in the terminal (`waitForUser`), uses `options.drive`, or closes the window with no result zone marked THEN the system SHALL CONTINUE TO end the recording and save the workflow as before

3.8 WHEN the browser stops while recording and no step was recorded THEN the system SHALL CONTINUE TO fail with "Nothing had been recorded yet" and write no recovery file

3.9 WHEN the Studio server receives requests THEN the system SHALL CONTINUE TO enforce the token, Host and Origin checks, the `x-studio-request` header and the CSP unchanged

3.10 WHEN read-only workflows or tools are shown in Studio or run in the playground THEN the system SHALL CONTINUE TO show them without write warnings, and the playground SHALL CONTINUE TO run `read` tools without confirmation and require `confirm: true` for write and delete tools

3.11 WHEN the CLI commands `record`, `compile` and `studio` are used THEN the system SHALL CONTINUE TO accept the same flags and produce the same output formats, and existing recording, recorder, compiler and Studio tests SHALL CONTINUE TO pass

3.12 WHEN existing tests or scripts locate the recording UI THEN the system SHALL CONTINUE TO expose exactly one element with the `data-daemonize-ui` attribute per frame that shows the recording UI, and the `data-daemonize-action` values `make-variable`, `variable-name`, `confirm-variable`, `mark-result` and `result-kind`, with the "Make variable" button name and the message `Variable "<name>" saved`

3.13 WHEN a terminal program is recorded with `record-tui.ts` THEN the system SHALL CONTINUE TO behave exactly as before (this spec does not change it)

3.14 WHEN the runtime files are generated THEN `replay.ts`, `docker-replay.ts` and every copied runtime module SHALL CONTINUE TO import nothing from `src/`, and the capture script SHALL CONTINUE TO be one injected string with no import
