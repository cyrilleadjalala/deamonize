/**
 * The workflow editor of the Studio: pure edits of a WorkflowSet (rename, describe, change the Variables, delete)
 * and the atomic write of the Workflow_File. Every edit works on a clone: a refused request changes nothing.
 */
import { randomBytes } from 'node:crypto';
import { readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { VariableType } from '../recorder/panel-protocol.js';
import { cleanDescription } from '../suggest/sanitize.js';
import type { Workflow, WorkflowSet, WorkflowVariable, WhenOmitted } from '../types.js';
import { retypePayloads, renameVariable, VARIABLE_NAME_RE } from '../workflow/variable-edit.js';
import { SKIP_IN_PATH_MESSAGE, findSkippedPathBinding } from '../workflow/workflow-scope.js';
import { serializeWorkflowSet } from '../workflow/workflow-set.js';
import { UNEXPECTED_FIELD } from './messages/common.js';
import * as text from './messages/workflows.js';
import { ASSET_NAME } from './model.js';

export type EditResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string; field?: string; index?: number };
export interface VariableUpdate {
  name: string;
  newName?: string;
  type?: VariableType;
  optional?: boolean;
  whenOmitted?: WhenOmitted;
  description?: string;
}
export interface UpdateRequest {
  id: string;
  label?: string;
  description?: string;
  variables?: VariableUpdate[];
}

export const MAX_LABEL_LENGTH = 200;
export const MAX_VARIABLE_NAME_LENGTH = 60;
export const MAX_VARIABLES_PER_REQUEST = 100;
export const MAX_ID_LENGTH = 200;

