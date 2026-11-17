// Feature: kiro-global-connect-vault-bridge, Property 13: Name_Map uniqueness and stability
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppNames, mapKey, MAX_SLUG, type AppSource } from '../../src/studio/app-names';
import type { AppData } from '../../src/studio/contracts';

const appDataOf = (dir: string): AppData => ({
  dir,
  ensure: async () => ({ ok: true, dir }),
  check: async () => ({ ok: true, dir }),
});

const label = fc.constantFrom('a', 'ab', 'shop', 'x'.repeat(60), 'x'.repeat(47) + 'y', 'x'.repeat(46) + '-y');
const origin = fc.tuple(label, fc.constantFrom('com', 'org'), fc.constantFrom('http', 'https')).map(([l, tld, scheme]): AppSource => ({ origin: `${scheme}://${l}.${tld}` }));
const named = fc.constantFrom('Shop', 'shop', 'SHOP!', 'a b').map((name): AppSource => ({ name }));

describe('Property 13: Name_Map uniqueness and stability', () => {
  it('gives different keys different slugs and the same key the same slug after a reload', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(origin, named), { minLength: 1, maxLength: 8 }), async (sources) => {
        const dir = await mkdtemp(join(tmpdir(), 'app-names-prop-'));
        try {
          const slugs = new Map<string, string>();
          for (const s of sources) {
            const slug = await createAppNames({ appData: appDataOf(dir) }).ensure(s); // reload from disk each call
            expect(slug.length).toBeLessThanOrEqual(MAX_SLUG);
            const known = slugs.get(mapKey(s));
            if (known !== undefined) expect(slug).toBe(known);
            slugs.set(mapKey(s), slug);
          }
          expect(new Set(slugs.values()).size).toBe(slugs.size);
          const fresh = createAppNames({ appData: appDataOf(dir) });
          for (const s of sources) expect(await fresh.peek(s)).toBe(slugs.get(mapKey(s)));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
