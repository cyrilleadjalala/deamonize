// Feature: kiro-global-connect-vault-bridge, Property 5: Install is idempotent
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { join } from 'node:path';
import { configArb, fullInstall, kiroDirOf, mcpPathOf, readIfThere, renderConfig, scopeArb, skillDirOf, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 5: Install is idempotent', () => {
  it('a second install gives the same bytes and keeps the backup and the record', async () => {
    // **Validates: Requirements 3.10**
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), async (scope, config) => {
        await withHarness(async (h) => {
          if (config !== undefined) await writeSettings(kiroDirOf(h, scope), renderConfig(config));
          const state = async () => ({
            mcp: await readIfThere(mcpPathOf(h, scope)),
            skill: await readIfThere(join(skillDirOf(h, scope), 'SKILL.md')),
            backup: await readIfThere(mcpPathOf(h, scope) + '.bak'),
            records: await h.records.list(),
          });
          await fullInstall(h, scope);
          const once = await state();
          h.clock.t += 60_000; // a later second would change `installedAt` if the record were rewritten
          await fullInstall(h, scope);
          const twice = await state();
          expect(twice.mcp?.equals(once.mcp as Buffer)).toBe(true);
          expect(twice.skill?.equals(once.skill as Buffer)).toBe(true);
          expect(twice.backup).toEqual(once.backup);
          expect(twice.records).toEqual(once.records);
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
