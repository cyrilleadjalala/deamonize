# Implementation Plan

## Parallel execution rules

The four bug groups (Tasks 1-3, 4-6, 7-9, 10-12) touch DISJOINT files and run in parallel, in the same first waves. Only Task 13 (checkpoint) runs after all of them. Every task states the files it may edit. No agent edits a file owned by another group.

| Group | Tasks | Owned files |
|---|---|---|
| Bug 1 (settle) | 1, 2, 3 | `src/replay/runtime/settle.ts`, `tests/unit/settle.test.ts`, `tests/integration/spa-navigation.test.ts` (new), `tests/property/nextjs-fix-settle.property.test.ts` (new) |
| Bug 2 (plan) | 4, 5, 6 | `src/replay/runtime/http-replay.ts` (`planSteps`, `recipeMutates`), `src/compiler/mcp-generator.ts` (only if needed), `docs/replay-model.md`, `tests/unit/http-replay.test.ts`, `tests/integration/http-replay-e2e.test.ts`, `tests/integration/http-mixed-workflow.test.ts` (new), `tests/property/nextjs-fix-plan.property.test.ts` (new) |
| Bug 3 (recipe) | 7, 8, 9 | `src/recorder/live-recorder.ts`, `src/recorder/network-capture.ts`, `src/recorder/workflow-recorder.ts` (only if `setHttp` needs a change), `tests/unit/select-recipe.test.ts` (new), `tests/unit/dev-internal-url.test.ts` (new), `tests/integration/network-capture.test.ts`, `tests/property/nextjs-fix-recipe.property.test.ts` (new) |
| Bug 4 (ids) | 10, 11, 12 | `src/recorder/selector-builder.ts`, `tests/unit/generated-ids.test.ts` (new), `tests/property/nextjs-fix-ids.property.test.ts` (new) |

Notes for all groups:
- Property tests carry the tag `// Feature: nextjs-spa-replay-fixes, Property N: <title>` on the line above the property. The vitest config already includes `tests/property/**/*.test.ts` in the unit project.
- `settle.ts` and `http-replay.ts` stay dependency free (no `playwright`, no import from `src/`).
- The `recipeMutates` replay-side change (defect 1.9) lives in `http-replay.ts`, so it belongs to the Bug 2 group (Task 6.1), not to Bug 3. The Bug 3 group never edits `http-replay.ts` or `mcp-generator.ts`.
- Run only your own test files while working, for example `npx vitest run tests/unit/settle.test.ts`. The full `npm test` runs only in Task 13.

## Bug 1: `waitForEffect` ends too early (group A)

