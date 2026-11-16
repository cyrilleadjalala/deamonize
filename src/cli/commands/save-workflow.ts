import { readFile, writeFile } from 'node:fs/promises';
import {
  deserializeWorkflowSet,
  mergeWorkflowSets,
  serializeWorkflowSet,
} from '../../workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../types.js';

/** What a recording session was run against. */
export interface RecordingTarget {
  targetType: 'web' | 'tui';
  name: string;
  startUrl?: string;
  startCommand?: string[];
  storageState?: string;
}

/**
 * Add a recorded workflow to a Workflow set file: the file is created when
 * missing and merged when it already exists. Returns the number of workflows
 * the file now holds.
 */
export async function saveWorkflow(out: string, target: RecordingTarget, workflow: Workflow): Promise<number> {
  const recorded: WorkflowSet = {
    version: '1',
    targetType: target.targetType,
    targetName: target.name,
    workflows: [workflow],
  };
  if (target.startUrl !== undefined) recorded.startUrl = target.startUrl;
  if (target.startCommand !== undefined) recorded.startCommand = target.startCommand;
  if (target.storageState !== undefined) recorded.storageState = target.storageState;

  const existing = await loadExisting(out);
  const set = existing ? mergeWorkflowSets(existing, recorded) : recorded;
  await writeFile(out, serializeWorkflowSet(set));
  return set.workflows.length;
}

async function loadExisting(path: string): Promise<WorkflowSet | null> {
  try {
    return deserializeWorkflowSet(await readFile(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
