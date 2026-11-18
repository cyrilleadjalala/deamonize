import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isBrowserMissing, launchReplayBrowser, NO_BROWSER_MESSAGE, type LaunchOptions } from '../../src/replay/runtime/browser-launch.js';

type Outcome = 'ok' | 'missing' | 'other';
const MISSING = ["browserType.launch: Executable doesn't exist at /x", "Chromium distribution 'chrome' is not found at /x", "Chromium distribution 'msedge' is not found at /x"];

function fake(outcomes: Outcome[]) {
  const calls: LaunchOptions[] = [];
  const launcher = {
    launch: async (options: LaunchOptions) => {
      const index = calls.push(options) - 1;
      const outcome = outcomes[index] ?? 'missing';
      if (outcome === 'ok') return { index };
      throw new Error(outcome === 'missing' ? MISSING[index] ?? MISSING[0] : 'browserType.launch: boom');
    },
  };
  return { launcher, calls };
}

// Feature: kiro-thin-extension, Property 21: The replay launcher follows the attempt chain
describe('Property 21: The replay launcher follows the attempt chain', () => {
  it('**Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.10** tries bundled, chrome, msedge and stops on a non-missing error', async () => {
    const channels = [undefined, 'chrome', 'msedge'];
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.constantFrom<Outcome>('ok', 'missing', 'other'), fc.constantFrom<Outcome>('ok', 'missing', 'other'), fc.constantFrom<Outcome>('ok', 'missing', 'other')),
        fc.boolean(),
        async (outcomes, inContainer) => {
          const { launcher, calls } = fake(outcomes);
          const env = inContainer ? { DAEMONIZE_IN_CONTAINER: '1' } : {};
          const stop = outcomes.findIndex((o) => o !== 'missing');
          const result = await launchReplayBrowser(launcher, env).then((b) => b, (e: Error) => e);
          if (stop === -1) {
            expect(result).toBeInstanceOf(Error);
            expect((result as Error).message).toBe(NO_BROWSER_MESSAGE);
            expect(calls).toHaveLength(3);
          } else if (outcomes[stop] === 'ok') {
            expect(result).toEqual({ index: stop });
            expect(calls).toHaveLength(stop + 1);
          } else {
            expect((result as Error).message).toBe('browserType.launch: boom');
            expect(calls).toHaveLength(stop + 1);
          }
          calls.forEach((call, i) => {
            expect(call.channel).toBe(channels[i]);
            expect(call.headless).toBe(true);
            expect(call.executablePath).toBeUndefined();
            expect(call.args).toEqual(inContainer ? ['--no-sandbox'] : []);
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('**Validates: Requirements 15.2** uses DAEMONIZE_CHROMIUM_PATH alone, without fallback', async () => {
    const { launcher, calls } = fake(['missing', 'ok', 'ok']);
    await expect(launchReplayBrowser(launcher, { DAEMONIZE_CHROMIUM_PATH: '/opt/b' })).rejects.toThrow(/exist/);
    expect(calls).toEqual([{ headless: true, executablePath: '/opt/b', args: [] }]);
  });

  it('**Validates: Requirements 15.3, 15.4, 15.5, 15.6** bundled, Chrome and Edge scenarios', async () => {
    expect(await launchReplayBrowser(fake(['ok']).launcher, {})).toEqual({ index: 0 });
    expect(await launchReplayBrowser(fake(['missing', 'ok']).launcher, {})).toEqual({ index: 1 });
    expect(await launchReplayBrowser(fake(['missing', 'missing', 'ok']).launcher, {})).toEqual({ index: 2 });
    await expect(launchReplayBrowser(fake(['missing', 'missing', 'missing']).launcher, {})).rejects.toThrow(NO_BROWSER_MESSAGE);
  });

  it('only a not installed error counts as missing', () => {
    expect(isBrowserMissing(new Error(MISSING[0]))).toBe(true);
    expect(isBrowserMissing(new Error('boom'))).toBe(false);
  });
});
