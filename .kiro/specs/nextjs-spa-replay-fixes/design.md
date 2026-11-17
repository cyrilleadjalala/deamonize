# Next.js SPA Replay Fixes Bugfix Design

## Overview

Replaying and recording workflows against a Next.js 15 / React 19 App Router app fails in four places:

1. `waitForEffect` (`src/replay/runtime/settle.ts`) returns before an SPA navigation has rendered. It stops counting a normal fetch after `LONG_LIVED_MS` (2 s), it does not see a `history.pushState` navigation, and after `framenavigated` it returns without waiting for the DOM to settle.
2. `planSteps` (`src/replay/runtime/http-replay.ts`) marks a step that has a recipe as `'http'` even when `ui` steps follow. The click runs through Node `fetch()`, the Playwright page stays on the first screen, and the following `ui` steps act on the wrong screen.
3. `LiveRecorder.finalizeNetwork` (`src/recorder/live-recorder.ts`) keeps the last request when ranks tie, can keep a follow-up GET instead of the write, and derives risk from unrelated requests. `network-capture.ts` also records Next.js HMR and dev requests.
4. `looksGenerated` (`src/recorder/selector-builder.ts`) does not know React `useId()` or Radix ids, so `#<id>` and a `css` path anchored on that id are emitted as fallback selectors and can match the wrong field.

Each fix is small and local. Two files are copied verbatim into generated output (`settle.ts`, `http-replay.ts`). They stay dependency free: no `playwright`, no import from `src/`. All new runtime code uses only what the file already has (`node:fs`, `node:crypto`, global `fetch`) and plain TypeScript.

### Decisions

| Topic | Decision |
|---|---|
| DOM quiet period after a navigation | `NAV_QUIET_MS = 250`, measured from the last DOM mutation, inside `boundAt`. |
| Observing SPA navigation | The existing `OBSERVE_EXPRESSION` (already evaluated every 20 ms through `page.evaluate`) also patches `history.pushState` / `replaceState` once per document and listens to `popstate` / `hashchange`. It reports `nav` (a counter) and `href`. A change of either counts as a navigation. No new page method, no Playwright import. |
| Pending requests | A fetch/xhr is counted until it finishes or the bound is reached. It is excluded by nature (websocket, eventsource, `text/event-stream`, `data:`/`blob:`, `isPeriodic`) or, when it is clearly repeated, by age. |
| Age guard | Only for a URL key started two or more times in the same wait and still pending after `LONG_LIVED_MS` (2 s). A single request is never dropped by age. |
| `planSteps` for mixed workflows | Demote every `http` or `prep` step that has a `ui` step after it. A final suffix with no `ui` step may stay HTTP unless its recipe relies on cookies (`auth === 'storageState'`), in which case it is demoted. |
| Recipe ranking | For a step whose UI risk is `write` or `delete`: write method first, then more bound variables, then earliest. For other steps: more bound variables, then earliest. |
| Dev/HMR filter | `isDevInternalUrl`, folded into `isStaticUrl`. |
| Recipe risk | `setHttp` receives the risk of the chosen recipe's method. `step.risk` is never lowered, so the UI risk stays for the accessibility level. The Level 1 fallback decision at replay uses the recipe method. |
| `looksGenerated` | Four new patterns (React 18, React 19, guillemet form, Radix), and a `css` path anchored on a generated id is dropped when other selectors exist. |

### Existing tests that encode the bug

Three existing tests assert the defective behavior. They are rewritten, not preserved, and the reason is recorded here so the change is deliberate:

- `tests/unit/settle.test.ts`, "stops waiting for a request that stays pending (long poll)": one `fetch` to `/poll`, pending after `LONG_LIVED_MS`, expected not to count. That is defect 1.1. It becomes "keeps counting a single slow request until it finishes", and a new test keeps the long-poll protection for a repeated key. Requirement 3.2 ("existing tests pass unchanged") cannot hold for this one test.
- `tests/unit/http-replay.test.ts`, "keeps a click, a secret or an unbound variable on the page": the two lines `[click http, click]` → `['http','ui']` and `[click http, type q]` → `['http','ui']` become `['ui','ui']`. The lines `[type other, click http]` and `[type secret, click http]` → `['ui','http']` stay as they are (final suffix, recipe without `auth`).
- `tests/integration/http-replay-e2e.test.ts`, case (d): `levels` `['accessibility','http','accessibility','accessibility']` becomes four `'accessibility'`, and `app.direct.search` must not increase.

`waits.test.ts` needs no change. The busy page has no request that stays pending, and its WebSocket, SSE and 100 ms poll are excluded by nature or periodicity.

Requirement numbering note: `bugfix.md` numbers Current Behavior 1.1 to 1.12 (bug 1: 1.1-1.3, bug 2: 1.4-1.5, bug 3: 1.6-1.9, bug 4: 1.10-1.12), Expected Behavior 2.1 to 2.14 and Unchanged Behavior 3.1 to 3.12. The "Validates" lines cite the Expected (2.x) and Unchanged (3.x) clauses only.

## Glossary

