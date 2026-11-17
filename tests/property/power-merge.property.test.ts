// Feature: kiro-global-connect-vault-bridge, Property 4: Merge preserves everything except the installed entry
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFile } from 'node:fs/promises';
import { SERVER, configArb, fullInstall, kiroDirOf, mcpPathOf, renderConfig, scopeArb, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 4: Merge preserves everything except the installed entry', () => {
  it('keeps every other server and root key, and creates mcpServers alone for a new file', async () => {
    // **Validates: Requirements 2.11, 2.12, 3.8, 3.9**
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), async (scope, config) => {
        await withHarness(async (h) => {
          if (config !== undefined) await writeSettings(kiroDirOf(h, scope), renderConfig(config));
          await fullInstall(h, scope);
          const after = JSON.parse(await readFile(mcpPathOf(h, scope), 'utf-8')) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
          const entry = JSON.parse(await h.installer.snippet()).mcpServers[SERVER];
          expect(after.mcpServers[SERVER]).toEqual(entry);
          if (config === undefined) {
            expect(Object.keys(after)).toEqual(['mcpServers']);
            expect(Object.keys(after.mcpServers)).toEqual([SERVER]);
            return;
          }
          const { mcpServers, ...rest } = after;
          expect(rest).toEqual(config.top);
          expect(mcpServers).toEqual({ ...(config.servers ?? {}), [SERVER]: entry });
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
