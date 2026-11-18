/**
 * Requirements 1.7, 1.8 (and 1.9, 1.10 for suggestions).
 * Feature: user-journey-improvements, Property 3: Description lead and limits (lead part)
 */
import { describe, expect, it } from 'vitest';
import { describeTool } from '../../src/compiler/tool-description.js';
import { applySuggestions } from '../../src/suggest/apply.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

const base = (extra: Partial<Workflow> = {}): Workflow => ({
  id: 'a1111111-1111-4111-8111-111111111111',
  label: 'Create customer',
  steps: [{ actionType: 'click', selectors: ['#go'] }],
  variables: [],
  observedPayloads: [],
  inputSchema: { type: 'object', properties: { email: { type: 'string', description: 'Customer e-mail' } }, required: ['email'] },
  ...extra,
});

describe('the lead of the tool description (Property 3, lead part)', () => {
  it('is the trimmed description of the workflow when it is not empty', () => {
    expect(describeTool(base({ description: '  Adds a customer to the book.  ' }))).toMatch(/^Adds a customer to the book\. Inputs: email \(Customer e-mail\)\./);
  });

  it.each(['', '   ', '\n\t '])('is the label when the description is %j', (description) => {
    expect(describeTool(base({ description }))).toBe(describeTool(base()));
    expect(describeTool(base({ description }))).toMatch(/^Create customer\. Inputs: email/);
  });
});

describe('an accepted suggestion over a description of the user (Requirement 1.8)', () => {
  const set = (description?: string): WorkflowSet => ({
    version: '1',
    targetType: 'web',
    targetName: 'App',
    startUrl: 'https://app.test/',
    workflows: [base(description === undefined ? {} : { description })],
  });
  const entries = (id: string) => ({
    version: '1' as const,
    source: 'deterministic' as const,
    workflows: [{ id, accepted: true, description: 'A suggested sentence.' }],
  });

  it('keeps the text of the user and records a skipped line', () => {
    const input = set('Written by me');
    const result = applySuggestions(input, entries(input.workflows[0].id));
    expect(result.set.workflows[0].description).toBe('Written by me');
    expect(result.skipped.join('\n')).toContain('description kept');
    expect(result.applied.join('\n')).not.toContain('description');
  });

  it.each([undefined, '', '   '])('applies the suggestion when the description is %j', (description) => {
    const input = set(description);
    const result = applySuggestions(input, entries(input.workflows[0].id));
    expect(result.set.workflows[0].description).toBe('A suggested sentence.');
  });
});
