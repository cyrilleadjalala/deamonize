import type * as vscode from 'vscode';
import type { Controller } from './controller';

/**
 * Sets the context keys `daemonize.cliFound`, `daemonize.browserMissing`, `daemonize.actionCount` and
 * `daemonize.installCount` that the welcome entries and the walkthrough read. G0 seam: sets nothing; group G-E3 fills it.
 */
export function registerContextKeys(_controller: Controller): vscode.Disposable[] {
  return [];
}
