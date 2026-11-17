// Feature: kiro-global-connect-vault-bridge, Property 8: Confirmation binding
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PowerError } from '../../src/studio/contracts.js';
import { previewRequest, scopeArb, snapshotTree, withHarness } from '../helpers/power-fixture.js';

type Change = 'scope' | 'path' | 'slug' | 'unknown-id' | 'reuse' | 'expired';

describe('Property 8: Confirmation binding', () => {
  it('any single change, reuse, expiry or unknown id gives 409 and writes nothing; another confirmation stays usable', async () => {
    // **Validates: Requirements 3.3, 3.4**
    await fc.assert(
      fc.asyncProperty(
        scopeArb,
        fc.constantFrom<Change>('scope', 'path', 'slug', 'unknown-id', 'reuse', 'expired'),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (scope, change, noise, extra) => {
          await withHarness(async (h) => {
            const other = scope === 'global' ? 'project' : 'global';
            const bystander = await h.installer.preview(previewRequest(h, other));
            const preview = await h.installer.preview(previewRequest(h, scope));
            let request = { confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope };
            if (change === 'scope') request = { ...request, scope: other };
            if (change === 'path') request = { ...request, kiroPath: preview.kiroPath + noise };
            if (change === 'unknown-id') request = { ...request, confirmationId: `id-${noise}` };
            if (change === 'slug') h.app.slug = 'another-app';
            if (change === 'expired') h.clock.t += 600_000 + extra; // the lifetime is 600 s
            if (change === 'reuse') {
              await h.installer.install(request);
              h.stored.add('PASSWORD'); // a real second install would write again if it were accepted
            }
            const before = await snapshotTree(h.base);
            const error = await h.installer.install(request).then(() => undefined, (e: unknown) => e);
            expect(error).toBeInstanceOf(PowerError);
            expect((error as PowerError).status).toBe(409);
            expect(await snapshotTree(h.base)).toEqual(before);
            if (change === 'slug') h.app.slug = h.slug;
            if (change === 'expired') return; // the bystander expired with it
            const done = await h.installer.install({ confirmationId: bystander.confirmationId, kiroPath: bystander.kiroPath, scope: other });
            expect(done.scope).toBe(other);
          });
        }
      ),
      { numRuns: 100 }
    );
  }, 180_000);
});
