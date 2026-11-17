/** The secrets the workflows of a set need, with the kind the Credentials panel shows. Names and kinds only. */
import type { RequiredSecret } from './contracts.js';
import { workflowSecrets } from './model.js';
import type { WorkflowSet } from '../types.js';

export function requiredSecrets(set: WorkflowSet | undefined): RequiredSecret[] {
  if (set === undefined) return [];
  const found = new Map<string, RequiredSecret>();
  for (const workflow of set.workflows ?? []) {
    for (const secret of workflowSecrets(workflow, { http: false }).required) {
      const kind: RequiredSecret['kind'] = secret.kind === 'totp' ? 'totp' : secret.kind === 'header' ? 'token' : 'password';
      const known = found.get(secret.name);
      // totp wins over token over password when two workflows disagree
      const rank = { password: 0, token: 1, totp: 2 } as const;
      if (known === undefined || rank[kind] > rank[known.kind]) found.set(secret.name, { name: secret.name, kind });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
