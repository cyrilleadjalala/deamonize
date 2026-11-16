/**
 * Decisions of a strict web replay that need no browser, shared by the generated
 * run-time and the tests (copied verbatim into the output directory, like
 * screen-hash.ts and settle.ts). Only a sibling runtime module is imported; nothing from src/.
 *
 * Level 2 resolution order of a step (requirements 12.3, 12.5, 12.6, 14.1 to 14.7):
 *   1. the accessible role + name, scoped by the recorded parent context (dialog, region, section);
 *   2. for a step in a dynamic list, the same inside the row found by the Variable (never by position);
 *   3. the recorded alternative selectors, in order;
 *   the CSS path is recorded last and is therefore tried last.
 * A locator that matches several elements is a failure, never narrowed with `.first()` or `nth`.
 * In strict mode, when every candidate fails the replay stops: no later step runs.
 */

import { buildRowLocator, RowResolutionError, type RowBindingLike } from './row-resolver.js';

export type StepRiskLike = 'read' | 'write' | 'delete';

export interface AnchorLike {
  role: string;
  name: string;
  parent?: { kind: 'dialog' | 'region' | 'heading' | 'label'; name: string };
  frame: number[];
  frameHints?: Array<{ name?: string; title?: string; src?: string }>;
  popup?: { page: number; opens?: boolean };
}

/** The part of a workflow step the strict runtime reads (kept structural so this file stays standalone). */
export interface StepLike {
  actionType: string;
  selectors: string[];
  value?: string;
  variable?: string;
  label?: string;
  anchor?: AnchorLike;
  rowBinding?: RowBindingLike;
  risk?: StepRiskLike;
  secretRef?: string;
  totp?: boolean;
  timeoutMs?: number;
}

export type ScopeKind = 'dialog' | 'region' | 'heading';

export interface LocatorCandidate {
  /** role: getByRole; selector: a recorded Playwright selector; css: a recorded CSS selector (last resort). */
  kind: 'role' | 'selector' | 'css';
  /** Human-readable form, the one reported in the failure diagnostic. */
  description: string;
  role?: { role: string; name: string; exact: boolean };
  /** Context the role locator is searched in (a dialog, a labelled region or a section with a heading). */
  scope?: { kind: ScopeKind; name: string };
  selector?: string;
  /** Applied inside the row found by the Variable of the step's rowBinding. */
  inRow?: boolean;
  /** Why this candidate cannot even be tried (for example the Variable that selects the row has no value). */
  unusable?: string;
}

/** Names longer than this were cut by the recorder: they can only be matched as a prefix. */
export const MAX_ACCESSIBLE_NAME = 80;
const SCOPE_KINDS = new Set<string>(['dialog', 'region', 'heading']);
const NON_ROLES = new Set(['', 'generic', 'document']);
const OPTION_ROLES = new Set(['option']);

