/**
 * The browser check of the Studio: starts the same launch chain as a replay (`launchReplayBrowser`), closes the browser
 * at once and answers a name, never a path. The answer is cached for 30 s. A launch that fails answers
 * `{ available: false }`, never an error.
 */
import { chromium } from 'playwright';
import { launchReplayBrowser, type LaunchOptions, type Launcher } from '../replay/runtime/browser-launch.js';
import type { BrowserCheck } from './contracts.js';

export const BROWSER_CHECK_CACHE_MS = 30_000;

type Answer = Awaited<ReturnType<BrowserCheck['check']>>;

/** What the check needs of a launched browser. */
export interface ProbeBrowser {
  close(): Promise<void>;
}

export interface BrowserCheckDeps {
  env: Record<string, string | undefined>;
  now?: () => number;
  /** Starts a browser like Playwright's `chromium.launch`. Tests inject a fake. */
  launch?: (options: LaunchOptions) => Promise<ProbeBrowser>;
}

const defaultLaunch = (options: LaunchOptions): Promise<ProbeBrowser> => chromium.launch(options);

function nameOf(options: LaunchOptions): NonNullable<Answer['browser']> {
  if (options.executablePath !== undefined) return 'custom';
  if (options.channel === 'chrome') return 'chrome';
  if (options.channel === 'msedge') return 'edge';
  return 'chromium';
}

export function createBrowserCheck(deps: BrowserCheckDeps): BrowserCheck {
  const now = deps.now ?? Date.now;
  const launch = deps.launch ?? defaultLaunch;
  let cached: { at: number; answer: Answer } | undefined;
  let pending: Promise<Answer> | undefined;

  async function probe(): Promise<Answer> {
    let used: Answer['browser'];
    const launcher: Launcher<ProbeBrowser> = {
      launch: async (options) => {
        const browser = await launch(options);
        used = nameOf(options);
        return browser;
      },
    };
    try {
      const browser = await launchReplayBrowser(launcher, deps.env as NodeJS.ProcessEnv);
      await browser.close().catch(() => undefined);
      return used === undefined ? { available: false } : { available: true, browser: used };
    } catch {
      return { available: false };
    }
  }

  return {
    async check(): Promise<Answer> {
      if (cached !== undefined) {
        const age = now() - cached.at;
        if (age >= 0 && age < BROWSER_CHECK_CACHE_MS) return { ...cached.answer };
      }
      pending ??= probe()
        .then((answer) => {
          cached = { at: now(), answer };
          return answer;
        })
        .finally(() => {
          pending = undefined;
        });
      return { ...(await pending) };
    },
  };
}
