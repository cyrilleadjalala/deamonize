import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { WorkflowContentError, applyDelete, applyUpdate, writeWorkflowFileAtomic } from '../../src/studio/workflow-editor.js';
import { removeDir } from '../helpers/cleanup.js';
import type { WorkflowSet } from '../../src/types.js';

// A file recorded before this change: no whenOmitted, description, startUrl per workflow or storageState per workflow.
const OLD_FILE = resolve(import.meta.dirname, '../fixtures/regression/pre-change-tui.workflows.json');

let dir: string;
let file: string;
let original: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wf-editor-compat-'));
  file = join(dir, 'daemonize.workflows.json');
  original = await readFile(OLD_FILE, 'utf-8');
  await writeFile(file, original);
});
afterEach(async () => {
  await removeDir(dir);
});

const load = async (): Promise<WorkflowSet> => deserializeWorkflowSet(await readFile(file, 'utf-8'));
const names = async (): Promise<string[]> => (await readdir(dir)).sort();

describe('workflow editor on a file recorded before this change', () => {
  it('writes only the changed fields and the result loads with the schema', async () => {
    const set = await load();
    const target = set.workflows[0];
    const result = applyUpdate(set, { id: target.id, label: '  Add a new task ', description: 'Adds a task to the list' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await writeWorkflowFileAtomic(file, result.value);
    const expected = JSON.parse(original);
    expected.workflows[0].label = 'Add a new task';
    expected.workflows[0].description = 'Adds a task to the list';
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(expected);
    expect((await load()).workflows[0].variables).toEqual(set.workflows[0].variables);
    expect(await names()).toEqual(['daemonize.workflows.json']);
  });

  it('adds no optional, whenOmitted or description to a Variable the request does not name', async () => {
    const set = await load();
    const target = set.workflows[0];
    const first = target.variables[0].name;
    const result = applyUpdate(set, { id: target.id, variables: [{ name: first, newName: `${first}_x` }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changed = result.value.workflows[0].variables;
    expect(changed[0]).toEqual({ ...target.variables[0], name: `${first}_x` });
    expect(changed.slice(1)).toEqual(target.variables.slice(1));
  });

  it('keeps every other workflow and every other top-level field on delete', async () => {
    const withExtra = { ...JSON.parse(original), timeoutMs: 45000, sandbox: { network: 'none' } };
    const second = JSON.parse(JSON.stringify(withExtra.workflows[0]));
    second.id = '22222222-2222-4222-8222-2222222222ff';
    second.label = 'Another';
    withExtra.workflows.push(second);
    await writeFile(file, JSON.stringify(withExtra, null, 2));
    const set = await load();
    const deleted = applyDelete(set, set.workflows[0].id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    await writeWorkflowFileAtomic(file, deleted.value.set);
    const after = JSON.parse(await readFile(file, 'utf-8'));
    const expected = JSON.parse(JSON.stringify(withExtra));
    expected.workflows.splice(0, 1);
    expect(after).toEqual(expected);
    expect(after.timeoutMs).toBe(45000);
    expect(after.sandbox).toEqual({ network: 'none' });
  });

  it('leaves the original file and no temporary file when the request is invalid', async () => {
    const set = await load();
    const invalid = applyUpdate(set, { id: set.workflows[0].id, label: '   ' });
    expect(invalid.ok).toBe(false);
    expect(await readFile(file, 'utf-8')).toBe(original);
    expect(await names()).toEqual(['daemonize.workflows.json']);
  });

  it('refuses a set that would hold a plain secret, keeping the original and leaving no temporary file', async () => {
    const set = await load();
    const bad = structuredClone(set);
    bad.workflows[0].steps.push({ actionType: 'type', selectors: ['input[type="password"]'], value: 'hunter2-plain' });
    await expect(writeWorkflowFileAtomic(file, bad)).rejects.toBeInstanceOf(WorkflowContentError);
    await expect(writeWorkflowFileAtomic(file, bad)).rejects.not.toThrow(/hunter2/);
    expect(await readFile(file, 'utf-8')).toBe(original);
    expect(await names()).toEqual(['daemonize.workflows.json']);
  });

  it('leaves no temporary file when the rename fails', async () => {
    const target = join(dir, 'blocked.json');
    await mkdir(target);
    const set = await load();
    await expect(writeWorkflowFileAtomic(target, set)).rejects.toThrow();
    expect(await names()).toEqual(['blocked.json', 'daemonize.workflows.json']);
  });

  it('leaves a loadable file with an empty workflow list after the last workflow is deleted', async () => {
    let set = await load();
    while (set.workflows.length > 0) {
      const deleted = applyDelete(set, set.workflows[0].id);
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) return;
      set = deleted.value.set;
      await writeWorkflowFileAtomic(file, set);
    }
    const final = await load();
    expect(final.workflows).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf-8')).workflows).toEqual([]);
    expect(final.targetName).toBe(JSON.parse(original).targetName);
  });
});
