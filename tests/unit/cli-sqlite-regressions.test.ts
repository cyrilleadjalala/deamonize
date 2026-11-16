/**
 * Regressions found by recording the real sqlite3 shell (examples/cli-sqlite, tests/integration/cli-sqlite-e2e.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { tokenizeInput } from '../../src/recorder/key-tokenizer.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';

const set = (variable: Record<string, unknown>): WorkflowSet => ({
  version: '1',
  targetType: 'tui',
  targetName: 'sqlite',
  startCommand: ['sqlite3', 'notes.db'],
  workflows: [
    {
      id: 'b1111111-1111-4111-8111-111111111111',
      label: 'add_note',
      steps: [{ actionType: 'type', selectors: [], variable: 'title', value: 'Sample' }],
      variables: [{ name: 'title', ...variable }],
      observedPayloads: [{ title: 'Sample' }],
    },
  ],
});

describe('a Variable with a pattern and a maximum length', () => {
  it('goes to the input schema, so the server refuses any other value before the replay', () => {
    const annotated = new SchemaInferencer().inferWorkflows(set({ pattern: '^[A-Za-z0-9 ]{1,80}$', maxLength: 80 }));
    const schema = annotated.workflows[0].inputSchema as { properties: Record<string, unknown>; required: string[] };

    expect(schema.properties.title).toMatchObject({ type: 'string', pattern: '^[A-Za-z0-9 ]{1,80}$', maxLength: 80 });
    expect(schema.required).toEqual(['title']);
  });

  it('is read back from a workflow file, and an expression that does not compile is refused at load', () => {
    const json = JSON.stringify(set({ pattern: '^[a-z]+$', maxLength: 5 }));
    expect(deserializeWorkflowSet(json).workflows[0].variables[0]).toMatchObject({ pattern: '^[a-z]+$', maxLength: 5 });

    expect(() => deserializeWorkflowSet(JSON.stringify(set({ pattern: '[unclosed' })))).toThrow(/Invalid regular expression/);
    expect(() => deserializeWorkflowSet(JSON.stringify(set({ maxLength: 0 })))).toThrow();
    expect(() => deserializeWorkflowSet(JSON.stringify(set({ pattern: '' })))).toThrow();
  });
});

describe('what a terminal sends around a pasted text (the readline of sqlite3 enables bracketed paste)', () => {
  it('keeps the pasted text and drops the paste markers', () => {
    expect(tokenizeInput('\x1b[200~select 1;\x1b[201~\r')).toEqual([
      { kind: 'text', text: 'select 1;' },
      { kind: 'key', name: 'Enter' },
    ]);
  });
});