- [x] 1. Write bug condition exploration test for settle
  - **Property 1: Bug Condition** - Wait covers slow requests, SPA navigation and hydration
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `tests/property/nextjs-fix-settle.property.test.ts` (new), `tests/integration/spa-navigation.test.ts` (new)
  - **Scoped PBT Approach**: scope to the concrete failing cases below, with random durations above 2 s
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 1: Bug Condition - Wait covers slow requests, SPA navigation and hydration`
  - Test cases from the design (Exploratory Bug Condition Checking, cases 1 to 4), isBugCondition_1:
    - `RequestTracker.start('a', 'http://x/clients?_rsc=1', 'fetch', {}, 0)`: `pending(LONG_LIVED_MS + 1)` is 1 for a single request (unfixed code returns 0)
    - Fake page with injected time: a finished request, then `nav` changes 700 ms later. `waitForEffect` must not return `'response'` before the nav is observed and the DOM was quiet for 250 ms
    - Fake page that fires `framenavigated` and keeps mutating for 200 ms. The result must come only after a 250 ms quiet period, never later than `boundAt`
  - Integration test in the NEW file `tests/integration/spa-navigation.test.ts`: a local HTTP page whose link click runs `fetch('/slow-rsc')` (response after about 3 s, more than 2 s), then `history.pushState` and renders a new heading. `waitForEffect` with `action: click` must return only after the heading exists and within the bound. Follow the harness of `tests/integration/waits.test.ts` (do not edit that file)
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (returns at about 2.1 s with `'quiet'`)
  - Document the counterexamples found (for example "`waitForEffect` returned `'quiet'` at 2.1 s while the heading did not exist")
  - Mark the task complete when the tests are written, run, and the failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.3, 2.4_

- [x] 2. Write preservation property tests for settle (BEFORE implementing the fix)
  - **Property 2: Preservation** - Streams, polls, quiet pages and bounds settle as before
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/nextjs-fix-settle.property.test.ts` (same new file as Task 1; Task 1 and Task 2 are done by the same agent, in order)
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 2: Preservation - Streams, polls, quiet pages and bounds settle as before`
  - Observe on UNFIXED code: websocket, eventsource, `text/event-stream`, `data:`/`blob:` and periodic requests are not counted. An action with no request and no navigation returns `'quiet'` after `quietMs`. A never-ending request returns `'bound'` at `timeoutMs`. A counted request that responds returns `'response'`. An `opts.action` error is passed on. A full navigation on a quiet page returns after `domcontentloaded`
  - Write property tests: random mixes of ignorable and periodic requests with a quiet DOM return `'quiet'` quickly. `RequestTracker.pending` equals the original implementation (kept in the test as `originalPending`) for ignorable and periodic entries
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS (baseline behavior)
  - Mark the task complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 2.2, 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix `waitForEffect` for slow requests, SPA navigation and hydration

  - [x] 3.1 Implement the fix in `src/replay/runtime/settle.ts`
    - Add `NAV_QUIET_MS = 250`. Change the `LONG_LIVED_MS` comment to "repeated requests only"
    - `RequestTracker.counts()`: ignorable or periodic entries never count. A single request counts until it finishes. The age guard applies only to a URL key started at least twice in the same wait and still pending after `LONG_LIVED_MS`
    - `QuietTracker`: add `touch(now)` and `isQuietFor(now, ms)`. `observe` reads optional `nav` and `href` from `DomSample` and calls `touch` on a change
    - Extend `DomSample` with optional `nav` and `href`. `OBSERVE_EXPRESSION` patches `history.pushState` / `replaceState` once per document, listens to `popstate` / `hashchange`, and returns `nav` and `href`
    - `waitForEffect`: record base `nav` and `href` from the first sample and set `spaNavigated` on a change. Each counted request that finishes calls `quiet.touch(now)`. After `navigated` or `spaNavigated`, wait for `domcontentloaded` once (full navigation, bounded), then return `'navigation'` only when `quiet.isQuietFor(t, NAV_QUIET_MS)` or `t >= boundAt`. Before a navigation, `'quiet'` requires `pending(t) == 0`
    - Keep `settle.ts` free of imports from `src/` and `playwright`. The generated `replayCore` needs no change for this bug
    - _Bug_Condition: isBugCondition_1(X) from design (counted fetch/xhr pending over 2 s, SPA navigation after the requests, `framenavigated` with a moving DOM)_
    - _Expected_Behavior: return not before every counted request finished or `boundAt`, `nav`/`href` change counts as an effect, after a navigation return after 250 ms of DOM quiet, never later than `boundAt`_
    - _Preservation: Property 2 (streams, polls, quiet pages, bounds settle as before)_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Rewrite the test that encodes the bug in `tests/unit/settle.test.ts`
    - Replace "stops waiting for a request that stays pending (long poll)" with "keeps counting a single slow request until it finishes", checking before and after `LONG_LIVED_MS + 1`
    - Add "keeps the long-poll protection for a repeated key": two starts of `/events`, pending after 2 s, not counted
    - Add: `responded` is false until the DOM has been quiet `quietMs` after the last finish (fake page)
    - Add: SPA navigation seen through `nav`, and through `href` only, then `'navigation'` after 250 ms of quiet
    - Add: `framenavigated` followed by mutations returns after the quiet period, and at `boundAt` when mutations never stop
    - Add: a sample with no `nav` and `href` (existing fake pages) still works
    - Keep every other existing test unchanged. Do NOT edit `tests/integration/waits.test.ts`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.2_

  - [x] 3.3 Verify the bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Wait covers slow requests, SPA navigation and hydration
    - **IMPORTANT**: Re-run the SAME tests from Task 1 (`tests/property/nextjs-fix-settle.property.test.ts` Property 1 and `tests/integration/spa-navigation.test.ts`). Do NOT write new tests
    - **EXPECTED OUTCOME**: tests PASS (confirms the bug is fixed)
    - _Requirements: 2.1, 2.3, 2.4_

  - [x] 3.4 Verify preservation tests still pass
    - **Property 2: Preservation** - Streams, polls, quiet pages and bounds settle as before
    - **IMPORTANT**: Re-run the SAME tests from Task 2, plus `tests/unit/settle.test.ts` and `tests/integration/waits.test.ts` (the busy page must still settle in under 3 s)
    - **EXPECTED OUTCOME**: tests PASS (confirms no regressions)
    - _Requirements: 2.2, 3.1, 3.2, 3.3, 3.4_

## Bug 2: mixed UI + HTTP workflows in `--http` mode (group B)

- [x] 4. Write bug condition exploration test for `planSteps`
  - **Property 3: Bug Condition** - Nothing runs over HTTP before a browser step
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `tests/property/nextjs-fix-plan.property.test.ts` (new), `tests/integration/http-mixed-workflow.test.ts` (new)
  - **Scoped PBT Approach**: random step lists where a recipe step is followed by a `ui` step (isBugCondition_2)
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 3: Bug Condition - Nothing runs over HTTP before a browser step`
  - Property: for every step list, no index has mode `'http'` or `'prep'` while a later index is `'ui'`
  - Concrete case: `[type email, type password, click Continue (POST /api/auth/login/credentials), type TOTP (secret/totp), click Verify (POST /api/auth/login/verify, auth storageState)]` must plan all `'ui'` (unfixed gives `['ui','ui','http','ui','http']`)
  - Mixed-workflow regression in the NEW file `tests/integration/http-mixed-workflow.test.ts`: a local multi-screen page (login form, then a TOTP screen after a credentials POST). Run a workflow of login step (ui), a click with an http recipe, and a TOTP-like ui step through the generated replay path in `--http` mode (follow the harness of `tests/integration/http-replay-e2e.test.ts`, do not edit that file here). Assert that the browser screen has advanced to the TOTP screen when the TOTP step runs
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (the page stays on the first screen)
  - Document the counterexamples found
  - _Requirements: 1.4, 1.5, 2.5, 2.7_

