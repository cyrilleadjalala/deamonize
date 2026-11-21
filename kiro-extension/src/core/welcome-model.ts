import { S } from './strings';
export interface WelcomeState {
  cliFound: boolean;
  browserMissing: boolean;
  actionCount: number;
  installCount: number;
}
export type WelcomeId = 'install' | 'first-action' | 'browser-missing' | 'none';
/** Keys of the extension's global state (never a workspace file). */
export const FIRST_RUN_KEY = 'daemonize.walkthroughShown';
export const BROWSER_CHECK_KEY = 'daemonize.browserCheck';
/** Pure: the same input gives the same answer. */
export function welcomeFor(state: WelcomeState): WelcomeId {
  if (!state.cliFound) return 'install';
  if (state.actionCount > 0) return 'none';
  return state.browserMissing ? 'browser-missing' : 'first-action';
}
export type WelcomePart = { kind: 'text'; text: string } | { kind: 'button'; label: string; command: string };
/** The text and the buttons of each welcome entry, in the order they are shown, from the one list of texts. */
export function welcomeContent(id: WelcomeId): WelcomePart[] | undefined {
  const text = (value: string): WelcomePart => ({ kind: 'text', text: value });
  const button = (label: string, command: string): WelcomePart => ({ kind: 'button', label, command });
  const firstAction = [
    text(S.welcomeFirstAction),
    button(S.newAction, 'daemonize.newAction'),
    button(S.buildWithAgent, 'daemonize.buildWithAgent'),
  ];
  switch (id) {
    case 'install':
      return [text(S.welcomeInstall), button(S.installDaemonize, 'daemonize.installCli')];
    case 'first-action':
      return firstAction;
    case 'browser-missing':
      return [text(S.browserMissing), button(S.checkAgain, 'daemonize.checkBrowser'), ...firstAction];
    default:
      return undefined;
  }
}
/** The `viewsWelcome` markdown of an entry: sentences, and buttons as command links. */
export function renderWelcome(id: WelcomeId): string | undefined {
  return welcomeContent(id)?.map((p) => (p.kind === 'text' ? p.text : `[${p.label}](command:${p.command})`)).join('\n');
}