import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveWorkflow } from '../../src/cli/commands/save-workflow.js';
import { deserializeWorkflowSet, mergeWorkflowSets, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

const OLD = join(__dirname, '..', 'fixtures', 'regression', 'pre-change.workflows.json');

function recorded(id: string): Workflow {
  return {
    id,
    label: 'New action',
    steps: [{ actionType: 'click', selectors: ['role=button[name="Go"]'] }],
    variables: [],
    observedPayloads: [],
  };
}

describe('merge and save keep old files unchanged (11.7, 11.11)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'merge-compat-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the old workflows byte-identical and stamps nothing when start page and login are the same', async () => {
    const text = await readFile(OLD, 'utf-8');
    const before = deserializeWorkflowSet(text);
    const out = join(dir, 'daemonize.workflows.json');
    await writeFile(out, serializeWorkflowSet(before));

    const total = await saveWorkflow(
      out,
      { targetType: 'web', name: before.targetName, startUrl: before.startUrl, storageState: before.storageState },
      recorded('22222222-2222-4222-8222-222222222222'),
    );
    expect(total).toBe(before.workflows.length + 1);

    const after = deserializeWorkflowSet(await readFile(out, 'utf-8'));
    const serialized = (w: Workflow): string => JSON.stringify(w);
    expect(after.workflows.slice(0, before.workflows.length).map(serialized)).toEqual(before.workflows.map(serialized));
    const added = after.workflows[after.workflows.length - 1];
    expect('startUrl' in added).toBe(false);
    expect('storageState' in added).toBe(false);
    expect(after.targetName).toBe(before.targetName);
    expect(after.startUrl).toBe(before.startUrl);
  });

  it('merging a set that replaces nothing keeps the base target settings', () => {
    const base = deserializeWorkflowSet('{"version":"1","targetType":"web","targetName":"A","startUrl":"https://a.test/","workflows":[]}');
    base.workflows.push(recorded('11111111-1111-4111-8111-111111111111'));
    const newer: WorkflowSet = { ...base, targetName: 'B', startUrl: 'https://a.test/other', workflows: [recorded('33333333-3333-4333-8333-333333333333')] };
    const merged = mergeWorkflowSets(base, newer);
    expect(merged.targetName).toBe('A');
    expect(merged.startUrl).toBe('https://a.test/');
    expect(merged.workflows.map((w) => w.id)).toEqual([base.workflows[0].id, newer.workflows[0].id]);
  });
});
