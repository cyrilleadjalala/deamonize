# Bugfix Requirements Document

## Introduction

Tests against a Next.js 15 / React 19 app (App Router SPA navigation, two-step login with password then TOTP) exposed four defects in `record`, `--http` and `replay`. Together they make recorded workflows fail on such apps: a replay moves on before the new page renders, `--http` mode leaves the browser on the first screen, the recorder stores the wrong HTTP request (sometimes a Next.js HMR file) for a step, and fallback selectors can match the wrong field.

The fixes must not weaken existing tests. Each bug needs unit or regression tests. Final verification is `npm run build`, `npm run check:secrets` and `npm test`.

Affected code:

- Bug 1: `src/replay/runtime/settle.ts` (`waitForEffect`, `RequestTracker.counts()`, `LONG_LIVED_MS`, `isPeriodic`).
- Bug 2: `src/replay/runtime/http-replay.ts` (`planSteps`, `isHttpOnly`, `runHttpStep`) and `src/compiler/mcp-generator.ts` (generated `replayCore`).
- Bug 3: `src/recorder/live-recorder.ts` (`finalizeNetwork`) and `src/recorder/network-capture.ts` (`isStaticUrl`, `isAnalyticsUrl`).
- Bug 4: `src/recorder/selector-builder.ts` (`looksGenerated`, `buildSelectors`).

## Bug Analysis

### Current Behavior (Defect)

**Bug 1: `waitForEffect` ends too early on SPA navigations and slow requests**

1.1 WHEN an action starts a normal fetch/xhr request (for example the RSC fetch of a Next.js `<Link>` click, or a slow submit) that is still pending after `LONG_LIVED_MS` (2000 ms) THEN `RequestTracker.counts()` stops counting it as if it were a stream or long poll, so `waitForEffect` returns `'quiet'` after about 2 s while the new page is not rendered, and the next step times out on the old screen (observed: `GET /clients` took 8146 ms under the Next.js dev compiler).

1.2 WHEN a click triggers an App Router navigation that calls `history.pushState` and no `framenavigated` event fires before the server answers THEN `waitForEffect` does not treat the URL change or the pending requests as the effect of the action and concludes too early.

1.3 WHEN `framenavigated` fires (`navigated` becomes true) THEN `waitForEffect` returns right after `domcontentloaded`, without a DOM quiet period, so the page may not yet be hydrated or rendered when the next step starts.

**Bug 2: `--http` mode on mixed UI + HTTP workflows**

1.4 WHEN a workflow in `--http` mode has a step with an `http` recipe followed by one or more `ui` steps (for example type email, type password, click "Continue" with recipe `POST /api/auth/login/credentials`, then type TOTP) THEN `planSteps()` marks the click as `'http'` and `replayCore` runs it through `runHttpStep()` with Node `fetch()` outside the browser, so the Playwright page does not move to the next screen and its cookies are not updated.

1.5 WHEN the `ui` steps after such an `http` step run THEN they act on a browser that is still on the first screen, and they fail or hit the wrong elements.

**Bug 3: HTTP correlation at record time and risk of GET requests**

1.6 WHEN `LiveRecorder.finalizeNetwork()` selects the recipe of a step and no request carries a variable (`bound.length === 0` for all of them) THEN `qualifying` uses `rank(a) >= rank(best)` in its `reduce`, so the last request in the action window replaces the real one (observed: `POST /api/auth/login/verify` replaced by `GET /api/settings/system`, the refresh of the next dashboard).

1.7 WHEN a submit step (`submit === true`, `inForm === true` or risk `'write'`) has both a write request and a later read-only follow-up request THEN the follow-up GET can be kept as its recipe.

1.8 WHEN a request is a Next.js dev or HMR request (`*.hot-update.json`, `/_next/static/...`, `/_next/webpack-hmr`, `/__nextjs_...`) THEN `network-capture.ts` records it, because `isStaticUrl` only matches file extensions such as `.js` or `.css` and `isAnalyticsUrl` does not match it (observed: `GET /_next/static/webpack/...webpack.hot-update.json` became the HTTP recipe of a click on the `Clients` link).