- **Bug_Condition (C)**: The set of inputs that trigger one of the four defects, defined per bug in "Bug Details".
- **Property (P)**: The behavior required for inputs in C.
- **Preservation**: Behavior for inputs outside C that must stay identical to the original code.
- **F / F'**: The original and the fixed function.
- **waitForEffect**: Function in `src/replay/runtime/settle.ts` that waits for the observable effect of an action. It resolves with `'navigation' | 'quiet' | 'response' | 'bound'`.
- **RequestTracker / QuietTracker**: Classes in `settle.ts` that track pending requests and DOM mutations with injected time.
- **LONG_LIVED_MS**: Age (2000 ms) after which a request used to stop being counted.
- **boundAt**: `Date.now() + timeoutMs`, taken after the action. No wait goes past it.
- **isPeriodic**: Helper that detects evenly spaced timestamps (poll loop or ticker).
- **planSteps / StepMode**: `planSteps` in `src/replay/runtime/http-replay.ts` returns `'http' | 'prep' | 'ui'` per step. `http` runs with Node `fetch()`, `prep` is a field fill skipped because a later request carries its value, `ui` runs in the browser.
- **raw plan**: The plan `planSteps` computes before demotion (today's result).
- **final suffix**: The steps after the last `ui` step of a plan.
- **replayCore**: Generated function (`WEB_RUNTIME_HTTP` in `src/compiler/mcp-generator.ts`) that runs a plan.
- **finalizeNetwork**: Method of `LiveRecorder` that picks the recipe of each step from the requests captured after its action.
- **rank**: Number of variables a candidate request binds (`attempt.bound.length`).
- **submit step**: A step whose UI risk is `write` or `delete`. `classifyRisk` already gives `write` to a submit click, to Enter in a form field, and to a click whose name matches the write or delete words, so the recorder needs no new flag.
- **isDevInternalUrl**: New helper in `network-capture.ts` for framework dev/HMR URLs.
- **generated id**: An element id produced by a framework (React `useId`, Radix, hex runs, digits) that changes between renders and may be shared.

## Bug Details

### Bug Condition

**Bug 1.** The wait ends before the action's effect is visible when a counted request is still pending after 2 s, when an SPA navigation completes after the requests, or when `framenavigated` fires and the DOM is still changing.

**Formal Specification:**
```
FUNCTION isBugCondition_1(X)
  INPUT: X of type ActionEffect (requests started by the action, navigation events, DOM mutation times)
  OUTPUT: boolean

  RETURN (EXISTS r IN X.requests WHERE r.type IN {fetch, xhr}
            AND NOT isIgnorable(r) AND NOT isPeriodic(startTimes(r.urlKey))
            AND r.duration > LONG_LIVED_MS AND r.startedAt + r.duration < X.boundAt)
      OR (X.spaNavigation AND X.lastMutationAfterNavigation > X.returnTimeOfF)
      OR (X.navigated AND NOT domQuiet(NAV_QUIET_MS, after X.navigationEnd))
END FUNCTION
```

**Bug 2.** A step with a recipe has a `ui` step after it in the plan.

```
FUNCTION isBugCondition_2(steps)
  INPUT: steps of type PlanStepLike[]
  OUTPUT: boolean

  raw := planStepsBeforeDemotion(steps)
  RETURN EXISTS i, j WHERE i < j AND raw[i] IN {'http', 'prep'} AND raw[j] = 'ui'
END FUNCTION
```

**Bug 3.** Recipe selection or capture goes wrong for one step.

```
FUNCTION isBugCondition_3(X)
  INPUT: X of type StepRequests (captured requests of one step, step risk)
  OUTPUT: boolean

  RETURN EXISTS u IN X.captured WHERE isDevInternalUrl(u.url)
      OR (tie(X.qualifying) AND chosen(F) != first(X.qualifying))
      OR (X.step.risk IN {'write', 'delete'} AND chosen(F).method IN {GET, HEAD}
          AND EXISTS w IN X.qualifying WHERE isWrite(w))
      OR (X.step.risk IN {'write', 'delete'} AND chosen(F).method IN {GET, HEAD}
          AND chosen(F).bound = [])
      OR (chosen(F).method IN {GET, HEAD} AND riskRaisedByOtherRequests(X))
END FUNCTION
```

**Bug 4.** The id is a framework-generated one.

```
FUNCTION isBugCondition_4(element)
  INPUT: element of type ElementInfo
  OUTPUT: boolean

  RETURN isGeneratedPattern(element.id)
      OR cssAnchoredOnGeneratedId(element.css)
END FUNCTION

FUNCTION isGeneratedPattern(id)
  RETURN id MATCHES /:[rR][0-9a-z]+:/            // React 18 useId, also inside radix-:r1: and headlessui-...-:r3:
      OR id MATCHES /^_[rR]_[0-9a-z]+_/          // React 19 useId, e.g. _R_jqatpesnelb_-field
      OR id MATCHES /^«[^»]*»/                   // React 19.1 guillemet form
      OR id MATCHES /^radix-/
END FUNCTION
```

### Examples

- Bug 1: click a `<Link>` to `/clients`. The RSC fetch takes 8146 ms. F returns `'quiet'` at about 2.1 s. F' returns `'response'` or `'navigation'` after the response and the render, and not later than the bound.
- Bug 1: the RSC response arrives at 600 ms, React commits and calls `pushState` at 700 ms. F returns `'response'` at 650 ms. F' sees `nav` change and returns `'navigation'` once the DOM has been quiet for 250 ms.
- Bug 1: a long poll started twice on `/api/events` and pending for 5 s. F and F' both ignore it after 2 s.
- Bug 2: `[type email, type password, click Continue (POST /api/auth/login/credentials), type TOTP (ui), click Verify (POST /api/auth/login/verify)]`. F: `['ui','ui','http','ui','http']`, so the page never leaves the login form. F': `['ui','ui','ui','ui','ui']` because the verify recipe has `auth: 'storageState'`.
- Bug 2: `[type q (prep), click Search (GET /api/customers)]`. F and F' both give `['prep','http']`.
- Bug 3: after `POST /api/auth/login/verify`, the dashboard fires `GET /api/settings/system`. Both bind no variable. F keeps the GET (`>=`). F' keeps the POST.
- Bug 3: click on `Clients` while HMR runs. F records `GET /_next/static/webpack/<hash>.webpack.hot-update.json`. F' records nothing for it.
- Bug 3: Enter in a search form, only `GET /api/search?q=Ada` follows and it binds `q`. F and F' keep the GET as the recipe. The step keeps UI risk `write`. At replay a failing GET falls back to the accessibility level in F'.
- Bug 4: `_R_jqatpesnelb_-field`, `_R_13qatpesnelb_-field`, `:r0:`, `radix-:r1:`, `«r2»` are generated. `email`, `login-form`, `save` are not.
- Bug 4 (edge): `{id: '_R_13qatpesnelb_-field', css: '#_R_13qatpesnelb_-field', role: 'textbox', name: 'Code'}` returns `['role=textbox[name="Code"]']`. With nothing else, `css` stays as the last resort.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A websocket, an event stream and a fixed-interval poll never delay settling. The busy page of `waits.test.ts` settles in under 3 s.
- An action with no request and no navigation returns `'quiet'` after `quietMs`. A request that never ends returns `'bound'` at `timeoutMs`. A counted request that responds returns `'response'`. An error of `opts.action` is passed on.
- A full-page navigation on a quiet page returns shortly after `domcontentloaded` (plus the quiet period).
- A workflow whose steps all have a recipe or are `prep` runs with `fetch()` and no browser, with `storageState` or `DAEMONIZE_COOKIE_HEADER` as today.
- A workflow with no recipe plans `'ui'` for every step. A secret, a TOTP step or a non-preparatory step stays `'ui'`.
- A write or delete recipe that was sent is never retried on another level and never runs twice.
- Images, fonts, stylesheets, scripts, analytics and beacons stay ignored. A normal `/api/...` fetch/xhr stays captured.
- One qualifying request, or one with a higher rank, is still chosen. A step with no qualifying request keeps the same reason texts. A write recipe still raises the step risk to `write`.
- A non-generated id still produces `#id`. Hex runs and digit-only ids stay generated. The selector order stays role/name, testId, id, name attribute, text, css.

**Scope:**
Everything outside C: any wait where no counted request outlives 2 s and no SPA navigation happens, any workflow with no `ui` step after a recipe step, any request not matching the dev filter, any non-submit step, any id outside the patterns.

## Hypothesized Root Cause

1. **Age used as a proxy for "stream"** (defect 1.1). `RequestTracker.counts()` returns false for any entry older than `LONG_LIVED_MS`. Streams are already excluded by `isIgnorableRequest`, so the age check only removes slow normal requests.
2. **No navigation signal besides `framenavigated`** (defect 1.2). Next.js calls `pushState` after the RSC response is parsed and React commits. `waitForEffect` sees nothing in the gap between the response (`responded` fires 50 ms after the finish) and the commit.
3. **Immediate return on `navigated`** (defect 1.3). The loop returns `'navigation'` right after `waitForLoadState('domcontentloaded')`, before hydration.
4. **`planSteps` looks only at the step itself** (bug 2). `step.http !== undefined` gives `'http'` regardless of what follows. `replayCore` runs it with Node `fetch()`, which cannot update the page.
5. **Tie-breaking and risk in `finalizeNetwork`** (bug 3). `rank(a) >= rank(best)` lets the last tie win. No preference for write methods. `risk` is the maximum over all captured requests, not over the chosen one, and `replayCore` uses `step.risk` to forbid fallback.
6. **`isStaticUrl` is extension based** (defect 1.8). `.hot-update.json` and `/_next/static/webpack-hmr` have no matching extension, and `isAnalyticsUrl` does not match them.
7. **`looksGenerated` knows only hex and digits, and `cssPath` ignores it** (bug 4). `capture-script.ts` `cssPath` starts the path at the nearest ancestor with an `id`, so `info.css` is `#<generated-id>` even when `buildSelectors` rejects `info.id`. Fixing `looksGenerated` alone would still emit the id through `css`.

## Correctness Properties

Property 1: Bug Condition - Wait covers slow requests, SPA navigation and hydration

_For any_ action effect where isBugCondition_1 holds, the fixed waitForEffect SHALL NOT return before every counted request has finished or `boundAt` is reached, SHALL treat a `pushState`/`replaceState`/`popstate` change of `nav` or `href` as an effect of the action, and, once a navigation (`framenavigated` or SPA) is seen, SHALL return only after `domcontentloaded` (full navigation) and a DOM quiet period of `NAV_QUIET_MS`, never later than `boundAt`.

**Validates: Requirements 2.1, 2.3, 2.4**

Property 2: Preservation - Streams, polls, quiet pages and bounds settle as before

_For any_ action effect where isBugCondition_1 does not hold, the fixed waitForEffect SHALL return the same reason as the original. Sockets, event streams, `data:`/`blob:` URLs, periodic requests and repeated requests pending over 2 s SHALL NOT delay it. An action without request or navigation SHALL return `'quiet'` after `quietMs`. A request that never ends SHALL return `'bound'` at `timeoutMs`. The error of `opts.action` SHALL be passed on.

**Validates: Requirements 2.2, 3.1, 3.2, 3.3, 3.4**

Property 3: Bug Condition - Nothing runs over HTTP before a browser step

_For any_ list of steps where isBugCondition_2 holds, the fixed planSteps SHALL return a plan in which no index has mode `'http'` or `'prep'` while a later index has mode `'ui'`. Steps after the last `ui` step keep their raw mode, except an `http` step whose recipe has `auth === 'storageState'` in a plan that contains a `ui` step, which becomes `'ui'` together with every step before it.

**Validates: Requirements 2.5, 2.6, 2.7, 2.8**

Property 4: Preservation - HTTP-only and recipe-free workflows plan as before

_For any_ list of steps where isBugCondition_2 does not hold (no recipe step before a `ui` step), the fixed planSteps SHALL return the same plan as the original. A workflow with no recipe SHALL be all `'ui'`, an all-recipe/`prep` workflow SHALL satisfy `isHttpOnly`, and a secret, a TOTP step and a non-preparatory step SHALL stay `'ui'`.

**Validates: Requirements 3.5, 3.6, 3.7**

Property 5: Bug Condition - The recorded recipe is the right request

_For any_ captured request set where isBugCondition_3 holds, the fixed recorder SHALL ignore dev/HMR URLs. It SHALL keep the first of equal-rank candidates. For a submit step it SHALL prefer a write method over a GET and SHALL drop a GET that binds no variable. It SHALL give the recipe the risk of its own method, never lower `step.risk`, and at replay SHALL allow the accessibility fallback when the recipe is a GET or HEAD.

**Validates: Requirements 2.9, 2.10, 2.11, 2.12**

Property 6: Preservation - Other requests and risks are recorded as before

_For any_ captured request set where isBugCondition_3 does not hold, the fixed recorder SHALL select the same recipe and give the same risk and the same report texts as the original. Static assets and analytics SHALL stay ignored, normal `/api/...` requests SHALL stay captured, one qualifying request or a higher rank SHALL still be chosen, and a write recipe SHALL still make the step `write`.

**Validates: Requirements 3.7, 3.8, 3.9, 3.10**

Property 7: Bug Condition - Generated ids never become selectors

_For any_ element where isBugCondition_4 holds and another selector exists, the fixed buildSelectors SHALL return no `#<id>` and no `css` path anchored on that id, and SHALL return exactly the selectors it returns for the same element without that id, in the same order.

**Validates: Requirements 2.13, 2.14**

Property 8: Preservation - Stable ids and selector order are unchanged

_For any_ element where isBugCondition_4 does not hold, the fixed buildSelectors SHALL return the same list as the original, with `#id` for a non-generated id, and hex-run and digit-only ids SHALL still count as generated.

**Validates: Requirements 3.11, 3.12**

## Fix Implementation

### Changes Required

#### Bug 1: `src/replay/runtime/settle.ts`

New constants: `NAV_QUIET_MS = 250`. `LONG_LIVED_MS` stays at 2000 and is renamed in its comment to "repeated requests only".

1. **`RequestTracker.counts()`**: a request counts unless it is ignorable or its URL key is periodic. The age guard applies only when the key was started at least twice in this wait.
   ```
   counts(entry, now):
     if entry.ignorable: return false
     starts := this.starts.get(entry.key)
     if isPeriodic(starts, 3): return false
     if entry.finishedAt != undefined: return true
     repeated := starts.length >= 2
     return NOT (repeated AND now - entry.startedAt >= LONG_LIVED_MS)
   ```
   A single slow fetch is pending until it ends or `waitForEffect` reaches `boundAt`. Two starts of one key, still pending after 2 s, behave like a long poll and are dropped. If `timeoutMs` is 2 s or less the guard never fires because the bound comes first.

2. **`QuietTracker`**: add `touch(now)` (sets `lastChangeAt = max(lastChangeAt, now)`), add `isQuietFor(now, ms)` (same as `isQuiet` with `ms` in place of `quietMs`; ambient mutations still count as quiet), and let `observe` take an optional `nav`/`href` pair in `DomSample`. A change of either calls `touch(now)`.

3. **`DomSample` and `OBSERVE_EXPRESSION`**: `DomSample` gains optional `nav?: number` and `href?: string`. The injected script, still installed once per document, adds:
   ```js
   const bump = () => { state.nav++; };
   for (const m of ['pushState', 'replaceState']) {
     const orig = history[m];
     history[m] = function () { const r = orig.apply(this, arguments); bump(); return r; };
   }
   addEventListener('popstate', bump);
   addEventListener('hashchange', bump);
   ```
   and returns `{ count, pageNow, times, nav: state.nav, href: location.href }`. Optional fields keep fake pages in `settle.test.ts` (which return only `count/pageNow/times`) working. The `href` comparison is the polling fallback for pages where the history patch came too late.

4. **`waitForEffect`**: the first sample gives `baseNav` and `baseHref`. Each sample sets `spaNavigated = true` when `nav` increases or `href` differs from the base (a full navigation resets `nav`, which also differs in `href`). Each counted request that finishes calls `quiet.touch(now)`, so `'response'` is returned only when the DOM has been quiet for `quietMs` after the last finish. That covers the gap between the response and the React commit.
   ```
   loop:
     now := Date.now()
     if navigated OR spaNavigated:
       if navigated AND NOT dcl_waited:
         await waitForLoadState('domcontentloaded', {timeout: max(1, boundAt - now)}) (bounded, errors ignored)
         dcl_waited := true
       await sample()
       t := Date.now()
       if quiet.isQuietFor(t, NAV_QUIET_MS) OR t >= boundAt: return 'navigation'
       sleep(min(POLL_MS, boundAt - t)); continue
     await sample(); t := Date.now()
     if requests.responded(t) AND quiet.isQuiet(t): return 'response'
     if quiet.isQuiet(t) AND requests.pending(t) == 0: return 'quiet'
     if t >= boundAt: return 'bound'
     sleep(min(POLL_MS, boundAt - t))
   ```
   Before a navigation is seen, pending counted requests keep the wait open (`pending(t) == 0` is required for `'quiet'`). After it, only DOM quiet matters, so a never-ending request started by the new page cannot hold the wait until the bound. The wait always ends by `boundAt`, which is derived from `timeoutMs` (already bounded by `boundStepTimeoutMs`).

   Return values stay in the existing union. A bound reached during the navigation phase returns `'navigation'` (as today, where reaching the bound after the navigation is not an error).

No import is added. `settle.ts` still describes the page through `SettlePage`. The generated `replayCore` already calls `waitForEffect`, so no generator change is needed for bug 1.

#### Bug 2: `src/replay/runtime/http-replay.ts` and `src/compiler/mcp-generator.ts`

1. **`planSteps`**: compute the raw plan as today (rename the existing body `rawPlan`, not exported or exported for tests). Then apply:
   ```
   FUNCTION planSteps(steps)
     raw := rawPlan(steps)
     hasUi := raw contains 'ui'
     // A recipe that leans on browser cookies is not independent of the browser session
     FOR i: IF hasUi AND raw[i] = 'http' AND steps[i].http.auth = 'storageState' THEN raw[i] := 'ui'
     // Nothing before a browser step may run outside the browser
     lastUi := last index with raw[i] = 'ui'  (or -1)
     FOR i <= lastUi: plan[i] := 'ui'
     FOR i > lastUi:  plan[i] := raw[i]
   ```
   Consequences:
   - All-HTTP workflow (`isHttpOnly(raw)`): `hasUi` is false, nothing changes, no browser opens (requirement 3.5).
   - Mixed workflow: every step up to and including the last `ui` step runs in the browser. This includes `prep` steps (requirement 2.7: the browser receives the value) and `http` steps. The browser carries cookies and DOM to the next screen.
   - Final suffix: stays over HTTP only if its steps do not need the browser session.

   **Cookie handling, and why `storageState` recipes are demoted.** A recipe is marked `auth: 'storageState'` when the recorded request carried a Cookie header (`http-correlate.ts`). In a mixed plan the browser is open. `replayCore` already feeds `session.context.storageState()` (the live cookies) to `runHttpStep`, so the first suffix request would be authenticated. The safe default is still to demote such a step, for three reasons. The suffix response may set or rotate cookies and the browser would not see them. A CSRF cookie or token may be paired with page state that a bare `fetch()` does not reproduce. And the saved browser result (`finishWeb`, DOM text) is the more faithful result of a session that was just driven in the browser. Recipes with `auth` `'none'` or `env:NAME` do not depend on browser cookies and may stay HTTP. A recipe without `auth` (older workflows and existing tests) is treated as independent, so `[type secret, click http]` still plans `['ui','http']`. Trade-off: some suffix GETs now run in the browser instead of over HTTP. That costs speed, not correctness, and can be relaxed later per recipe.

   Update the doc comment of `planSteps` with the rule and the cookie rationale.

2. **`replayCore` (`WEB_RUNTIME_HTTP`)**: no plan logic changes, because the plan is the single source. Two small edits:
   - The read-fallback condition `(step.risk ?? "read") !== "read"` becomes `recipeMutates(step.http)`, a new export of `http-replay.ts`:
     ```ts
     export function recipeMutates(recipe: { method: string }): boolean {
       const m = recipe.method.toUpperCase();
       return m !== 'GET' && m !== 'HEAD';
     }
     ```
     A step with UI risk `write` and a GET recipe may then fall back to the accessibility level (defect 1.9). A write or delete recipe that was sent is still never retried. The `import` line for `http-replay.js` in the generator adds `recipeMutates`. The existing `levels`, `deferred` and `openBrowser` code is unchanged: with a mixed plan, no `prep` step is deferred before the browser, and the browser opens at step 0.
   - Update the comment above `WEB_RUNTIME_HTTP`.

3. **`src/compiler/tool-description.ts`** uses `planSteps` in `describeLevels`. It keeps working and reports the demoted steps as browser steps.

4. **Docs**: `docs/replay-model.md` gets a short section "Mixed workflows" with the rule and the cookie rationale (requirement 2.8).

#### Bug 3: `src/recorder/network-capture.ts`, `src/recorder/http-correlate.ts`, `src/recorder/live-recorder.ts`, `src/recorder/workflow-recorder.ts`

1. **`isDevInternalUrl(url)`** (exported, `network-capture.ts`), tested on `pathname`:
   ```ts
   const DEV_INTERNAL_PATH = [
     /\.hot-update\.(json|js)$/i,
     /(^|\/)_next\/(static|webpack-hmr)(\/|$)/,   // also under a basePath
     /(^|\/)__nextjs/,                              // __nextjs_original-stack-frame, __nextjs_font
     /(^|\/)__webpack_hmr(\/|$)/,
     /(^|\/)webpack-hmr(\/|$)/,
     /^\/(@vite|@react-refresh|@fs|__vite_ping)(\/|$)/,
     /^\/sockjs-node(\/|$)/,
   ];
   ```
   `isStaticUrl` returns `STATIC_PATH.test(pathname) || isDevInternalUrl(url)`. `requestStarted` already calls `isStaticUrl`, so no other change. `_next/data/...` JSON (pages router) is a real data request and is not filtered. `_next/image` answers with an image content type and is already filtered by `STATIC_CONTENT`.

2. **`selectRecipe(attempts, { submit })`** (new, exported from `http-correlate.ts` so it can be unit tested without Playwright). `finalizeNetwork` calls it.
   ```
   FUNCTION selectRecipe(attempts, used, submit)
     candidates := attempts WHERE recipe != undefined AND used.every(name IN bound)
     IF submit: candidates := candidates WHERE isWriteMethod(method) OR bound.length > 0
     // submit: GET/HEAD that binds nothing is a follow-up refresh, not the action
     best := undefined
     FOR a IN candidates (in capture order):
       IF best = undefined OR better(a, best) THEN best := a
     RETURN best

   FUNCTION better(a, b)           // strictly better, so the earliest wins a tie
     IF submit AND isWriteMethod(a) != isWriteMethod(b) THEN RETURN isWriteMethod(a)
     RETURN rank(a) > rank(b)
   ```
   `submit` is `(step.risk ?? 'read') !== 'read'`, taken before `setHttp` runs, so it reflects `classifyRisk` (submit click, Enter in a form field, write/delete wording). Order is write method, then rank, then earliest, as decided. For non-submit steps the order is rank, then earliest (the `>=` becomes `>`).

   Effects on the cases in the bug: login verify (POST, no bound variable) beats the later `GET /api/settings/system`. A search form whose GET binds `q` stays a recipe. A submit whose only candidate is an unbound GET gets no recipe and reports `accessibility`, with the reason text `GET /path: follow-up read of a submit step, not used`. Every other reason text is unchanged.

3. **Risk of the recipe.** `finalizeNetwork` passes `riskOfMethod(qualifying.recipe.method)` to `setHttp` when a recipe was chosen. When none was chosen it keeps the maximum over all captured requests (a write request happened and the step must not be replayed twice). `setHttp` still never lowers `step.risk`. The consequences:
   - The step keeps UI risk `write` for the accessibility level (a submit through the UI is a write). It is not raised to `write` by an unrelated request.
   - A GET recipe is treated as a read at replay through `recipeMutates` (bug 2 item 2), so a shape failure on a redirect to the HTML login page (status 200) falls back to the accessibility level and the UI action runs once.
   - A POST/PUT/PATCH/DELETE recipe still raises the step to `write`/`delete` (requirement 3.10).

#### Bug 4: `src/recorder/selector-builder.ts`

1. **`looksGenerated(id)`** becomes a list of patterns (exported for tests):
   ```ts
   const GENERATED_ID = [
     /[0-9a-f]{8,}/i,                 // existing: hex runs
     /^\d+$/,                          // existing: digits only
     /:[rR][0-9a-z]+:/,                // React 18 useId, also radix-:r1: and headlessui-menu-button-:r3:
     /^_[rR]_[0-9a-z]+_/,              // React 19 useId: _R_jqatpesnelb_-field, _r_0_
     /^«[^»]*»/,                       // React 19.1 useId: «r0»
     /^radix-/,                        // Radix UI ids in any version
   ];
   ```
   The React 18 pattern is `:[rR][0-9a-z]+:` (colon required, matched anywhere), as `bugfix.md` 2.13 now states. An optional colon would flag real ids such as `rooms:list`. React 18 always emits the colon. The React 19 pattern requires a token between the underscores. Every id in 2.13 and 4.1 to 4.3 matches.

2. **`buildSelectors`**: the `#id` branch already uses `looksGenerated`. Add a guard on `element.css`:
   ```ts
   if (element.css && !cssStartsOnGeneratedId(element.css) ...existing nth-of-type rule...)
   ```
   where `cssStartsOnGeneratedId(css)` reads the first `#...` token (unescaping `\x` pairs) and applies `looksGenerated`. The `css` path is dropped only if other selectors exist, so a bare element keeps its last-resort selector. `buildZoneSelector` calls `buildSelectors` and benefits without a change. `capture-script.ts` is a string injected in the browser and cannot import `looksGenerated`, so the filter stays on the `selector-builder.ts` side, which is the single source.

## Testing Strategy

### Validation Approach

Two phases: write the exploratory tests below, run them on the unfixed code to see them fail for the hypothesized reason, then fix and run the fix and preservation checks. Final verification is `npm run build`, `npm run check:secrets` and `npm test`. Property tests use `fast-check` (already a dev dependency) and carry the tag `// Feature: nextjs-spa-replay-fixes, Property N: <title>` on the line above the property.

Nothing in tests or runtime imports across the verbatim-copy boundary the wrong way: `settle.ts` and `http-replay.ts` import nothing from `src/`, and the existing copy tests in `waits.test.ts` ("copies settle.ts next to the server") keep guarding that.

### Exploratory Bug Condition Checking

**Goal**: Show the bug before the fix and confirm or refute the root causes.

**Test Plan**: Unit tests with injected time and fake pages, one integration page per navigation shape, planner and chooser tests on plain data. Run them on the unfixed code first.

**Test Cases**:
1. **Slow fetch**: `RequestTracker.start('a', 'http://x/clients?_rsc=1', 'fetch', {}, 0)`, `pending(LONG_LIVED_MS + 1)` is 1 (fails on unfixed code, returns 0).
2. **SPA navigation in waits.test.ts**: a page whose link click runs `fetch('/slow')` for 3 s, then `history.pushState` and renders a new heading. `waitForEffect` with `action: click` must return after the heading exists (fails on unfixed code, returns at about 2.1 s).
3. **Late pushState**: fake page whose `evaluate` returns `nav` 0 until 700 ms after a finished request and 1 afterwards. `waitForEffect` must not return `'response'` before the nav is observed and the DOM has been quiet for 250 ms.
4. **Hydration after framenavigated**: fake page that fires `framenavigated`, with mutations during the next 200 ms. The unfixed function returns right after `waitForLoadState`.
5. **Mixed plan**: `planSteps([{type email}, {click, http: credentials}, {type, totp: true}, {click, http: verify}])` must not contain `'http'` before a `'ui'` (fails on unfixed code).
6. **Tie**: `selectRecipe` on `[POST /api/auth/login/verify, GET /api/settings/system]`, both rank 0, must give the POST.
7. **HMR**: `isStaticUrl('http://localhost:3000/_next/static/webpack/abc.webpack.hot-update.json')` is true. Same for `/_next/webpack-hmr`, `/__nextjs_original-stack-frame`.
8. **Generated ids**: `buildSelectors({ role:'textbox', name:'Code', id:'_R_13qatpesnelb_-field', css:'#_R_13qatpesnelb_-field' })` must be `['role=textbox[name="Code"]']`.

**Expected Counterexamples**:
- Test 1 and 2 returning after 2 s. Cause: age check in `counts()`.
- Test 3 returning at the end of the request. Cause: `responded` plus 50 ms grace and no navigation signal.
- Test 4 returning before the DOM settles. Cause: early return on `navigated`.
- Test 5 giving `'http'` before `'ui'`. Cause: per-step planning.
- Test 6 giving the GET. Cause: `>=` in the reduce.
- Test 8 giving `#_R_...` or the css path. Cause: `looksGenerated` patterns plus `cssPath` anchoring. If only `#id` appears in the output, the css-anchoring hypothesis is refuted and one guard can go.

### Fix Checking

**Goal**: For all inputs where the bug condition holds, the fixed function gives the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)
END FOR
```

Per bug:
- Bug 1: `returnedAt >= lastCountedRequestEnd AND returnedAt <= boundAt`, and after a navigation `returnedAt - lastMutationAt >= NAV_QUIET_MS` or `returnedAt == boundAt`.
- Bug 2: `NOT EXISTS i < j WITH plan[i] IN {'http','prep'} AND plan[j] = 'ui'`.
- Bug 3: result recipe is not dev-internal, is the first on a tie, is a write when a submit step has a write, has `risk` equal to the chosen method's risk, and is never lower than the UI risk.
- Bug 4: no `#id` and no id-anchored css in the result, and result equals the result for the same element without the id.