- [x] 5. Write preservation property tests for `planSteps` (BEFORE implementing the fix)
  - **Property 4: Preservation** - HTTP-only and recipe-free workflows plan as before
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/nextjs-fix-plan.property.test.ts` (same new file as Task 4; the same agent does Task 4 then Task 5)
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 4: Preservation - HTTP-only and recipe-free workflows plan as before`
  - Observe on UNFIXED code: `[type q, click http]` gives `['prep','http']`. `[type other, click http]` and `[type secret, click http]` give `['ui','http']`. A workflow with no recipe is all `'ui'`. An all-recipe/`prep` workflow satisfies `isHttpOnly`
  - Keep the unfixed logic in the test as `originalPlanSteps`. Property: for lists with no recipe step before a `ui` step (isBugCondition_2 false), `planSteps` equals `originalPlanSteps`. Lists without recipes are all `'ui'`. A secret, a TOTP step and a non-preparatory step stay `'ui'`
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.5, 3.6, 3.7_

- [x] 6. Fix for `--http` plan on mixed workflows

  - [x] 6.1 Implement the fix in `src/replay/runtime/http-replay.ts` (and `src/compiler/mcp-generator.ts` only if needed)
    - Rename the existing body of `planSteps` to `rawPlan`. New `planSteps`: when the raw plan has a `ui` step, demote every `http` step whose recipe has `auth === 'storageState'` to `'ui'`, then set every index up to the last `ui` index to `'ui'` (this also demotes `prep` steps). Steps after the last `ui` step keep their raw mode. An all-HTTP plan is unchanged. A recipe without `auth` is treated as independent
    - Update the doc comment of `planSteps` with the rule and the cookie rationale from the design
    - Add and export `recipeMutates(recipe: { method: string }): boolean` (false for GET and HEAD, case-insensitive). This is the replay-side half of defect 1.9
    - In `WEB_RUNTIME_HTTP` of `src/compiler/mcp-generator.ts`, add `recipeMutates` to the `http-replay.js` import and replace the read-fallback condition `(step.risk ?? "read") !== "read"` with `recipeMutates(step.http)`. A write or delete recipe that was sent is still never retried or run twice. Update the comment above `WEB_RUNTIME_HTTP`. This is the ONLY place `mcp-generator.ts` is edited; check that `tests/unit` generator tests still pass
    - Add a section "Mixed workflows" to `docs/replay-model.md` with the rule and the cookie rationale (requirement 2.8)
    - Keep `http-replay.ts` free of imports from `src/` and `playwright`
    - _Bug_Condition: isBugCondition_2(steps) from design (a recipe or prep step followed by a ui step)_
    - _Expected_Behavior: no `'http'` or `'prep'` before a later `'ui'`; final suffix keeps raw mode unless `auth === 'storageState'`_
    - _Preservation: Property 4 (HTTP-only and recipe-free workflows plan as before)_
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.12, 3.5, 3.6, 3.7_

  - [x] 6.2 Update the existing tests that encode the bug
    - `tests/unit/http-replay.test.ts`: the two lines `[click http, click]` and `[click http, type q]` expect `['ui','ui']`. Keep `[type other, click http]` and `[type secret, click http]` as `['ui','http']`
    - Add unit tests: mixed credentials/TOTP/verify example is all `'ui'`. `[type q, click http]` is `['prep','http']`. `[http, ui]` is `['ui','ui']`. A `prep` before a demoted `http` becomes `'ui'`. `[ui, http(auth none)]` is `['ui','http']`. `[ui, http(auth storageState)]` is `['ui','ui']`. `[ui, http(auth storageState), http(auth none)]` is `['ui','ui','http']`. `recipeMutates` for GET, HEAD, POST, PUT, PATCH, DELETE
    - `tests/integration/http-replay-e2e.test.ts` case (d): `levels` becomes four `'accessibility'` and `app.direct.search` must not increase. Add a case where a GET recipe redirects to an HTML login page (status 200): it falls back to the page once and `levelFallback` is true. A POST failure is still not retried. This case covers defect 1.9 at replay time
    - Keep every other existing test unchanged
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.12, 3.7_

  - [x] 6.3 Verify the bug condition exploration test now passes
    - **Property 3: Expected Behavior** - Nothing runs over HTTP before a browser step
    - **IMPORTANT**: Re-run the SAME tests from Task 4 (`tests/property/nextjs-fix-plan.property.test.ts` Property 3 and `tests/integration/http-mixed-workflow.test.ts`). Do NOT write new tests
    - **EXPECTED OUTCOME**: tests PASS (the browser screen advances before the TOTP step)
    - _Requirements: 2.5, 2.7_

  - [x] 6.4 Verify preservation tests still pass
    - **Property 4: Preservation** - HTTP-only and recipe-free workflows plan as before
    - **IMPORTANT**: Re-run the SAME tests from Task 5, plus `tests/unit/http-replay.test.ts` and `tests/integration/http-replay-e2e.test.ts` (Docker-gated cases only when `DAEMONIZE_DOCKER_TESTS=1` and Docker is up)
    - **EXPECTED OUTCOME**: tests PASS (no regressions)
    - _Requirements: 3.5, 3.6, 3.7_

