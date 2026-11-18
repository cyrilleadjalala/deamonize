import type { StudioApi, StudioClient } from './ports';
import { S } from './strings';
import type {
  ApiResult, InstallAnswer, InstallRow, InstallScope, PowerInfo, PreviewAnswer, RecordingState, RecordingStatus,
  Risk, SecretRow, WorkflowRow,
} from './types';

export type { StudioApi };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const RISKS: readonly string[] = ['read', 'write', 'delete'];
const KINDS: readonly string[] = ['password', 'totp', 'token'];
const STATES: readonly string[] = ['idle', 'recording', 'saving', 'compiling', 'done', 'error'];
const OUTCOMES: readonly string[] = ['create', 'merge', 'replace'];
const isScope = (v: unknown): v is InstallScope => v === 'global' || v === 'project';

export function parseWorkflows(body: unknown): WorkflowRow[] | undefined {
  if (!isObj(body) || !Array.isArray(body.workflows)) return undefined;
  const rows: WorkflowRow[] = [];
  for (const item of body.workflows) {
    if (!isObj(item) || typeof item.id !== 'string' || typeof item.label !== 'string') continue;
    const risk = isObj(item.risk) ? item.risk.highest : undefined;
    if (typeof risk !== 'string' || !RISKS.includes(risk)) continue;
    rows.push({
      id: item.id,
      label: item.label,
      ...(typeof item.toolName === 'string' && item.toolName !== '' ? { toolName: item.toolName } : {}),
      risk: risk as Risk,
    });
  }
  return rows;
}

export function parseSecrets(body: unknown): SecretRow[] | undefined {
  if (!isObj(body) || !Array.isArray(body.secrets)) return undefined;
  const rows: SecretRow[] = [];
  for (const item of body.secrets) {
    if (!isObj(item) || typeof item.name !== 'string' || typeof item.kind !== 'string' || !KINDS.includes(item.kind) || typeof item.configured !== 'boolean') continue;
    rows.push({ name: item.name, kind: item.kind as SecretRow['kind'], configured: item.configured });
  }
  return rows;
}

export function parseRecordingStatus(body: unknown): RecordingStatus | undefined {
  if (!isObj(body) || typeof body.state !== 'string' || !STATES.includes(body.state)) return undefined;
  return {
    state: body.state as RecordingState,
    steps: typeof body.steps === 'number' && Number.isFinite(body.steps) ? body.steps : 0,
    labels: strings(body.labels),
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    ...(typeof body.sessionNote === 'string' ? { sessionNote: body.sessionNote } : {}),
  };
}

export function parsePowerInfo(body: unknown): PowerInfo | undefined {
  if (!isObj(body) || typeof body.kiroHomeExists !== 'boolean') return undefined;
  const installs: InstallRow[] = [];
  if (Array.isArray(body.installs)) {
    for (const item of body.installs) {
      if (isObj(item) && isScope(item.scope) && typeof item.slug === 'string' && typeof item.kiroPath === 'string') {
        installs.push({ scope: item.scope, slug: item.slug, kiroPath: item.kiroPath });
      }
    }
  }
  return { kiroHomeExists: body.kiroHomeExists, installs, available: body.available === true };
}

export function parsePreview(body: unknown): PreviewAnswer | undefined {
  if (!isObj(body) || typeof body.confirmationId !== 'string' || !isScope(body.scope) || typeof body.kiroPath !== 'string') return undefined;
  const files: PreviewAnswer['files'] = [];
  if (Array.isArray(body.files)) {
    for (const f of body.files) {
      if (isObj(f) && typeof f.path === 'string' && typeof f.outcome === 'string' && OUTCOMES.includes(f.outcome)) {
        files.push({ path: f.path, outcome: f.outcome as PreviewAnswer['files'][number]['outcome'] });
      }
    }
  }
  return {
    confirmationId: body.confirmationId,
    scope: body.scope,
    kiroPath: body.kiroPath,
    files,
    replacesEntry: body.replacesEntry === true,
    placeholders: strings(body.placeholders),
    missingSecrets: strings(body.missingSecrets),
    ...(Array.isArray(body.requiredSecrets) ? { requiredSecrets: strings(body.requiredSecrets) } : {}),
    backup: body.backup === true,
  };
}

export function parseInstall(body: unknown): InstallAnswer | undefined {
  if (!isObj(body) || !isScope(body.scope)) return undefined;
  return {
    written: strings(body.written),
    placeholders: strings(body.placeholders),
    missingSecrets: strings(body.missingSecrets),
    ...(Array.isArray(body.requiredSecrets) ? { requiredSecrets: strings(body.requiredSecrets) } : {}),
    scope: body.scope,
  };
}

/** Wraps a `StudioClient` with typed calls. Unknown JSON never throws here. Network failures still throw StudioClientError. */
export function createStudioApi(client: StudioClient): StudioApi {
  const result = <T>(res: { status: number; body: unknown }, parse: (body: unknown) => T | undefined): ApiResult<T> => {
    if (res.status >= 200 && res.status < 300) {
      const data = parse(res.body);
      return data === undefined ? { ok: false, status: res.status, error: S.loadFailed } : { ok: true, status: res.status, data };
    }
    const error = isObj(res.body) && typeof res.body.error === 'string' && res.body.error !== '' ? res.body.error : S.loadFailed;
    const field = isObj(res.body) && typeof res.body.field === 'string' ? res.body.field : undefined;
    return { ok: false, status: res.status, error, ...(field === undefined ? {} : { field }) };
  };
  const flag = (b: unknown): { name: string; configured: boolean } | undefined =>
    isObj(b) && typeof b.name === 'string' && typeof b.configured === 'boolean' ? { name: b.name, configured: b.configured } : undefined;
  const state = (b: unknown): { state: string } | undefined => (isObj(b) && typeof b.state === 'string' ? { state: b.state } : undefined);

  return {
    health: async () => result(await client.get('/api/health'), (b) => (isObj(b) ? { ok: b.ok === true } : undefined)),
    workflows: async () => result(await client.get('/api/workflows'), parseWorkflows),
    deleteWorkflow: async (id) =>
      result(await client.post('/api/workflows/delete', { id }), (b) =>
        isObj(b) && b.ok === true
          ? { ok: true, remaining: typeof b.remaining === 'number' ? b.remaining : 0, ...(typeof b.recompile === 'string' ? { recompile: b.recompile } : {}) }
          : undefined),
    secrets: async () => result(await client.get('/api/secrets'), parseSecrets),
    setSecret: async (name, value) => result(await client.post('/api/secrets', { name, value }), flag),
    forgetSecret: async (name) => result(await client.post('/api/secrets/forget', { name }), flag),
    recordStart: async (i) => result(await client.post('/api/record/start', { name: i.name, url: i.url, reuseSession: i.reuseSession }), state),
    recordStatus: async () => result(await client.get('/api/record/status'), parseRecordingStatus),
    recordStop: async () => result(await client.post('/api/record/stop', {}), state),
    powerInfo: async () => result(await client.get('/api/power/info'), parsePowerInfo),
    powerPreview: async (scope, workspacePath) =>
      result(await client.post('/api/power/preview', { scope, ...(workspacePath === undefined ? {} : { workspacePath }) }), parsePreview),
    powerInstall: async (p) =>
      result(await client.post('/api/power/install', { confirmationId: p.confirmationId, kiroPath: p.kiroPath, scope: p.scope }), parseInstall),
    powerRemove: async (scope) =>
      result(await client.post('/api/power/remove', { scope }), (b) => (isObj(b) ? { removed: strings(b.removed) } : undefined)),
  };
}
