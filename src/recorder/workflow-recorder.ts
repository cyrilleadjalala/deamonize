import { randomUUID } from 'node:crypto';
import { ScreenHasher } from '../state/screen-hasher.js';
import type {
  RecordedAction,
  ScreenContent,
  FinalZone,
  Workflow,
  WorkflowStep,
  WorkflowVariable,
} from '../types.js';

export interface RecordedStep {
  actionType: RecordedAction['actionType'];
  selectors: string[];
  value?: string;
  label?: string;
}

/**
 * Records one Workflow: the ordered steps the user performs from the known
 * start state, the fields the user marks as variable, and the final screen.
 */
export class WorkflowRecorder {
  private readonly hasher = new ScreenHasher();
  private readonly steps: WorkflowStep[] = [];
  private readonly variables = new Map<string, WorkflowVariable>();
  private readonly payload: Record<string, unknown> = {};

  constructor(private readonly label: string) { }

  /** Append a step performed by the user. Returns its index. */
  addStep(step: RecordedStep): number {
    const recorded: WorkflowStep = {
      actionType: step.actionType,
      selectors: [...step.selectors],
    };
    if (step.value !== undefined) {
      recorded.value = step.value;
    }
    if (step.label !== undefined) {
      recorded.label = step.label;
    }
    this.steps.push(recorded);
    return this.steps.length - 1;
  }

  /**
   * Mark the value of a step as a variable. The typed value becomes the first
   * observed payload so the input schema can be inferred from it.
   */
  markVariable(
    stepIndex: number,
    variable: WorkflowVariable,
  ): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    if (step.value === undefined) {
      throw new Error(`Step ${stepIndex} has no value to turn into a variable`);
    }
    if (step.variable !== undefined) {
      throw new Error(`Step ${stepIndex} is already the variable "${step.variable}"`);
    }
    if (this.variables.has(variable.name)) {
      throw new Error(`Variable "${variable.name}" is already defined`);
    }

    this.variables.set(variable.name, variable);
    this.payload[variable.name] = coerce(step.value, variable.type);
    step.variable = variable.name;
  }

  /** Finish the recording with the screen the user ended on. */
  finish(finalScreen?: ScreenContent, finalZone?: FinalZone): Workflow {
    if (this.steps.length === 0) {
      throw new Error('Cannot finish a workflow without steps');
    }

    const workflow: Workflow = {
      id: randomUUID(),
      label: this.label,
      steps: this.steps.map((s) => ({ ...s, selectors: [...s.selectors] })),
      variables: [...this.variables.values()],
      observedPayloads: Object.keys(this.payload).length > 0 ? [{ ...this.payload }] : [],
    };
    if (finalScreen !== undefined) {
      // With a zone, the caller passes the zone's content (web: outerHTML of the element;
      // terminal: the cropped text), hashed here exactly like at run time.
      workflow.finalScreenId = this.hasher.computeId(finalScreen);
      if (finalZone !== undefined) {
        workflow.finalZone = structuredClone(finalZone);
      }
    }
    return workflow;
  }
}

function coerce(value: string, type: WorkflowVariable['type']): unknown {
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === 'boolean') {
    return value === 'true';
  }
  return value;
}