## Bug 3: wrong recipe recorded and dev/HMR requests captured (group C)

- [x] 7. Write bug condition exploration test for recipe selection and dev URLs
  - **Property 5: Bug Condition** - The recorded recipe is the right request
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `src/recorder/live-recorder.ts` (extraction only, see below), `tests/unit/select-recipe.test.ts` (new), `tests/unit/dev-internal-url.test.ts` (new), `tests/property/nextjs-fix-recipe.property.test.ts` (new), `tests/integration/network-capture.test.ts`
  - **Preparation (behavior-neutral)**: so the test can call it on unfixed code, extract the choice made in `LiveRecorder.finalizeNetwork` (`src/recorder/live-recorder.ts`, line about 181) into an exported pure function `selectRecipe(attempts, { submit })` that keeps the ORIGINAL behavior (`rank(a) >= rank(best)`, no write preference). Export `isDevInternalUrl` from `src/recorder/network-capture.ts` as a stub returning `false` (also behavior-neutral), so the test file imports resolve. Do not change any other behavior
  - **Scoped PBT Approach**: random attempt lists, plus the concrete cases from the design
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 5: Bug Condition - The recorded recipe is the right request`
  - Property: the chosen element is the first of the maximal-rank group, a write method for a submit step if one qualifies, never a dev URL, and its risk is that of its own method
  - Concrete cases in `tests/unit/select-recipe.test.ts`: `[POST /api/auth/login/verify, GET /api/settings/system]` both rank 0 must give the POST (unfixed gives the GET). A submit step with only an unbound GET must give no recipe
  - Concrete cases in `tests/unit/dev-internal-url.test.ts`: `isStaticUrl` is true for `http://localhost:3000/_next/static/webpack/abc.webpack.hot-update.json`, `/_next/webpack-hmr`, `/__nextjs_original-stack-frame`, and `isDevInternalUrl` is true for the same URLs (unfixed: false)
  - Integration case in `tests/integration/network-capture.test.ts`: a page that fires an HMR fetch after a click must yield no recipe for it. Edit only by adding cases
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL on the assertions (not on missing imports)
  - Document the counterexamples found
  - _Requirements: 1.6, 1.7, 1.8, 1.9, 2.9, 2.10, 2.11, 2.12_