const UPDATE_FIELDS = new Set(['id', 'label', 'description', 'variables']);
const VARIABLE_KEYS = new Set(['name', 'newName', 'type', 'optional', 'whenOmitted', 'description']);
const TYPES = new Set<string>(['string', 'number', 'boolean']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const fail = (error: string, field?: string, index?: number): { ok: false; status: 400; error: string; field?: string; index?: number } => ({
  ok: false,
  status: 400,
  error,
  ...(field === undefined ? {} : { field }),
  ...(index === undefined ? {} : { index }),
});
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Pure. Clones the set, validates the whole request in the order of the design, then applies it. */
export function applyUpdate(set: WorkflowSet, request: unknown): EditResult<WorkflowSet> {
  if (!isRecord(request)) return fail(text.EDIT_ID_INVALID, 'id');
  for (const key of Object.keys(request)) {
    if (!UPDATE_FIELDS.has(key)) return fail(UNEXPECTED_FIELD, key);
  }
  if (typeof request.id !== 'string' || request.id === '') return fail(text.EDIT_ID_INVALID, 'id');
  if (!has(request, 'label') && !has(request, 'description') && !has(request, 'variables')) return fail(text.EDIT_NOTHING_CHANGED);
  const index = (set.workflows ?? []).findIndex((w) => w.id === request.id);
  if (index === -1) return { ok: false, status: 404, error: text.WORKFLOW_NOT_FOUND };

  let label: string | undefined;
  if (has(request, 'label')) {
    const raw = request.label;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (typeof raw !== 'string' || trimmed.length < 1 || trimmed.length > MAX_LABEL_LENGTH || CONTROL.test(trimmed)) {
      return fail(text.EDIT_LABEL_INVALID, 'label');
    }
    label = trimmed;
  }
  let description: string | undefined;
  if (has(request, 'description')) {
    const raw = request.description;
    if (typeof raw !== 'string') return fail(text.EDIT_DESCRIPTION_INVALID, 'description');
    if (raw === '') description = '';
    else {
      const cleaned = cleanDescription(raw);
      if (cleaned === undefined) return fail(text.EDIT_DESCRIPTION_INVALID, 'description');
      description = cleaned;
    }
  }

  const original = set.workflows[index];
  let updates: VariableUpdate[] | undefined;
  if (has(request, 'variables')) {
    const checked = validateVariableUpdates(original, request.variables);
    if (!checked.ok) return checked;
    updates = checked.value;
  }

  const next = structuredClone(set);
  const workflow = next.workflows[index];
  if (label !== undefined) workflow.label = label;
  if (description !== undefined) {
    if (description === '') delete workflow.description;
    else workflow.description = description;
  }
  if (updates !== undefined) {
    const applied = applyVariableUpdates(workflow, updates);
    if (!applied.ok) return applied;
  }
  return { ok: true, value: next };
}

function validateVariableUpdates(workflow: Workflow, raw: unknown): EditResult<VariableUpdate[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VARIABLES_PER_REQUEST) return fail(text.EDIT_VARIABLES_INVALID, 'variables');
  const current = new Map<string, WorkflowVariable>();
  for (const variable of workflow.variables ?? []) current.set(variable.name, variable);
  const checkVariables = new Set<string>();
  for (const step of workflow.steps ?? []) {
    if (step.actionType === 'check' && step.variable !== undefined) checkVariables.add(step.variable);
  }
  const names = new Set<string>();
  const newNames = new Map<string, number>();
  const out: VariableUpdate[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    if (!isRecord(item)) return fail(text.EDIT_VARIABLE_FIELDS, 'variables', i);
    for (const key of Object.keys(item)) {
      if (!VARIABLE_KEYS.has(key)) return fail(text.EDIT_VARIABLE_FIELDS, 'variables', i);
    }
    if (typeof item.name !== 'string') return fail(text.EDIT_VARIABLE_FIELDS, 'variables', i);
    for (const key of ['newName', 'type', 'whenOmitted', 'description'] as const) {
      if (has(item, key) && typeof item[key] !== 'string') return fail(text.EDIT_VARIABLE_FIELDS, 'variables', i);
    }
    if (has(item, 'optional') && typeof item.optional !== 'boolean') return fail(text.EDIT_FLAG_INVALID, 'variables', i);
    const name = item.name;
    const variable = current.get(name);
    if (variable === undefined) return fail(text.EDIT_VARIABLE_UNKNOWN(name.slice(0, 60)), 'variables', i);
    if (names.has(name)) return fail(text.EDIT_VARIABLE_TWICE(name), 'variables', i);
    names.add(name);
    if (has(item, 'newName')) {
      const newName = item.newName as string;
      if (!VARIABLE_NAME_RE.test(newName) || newName.length > MAX_VARIABLE_NAME_LENGTH) return fail(text.EDIT_NEW_NAME_INVALID, 'variables', i);
      if (newName !== name) {
        if (current.has(newName) || newNames.has(newName)) return fail(text.EDIT_NEW_NAME_TAKEN(newName), 'variables', i);
        newNames.set(newName, i);
      }
    }
    if (has(item, 'type')) {
      const type = item.type as string;
      if (!TYPES.has(type)) return fail(text.EDIT_TYPE_INVALID, 'variables', i);
      if (type !== 'string' && (variable.enum !== undefined || variable.pattern !== undefined || variable.maxLength !== undefined)) {
        return fail(text.EDIT_TYPE_RESTRICTED(name), 'variables', i);
      }
      if (type !== 'boolean' && checkVariables.has(name)) return fail(text.EDIT_TYPE_CHECK(name), 'variables', i);
    }
    if (has(item, 'whenOmitted')) {
      if (item.whenOmitted !== 'useRecorded' && item.whenOmitted !== 'skip') return fail(text.EDIT_WHEN_OMITTED_INVALID, 'variables', i);
      const optionalAfter = has(item, 'optional') ? item.optional === true : variable.optional === true;
      if (!optionalAfter) return fail(text.EDIT_WHEN_OMITTED_REQUIRED(name), 'variables', i);
    }
    if (has(item, 'description') && item.description !== '' && cleanDescription(item.description) === undefined) {
      return fail(text.EDIT_VARIABLE_DESCRIPTION_INVALID(name), 'variables', i);
    }
    out.push(item as unknown as VariableUpdate);
  }
  return { ok: true, value: out };
}

