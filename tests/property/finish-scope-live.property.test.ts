// Feature: user-journey-improvements, Property 31: Install scope resolution (recorder part)
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

function fakePage() {
  const bindings = new Map<string, (source: unknown, arg?: unknown) => unknown>();
  const frame = { page: () => page, parentFrame: () => null };
  const page = {
    exposeBinding: async (name: string, fn: (source: unknown, arg?: unknown) => unknown) => { bindings.set(name, fn); },
    addInitScript: async () => { },
    evaluate: async () => { },
    frames: () => [],
    url: () => 'http://example.test/',
    on: () => { },
    mainFrame: () => frame,
    context: () => ({}),
  };
  return { page: page as unknown as Page, bindings, frame };
}

const intentArb = fc.oneof(fc.constantFrom('save', 'test', 'kiro'), fc.constantFrom('Kiro', 'finish', '', 1, null, undefined));
const scopeArb = fc.oneof(
  fc.constantFrom('global', 'project'),
  fc.constantFrom('Global', 'PROJECT', 'all', '', ' global', 'global ', 0, 1, null, undefined, true, {}, ['global']),
  fc.string({ maxLength: 8 }),
);
const requestArb = fc.record({ intent: intentArb, scope: scopeArb }, { requiredKeys: [] });

describe('Property 31: Install scope resolution (recorder part)', () => {
  /** **Validates: Requirements 19.3, 19.4, 19.5, 19.6, 19.7** */
  it('exposes finishScope only for intent kiro with exactly "global" or "project", and the first request decides', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(requestArb, { minLength: 1, maxLength: 4 }), async (requests) => {
        const fake = fakePage();
        const live = new LiveRecorder(fake.page, new WorkflowRecorder('Property'));
        await live.attach();
        const finish = fake.bindings.get('__daemonizeFinish')!;
        for (const request of requests) expect(await finish({ frame: fake.frame }, request)).toEqual({ ok: true });

        // After the session has ended, later requests change nothing: the first request ended it
        const deciding = requests[0];
        const decidingKnown = ['save', 'test', 'kiro'].includes(deciding.intent as string);
        const intent = decidingKnown ? deciding.intent : 'save';
        const scope = decidingKnown && deciding.intent === 'kiro' && (deciding.scope === 'global' || deciding.scope === 'project') ? deciding.scope : undefined;
        expect(live.finishIntent).toBe(intent);
        expect(live.finishScope).toBe(scope);
        if (live.finishIntent !== 'kiro') expect(live.finishScope).toBeUndefined();
        await expect(live.ended).resolves.toBe('panel');
      }),
      { numRuns: 100 },
    );
  });

  it('keeps an absent scope unset, and the panel state offers the choice only with the Kiro folder', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (kiroHomeExists) => {
        const fake = fakePage();
        const live = new LiveRecorder(fake.page, new WorkflowRecorder('Property'), { kiroHomeExists });
        await live.attach();
        expect(live.panelState().kiroHomeExists).toBe(kiroHomeExists);
        expect(live.finishScope).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
