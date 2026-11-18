import { S } from '../strings';
import type { ApiResult, PowerInfo, ProcessState, TreeNode } from '../types';

/** Rows of the Kiro view: each connection, or the way to make one. */
export function kiroTree(input: { state: ProcessState; info: ApiResult<PowerInfo> | undefined }): TreeNode[] {
  if (input.state !== 'running' || input.info === undefined) {
    return [{ id: 'info:start-to-see', label: S.startToSee, icon: 'info' }];
  }
  if (!input.info.ok) {
    return [{ id: 'info:load-failed', label: S.loadFailed, description: S.tryAgain, icon: 'warning', command: { id: 'daemonize.refresh' } }];
  }
  const { installs, available } = input.info.data;
  if (installs.length > 0) {
    return installs.map((i): TreeNode => ({
      id: `install:${i.scope}:${i.slug}`,
      label: i.slug,
      description: i.scope === 'global' ? S.scopeGlobal : S.scopeProject,
      tooltip: i.kiroPath,
      icon: 'plug',
      contextValue: 'install',
    }));
  }
  if (!available) return [{ id: 'info:unavailable', label: S.connectUnavailable, icon: 'info' }];
  return [{ id: 'connect', label: S.notInstalled, description: S.confirmConnect, icon: 'plug', command: { id: 'daemonize.connectToKiro' } }];
}
