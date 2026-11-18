// Feature: kiro-thin-extension, Property 4: `requiredSecrets` is the sorted required names and contains every missing name
// **Validates: Requirements 2.1, 2.2**
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FAKE_SECRET_VALUE, SERVER, createHarness, fullInstall, type Harness } from '../helpers/power-fixture.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const secretName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,10}$/);

describe('Property 4: requiredSecrets', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('is the sorted required names and contains every missing name, without any value', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(secretName, { maxLength: 5 }), fc.array(secretName, { maxLength: 6 }), async (required, vault) => {
        const env: Record<string, string> = { DAEMONIZE_MODE: 'strict', OTHER_TOKEN: FAKE_SECRET_VALUE };
        for (const name of required) env[`DAEMONIZE_SECRET_${name}`] = FAKE_SECRET_VALUE;
        await writeFile(join(h.out, 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', command: 'node', args: ['x'], env } } }));
        h.stored.clear();
        for (const name of vault) h.stored.add(name);

        const { preview, result } = await fullInstall(h, 'global');
        const sorted = [...required].sort();
        expect(preview.requiredSecrets).toEqual(sorted);
        expect(result.requiredSecrets).toEqual(sorted);
        for (const name of preview.missingSecrets) expect(preview.requiredSecrets).toContain(name);
        for (const name of result.missingSecrets) expect(result.requiredSecrets).toContain(name);
        expect(JSON.stringify([preview, result])).not.toContain(FAKE_SECRET_VALUE);
      }),
      { numRuns: 100 }
    );
  });
});
