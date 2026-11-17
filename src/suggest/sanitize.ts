/**
 * What a suggestion may contain. A suggestion comes from a model or from a file a user edited, and it ends up in tool
 * descriptions that an agent reads: so it is plain text, bounded, and free of markup, links and instructions.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { SUGGESTION_SET_SCHEMA, WORKFLOW_SUGGESTION_SCHEMA, type SuggestionSet, type WorkflowSuggestion } from './suggester.js';

export const MAX_DESCRIPTION_LENGTH = 400;
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Control characters, and the invisible or direction-changing characters that hide text from a reader. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const MARKUP = /[<>`]|\]\(|\*\*|__|^\s*#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|&[a-z#0-9]+;/i;
const LINK = /\b(?:https?|ftp|file|data|javascript|mailto):|\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co|info|biz|xyz|ru|cn)\b/i;
const INJECTION =
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the|these|those|system)\b[^.]{0,30}\b(?:instruction|prompt|rule|direction|message|context|guideline)s?\b|\b(?:system|developer)\s+(?:prompt|message)\b|\bnew\s+instructions?\b|\bignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier)\b|\byou\s+(?:are|must|should|will)\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|agent|admin|root)\b|\bas\s+an\s+ai\b|\bjailbreak\b|\bdo\s+not\s+(?:follow|obey)\b|\bcall\s+(?:the\s+)?tool\b|\bexfiltrat/i;

/** Text without control or invisible characters, spaces collapsed, and no longer than `max`. */
export function stripControl(text: string, max = MAX_DESCRIPTION_LENGTH): string {
  return text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * A description that may be shown to an agent, or undefined when it must be dropped: control characters are stripped
 * and the length is capped, but markup, links and instruction-like phrases drop the whole text.
 */
export function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = stripControl(value);
  if (text === '') return undefined;
  if (MARKUP.test(text) || LINK.test(text) || INJECTION.test(text)) return undefined;
  return text;
}

export function isValidToolName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_NAME_PATTERN.test(value);
}

export function isValidVariableName(value: unknown): value is string {
  return typeof value === 'string' && VARIABLE_NAME_PATTERN.test(value);
}

let setValidator: ValidateFunction | undefined;
let entryValidator: ValidateFunction | undefined;
function validators(): { set: ValidateFunction; entry: ValidateFunction } {
  if (setValidator === undefined || entryValidator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    setValidator = ajv.compile(SUGGESTION_SET_SCHEMA);
    entryValidator = ajv.compile(WORKFLOW_SUGGESTION_SCHEMA);
  }
  return { set: setValidator, entry: entryValidator };
}

/** Whether a whole suggestion file has the strict shape; errors name the failing paths. */
export function validateSuggestionSet(value: unknown): { ok: true; set: SuggestionSet } | { ok: false; errors: string[] } {
  const { set } = validators();
  if (set(value)) return { ok: true, set: value as unknown as SuggestionSet };
  return { ok: false, errors: (set.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`) };
}

/** Whether one entry has the strict shape (used one by one so that a bad entry does not discard the others). */
export function validateWorkflowSuggestion(value: unknown): value is WorkflowSuggestion {
  return validators().entry(value) === true;
}
