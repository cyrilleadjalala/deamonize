import type { VariableType } from '../recorder/panel-protocol.js';
import type { WorkflowStep, WorkflowVariable } from '../types.js';

/** What a rename and a retype need to touch. Mutates in place: steps and variables are shared with the caller. */
export interface VariableHost {
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  observedPayloads: Record<string, unknown>[];
}

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function renameText(text: string, from: string, to: string): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (name === from ? `{{${to}}}` : whole));
}

function renameInBody(node: unknown, from: string, to: string): unknown {
  if (typeof node === 'string') return renameText(node, from, to);
  if (Array.isArray(node)) return node.map((item) => renameInBody(item, from, to));
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    if (typeof record.$var === 'string' && keys.every((key) => key === '$var' || key === 'as')) {
      return record.$var === from ? { ...record, $var: to } : { ...record };
    }
    const next: Record<string, unknown> = {};
    for (const key of keys) next[key] = renameInBody(record[key], from, to);
    return next;
  }
  return node;
}

function renameInMap<T>(map: Record<string, T | { $secret: string }>, from: string, to: string): void {
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (typeof value === 'string') map[key] = renameText(value, from, to) as unknown as T;
  }
}

/**
 * step.variable, rowBinding.variable, http.bindings[].variable, `{{name}}` in http.url, query values and header values,
 * `{"$var":name}` leaves and `{{name}}` in string leaves of http.body, the definition itself and the key of every
 * observed payload. Afterwards the old name appears in none of these places. Other names are untouched.
 */
export function renameVariable(host: VariableHost, from: string, to: string): void {
  if (from === to) return;
  for (const step of host.steps) {
    if (step.variable === from) step.variable = to;
    if (step.rowBinding?.variable === from) step.rowBinding.variable = to;
    const http = step.http;
    if (http !== undefined) {
      for (const binding of http.bindings ?? []) {
        if (binding.variable === from) binding.variable = to;
      }
      http.url = renameText(http.url, from, to);
      renameInMap(http.query ?? {}, from, to);
      if (http.headers !== undefined) renameInMap(http.headers, from, to);
      if (http.body !== undefined) http.body = renameInBody(http.body, from, to);
    }
  }
  for (const variable of host.variables) {
    if (variable.name === from) variable.name = to;
  }
  host.observedPayloads.forEach((payload, index) => {
    if (!Object.prototype.hasOwnProperty.call(payload, from)) return;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(payload)) next[key === from ? to : key] = payload[key];
    host.observedPayloads[index] = next;
  });
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false };

/**
 * string to number when the trimmed text is not empty and finite; string to boolean only for "true" and "false";
 * number or boolean to string; number to boolean and boolean to number are refused.
 */
export function coercePayloadValue(
  value: unknown,
  from: 'string' | 'number' | 'boolean',
  to: 'string' | 'number' | 'boolean',
): CoerceResult {
  if (typeof value !== from) return { ok: false };
  if (from === to) return { ok: true, value };
  if (to === 'string') return { ok: true, value: String(value) };
  if (from === 'string') {
    const text = value as string;
    if (to === 'number') {
      const trimmed = text.trim();
      if (trimmed === '') return { ok: false };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    if (text === 'true') return { ok: true, value: true };
    if (text === 'false') return { ok: true, value: false };
  }
  return { ok: false };
}

/** false: a value cannot be coerced, nothing changed. */
export function retypePayloads(host: VariableHost, name: string, from: VariableType, to: VariableType): boolean {
  const converted: Array<[Record<string, unknown>, unknown]> = [];
  for (const payload of host.observedPayloads) {
    if (!Object.prototype.hasOwnProperty.call(payload, name)) continue;
    const result = coercePayloadValue(payload[name], from, to);
    if (!result.ok) return false;
    converted.push([payload, result.value]);
  }
  for (const [payload, value] of converted) payload[name] = value;
  return true;
}
