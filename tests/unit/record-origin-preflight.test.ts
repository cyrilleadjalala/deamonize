import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../../src/cli/commands/record.js';
import { LOAD_UNREADABLE } from '../../src/studio/messages/common.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';

const HELD = 'https://app.example.com/start';

function setWith(workflows: number): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'App',
    startUrl: HELD,
    workflows: Array.from({ length: workflows }, (_, i) => ({
      id: `1111111${i}-1111-4111-8111-111111111111`,
      label: `w${i}`,
      steps: [{ actionType: 'click' as const, selectors: ['role=button[name="Go"]'] }],
      variables: [],
      observedPayloads: [],
    })),
  };
}

describe('record() origin preflight', () => {
  let dir: string;
  let out: string;
  // The launcher stops the run on purpose: reaching it means a browser would open
  const launch = vi.fn(async () => {
    throw new Error('LAUNCHED');
  });
  const base = () => ({ name: 'App', label: 'x', out, headless: true, launch: launch as never });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'record-preflight-'));
    out = join(dir, 'daemonize.workflows.json');
    launch.mockClear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses another origin before any browser and leaves the file unchanged', async () => {
    const text = serializeWorkflowSet(setWith(1));
    await writeFile(out, text);
    const failure = await record({ ...base(), url: 'https://other.example.org/' }).catch((e: Error) => e);
    expect((failure as Error).message).toContain('https://app.example.com');
    expect((failure as Error).message).not.toContain(dir);
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(out, 'utf-8')).toBe(text);
  });

  it('proceeds to the browser for the same origin, including a default port', async () => {
    await writeFile(out, serializeWorkflowSet(setWith(1)));
    const failure = await record({ ...base(), url: 'https://app.example.com:443/other' }).catch((e: Error) => e);
    expect((failure as Error).message).toContain('LAUNCHED');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('proceeds when there is no file', async () => {
    const failure = await record({ ...base(), url: 'https://other.example.org/' }).catch((e: Error) => e);
    expect((failure as Error).message).toContain('LAUNCHED');
  });

  it('proceeds when the file holds no workflow', async () => {
    await writeFile(out, serializeWorkflowSet(setWith(0)));
    const failure = await record({ ...base(), url: 'https://other.example.org/' }).catch((e: Error) => e);
    expect((failure as Error).message).toContain('LAUNCHED');
  });

  it('fails with the standard message when the file is unreadable', async () => {
    await writeFile(out, '{ not json');
    const failure = await record({ ...base(), url: HELD }).catch((e: Error) => e);
    expect((failure as Error).message).toBe(LOAD_UNREADABLE);
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(out, 'utf-8')).toBe('{ not json');
  });
});
