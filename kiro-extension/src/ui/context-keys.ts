import * as vscode from 'vscode';
import * as path from 'node:path';
import { locateCli, type LocatorResult } from '../core/cli-locator';
import { BROWSER_CHECK_KEY } from '../core/welcome-model';
import type { Controller } from './controller';
import { currentFolder } from './controller';
import { buildLocatorInput } from './settings';
/** What the onboarding needs of the `vscode.ExtensionContext`. */
export type OnboardingContext = Pick<vscode.ExtensionContext, 'globalState' | 'globalStorageUri' | 'extension'>;
/** The answer of the browser check, remembered in the global state with the extension version. */
export interface BrowserCheckRecord { version: string; available: boolean }
/** `<globalStorage>/cli`: the folder the extension installs into and the locator looks at second. */
export function cliFolder(context: OnboardingContext): string {
  return path.join(context.globalStorageUri.fsPath, 'cli');
}
export function extensionVersion(context: OnboardingContext): string {
  const version = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return typeof version === 'string' ? version : '0.0.0';
}
export function readBrowserRecord(context: OnboardingContext | undefined): BrowserCheckRecord | undefined {
  const value = context?.globalState.get<BrowserCheckRecord>(BROWSER_CHECK_KEY);
  return value && typeof value.available === 'boolean' && typeof value.version === 'string' ? value : undefined;
}
/** The locator with the extension-owned folder added to the input. */
export function locateWithExtensionFolder(controller: Controller, context: OnboardingContext | undefined): Promise<LocatorResult> {
  const folder = currentFolder();
  const input = buildLocatorInput(folder.kind === 'local' ? folder.path : '', controller.deps.env);
  return locateCli(context ? { ...input, extensionFolder: cliFolder(context) } : input);
}
export function setContextKey(key: string, value: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', key, value);
}
/**
 * Sets the context keys `daemonize.cliFound`, `daemonize.browserMissing`, `daemonize.actionCount` and
 * `daemonize.installCount` that the welcome entries and the walkthrough read.
 */
export function registerContextKeys(controller: Controller, context?: OnboardingContext): vscode.Disposable[] {
  let actionCount = 0;
  let installCount = 0;
  let running = false;
  let again = false;
  const update = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        try {
          const located = await locateWithExtensionFolder(controller, context);
          await setContextKey('daemonize.cliFound', located.kind === 'ok');
          await setContextKey('daemonize.browserMissing', readBrowserRecord(context)?.available === false);
          const workflows = await controller.query((api) => api.workflows());
          if (workflows?.ok) actionCount = workflows.data.length;
          const power = await controller.query((api) => api.powerInfo());
          if (power?.ok) installCount = power.data.installs.length;
          await setContextKey('daemonize.actionCount', actionCount);
          await setContextKey('daemonize.installCount', installCount);
        } catch {
          // A failed refresh keeps the last values; the next refresh tries again.
        }
      } while (again);
    } finally {
      running = false;
    }
  };
  void update();
  return [
    controller.onDidRefresh(() => { void update(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('daemonize')) void update();
    }),
  ] as vscode.Disposable[];
}
