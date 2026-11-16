import type { SandboxDriver } from '../sandbox/driver.js';
import { ScreenHasher } from '../state/screen-hasher.js';
import { cropTerminal } from '../replay/runtime/screen-hash.js';
import { extractResult } from './result-extractor.js';
import {
  boundText,
  extractTerminalZone,
  pickResultZone,
  zoneFailure,
  zoneFailureResult,
  type ZoneOutcome,
} from '../replay/runtime/extract.js';
import { resolveTimeoutMs } from '../replay/runtime/settle.js';
import { PatternTimeoutError, patternTimeoutResult } from '../replay/runtime/pattern-wait.js';
import {
  StepExecutionError,
  describeFailure,
  failureResult,
  runStepsStrict,
  type StrictOutcome,
} from '../replay/runtime/step-plan.js';
import { saveFailureScreenshot, type FailureShot } from '../replay/runtime/web-steps.js';
import type {
  Workflow,
  WorkflowStep,
  RecordedAction,
  ScreenContent,
  ReplayResult,
  ResultZone,
} from '../types.js';



/** Creates a brand-new sandbox, already positioned on the workflow's start state. */
export type DriverFactory = (size?: { cols: number; rows: number }) => SandboxDriver;

export class Replayer {
  private readonly hasher = new ScreenHasher();

  /** setTimeoutMs is the WorkflowSet.timeoutMs, the last source of the whole-replay timeout. */
  constructor(
    private readonly createDriver: DriverFactory,
    private readonly options: { setTimeoutMs?: number } = {},
  ) { }

