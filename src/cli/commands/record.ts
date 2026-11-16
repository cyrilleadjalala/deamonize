import { createInterface } from 'node:readline/promises';
import { chromium, type Page } from 'playwright';
import { LiveRecorder } from '../../recorder/live-recorder.js';
import { WorkflowRecorder } from '../../recorder/workflow-recorder.js';
import { saveWorkflow } from './save-workflow.js';
import type { ScreenContent } from '../../types.js';

export interface RecordOptions {
  url: string;
  name: string;                 // target application name
  label: string;                // label of the recorded workflow (becomes the tool name)
  out: string;                  // Workflow set file; created, or merged into when it exists
  storageState?: string;        // Playwright storage state: start the recording already logged in
  headless?: boolean;           // default false: the user needs to see the browser
  finalZone?: string;           // CSS selector: drift is judged on this part of the final page only
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
    live = new LiveRecorder(page, recorder);
    await live.attach();

    const session = options.drive ? options.drive(page, live) : waitForUser(page);
    await Promise.race([session, stopped]);

    // The final screen is only available while the window is still open
    const finalScreen = page.isClosed() ? undefined : await captureFinalScreen(page, options.finalZone);
    const workflow = recorder.finish(
      finalScreen,
      options.finalZone !== undefined ? { selector: options.finalZone } : undefined
    );

    const totalWorkflows = await saveWorkflow(options.out, target, workflow);

    return {
      out: options.out,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      variables: workflow.variables.map((v) => v.name),
      totalWorkflows,
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
