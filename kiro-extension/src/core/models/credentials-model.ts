import { S } from '../strings';
import type { ApiResult, ProcessState, SecretRow, TreeNode } from '../types';

/** Rows of the Credentials view: names and a flag, never a value. */
export function credentialsTree(input: { state: ProcessState; secrets: ApiResult<SecretRow[]> | undefined }): TreeNode[] {
  if (input.state !== 'running' || input.secrets === undefined) {
    return [{ id: 'info:start-to-see', label: S.startToSee, icon: 'info' }];
  }
  if (!input.secrets.ok) {
    return [{ id: 'info:load-failed', label: S.loadFailed, description: S.tryAgain, icon: 'warning', command: { id: 'daemonize.refresh' } }];
  }
  if (input.secrets.data.length === 0) return [{ id: 'info:none', label: S.noCredentialsYet, icon: 'info' }];
  return input.secrets.data.map((s): TreeNode => ({
    id: `secret:${s.name}`,
    label: s.name,
    description: s.configured ? S.hasValue : S.hasNoValue,
    icon: s.configured ? 'check' : 'key',
    contextValue: s.configured ? 'secret.configured' : 'secret.missing',
  }));
}