- [x] 8. Write preservation property tests for recipe selection (BEFORE implementing the fix)
  - **Property 6: Preservation** - Other requests and risks are recorded as before
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/nextjs-fix-recipe.property.test.ts`, `tests/unit/select-recipe.test.ts`, `tests/unit/dev-internal-url.test.ts` (the same new files as Task 7; the same agent does Task 7 then Task 8)
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 6: Preservation - Other requests and risks are recorded as before`
  - Observe on UNFIXED code: one qualifying request is chosen. A request with a higher rank is chosen. `isStaticUrl` is true for `.js`, `.css`, images and fonts, and false for `/api/customers?q=a` and `/_next/data/x/page.json`. `isAnalyticsUrl` is unchanged. A step with no qualifying request keeps the same reason texts. A write recipe makes the step `write`
  - Keep the original reduce in the test as `originalPick`. Property: for non-submit steps with no tie, `selectRecipe` equals `originalPick`. For lists with one qualifying request, it is chosen
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.7, 3.8, 3.9, 3.10_

- [x] 9. Fix for recipe selection, dev/HMR capture and recipe risk

  - [x] 9.1 Implement the fix in `src/recorder/network-capture.ts`, `src/recorder/live-recorder.ts` (and `src/recorder/workflow-recorder.ts` only if `setHttp` needs it)
    - `isDevInternalUrl(url)`: implement the path list from the design (`*.hot-update.(json|js)`, `_next/static`, `_next/webpack-hmr`, `__nextjs*`, `__webpack_hmr`, `webpack-hmr`, `@vite`, `@react-refresh`, `@fs`, `__vite_ping`, `sockjs-node`). `isStaticUrl` returns `STATIC_PATH.test(pathname) || isDevInternalUrl(url)`. `_next/data/...` JSON is not filtered
    - `selectRecipe(attempts, { submit })`: candidates are attempts with a recipe whose bound variables cover the used ones. For a submit step, drop a GET/HEAD that binds nothing. Order: write method first (submit only), then more bound variables, then earliest (`>` instead of `>=`). `finalizeNetwork` calls it, with `submit = (step.risk ?? 'read') !== 'read'`
    - For a submit step whose only candidate is an unbound GET, report `accessibility` with the reason `GET /path: follow-up read of a submit step, not used`. All other reason texts stay unchanged
    - Risk: when a recipe was chosen, pass `riskOfMethod(recipe.method)` to `setHttp`. When none was chosen keep the maximum over all captured requests. `setHttp` never lowers `step.risk`
    - Do NOT edit `src/replay/runtime/http-replay.ts` or `src/compiler/mcp-generator.ts` (the `recipeMutates` change is Task 6.1 in group B)
    - _Bug_Condition: isBugCondition_3(X) from design (dev/HMR URL, tie, submit step with a follow-up GET, unbound GET on a submit step, risk raised by unrelated requests)_
    - _Expected_Behavior: dev URLs ignored, first of equal rank kept, write preferred for a submit step, recipe risk equals its method risk, `step.risk` never lowered_
    - _Preservation: Property 6 (other requests and risks recorded as before)_
    - _Requirements: 2.9, 2.10, 2.11, 2.12, 3.7, 3.8, 3.9, 3.10_

  - [x] 9.2 Add and adjust tests
    - `tests/unit/select-recipe.test.ts`: tie keeps first, higher rank wins, write beats a later GET for a submit step, an unbound GET is dropped for a submit step, a GET with a bound variable stays, a non-submit step picks by rank then earliest
    - `tests/unit/dev-internal-url.test.ts`: the listed dev URLs are filtered. `/api/customers` and `/_next/data/x/page.json` are not
    - Risk: `setHttp` keeps a `write` step at `write` with a GET recipe and raises a `read` step to `write` for a POST (put these cases in `tests/unit/select-recipe.test.ts`; do not edit `tests/unit/workflow-recorder.test.ts` or `tests/unit/http-correlate.test.ts`)
    - `tests/integration/network-capture.test.ts`: a submit that fires the write and then a dashboard GET keeps the write. Adjust only the cases the change requires, keep all other cases unchanged
    - _Requirements: 2.9, 2.10, 2.11, 2.12, 3.8, 3.9, 3.10_

  - [x] 9.3 Verify the bug condition exploration test now passes
    - **Property 5: Expected Behavior** - The recorded recipe is the right request
    - **IMPORTANT**: Re-run the SAME tests from Task 7. Do NOT write new tests
    - **EXPECTED OUTCOME**: tests PASS (confirms the bug is fixed)
    - _Requirements: 2.9, 2.10, 2.11, 2.12_

  - [x] 9.4 Verify preservation tests still pass
    - **Property 6: Preservation** - Other requests and risks are recorded as before
    - **IMPORTANT**: Re-run the SAME tests from Task 8, plus `tests/unit/http-correlate.test.ts`, `tests/property/http-correlate.property.test.ts` and `tests/integration/network-capture.test.ts`
    - **EXPECTED OUTCOME**: tests PASS (no regressions)
    - _Requirements: 3.7, 3.8, 3.9, 3.10_

