import { KEY_SEQUENCES } from '../sandbox/keys.js';
import { defaultNetwork, renderDockerfile } from '../sandbox/dockerfile.js';
import { describeTool } from './tool-description.js';
import { propertyToZodSource } from './zod-translator.js';
import { pickResultZone } from '../replay/runtime/extract.js';
import type { ResultZone, Workflow, WorkflowSet } from '../types.js';

// The sandbox image of a web target starts from the Playwright image of this exact version,
// whose browsers match the playwright package installed on top of it.
export const PLAYWRIGHT_VERSION = '1.65.1';

/** `--http`: off (default) replays through the page only; auto executes the recorded HTTP request of every step that has one. */
export type HttpMode = 'off' | 'auto';

export interface GenerateOptions {
  http?: HttpMode;
  /**
   * `compile --heal-support`: emit the Heal modules (`heal/`) and the code that loads them when `DAEMONIZE_MODE=heal`.
   * Off by default, so a strict-only server contains no model code at all.
   */
  healSupport?: boolean;
}

/** Level 1 only exists for web targets. */
export function httpEnabled(set: WorkflowSet, options: GenerateOptions): boolean {
  return set.targetType === 'web' && options.http === 'auto';
}

/** Level 3 (heal) only exists for web targets, and only when compiled with `--heal-support`. */
export function healEnabled(set: WorkflowSet, options: GenerateOptions): boolean {
  return set.targetType === 'web' && options.healSupport === true;
}

