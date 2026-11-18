import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { launchBrowser, type LaunchFn } from '../../recorder/browser-launcher.js';
import { LiveRecorder, type EndReason, type NetworkStepReport } from '../../recorder/live-recorder.js';
import { WorkflowRecorder } from '../../recorder/workflow-recorder.js';
import { saveWorkflow } from './save-workflow.js';
import { deserializeWorkflowSet } from '../../workflow/workflow-set.js';
import { checkSameOrigin } from '../../workflow/origin-guard.js';
import { LOAD_UNREADABLE } from '../../studio/messages/common.js';
import type { SandboxSpec } from '../../types.js';
import { extractWebZone } from '../../replay/runtime/web-steps.js';
import { dataSchemaFor } from '../../schema/data-schema.js';
import type { ExtractorKind, ResultZone, ScreenContent, Workflow } from '../../types.js';

export interface RecordOptions {
  url: string;
  name: string;                 // target application name
  label: string;                // label of the recorded workflow (becomes the tool name)
  out: string;                  // Workflow set file; created, or merged into when it exists
  storageState?: string;        // Playwright storage state: start the recording already logged in
  sandbox?: SandboxSpec;        // --sandbox-* flags: stored in the sandbox block of the file
  headless?: boolean;           // default false: the user needs to see the browser
  finalZone?: string;           // CSS selector: drift is judged on this part of the final page only
  resultZone?: string;          // selector of the element whose content the tool returns (instead of the whole page)
  resultKind?: ExtractorKind;   // how to read it: text, table, list, fields, json, attribute (default: suggested from the element)
  captureNetwork?: boolean;     // observe fetch/XHR to record Level 1 recipes (default true)
  visual?: boolean;             // capture Visual_Anchors: rect, intent and a thumbnail per step (default true; false = none at all)
  /**
   * Replaces the wait for the user (Enter key or closing the window).
   * The session ends when it resolves; used to drive the page from tests.
   */
  drive?: (page: Page, live: LiveRecorder) => Promise<void>;
  /**
   * Ends the session like the "Finish and save" button of the panel (`LiveRecorder.requestEnd('signal')`), while the
   * page is still open. A Studio-driven recording uses it, or calls `live.requestEnd('api')` from `drive`.
   */
  signal?: AbortSignal;
  /** Test seam of the Browser_Launcher: replaces chromium.launch. */
  launch?: LaunchFn;
  /**
   * Path of a Playwright storage state used only to start the browser context (a persistent session). It is never copied
   * into the Workflow_File or the recovery file, unlike storageState.
   */
  sessionStorageState?: string;
  /** After a successful save and before the browser closes, receives context.storageState(); it stays in memory. */
  captureSessionState?: (state: unknown) => void | Promise<void>;
  /** terminal (default) waits for Enter or the window; studio never reads stdin and a closed window takes the recovery path. */
  windowMode?: 'terminal' | 'studio';
  /** Called right after the live recorder is attached. */
  onLive?: (live: LiveRecorder) => void;
  /** True when ~/.kiro exists now; passed to the Live_Recorder for the install scope choice of the panel. */
  kiroHomeExists?: boolean;
  /** Called with the launched browser. */
  onBrowser?: (browser: Browser) => void;
  /** Called when the session ends, before the end of the recording is completed. */
  onEnding?: (reason: EndReason | 'closed') => void;
}

export interface RecordSummary {
  out: string;
  workflowId: string;
  steps: number;
  variables: string[];
  totalWorkflows: number;
  /** Secrets the replay will need: the environment variable to set for each (names only). */
  secrets: Array<{ name: string; envVariable: string; totp: boolean }>;
  /** Typed values that are neither a Variable nor a Secret_Reference: stored as typed. */
  constantTypedValues: number;
  /** Per step, the replay level that can be used (empty when the network capture is off). */
  network?: NetworkStepReport[];
  /** Thumbnails saved next to the workflow file (in `<out>.assets/`). */
  thumbnails: number;
  /** The Result_Zone stored with the workflow, when there is one. */
  resultZone?: { selector?: string; rect?: { row: number; col: number; rows: number; cols: number }; kind: string };
  /** Present only when captureSessionState was given: whether the session state was captured. */
  sessionCaptured?: boolean;
}

/**
 * Record one workflow in a browser the user drives, then add it to the
 * Workflow set file (created when missing, merged when it already exists).
 */