## Bug 4: generated React / Radix ids become selectors (group D)

- [x] 10. Write bug condition exploration test for generated ids
  - **Property 7: Bug Condition** - Generated ids never become selectors
  - **CRITICAL**: This test MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails**
  - **Files owned**: `src/recorder/selector-builder.ts` (export only, see below), `tests/unit/generated-ids.test.ts` (new), `tests/property/nextjs-fix-ids.property.test.ts` (new)
  - **Preparation (behavior-neutral)**: export `looksGenerated` from `src/recorder/selector-builder.ts` unchanged, if it is not exported yet
  - **Scoped PBT Approach**: generate React 18 (`:r0:`), React 19 (`_R_<token>_-field`), guillemet (`«r2»`) and Radix (`radix-:r1:`) ids with random tokens, on elements with a role and name
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 7: Bug Condition - Generated ids never become selectors`
  - Property: the result of `buildSelectors` has no `#id` and no css path anchored on that id, and equals the result for the same element without the id
  - Concrete case: `buildSelectors({ role:'textbox', name:'Code', id:'_R_13qatpesnelb_-field', css:'#_R_13qatpesnelb_-field' })` must be `['role=textbox[name="Code"]']`. Two fields that share a reused id give selectors that do not contain it
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests FAIL (`#_R_...` or the css path appears). If only `#id` appears and the css path does not, the css-anchoring hypothesis is refuted: record that and drop the css guard in Task 12.1
  - Document the counterexamples found
  - _Requirements: 1.10, 1.11, 1.12, 2.13, 2.14_

