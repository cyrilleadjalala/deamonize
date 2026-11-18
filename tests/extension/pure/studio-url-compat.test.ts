// Feature: user-journey-improvements, compatibility of the extension URL (Requirements 18.5, 18.14)
import { describe, expect, it } from 'vitest';
import { parseWorkflows } from '../../../kiro-extension/src/core/studio-api';
import { buildBrowserUrl, TARGET_NAME_RE, type StudioTarget } from '../../../kiro-extension/src/core/studio-url';

const H = { origin: 'http://127.0.0.1:45678', token: 'T0KEN-for-compat-tests-0123456789abcdef' };

describe('buildBrowserUrl without a target', () => {
  it('returns exactly the URL of before for every existing route', () => {
    const before: Array<[Parameters<typeof buildBrowserUrl>[1], string]> = [
      [undefined, `http://127.0.0.1:45678/?token=${H.token}`],
      ['overview', `http://127.0.0.1:45678/?token=${H.token}`],
      ['playground', `http://127.0.0.1:45678/?token=${H.token}#/playground`],
      ['credentials', `http://127.0.0.1:45678/?token=${H.token}#/credentials`],
    ];
    for (const [route, expected] of before) {
      expect(buildBrowserUrl(H, route)).toBe(expected);
      expect(buildBrowserUrl(H, route, undefined)).toBe(expected);
    }
  });

  it('adds the workflows route without changing the others', () => {
    expect(buildBrowserUrl(H, 'workflows')).toBe(`http://127.0.0.1:45678/?token=${H.token}#/workflows`);
  });
});

/** The decision of daemonize.testInStudio for a workflow list, as the command makes it. */
function targetFor(body: unknown, id: string): StudioTarget | undefined {
  const found = parseWorkflows(body)?.find((w) => w.id === id);
  if (!found) return undefined;
  if (found.toolName === undefined) return { kind: 'workflow', id };
  return TARGET_NAME_RE.test(found.toolName) ? { kind: 'tool', name: found.toolName } : undefined;
}

describe('a Workflow_File recorded before this change', () => {
  const old = { id: 'w1', label: 'Old', risk: { highest: 'read' } };
  const fresh = { ...old, toolName: 'old_tool', extra: { anything: true } };

  it('reads the same id and gives the same decision for the three cases as a new one', () => {
    // Case 1: no tool name yet -> the workflow page. Same for a toolName that is an empty string.
    expect(targetFor({ workflows: [old] }, 'w1')).toEqual({ kind: 'workflow', id: 'w1' });
    expect(targetFor({ workflows: [{ ...old, toolName: '' }] }, 'w1')).toEqual({ kind: 'workflow', id: 'w1' });
    // Case 2: a tool name -> the Playground with the tool.
    expect(targetFor({ workflows: [fresh] }, 'w1')).toEqual({ kind: 'tool', name: 'old_tool' });
    // Case 3: unknown id -> no target.
    expect(targetFor({ workflows: [old, fresh] }, 'nope')).toBeUndefined();
    // The URLs for the three cases.
    expect(buildBrowserUrl(H, 'playground', targetFor({ workflows: [old] }, 'w1'))).toContain('#/workflows/w1');
    expect(buildBrowserUrl(H, 'playground', targetFor({ workflows: [fresh] }, 'w1'))).toContain('#/playground?tool=old_tool');
    expect(buildBrowserUrl(H, 'playground', targetFor({ workflows: [old] }, 'nope'))).toBe(buildBrowserUrl(H, 'playground'));
  });
});
