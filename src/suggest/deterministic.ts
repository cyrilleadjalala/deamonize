/**
 * The suggestions that need no model and no network (requirement 18.2). The output depends only on the input: the same
 * WorkflowSet and snapshots always give the same SuggestionSet.
 */
import { ToolNameDeriver } from '../compiler/tool-name-deriver.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../types.js';
import { suggestResultZone } from './html-zone.js';
import { cleanDescription, isValidVariableName, stripControl } from './sanitize.js';
import type {
  CandidateVariable,
  CorrelatedParam,
  SuggestContext,
  Suggester,
  SuggestionSet,
  WorkflowSuggestion,
} from './suggester.js';

const NOISE = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'from', 'by', 'my', 'our', 'please', 'new',
  'test', 'tmp', 'temp', 'workflow', 'recording', 'recorded', 'flow', 'step', 'steps', 'final', 'v',
]);

const VERBS = new Set([
  'add', 'approve', 'archive', 'assign', 'book', 'cancel', 'change', 'check', 'clear', 'close', 'confirm', 'copy', 'create',
  'delete', 'disable', 'download', 'edit', 'enable', 'enter', 'export', 'fetch', 'fill', 'find', 'generate', 'get', 'greet', 'import',
  'list', 'load', 'login', 'logout', 'open', 'order', 'pay', 'publish', 'read', 'register', 'reject', 'remove', 'rename',
  'reset', 'restore', 'run', 'save', 'search', 'select', 'send', 'set', 'show', 'sign', 'start', 'stop', 'submit', 'unlock',
  'update', 'upload', 'validate', 'view',
]);

/** A token that is an identifier, a hash or a number rather than a word. */
function looksLikeId(token: string): boolean {
  if (/^\d+$/.test(token)) return token.length >= 3;
  if (/^[0-9a-f]{6,}$/.test(token)) return true;
  if (/\d/.test(token) && /[a-z]/.test(token) && token.length >= 6) return true;
  return false;
}

/** `Create new customer #12345 (a1b2c3d4)` becomes `create_customer`; a name never starts with a digit or is empty. */
export function cleanToolName(label: string): string {
  const folded = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tokens = folded.split(/[^a-z0-9]+/).filter((t) => t !== '' && !NOISE.has(t) && !looksLikeId(t));
  const verbAt = tokens.findIndex((t) => VERBS.has(t));
  if (verbAt > 0) tokens.unshift(...tokens.splice(verbAt, 1));
  else if (verbAt < 0 && tokens.length > 0) tokens.unshift('run');
  while (tokens.length > 0 && /^\d/.test(tokens[0])) tokens.shift();
  const name = tokens.join('_');
  return name === '' ? 'run_workflow' : name;
}

const PASSWORD = /pass(word|wd)|mot de passe|passcode|secret|token|pin\b|otp|one[- ]time|2fa|totp|verification code|cvv|cvc/i;

