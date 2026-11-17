// Feature: kiro-global-connect-vault-bridge, Property 6: Unusable configuration is refused without any write
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { writeFile } from 'node:fs/promises';
import { parseConfig } from '../../src/studio/power-config.js';
import { PowerError } from '../../src/studio/contracts.js';
import { fullInstall, kiroDirOf, mcpPathOf, previewRequest, scopeArb, snapshotTree, withHarness, writeSettings } from '../helpers/power-fixture.js';

const unusable: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom('', '{', '[]', 'null', '"x"', '5', 'true', '[1,2]'),
  fc.oneof(fc.constant(null), fc.integer(), fc.string({ maxLength: 6 }), fc.array(fc.integer(), { maxLength: 3 })).map((v) => JSON.stringify({ mcpServers: v }))
).filter((text) => !parseConfig(Buffer.from(text, 'utf-8')).ok);

const refused = async (p: Promise<unknown>): Promise<void> => {
  const error = await p.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(PowerError);
  expect((error as PowerError).status).toBe(409);
};

describe('Property 6: Unusable configuration is refused without any write', () => {
  it('preview and install answer 409 and every file keeps its bytes', async () => {
    // **Validates: Requirements 2.13, 3.5**
    await fc.assert(
      fc.asyncProperty(scopeArb, unusable, fc.boolean(), async (scope, text, corruptAfterPreview) => {
        await withHarness(async (h) => {
          if (!corruptAfterPreview) {
            await writeSettings(kiroDirOf(h, scope), text);
            const before = await snapshotTree(h.base);
            await refused(h.installer.preview(previewRequest(h, scope)));
            expect(await snapshotTree(h.base)).toEqual(before);
            return;
          }
          // A valid preview first, then the file turns unusable before the install
          const preview = await h.installer.preview(previewRequest(h, scope));
          await writeSettings(kiroDirOf(h, scope), text);
          const before = await snapshotTree(h.base);
          await refused(h.installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope }));
          expect(await snapshotTree(h.base)).toEqual(before);
          expect(await h.records.list()).toEqual([]);
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);

  it('remove answers 409, changes no byte and keeps the record', async () => {
    // **Validates: Requirements 4.13**
    await fc.assert(
      fc.asyncProperty(scopeArb, unusable, async (scope, text) => {
        await withHarness(async (h) => {
          await fullInstall(h, scope);
          await writeFile(mcpPathOf(h, scope), text);
          const before = await snapshotTree(h.base);
          await refused(h.installer.remove({ scope }));
          expect(await snapshotTree(h.base)).toEqual(before);
          expect(await h.records.list()).toHaveLength(1);
        });
      }),
      { numRuns: 100 }
    );
  }, 180_000);
});
