# Replay model

How a generated server performs a recorded workflow, what it returns, and how it fails. Every name below exists in the code
(`src/compiler/mcp-generator.ts`, `src/replay/runtime/`, `src/types.ts`).

## The cascade

Each step is replayed by the most stable means available:

| Level | Name in `levels` | What it is | When it is used |
| --- | --- | --- | --- |
| 1 | `http` | The recorded fetch/XHR request, with Variables bound into it and secrets taken from the environment | Web only, compiled with `compile --http`, and only for steps that have a recorded request. A step whose request fails is repeated in the browser (`levelFallback: true`) when the request is a GET or HEAD. A step whose request is a POST, PUT, PATCH or DELETE is never repeated: the call fails with `http_failed` |
| 2 | `accessibility` | Role and accessible name, then recorded fallbacks, with relational anchors (the row of a table is found by a Variable bound to a cell text, never by position) | Always |
| 3 | vision | A multimodal model finds the element on a screenshot | Only with `--heal`, only after Levels 1 and 2 failed, or when the page has no DOM (canvas) |

Server-rendered applications such as Adminer have no fetch/XHR to record: every step stays at Level 2. That is a normal result.

## Mixed workflows (--http)
Node etch() runs outside the browser: it moves neither the page to the next screen nor the cookies of the browser. So the plan (planSteps in src/replay/runtime/http-replay.ts) follows one rule:
- A workflow where every step has a request, or only fills a field for a later request, runs over HTTP with no browser (unchanged).
- Otherwise every step up to and including the last browser step runs in the browser (ccessibility), whether it has a request or not. A field-filling step whose value a later request carries is replayed on the page too, so the page receives the value. This keeps the DOM and the cookies of the page in step with the browser steps that follow (a two-step login: password screen, then a code screen).
- The final suffix, the steps after the last browser step, stays over HTTP. The exception is a request whose uth is storageState: it relies on the cookies of the browser session, the response may rotate them, and CSRF state can be paired with the page. Such a request runs in the browser, together with every step before it. A request with uth 
one or env:NAME, or with no uth, does not depend on the browser and stays over HTTP.
The fallback to the browser after a failed request depends on the request, not on the risk of the step: only a request that mutates (POST, PUT, PATCH, DELETE) is never repeated, so a GET that fails (a redirect to an HTML login page with status 200, a changed shape) can fall back to Level 2 once.
## STRICT and HEAL

| | STRICT (default) | HEAL (opt-in) |
| --- | --- | --- |
| Start | `daemonize serve <dir>` or `--strict` | `daemonize serve <dir> --heal` (or `DAEMONIZE_MODE=heal`) |
| A step no locator can perform | The call fails: `success: false`, `drifted: true`, `error: "step_failed"`, `failure` with the step, the locators tried and a screenshot path. No later step runs | Looks for the element: cache of an earlier heal, recorded coordinates (canvas), then the model |
| Result flag | `mode: "strict"` | `mode: "heal"`, `healed: true` and `healedSteps` (`stepIndex`, `source`: `cache`, `coordinates` or `model`) when a step was healed |
| Write or delete step | Never healed | Healed only if the step has `allowHeal: true` |
| Needs | Nothing | A server compiled with `compile --heal-support`, and a model in `DAEMONIZE_MODEL_PROVIDER`, `DAEMONIZE_MODEL_NAME`, `DAEMONIZE_MODEL_API_KEY`, `DAEMONIZE_MODEL_BASE_URL` |

The model only locates an element. It never chooses what the workflow does, and the workflow file is never modified: a repaired
locator is cached in `.daemonize/heal-cache.json` (or `DAEMONIZE_HEAL_CACHE`) and replayed deterministically afterwards.
Without `--heal`, no model is called (`tests/integration/no-model-without-heal.test.ts`). `--heal` has not been run against a
real model in this repository: the tests use a scripted healer.

## Result fields

| Field | Meaning |
| --- | --- |
| `success` | The workflow ran to its end and the result could be read |
| `drifted` | The final screen (or its `finalZone`/`finalRect`) differs from the recorded one, or a strict step failed |
| `driftChecked` | `false` when the workflow has no recorded final screen, so `drifted: false` means "not compared" |
| `healed`, `healedSteps` | Heal mode only (see above) |
| `levels` | Web: the level used by each step (`http`, `accessibility`, `not_run`) |
| `mode` | `strict` or `heal` |
| `data` | The structured result: table, list, fields, JSON, or the named groups of a terminal regex |
| `text`, `title` | Visible text and title of the final screen (web), or the text of the result zone |
| `failure` | Diagnostic of a failed call (step, locators tried, screenshot path, last screen text, missing secret name) |
| `error` | One of the codes below |
| `errors` | With `error: "validation"`: the AJV errors |

## Error codes

| `error` | Cause |
| --- | --- |
| `validation` | The payload does not match the input schema. Nothing was replayed |
| `missing_secret` | A `DAEMONIZE_SECRET_<NAME>` variable is unset or empty. Checked before the sandbox starts; `failure.missingSecret` holds the name |
| `storage_state_missing` | The `storageState` file named by the workflow or `DAEMONIZE_STORAGE_STATE` is absent |
| `step_failed` | Strict mode: no locator could perform a step (`failure` has the diagnostic) |
| `pattern_timeout` | A terminal screen-pattern wait did not match in time (`failure.lastText`) |
| `http_failed` | A write or delete step's recorded HTTP request failed |
| `heal_unavailable` | Heal mode needed a model and none is configured, or the server was compiled without `--heal-support` |
| `result_zone_not_found` | The action ran, but the result zone or result pattern matched nothing (`message` says so) |
| `result_extraction_failed` | The zone was found but could not be read in the requested form |
| `sandbox_unavailable` | The sandbox (browser, pty or container) could not start |
| `timeout` | The whole call exceeded `--timeout` (default 30000 ms) |

A row that cannot be bound fails with `ROW_NOT_FOUND`, `AMBIGUOUS_ROW`, `ROW_VARIABLE_MISSING` or `ROW_KEY_EMPTY` rather than
acting on a guessed row. Timeouts: `--timeout`/`DAEMONIZE_TIMEOUT_MS` for a call, `--step-timeout`/`DAEMONIZE_STEP_TIMEOUT_MS`
(default 8000 ms) for a step.

The server returns a failure as a tool result with `isError: true`, so the agent can read the diagnostic.
