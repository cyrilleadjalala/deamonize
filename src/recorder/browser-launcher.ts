/** Group G1 owns this file. Stub: the final types and a launcher that is not implemented yet. */
import type { Browser } from 'playwright';

export type BrowserUsed = 'chromium' | 'chrome' | 'msedge' | 'custom';
export type LaunchFn = (options: { headless: boolean; executablePath?: string; channel?: 'chrome' | 'msedge' }) => Promise<Browser>;
export interface LaunchedBrowser {
  browser: Browser;
  used: BrowserUsed;
  label: string;
}
export class BrowserLaunchError extends Error {
  readonly used?: BrowserUsed;
}

export function isNotInstalled(_error: unknown): boolean {
  return false;
}

export async function launchBrowser(_options: { headless?: boolean; env?: NodeJS.ProcessEnv; launch?: LaunchFn } = {}): Promise<LaunchedBrowser> {
  throw new BrowserLaunchError('not implemented');
}