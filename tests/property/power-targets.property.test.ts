// Feature: kiro-global-connect-vault-bridge, Property 2: Targets lie inside the allowed root
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { join, resolve } from 'node:path';
import { targetPaths } from '../../src/studio/power-config.js';
import { inside } from '../../src/studio/power-fs.js';

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,47}$/);
const segment = fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/);
const base = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => resolve(join(process.cwd(), 'fake-root', ...parts)));

describe('Property 2: Targets lie inside the allowed root', () => {
  /** **Validates: Requirements 2.5, 2.6, 2.7, 2.9, 2.10** */
  it('every target is the exact path under <root>/.kiro and inside it', () => {
    fc.assert(
      fc.property(fc.constantFrom('global' as const, 'project' as const), base, slug, (scope, parent, name) => {
        const root = join(parent, '.kiro');
        const t = targetPaths(scope, root, name);
        expect(t.mcp).toBe(join(root, 'settings', 'mcp.json'));
        expect(t.backup).toBe(join(root, 'settings', 'mcp.json.bak'));
        expect(t.skill).toBe(join(root, 'skills', name, 'SKILL.md'));
        for (const p of [t.mcp, t.backup, t.skill, t.skillDir]) expect(inside(p, root)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  /** **Validates: Requirements 2.9, 2.10** */
  it('rejects paths outside the root: parent, siblings with the same prefix, dot-dot escapes', () => {
    fc.assert(
      fc.property(base, segment, (parent, extra) => {
        const root = join(parent, '.kiro');
        expect(inside(parent, root)).toBe(false);
        expect(inside(root + extra, root)).toBe(false); // same prefix, different folder
        expect(inside(resolve(root, '..', extra), root)).toBe(false);
        expect(inside(resolve(root, 'settings', '..', '..', extra), root)).toBe(false);
        expect(inside(join(root, extra), root)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