1.9 WHEN the kept recipe is a GET but the step risk was computed from all captured requests (for example a `keypress` in a form with risk `'write'`) THEN the step keeps risk `'write'` with a read-only recipe. At replay, if that GET without a valid session is redirected to the HTML login page (status 200), `http-replay` reports a shape failure and refuses to fall back to the accessibility level ("a write step is never retried on another level").

**Bug 4: React `useId()` and Radix UI generated ids are not excluded**

1.10 WHEN an element has a React 19 `useId()` id (for example `_R_jqatpesnelb_-field`, `_R_13qatpesnelb_-field`) THEN `looksGenerated()` (which only tests `/[0-9a-f]{8,}/i` or `/^\d+$/`) can return false, and `buildSelectors()` adds `#<id>` as a fallback selector.

1.11 WHEN an element has a React 18 `useId()` id (`:r0:`, `:r1:`) or a Radix UI id (`radix-:r...:`) THEN `looksGenerated()` returns false and `buildSelectors()` adds an id selector built from it.

1.12 WHEN two different fields in one workflow share the same generated id (React 19 reused `#_R_13qatpesnelb_-field` for both the password field in step 1 and the TOTP field in step 2) and the primary role selector does not match THEN the id fallback matches the wrong field.

### Expected Behavior (Correct)

**Bug 1**

2.1 WHEN an action starts a fetch/xhr request that is still pending after `LONG_LIVED_MS` and is not a stream or periodic request THEN `waitForEffect` SHALL keep counting it as pending until it finishes or `timeoutMs` (the `boundAt` limit) is reached, so a slow RSC navigation or submit is awaited until the page has the response.

2.2 WHEN a request is a websocket, an eventsource or `text/event-stream` response, or its URL pattern is periodic according to `isPeriodic` THEN `waitForEffect` SHALL exclude it from the pending count by its nature, not by its age. Any extra age-based guard SHALL apply only to requests that are clearly background or repeated, and SHALL stay below `timeoutMs`.

2.3 WHEN the action triggers an SPA navigation (`history.pushState` / URL change, or the end of the requests started by the click) THEN `waitForEffect` SHALL observe it as an effect of the action and SHALL NOT conclude before those requests have finished.

2.4 WHEN `framenavigated` fires THEN `waitForEffect` SHALL wait for `domcontentloaded` and then for a short DOM quiet period (settle/hydration time), all within `boundAt`, before returning.

**Bug 2**