- [x] 11. Write preservation property tests for selectors (BEFORE implementing the fix)
  - **Property 8: Preservation** - Stable ids and selector order are unchanged
  - **IMPORTANT**: Follow the observation-first methodology
  - **Files owned**: `tests/property/nextjs-fix-ids.property.test.ts` and `tests/unit/generated-ids.test.ts` (the same new files as Task 10; the same agent does Task 10 then Task 11)
  - Tag the property `// Feature: nextjs-spa-replay-fixes, Property 8: Preservation - Stable ids and selector order are unchanged`
  - Observe on UNFIXED code: `email`, `login-form`, `save` give `#id`. `rooms:list` gives `#rooms\:list` or the same output as today. `a3f9c2d10b7e` and `12345` are generated. Selector order is role/name, testId, id, name attribute, text, css
  - Keep the unfixed logic in the test as `originalLooksGenerated` and a copy of the original `buildSelectors` as `originalBuildSelectors`. Property: ids from `[a-z][a-z-]{0,12}` with no pattern match give `looksGenerated` equal to the original and `buildSelectors` equal to the original
  - Run on UNFIXED code. **EXPECTED OUTCOME**: tests PASS
  - _Requirements: 3.11, 3.12_

- [x] 12. Fix for generated ids in `selector-builder.ts`

  - [x] 12.1 Implement the fix in `src/recorder/selector-builder.ts`
    - `looksGenerated` becomes a pattern list: the two existing patterns plus `/:[rR][0-9a-z]+:/` (colon required, so `rooms:list` is not flagged), `/^_[rR]_[0-9a-z]+_/`, `/^«[^»]*»/` and `/^radix-/`. Keep it exported
    - `buildSelectors`: add `cssStartsOnGeneratedId(css)` that reads the first `#...` token (unescaping `\x` pairs) and applies `looksGenerated`. Drop the `css` selector when it starts on a generated id and other selectors exist. A bare element keeps its last-resort css selector. Keep the existing order. `buildZoneSelector` needs no change
    - Do not edit `src/recorder/capture-script.ts`
    - _Bug_Condition: isBugCondition_4(element) from design (generated id pattern, or css anchored on a generated id)_
    - _Expected_Behavior: no `#id` and no id-anchored css when other selectors exist, same list as for the element without the id_
    - _Preservation: Property 8 (stable ids and selector order unchanged)_
    - _Requirements: 2.13, 2.14, 3.11, 3.12_

  - [x] 12.2 Add unit tests in `tests/unit/generated-ids.test.ts`
    - `_R_jqatpesnelb_-field`, `_R_13qatpesnelb_-field`, `:r0:`, `radix-:r1:`, `«r2»` are generated. `email`, `login-form`, `save`, `rooms:list` are not. Hex runs and digit-only ids stay generated
    - `buildSelectors` gives the same list with and without a generated id. It drops `#_R_..._` css when other selectors exist and keeps it when none exist
    - Do not edit `tests/unit/workflow-recorder.test.ts`; run it to confirm it still passes
    - _Requirements: 2.13, 2.14, 3.11, 3.12_

  - [x] 12.3 Verify the bug condition exploration test now passes
    - **Property 7: Expected Behavior** - Generated ids never become selectors
    - **IMPORTANT**: Re-run the SAME tests from Task 10. Do NOT write new tests
    - **EXPECTED OUTCOME**: tests PASS (confirms the bug is fixed)
    - _Requirements: 2.13, 2.14_

  - [x] 12.4 Verify preservation tests still pass
    - **Property 8: Preservation** - Stable ids and selector order are unchanged
    - **IMPORTANT**: Re-run the SAME tests from Task 11, plus `tests/unit/workflow-recorder.test.ts`
    - **EXPECTED OUTCOME**: tests PASS (no regressions)
    - _Requirements: 3.11, 3.12_