### Preservation Checking

**Goal**: For all inputs where the bug condition does not hold, the fixed function matches the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing, because the inputs (step lists, request sets, ids, timelines) are large and the original behavior is a few lines that can be kept in the test as a reference implementation (`originalPlanSteps`, `originalLooksGenerated`, `originalPick`).

**Test Plan**: Observe the unfixed code on non-bug inputs, copy that logic into the test as the oracle, then compare.

**Test Cases**:
1. **Streams and polls**: websocket, eventsource, `text/event-stream` and periodic requests stay uncounted (existing tests, unchanged).
2. **Quiet and bound**: no-request action returns `'quiet'`. Never-ending request returns `'bound'`. `opts.action` error propagates.
3. **HTTP-only plan**: every step recipe or `prep` gives the same plan and `isHttpOnly` stays true.
4. **Recipe-free plan**: all `'ui'`.
5. **Recipe choice**: a single qualifying request, or a request with a higher rank, is chosen as before; reasons unchanged.
6. **Static and analytics**: `isStaticUrl` still true for `.js`, `.css`, images and fonts, and `isAnalyticsUrl` unchanged. `/api/customers?q=a` is not filtered.
7. **Ids**: `email`, `login-form`, `save` give `#id`. `a3f9c2d10b7e` and `12345` stay generated. Selector order unchanged.

