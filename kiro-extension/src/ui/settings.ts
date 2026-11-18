import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FsPort, LocatorInput } from '../core/cli-locator';

export interface DaemonizeSettings { cliPath: string; nodePath: string }

export function readSettings(): DaemonizeSettings {
  const config = vscode.workspace.getConfiguration('daemonize');
  const read = (key: string): string => {
    const value = config.get<string>(key, '');
    return typeof value === 'string' ? value.trim() : '';
  };
  return { cliPath: read('cliPath'), nodePath: read('nodePath') };
}

/** The real file system access for the locator: reads only, never writes. */
export function createNodeFsPort(): FsPort {
  return {
    async isFile(p: string): Promise<boolean> {
      try { return (await fs.stat(p)).isFile(); } catch { return false; }
    },
    async realpath(p: string): Promise<string> {
      try { return await fs.realpath(p); } catch { return p; }
    },
    async readText(p: string, maxBytes: number): Promise<string | undefined> {
      try {
        const handle = await fs.open(p, 'r');
        try {
          const buffer = Buffer.alloc(maxBytes);
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
          return buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    },
  };
}

export function buildLocatorInput(
  workspaceFolder: string,
  env: NodeJS.ProcessEnv,
  settings: DaemonizeSettings = readSettings(),
  fsPort: FsPort = createNodeFsPort(),
): LocatorInput {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? '';
  return {
    cliPath: settings.cliPath,
    nodePath: settings.nodePath,
    workspaceFolder,
    pathEntries: rawPath.split(path.delimiter).filter((entry) => entry !== ''),
    platform: process.platform,
    execPath: process.execPath,
    fs: fsPort,
  };
}

/** "Choose the file": the user picks the Daemonize program, the path is saved at the user level (scope machine). */
export async function chooseCliFile(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: 'Choose' });
  const file = picked?.[0]?.fsPath;
  if (!file) return undefined;
  await vscode.workspace.getConfiguration('daemonize').update('cliPath', file, vscode.ConfigurationTarget.Global);
  return file;
}

export async function openDaemonizeSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'daemonize');
}
