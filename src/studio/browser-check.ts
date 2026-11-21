/**
 * The browser check of the Studio: starts the same launch chain as a replay, closes the browser at once and answers a name.
 * G0 stub (inert); group G-O replaces the body and keeps the signature.
 */
import type { BrowserCheck } from './contracts.js';
import { InertBrowserCheck } from './inert-services.js';

export interface BrowserCheckDeps {
  env: Record<string, string | undefined>;
  now?: () => number;
}

export function createBrowserCheck(_deps: BrowserCheckDeps): BrowserCheck {
  return new InertBrowserCheck();
}
