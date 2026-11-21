/**
 * Requirements 4.2, 7.11, 10.9, 24.3: a set that uses none of the new features compiles to the same generated
 * code as before (the regression snapshot), and a set with a click on a checkbox and no `check` step is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compiler, type CompileOptions } from '../../src/compiler/compiler.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { usesWorkflowCall } from '../../src/workflow/workflow-scope.js';
import { OPTION_SETS, SNAPSHOT_TEXTS } from '../helpers/regression-snapshot.js';
import { removeDir } from '../helpers/cleanup.js';
import type { WorkflowSet } from '../../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'regression');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

async function compile(set: WorkflowSet, options: CompileOptions): Promise<{ dir: string; read: (name: string) => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-gencompat-'));
  const log = console.log;
  console.log = () => undefined;
  try {
    await new Compiler().compile(structuredClone(set), dir, options);
  } finally {
    console.log = log;
  }
  return { dir, read: async (name) => lf(await readFile(join(dir, name), 'utf-8')) };
}

describe('generated code of a set that uses none of the new features', () => {
  for (const [name, file] of [
    ['web', 'pre-change.workflows.json'],
    ['tui', 'pre-change-tui.workflows.json'],
  ] as const) {
    for (const [optionName, options] of Object.entries(OPTION_SETS)) {
      it(`${name} / ${optionName}: no call parameter, text equal to the snapshot, sandbox copy list differs by omission.js only`, async () => {
        const set = deserializeWorkflowSet(await readFile(join(FIXTURES, file), 'utf-8'));
        expect(usesWorkflowCall(set)).toBe(false);
        const out = await compile(set, options);
        try {
          for (const text of SNAPSHOT_TEXTS) {
            // Only the lines of the firewall change (ending with //#fw) are added to an old set
            const generated = (await out.read(text)).split('\n').filter((line) => !line.trimEnd().endsWith('//#fw')).join('\n');
            const stored = lf(await readFile(join(FIXTURES, 'snapshot', `${name}.${optionName}.${text}.txt`), 'utf-8'));
            expect(generated, text).toBe(stored);
            expect(generated).not.toMatch(/WorkflowCall|omission|skippedSet|skippedSteps/);
          }
          const image = JSON.parse(await out.read('sandbox/image.json')) as { copy: string[] };
          const snapshot = JSON.parse(await readFile(join(FIXTURES, 'snapshot', `${name}.json`), 'utf-8')) as {
            options: Record<string, { sandboxImage: { copy: string[] } }>;
          };
          const before = snapshot.options[optionName].sandboxImage.copy;
          expect(image.copy.filter((entry) => entry !== 'omission.js' && entry !== 'trace.js')).toEqual(before);
          expect(image.copy).toContain('omission.js');
          expect((await out.read('omission.ts')).length).toBeGreaterThan(0);
        } finally {
          await removeDir(out.dir);
        }
      });
    }
  }

  it('a click on a checkbox with no check step gives the same code as before', async () => {
    const base: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Compat',
      startUrl: 'http://localhost:8080/',
      workflows: [
        {
          id: 'a1111111-1111-4111-8111-111111111111',
          label: 'Accept',
          steps: [{ actionType: 'click', selectors: ['input[type=checkbox]'], label: 'Accept terms' }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
    const first = await compile(base, {});
    const second = await compile(base, { http: 'auto' });
    try {
      for (const name of ['mcp-server.ts', 'replay.ts', 'docker-replay.ts']) {
        expect(await first.read(name)).not.toMatch(/WorkflowCall|omission/);
        expect(await second.read(name)).not.toMatch(/WorkflowCall|omission|skippedSet/);
      }
      expect(await first.read('replay.ts')).not.toContain('"check"');
    } finally {
      await removeDir(first.dir);
      await removeDir(second.dir);
    }
  });
});
