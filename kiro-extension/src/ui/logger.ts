import * as vscode from 'vscode';
import type { Redactor } from '../core/ports';
import { S } from '../core/strings';

export interface Logger {
  /** A line from the Studio process stderr. Redacted first. There is no stdout path. */
  logStderr(line: string): void;
  /** A line written by the extension itself (for example a failed-request line). Redacted first. */
  log(line: string): void;
  show(): void;
  dispose(): void;
}

export function createLogger(redact: Redactor): Logger {
  const channel = vscode.window.createOutputChannel(S.logChannel);
  const write = (line: string): void => { channel.appendLine(redact(line)); };
  return {
    logStderr: write,
    log: write,
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
