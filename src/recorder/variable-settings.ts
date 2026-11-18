import type { StepActionType, WhenOmitted, WorkflowStep, WorkflowVariable } from '../types.js';
import type { EditVariableRequest, RadioInfo, VariableType } from './panel-protocol.js';
import { VARIABLE_NAME_RE } from '../workflow/variable-edit.js';

/** What the validators need to know about the recorded step a request targets. */
export interface RecordedStepFacts {
  actionType: StepActionType;
  value?: string;
  isRadioClick: boolean;
}

export type VariableSettings = { type?: VariableType; optional?: true; whenOmitted?: WhenOmitted };
export type SettingsResult = { ok: true; settings: VariableSettings } | { ok: false; error: string };

export const MAX_VARIABLE_NAME_LENGTH = 64;
export const MAX_RADIOS = 50;
export const MAX_RADIO_NAME_LENGTH = 200;
export const MAX_FIELD_LABEL_LENGTH = 200;

const TYPES: readonly VariableType[] = ['string', 'number', 'boolean'];
const OMITTED: readonly WhenOmitted[] = ['useRecorded', 'skip'];

const NOT_A_NUMBER = 'The recorded value is not a number. Choose "text" or record a number.';
const NOT_A_BOOLEAN = 'The recorded value is not "true" or "false". Choose "text" or record a true or false value.';

function isType(value: unknown): value is VariableType {
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value);
}

function isOmitted(value: unknown): value is WhenOmitted {
  return typeof value === 'string' && (OMITTED as readonly string[]).includes(value);
}

/** Whether a recorded text can be stored as the given type. */
export function valueFitsType(value: string | undefined, type: VariableType): string | undefined {
  if (type === 'string') return undefined;
  if (type === 'number') {
    const trimmed = (value ?? '').trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed)) ? undefined : NOT_A_NUMBER;
  }
  return value === 'true' || value === 'false' ? undefined : NOT_A_BOOLEAN;
}

/**
 * Requirements 5.4 to 5.8, 7.3 and 8.2: the settings to store for a "Make variable" request, or a plain message.
 * Changes nothing. A request with none of the three settings (and no check or radio target) gives `settings: {}`.
 */
export function validateVariableSettings(
  request: { type?: unknown; optional?: unknown; whenOmitted?: unknown; rowText?: unknown },
  step: RecordedStepFacts | undefined,
): SettingsResult {
  const { type, optional, whenOmitted, rowText } = request;
  if (type !== undefined && !isType(type)) {
    return { ok: false, error: 'The type must be text, number or true or false.' };
  }
  if (optional !== undefined && typeof optional !== 'boolean') {
    return { ok: false, error: 'Optional must be on or off.' };
  }
  if (whenOmitted !== undefined && !isOmitted(whenOmitted)) {
    return { ok: false, error: 'Choose to skip the field or to use the recorded value when it is left empty.' };
  }
  if (whenOmitted !== undefined && optional !== true) {
    return { ok: false, error: 'Tick "Optional" to choose what happens when the field is left empty.' };
  }
  if (rowText !== undefined) {
    if (typeof rowText !== 'string') return { ok: false, error: 'The selected text is not valid.' };
    if (type !== undefined && type !== 'string') {
      return { ok: false, error: 'A text selected in a row can only be a text variable.' };
    }
  }

  const settings: VariableSettings = {};
  if (step !== undefined && rowText === undefined) {
    if (step.actionType === 'check') {
      if (type !== undefined && type !== 'boolean') {
        return { ok: false, error: 'A checkbox or switch can only be a true or false variable.' };
      }
      settings.type = 'boolean';
    } else if (step.isRadioClick) {
      if (type !== undefined && type !== 'string') {
        return { ok: false, error: 'A group of radio buttons can only be a text variable.' };
      }
      settings.type = 'string';
    } else if (type !== undefined) {
      const problem = valueFitsType(step.value, type);
      if (problem !== undefined) return { ok: false, error: problem };
      settings.type = type;
    }
  } else if (type !== undefined) {
    settings.type = type;
  }
  if (optional === true) {
    settings.optional = true;
    if (whenOmitted !== undefined) settings.whenOmitted = whenOmitted;
  }
  return { ok: true, settings };
}

/**
 * Requirement 6.11: an edit of a Variable. The Variable must exist, a new name must match the pattern, be at most 64
 * characters and be free, and the settings follow the rules of Requirement 5 against the current Variable.
 */
