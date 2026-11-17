import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Browser } from 'playwright';
import { BrowserLaunchError, launchBrowser, type LaunchFn } from '../../src/recorder/browser-launcher.js';

type Outcome = 'ok' | 'missing' | 'other';
const MESSAGES: Record<string, string> = {
  missing0: "browserType.launch: Executable doesn't exist at /x",
  missingchrome: "browserType.launch: Chromium distribution 'chrome' is not found at /x",
  missingmsedge: "browserType.launch: Chromium distribution 'msedge' is not found at /x",
};
const EXPECTED = [{}, { channel: 'chrome' }, { channel: 'msedge' }];

// Feature: studio-first-flow, Property 16: The Browser_Launcher attempt order
describe('Property 16: The Browser_Launcher attempt order', () => {
  it('**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7** without a custom path', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.constantFrom<Outcome>('ok', 'missing', 'other'), fc.constantFrom<Outcome>('ok', 'missing', 'other'), fc.constantFrom<Outcome>('ok', 'missing', 'other')),
        fc.boolean(),
        fc.constantFrom(undefined, ''),
        async (outcomes, headless, emptyPath) => {
          const calls: Array<Parameters<LaunchFn>[0]> = [];
          const launch: LaunchFn = async (options) => {
            const index = calls.push(options) - 1;
            const outcome = outcomes[index];
            if (outcome === 'ok') return {} as Browser;
            const key = index === 0 ? 'missing0' : `missing${EXPECTED[index].channel}`;
            throw new Error(outcome === 'missing' ? MESSAGES[key] : 'browserType.launch: boom');
          };
          const env = emptyPath === undefined ? {} : { DAEMONIZE_CHROMIUM_PATH: emptyPath };
          const result = await launchBrowser({ headless, env, launch }).then(
            (r) => r,
            (e: unknown) => e as BrowserLaunchError
          );

          // The attempts are a prefix of the fixed order, each with headless, and never a path
          expect(calls.length).toBeGreaterThanOrEqual(1);
          expect(calls.length).toBeLessThanOrEqual(3);
          calls.forEach((call, i) => expect(call).toEqual({ headless, ...EXPECTED[i] }));
          // It stops at the first outcome that is not "missing"
          const stop = outcomes.findIndex((o) => o !== 'missing');
          expect(calls.length).toBe(stop === -1 ? 3 : stop + 1);
          if (stop !== -1 && outcomes[stop] === 'ok') {
            expect(result).toMatchObject({ used: ['chromium', 'chrome', 'msedge'][stop] });
          } else {
            expect(result).toBeInstanceOf(BrowserLaunchError);
            const message = (result as Error).message;
            if (stop === -1) expect(message).toMatch(/Google Chrome.*Microsoft Edge.*DAEMONIZE_CHROMIUM_PATH/);
            else expect(message).toContain(['Chromium', 'Google Chrome', 'Microsoft Edge'][stop]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('**Validates: Requirements 5.1, 5.2** makes exactly one attempt with a custom path, whatever happens', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Outcome>('ok', 'missing', 'other'), fc.stringMatching(/^[a-z/]{1,20}$/), fc.boolean(), async (outcome, path, headless) => {
        const calls: Array<Parameters<LaunchFn>[0]> = [];
        const launch: LaunchFn = async (options) => {
          calls.push(options);
          if (outcome === 'ok') return {} as Browser;
          throw new Error(outcome === 'missing' ? MESSAGES.missing0 : 'browserType.launch: boom');
        };
        const result = await launchBrowser({ headless, env: { DAEMONIZE_CHROMIUM_PATH: path }, launch }).catch((e: unknown) => e as Error);
        expect(calls).toEqual([{ headless, executablePath: path }]);
        if (outcome !== 'ok') expect((result as Error).message).toContain(`DAEMONIZE_CHROMIUM_PATH (${path})`);
      }),
      { numRuns: 100 }
    );
  });
});