export async function record(options: RecordOptions): Promise<RecordSummary> {
  // One file holds one application: refuse another origin before any browser opens
  await preflightOrigin(options);
  // A launcher failure propagates here, before anything is written
  const { browser } = await launchBrowser({ headless: options.headless ?? false, launch: options.launch });
  options.onBrowser?.(browser);

  // The browser going away on its own (crash, killed) is not the user ending the session
  let closing = false;
  let signalStopped: (reason: string) => void = () => { };
  const stopped = new Promise<never>((_, reject) => {
    signalStopped = (reason) => {
      if (!closing) {
        reject(new BrowserStoppedError(reason));
      }
    };
  });
  stopped.catch(() => { });
  browser.on('disconnected', () => signalStopped('the browser exited'));

  let recorder: WorkflowRecorder | undefined;
  let live: LiveRecorder | undefined;
  const target = { targetType: 'web' as const, name: options.name, startUrl: options.url, storageState: options.storageState, sandbox: options.sandbox };
  let ending = false;
  const notifyEnding = (reason: EndReason | 'closed'): void => {
    if (ending) return;
    ending = true;
    try { options.onEnding?.(reason); } catch { /* a hook never breaks the recording */ }
  };

  try {
    const context = await browser.newContext(
      options.sessionStorageState ? { storageState: options.sessionStorageState } : options.storageState ? { storageState: options.storageState } : {}
    );
    const page = await context.newPage();
    page.on('crash', () => signalStopped('the page crashed'));
    await page.goto(options.url);

    recorder = new WorkflowRecorder(options.label);
    live = new LiveRecorder(page, recorder, {
      captureNetwork: options.captureNetwork ?? true,
      ...(options.windowMode === 'studio' ? { studio: true } : {}),
      ...(options.kiroHomeExists === undefined ? {} : { kiroHomeExists: options.kiroHomeExists }),
      ...(options.visual === false ? {} : { visual: { workflowFile: options.out } }),
    });
    await live.attach();
    options.onLive?.(live);

    // Popups and new tabs get the same capture; each opening is recorded as a switch_page step
    context.on('page', (opened) => {
      if (opened === page) return;
      live!.attachPopup(opened).catch((err) => {
        console.error(`[record] could not record the new page: ${(err as Error).message}`);
      });
    });

    // A Node-side stop (a Studio-driven recording, a signal) takes the same end path as the panel button
    const stop = (): void => live!.requestEnd('signal');
    if (options.signal?.aborted === true) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });

    if (options.windowMode === 'studio') page.on('close', () => signalStopped('the browser window was closed'));
    const session: Promise<void> = options.drive
      ? options.drive(page, live)
      : options.windowMode === 'studio'
        ? new Promise<void>(() => { })
        : waitForUser(page, live.ended);
    const reason = await Promise.race([
      session.then((): EndReason | 'closed' => (options.drive ? 'api' : 'closed')),
      stopped,
      live.ended,
    ]);
    notifyEnding(reason);

    const { workflow, totalWorkflows, network } = await completeRecording({ options, page, live, recorder, target });

    let sessionCaptured: boolean | undefined;
    if (options.captureSessionState !== undefined) {
      try {
        await options.captureSessionState(await context.storageState());
        sessionCaptured = true;
      } catch {
        sessionCaptured = false;
      }
    }

    return {
      out: options.out,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      variables: workflow.variables.map((v) => v.name),
      totalWorkflows,
      thumbnails: live.thumbnailCount,
      network,
      ...(sessionCaptured === undefined ? {} : { sessionCaptured }),
      ...secretSummary(workflow),
      ...(workflow.resultZone === undefined
        ? {}
        : { resultZone: { selector: workflow.resultZone.selector, kind: workflow.resultZone.extractor?.kind ?? 'text' } }),
    };
  } catch (err) {
    if (closing || !(err instanceof BrowserStoppedError)) {
      throw err;
    }
    notifyEnding('closed');
    throw await interrupted((err as Error).message, options, target, recorder, live);
  } finally {
    closing = true;
    await browser.close().catch(() => { });
  }
}

/**
 * Tolerant read of the Workflow_File before the browser: no file or no workflow proceeds; an unreadable or invalid
 * file or another origin throws, and nothing is launched or written.
 */
