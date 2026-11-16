import type { Page } from 'playwright';
import { CAPTURE_SCRIPT } from './capture-script.js';
import { buildSelectors, type ElementInfo } from './selector-builder.js';
import type { WorkflowRecorder } from './workflow-recorder.js';
import type { RecordedAction, WorkflowVariable } from '../types.js';

/** Event sent by the capture script running inside the page. */
export interface CapturedEvent {
  actionType: RecordedAction['actionType'];
  info: ElementInfo;
  value?: string;
  label?: string;
}

/** Request sent by the "Make variable" box shown in the page. */
export interface MarkVariableRequest {
  stepIndex: number;
  name: string;
}

export type MarkVariableResult = { ok: true } | { ok: false; error: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Connects a Playwright page to a WorkflowRecorder: every click, typed value,
 * selection or Enter press the user performs in the page becomes a step, and
 * the user can turn typed or selected values into variables from the page.
 *
 * A page can be attached to one LiveRecorder only.
 */
export class LiveRecorder {
  private steps = 0;
  private attached = false;
  private readonly fieldNames = new Map<number, string>();

  constructor(
    private readonly page: Page,
    private readonly recorder: WorkflowRecorder,
  ) {}

  /** Number of steps recorded so far. */
  get stepCount(): number {
    return this.steps;
  }

  /** Start capturing in the current page and in every page it navigates to. */
  async attach(): Promise<void> {
    if (this.attached) {
      throw new Error('This LiveRecorder is already attached to its page');
    }

    try {
      await this.page.exposeFunction('__daemonizeRecord', (event: CapturedEvent) =>
        this.handle(event)
      );
      await this.page.exposeFunction('__daemonizeMarkVariable', (request: MarkVariableRequest) =>
        this.handleMarkVariable(request)
      );
    } catch (err) {
      if ((err as Error).message.includes('already registered')) {
        throw new Error('This page already has a LiveRecorder attached');
      }
      throw err;
    }

    await this.page.addInitScript(CAPTURE_SCRIPT);
    await this.page.evaluate(CAPTURE_SCRIPT);
    this.attached = true;
  }

  /** Turn one captured event into a recorded step. Returns its index, or null when ignored. */
  handle(event: CapturedEvent): number | null {
    const selectors = buildSelectors(event.info);
    if (selectors.length === 0) {
      return null;
    }

    const index = this.recorder.addStep({
      actionType: event.actionType,
      selectors,
      value: event.value,
      label: event.label,
    });
    this.steps += 1;

    const fieldName = event.info.name ?? event.info.nameAttr ?? event.info.id;
    if (fieldName !== undefined) {
      this.fieldNames.set(index, fieldName);
    }
    return index;
  }

  /** Mark the value typed or selected in a recorded step as a variable. */
  markVariable(stepIndex: number, variable: WorkflowVariable): void {
    this.recorder.markVariable(stepIndex, variable);
  }

  /** Handle a variable named by the user in the page; never throws. */
  handleMarkVariable(request: MarkVariableRequest): MarkVariableResult {
    if (!VARIABLE_NAME.test(request.name)) {
      return { ok: false, error: 'Use letters, digits and underscores, not starting with a digit' };
    }

    const variable: WorkflowVariable = { name: request.name };
    const description = this.fieldNames.get(request.stepIndex);
    if (description !== undefined) {
      variable.description = description;
    }

    try {
      this.recorder.markVariable(request.stepIndex, variable);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
