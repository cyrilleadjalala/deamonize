// Feature: kiro-global-connect-vault-bridge, Property 9: Install then remove restores the original state
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { SERVER, configArb, fullInstall, kiroDirOf, mcpPathOf, readIfThere, renderConfig, scopeArb, skillDirOf, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 9: Install then remove restores the original state', () => {
  it('leaves mcp.json byte-identical (or absent), no skill folder and no record', async () => {
    // **Validates: Requirements 4.9, 4.10, 4.12**
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), async (scope, config) => {
        await withHarness(async (h) => {
          const original = config === undefined ? undefined : renderConfig(config);
          if (original !== undefined) await writeSettings(kiroDirOf(h, scope), original);
          await fullInstall(h, scope);
          await h.installer.remove({ scope });
          const after = await readIfThere(mcpPathOf(h, scope));
          if (original === undefined) expect(after).toBeUndefined();
          else expect(after?.toString('utf-8')).toBe(original);
          expect(await readIfThere(skillDirOf(h, scope) + '/SKILL.md')).toBeUndefined();
          expect(await h.records.list()).toEqual([]);
          if (config !== undefined) {
            // every other server is still there
            const parsed = JSON.parse(after!.toString('utf-8').replace(/^\uFEFF/, '')) as { mcpServers?: Record<string, unknown> };
            for (const name of Object.keys(config.servers ?? {})) expect(parsed.mcpServers?.[name]).toBeDefined();
          }
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);

  // **Validates: Requirements 4.12**
  it('still succeeds when the server entry or the skill folder was already gone', async () => {
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), fc.boolean(), fc.boolean(), async (scope, config, dropServer, dropSkill) => {
        await withHarness(async (h) => {
          if (config !== undefined) await writeSettings(kiroDirOf(h, scope), renderConfig(config));
          await fullInstall(h, scope);
          if (dropServer) {
            const root = JSON.parse(await readFile(mcpPathOf(h, scope), 'utf-8')) as { mcpServers: Record<string, unknown> };
            delete root.mcpServers[SERVER];
            await writeFile(mcpPathOf(h, scope), JSON.stringify(root));
          }
          if (dropSkill) await rm(skillDirOf(h, scope), { recursive: true, force: true });
          await expect(h.installer.remove({ scope })).resolves.toBeDefined();
          expect(await readIfThere(skillDirOf(h, scope) + '/SKILL.md')).toBeUndefined();
          expect(await h.records.list()).toEqual([]);
          const after = await readIfThere(mcpPathOf(h, scope));
          // Without an outside edit the original bytes come back, even when they held an older entry of ours
          if (dropServer && after !== undefined) expect((JSON.parse(after.toString('utf-8').replace(/^\uFEFF/, '')) as { mcpServers?: Record<string, unknown> }).mcpServers?.[SERVER]).toBeUndefined();
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
