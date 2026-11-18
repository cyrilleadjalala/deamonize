/**
 * Suggestions on disk, and what `compile` takes from them. Applying a suggestion changes names and texts only (tool
 * name, tool description, description of a Variable). Steps, selectors, recorded requests and Variables themselves are
 * never touched, so what a tool replays is the same with and without suggestions.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { WorkflowSet } from '../types.js';
import { cleanDescription, isValidToolName, validateSuggestionSet } from './sanitize.js';
import type { SuggestionSet, WorkflowSuggestion } from './suggester.js';

export function suggestionsPathFor(workflowFile: string): string {
  return `${workflowFile}.suggestions.json`;
}

/** The suggestions file, or undefined when there is none. A file that is not valid is an error naming the problem. */
export async function readSuggestionsFile(path: string): Promise<SuggestionSet | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const result = validateSuggestionSet(json);
  if (!result.ok) throw new Error(`${path} is not a valid suggestions file: ${result.errors.join('; ')}`);
  return result.set;
}

export async function writeSuggestionsFile(path: string, suggestions: SuggestionSet): Promise<void> {
  await writeFile(path, `${JSON.stringify(suggestions, null, 2)}\n`);
}

export interface MergeResult {
  merged: SuggestionSet;
  /** Entries and keys added to the existing file. */
  added: number;
  /** Entries left alone because the user already accepted them. */
  keptAccepted: number;
}

/**
 * Add what an existing file lacks and leave everything else as the user left it. An entry the user accepted is not
 * touched at all, so a new suggestion never takes effect without a review.
 */
export function mergeMissing(existing: SuggestionSet, fresh: SuggestionSet): MergeResult {
  const merged: SuggestionSet = structuredClone(existing);
  let added = 0;
  let keptAccepted = 0;
  for (const entry of fresh.workflows) {
    const current = merged.workflows.find((w) => w.id === entry.id);
    if (current === undefined) {
      merged.workflows.push({ ...structuredClone(entry), accepted: false });
      added++;
      continue;
    }
    if (current.accepted === true) {
      keptAccepted++;
      continue;
    }
    const target = current as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'id' || key === 'accepted' || key in target) continue;
      target[key] = structuredClone(value);
      added++;
    }
  }
  return { merged, added, keptAccepted };
}

export interface AppliedSuggestions {
  /** A copy of the set with the accepted descriptions in place. */
  set: WorkflowSet;
  /** Workflow id to tool name, for the accepted names that are valid. */
  toolNames: Record<string, string>;
  applied: string[];
  skipped: string[];
}

/**
 * The accepted entries of a suggestions file, applied to a copy of the set. Anything invalid or unknown is skipped
 * with a reason: it never fails the compile and never changes a step.
 */
export function applySuggestions(set: WorkflowSet, suggestions: SuggestionSet): AppliedSuggestions {
  const copy = structuredClone(set);
  const toolNames: Record<string, string> = {};
  const applied: string[] = [];
  const skipped: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of suggestions.workflows) {
    if (entry.accepted !== true) continue;
    const workflow = copy.workflows.find((w) => w.id === entry.id);
    if (workflow === undefined || seenIds.has(entry.id)) {
      skipped.push(`${entry.id}: no such workflow`);
      continue;
    }
    seenIds.add(entry.id);
    applyEntry(entry, workflow, toolNames, applied, skipped);
  }
  return { set: copy, toolNames, applied, skipped };
}

function applyEntry(
  entry: WorkflowSuggestion,
  workflow: WorkflowSet['workflows'][number],
  toolNames: Record<string, string>,
  applied: string[],
  skipped: string[],
): void {
  const where = workflow.label;
  if (entry.toolName !== undefined) {
    if (isValidToolName(entry.toolName)) {
      toolNames[workflow.id] = entry.toolName;
      applied.push(`${where}: tool name ${entry.toolName}`);
    } else skipped.push(`${where}: tool name is not snake_case of at most 64 characters`);
  }
  if (entry.description !== undefined) {
    const description = cleanDescription(entry.description);
    // The description the user wrote is kept over a suggestion
    if (workflow.description?.trim()) skipped.push(`${where}: description kept, the workflow already has one written by the user`);
    else if (description === undefined) skipped.push(`${where}: description is empty, or has markup, a link or an instruction`);
    else {
      workflow.description = description;
      applied.push(`${where}: description`);
    }
  }
  for (const suggested of entry.variables ?? []) {
    if (suggested.description === undefined) continue;
    const variable = workflow.variables.find((v) => v.name === suggested.name);
    if (variable === undefined) continue; // a proposal for a Variable that does not exist is not applied
    const description = cleanDescription(suggested.description);
    if (description === undefined) skipped.push(`${where}: description of ${suggested.name} is not plain text`);
    else {
      variable.description = description;
      applied.push(`${where}: description of ${suggested.name}`);
    }
  }
}
