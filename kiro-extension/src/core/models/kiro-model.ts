import { S } from '../strings';
import type { ApiResult, InstallScope, PowerInfo, ProcessState, TreeNode } from '../types';

const scopeText = (scope: InstallScope): string => (scope === 'global' ? S.scopeGlobal : S.scopeProject);

/** Rows of the Kiro view: each connection (with its "Ask before changes" setting), the Power rows, or the way to make one. */
export function kiroTree(input: {
  state: ProcessState;
  info: ApiResult<PowerInfo> | undefined;
  /** Where the Daemonize Power is installed, when the Studio could tell. */
  powerScopes?: InstallScope[];
}): TreeNode[] {
  if (input.state !== 'running' || input.info === undefined) {
    return [{ id: 'info:start-to-see', label: S.startToSee, icon: 'info' }];
  }
  if (!input.info.ok) {
    return [{ id: 'info:load-failed', label: S.loadFailed, description: S.tryAgain, icon: 'warning', command: { id: 'daemonize.refresh' } }];
  }
  const { installs, available } = input.info.data;
  const powerRows = (input.powerScopes ?? []).map((scope): TreeNode => ({
    id: `power:${scope}`,
    label: S.powerRowLabel,
    description: scopeText(scope),
    icon: 'plug',
    contextValue: 'power',
  }));
  if (installs.length > 0) {
    const rows = installs.map((i): TreeNode => ({
      id: `install:${i.scope}:${i.slug}`,
      label: i.slug,
      description: i.askBeforeChanges === undefined
        ? scopeText(i.scope)
        : `${scopeText(i.scope)} · ${i.askBeforeChanges ? S.askOn : S.askOff}`,
      tooltip: i.kiroPath,
      icon: 'plug',
      contextValue: 'install',
    }));
    return [...rows, ...powerRows];
  }
  if (!available) return [{ id: 'info:unavailable', label: S.connectUnavailable, icon: 'info' }, ...powerRows];
  return [
    { id: 'connect', label: S.notInstalled, description: S.confirmConnect, icon: 'plug', command: { id: 'daemonize.connectToKiro' } },
    ...powerRows,
  ];
}
