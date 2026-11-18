import * as vscode from 'vscode';
import { spawn as nodeSpawn } from 'node:child_process';
import { createProcessManager } from './core/process-manager';
import type { ChildLike, SpawnOptions } from './core/process-manager';
import { createStudioApi } from './core/studio-api';
import { createStudioClient } from './core/studio-client';
import { registerCredentialCommands } from './ui/commands/credentials';
import { registerDeleteCommands } from './ui/commands/delete';
import { registerKiroCommands } from './ui/commands/kiro';
import { registerLifecycleCommands } from './ui/commands/lifecycle';
import { registerRecordCommands } from './ui/commands/record';
import { registerStudioCommands } from './ui/commands/studio';
import { Controller, type ExtensionDeps, type ManagerHooks } from './ui/controller';
import { registerStatusBar } from './ui/status-bar';
import { registerActionsView } from './ui/views/actions-view';
import { registerCredentialsView } from './ui/views/credentials-view';
import { registerKiroView } from './ui/views/kiro-view';

export interface ExtensionHandle {
  controller: Controller;
  dispose(): Promise<void>;
}

/** Kills the process and its children. Windows: taskkill /T /F. Elsewhere: SIGTERM to the group, SIGKILL after 5 s. */
function killTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });
  }
  const signal = (sig: NodeJS.Signals): void => {
    try { process.kill(-pid, sig); } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 5000);
  timer.unref();
  return Promise.resolve();
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): ExtensionDeps {
  return {
    env,
    createProcessManager: (hooks: ManagerHooks) =>
      createProcessManager({
        locate: hooks.locate,
        workspaceFolder: hooks.workspaceFolder,
        spawn: (command: string, args: string[], options: SpawnOptions) =>
          nodeSpawn(command, args, options) as unknown as ChildLike,
        killTree,
        env,
        platform: process.platform,
        setTimeout,
        clearTimeout,
        onStderr: hooks.onStderr,
        createClient: (h) => createStudioClient({ origin: h.origin, token: h.token, log: hooks.log }),
      }),
    createApi: (session) => createStudioApi(session.client),
  };
}

let active: ExtensionHandle | undefined;

export function activateWith(context: vscode.ExtensionContext, deps: ExtensionDeps): ExtensionHandle {
  const controller = new Controller(deps);

  const actions = registerActionsView(controller);
  const credentials = registerCredentialsView(controller);
  const kiro = registerKiroView(controller);

  const disposables: Array<{ dispose(): unknown }> = [
    controller,
    ...actions.disposables,
    ...credentials.disposables,
    ...kiro.disposables,
    ...registerStatusBar(controller),
    ...registerLifecycleCommands(controller),
    ...registerStudioCommands(controller),
    ...registerDeleteCommands(controller),
    ...registerRecordCommands(controller),
    ...registerCredentialCommands(controller),
    ...registerKiroCommands(controller),
    controller.onDidRefresh(() => {
      void actions.provider.reload();
      void credentials.provider.reload();
      void kiro.provider.reload();
    }),
  ];
  context.subscriptions.push(...disposables as vscode.Disposable[]);

  // Best effort: the direct child is killed when the Extension Host exits without deactivate.
  const onExit = (): void => {
    const pid = controller.manager.session?.pid;
    if (pid !== undefined) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  };
  process.on('exit', onExit);

  const handle: ExtensionHandle = {
    controller,
    async dispose() {
      process.off('exit', onExit);
      await controller.manager.stop();
    },
  };
  active = handle;
  return handle;
}

export function activate(context: vscode.ExtensionContext): void {
  activateWith(context, realDeps());
}

export async function deactivate(): Promise<void> {
  const handle = active;
  active = undefined;
  await handle?.dispose();
}