/** Quote a name for the description of a Playwright call. */
function q(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** True when the step clicks an option whose text is given by a Variable. */
export function isOptionByValue(step: StepLike, variables: Record<string, unknown>): boolean {
  return (
    step.actionType === 'click' &&
    step.anchor !== undefined &&
    OPTION_ROLES.has(step.anchor.role) &&
    step.variable !== undefined &&
    variables[step.variable] !== undefined &&
    variables[step.variable] !== null
  );
}

function isCssSelector(selector: string): boolean {
  return !/^(role=|text=|text\/|css=|xpath=|id=|data-testid=|\[data-testid|#|\[name=|internal:)/.test(selector);
}

/**
 * The ordered, described candidate locators of a step. Pure: never touches a page.
 * A step without anchor (an older recording) only has its recorded selectors.
 */
export function planLocators(step: StepLike, variables: Record<string, unknown> = {}): LocatorCandidate[] {
  if (step.actionType === 'switch_page') return [];

  const out: LocatorCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: LocatorCandidate): void => {
    if (seen.has(candidate.description)) return;
    seen.add(candidate.description);
    out.push(candidate);
  };

  let inRow = '';
  if (step.rowBinding !== undefined) {
    try {
      inRow = ` in the row containing ${q(buildRowLocator(step.rowBinding, variables).hasText)}`;
    } catch (err) {
      const message = err instanceof RowResolutionError ? err.message : (err as Error).message;
      // Acting on another row would be worse than failing
      return [{ kind: 'selector', inRow: true, unusable: message, description: `row of the step: ${message}` }];
    }
  }
  const rowBound = step.rowBinding !== undefined;

  const anchor = step.anchor;
  const byValue = isOptionByValue(step, variables);
  const name = byValue ? String(variables[step.variable as string]) : anchor?.name ?? '';

  if (anchor !== undefined && !NON_ROLES.has(anchor.role) && name !== '') {
    const role = { role: anchor.role, name, exact: name.length < MAX_ACCESSIBLE_NAME };
    const parent = anchor.parent;
    const scope =
      !rowBound && parent !== undefined && SCOPE_KINDS.has(parent.kind) && parent.name !== ''
        ? { kind: parent.kind as ScopeKind, name: parent.name }
        : undefined;
    // A control recorded inside a context is never looked for outside it: it could be the other "Save"
    const call = `getByRole(${q(role.role)}, { name: ${q(name)}${role.exact ? ', exact: true' : ''} })`;
    if (scope !== undefined) {
      push({ kind: 'role', role, scope, description: `${call} in ${scope.kind === 'heading' ? 'the section titled' : scope.kind} ${q(scope.name)}` });
    } else if (parent === undefined || !SCOPE_KINDS.has(parent.kind) || rowBound || parent.name === '') {
      push({ kind: 'role', role, inRow: rowBound, description: call + inRow });
    }
  }

  // A value taken from the Payload replaces the recorded text: the recorded selectors would pick the recorded option
  if (!byValue) {
    for (const recorded of step.selectors) {
      // In a row only the part of the selector that designates the control is applied
      const selector = rowBound ? (recorded.split(' >> ').pop() as string) : recorded;
      if (rowBound && selector.includes(':nth-of-type')) continue;
      const css = isCssSelector(selector);
      push({
        kind: css ? 'css' : 'selector',
        selector,
        inRow: rowBound,
        description: `${css ? 'css: ' : ''}${selector}${inRow}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function cssValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Selector of an iframe from what was recorded about it: its name, else its title, else its source. */
export function frameHintSelector(hint: { name?: string; title?: string; src?: string }): string | undefined {
  const attribute = hint.name !== undefined && hint.name !== ''
    ? ['name', hint.name]
    : hint.title !== undefined && hint.title !== ''
      ? ['title', hint.title]
      : hint.src !== undefined && hint.src !== ''
        ? ['src', hint.src]
        : undefined;
  if (attribute === undefined) return undefined;
  return `iframe[${attribute[0]}="${cssValue(attribute[1])}"], frame[${attribute[0]}="${cssValue(attribute[1])}"]`;
}

// ---------------------------------------------------------------------------
// Which candidate to act on
// ---------------------------------------------------------------------------

export interface CandidateState {
  /** Elements the candidate matches right now. */
  count: number;
  /** Cannot be tried at all. */
  unusable?: boolean;
  /** Was tried and its action failed. */
  failed?: boolean;
}

/** A lower-priority candidate is only taken after this long, so a page that is still rendering is not mistaken for a drifted one. */
export const LOWER_PRIORITY_GRACE_MS = 400;

/**
 * Pick the first candidate that matches exactly one element. A candidate that comes
 * after another one which does not match yet is only taken once `graceMs` elapsed.
 */
export function decideCandidate(
  states: CandidateState[],
  elapsedMs: number,
  graceMs: number = LOWER_PRIORITY_GRACE_MS
): number | undefined {
  let earlierPending = false;
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    if (state.unusable === true || state.failed === true) continue;
    if (state.count === 1 && (!earlierPending || elapsedMs >= graceMs)) return i;
    if (state.count !== 1) earlierPending = true;
  }
  return undefined;
}

/** Why a candidate was not used, for the diagnostic. */
export function explainState(state: CandidateState, failure?: string): string {
  if (state.unusable === true) return failure ?? 'cannot be tried';
  if (state.failed === true) return failure ?? 'the action failed';
  if (state.count === 0) return 'no element matched';
  if (state.count > 1) return `${state.count} elements matched (ambiguous, never narrowed with first/nth)`;
  return 'matched but not used';
}

// ---------------------------------------------------------------------------
// Values and secrets
// ---------------------------------------------------------------------------

export class MissingSecretError extends Error {
  constructor(readonly variable: string) {
    super(`missing secret: the environment variable ${variable} is not set`);
    this.name = 'MissingSecretError';
  }
}

export function secretEnvName(name: string): string {
  return `DAEMONIZE_SECRET_${name}`;
}

/** Names of the environment variables of the secrets the steps need and the environment lacks (never their values). */
export function missingSecrets(steps: StepLike[], env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  for (const step of steps) {
    if (step.secretRef === undefined) continue;
    const variable = secretEnvName(step.secretRef);
    const value = env[variable];
    if ((value === undefined || value === '') && !missing.includes(variable)) missing.push(variable);
  }
  return missing;
}

/**
 * The value a step types or selects: the secret of `secretRef`, else the Variable of the
 * Payload, else the recorded value. A missing secret is an error that names the variable.
 */
export function resolveStepValue(
  step: StepLike,
  variables: Record<string, unknown>,
  env: Record<string, string | undefined>
): string | undefined {
  if (step.secretRef !== undefined) {
    const variable = secretEnvName(step.secretRef);
    const value = env[variable];
    if (value === undefined || value === '') throw new MissingSecretError(variable);
    return value;
  }
  if (step.variable !== undefined) {
    const supplied = variables[step.variable];
    return supplied === undefined || supplied === null ? step.value : String(supplied);
  }
  return step.value;
}

// ---------------------------------------------------------------------------
// Failure diagnostic and strict loop
// ---------------------------------------------------------------------------

export interface StepFailure {
  stepIndex: number;
  label: string;
  action: string;
  risk: StepRiskLike;
  /** Descriptions of the locators tried, in order. */
  tried: string[];
  reason: string;
  /** Path of a PNG of the page at the time of the failure. */
  screenshot?: string;
  /** The screenshot as a data URI, only when it is smaller than 20 KB. */
  thumbnail?: string;
}

export const MAX_THUMBNAIL_BYTES = 20 * 1024;
const MAX_REASON_LENGTH = 1200;

/** Replace every occurrence of a secret value by `***`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

export function describeFailure(input: {
  stepIndex: number;
  step: StepLike;
  tried: string[];
  reason: string;
  screenshot?: string;
  thumbnail?: string;
  secrets?: readonly string[];
}): StepFailure {
  const secrets = input.secrets ?? [];
  const clean = (text: string): string => redactSecrets(text, secrets);
  // Playwright appends a call log that can echo the typed value: keep the first lines only
  const reason = clean(input.reason.split(/\r?\nCall log:/)[0]).slice(0, MAX_REASON_LENGTH);
  const failure: StepFailure = {
    stepIndex: input.stepIndex,
    label: clean(input.step.label ?? `${input.step.actionType} step ${input.stepIndex}`),
    action: input.step.actionType,
    risk: input.step.risk ?? 'read',
    tried: input.tried.map(clean),
    reason,
  };
  if (input.screenshot !== undefined) failure.screenshot = input.screenshot;
  if (input.thumbnail !== undefined) failure.thumbnail = input.thumbnail;
  return failure;
}

/** The result of a strict failure: the same shape on the host and in a container. */
export function failureResult(failure: StepFailure, elapsedMs: number): {
  success: false;
  drifted: true;
  error: 'step_failed';
  failure: StepFailure;
  elapsedMs: number;
} {
  return { success: false, drifted: true, error: 'step_failed', failure, elapsedMs };
}

/** Thrown by a step executor when no locator of the step worked. */
export class StepExecutionError extends Error {
  constructor(
    readonly tried: string[],
    readonly reason: string
  ) {
    super(reason);
    this.name = 'StepExecutionError';
  }
}

export type StrictOutcome =
  | { ok: true }
  | { ok: false; stepIndex: number; step: StepLike; tried: string[]; reason: string };

/**
 * Run the steps in order and stop at the first one that fails: no later step is started.
 * A write or delete step is never retried here or by the executor.
 */
export async function runStepsStrict<S extends StepLike>(
  steps: readonly S[],
  execute: (step: S, index: number) => Promise<void>
): Promise<StrictOutcome> {
  for (let index = 0; index < steps.length; index++) {
    try {
      await execute(steps[index], index);
    } catch (err) {
      const tried = err instanceof StepExecutionError ? err.tried : [];
      const reason = err instanceof StepExecutionError ? err.reason : (err as Error)?.message ?? String(err);
      return { ok: false, stepIndex: index, step: steps[index], tried, reason };
    }
  }
  return { ok: true };
}