  /**
   * Replay a workflow from scratch: every call gets a fresh sandbox, so no
   * state is carried over from a previous call and no recovery is needed
   * after a failure.
   */
  async replay(
    workflow: Workflow,
    payload: Record<string, unknown>,
    callTimeoutMs?: number,
  ): Promise<ReplayResult> {
    // Order: the call, DAEMONIZE_TIMEOUT_MS, the workflow, the set, 30 s
    const timeoutMs = resolveTimeoutMs({
      call: callTimeoutMs,
      env: process.env.DAEMONIZE_TIMEOUT_MS,
      workflow: workflow.timeoutMs,
      set: this.options.setTimeoutMs,
    });
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;

    let driver: SandboxDriver;
    try {
      // A terminal workflow replays at the size it was recorded at (DAEMONIZE_COLS/ROWS override it)
      driver = this.createDriver(terminalSizeFor(workflow));
      await driver.start();
    } catch {
      return { success: false, error: 'sandbox_unavailable', elapsedMs: elapsed() };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const outcome = await Promise.race([
        this.runSteps(driver, workflow, payload, () => timeoutMs - elapsed()),
        timeout,
      ]);

      // Strict mode: the first step no locator could perform ends the replay; no later step ran
      if (outcome !== 'timeout' && 'failed' in outcome) {
        const { stepIndex, step, tried, reason, cause } = outcome.failed as Extract<StrictOutcome, { ok: false }>;
        if (cause instanceof PatternTimeoutError) {
          return patternTimeoutResult(
            { stepIndex, wait: cause.wait, elapsedMs: cause.elapsedMs, screenExcerpt: cause.screenExcerpt },
            elapsed(),
          );
        }
        const shot = await this.captureFailure(driver, stepIndex);
        const failure = describeFailure({ stepIndex, step, tried, reason, screenshot: shot.screenshot, thumbnail: shot.thumbnail });
        return { ...failureResult(failure, elapsed()) };
      }

      if (outcome === 'timeout') {
        console.warn(
          `[Replayer] timeout: ${JSON.stringify({
            actionId: workflow.id,
            payload,
            elapsedMs: elapsed(),
          })}`
        );
        return { success: false, error: 'timeout', elapsedMs: elapsed() };
      }

      const whole = extractResult(outcome.screen);
      const zone = pickResultZone(workflow);
      let content = whole;
      if (zone !== undefined) {
        // The structured data of the zone replaces the whole screen; a zone that cannot be read is a strict failure
        const read = await this.readZone(driver, outcome.screen, zone);
        if (!read.ok) {
          return { ...zoneFailureResult(read, elapsed()) };
        }
        content = {
          ...whole,
          text: boundText(read.text),
          data: typeof read.data === 'string' ? boundText(read.data) : read.data,
        };
      }
      const result: ReplayResult = {
        success: true,
        screen: outcome.screen,
        result: content,
        elapsedMs: elapsed(),
      };
      if (workflow.finalScreenId !== undefined) {
        // A terminal zone is cropped like at recording time; a web zone needs a browser
        // and is only judged by the generated server.
        const rect = workflow.finalZone?.rect;
        const compared: ScreenContent =
          outcome.screen.type === 'terminal' && rect !== undefined
            ? { ...outcome.screen, raw: cropTerminal(outcome.screen.raw, rect) }
            : outcome.screen;
        result.drifted = this.hasher.computeId(compared) !== workflow.finalScreenId;
      }
      if (outcome.screen.type === 'terminal' && driver.terminalSize !== undefined) {
        const used = driver.terminalSize;
        result.terminalSize = used;
        // A screen rendered at another size than the recorded one is never judged equal
        if (workflow.finalScreenId !== undefined && workflow.cols !== undefined && workflow.rows !== undefined
          && (used.cols !== workflow.cols || used.rows !== workflow.rows)) {
          result.drifted = true;
          result.driftReason = `terminal size: recorded ${workflow.cols}x${workflow.rows}, replayed at ${used.cols}x${used.rows}`;
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message, elapsedMs: elapsed() };
    } finally {
      clearTimeout(timer);
      await driver.stop().catch(() => {
        // Best-effort cleanup; the next call starts a fresh sandbox anyway.
      });
    }
  }

  private async runSteps(
    driver: SandboxDriver,
    workflow: Workflow,
    payload: Record<string, unknown>,
    budgetMs?: () => number,
  ): Promise<{ screen: ScreenContent } | { failed: StrictOutcome }> {
    let screen = await driver.captureScreen();
    const outcome = await runStepsStrict(workflow.steps, async (step) => {
      screen = await this.runStep(driver, step, payload, budgetMs);
    });
    return outcome.ok ? { screen } : { failed: outcome };
  }

  private async readZone(driver: SandboxDriver, screen: ScreenContent, zone: ResultZone): Promise<ZoneOutcome> {
    if (screen.type === 'terminal') return extractTerminalZone(screen.raw, zone);
    if (driver.extractZone === undefined) {
      return zoneFailure('result_extraction_failed', 'This driver cannot read a result zone of a web page', zone);
    }
    return driver.extractZone(zone);
  }

  /** The picture of the sandbox at the time of a failure, when the driver can take one. */
  private async captureFailure(driver: SandboxDriver, stepIndex: number): Promise<FailureShot> {
    if (driver.screenshot === undefined) return {};
    try {
      return saveFailureScreenshot(await driver.screenshot(), stepIndex);
    } catch {
      return {};
    }
  }

  /**
   * Try each candidate selector in order; the first one that works wins. A write or
   * delete step is never retried with another selector: the first action may have started.
   */
  private async runStep(
    driver: SandboxDriver,
    step: WorkflowStep,
    payload: Record<string, unknown>,
    budgetMs?: () => number,
  ): Promise<ScreenContent> {
    const value = resolveValue(step, payload);
    let lastError: unknown;

    const candidates = step.selectors.length > 0 ? step.selectors : [undefined];
    for (const selector of candidates) {
      // hover, scrollIntoView and switch_page are replayed by the generated web runtime (17.6); this driver rejects them
      const action: RecordedAction = { actionType: step.actionType as RecordedAction['actionType'] };
      if (step.timeoutMs !== undefined) {
        action.timeoutMs = step.timeoutMs;
      }
      if (step.waitFor !== undefined) {
        action.waitFor = step.waitFor;
        if (budgetMs !== undefined) action.waitBudgetMs = Math.max(1, budgetMs());
      }
      if (selector !== undefined) {
        action.selector = selector;
      }
      if (value !== undefined) {
        action.value = value;
      }
      try {
        return await driver.execute(action);
      } catch (err) {
        // The pattern did not show up: strict, the replay stops here with its own diagnostic
        if (err instanceof PatternTimeoutError) throw err;
        lastError = err;
        if ((step.risk ?? 'read') !== 'read') break;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : 'No selector matched for step';
    throw new StepExecutionError(step.selectors, reason);
  }
}

/** The size to replay a terminal workflow at: the environment, else the recorded size; undefined when neither (the driver then uses 80x24). */
export function terminalSizeFor(workflow: Workflow): { cols: number; rows: number } | undefined {
  const fromEnv = (name: string, min: number, max: number): number | undefined => {
    const text = process.env[name]?.trim();
    if (text === undefined || !/^[0-9]+$/.test(text)) return undefined;
    const n = Number(text);
    return n >= min && n <= max ? n : undefined;
  };
  const cols = fromEnv('DAEMONIZE_COLS', 20, 500) ?? workflow.cols;
  const rows = fromEnv('DAEMONIZE_ROWS', 5, 200) ?? workflow.rows;
  if (cols === undefined && rows === undefined) return undefined;
  return { cols: cols ?? 80, rows: rows ?? 24 };
}

function resolveValue(step: WorkflowStep, payload: Record<string, unknown>): string | undefined {
  if (step.variable !== undefined) {
    const supplied = payload[step.variable];
    return supplied === undefined || supplied === null ? step.value : String(supplied);
  }
  return step.value;
}