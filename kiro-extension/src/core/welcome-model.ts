/** G0 seam: types and signature are final; the body belongs to group G-E3. */
export interface WelcomeState {
  cliFound: boolean;
  browserMissing: boolean;
  actionCount: number;
  installCount: number;
}
export type WelcomeId = 'install' | 'first-action' | 'browser-missing' | 'none';

/** Pure: the same input gives the same answer. */
export function welcomeFor(_state: WelcomeState): WelcomeId {
  throw new Error('not implemented: G-E3');
}
