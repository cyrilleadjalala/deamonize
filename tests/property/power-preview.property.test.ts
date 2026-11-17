// Feature: kiro-global-connect-vault-bridge, Property 3: Preview is complete and read-only
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVER, configArb, kiroDirOf, previewRequest, renderConfig, scopeArb, snapshotTree, withHarness, writeSettings } from '../helpers/power-fixture.js';

describe('Property 3: Preview is complete and read-only', () => {
  it('lists scope, path, outcomes, replacement and backup, and changes no byte', async () => {
    // **Validates: Requirements 2.8**
    await fc.assert(
      fc.asyncProperty(scopeArb, fc.option(configArb, { nil: undefined }), fc.boolean(), async (scope, config, skillThere) => {
        await withHarness(async (h) => {
          const kiro = kiroDirOf(h, scope);
          if (config !== undefined) await writeSettings(kiro, renderConfig(config));
          if (skillThere) {
            await mkdir(join(kiro, 'skills', SERVER), { recursive: true });
            await writeFile(join(kiro, 'skills', SERVER, 'SKILL.md'), 'old skill');
          }
          const before = await snapshotTree(h.base);
          const preview = await h.installer.preview(previewRequest(h, scope));
          expect(await snapshotTree(h.base)).toEqual(before);
          expect(preview.scope).toBe(scope);
          expect(preview.kiroPath).toBe(kiro);
          expect(preview.serverName).toBe(SERVER);
          expect(preview.files).toEqual([
            { path: 'settings/mcp.json', outcome: config === undefined ? 'create' : 'merge' },
            { path: `skills/${SERVER}/SKILL.md`, outcome: skillThere ? 'replace' : 'create' },
          ]);
          expect(preview.replacesEntry).toBe(config?.withOurs === true);
          expect(preview.backup).toBe(config !== undefined);
          expect(typeof preview.confirmationId).toBe('string');
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