function stepName(step: WorkflowStep): string | undefined {
  const name = step.anchor?.name ?? step.label;
  if (name === undefined) return undefined;
  const text = stripControl(name, 60).replace(/['"<>`\\]/g, '').trim();
  return text === '' ? undefined : text;
}

function isSecretStep(step: WorkflowStep): boolean {
  return (
    step.secretRef !== undefined ||
    step.totp === true ||
    (step.selectors ?? []).some((s) => /type\s*=\s*["']?password/i.test(s)) ||
    PASSWORD.test(`${step.anchor?.name ?? ''} ${step.label ?? ''}`)
  );
}

/** What the steps do, in words an agent can read: names of controls only, never a typed value. */
export function describeSteps(workflow: Workflow): string | undefined {
  const phrases: string[] = [];
  let parent: string | undefined;
  for (const step of workflow.steps) {
    const name = stepName(step);
    let verb: string | undefined;
    if (step.actionType === 'type') verb = 'fill';
    else if (step.actionType === 'select') verb = 'select';
    else if (step.actionType === 'click' || step.actionType === 'form_submit') verb = 'click';
    else if (step.actionType === 'keypress') verb = 'press a key in';
    if (verb === undefined || name === undefined) continue;
    const phrase = `${verb} '${name}'`;
    if (phrases[phrases.length - 1] !== phrase) phrases.push(phrase);
    const context = step.anchor?.parent;
    if (context !== undefined) {
      const contextName = stripControl(context.name, 60).replace(/['"<>`\\]/g, '').trim();
      if (contextName !== '') parent = `${context.kind} '${contextName}'`;
    }
  }
  if (phrases.length === 0) return undefined;
  const shown = phrases.slice(0, 6);
  const [first, ...rest] = shown;
  let text = [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(', ');
  if (phrases.length > shown.length) text += ` and ${phrases.length - shown.length} more step${phrases.length - shown.length > 1 ? 's' : ''}`;
  if (parent !== undefined) text += ` in ${parent}`;
  text += '.';
  const risks = new Set(workflow.steps.map((s) => s.risk ?? 'read'));
  if (risks.has('delete')) text += ' Deletes data.';
  else if (risks.has('write')) text += ' Writes data.';
  else text += ' Read only.';
  return cleanDescription(text);
}

function humanize(text: string): string {
  const spaced = text.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function variableDescriptions(workflow: Workflow): NonNullable<WorkflowSuggestion['variables']> {
  const out: NonNullable<WorkflowSuggestion['variables']> = [];
  for (const variable of workflow.variables) {
    if (variable.description !== undefined && variable.description !== '') continue;
    const step = workflow.steps.find((s) => s.variable === variable.name);
    const label = (step === undefined ? undefined : stepName(step)) ?? humanize(variable.name);
    const description = cleanDescription(label);
    if (description !== undefined) out.push({ name: variable.name, description });
  }
  return out;
}

function candidates(workflow: Workflow): CandidateVariable[] {
  const out: CandidateVariable[] = [];
  workflow.steps.forEach((step, stepIndex) => {
    if ((step.actionType !== 'type' && step.actionType !== 'select') || step.variable !== undefined) return;
    if (step.value === undefined || step.value === '' || isSecretStep(step)) return;
    const name = stepName(step);
    const suggested = name === undefined ? undefined : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^\d+/, '');
    const reason = `${step.actionType === 'select' ? 'Selected' : 'Typed'} value of ${name === undefined ? 'a field' : `'${name}'`} is fixed in the recording`;
    out.push({ stepIndex, reason, ...(suggested !== undefined && isValidVariableName(suggested.slice(0, 64)) ? { name: suggested.slice(0, 64) } : {}) });
  });
  return out;
}

function correlations(workflow: Workflow): CorrelatedParam[] {
  const out: CorrelatedParam[] = [];
  workflow.steps.forEach((step, stepIndex) => {
    for (const b of step.http?.bindings ?? []) out.push({ stepIndex, variable: b.variable, in: b.in, name: b.name });
  });
  return out;
}

/** The ordered tool names for the whole set, unique by construction. */
export function suggestToolNames(set: WorkflowSet): string[] {
  const deriver = new ToolNameDeriver();
  return set.workflows.map((w) => deriver.derive(cleanToolName(w.label)));
}

export class DeterministicSuggester implements Suggester {
  constructor(private readonly options: { fallbackReason?: string } = {}) {}

  async suggest(set: WorkflowSet, context: SuggestContext = {}): Promise<SuggestionSet> {
    const names = suggestToolNames(set);
    const workflows = set.workflows.map((workflow, index): WorkflowSuggestion => {
      const entry: WorkflowSuggestion = { id: workflow.id, accepted: false, toolName: names[index] };
      const description = describeSteps(workflow);
      if (description !== undefined) entry.description = description;
      const variables = variableDescriptions(workflow);
      if (variables.length > 0) entry.variables = variables;
      const candidateVariables = candidates(workflow);
      if (candidateVariables.length > 0) entry.candidateVariables = candidateVariables;
      const correlatedParams = correlations(workflow);
      if (correlatedParams.length > 0) entry.correlatedParams = correlatedParams;
      const snapshot = context.finalSnapshots?.get(workflow.id);
      if (snapshot !== undefined && workflow.resultZone === undefined) {
        const zone = suggestResultZone(snapshot);
        if (zone !== undefined) entry.resultZone = zone;
      }
      return entry;
    });
    return {
      version: '1',
      source: 'deterministic',
      ...(this.options.fallbackReason === undefined ? {} : { fallbackReason: this.options.fallbackReason }),
      workflows,
    };
  }
}