### Unit Tests

Bug 1, `tests/unit/settle.test.ts`:
- Rewrite "stops waiting for a request that stays pending (long poll)": a single slow fetch counts until it finishes and after `LONG_LIVED_MS + 1`.
- Keep the long-poll protection for a repeated key: two starts of `/events`, pending after 2 s, not counted.
- `responded` is false until the DOM has been quiet `quietMs` after the last finish (fake page).
- SPA navigation seen through `nav` and through `href` only, then `'navigation'` after 250 ms of quiet.
- `framenavigated` followed by mutations returns after the quiet period, and at `boundAt` when mutations never stop.
- Sample without `nav` and `href` (existing fake pages) still works.

Bug 2, `tests/unit/http-replay.test.ts`:
- Mixed workflow: the credentials/TOTP/verify example gives all `'ui'`.
- `[type q, click http]` gives `['prep','http']`. `[http, ui]` gives `['ui','ui']`.
- A `prep` before a demoted `http` becomes `'ui'`.
- Final suffix: `[ui, http(auth none)]` gives `['ui','http']`. `[ui, http(auth storageState)]` gives `['ui','ui']`. `[ui, http(auth storageState), http(auth none)]` gives `['ui','ui','http']`: the cookie-dependent step is demoted, and only steps before the last `ui` step are demoted with it.
- `recipeMutates` for GET, HEAD, POST, PUT, PATCH, DELETE.
- Update the two lines named in the Overview.