/** Works on the clone. Failure: the clone is dropped by the caller. */
function applyVariableUpdates(workflow: Workflow, updates: VariableUpdate[]): EditResult<true> {
  const host = workflow;
  for (let i = 0; i < updates.length; i += 1) {
    const update = updates[i];
    const variable = workflow.variables.find((v) => v.name === update.name);
    if (variable === undefined) return fail(text.EDIT_VARIABLE_UNKNOWN(update.name.slice(0, 60)), 'variables', i);
    if (update.type !== undefined && update.type !== (variable.type ?? 'string')) {
      if (!retypePayloads(host, update.name, variable.type ?? 'string', update.type)) return fail(text.EDIT_COERCE_FAILED(update.name), 'variables', i);
      variable.type = update.type;
    }
    if (update.optional === true) variable.optional = true;
    else if (update.optional === false) {
      delete variable.optional;
      delete variable.whenOmitted;
    }
    if (update.whenOmitted !== undefined) variable.whenOmitted = update.whenOmitted;
    if (update.description !== undefined) {
      if (update.description === '') delete variable.description;
      else variable.description = cleanDescription(update.description) as string;
    }
  }
  // Renames last: every request name refers to the names before the update
  for (const update of updates) {
    if (update.newName !== undefined && update.newName !== update.name) renameVariable(host, update.name, update.newName);
  }
  const skipped = findSkippedPathBinding(workflow);
  if (skipped !== undefined) {
    const at = updates.findIndex((u) => (u.newName ?? u.name) === skipped.variable);
    return fail(SKIP_IN_PATH_MESSAGE(workflow.id, skipped.variable), 'variables', at === -1 ? undefined : at);
  }
  return { ok: true, value: true };
}

/** Pure. `id` is a non-empty string of at most 200 characters. */
export function applyDelete(set: WorkflowSet, id: unknown): EditResult<{ set: WorkflowSet; removed: Workflow }> {
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) return fail(text.DELETE_ID_INVALID, 'id');
  const index = (set.workflows ?? []).findIndex((w) => w.id === id);
  if (index === -1) return { ok: false, status: 404, error: text.WORKFLOW_NOT_FOUND };
  const next = structuredClone(set);
  const [removed] = next.workflows.splice(index, 1);
  return { ok: true, value: { set: next, removed } };
}

/** Basenames from `visual.thumbnailPath` of every step of every workflow. */
export function referencedAssets(set: WorkflowSet): Set<string> {
  const names = new Set<string>();
  for (const workflow of set.workflows ?? []) {
    for (const step of workflow.steps ?? []) {
      const path = step.visual?.thumbnailPath;
      if (typeof path === 'string') names.add(path.split(/[\\/]/).pop() ?? path);
    }
  }
  return names;
}

/** The set would not pass the schema or would hold a plain secret. The message names no value. */
export class WorkflowContentError extends Error {}

let writeLock: Promise<unknown> = Promise.resolve();

/** serializeWorkflowSet, a temporary file next to the original (flag wx), rename over it, unlink in finally. One write at a time. */
export function writeWorkflowFileAtomic(file: string, set: WorkflowSet): Promise<void> {
  const run = async (): Promise<void> => {
    let content: string;
    try {
      content = serializeWorkflowSet(set);
    } catch {
      throw new WorkflowContentError(text.EDIT_REFUSED_CONTENT);
    }
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  const result = writeLock.then(run, run);
  writeLock = result.catch(() => undefined);
  return result;
}

/** Deletes the regular, non-symlink files of `<file>.assets/` named like a thumbnail that no remaining workflow references. */
export async function cleanAssets(file: string, set: WorkflowSet): Promise<'ok' | 'partial'> {
  const dir = join(dirname(file), `${basename(file)}.assets`);
  const keep = referencedAssets(set);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ok' : 'partial';
  }
  let result: 'ok' | 'partial' = 'ok';
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !ASSET_NAME.test(entry.name) || keep.has(entry.name)) continue;
    try {
      await unlink(join(dir, entry.name));
    } catch {
      result = 'partial';
    }
  }
  return result;
}
