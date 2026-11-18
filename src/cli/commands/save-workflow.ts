import { readFile, writeFile } from 'node:fs/promises';
import {
  deserializeWorkflowSet,
  mergeWorkflowSets,
  serializeWorkflowSet,
} from '../../workflow/workflow-set.js';
import { checkSameOrigin, saveOriginMessage } from '../../workflow/origin-guard.js';
import { originOf } from '../../workflow/workflow-scope.js';
import { mergeSandboxSpec, validateSandboxSpec } from '../../sandbox/dockerfile.js';
import type { SandboxSpec, Workflow, WorkflowSet } from '../../types.js';

/** What a recording session was run against. */
export interface RecordingTarget {
  targetType: 'web' | 'tui';
  name: string;
  startUrl?: string;
  startCommand?: string[];
  storageState?: string;
  /** `--sandbox-*` flags: added to the `sandbox` block of the file. */
  sandbox?: SandboxSpec;
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
  // Origin check first, before anything else (it also wins when the new workflow replaces one of the file)
  if (existing !== null && target.targetType === 'web' && target.startUrl !== undefined) {
    const check = checkSameOrigin(existing, target.startUrl);
    if (!check.ok) throw new Error(saveOriginMessage(check.heldOrigin, originOf(target.startUrl) ?? target.startUrl));
  }
  // The sandbox block belongs to the file: a recording without flags keeps it, flags add to it
  const sandbox = mergeSandboxSpec(existing?.sandbox, target.sandbox);
  validateSandboxSpec(sandbox, target.targetType);
  if (sandbox !== undefined) recorded.sandbox = sandbox;
  const set = existing ? mergeWorkflowSets(existing, stamped(existing, recorded, target)) : recorded;
  await writeFile(out, serializeWorkflowSet(set));
  return set.workflows.length;
}

/**
 * When an earlier workflow of the file survives the merge, the file keeps its own start page and login: the new
 * workflow carries what differs from them (and nothing else).
 */
function stamped(existing: WorkflowSet, recorded: WorkflowSet, target: RecordingTarget): WorkflowSet {
  const [workflow] = recorded.workflows;
  const keepsBase = existing.workflows.some((w) => w.id !== workflow.id);
  if (!keepsBase || target.targetType !== 'web') return recorded;
  const own: Workflow = { ...workflow };
  if (target.startUrl !== undefined && target.startUrl !== existing.startUrl) own.startUrl = target.startUrl;
  if (target.storageState !== existing.storageState) own.storageState = target.storageState ?? null;
  return { ...recorded, workflows: [own] };
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
