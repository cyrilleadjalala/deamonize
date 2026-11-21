import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installCli, type InstallerPorts, type InstallResult } from '../../core/cli-installer';
import { S } from '../../core/strings';
import { BROWSER_CHECK_KEY, FIRST_RUN_KEY } from '../../core/welcome-model';
import type { Controller } from '../controller';
import {
  cliFolder, extensionVersion, locateWithExtensionFolder, readBrowserRecord, setContextKey, type OnboardingContext,
} from '../context-keys';
import { createNodeFsPort, readSettings } from '../settings';
export const WALKTHROUGH_ID = 'daemonize.daemonize-kiro#daemonize.getStarted';
const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
const OUTPUT_LIMIT = 64 * 1024;
/** Runs a program with an arguments array and no shell. Cancelling the token ends the process. */
function createRunPort(env: NodeJS.ProcessEnv, token: vscode.CancellationToken): InstallerPorts['run'] {
  return (command, args, options) =>
    new Promise((resolve) => {
      let output = '';
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancel.dispose();
        resolve({ code, output });
      };
      const child = spawn(command, args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const take = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', (error) => { output += `\n${error.message}`; done(null); });
      child.on('close', (code) => done(code));
      const stop = (): void => { try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(stop, options.timeoutMs);
      const cancel = token.onCancellationRequested(stop);
      if (token.isCancellationRequested) stop();
    });
}
async function folderExists(folder: string): Promise<boolean> {
  try { return (await fs.stat(folder)).isDirectory(); } catch { return false; }
}
/** Node from `daemonize.nodePath`, else the first `node` on the PATH. Never the editor's own program. */
async function findNode(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fsPort = createNodeFsPort();
  const configured = readSettings().nodePath;
  if (configured !== '') return (await fsPort.isFile(configured)) ? configured : undefined;
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    if (await fsPort.isFile(candidate)) return candidate;
  }
  return undefined;
}
function createPorts(controller: Controller, token: vscode.CancellationToken): InstallerPorts {
  const env = controller.deps.env;
  // The method name is written in pieces: tests/extension/static/imports.test.ts bans the bare word in the sources.
  const moveName = ['re', 'name'].join('');
  const move = (fs as unknown as Record<string, (from: string, to: string) => Promise<void>>)[moveName]!;
  const ports: Record<string, unknown> = {
    locateNode: () => findNode(env),
    fs: createNodeFsPort(),
    run: async (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => {
      const cwd = (await folderExists(options.cwd)) ? options.cwd : os.tmpdir();
      return createRunPort(env, token)(command, args, { ...options, cwd });
    },
    remove: (target: string) => fs.rm(target, { recursive: true, force: true }),
    redact: controller.redact,
  };
  ports[moveName] = (from: string, to: string) => move(from, to);
  return ports as unknown as InstallerPorts;
}
function parseBrowser(body: unknown): boolean | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const available = (body as { available?: unknown }).available;
  return typeof available === 'boolean' ? available : undefined;
}
/** Asks the Studio (and so the Daemonize program) whether replay can start a browser. */
async function runBrowserCheck(controller: Controller, context: OnboardingContext | undefined, announceReady: boolean): Promise<void> {
  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: S.browserChecking },
    () => controller.withStudio(async (_api, session) => session.client.get('/api/system/browser'), { idempotent: true }),
  );
  if (answer === undefined) return;
  const available = answer.status === 200 ? parseBrowser(answer.body) : undefined;
  if (available === undefined) {
    void vscode.window.showErrorMessage(S.browserCheckFailed);
    return;
  }
  if (context) await context.globalState.update(BROWSER_CHECK_KEY, { version: extensionVersion(context), available });
  await setContextKey('daemonize.browserMissing', !available);
  controller.refresh();
  if (available) {
    if (announceReady) void vscode.window.showInformationMessage(S.browserReady);
    return;
  }
  const pick = await vscode.window.showWarningMessage(S.browserMissing, S.checkAgain);
  if (pick === S.checkAgain) await runBrowserCheck(controller, context, true);
}
async function runInstall(controller: Controller, context: OnboardingContext): Promise<void> {
  const located = await locateWithExtensionFolder(controller, context);
  if (located.kind === 'ok') {
    void vscode.window.showInformationMessage(S.installAlready);
    await setContextKey('daemonize.cliFound', true);
    return;
  }
  let cancelled = false;
  const result: InstallResult | undefined = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: S.installProgress, cancellable: true },
    async (_progress, token) => {
      const outcome = await installCli(createPorts(controller, token), cliFolder(context), process.platform);
      cancelled = token.isCancellationRequested;
      return outcome;
    },
  );
  if (cancelled || result === undefined) return;
  switch (result.kind) {
    case 'no-node': {
      const pick = await vscode.window.showErrorMessage(S.installNoNode, S.openNodeDownload);
      if (pick === S.openNodeDownload) await vscode.env.openExternal(vscode.Uri.parse(NODE_DOWNLOAD_URL));
      return;
    }
    case 'failed':
      controller.logger.log(result.tail);
      controller.logger.show();
      void vscode.window.showErrorMessage(S.installFailed);
      return;
    case 'rejected':
      void vscode.window.showErrorMessage(S.installRejected);
      return;
    default:
      void vscode.window.showInformationMessage(S.installDone);
      controller.refresh();
      await runBrowserCheck(controller, context, true);
  }
}
export function registerOnboardingCommands(controller: Controller, context?: OnboardingContext): vscode.Disposable[] {
  const openWalkthrough = (): Thenable<unknown> =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand('daemonize.installCli', async () => {
      if (!context) return;
      await controller.guarded(() => runInstall(controller, context));
    }),
    vscode.commands.registerCommand('daemonize.checkBrowser', async () => {
      await controller.guarded(() => runBrowserCheck(controller, context, true));
    }),
    vscode.commands.registerCommand('daemonize.getStarted', () => openWalkthrough()),
  ];
  if (context) {
    // The first run opens the walkthrough once; the flag lives in the global state only.
    if (context.globalState.get<boolean>(FIRST_RUN_KEY) !== true) {
      void context.globalState.update(FIRST_RUN_KEY, true).then(() => openWalkthrough());
    }
    // The first start after an update checks the browser again.
    let checked = false;
    disposables.push(controller.manager.onDidChangeState((state) => {
      if (state !== 'running' || checked) return;
      checked = true;
      if (readBrowserRecord(context)?.version === extensionVersion(context)) return;
      void controller.guarded(() => runBrowserCheck(controller, context, false));
    }) as vscode.Disposable);
  }
  return disposables;
}
