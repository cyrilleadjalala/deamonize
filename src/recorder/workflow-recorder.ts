import { randomUUID } from 'node:crypto';
import { ScreenHasher } from '../state/screen-hasher.js';
import type {
  Anchor,
  RowBinding,
  ScreenContent,
  SecretReference,
  FinalZone,
  HttpRecipe,
  ResultZone,
  ScreenWait,
  StepActionType,
  StepRisk,
  VisualAnchor,
  Workflow,
  WorkflowStep,
  WorkflowVariable,
} from '../types.js';

export interface RecordedStep {
  actionType: StepActionType;
  selectors: string[];
  value?: string;
  label?: string;
  anchor?: Anchor;
  rowBinding?: RowBinding;
  risk?: StepRisk;
  secretRef?: string;   // the value is a secret: only its name is recorded
  totp?: boolean;       // with secretRef: the secret is a base32 TOTP seed and the replay types the current code
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

  /** Known from the start: thumbnails are named after it while the recording runs. */
  readonly id = randomUUID();

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
    if (step.anchor !== undefined) {
      recorded.anchor = structuredClone(step.anchor);
    }
    if (step.rowBinding !== undefined) {
      recorded.rowBinding = structuredClone(step.rowBinding);
    }
    if (step.risk !== undefined) {
      recorded.risk = step.risk;
    }
    if (step.secretRef !== undefined) {
      // A secret step never carries a value
      recorded.secretRef = step.secretRef;
      if (step.totp === true) recorded.totp = true;
      delete recorded.value;
    }
    this.steps.push(recorded);
    return this.steps.length - 1;
  }

  /** Attach the Visual_Anchor captured for a step. */
  setVisual(stepIndex: number, visual: VisualAnchor): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    step.visual = structuredClone(visual);
  }

  /** Replace the anchor of a recorded step (the page title is only known after the page loaded). */
  setAnchor(stepIndex: number, anchor: Anchor): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    step.anchor = structuredClone(anchor);
  }

  /** Set (or with `undefined`, remove) the screen wait of a terminal step. */
  setWaitFor(stepIndex: number, wait: ScreenWait | undefined): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    if (wait === undefined) delete step.waitFor;
    else step.waitFor = structuredClone(wait);
  }

  /** A copy of the steps recorded so far. */
  stepsSoFar(): WorkflowStep[] {
    return this.steps.map((s) => structuredClone(s));
  }

  /**
   * Attach the Level 1 recipe observed for a step and raise its risk to that of the request
   * (GET read, POST/PUT/PATCH write, DELETE delete); the risk never goes down.
   */
  setHttp(stepIndex: number, recipe: HttpRecipe | undefined, requestRisk: StepRisk): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    if (recipe !== undefined) step.http = structuredClone(recipe);
    const order: StepRisk[] = ['read', 'write', 'delete'];
    if (order.indexOf(requestRisk) > order.indexOf(step.risk ?? 'read')) step.risk = requestRisk;
  }

  /** Values of the variables defined so far, as strings (to recognise them in a row). */
  variableValues(): Map<string, string> {
    return new Map(Object.entries(this.payload).map(([name, value]) => [name, String(value)]));
  }

  /** Define a variable from a text that is not the value of a step (a text selected in a row). */
  defineVariable(variable: WorkflowVariable, value: string): void {
    if (this.variables.has(variable.name)) {
      throw new Error(`Variable "${variable.name}" is already defined`);
    }
    this.variables.set(variable.name, variable);
    this.payload[variable.name] = coerce(value, variable.type);
  }

  /** Bind the row of a step to a variable that is already defined. */
  bindRow(stepIndex: number, variableName: string, keyText?: string): void {
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`No step at index ${stepIndex}`);
    }
    if (step.rowBinding === undefined) {
      throw new Error(`Step ${stepIndex} is not inside a row, a card or a list item`);
    }
    if (!this.variables.has(variableName)) {
      throw new Error(`Variable "${variableName}" is not defined`);
    }
    step.rowBinding.variable = variableName;
    if (keyText !== undefined) {
      // The recorded column only describes the recorded key text
      const column = step.rowBinding.key?.text === keyText ? step.rowBinding.key.column : undefined;
      step.rowBinding.key = column === undefined ? { text: keyText } : { text: keyText, column };
    }
    // The recorded text of the parent would bake the recorded row into the step
    if (step.anchor?.parent !== undefined && step.anchor.parent.kind === 'region') {
      delete step.anchor.parent;
    }
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
  finish(finalScreen?: ScreenContent, finalZone?: FinalZone, resultZone?: ResultZone): Workflow {
    if (this.steps.length === 0) {
      throw new Error('Cannot finish a workflow without steps');
    }

    const workflow: Workflow = {
      id: this.id,
      label: this.label,
      steps: this.steps.map((s) => structuredClone(s)),
      variables: [...this.variables.values()],
      observedPayloads: Object.keys(this.payload).length > 0 ? [{ ...this.payload }] : [],
    };
    // The names of the secrets the steps need (never values), so compile can list the variables to set
    const secrets = new Map<string, SecretReference>();
    for (const step of workflow.steps) {
      if (step.secretRef === undefined || secrets.has(step.secretRef)) continue;
      secrets.set(step.secretRef, {
        name: step.secretRef,
        kind: step.totp === true ? 'totp' : /PASS/.test(step.secretRef) ? 'password' : 'token',
      });
    }
    if (secrets.size > 0) workflow.secrets = [...secrets.values()];
    if (resultZone !== undefined) workflow.resultZone = structuredClone(resultZone);
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
