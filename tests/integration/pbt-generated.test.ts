import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '../../src/cli/commands/compile.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Legacy CRM',
  startUrl: 'http://localhost:8080/',
  workflows: [
    {
      id: '88888888-8888-4888-8888-888888888888',
      label: 'Create customer',
      steps: [
        { actionType: 'type', selectors: ['#email'], variable: 'email' },
        { actionType: 'type', selectors: ['#qty'], variable: 'qty' },
        { actionType: 'click', selectors: ['#save'] },
      ],
      variables: [
        { name: 'email', description: 'Customer e-mail' },
        { name: 'qty', type: 'number', optional: true },
      ],
      observedPayloads: [{ email: 'a@example.com', qty: 2 }, { email: 'b@example.com', qty: 7 }],
    },
    {
      id: '99999999-9999-4999-8999-999999999999',
      label: 'Submit code',
      steps: [{ actionType: 'type', selectors: ['#code'], variable: 'code' }],
      variables: [{ name: 'code' }],
      observedPayloads: [{ code: 'abc' }, { code: 5 }],
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      label: 'Log out',
      steps: [{ actionType: 'click', selectors: ['#logout'] }],
      variables: [],
      observedPayloads: [],
    },
  ],
};

describe('Generated property-based test suite', () => {
  let dir: string;

  beforeAll(async () => {
    // Under the workspace so the generated files find vitest, fast-check and ajv in node_modules
    dir = await mkdtemp(join(workspaceRoot, '.pbt-'));
    const file = join(dir, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(set));

    const log = console.log;
    console.log = () => { };
    try {
      await compile(file, join(dir, 'out'));
    } finally {
      console.log = log;
    }
  }, 60000);

  afterAll(async () => {
    if (dir) {
      await removeDir(dir);
    }
  });

  it('is written next to the compiled server', async () => {
    expect((await readdir(join(dir, 'out', 'tests'))).sort()).toEqual([
      'create_customer.property.test.ts',
      'log_out.property.test.ts',
      'property-runner.ts',
      'schema-arbitrary.ts',
      'submit_code.property.test.ts',
    ]);
  });

  it('runs as generated, with no change, and reports its properties', () => {
    const outDir = join(dir, 'out');
    const run = spawnSync(
      process.execPath,
      [join(workspaceRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--root', outDir],
      { cwd: outDir, encoding: 'utf-8', timeout: 120000 }
    );
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.status, output).toBe(0);
    // Two properties per action, three actions
    expect(output).toContain('6 passed');
    expect(output).toContain('[create_customer] 2 passing properties, 0 failing');
    expect(output).toContain('[submit_code] 2 passing properties, 0 failing');
    expect(output).toContain('[log_out] 2 passing properties, 0 failing');
  }, 150000);
});
