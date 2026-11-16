import { readFile, writeFile } from 'node:fs/promises';
import {
  deserializeWorkflowSet,
  mergeWorkflowSets,
  serializeWorkflowSet,
} from '../../workflow/workflow-set.js';

/**
 * Merge two Workflow set files into `out`. When both hold a workflow with
 * the same id, the one from `newerFile` wins. Returns the number of workflows kept.
 */
export async function merge(baseFile: string, newerFile: string, out: string): Promise<number> {
  const base = deserializeWorkflowSet(await readFile(baseFile, 'utf-8'));
  const newer = deserializeWorkflowSet(await readFile(newerFile, 'utf-8'));
  const merged = mergeWorkflowSets(base, newer);
  await writeFile(out, serializeWorkflowSet(merged));
  return merged.workflows.length;
}