Bug 3, `tests/unit/http-correlate.test.ts` and `tests/integration/network-capture.test.ts`:
- `selectRecipe`: tie keeps first, higher rank wins, write beats later GET for a submit step, GET without bound variable is dropped for a submit step, GET with a bound variable stays, non-submit step picks by rank then earliest.
- `isStaticUrl` and `isDevInternalUrl` on the listed URLs, and false for `/api/customers`, `/_next/data/x/page.json`.
- `setHttp` keeps a `write` step at `write` with a GET recipe and raises a `read` step to `write` for a POST.
- Integration: a page that fetches an HMR file after a click does not produce that recipe.

Bug 4, `tests/unit/workflow-recorder.test.ts` (next to the existing `buildSelectors` tests) or a new `selector-builder.test.ts`:
- The ids of 2.13 are generated, and `email`, `login-form`, `rooms:list` are not.
- `buildSelectors` gives the same list with and without a generated id, and drops `#_R_..._` css when other selectors exist and keeps it when none exist.
- The two fields with the same reused id give selectors that do not contain it.

### Property-Based Tests

Put them in `tests/unit/nextjs-spa-replay-fixes.property.test.ts`. Each has the required tag on the line above.

- `// Feature: nextjs-spa-replay-fixes, Property 1: Bug Condition - Wait covers slow requests, SPA navigation and hydration`. Random request durations (above and below 2 s) and navigation delays on a fake page with injected time. Return time is at least the last counted finish and at most `boundAt`, and after a navigation the DOM was quiet 250 ms or the bound was reached.
- `// Feature: nextjs-spa-replay-fixes, Property 2: Preservation - Streams, polls, quiet pages and bounds settle as before`. Random mixes of ignorable and periodic requests with a quiet DOM return `'quiet'` quickly. Compare `RequestTracker.pending` with the original implementation for ignorable and periodic entries.
- `// Feature: nextjs-spa-replay-fixes, Property 3: Bug Condition - Nothing runs over HTTP before a browser step`. Random step lists (action types, variables, secrets, recipes with and without bindings and `auth`). For every list, no `'http'` or `'prep'` precedes a `'ui'`.
- `// Feature: nextjs-spa-replay-fixes, Property 4: Preservation - HTTP-only and recipe-free workflows plan as before`. For lists with no recipe step before a `ui` step, `planSteps` equals `originalPlanSteps`. Lists without recipes are all `'ui'`.
- `// Feature: nextjs-spa-replay-fixes, Property 5: Bug Condition - The recorded recipe is the right request`. Random attempt lists. The chosen element is the first of the maximal-rank group, a write for a submit step if one qualifies, never a dev URL, and its risk is that of its method.
- `// Feature: nextjs-spa-replay-fixes, Property 6: Preservation - Other requests and risks are recorded as before`. For non-submit steps with no tie, `selectRecipe` equals the original reduce. For lists with one qualifying request, it is chosen.
- `// Feature: nextjs-spa-replay-fixes, Property 7: Bug Condition - Generated ids never become selectors`. Generate React 18, React 19, guillemet and Radix ids with random tokens, and elements with a role and name. The result has no `#id` and equals the result without the id.
- `// Feature: nextjs-spa-replay-fixes, Property 8: Preservation - Stable ids and selector order are unchanged`. Generate ids from `[a-z][a-z-]{0,12}` with no pattern match. `looksGenerated` equals the original, and `buildSelectors` equals the original implementation.

### Integration Tests

- `tests/integration/waits.test.ts` adds an SPA page: a link click starts `fetch('/slow-rsc')` that takes about 3 s, then `pushState` and a render. The step returns after the new heading is in the DOM and within the bound. The existing busy-page tests run unchanged.
- `tests/integration/http-replay-e2e.test.ts`: case (d) now expects four `'accessibility'` levels and no direct search. A new case runs a login (credentials click with recipe), TOTP typing and verify click through `--http`, and checks that the page is on the second screen when the TOTP step runs. A GET recipe whose response redirects to an HTML login page (status 200) falls back to the page once and `levelFallback` is true. A POST failure is still not retried.
- `tests/integration/network-capture.test.ts`: a page that fires an HMR fetch after a click yields no recipe for it. A submit that fires the write and then a dashboard GET keeps the write.
- Final: `npm run build`, `npm run check:secrets`, `npm test`. `check:secrets` guards that the new tests and docs hold no cookie or token value.
