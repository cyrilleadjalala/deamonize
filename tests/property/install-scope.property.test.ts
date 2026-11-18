// Feature: user-journey-improvements, Property 31: Install scope resolution
// **Validates: Requirements 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveInstallScope } from '../../src/studio/install-scope.js';
import { runKiroRecording } from '../helpers/kiro-recording.js';

const anyScope = fc.oneof(
  fc.constantFrom('global', 'project'),
  fc.constant(undefined),
  fc.constant(null),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant({ scope: 'global' }),
);
const expected = (scope: unknown, home: boolean): 'global' | 'project' => (scope === 'project' ? 'project' : home ? 'global' : 'project');

describe('Property 31: Install scope resolution', () => {
  it('resolveInstallScope follows the table for any value', () => {
    fc.assert(
      fc.property(anyScope, fc.boolean(), (scope, home) => {
        expect(resolveInstallScope(scope, home)).toBe(expected(scope, home));
      }),
      { numRuns: 200 },
    );
  });

  it('the manager passes one and the same resolved scope to preview and install', async () => {
    await fc.assert(
      fc.asyncProperty(anyScope, fc.boolean(), fc.boolean(), async (scope, atStart, atInstall) => {
        const r = await runKiroRecording(scope, { homeAtStart: atStart, homeAtInstall: atInstall });
        const want = expected(scope, atInstall);
        expect(r.previews).toEqual([want]);
        expect(r.installs).toEqual([want]);
        expect(r.manager.status().kiro?.scope).toBe(want);
      }),
      { numRuns: 100 },
    );
  });
});
