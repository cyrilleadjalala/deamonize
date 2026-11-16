import { createInterface } from 'node:readline/promises';
import { chromium, type Page } from 'playwright';
import { LiveRecorder, type NetworkStepReport } from '../../recorder/live-recorder.js';
import { WorkflowRecorder } from '../../recorder/workflow-recorder.js';
import { saveWorkflow } from './save-workflow.js';
import { extractWebZone } from '../../replay/runtime/web-steps.js';
import { dataSchemaFor } from '../../schema/data-schema.js';
import type { ExtractorKind, ResultZone, ScreenContent, Workflow } from '../../types.js';

export interface RecordOptions {
  url: string;
  name: string;                 // target application name
  label: string;                // label of the recorded workflow (becomes the tool name)
  out: string;                  // Workflow set file; created, or merged into when it exists
  storageState?: string;        // Playwright storage state: start the recording already logged in
  headless?: boolean;           // default false: the user needs to see the browser
  finalZone?: string;           // CSS selector: drift is judged on this part of the final page only
  resultZone?: string;          // selector of the element whose content the tool returns (instead of the whole page)
  resultKind?: ExtractorKind;   // how to read it: text, table, list, fields, json, attribute (default: suggested from the element)
  captureNetwork?: boolean;     // observe fetch/XHR to record Level 1 recipes (default true)
  /**
   * Replaces the wait for the user (Enter key or closing the window).
   * The session ends when it resolves; used to drive the page from tests.
   */
  drive?: (page: Page, live: LiveRecorder) => Promise<void>;
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
  /** The Result_Zone stored with the workflow, when there is one. */
  resultZone?: { selector?: string; rect?: { row: number; col: number; rows: number; cols: number }; kind: string };
}

/**
 * Record one workflow in a browser the user drives, then add it to the
 * Workflow set file (created when missing, merged when it already exists).
 */
export async function record(options: RecordOptions): Promise<RecordSummary> {
  const browser = await chromium.launch({
    headless: options.headless ?? false,
    executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
  });

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
  const target = { targetType: 'web' as const, name: options.name, startUrl: options.url, storageState: options.storageState };

  try {
    const context = await browser.newContext(
      options.storageState ? { storageState: options.storageState } : {}
    );
    const page = await context.newPage();
    page.on('crash', () => signalStopped('the page crashed'));
    await page.goto(options.url);

    recorder = new WorkflowRecorder(options.label);
    live = new LiveRecorder(page, recorder, { captureNetwork: options.captureNetwork ?? true });
    await live.attach();

    // Popups and new tabs get the same capture; each opening is recorded as a switch_page step
    context.on('page', (opened) => {
      if (opened === page) return;
      live!.attachPopup(opened).catch((err) => {
        console.error(`[record] could not record the new page: ${(err as Error).message}`);
      });
    });

    const session = options.drive ? options.drive(page, live) : waitForUser(page);
    await Promise.race([session, stopped]);

    // The final screen is only available while the window is still open
    const finalScreen = page.isClosed() ? undefined : await captureFinalScreen(page, options.finalZone);
    // The zone given on the command line, else the one marked in the page
    const marked: ResultZone | undefined = options.resultZone !== undefined
      ? { selector: options.resultZone, ...(options.resultKind === undefined ? {} : { extractor: { kind: options.resultKind } as ResultZone['extractor'] }) }
      : live.resultZone;
    const resultZone = marked === undefined ? undefined : await readResultZone(page, marked);
    const network = await live.finalizeNetwork();
    const workflow = recorder.finish(
      finalScreen,
      options.finalZone !== undefined ? { selector: options.finalZone } : undefined,
      resultZone
    );

    const totalWorkflows = await saveWorkflow(options.out, target, workflow);

    return {
      out: options.out,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      variables: workflow.variables.map((v) => v.name),
      totalWorkflows,
      network,
      ...secretSummary(workflow),
      ...(workflow.resultZone === undefined
        ? {}
        : { resultZone: { selector: workflow.resultZone.selector, kind: workflow.resultZone.extractor?.kind ?? 'text' } }),
    };
  } catch (err) {
    if (closing || !(err instanceof BrowserStoppedError)) {
      throw err;
    }
    throw await interrupted((err as Error).message, options.out, target, recorder, live);
  } finally {
    closing = true;
    await browser.close().catch(() => { });
  }
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

/**
 * The browser stopped while recording: say so, and keep what was recorded in a
 * recovery file next to the workflow file, which is itself a valid workflow file.
 */
async function interrupted(
  reason: string,
  out: string,
  target: Parameters<typeof saveWorkflow>[1],
  recorder: WorkflowRecorder | undefined,
  live: LiveRecorder | undefined
): Promise<Error> {
  console.error(`[record] ${reason} before the recording was finished`);

  if (recorder === undefined || live === undefined || live.stepCount === 0) {
    return new Error(`Recording interrupted: ${reason}. Nothing had been recorded yet.`);
  }

  const recoveryFile = `${out}.recovery.json`;
  await saveWorkflow(recoveryFile, target, recorder.finish());
  return new Error(
    `Recording interrupted: ${reason}. The ${live.stepCount} step(s) recorded so far were saved to ${recoveryFile}.`
  );
}

async function waitForUser(page: Page): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const windowClosed = new Promise<void>((resolve) => page.once('close', () => resolve()));
  try {
    await Promise.race([
      rl.question('Use the browser window, then press Enter here to finish (or close the window): '),
      windowClosed,
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
