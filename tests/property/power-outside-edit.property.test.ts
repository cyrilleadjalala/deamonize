// Feature: kiro-global-connect-vault-bridge, Property 10: Remove after an outside edit keeps later servers
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFile, writeFile } from 'node:fs/promises';
import { SERVER, configArb, fullInstall, kiroDirOf, mcpPathOf, otherServers, readIfThere, renderConfig, scopeArb, skillDirOf, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 10: Remove after an outside edit keeps later servers', () => {
  it('deletes only our entry, keeps the other servers, keys and the backup, and deletes the skill folder', async () => {
    // **Validates: Requirements 4.9, 4.11**
    await fc.assert(
      fc.asyncProperty(
        scopeArb,
        fc.option(configArb, { nil: undefined }),
        otherServers,
        fc.integer(),
        fc.boolean(),
        async (scope, config, added, marker, keepOurs) => {
          await withHarness(async (h) => {
            if (config !== undefined) await writeSettings(kiroDirOf(h, scope), renderConfig(config));
            await fullInstall(h, scope);
            const mcp = mcpPathOf(h, scope);
            const backupBefore = await readIfThere(mcp + '.bak');
            // The outside edit: later servers, a changed root key, our entry kept or dropped
            const root = JSON.parse(await readFile(mcp, 'utf-8')) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
            const edited: Record<string, unknown> = { ...root, editedLater: marker, mcpServers: { ...root.mcpServers, ...added } };
            if (!keepOurs) delete (edited.mcpServers as Record<string, unknown>)[SERVER];
            await writeFile(mcp, JSON.stringify(edited, null, 2));
            await h.installer.remove({ scope });
            const after = JSON.parse(await readFile(mcp, 'utf-8')) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
            const expectedServers = { ...(edited.mcpServers as Record<string, unknown>) };
            delete expectedServers[SERVER];
            expect(after).toEqual({ ...edited, mcpServers: expectedServers });
            expect(await readIfThere(mcp + '.bak')).toEqual(backupBefore);
            expect(await readIfThere(skillDirOf(h, scope) + '/SKILL.md')).toBeUndefined();
            expect(await h.records.list()).toEqual([]);
          });
        }
      ),
      { numRuns: 100 }
    );
  }, 180_000);
});