## Final checkpoint (runs after all four groups)

- [x] 13. Checkpoint - Ensure all tests pass
  - Starts only when Tasks 3, 6, 9 and 12 are complete. Run the commands in order from `d:\deamonize\workspace`. Redirect each output to a file in `%TEMP%` and report the exact results (exit code, test files passed/failed, tests passed/failed/skipped, and the path of each output file)
  - [x] 13.1 Run `npm run build > "$env:TEMP\nextjs-fix-build.txt" 2>&1`
    - Report the exit code and any TypeScript errors
    - _Requirements: 2.1, 2.5, 2.9, 2.13_
  - [x] 13.2 Run `npm run check:secrets > "$env:TEMP\nextjs-fix-secrets.txt" 2>&1`
    - Report the exit code. New tests and docs must hold no cookie or token value
    - _Requirements: 3.7_
  - [x] 13.3 Run `npm test > "$env:TEMP\nextjs-fix-test.txt" 2>&1` (`DAEMONIZE_DOCKER_TESTS` unset is fine)
    - Report the exact counts. Confirm the rewritten settle test, the two updated `http-replay` lines and case (d) are the only changed expectations of existing tests
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12_
  - [x] 13.4 When Docker is up, run `$env:DAEMONIZE_DOCKER_TESTS='1'; npx vitest run tests/integration/docker-sandbox.test.ts tests/integration/http-replay-e2e.test.ts > "$env:TEMP\nextjs-fix-docker.txt" 2>&1`
    - Report the exact counts, or state that Docker was not available and the run was skipped
    - _Requirements: 2.5, 2.6, 2.12, 3.5, 3.7_
  - Ensure all tests pass, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1", "2", "4", "5", "7", "8", "10", "11"],
      "note": "Exploration and preservation tests of the four bug groups. Within a group, the Property tests share one file, so one agent does them in order (1 then 2, 4 then 5, 7 then 8, 10 then 11)."
    },
    {
      "id": 1,
      "tasks": ["3.1", "6.1", "9.1", "12.1"],
      "note": "Fixes. Disjoint source files: settle.ts, http-replay.ts + mcp-generator.ts, live-recorder.ts + network-capture.ts, selector-builder.ts."
    },
    {
      "id": 2,
      "tasks": ["3.2", "6.2", "9.2", "12.2"],
      "note": "Tests that update or extend existing and new files of each group."
    },
    {
      "id": 3,
      "tasks": ["3.3", "3.4", "6.3", "6.4", "9.3", "9.4", "12.3", "12.4"],
      "note": "Verification of Property 1-8 within each group."
    },
    {
      "id": 4,
      "tasks": ["13.1", "13.2", "13.3", "13.4"],
      "note": "Final checkpoint, sequential in this order, only after all four groups are done."
    }
  ],
  "groups": {
    "A-bug1-settle": ["1", "2", "3"],
    "B-bug2-plan": ["4", "5", "6"],
    "C-bug3-recipe": ["7", "8", "9"],
    "D-bug4-ids": ["10", "11", "12"],
    "checkpoint": ["13"]
  },
  "dependencies": {
    "2": ["1"],
    "3": ["1", "2"],
    "5": ["4"],
    "6": ["4", "5"],
    "8": ["7"],
    "9": ["7", "8"],
    "11": ["10"],
    "12": ["10", "11"],
    "13": ["3", "6", "9", "12"]
  }
}
```
