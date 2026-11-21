import type { PowerApi, StudioClient } from './ports';
import { S } from './strings';
import type { ApiResult, DaemonizePowerPlanRow, InstallScope } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isScope = (v: unknown): v is InstallScope => v === 'global' || v === 'project';
const isParts = (v: unknown): v is 'power' | 'agent' => v === 'power' || v === 'agent';
const OUTCOMES: readonly string[] = ['create', 'merge', 'replace'];

function parseInfo(b: unknown): { installs: Array<{ scope: InstallScope; parts: 'power' | 'agent' }>; agentPresent: { project: boolean; global: boolean } } | undefined {
  if (!isObj(b)) return undefined;
  const installs: Array<{ scope: InstallScope; parts: 'power' | 'agent' }> = [];
  if (Array.isArray(b.installs)) {
    for (const i of b.installs) if (isObj(i) && isScope(i.scope) && isParts(i.parts)) installs.push({ scope: i.scope, parts: i.parts });
  }
  const present = isObj(b.agentPresent) ? b.agentPresent : {};
  return { installs, agentPresent: { project: present.project === true, global: present.global === true } };
}

function parsePlan(b: unknown): DaemonizePowerPlanRow | undefined {
  if (!isObj(b) || typeof b.confirmationId !== 'string' || !isScope(b.scope) || !isParts(b.parts) || typeof b.kiroPath !== 'string') return undefined;
  const files: DaemonizePowerPlanRow['files'] = [];
  if (Array.isArray(b.files)) {
    for (const f of b.files) {
      if (isObj(f) && typeof f.path === 'string' && typeof f.outcome === 'string' && OUTCOMES.includes(f.outcome)) {
        files.push({ path: f.path, outcome: f.outcome as DaemonizePowerPlanRow['files'][number]['outcome'] });
      }
    }
  }
  return {
    confirmationId: b.confirmationId, scope: b.scope, parts: b.parts, kiroPath: b.kiroPath, files,
    conflicts: strings(b.conflicts), alreadyInstalled: b.alreadyInstalled === true, replacesEntry: b.replacesEntry === true,
  };
}

/** Typed calls of `/api/power/daemonize/*` and `GET /api/system/browser`. Unknown JSON never throws; network failures still throw. */
export function createPowerApi(client: StudioClient): PowerApi {
  const result = <T>(res: { status: number; body: unknown }, parse: (body: unknown) => T | undefined): ApiResult<T> => {
    if (res.status >= 200 && res.status < 300) {
      const data = parse(res.body);
      return data === undefined ? { ok: false, status: res.status, error: S.loadFailed } : { ok: true, status: res.status, data };
    }
    const error = isObj(res.body) && typeof res.body.error === 'string' && res.body.error !== '' ? res.body.error : S.loadFailed;
    const field = isObj(res.body) && typeof res.body.field === 'string' ? res.body.field : undefined;
    return { ok: false, status: res.status, error, ...(field === undefined ? {} : { field }) };
  };
  return {
    info: async () => result(await client.get('/api/power/daemonize/info'), parseInfo),
    preview: async (i) =>
      result(
        await client.post('/api/power/daemonize/preview', { scope: i.scope, parts: i.parts, ...(i.workspacePath === undefined ? {} : { workspacePath: i.workspacePath }) }),
        parsePlan,
      ),
    install: async (i) =>
      result(
        await client.post('/api/power/daemonize/install', {
          confirmationId: i.confirmationId, kiroPath: i.kiroPath, scope: i.scope, ...(i.replace === undefined ? {} : { replace: i.replace }),
        }),
        (b) => (isObj(b) ? { written: strings(b.written), skipped: strings(b.skipped), alreadyInstalled: b.alreadyInstalled === true } : undefined),
      ),
    remove: async (scope, parts) =>
      result(await client.post('/api/power/daemonize/remove', { scope, parts }), (b) => (isObj(b) ? { removed: strings(b.removed) } : undefined)),
    browser: async () => result(await client.get('/api/system/browser'), (b) => (isObj(b) ? { available: b.available === true } : undefined)),
  };
}
