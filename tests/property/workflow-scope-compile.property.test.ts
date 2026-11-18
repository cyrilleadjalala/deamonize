// Feature: user-journey-improvements, Property 19: The Compiler resolves start page and login per workflow
// **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 10.11**
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { usesWorkflowCall } from '../../src/workflow/workflow-scope.js';
import type { WorkflowSet } from '../../src/types.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';
import { removeDir } from '../helpers/cleanup.js';

let parent = '';
let counter = 0;
beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'daemonize-scope-'));
});
afterAll(async () => {
  await removeDir(parent);
});

async function refusal(set: WorkflowSet): Promise<{ message: string; out: string }> {
  const out = join(parent, `out-${counter++}`);
  const log = console.log;
  console.log = () => undefined;
  try {
    await new Compiler().compile(set, out);
  } catch (error) {
    return { message: (error as Error).message, out };
  } finally {
    console.log = log;
  }
  throw new Error('the compiler accepted the set');
}

describe('Property 19: The Compiler resolves start page and login per workflow', () => {
  it('the call of each tool holds the start page and login of its workflow, and the code uses the call', () => {
    fc.assert(
      fc.property(workflowSetArb(), (set) => {
        const names = new Map(set.workflows.map((workflow, index) => [workflow.id, `tool_${index}`]));
        const generator = new McpGenerator();
        const server = generator.generate(set, names);
        const replay = generator.generateReplay(set);
        const docker = generator.generateDockerReplay(set, 'img');
        const used = usesWorkflowCall(set);
        expect(replay.includes('call.startUrl ?? START_URL')).toBe(used);
        expect(replay.includes('if (call.storageState === null) return undefined;')).toBe(used);
        expect(docker.includes('resolveHostStorageState(call)')).toBe(used);
        for (const workflow of set.workflows) {
          if (workflow.startUrl !== undefined) expect(server).toContain(`"startUrl":${JSON.stringify(workflow.startUrl)}`);
          if (workflow.storageState === null) expect(server).toContain('"storageState":null');
          else if (workflow.storageState !== undefined) expect(server).toContain(`"storageState":${JSON.stringify(workflow.storageState)}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a workflow start page on another origin is refused with its id, and nothing is written', async () => {
    await fc.assert(
      fc.asyncProperty(workflowSetArb(), fc.constantFrom('https://other.example.net/x', 'http://app.example.com/x', 'https://app.example.com:8443/x'), async (generated, foreign) => {
        const set = structuredClone(generated);
        set.workflows[0].startUrl = foreign;
        const { message, out } = await refusal(set);
        expect(message).toContain(set.workflows[0].id);
        expect(existsSync(out)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('a workflow start page on a terminal target is refused, and nothing is written', async () => {
    await fc.assert(
      fc.asyncProperty(workflowSetArb(), async (generated) => {
        const set = structuredClone(generated);
        const terminal: WorkflowSet = { version: '1', targetType: 'tui', targetName: 'Term', startCommand: ['prog'], workflows: set.workflows };
        for (const workflow of terminal.workflows) {
          workflow.steps = [{ actionType: 'type', selectors: [], value: 'x' }];
          delete workflow.storageState;
        }
        terminal.workflows[0].startUrl = 'https://app.example.com/x';
        const { message, out } = await refusal(terminal);
        expect(message).toContain(terminal.workflows[0].id);
        expect(existsSync(out)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