async function preflightOrigin(options: Pick<RecordOptions, 'out' | 'url'>): Promise<void> {
  let existing;
  try {
    existing = deserializeWorkflowSet(await readFile(options.out, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(LOAD_UNREADABLE);
  }
  const check = checkSameOrigin(existing, options.url);
  if (!check.ok) throw new Error(check.message);
}

/** What the replay needs in its environment, and the typed values that are stored as typed. */
function secretSummary(workflow: Workflow): Pick<RecordSummary, 'secrets' | 'constantTypedValues'> {
  const secrets = new Map<string, { name: string; envVariable: string; totp: boolean }>();
  for (const step of workflow.steps) {
    if (step.secretRef === undefined) continue;
    const known = secrets.get(step.secretRef);
    secrets.set(step.secretRef, {
      name: step.secretRef,
      envVariable: `DAEMONIZE_SECRET_${step.secretRef}`,
      totp: step.totp === true || known?.totp === true,
    });
  }
  const constantTypedValues = workflow.steps.filter(
    (s) => s.actionType === 'type' && s.value !== undefined && s.variable === undefined && s.secretRef === undefined
  ).length;
  return { secrets: [...secrets.values()], constantTypedValues };
}

/** The browser went away on its own while the user was recording. */
class BrowserStoppedError extends Error { }

/** The result zone to check: the one given on the command line, else the one marked in the page. */
function markedZoneOf(options: Pick<RecordOptions, 'resultZone' | 'resultKind'>, live: Pick<LiveRecorder, 'resultZone'>): ResultZone | undefined {
  return options.resultZone !== undefined
    ? { selector: options.resultZone, ...(options.resultKind === undefined ? {} : { extractor: { kind: options.resultKind } as ResultZone['extractor'] }) }
    : live.resultZone;
}

/** A result zone was marked, but the window was closed before it could be checked on the final page. */
class ZoneUnverifiedError extends Error { }

type RecordingTarget = Parameters<typeof saveWorkflow>[1];
const NETWORK_RESCUE_MS = 5000;

/** What `completeRecording` works on: everything the end of a session needs. */
export interface CompletionContext {
  options: Pick<RecordOptions, 'out' | 'finalZone' | 'resultZone' | 'resultKind'>;
  page: Page;
  live: Pick<LiveRecorder, 'idle' | 'finalizeNetwork' | 'resultZone' | 'stepCount'>;
  recorder: Pick<WorkflowRecorder, 'finish'>;
  target: RecordingTarget;
}

/** Stage overrides, for tests that force a stage to fail. */
export interface CompletionHooks {
  captureFinalScreen?: (page: Page, zone?: string) => Promise<ScreenContent>;
  readResultZone?: (page: Page, zone: ResultZone) => Promise<ResultZone>;
  finalizeNetwork?: (live: CompletionContext['live']) => Promise<NetworkStepReport[]>;
  saveWorkflow?: typeof saveWorkflow;
}

export interface Completion {
  workflow: Workflow;
  totalWorkflows: number;
  network: NetworkStepReport[];
}

/** What the end of a session has done so far, to rescue the steps when a stage fails. */
interface CompletionState {
  finalScreen?: ScreenContent;
  marked?: ResultZone;
  networkTried: boolean;
  workflow?: Workflow;
}

/**
 * Everything that follows the end of a session, in stages (idle, screen, zone, network, finish, save). A failure at
 * any stage, with at least one step recorded, writes `<out>.recovery.json` with the steps and the marked result zone
 * (unchecked) and throws an error that names the file and the cause. Nothing is written when no step was recorded.
 */
export async function completeRecording(context: CompletionContext, hooks: CompletionHooks = {}): Promise<Completion> {
  const { options, page, live, recorder, target } = context;
  const state: CompletionState = { networkTried: false };
  const doScreen = hooks.captureFinalScreen ?? captureFinalScreen;
  const doZone = hooks.readResultZone ?? readResultZone;
  const doNetwork = hooks.finalizeNetwork ?? ((l: CompletionContext['live']) => l.finalizeNetwork());
  const doSave = hooks.saveWorkflow ?? saveWorkflow;
  try {
    // Every reported event is recorded, and no thumbnail is being taken while the final screen is read
    await live.idle();
    // The final screen is only available while the window is still open
    state.finalScreen = page.isClosed() ? undefined : await doScreen(page, options.finalZone);
    state.marked = markedZoneOf(options, live);
    if (state.marked !== undefined && page.isClosed()) {
      throw new ZoneUnverifiedError(
        'the window was closed before the result zone could be checked (use "Finish and save" in the panel to avoid this)'
      );
    }
    const resultZone = state.marked === undefined ? undefined : await doZone(page, state.marked);
    state.networkTried = true;
    const network = await doNetwork(live);
    state.workflow = recorder.finish(
      state.finalScreen,
      options.finalZone !== undefined ? { selector: options.finalZone } : undefined,
      resultZone
    );
    const totalWorkflows = await doSave(options.out, target, state.workflow);
    return { workflow: state.workflow, totalWorkflows, network };
  } catch (err) {
    throw await rescue(err as Error, context, hooks, state);
  }
}

/**
 * Keep the steps recorded so far in `<out>.recovery.json` (itself a valid workflow file), or in the temp directory
 * when that cannot be written. Returns the error to throw: it names the file and the cause.
 */
async function rescue(err: Error, context: CompletionContext, hooks: CompletionHooks, state: CompletionState): Promise<Error> {
  const { options, live, recorder, target } = context;
  const stopped = err instanceof BrowserStoppedError;
  if (stopped) console.error(`[record] ${err.message} before the recording was finished`);

  if (live.stepCount === 0) {
    return stopped ? new Error(`Recording interrupted: ${err.message}. Nothing had been recorded yet.`) : err;
  }

  try {
    if (!state.networkTried) {
      state.networkTried = true;
      const finalize = hooks.finalizeNetwork ?? ((l: CompletionContext['live']) => l.finalizeNetwork());
      await withDeadline(finalize(live), NETWORK_RESCUE_MS).catch(() => undefined);
    }
    // The marked zone is kept as marked: the page is not there to check it
    state.marked ??= markedZoneOf(options, live);
    const workflow =
      state.workflow ??
      recorder.finish(state.finalScreen, options.finalZone !== undefined ? { selector: options.finalZone } : undefined, state.marked);

    const save = hooks.saveWorkflow ?? saveWorkflow;
    let file = `${options.out}.recovery.json`;
    try {
      await save(file, target, workflow);
    } catch {
      file = join(tmpdir(), `daemonize-recovery-${workflow.id}.json`);
      await writeFile(file, JSON.stringify(workflow, null, 2));
    }
    const kept = `The ${live.stepCount} step(s) recorded so far were saved to ${file}.`;
    return new Error(
      stopped ? `Recording interrupted: ${err.message}. ${kept}` : `Recording failed after the session ended: ${err.message}. ${kept}`,
      { cause: err }
    );
  } catch (failure) {
    return new Error(
      `Recording failed: ${err.message}. The ${live.stepCount} step(s) recorded so far could not be saved: ${(failure as Error).message}`,
      { cause: err }
    );
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * The browser stopped while recording: say so, and keep what was recorded in a
 * recovery file next to the workflow file, which is itself a valid workflow file.
 */
async function interrupted(
  reason: string,
  options: RecordOptions,
  target: RecordingTarget,
  recorder: WorkflowRecorder | undefined,
  live: LiveRecorder | undefined
): Promise<Error> {
  if (recorder === undefined || live === undefined) {
    console.error(`[record] ${reason} before the recording was finished`);
    return new Error(`Recording interrupted: ${reason}. Nothing had been recorded yet.`);
  }
  const context: CompletionContext = { options, page: undefined as unknown as Page, live, recorder, target };
  return rescue(new BrowserStoppedError(reason), context, {}, { networkTried: false });
}

async function waitForUser(page: Page, ended: Promise<unknown>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const windowClosed = new Promise<void>((resolve) => page.once('close', () => resolve()));
  try {
    await Promise.race([
      rl.question('Use the browser window, then click "Finish and save" in its panel or press Enter here (or close the window): '),
      windowClosed,
      ended,
    ]);
  } finally {
    rl.close();
  }
}

/**
 * Check a zone against the final page and complete it: the kind suggested from the element when none
 * was given, and the JSON Schema of `data` from what the zone returns now (names and types, never values).
 */
async function readResultZone(page: Page, zone: ResultZone): Promise<ResultZone> {
  if (page.isClosed()) {
    throw new Error('The result zone needs the browser window to be open when the recording ends, to check it');
  }
  let extractor = zone.extractor;
  if (extractor === undefined) {
    const kind = await page
      .locator(zone.selector as string)
      .first()
      .evaluate((el: Element) => (window as unknown as { __daemonizeHelpers: { suggestResultKind(el: Element): string } }).__daemonizeHelpers.suggestResultKind(el), undefined, { timeout: 5000 })
      .catch(() => {
        throw new Error(`The result zone "${zone.selector}" matches nothing on the final page`);
      });
    extractor = { kind } as ResultZone['extractor'];
  }
  const checked: ResultZone = { selector: zone.selector, extractor };
  const read = await extractWebZone(page, checked, 5000);
  if (!read.ok) {
    throw new Error(`The result zone "${zone.selector}" cannot be read on the final page: ${read.message}`);
  }
  checked.schema = dataSchemaFor(extractor, read.data);
  return checked;
}

async function captureFinalScreen(page: Page, zone?: string): Promise<ScreenContent> {
  // With a zone, only that element is kept: it is what the generated server hashes at run time
  const raw =
    zone === undefined
      ? await page.content()
      : await page.locator(zone).first().evaluate((el: Element) => el.outerHTML, { timeout: 5000 }).catch(() => {
        throw new Error(`The final zone "${zone}" matches nothing on the final page`);
      });
  return { type: 'dom', raw, normalized: raw, capturedAt: Date.now() };
}
