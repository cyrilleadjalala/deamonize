// Feature: kiro-native-agent-and-firewall, Property 27: Ask before changes has a default, a memory and a strict input
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PowerError } from '../../src/studio/contracts.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { SERVER, createHarness, snapshotTree, withHarness, type Harness } from '../helpers/power-fixture.js';

type Risk = 'read' | 'write' | 'delete';
const riskArb = fc.constantFrom<Risk>('read', 'write', 'delete');
const risksArb = fc.array(riskArb, { minLength: 0, maxLength: 6 });
const toRisks = (risks: Risk[]) => risks.map((risk, i) => ({ toolName: `tool_${i}`, risk }));
const notBoolean = fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant([]), fc.constant({}), fc.constantFrom('true', 'false', 'on', 0, 1));

function installerFor(h: Harness, risks: Risk[]) {
  const appData = { dir: h.appDir, ensure: async () => ({ ok: true as const, dir: h.appDir }), check: async () => ({ ok: true as const, dir: h.appDir }) };
  return createPowerInstaller({
    locate: async () => ({ slug: h.app.slug, outDir: h.app.outDir, legacy: false }),
    cwd: h.ws, home: h.home, appData, vault: h.vault, records: h.records, autoAdd: h.autoAddStore, now: () => h.clock.t,
    toolRisks: async () => toRisks(risks),
  });
}
const settings = (h: Harness) => join(h.kiroGlobal, 'settings', 'mcp.json');
const entryEnv = async (h: Harness) => (JSON.parse(await readFile(settings(h), 'utf-8')) as any).mcpServers[SERVER].env as Record<string, string>;

describe('Property 27: Ask before changes has a default, a memory and a strict input', () => {
  it('the default is on if and only if some tool is not read, and the entry says so', async () => {
    // **Validates: Requirements 10.1, 10.2, 10.3**
    await fc.assert(
      fc.asyncProperty(risksArb, async (risks) => {
        await withHarness(async (h) => {
          const installer = installerFor(h, risks);
          const preview = await installer.preview({ scope: 'global' });
          const expected = risks.some((r) => r !== 'read');
          expect(preview.askBeforeChanges).toBe(expected);
          expect(preview.askBeforeChangesTools).toEqual(toRisks(risks).filter((t) => t.risk !== 'read').map((t) => t.toolName).sort());
          expect((preview.askBeforeChangesTools ?? []).length > 0).toBe(expected);
          await installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'global' });
          const env = await entryEnv(h);
          expect(env.DAEMONIZE_ASK_BEFORE_CHANGES).toBe(expected ? 'true' : 'false');
          expect(env.DAEMONIZE_APPROVAL_TIMEOUT_MS).toBe(expected ? '90000' : undefined);
        });
      }),
      { numRuns: 100 }
    );
  }, 120000);

  it('a re-install keeps an explicit choice, and a record without the field reads as off', async () => {
    // **Validates: Requirements 10.4, 10.5**
    await fc.assert(
      fc.asyncProperty(risksArb, fc.boolean(), async (risks, chosen) => {
        await withHarness(async (h) => {
          const installer = installerFor(h, risks);
          const first = await installer.preview({ scope: 'global' });
          await installer.install({ confirmationId: first.confirmationId, kiroPath: first.kiroPath, scope: 'global', askBeforeChanges: chosen });
          const second = await installer.preview({ scope: 'global' });
          expect(second.askBeforeChanges).toBe(chosen);
          await installer.install({ confirmationId: second.confirmationId, kiroPath: second.kiroPath, scope: 'global' });
          expect((await entryEnv(h)).DAEMONIZE_ASK_BEFORE_CHANGES).toBe(String(chosen));
          // A record written before the setting existed
          const [record] = await h.records.list();
          const { askBeforeChanges: _a, askBeforeChangesChosen: _c, ...legacy } = record;
          await h.records.put(legacy);
          expect((await installer.info()).installs[0]?.askBeforeChanges).toBe(false);
        });
      }),
      { numRuns: 100 }
    );
  }, 120000);

  it('a value that is not a boolean answers 400 from install and setApproval and changes no byte', async () => {
    // **Validates: Requirements 10.4, 10.6**
    await fc.assert(
      fc.asyncProperty(risksArb, notBoolean, async (risks, bad) => {
        const h = await createHarness();
        try {
          const installer = installerFor(h, risks);
          const preview = await installer.preview({ scope: 'global' });
          const refused = await installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'global', askBeforeChanges: bad }).then(() => undefined, (e: unknown) => e);
          expect(refused).toBeInstanceOf(PowerError);
          expect((refused as PowerError).status).toBe(400);
          expect(await snapshotTree(h.kiroGlobal)).toEqual([]);
          expect(await h.records.list()).toEqual([]);

          await installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope: 'global' });
          const tree = await snapshotTree(h.kiroGlobal);
          const records = await h.records.list();
          const refusedToggle = await installer.setApproval!({ scope: 'global', askBeforeChanges: bad }).then(() => undefined, (e: unknown) => e);
          expect((refusedToggle as PowerError).status).toBe(400);
          expect(await snapshotTree(h.kiroGlobal)).toEqual(tree);
          expect(await h.records.list()).toEqual(records);
        } finally {
          await h.cleanup();
        }
      }),
      { numRuns: 100 }
    );
  }, 120000);
});