/** The settings that choose and reach the model of a heal; only their names are ever written to a file. */
export const MODEL_ENV_NAMES = [
  'DAEMONIZE_MODEL_PROVIDER',
  'DAEMONIZE_MODEL_NAME',
  'DAEMONIZE_MODEL_API_KEY',
  'DAEMONIZE_MODEL_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

/**
 * Standalone runtime embedded in every generated server. Each call starts from
 * the same known state (a fresh browser context, or a freshly started program),
 * replays the recorded steps with the payload values, and returns what the
 * resulting screen shows. Kept free of template literals so it can be embedded
 * verbatim.
 */

// Shared by both kinds of target, in replay.ts: the step type and the lookup of a step's value.
const REPLAY_COMMON = [
  `export type Step = {`,
  `  actionType: string;`,
  `  selectors: string[];`,
  `  value?: string;`,
  `  variable?: string;`,
  `  label?: string;`,
  `  timeoutMs?: number;`,
  `  // Level 2 (web): see step-plan.ts`,
  `  anchor?: any;`,
  `  rowBinding?: any;`,
  `  risk?: "read" | "write" | "delete";`,
  `  // Level 3 (web): see step-plan.ts. A write or delete step is healed only with allowHeal.`,
  `  allowHeal?: boolean;`,
  `  visual?: any;`,
  `  secretRef?: string;`,
  `  totp?: boolean;`,
  `  // Terminal: wait for a pattern of the rendered screen instead of a moment of silence, see pattern-wait.ts`,
  `  waitFor?: any;`,
  `  // Level 1 (web, compiled with --http): see http-replay.ts`,
  `  http?: any;`,
  `};`,
  ``,
  `// Where a replay starts when it runs in a sandbox that cannot reach the recorded one.`,
  `export type Overrides = { command?: string[]; url?: string };`,
  ``,
  `// Timeouts of a call, in the order they apply: the call (_timeoutMs), DAEMONIZE_TIMEOUT_MS, the workflow, the set, 30 s.`,
  `export type Limits = { callMs?: number; workflowMs?: number; setMs?: number };`,
  ``,
  `// What the call is compared with to tell whether the application still looks as recorded.`,
  `// finalZone limits the comparison: a CSS selector (web) or a rectangle of the screen (terminal).`,
  `export type Zone = { selector?: string; rect?: { row: number; col: number; rows: number; cols: number } };`,
  `export type ResultZone = Zone & { extractor?: ExtractorLike };`,
  `// cols and rows: the terminal size the workflow was recorded at (terminal targets); absent in old files.`,
  `export type Final = { finalScreenId?: string; finalZone?: Zone; resultZone?: ResultZone; workflowId?: string; cols?: number; rows?: number };`,
  ``,
  `const MAX_TEXT_LENGTH = 20000;`,
  ``,
  `// Without a recorded final screen nothing can be compared: drifted is false and driftChecked says so.`,
  `function driftFields(hash: string | undefined, final: Final): { drifted: boolean; driftChecked: boolean } {`,
  `  if (final.finalScreenId === undefined) return { drifted: false, driftChecked: false };`,
  `  return { drifted: hash !== final.finalScreenId, driftChecked: true };`,
  `}`,
  ``,
  `function resolveValue(step: Step, args: Record<string, unknown>): string | undefined {`,
  `  if (step.variable !== undefined) {`,
  `    const supplied = args[step.variable];`,
  `    return supplied === undefined || supplied === null ? step.value : String(supplied);`,
  `  }`,
  `  return step.value;`,
  `}`,
  ``,
];

// Payload validation, in mcp-server.ts: every call is checked against the inferred schema before any replay.
const VALIDATION_RUNTIME = [
  `// ajv-formats ships as CJS; cast to the callable form for TypeScript.`,
  `const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;`,
  `const ajv = new Ajv2020({ allErrors: true, strict: false });`,
  `addFormats(ajv);`,
  `// Schemas are compiled once at startup, not per call.`,
  `const validators = new Map<string, ValidateFunction>(`,
  `  Object.entries(INPUT_SCHEMAS).map(([tool, schema]) => [tool, ajv.compile(schema)])`,
  `);`,
  ``,
  `// Returns null when the payload is valid, the list of violations otherwise.`,
  `function validatePayload(tool: string, payload: unknown) {`,
  `  const validate = validators.get(tool);`,
  `  if (validate === undefined || validate(payload)) return null;`,
  `  return (validate.errors ?? []).map((err) => ({`,
  `    instancePath: err.instancePath ?? "",`,
  `    schemaPath: err.schemaPath ?? "",`,
  `    message: err.message ?? "Validation error"`,
  `  }));`,
  `}`,
  ``,
];

// Web targets: a fresh Playwright browser context per call; returns the page title and visible text.
// Strict level 2 (see step-plan.ts and web-steps.ts): accessible role and name in the recorded context, frame and page,
// the row bound to a Variable, then the recorded selectors. A step that no locator can perform stops the replay.
const WEB_SHARED = [
  `// Where the saved login is: DAEMONIZE_STORAGE_STATE (in a container, the read-only mount), else the recorded one, relative to this folder.`,
  `function resolveStorageState(): string | undefined {`,
  `  if (process.env.DAEMONIZE_STORAGE_STATE) return resolvePath(process.env.DAEMONIZE_STORAGE_STATE);`,
  `  if (STORAGE_STATE) return resolvePath(dirname(fileURLToPath(import.meta.url)), STORAGE_STATE);`,
  `  return undefined;`,
  `}`,
  ``,
  `// Timeout of a step (its action and the wait on its effect): the step's own, DAEMONIZE_STEP_TIMEOUT_MS, 8 s.`,
  `const STEP_TIMEOUT_MS = resolveStepTimeoutMs({ env: process.env.DAEMONIZE_STEP_TIMEOUT_MS });`,
  ``,
  `// strict (the default) or heal; anything but the exact word "heal" is strict`,
  `const MODE: ReplayMode = parseMode(process.env.DAEMONIZE_MODE);`,
  `// The steps of this call that a heal performed, and the heal session of the call`,
  `type HealTrack = { healedSteps: Array<{ stepIndex: number; source: string }>; session?: any };`,
  ``,
  `function errorParts(err: unknown): { tried: string[]; reason: string } {`,
  `  if (err instanceof StepExecutionError || err instanceof HealUnavailableError || err instanceof HealFailedError) return { tried: err.tried, reason: err.reason };`,
  `  return { tried: [], reason: (err as Error)?.message ?? String(err) };`,
  `}`,
  ``,
  `// The result of a step that failed: the strict diagnostic, and what heal mode adds to it`,
  `async function stepFailureResult(webRun: WebRun, outcome: { stepIndex: number; step: Step; tried: string[]; reason: string; cause?: unknown }, startedAt: number, extra: Record<string, unknown> = {}) {`,
  `  const shot = await captureFailure(webRun, outcome.stepIndex);`,
  `  const failure = describeFailure({`,
  `    stepIndex: outcome.stepIndex,`,
  `    step: outcome.step,`,
  `    tried: outcome.tried,`,
  `    reason: outcome.reason,`,
  `    screenshot: shot.screenshot,`,
  `    thumbnail: shot.thumbnail,`,
  `    secrets: webRun.secrets`,
  `  });`,
  `  let failed: Record<string, unknown> = { ...failureResult(failure, Date.now() - startedAt), ...extra };`,
  `  // Heal mode was asked for but cannot run: said as such, not as a plain strict failure`,
  `  if (outcome.cause instanceof HealUnavailableError) failed = { ...failed, error: "heal_unavailable" };`,
  `  // Heal ran and found nothing`,
  `  else if (outcome.cause instanceof HealFailedError) failed = { ...failed, heal: outcome.cause.heal };`,
  `  // In a container the host keeps the picture: it travels in the result and the host saves it`,
  `  return shot.data === undefined ? failed : { ...failed, failure: { ...(failed.failure as object), screenshotData: shot.data } };`,
  `}`,
  ``,
  `// What a call reports about heal: always present in heal mode, absent in strict mode`,
  `function modeFields(track: HealTrack): Record<string, unknown> {`,
  `  return { mode: MODE, ...(MODE === "heal" ? { healed: track.healedSteps.length > 0, healedSteps: track.healedSteps } : {}) };`,
  `}`,
  ``,
  `// The result of a call that ends on a page: its title, visible text (or the data of the Result_Zone) and the drift check.`,
  `async function finishWeb(webRun: WebRun, page: Page, final: Final, startedAt: number, deadline: number, extra: Record<string, unknown> = {}) {`,
  `  // The steps may have moved to another page (a pop-up)`,
  `  const last = webRun.pages[webRun.current];`,
  `  const finalPage = last !== undefined && !last.isClosed() ? last : page;`,
  `  // A Result_Zone limits the result to one element and extracts its structured data; without one, the whole visible text`,
  `  let text: string;`,
  `  let data: unknown;`,
  `  if (final.resultZone === undefined) {`,
  `    text = await finalPage.evaluate(() => document.body.innerText);`,
  `  } else {`,
  `    // The steps already ran: a zone that cannot be read is reported as such, strictly`,
  `    const read = await extractWebZone(finalPage, final.resultZone, boundStepTimeoutMs(STEP_TIMEOUT_MS, deadline - Date.now()));`,
  `    if (!read.ok) return zoneFailureResult(read, Date.now() - startedAt);`,
  `    text = read.text;`,
  `    data = redactDeep(typeof read.data === "string" ? boundText(read.data) : read.data, (value) => redactSecrets(value, webRun.secrets));`,
  `  }`,
  `  // The same screen as at recording time: the whole page, or only the zone when there is one`,
  `  let hash: string | undefined;`,
  `  if (final.finalScreenId !== undefined) {`,
  `    const zone = final.finalZone?.selector;`,
  `    // A zone that matches nothing leaves hash undefined, which counts as drift`,
  `    const raw = zone === undefined`,
  `      ? await finalPage.content()`,
  `      : (await finalPage.locator(zone).count()) === 0`,
  `        ? undefined`,
  `        : await finalPage.locator(zone).first().evaluate((el: Element) => el.outerHTML, { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);`,
  `    hash = raw === undefined ? undefined : screenId("dom", raw);`,
  `  }`,
  `  // DAEMONIZE_SCREENSHOT=final: a picture of the last screen (never while a password or code field shows)`,
  `  const finalShot = process.env.DAEMONIZE_SCREENSHOT === "final" ? await captureFinal(finalPage) : {};`,
  `  return {`,
  `    success: true,`,
  `    screenType: "dom",`,
  `    title: redactSecrets(await finalPage.title(), webRun.secrets),`,
  `    text: redactSecrets(boundText(text, MAX_TEXT_LENGTH), webRun.secrets),`,
  `    ...(final.resultZone === undefined ? {} : { data }),`,
  `    ...driftFields(hash, final),`,
  `    ...finalShot,`,
  `    ...extra,`,
  `    elapsedMs: Date.now() - startedAt`,
  `  };`,
  `}`,
];

// One web step. A server compiled without --heal-support has no heal code: asking for heal mode is reported as
// unavailable on the step where heal would have been needed, and the strict path is otherwise untouched.
const WEB_STEP_STRICT = [
  `async function runStep(webRun: WebRun, step: Step, _index: number, args: Record<string, unknown>, timeoutMs: number, _track: HealTrack, _final: Final, env: Record<string, string | undefined>): Promise<void> {`,
  `  try {`,
  `    await executeWebStep(webRun, step, args, { timeoutMs, env });`,
  `  } catch (err) {`,
  `    if (err instanceof StepExecutionError && err.healable && healEligible(step, MODE)) {`,
  `      throw new HealUnavailableError(err.tried, "heal mode was requested but this server was compiled without --heal-support (recompile with: daemonize compile --heal-support). The deterministic locators had failed: " + err.reason);`,
  `    }`,
  `    throw err;`,
  `  }`,
  `}`,
  ``,
];

// With --heal-support: when every deterministic locator of an eligible step failed, the heal modules are loaded
// (a dynamic import, only now) and look for the element: cached locator, recorded coordinates, then the model.
const WEB_STEP_HEAL = [
  `async function runStep(webRun: WebRun, step: Step, index: number, args: Record<string, unknown>, timeoutMs: number, track: HealTrack, final: Final, env: Record<string, string | undefined>): Promise<void> {`,
  `  try {`,
  `    await executeWebStep(webRun, step, args, { timeoutMs, env });`,
  `  } catch (err) {`,
  `    if (!(err instanceof StepExecutionError) || !err.healable || !healEligible(step, MODE)) throw err;`,
  `    const page = webRun.pages[webRun.current];`,
  `    if (page === undefined || page.isClosed()) throw err;`,
  `    if (track.session === undefined) {`,
  `      try {`,
  `        const heal = await import("./heal/heal-step.js");`,
  `        track.session = heal.createHealSession({`,
  `          workflowId: final.workflowId ?? "workflow",`,
  `          baseDir: dirname(fileURLToPath(import.meta.url)),`,
  `          protectedPaths: process.env.DAEMONIZE_WORKFLOW_FILE ? [process.env.DAEMONIZE_WORKFLOW_FILE, process.env.DAEMONIZE_WORKFLOW_FILE + ".assets"] : []`,
  `        });`,
  `      } catch (loadError) {`,
  `        throw new HealUnavailableError(err.tried, "heal mode was requested but the heal modules could not be loaded (" + String((loadError as Error).message).split("\\n")[0] + "). The deterministic locators had failed: " + err.reason);`,
  `      }`,
  `    }`,
  `    let value: string | undefined;`,
  `    try {`,
  `      value = resolveStepValue(step, args, env);`,
  `    } catch {`,
  `      value = undefined;`,
  `    }`,
  `    const outcome = await track.session.heal({ page, step, stepIndex: index, value, noDomTarget: hasNoDomTarget(step), timeoutMs, secrets: webRun.secrets });`,
  `    if (outcome.ok) {`,
  `      track.healedSteps.push({ stepIndex: index, source: outcome.source });`,
  `      return;`,
  `    }`,
  `    if (outcome.unavailable) {`,
  `      throw new HealUnavailableError(err.tried, "heal mode was requested but is unavailable: " + outcome.reason + ". The deterministic locators had failed: " + err.reason);`,
  `    }`,
  `    throw new HealFailedError(err.tried, err.reason, { attempted: true, reason: outcome.reason });`,
  `  }`,
  `}`,
  ``,
];

// Web targets, without --http: Level 2 only.
const WEB_RUNTIME = [
  `async function replayCore(steps: Step[], args: Record<string, unknown>, final: Final, limits: Limits, overrides: Overrides, track: HealTrack) {`,
  `  const startedAt = Date.now();`,
  `  const TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const deadline = startedAt + TIMEOUT_MS;`,
  `  // A secret that is not set fails the call before any step runs; only the name of its variable is reported`,
  `  const env = await withResolvedSecrets(process.env, [...secretVariables(steps)]);`,
  `  const missing = missingSecrets(steps, env);`,
  `  if (missing.length > 0) {`,
  `    return { success: false, error: "missing_secret", failure: { missingSecret: missing[0], missing }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  // The saved login is referenced by path and read by the browser into memory only; its content is never logged`,
  `  const storagePath = resolveStorageState();`,
  `  if (storagePath !== undefined && !existsSync(storagePath)) {`,
  `    return { success: false, error: "storage_state_missing", failure: { path: storagePath }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  const browser = await launchReplayBrowser(chromium);`,
  `  let timer: NodeJS.Timeout | undefined;`,
  `  try {`,
  `    const context = await browser.newContext(storagePath !== undefined ? { storageState: storagePath } : {});`,
  `    const page = await context.newPage();`,
  `    const webRun = createWebRun(context, page);`,
  `    // Passwords and TOTP seeds are removed from everything this call reports, whichever step fails`,
  `    webRun.secrets.push(...secretValues(steps, env));`,
  `    const run = async () => {`,
  `      await page.goto(overrides.url ?? START_URL, { timeout: TIMEOUT_MS });`,
  `      await waitForEffect(page as unknown as SettlePage, { timeoutMs: boundStepTimeoutMs(STEP_TIMEOUT_MS, deadline - Date.now()) });`,
  `      // Strict mode: the first step that no locator can perform stops the replay, no later step runs`,
  `      const outcome = await runStepsStrict(steps, async (step, index) => {`,
  `        // A step never waits longer than what is left of the whole replay`,
  `        const timeoutMs = boundStepTimeoutMs(resolveStepTimeoutMs({ step: step.timeoutMs, env: process.env.DAEMONIZE_STEP_TIMEOUT_MS }), deadline - Date.now());`,
  `        await runStep(webRun, step, index, args, timeoutMs, track, final, env);`,
  `      });`,
  `      if (!outcome.ok) return await stepFailureResult(webRun, outcome, startedAt);`,
  `      return await finishWeb(webRun, page, final, startedAt, deadline);`,
  `    };`,
  `    const timeout = new Promise<never>((_, reject) => {`,
  `      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);`,
  `    });`,
  `    return await Promise.race([run(), timeout]);`,
  `  } catch (err) {`,
  `    // A Playwright wait (page.goto) that ran out with the call budget is the call timeout`,
  `    const message = (err as Error).name === "TimeoutError" && Date.now() >= deadline - 5 ? "timeout" : (err as Error).message;`,
  `    return { success: false, error: message, elapsedMs: Date.now() - startedAt };`,
  `  } finally {`,
  `    clearTimeout(timer);`,
  `    await browser.close().catch(() => {});`,
  `  }`,
  `}`,
];

// With --http (Level 1): a recipe is executed directly (http-replay.ts); a workflow whose steps all have one runs
// without a browser. A workflow that has a ui step runs every step up to the last one in the browser (planSteps), so\n// page and cookies stay in sync. The browser starts on the first step that needs it (a step without recipe, or the Level 2
// fallback of a read step), at which point the field-filling steps skipped so far are replayed on the page.
// A recipe that mutates (POST/PUT/PATCH/DELETE) whose request failed is never repeated on another level; a GET may fall back.
const WEB_RUNTIME_HTTP = [
  `async function replayCore(steps: Step[], args: Record<string, unknown>, final: Final, limits: Limits, overrides: Overrides, track: HealTrack) {`,
  `  const startedAt = Date.now();`,
  `  const TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const deadline = startedAt + TIMEOUT_MS;`,
  `  // A secret that is not set fails the call before any step runs; only the name of its variable is reported`,
  `  // A step kept on the page never reads its recorded {"$secret":NAME} references: only the steps run over HTTP need them`,
  `  const plan = planSteps(steps);`,
  `  const httpSteps = steps.filter((_, index) => plan[index] === "http");`,
  `  const httpVariables = httpSteps.flatMap((step) => httpSecretNames(step.http).map(secretVariable));`,
  `  const env = await withResolvedSecrets(process.env, [...secretVariables(steps), ...httpVariables]);`,
  `  const missing = [...new Set([...missingSecrets(steps, env), ...missingHttpSecrets(httpSteps, env)])];`,
  `  if (missing.length > 0) {`,
  `    return { success: false, error: "missing_secret", failure: { missingSecret: missing[0], missing }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  // The saved login is referenced by path and read into memory only; its content is never logged`,
  `  const storagePath = resolveStorageState();`,
  `  if (storagePath !== undefined && !existsSync(storagePath)) {`,
  `    return { success: false, error: "storage_state_missing", failure: { path: storagePath }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  const variables = withRecordedDefaults(steps, args);`,
  `  // The level each step ran at; a field-filling step that only fed a request counts as http`,
  `  const levels: string[] = plan.map((mode) => (mode === "ui" ? "accessibility" : "http"));`,
  `  const secrets: string[] = [...secretValues(steps, env), ...httpSecretValues(httpSteps, env)];`,
  `  let levelFallback = false;`,
  `  let session: { browser: Browser; context: BrowserContext; page: Page; webRun: WebRun } | undefined;`,
  `  let timer: NodeJS.Timeout | undefined;`,
  ``,
  `  // The browser starts when a step first needs it, on the application as the requests left it`,
  `  const openBrowser = async () => {`,
  `    if (session !== undefined) return session;`,
  `    const browser = await launchReplayBrowser(chromium);`,
  `    try {`,
  `      const context = await browser.newContext(storagePath !== undefined ? { storageState: storagePath } : {});`,
  `      const page = await context.newPage();`,
  `      const webRun = createWebRun(context, page);`,
  `      webRun.secrets.push(...secrets);`,
  `      await page.goto(overrides.url ?? START_URL, { timeout: Math.max(1, deadline - Date.now()) });`,
  `      await waitForEffect(page as unknown as SettlePage, { timeoutMs: boundStepTimeoutMs(STEP_TIMEOUT_MS, deadline - Date.now()) });`,
  `      session = { browser, context, page, webRun };`,
  `      return session;`,
  `    } catch (err) {`,
  `      await browser.close().catch(() => {});`,
  `      throw err;`,
  `    }`,
  `  };`,
  ``,
  `  try {`,
  `    const run = async () => {`,
  `      let lastHttp: { data: unknown; drifted: boolean; driftChecked: boolean } | undefined;`,
  `      // Field-filling steps skipped because a later request carries their value`,
  `      const deferred: number[] = [];`,
  `      const stepTimeout = (step: Step) => boundStepTimeoutMs(resolveStepTimeoutMs({ step: step.timeoutMs, env: process.env.DAEMONIZE_STEP_TIMEOUT_MS }), deadline - Date.now());`,
  `      // Level 2 for one step; a failure stops the call, as in strict mode`,
  `      const ui = async (index: number): Promise<Record<string, unknown> | undefined> => {`,
  `        const open = await openBrowser();`,
  `        try {`,
  `          await runStep(open.webRun, steps[index], index, variables, stepTimeout(steps[index]), track, final, env);`,
  `          return undefined;`,
  `        } catch (err) {`,
  `          return await stepFailureResult(open.webRun, { stepIndex: index, step: steps[index], ...errorParts(err), cause: err }, startedAt, { levels, ...(levelFallback ? { levelFallback: true } : {}) });`,
  `        }`,
  `      };`,
  ``,
  `      for (let index = 0; index < steps.length; index++) {`,
  `        const step = steps[index];`,
  `        if (plan[index] === "prep") {`,
  `          deferred.push(index);`,
  `          continue;`,
  `        }`,
  `        if (plan[index] === "http") {`,
  `          const recipe = { ...step.http, url: rebaseOrigin(step.http.url, START_URL, overrides.url) };`,
  `          // With a browser open, its current cookies are the login; else the saved login file`,
  `          const state = session !== undefined ? await session.context.storageState() : storagePath;`,
  `          const outcome = await runHttpStep(recipe, variables, env, { timeoutMs: stepTimeout(step), storageState: state });`,
  `          secrets.push(...outcome.secrets.filter((s) => !secrets.includes(s)));`,
  `          if (session !== undefined) session.webRun.secrets.push(...outcome.secrets.filter((s) => !session!.webRun.secrets.includes(s)));`,
  `          if (outcome.ok) {`,
  `            lastHttp = outcome;`,
  `            continue;`,
  `          }`,
  `          // A write or delete request may have reached the server: another level could do the action twice`,
  `          if (recipeMutates(step.http)) {`,
  `            return httpFailureResult({ stepIndex: index, step, outcome, levels: levels.map((l, i) => (i > index ? "not_run" : l)), elapsedMs: Date.now() - startedAt });`,
  `          }`,
  `          // A read step is repeated on the page, strictly`,
  `          levelFallback = true;`,
  `          levels[index] = "accessibility";`,
  `          lastHttp = undefined;`,
  `        }`,
  `        for (const earlier of deferred.splice(0)) {`,
  `          levels[earlier] = "accessibility";`,
  `          const failed = await ui(earlier);`,
  `          if (failed !== undefined) return failed;`,
  `        }`,
  `        const failed = await ui(index);`,
  `        if (failed !== undefined) return failed;`,
  `        lastHttp = undefined;`,
  `      }`,
  ``,
  `      // The call ends on an HTTP step: the response is the result`,
  `      if (lastHttp !== undefined) {`,
  `        return buildHttpResult({ ...lastHttp, resultZone: final.resultZone, levels, levelFallback, secrets, elapsedMs: Date.now() - startedAt });`,
  `      }`,
  `      const open = await openBrowser();`,
  `      return await finishWeb(open.webRun, open.page, final, startedAt, deadline, { levels, ...(levelFallback ? { levelFallback: true } : {}) });`,
  `    };`,
  `    const timeout = new Promise<never>((_, reject) => {`,
  `      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);`,
  `    });`,
  `    return await Promise.race([run(), timeout]);`,
  `  } catch (err) {`,
  `    // A Playwright wait (page.goto) that ran out with the call budget is the call timeout`,
  `    const message = (err as Error).name === "TimeoutError" && Date.now() >= deadline - 5 ? "timeout" : scrub((err as Error).message, secrets);`,
  `    return { success: false, error: message, elapsedMs: Date.now() - startedAt };`,
  `  } finally {`,
  `    clearTimeout(timer);`,
  `    const open = session;`,
  `    if (open !== undefined) await open.browser.close().catch(() => {});`,
  `  }`,
  `}`,
];

// Terminal targets: a freshly started program in a pty per call; returns the text on its screen.
const TERMINAL_RUNTIME = [
  `// The documented fallback of a workflow recorded without a size (old files).`,
  `const DEFAULT_COLS = 80;`,
  `const DEFAULT_ROWS = 24;`,
  ``,
  `// DAEMONIZE_COLS / DAEMONIZE_ROWS override the recorded size; anything out of range is ignored.`,
  `function sizeFromEnv(name: string, min: number, max: number): number | undefined {`,
  `  const text = process.env[name]?.trim();`,
  `  if (text === undefined || !/^[0-9]+$/.test(text)) return undefined;`,
  `  const n = Number(text);`,
  `  return n >= min && n <= max ? n : undefined;`,
  `}`,
  ``,
  `const STABLE_MS = 150;`,
  `const MAX_SETTLE_MS = 3000;`,
  `const SILENT_GRACE_MS = 500;`,
  ``,
  `// @xterm/headless is CommonJS: take the class from the default export.`,
  `const { Terminal } = xtermHeadless;`,
  ``,
  `async function replayCore(steps: Step[], args: Record<string, unknown>, final: Final, limits: Limits, overrides: Overrides) {`,
  `  const startedAt = Date.now();`,
  `  const TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  // The size of the pty and of the screen renderer: the environment, else the recorded size, else 80x24`,
  `  const COLS = sizeFromEnv("DAEMONIZE_COLS", 20, 500) ?? final.cols ?? DEFAULT_COLS;`,
  `  const ROWS = sizeFromEnv("DAEMONIZE_ROWS", 5, 200) ?? final.rows ?? DEFAULT_ROWS;`,
  `  const screen = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });`,
  `  let lastActivityAt = Date.now();`,
  `  let touchedAt = Date.now();`,
  `  let writesSinceTouch = 0;`,
  `  let exited = false;`,
  `  let timer: NodeJS.Timeout | undefined;`,
  ``,
  `  const [command, ...commandArgs] = overrides.command ?? START_COMMAND;`,
  `  const program = pty.spawn(command, commandArgs, { cols: COLS, rows: ROWS, name: "xterm-256color" });`,
  `  const outputListeners = new Set<() => void>();`,
  `  program.onData((data: string) => {`,
  `    screen.write(data);`,
  `    lastActivityAt = Date.now();`,
  `    writesSinceTouch += 1;`,
  `    for (const listener of outputListeners) listener();`,
  `  });`,
  `  program.onExit(() => {`,
  `    exited = true;`,
  `  });`,
  ``,
  `  // Wait until the program has reacted and gone quiet: a moment of silence after its`,
  `  // output, or a longer grace period if it prints nothing, then until the screen is rendered.`,
  `  const settle = async (graceMs = SILENT_GRACE_MS, maxMs = MAX_SETTLE_MS) => {`,
  `    const waitStart = Date.now();`,
  `    for (;;) {`,
  `      const now = Date.now();`,
  `      const done = writesSinceTouch > 0 ? now - lastActivityAt >= STABLE_MS : now - touchedAt >= graceMs;`,
  `      if (done || now - waitStart >= maxMs) break;`,
  `      await new Promise<void>((resolve) => setTimeout(resolve, 10));`,
  `    }`,
  `    await new Promise<void>((resolve) => screen.write("", resolve));`,
  `  };`,
  ``,
  `  const screenText = () => {`,
  `    const buffer = screen.buffer.active;`,
  `    const lines: string[] = [];`,
  `    for (let row = 0; row < ROWS; row++) {`,
  `      lines.push((buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").trimEnd());`,
  `    }`,
  `    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();`,
  `    return lines.join("\\n");`,
  `  };`,
  ``,
  `  // The rendered screen, once everything the program printed so far is drawn.`,
  `  const readScreen = async () => {`,
  `    await new Promise<void>((resolve) => screen.write("", resolve));`,
  `    return screenText();`,
  `  };`,
  ``,
  `  try {`,
  `    const run = async () => {`,
  `      // A program may take a while to start and print its first screen; a terminal`,
  `      // emits set-up sequences first, so wait for text rather than for bytes.`,
  `      const firstTextDeadline = Date.now() + 5000;`,
  `      for (;;) {`,
  `        await new Promise<void>((resolve) => screen.write("", resolve));`,
  `        if (screenText() !== "" || exited || Date.now() >= firstTextDeadline) break;`,
  `        await new Promise<void>((resolve) => setTimeout(resolve, 25));`,
  `      }`,
  `      await settle();`,
  `      // A step with a waitFor waits for its pattern on the rendered screen (up to its timeout, and never past the`,
  `      // time left for the call); the silence rule below is only for steps without one. A pattern that does not`,
  `      // show up stops the replay: no later step runs.`,
  `      const waitForStep = async (step: Step, index: number, wait: CompiledScreenPattern) => {`,
  `        const left = Math.max(1, TIMEOUT_MS - (Date.now() - startedAt));`,
  `        const outcome = await waitForPattern(readScreen, wait, {`,
  `          timeoutMs: Math.min(step.waitFor.timeoutMs, left),`,
  `          subscribe: (listener) => {`,
  `            outputListeners.add(listener);`,
  `            return () => outputListeners.delete(listener);`,
  `          },`,
  `          isClosed: () => exited`,
  `        });`,
  `        return outcome.matched`,
  `          ? undefined`,
  `          : patternTimeoutResult({ stepIndex: index, wait, elapsedMs: outcome.elapsedMs, screenExcerpt: outcome.screenExcerpt }, Date.now() - startedAt);`,
  `      };`,
  `      for (let index = 0; index < steps.length; index++) {`,
  `        const step = steps[index];`,
  `        const value = resolveValue(step, args);`,
  `        const wait = step.waitFor === undefined ? undefined : compileStepWait(step.waitFor);`,
  `        if (wait !== undefined && step.waitFor.when === "before") {`,
  `          const failed = await waitForStep(step, index, wait);`,
  `          if (failed !== undefined) return failed;`,
  `        }`,
  `        switch (step.actionType) {`,
  `          case "type":`,
  `            program.write(value ?? "");`,
  `            break;`,
  `          case "keypress":`,
  `            program.write(KEY_SEQUENCES[value ?? ""] ?? value ?? "");`,
  `            break;`,
  `          case "form_submit":`,
  `            program.write(KEY_SEQUENCES["Enter"]);`,
  `            break;`,
  `          case "select":`,
  `            program.write((value ?? "") + KEY_SEQUENCES["Enter"]);`,
  `            break;`,
  `          default:`,
  `            throw new Error("Unsupported action for a terminal program: " + step.actionType);`,
  `        }`,
  `        touchedAt = Date.now();`,
  `        writesSinceTouch = 0;`,
  `        if (wait !== undefined && step.waitFor.when !== "before") {`,
  `          const failed = await waitForStep(step, index, wait);`,
  `          if (failed !== undefined) return failed;`,
  `        } else {`,
  `          await settle();`,
  `        }`,
  `      }`,
  `      const finalText = screenText();`,
  `      // A Result_Zone limits the result to a crop of the screen and extracts its structured data`,
  `      let text = finalText;`,
  `      let data: unknown;`,
  `      if (final.resultZone !== undefined) {`,
  `        const read = extractTerminalZone(finalText, final.resultZone);`,
  `        if (!read.ok) return zoneFailureResult(read, Date.now() - startedAt);`,
  `        text = read.text;`,
  `        data = typeof read.data === "string" ? boundText(read.data, MAX_TEXT_LENGTH) : read.data;`,
  `      }`,
  `      let hash: string | undefined;`,
  `      if (final.finalScreenId !== undefined) {`,
  `        const rect = final.finalZone?.rect;`,
  `        hash = screenId("terminal", rect === undefined ? finalText : cropTerminal(finalText, rect));`,
  `      }`,
  `      // A screen rendered at another size than the recorded one is never judged equal: the hash alone cannot tell`,
  `      const recordedSize = final.cols !== undefined && final.rows !== undefined ? final.cols + "x" + final.rows : undefined;`,
  `      const replaySize = COLS + "x" + ROWS;`,
  `      const sizeDrift = final.finalScreenId !== undefined && recordedSize !== undefined && recordedSize !== replaySize;`,
  `      return {`,
  `        success: true,`,
  `        screenType: "terminal",`,
  `        text: boundText(text, MAX_TEXT_LENGTH),`,
  `        ...(final.resultZone === undefined ? {} : { data }),`,
  `        ...driftFields(hash, final),`,
  `        ...(sizeDrift ? { drifted: true, driftReason: "terminal size: recorded " + recordedSize + ", replayed at " + replaySize } : {}),`,
  `        terminalSize: { cols: COLS, rows: ROWS },`,
  `        elapsedMs: Date.now() - startedAt`,
  `      };`,
  `    };`,
  `    const timeout = new Promise<never>((_, reject) => {`,
  `      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);`,
  `    });`,
  `    return await Promise.race([run(), timeout]);`,
  `  } catch (err) {`,
  `    return { success: false, error: (err as Error).message, elapsedMs: Date.now() - startedAt };`,
  `  } finally {`,
  `    clearTimeout(timer);`,
  `    if (!exited) {`,
  `      try {`,
  `        program.kill();`,
  `      } catch {`,
  `        // Already gone`,
  `      }`,
  `    }`,
  `    screen.dispose();`,
  `  }`,
  `}`,
];

// The exported replay: the core, plus what every result says about the mode (and, in heal mode, about healing).
const WEB_REPLAY_ENTRY = [
  ``,
  `export async function replay(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}, overrides: Overrides = {}) {`,
  `  const track: HealTrack = { healedSteps: [] };`,
  `  const result = await replayCore(steps, args, final, limits, overrides, track);`,
  `  return { ...modeFields(track), ...result };`,
  `}`,
];

// A terminal program is never healed: heal mode only changes what the result reports.
const TERMINAL_REPLAY_ENTRY = [
  ``,
  `export async function replay(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}, overrides: Overrides = {}) {`,
  `  const result = await replayCore(steps, args, final, limits, overrides);`,
  `  const heal = process.env.DAEMONIZE_MODE?.trim().toLowerCase() === "heal";`,
  `  return { mode: heal ? "heal" : "strict", ...(heal ? { healed: false, healedSteps: [] } : {}), ...result };`,
  `}`,
];

// Container entry point of replay.js: `node replay.js --container` reads one request on stdin and
// prints the result as one line on stdout. Nothing else is written to stdout.
const CONTAINER_ENTRY = [
  ``,
  `if (process.argv.includes("--container")) {`,
  `  let input = "";`,
  `  for await (const chunk of process.stdin) input += chunk;`,
  `  const request = JSON.parse(input) as {`,
  `    steps: Step[];`,
  `    args: Record<string, unknown>;`,
  `    final?: Final;`,
  `    limits?: Limits;`,
  `    command?: string[];`,
  `    url?: string;`,
  `  };`,
  `  const result = await replay(request.steps, request.args, request.final ?? {}, request.limits ?? {}, { command: request.command, url: request.url });`,
  `  process.stdout.write(JSON.stringify(result) + "\\n");`,
  `  process.exit(0);`,
  `}`,
];

// docker-replay.ts: replays one call inside a throw-away container, so the target application
// never runs on the host. Needs only the docker command; settings come from the environment.
const DOCKER_RUNTIME = [
  `const DOCKER = process.env.DAEMONIZE_DOCKER ?? "docker";`,
  `const NETWORK = process.env.DAEMONIZE_SANDBOX_NETWORK ?? DEFAULT_NETWORK;`,
  `const IMAGE = process.env.DAEMONIZE_SANDBOX_IMAGE ?? DEFAULT_IMAGE;`,
  `const MEMORY_MB = Number(process.env.DAEMONIZE_SANDBOX_MEMORY_MB ?? 512);`,
  `const CPUS = Number(process.env.DAEMONIZE_SANDBOX_CPUS ?? 1);`,
  `// JSON arrays set by the user: the only folders of the host the container can see, e.g. ["/data:/data:ro"]`,
  `const MOUNTS: string[] = [...new Set([...SET_MOUNTS, ...(JSON.parse(process.env.DAEMONIZE_SANDBOX_MOUNTS ?? "[]") as string[])])];`,
  `// What to start inside the container, when it differs from what was recorded on the host.`,
  `const COMMAND: string[] | undefined = process.env.DAEMONIZE_SANDBOX_COMMAND`,
  `  ? JSON.parse(process.env.DAEMONIZE_SANDBOX_COMMAND)`,
  `  : undefined;`,
  `const URL_OVERRIDE = process.env.DAEMONIZE_SANDBOX_URL;`,
  `const STARTUP_ALLOWANCE_MS = 20000;`,
  ``,
  `// A failed step comes back with its screenshot as data: keep it on the host, where the caller can open it.`,
  `function keepScreenshot(result: Record<string, unknown>): Record<string, unknown> {`,
  `  const failure = result.failure as Record<string, unknown> | undefined;`,
  `  if (failure === undefined || failure === null || typeof failure.screenshotData !== "string") return result;`,
  `  try {`,
  `    const dir = join(tmpdir(), "daemonize-failures");`,
  `    mkdirSync(dir, { recursive: true });`,
  `    const path = join(dir, "fail-" + Date.now() + "-" + String(failure.stepIndex) + ".png");`,
  `    writeFileSync(path, Buffer.from(failure.screenshotData, "base64"));`,
  `    failure.screenshot = path;`,
  `  } catch {`,
  `    delete failure.screenshot;`,
  `  }`,
  `  delete failure.screenshotData;`,
  `  return result;`,
  `}`,
  ``,
  `// Where the container sees the saved login`,
  `const STORAGE_STATE_IN_CONTAINER = "/run/daemonize/storage-state.json";`,
  ``,
  `// The saved login on the host: DAEMONIZE_STORAGE_STATE, else the one recorded (relative to this folder). Web targets only.`,
  `function resolveHostStorageState(): string | undefined {`,
  `  if (!WEB_TARGET) return undefined;`,
  `  if (process.env.DAEMONIZE_STORAGE_STATE) return resolve(process.env.DAEMONIZE_STORAGE_STATE);`,
  `  if (STORAGE_STATE_RECORDED) return resolve(dirname(fileURLToPath(import.meta.url)), STORAGE_STATE_RECORDED);`,
  `  return undefined;`,
  `}`,
  ``,
  `// The arguments of docker run. Secrets are named without a value (docker reads them from this process's environment),`,
  `// so no secret appears on a command line; the saved login is a read-only bind mount, never part of the image.`,
  `// Where heal keeps its files on the host: the cache folder (read and written) and the recorded thumbnails (read-only).`,
  `export type HealMounts = { cacheDir: string; cacheFile: string; anchorsDir: string };`,
  `const HEAL_CACHE_IN_CONTAINER = "/run/daemonize/heal";`,
  `const ANCHORS_IN_CONTAINER = "/run/daemonize/anchors";`,
  ``,
  `export function buildDockerArgs(options: { name: string; timeoutEnv: string[]; steps: Step[]; storagePath?: string; mode?: "strict" | "heal"; heal?: HealMounts }): string[] {`,
  `  const secretEnv = [...new Set([`,
  `    ...options.steps.filter((s) => s.secretRef !== undefined).map((s) => secretEnvName(s.secretRef as string)),`,
  `    ...HTTP_SECRET_VARIABLES(options.steps),`,
  `  ])].flatMap((variable) => ["-e", variable]);`,
  `  // A terminal size set on the host applies in the container too (the recorded size travels in the request)`,
  `  const sizeEnv = WEB_TARGET ? [] : ["DAEMONIZE_COLS", "DAEMONIZE_ROWS"].flatMap((variable) => /^[0-9]+$/.test(process.env[variable]?.trim() ?? "") ? ["-e", variable + "=" + process.env[variable]!.trim()] : []);`,
  `  const mode = options.mode === "heal" ? "heal" : "strict";`,
  `  // The settings of the model by name only (docker copies the value from this process), and only for a heal`,
  `  const modelEnv = mode === "heal" && HEAL_SUPPORT ? MODEL_ENV_NAMES.flatMap((variable) => ["-e", variable]) : [];`,
  `  // The cache is the one thing a heal writes; the thumbnails are read-only, like the saved login`,
  `  const healMounts = mode === "heal" && HEAL_SUPPORT && options.heal !== undefined`,
  `    ? [`,
  `        "-v", options.heal.cacheDir + ":" + HEAL_CACHE_IN_CONTAINER,`,
  `        "-e", "DAEMONIZE_HEAL_CACHE=" + HEAL_CACHE_IN_CONTAINER + "/" + options.heal.cacheFile,`,
  `        "-v", options.heal.anchorsDir + ":" + ANCHORS_IN_CONTAINER + ":ro",`,
  `        "-e", "DAEMONIZE_ANCHORS_DIR=" + ANCHORS_IN_CONTAINER`,
  `      ]`,
  `    : [];`,
  `  return [`,
  `    "run", "--rm", "-i", "--name", options.name,`,
  `    // Never download an image implicitly: it must have been built on purpose`,
  `    "--pull", "never",`,
  `    "--network", NETWORK,`,
  `    "--memory", MEMORY_MB + "m", "--cpus", String(CPUS),`,
  `    "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",`,
  `    ...EXTRA_FLAGS,`,
  `    ...(SET_WORKDIR === undefined ? [] : ["-w", SET_WORKDIR]),`,
  `    ...options.timeoutEnv,`,
  `    ...sizeEnv,`,
  `    "-e", "DAEMONIZE_MODE=" + mode,`,
  `    ...secretEnv,`,
  `    ...modelEnv,`,
  `    ...healMounts,`,
  `    ...(options.storagePath === undefined ? [] : ["-v", options.storagePath + ":" + STORAGE_STATE_IN_CONTAINER + ":ro", "-e", "DAEMONIZE_STORAGE_STATE=" + STORAGE_STATE_IN_CONTAINER]),`,
  `    ...MOUNTS.flatMap((mount) => ["-v", mount]),`,
  `    IMAGE`,
  `  ];`,
  `}`,
  ``,
  `// A terminal program replayed with a network (git clone, psql...) is allowed, but it is not the default: say so once.`,
  `let warnedNetwork = false;`,
  `function warnNetworkOnce(): void {`,
  `  if (warnedNetwork || WEB_TARGET || NETWORK === "none") return;`,
  `  warnedNetwork = true;`,
  `  console.error("daemonize warning: the sandbox of this terminal program runs with the network " + NETWORK + " (a terminal program has none by default). It can reach the network and the services of the host.");`,
  `}`,
  `export async function replayInDocker(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}) {`,
  `  const startedAt = Date.now();`,
  `  warnNetworkOnce();`,
  `  // Resolved here, so the container applies the same value; the step timeout travels as an environment variable`,
  `  const REPLAY_TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const timeoutEnv = ["-e", "DAEMONIZE_TIMEOUT_MS=" + REPLAY_TIMEOUT_MS];`,
  `  if (process.env.DAEMONIZE_STEP_TIMEOUT_MS) timeoutEnv.push("-e", "DAEMONIZE_STEP_TIMEOUT_MS=" + process.env.DAEMONIZE_STEP_TIMEOUT_MS);`,
  `  const fail = (error: string) => ({ success: false, error, elapsedMs: Date.now() - startedAt });`,
  ``,
  `  // A secret that is not set fails the call before the container starts; the container receives the values from this environment, never on the command line`,
  `  // Resolved once per call: the environment first, then the vault of the application, then the generic vault`,
  `  const env = await withResolvedSecrets(process.env, [...secretVariables(steps), ...HTTP_SECRET_VARIABLES(steps)]);`,
  `  const missing = [...new Set([...missingSecrets(steps, env), ...HTTP_MISSING_SECRETS(steps, env)])];`,
  `  if (missing.length > 0) {`,
  `    return { success: false, error: "missing_secret", failure: { missingSecret: missing[0], missing }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  ``,
  `  if (HOST_COMMAND && !COMMAND && HOST_COMMAND.some((part) => /^[A-Za-z]:[\\\\/]/.test(part))) {`,
  `    return fail("sandbox: the program was recorded with a path of the host; set DAEMONIZE_SANDBOX_COMMAND to its command line inside the container");`,
  `  }`,
  ``,
  `  // The saved login stays on the host: the container gets that one file, read-only, by absolute path.`,
  `  // Its path is not a secret; its content is never read or logged here.`,
  `  const storagePath = resolveHostStorageState();`,
  `  if (storagePath !== undefined && !(existsSync(storagePath) && statSync(storagePath).isFile())) {`,
  `    return { success: false, error: "storage_state_missing", failure: { path: storagePath }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  ``,
  `  const name = "daemonize-" + Math.random().toString(36).slice(2, 10);`,
  `  // Heal mode: the cache and the thumbnails are folders of this server's output directory (or DAEMONIZE_HEAL_CACHE)`,
  `  const mode = process.env.DAEMONIZE_MODE?.trim().toLowerCase() === "heal" ? "heal" : "strict";`,
  `  let heal: HealMounts | undefined;`,
  `  if (mode === "heal" && HEAL_SUPPORT) {`,
  `    const here = dirname(fileURLToPath(import.meta.url));`,
  `    const cacheFile = process.env.DAEMONIZE_HEAL_CACHE ? resolve(process.env.DAEMONIZE_HEAL_CACHE) : join(here, ".daemonize", "heal-cache.json");`,
  `    const anchorsDir = join(here, ".daemonize", "anchors");`,
  `    try {`,
  `      mkdirSync(dirname(cacheFile), { recursive: true });`,
  `      mkdirSync(anchorsDir, { recursive: true });`,
  `      heal = { cacheDir: dirname(cacheFile), cacheFile: basename(cacheFile), anchorsDir };`,
  `    } catch {`,
  `      heal = undefined;`,
  `    }`,
  `  }`,
  `  const dockerArgs = buildDockerArgs({ name, timeoutEnv, steps, storagePath, mode, heal });`,
  ``,
  `  return new Promise<Record<string, unknown>>((resolve) => {`,
  `    const child = spawn(DOCKER, dockerArgs, { stdio: ["pipe", "pipe", "pipe"], env });`,
  `    let stdout = "";`,
  `    let stderr = "";`,
  `    let settled = false;`,
  `    const finish = (result: Record<string, unknown>) => {`,
  `      if (settled) return;`,
  `      settled = true;`,
  `      clearTimeout(timer);`,
  `      resolve(result);`,
  `    };`,
  ``,
  `    const timer = setTimeout(() => {`,
  `      spawn(DOCKER, ["kill", name], { stdio: "ignore" }).on("error", () => {});`,
  `      finish(fail("timeout"));`,
  `    }, REPLAY_TIMEOUT_MS + STARTUP_ALLOWANCE_MS);`,
  ``,
  `    child.stdout.on("data", (data) => (stdout += data));`,
  `    child.stderr.on("data", (data) => (stderr += data));`,
  `    child.on("error", (err) => finish(fail("sandbox_unavailable: cannot run " + DOCKER + " (" + err.message + ")")));`,
  `    child.on("close", (code) => {`,
  `      const lastLine = stdout.trim().split("\\n").pop() ?? "";`,
  `      try {`,
  `        finish(keepScreenshot(JSON.parse(lastLine)));`,
  `        return;`,
  `      } catch {`,
  `        // Not a result: the container could not run`,
  `      }`,
  `      const detail = stderr.trim().split("\\n").slice(-3).join(" ");`,
  `      const unavailable = /Cannot connect to the Docker daemon|error during connect|No such image|pull access denied/i.test(stderr);`,
  `      finish(fail((unavailable ? "sandbox_unavailable: " : "sandbox failed (exit " + code + "): ") + detail));`,
  `    });`,
  `    // The container may end before it has read everything`,
  `    child.stdin.on("error", () => {});`,
  `    child.stdin.end(JSON.stringify({ steps, args, final, limits: { callMs: REPLAY_TIMEOUT_MS }, command: COMMAND, url: URL_OVERRIDE }));`,
  `  });`,
  `}`,
];

/**
 * Generates the standalone TypeScript files of an MCP server from an annotated
 * Workflow set: the server (`generate`), the replay of a workflow
 * (`generateReplay`) and its replay in a container (`generateDockerReplay`).
 * They import only @modelcontextprotocol/sdk, zod, ajv, ajv-formats and,
 * depending on the target, playwright (web) or node-pty and @xterm/headless
 * (terminal) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no Daemonize runtime dependency.
 */
export class McpGenerator {
  /**
   * Generate a standalone TypeScript MCP server source file.
   *
   * The generated file:
   * - Imports @modelcontextprotocol/sdk, zod, ajv, ajv-formats and playwright
   *   (web) or node-pty and @xterm/headless (terminal)
   * - Validates every payload against the inferred JSON Schema before replaying
   * - Requires NO Daemonize runtime dependency
   * - Registers one tool per Workflow using server.tool()
   * - Replays the workflow from a fresh browser context, or a freshly started
   *   program, on every call
   * - Starts a StdioServerTransport
   *
   * @param set - Annotated workflow set
   * @param toolNames - Map from workflowId to tool name
   * @returns TypeScript source code as a string
   */
  generate(
    set: WorkflowSet,
    toolNames: Map<string, string>,
    options: GenerateOptions = {}
  ): string {
    this.assertTarget(set);

    const toolBlocks = set.workflows
      .map((w) => this.generateToolBlock(set, w, toolNames, httpEnabled(set, options)))
      .join('\n\n');

    const lines: string[] = [
      `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
      `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
      `import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";`,
      `import _addFormats from "ajv-formats";`,
      `import { z } from "zod";`,
      `import { replay } from "./replay.js";`,
      `import { replayInDocker } from "./docker-replay.js";`,
      ``,
      `const INPUT_SCHEMAS: Record<string, object> = ${JSON.stringify(this.collectInputSchemas(set, toolNames))};`,
      ``,
      ...VALIDATION_RUNTIME,
      `// DAEMONIZE_SANDBOX=docker replays every call in a throw-away container instead of on this machine.`,
      `const runReplay = process.env.DAEMONIZE_SANDBOX === "docker" ? replayInDocker : replay;`,
      ``,
      `// DAEMONIZE_MODE=strict (the default) or heal. Every result says which mode produced it; a result that did not`,
      `// get as far as a replay (a refused payload, a sandbox that did not start) is completed here.`,
      `const MODE = process.env.DAEMONIZE_MODE?.trim().toLowerCase() === "heal" ? "heal" : "strict";`,
      `function withMode(result: object): object {`,
      `  return { mode: MODE, ...(MODE === "heal" ? { healed: false, healedSteps: [] } : {}), ...result };`,
      `}`,
      ``,
      `const server = new McpServer({`,
      `  name: ${JSON.stringify(set.targetName)},`,
      `  version: "1.0.0"`,
      `});`,
      ``,
      toolBlocks,
      ``,
      `const transport = new StdioServerTransport();`,
      `await server.connect(transport);`,
    ];

    return lines.join('\n');
  }

  /**
   * Generate `replay.ts`: replays the steps of a workflow from a fresh browser
   * context, or a freshly started program. It runs on the host when imported by
   * the server and inside a container when started with `--container`.
   */
  generateReplay(set: WorkflowSet, options: GenerateOptions = {}): string {
    this.assertTarget(set);
    const http = httpEnabled(set, options);
    const heal = healEnabled(set, options);

    const lines: string[] = [
      ...(set.targetType === 'web'
        ? [
          `import { chromium, type Browser, type BrowserContext, type Page } from "playwright";`,
          `import { existsSync } from "node:fs";`,
          `import { dirname, resolve as resolvePath } from "node:path";`,
          `import { fileURLToPath } from "node:url";`,
          `import { screenId } from "./screen-hash.js";`,
          `import { waitForEffect, resolveTimeoutMs, resolveStepTimeoutMs, boundStepTimeoutMs, type SettlePage } from "./settle.js";`,
          `import { createWebRun, executeWebStep, captureFailure, captureFinal, extractWebZone, type WebRun } from "./web-steps.js";`,
          `import { boundText, redactDeep, zoneFailureResult, type ExtractorLike } from "./extract.js";`,
          `import { missingSecrets, secretValues, redactSecrets, runStepsStrict, describeFailure, failureResult, StepExecutionError, HealUnavailableError, HealFailedError, healEligible, hasNoDomTarget, parseMode, resolveStepValue, secretVariables, type ReplayMode } from "./step-plan.js";`,
          `import { withResolvedSecrets } from "./vault-reader.js";`,
          `import { launchReplayBrowser } from "./browser-launch.js";`,
          ...(http
            ? [`import { planSteps, recipeMutates, runHttpStep, withRecordedDefaults, rebaseOrigin, missingHttpSecrets, httpSecretValues, httpSecretNames, secretVariable, buildHttpResult, httpFailureResult, scrub } from "./http-replay.js";`]
            : []),
        ]
        : [
          `import pty from "node-pty";`,
          `import xtermHeadless from "@xterm/headless";`,
          `import { screenId, cropTerminal } from "./screen-hash.js";`,
          `import { resolveTimeoutMs } from "./settle.js";`,
          `import { compileStepWait, waitForPattern, patternTimeoutResult, type CompiledScreenPattern } from "./pattern-wait.js";`,
          `import { boundText, extractTerminalZone, zoneFailureResult, type ExtractorLike } from "./extract.js";`,
        ]),
      ``,
      ...(set.targetType === 'web'
        ? [
          `const START_URL = ${JSON.stringify(set.startUrl)};`,
          `const STORAGE_STATE: string | undefined = ${JSON.stringify(set.storageState)};`,
        ]
        : [
          `const START_COMMAND: string[] = ${JSON.stringify(set.startCommand)};`,
          `const KEY_SEQUENCES: Record<string, string> = ${JSON.stringify(KEY_SEQUENCES)};`,
        ]),
      ``,
      ...REPLAY_COMMON,
      ...(set.targetType === 'web'
        ? [
          ...WEB_SHARED,
          ...(heal ? WEB_STEP_HEAL : WEB_STEP_STRICT),
          ...(http ? WEB_RUNTIME_HTTP : WEB_RUNTIME),
          ...WEB_REPLAY_ENTRY,
        ]
        : [...TERMINAL_RUNTIME, ...TERMINAL_REPLAY_ENTRY]),
      ...CONTAINER_ENTRY,
    ];
    return lines.join('\n') + '\n';
  }

  /**
   * Generate `docker-replay.ts`: replays a call in a throw-away container with
   * limits on memory and CPU, no capabilities, no implicit image download, and
   * no network for a terminal program.
   *
   * @param imageTag - default tag of the sandbox image built by `daemonize sandbox build`
   */
  generateDockerReplay(set: WorkflowSet, imageTag: string, options: GenerateOptions = {}): string {
    this.assertTarget(set);
    const http = httpEnabled(set, options);

    const terminal = set.targetType === 'tui';
    const lines: string[] = [
      `import { spawn } from "node:child_process";`,
      `import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";`,
      `import { tmpdir } from "node:os";`,
      `import { basename, dirname, join, resolve } from "node:path";`,
      `import { fileURLToPath } from "node:url";`,
      `import type { Step, Final, Limits } from "./replay.js";`,
      `import { resolveTimeoutMs } from "./settle.js";`,
      `import { missingSecrets, secretEnvName, secretVariables } from "./step-plan.js";`,
      `import { withResolvedSecrets } from "./vault-reader.js";`,
      ...(http ? [`import { planSteps, httpSecretNames, missingHttpSecrets, secretVariable, COOKIE_HEADER_VARIABLE } from "./http-replay.js";`] : []),
      ``,
      http
        ? `// Level 1: the secrets of the recipes and the cookie header are forwarded by name, like the typed secrets.`
        : `// Level 1 (--http) is not compiled in.`,
      http
        ? `const httpStepsOf = (steps: Step[]): Step[] => { const plan = planSteps(steps); return steps.filter((_, index) => plan[index] === "http"); };\n` +
        `const HTTP_SECRET_VARIABLES = (steps: Step[]): string[] => [...httpStepsOf(steps).flatMap((s) => httpSecretNames(s.http).map(secretVariable)), ...(process.env[COOKIE_HEADER_VARIABLE] ? [COOKIE_HEADER_VARIABLE] : [])];`
        : `const HTTP_SECRET_VARIABLES = (_steps: Step[]): string[] => [];`,
      http
        ? `const HTTP_MISSING_SECRETS = (steps: Step[], env: Record<string, string | undefined> = process.env): string[] => missingHttpSecrets(httpStepsOf(steps), env);`
        : `const HTTP_MISSING_SECRETS = (_steps: Step[], _env?: Record<string, string | undefined>): string[] => [];`,
      ``,
      healEnabled(set, options)
        ? `// Heal mode (compiled with --heal-support): the settings of the model are forwarded by name, like the secrets.`
        : `// Heal mode is not compiled in.`,
      `const HEAL_SUPPORT = ${JSON.stringify(healEnabled(set, options))};`,
      `const MODEL_ENV_NAMES: string[] = ${JSON.stringify(healEnabled(set, options) ? MODEL_ENV_NAMES : [])};`,
      ``,
      `const DEFAULT_IMAGE = ${JSON.stringify(imageTag)};`,
      `const WEB_TARGET = ${JSON.stringify(!terminal)};`,
      `const STORAGE_STATE_RECORDED: string | undefined = ${JSON.stringify(terminal ? undefined : set.storageState)};`,
      terminal
        ? `// A terminal program needs nothing from the network.`
        : `// A browser must reach the application; the container still has no access to the host network stack.`,
      `const DEFAULT_NETWORK = ${JSON.stringify(set.sandbox?.network ?? defaultNetwork(set.targetType))};`,
      `// The set may ask for more: mounts (added to those of --mount) and the working directory of the program.`,
      `const SET_MOUNTS: string[] = ${JSON.stringify(set.sandbox?.mounts ?? [])};`,
      `const SET_WORKDIR: string | undefined = ${JSON.stringify(set.sandbox?.workdir)};`,
      terminal
        ? `// Read-only file system with a scratch /tmp; the program runs as an unprivileged user.`
        : `// Chromium needs more shared memory than a container gets by default.`,
      `const EXTRA_FLAGS: string[] = ${JSON.stringify(terminal ? ['--read-only', '--tmpfs', '/tmp'] : ['--shm-size', '512m'])};`,
      `const HOST_COMMAND: string[] | undefined = ${JSON.stringify(terminal ? set.startCommand : undefined)};`,
      ``,
      ...DOCKER_RUNTIME,
    ];
    return lines.join('\n') + '\n';
  }

  /**
   * Files needed to build the sandbox image, relative to the output directory:
   * the Dockerfile (to build with the output directory as context) and the
   * minimal package.json of what runs inside the container.
   */
  generateSandboxFiles(set: WorkflowSet, options: GenerateOptions = {}): { dockerfile: string; packageJson: string; dockerignore: string; copy: string[] } {
    this.assertTarget(set);
    const http = httpEnabled(set, options);

    const terminal = set.targetType === 'tui';
    const dependencies = terminal
      ? { 'node-pty': '^1.1.0', '@xterm/headless': '^6.0.0' }
      : { playwright: PLAYWRIGHT_VERSION };

    const copy = [
      'replay.js', 'screen-hash.js', 'settle.js', 'extract.js',
      ...(terminal
        ? ['pattern-wait.js']
        : ['row-resolver.js', 'step-plan.js', 'totp.js', 'vault-format.js', 'vault-reader.js', 'web-steps.js', 'browser-launch.js', ...(http ? ['http-replay.js'] : []), ...(healEnabled(set, options) ? ['heal'] : [])]),
    ];
    const dockerfile = renderDockerfile({ targetType: set.targetType, copy, sandbox: set.sandbox, playwrightVersion: PLAYWRIGHT_VERSION });
    return {
      dockerfile,
      copy,
      packageJson: JSON.stringify({ name: 'sandbox', private: true, type: 'module', dependencies }, null, 2),
      dockerignore: [
        '# Nothing that holds a login or a secret may reach the build context, so no image layer can contain it.',
        '# The saved login is mounted read-only when a call runs, never copied. The Dockerfile copies named files only.',
        'node_modules',
        'tests',
        '*.md',
        '# Workflow sets, state files, manifests (the image builds from sandbox/package.json)',
        '*.json',
        '!sandbox/package.json',
        '**/*.workflow*',
        '**/*storage*',
        '**/*state*',
        '**/.env*',
        '**/auth*',
        '**/.daemonize',
        '**/*.assets',
        '',
      ].join('\n'),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertTarget(set: WorkflowSet): void {
    if (set.targetType === 'web' && !set.startUrl) {
      throw new Error('A web target needs a startUrl');
    }
    if (set.targetType === 'tui' && (!set.startCommand || set.startCommand.length === 0)) {
      throw new Error('A terminal target needs a startCommand');
    }
  }

  private generateToolBlock(
    set: WorkflowSet,
    workflow: Workflow,
    toolNames: Map<string, string>,
    http: boolean
  ): string {
    const toolName = toolNames.get(workflow.id) ?? workflow.id;
    const description = `${describeTool(workflow, { http })}\n\nOptional reserved argument _timeoutMs (integer, 1 to 600000): timeout in milliseconds of the whole call; it is not part of the payload.`;
    const zodSchema = this.buildZodSchema(workflow);

    const lines: string[] = [
      `// Tool: ${toolName} (from workflow: ${JSON.stringify(workflow.label)})`,
      `server.tool(`,
      `  ${JSON.stringify(toolName)},`,
      `  ${JSON.stringify(description)},`,
      `  {`,
    ];

    for (const propLine of zodSchema) {
      lines.push(`    ${propLine}`);
    }

    lines.push(
      `    // Reserved: the timeout of this call. Never part of the inferred payload schema.`,
      `    "_timeoutMs": z.number().int().min(1).max(600000).optional(),`,
      `  },`,
      `  async ({ _timeoutMs, ...args }) => {`,
      `    // The payload is validated against the full inferred schema before any replay.`,
      `    const errors = validatePayload(${JSON.stringify(toolName)}, args);`,
      `    if (errors !== null) {`,
      `      return {`,
      `        content: [{ type: "text", text: JSON.stringify(withMode({ success: false, error: "validation", errors })) }],`,
      `        isError: true`,
      `      };`,
      `    }`,
      `    const result = await runReplay(${JSON.stringify(workflow.steps)}, args, ${JSON.stringify(this.finalOf(workflow))}, { callMs: _timeoutMs, workflowMs: ${JSON.stringify(workflow.timeoutMs)}, setMs: ${JSON.stringify(set.timeoutMs)} });`,
      `    return {`,
      `      content: [{ type: "text", text: JSON.stringify(withMode(result)) }],`,
      `      isError: !result.success`,
      `    };`,
      `  }`,
      `);`
    );

    return lines.join('\n');
  }

  /** The recorded final screen of a workflow (and its zone), embedded for the drift check. */
  private finalOf(workflow: Workflow): {
    finalScreenId?: string;
    finalZone?: Workflow['finalZone'];
    resultZone?: Omit<ResultZone, 'schema'>;
    workflowId?: string;
    cols?: number;
    rows?: number;
  } {
    const final: {
      finalScreenId?: string;
      finalZone?: Workflow['finalZone'];
      resultZone?: Omit<ResultZone, 'schema'>;
      workflowId?: string;
      cols?: number;
      rows?: number;
    } = { workflowId: workflow.id };
    if (workflow.cols !== undefined) final.cols = workflow.cols;
    if (workflow.rows !== undefined) final.rows = workflow.rows;
    if (workflow.finalScreenId !== undefined) final.finalScreenId = workflow.finalScreenId;
    if (workflow.finalZone !== undefined) final.finalZone = workflow.finalZone;
    // The schema of `data` is documentation (OpenAPI), not needed to extract
    const resultZone = pickResultZone(workflow);
    if (resultZone !== undefined) {
      const { schema: _schema, ...extraction } = resultZone;
      final.resultZone = extraction;
    }
    return final;
  }

  /** Input schema of each tool, keyed by tool name. */
  private collectInputSchemas(
    set: WorkflowSet,
    toolNames: Map<string, string>
  ): Record<string, unknown> {
    const schemas: Record<string, unknown> = {};
    for (const workflow of set.workflows) {
      schemas[toolNames.get(workflow.id) ?? workflow.id] = workflow.inputSchema ?? { type: 'object' };
    }
    return schemas;
  }

  /**
   * Convert the JSON Schema properties of a Workflow's inputSchema into an
   * array of "propName: z.xxx()," lines suitable for embedding in an object
   * literal.
   */
  private buildZodSchema(workflow: Workflow): string[] {
    const schema = workflow.inputSchema;
    if (!schema) {
      return [];
    }

    const properties = schema['properties'];
    if (!properties || typeof properties !== 'object') {
      return [];
    }

    const required: string[] = Array.isArray(schema['required'])
      ? (schema['required'] as string[])
      : [];

    const lines: string[] = [];

    for (const [propName, propSchema] of Object.entries(
      properties as Record<string, unknown>
    )) {
      // Recursive translation; optional unless required, then described
      const zodExpr = propertyToZodSource(propSchema, required.includes(propName), `#/properties/${propName}`).source;

      lines.push(`${JSON.stringify(propName)}: ${zodExpr},`);
    }

    return lines;
  }
}
