import type { SandboxDriver } from '../sandbox/driver.js';
import { ScreenHasher } from '../state/screen-hasher.js';
import { cropTerminal } from '../replay/runtime/screen-hash.js';
import { extractResult } from './result-extractor.js';
import type {
  Workflow,
  WorkflowStep,
  RecordedAction,
  ScreenContent,
  ReplayResult,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 10000;

/** Creates a brand-new sandbox, already positioned on the workflow's start state. */
export type DriverFactory = () => SandboxDriver;

export class Replayer {
  private readonly hasher = new ScreenHasher();

  constructor(private readonly createDriver: DriverFactory) { }

  /**
   * Replay a workflow from scratch: every call gets a fresh sandbox, so no
   * state is carried over from a previous call and no recovery is needed
   * after a failure.
   */
  async replay(
    workflow: Workflow,
    payload: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<ReplayResult> {
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;

    let driver: SandboxDriver;
    try {
      driver = this.createDriver();
      await driver.start();
    } catch {
      return { success: false, error: 'sandbox_unavailable', elapsedMs: elapsed() };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const outcome = await Promise.race([this.runSteps(driver, workflow, payload), timeout]);

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

      const result: ReplayResult = {
        success: true,
        screen: outcome,
        result: extractResult(outcome),
        elapsedMs: elapsed(),
      };
      if (workflow.finalScreenId !== undefined) {
        // A terminal zone is cropped like at recording time; a web zone needs a browser
        // and is only judged by the generated server.
        const rect = workflow.finalZone?.rect;
        const compared: ScreenContent =
          outcome.type === 'terminal' && rect !== undefined
            ? { ...outcome, raw: cropTerminal(outcome.raw, rect) }
            : outcome;
        result.drifted = this.hasher.computeId(compared) !== workflow.finalScreenId;
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
  ): Promise<ScreenContent> {
    let screen = await driver.captureScreen();
    for (const step of workflow.steps) {
      screen = await this.runStep(driver, step, payload);
    }
    return screen;
  }

  /** Try each candidate selector in order; the first one that works wins. */
  private async runStep(
    driver: SandboxDriver,
    step: WorkflowStep,
    payload: Record<string, unknown>,
  ): Promise<ScreenContent> {
    const value = resolveValue(step, payload);
    let lastError: unknown;

    const candidates = step.selectors.length > 0 ? step.selectors : [undefined];
    for (const selector of candidates) {
      const action: RecordedAction = { actionType: step.actionType };
      if (selector !== undefined) {
        action.selector = selector;
      }
      if (value !== undefined) {
        action.value = value;
      }
      try {
        return await driver.execute(action);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No selector matched for step');
  }
}

function resolveValue(step: WorkflowStep, payload: Record<string, unknown>): string | undefined {
  if (step.variable !== undefined) {
    const supplied = payload[step.variable];
    return supplied === undefined || supplied === null ? step.value : String(supplied);
  }
  return step.value;
}
