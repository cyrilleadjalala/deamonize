/**
 * What the agent principal may call. The Studio_MCP reads an agent token from the lease file; that token is mapped to
 * the `agent` principal, which gets 403 on every route that is not listed here (default deny).
 *
 * Not allowed for the agent, because a file that an assistant may read must not answer its own question or write a
 * credential: `POST /api/approvals/decide`, `GET /api/approvals`, `POST /api/secrets*`, `POST /api/power/approval`,
 * `POST /api/power/remove`, `POST /api/power/daemonize/*`, `POST /api/sessions/forget`, `POST /api/power/auto-add`,
 * `POST /api/pbt/run`. None of them is in the list, so none of them is reachable.
 */
export const AGENT_REFUSED = 'This action needs you, not an assistant.';

export interface AgentRule {
  method: 'GET' | 'POST';
  path: string | RegExp;
}

export const AGENT_ALLOWED: ReadonlyArray<AgentRule> = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/overview' },
  { method: 'GET', path: '/api/workflows' },
  { method: 'GET', path: '/api/secrets' },
  { method: 'GET', path: '/api/activity' },
  { method: 'GET', path: '/api/record/status' },
  { method: 'POST', path: '/api/record/start' },
  { method: 'POST', path: '/api/record/stop' },
  { method: 'POST', path: '/api/compile' },
  { method: 'GET', path: '/api/compile/status' },
  { method: 'POST', path: '/api/workflows/update' },
  { method: 'POST', path: '/api/workflows/delete' },
  { method: 'GET', path: '/api/playground' },
  { method: 'POST', path: '/api/playground/call' },
  { method: 'GET', path: '/api/power/info' },
  { method: 'POST', path: '/api/power/preview' },
  { method: 'POST', path: '/api/power/install' },
];

/** True when the agent principal may call `method` on `pathname`. HEAD counts as GET. */
export function agentMayCall(method: string, pathname: string): boolean {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return AGENT_ALLOWED.some((rule) => rule.method === verb && (typeof rule.path === 'string' ? rule.path === pathname : rule.path.test(pathname)));
}