2.5 WHEN a step has an `http` recipe and any `ui` step follows it in the plan THEN `planSteps()` SHALL NOT mark that step `'http'`. It SHALL run through the browser (Level 2, or the step's usual UI level) so that DOM and cookies stay in sync with the following `ui` steps.

2.6 WHEN the workflow is 100% HTTP (`isHttpOnly(plan)` is true), or an `http` step belongs to a final suffix of the plan in which no `ui` step follows and no later step depends on browser state THEN the system SHALL run it over HTTP without Playwright. Where a browser session is open (its cookies are the login) the existing choice of `storageState` in `replayCore` SHALL still apply.

2.7 WHEN a step that was `'prep'` (a field fill whose value a later recipe carries) precedes an `http` step that is demoted to the browser by 2.5 THEN the system SHALL replay that prep step on the page too, so the browser receives the value.

2.8 WHEN the plan rules above are applied THEN the rule SHALL be documented (comment on `planSteps` and the replay documentation) and covered by tests: mixed workflow, HTTP-only workflow, HTTP final suffix.

**Bug 3**

2.9 WHEN several recorded requests have the same rank (including when none carries a variable) THEN `finalizeNetwork()` SHALL keep the first, most specific one (`rank(a) > rank(best)`), not the last.

2.10 WHEN a step is a submit step (`submit === true`, `inForm === true` or risk `'write'`) and the qualifying requests include a write request (POST/PUT/PATCH/DELETE) THEN `finalizeNetwork()` SHALL prefer the write request over a later GET that is only a follow-up refresh.

2.11 WHEN a request URL matches Next.js dev or HMR internals (`*.hot-update.json`, `/_next/static/`, `/_next/webpack-hmr`, `/__nextjs_`) THEN `network-capture.ts` SHALL ignore it (via `isStaticUrl` or a dedicated filter), so it never becomes a recipe.

2.12 WHEN the kept recipe is a read-only GET THEN the step SHALL NOT have risk `'write'` because of it, and a shape or status failure of that GET at replay, with no mutation sent, SHALL be able to fall back to the accessibility level. A GET that only follows a write or submit action SHALL NOT be attached to that action as its recipe.

**Bug 4**

2.13 WHEN an element id matches React 19 `useId()` (`^_[rR]_[0-9a-z]+_`), React 19.1 guillemet ids (`^«[^»]*»`), React 18 `useId()` (`:[rR][0-9a-z]+:`, colon required, matched anywhere in the id, so ids such as `rooms:list` are not flagged) or Radix UI (`^radix-`) patterns THEN `looksGenerated()` SHALL return true and `buildSelectors()` SHALL NOT emit an `#id` selector for it, as long as other selectors exist (role/name, testId, name attribute).

2.14 WHEN `buildSelectors()` is called with these generated ids THEN it SHALL return the same selectors it would return for an element without an id, in the same order.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a page uses a websocket, server-sent events or a polling loop (periodic requests per `isPeriodic`) THEN the system SHALL CONTINUE TO settle quickly without waiting for those requests.

3.2 WHEN the busy page of the existing `waits.test.ts` is replayed THEN the system SHALL CONTINUE TO settle in under 3 s, and all existing tests in `settle` and `waits` SHALL pass unchanged.

3.3 WHEN an action has no request and no navigation THEN `waitForEffect` SHALL CONTINUE TO return `'quiet'` after `quietMs`, and SHALL CONTINUE TO return `'bound'` at `timeoutMs` for a request that never finishes, and `'response'` when a counted request responds, with an error of `opts.action` passed on.

3.4 WHEN a full-page navigation fires `framenavigated` on a page with no further DOM activity THEN the system SHALL CONTINUE TO return after `domcontentloaded` with only the brief quiet period added.

3.5 WHEN every step of a workflow has a recipe or is preparatory (`isHttpOnly`) THEN the system SHALL CONTINUE TO replay it with `fetch()` and without opening a browser.

3.6 WHEN `planSteps()` receives a workflow with no `http` recipe THEN the system SHALL CONTINUE TO return `'ui'` for every step, and a secret, a TOTP step or a non-preparatory step SHALL CONTINUE TO be `'ui'`.

3.7 WHEN a step has risk `'write'` THEN the system SHALL CONTINUE TO never execute it twice, and a write step that sent its request SHALL CONTINUE TO never be retried on another level.

3.8 WHEN a request is an image, font, stylesheet, script or other static asset, or an analytics/beacon/telemetry request THEN `network-capture.ts` SHALL CONTINUE TO ignore it, and a normal `/api/...` fetch/xhr SHALL CONTINUE TO be captured.

3.9 WHEN only one request qualifies, or one request carries more variables than the others (higher `rank`) THEN `finalizeNetwork()` SHALL CONTINUE TO select that request, and a step with no qualifying request SHALL CONTINUE TO be reported at the accessibility level with the same reason texts.

3.10 WHEN a step has a write request (POST/PUT/PATCH/DELETE) as its recipe THEN the step SHALL CONTINUE TO have risk `'write'`.

3.11 WHEN an element has a non-generated id (for example `email`, `login-form`) THEN `buildSelectors()` SHALL CONTINUE TO emit `#id`, and ids with long hex runs or purely numeric ids SHALL CONTINUE TO be treated as generated.

3.12 WHEN `buildSelectors()` builds selectors for any element THEN the system SHALL CONTINUE TO keep the existing selector order (role/name, testId, id, name attribute, and the rest as it is today).