export function validateEdit(
  request: EditVariableRequest,
  current: WorkflowVariable[],
  valueOf: (name: string) => string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (typeof request?.name !== 'string') return { ok: false, error: 'Choose the variable to change.' };
  const variable = current.find((candidate) => candidate.name === request.name);
  if (variable === undefined) return { ok: false, error: `There is no variable named "${request.name}".` };

  const { newName, type, optional, whenOmitted } = request;
  if (newName !== undefined) {
    if (typeof newName !== 'string' || !VARIABLE_NAME_RE.test(newName)) {
      return { ok: false, error: 'Use letters, digits and underscores, not starting with a digit' };
    }
    if (newName.length > MAX_VARIABLE_NAME_LENGTH) {
      return { ok: false, error: `Use at most ${MAX_VARIABLE_NAME_LENGTH} characters for the name.` };
    }
    if (newName !== variable.name && current.some((candidate) => candidate.name === newName)) {
      return { ok: false, error: `A variable named "${newName}" already exists.` };
    }
  }
  if (type !== undefined && !isType(type)) {
    return { ok: false, error: 'The type must be text, number or true or false.' };
  }
  if (optional !== undefined && typeof optional !== 'boolean') {
    return { ok: false, error: 'Optional must be on or off.' };
  }
  if (whenOmitted !== undefined && !isOmitted(whenOmitted)) {
    return { ok: false, error: 'Choose to skip the field or to use the recorded value when it is left empty.' };
  }
  const optionalAfter = optional ?? variable.optional === true;
  if (whenOmitted !== undefined && !optionalAfter) {
    return { ok: false, error: 'Tick "Optional" to choose what happens when the field is left empty.' };
  }
  if (type !== undefined && type !== (variable.type ?? 'string')) {
    if (variable.enum !== undefined && type !== 'string') {
      return { ok: false, error: 'A variable with a list of choices can only be text.' };
    }
    const problem = valueFitsType(valueOf(variable.name), type);
    if (problem !== undefined) return { ok: false, error: problem };
  }
  return { ok: true };
}

/** Requirements 8.3 to 8.6: the choices of a radio group, in document order, and the recorded value. */
export function validateRadioGroup(
  info: RadioInfo,
): { ok: true; enum: string[]; value: string } | { ok: false; error: string } {
  if (info === null || typeof info !== 'object' || !Array.isArray(info.names) || typeof info.clicked !== 'string') {
    return { ok: false, error: 'This group of radio buttons could not be read.' };
  }
  if (info.clickedDisabled === true) {
    return { ok: false, error: 'This radio button is disabled, so it cannot become a variable.' };
  }
  if (typeof info.total !== 'number' || info.total < 2) {
    return { ok: false, error: 'A variable needs a group of at least 2 radio buttons.' };
  }
  if (info.total > MAX_RADIOS || info.names.length > MAX_RADIOS) {
    return { ok: false, error: `This group has more than ${MAX_RADIOS} radio buttons, which is too many for a variable.` };
  }
  if (info.names.some((name) => typeof name !== 'string' || name === '')) {
    return { ok: false, error: 'A radio button of this group has no name, so the choices cannot be listed.' };
  }
  if (info.names.some((name) => name.length > MAX_RADIO_NAME_LENGTH)) {
    return { ok: false, error: `A radio button name of this group is longer than ${MAX_RADIO_NAME_LENGTH} characters.` };
  }
  if (new Set(info.names).size !== info.names.length) {
    return { ok: false, error: 'Two radio buttons of this group have the same name, so they cannot be told apart.' };
  }
  if (info.clicked === '' || !info.names.includes(info.clicked)) {
    return { ok: false, error: 'The radio button you clicked is not in the list of choices.' };
  }
  return { ok: true, enum: [...info.names], value: info.clicked };
}

const KIND_WORDS: Partial<Record<StepActionType, string>> = {
  type: 'type', select: 'select', check: 'check', click: 'choose',
};

function withoutValue(text: string, value: string): string {
  let out = text;
  while (out.includes(value)) out = out.split(value).join('');
  return out;
}

/** The label the field list shows for a step: at most 200 characters, and never the recorded value. */
export function safeFieldLabel(step: Pick<WorkflowStep, 'actionType' | 'label' | 'value'>): string {
  const word = KIND_WORDS[step.actionType] ?? step.actionType;
  let label = (step.label ?? `${word} field`).replace(/\s+/g, ' ').trim();
  const value = step.value;
  if (value !== undefined && value !== '' && label.includes(value)) {
    label = `${word} field`;
    if (label.includes(value)) label = withoutValue(label, value).replace(/\s+/g, ' ').trim();
  }
  if (label.length > MAX_FIELD_LABEL_LENGTH) {
    label = label.slice(0, MAX_FIELD_LABEL_LENGTH);
    if (value !== undefined && value !== '' && label.includes(value)) label = withoutValue(label, value);
  }
  return label;
}
