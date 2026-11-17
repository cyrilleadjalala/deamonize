// Feature: kiro-global-connect-vault-bridge, Property 7: Backup fidelity and record content
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { join } from 'node:path';
import { sha256 } from '../../src/studio/power-config.js';
import { SERVER, configArb, fullInstall, kiroDirOf, mcpPathOf, readIfThere, renderConfig, scopeArb, skillDirOf, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 7: Backup fidelity and record content', () => {
  it('copies the exact previous bytes and stores a record with the hash of the written bytes', async () => {
    // **Validates: Requirements 3.6, 4.7**
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), async (scope, config) => {
        await withHarness(async (h) => {
          const original = config === undefined ? undefined : renderConfig(config);
          if (original !== undefined) await writeSettings(kiroDirOf(h, scope), original);
          await fullInstall(h, scope);
          const mcp = mcpPathOf(h, scope);
          const backup = await readIfThere(mcp + '.bak');
          const [record, ...more] = await h.records.list();
          expect(more).toEqual([]);
          expect(record?.scope).toBe(scope);
          expect(record?.slug).toBe(SERVER);
          expect(record?.kiroPath).toBe(kiroDirOf(h, scope));
          expect(record?.skillDir).toBe(skillDirOf(h, scope));
          expect(record?.configSha256).toBe(sha256((await readIfThere(mcp)) as Buffer));
          expect(record?.written).toContain(mcp);
          expect(record?.written).toContain(join(skillDirOf(h, scope), 'SKILL.md'));
          if (original === undefined) {
            expect(backup).toBeUndefined();
            expect(record?.backup).toBe(false);
          } else {
            expect(backup?.toString('utf-8')).toBe(original);
            expect(record?.backup).toBe(true);
            expect(record?.written).toContain(mcp + '.bak');
          }
          // A later real install of the same application and scope replaces the record
          h.stored.add('PASSWORD');
          await fullInstall(h, scope);
          const again = await h.records.list();
          expect(again).toHaveLength(1);
          expect(again[0]?.configSha256).toBe(sha256((await readIfThere(mcp)) as Buffer));
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
