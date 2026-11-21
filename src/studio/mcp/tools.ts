/**
 * The thirteen tools of the Studio_MCP. Each one calls documented Studio routes through a `StudioApi`, never decides an
 * approval, never touches the vault or the Approval_Setting, and never returns a value that the Studio would hide.
 * A tool answers `{ ok: true, value }` or `{ ok: false, error }`; `server.ts` turns that into an MCP result.
 */
import { redactArguments } from '../playground.js';
import { redactForStudio } from '../redact.js';
import { SAMPLE_MODE } from '../messages/common.js';
import { requestApproval, parseApprovalTimeout, type ApprovalKind, type ApprovalOutcome, type ApprovalRisk, type RequestApprovalOptions, type WriteStepMeta } from '../../replay/runtime/approval-queue.js';
import { defaultAppDataDir } from '../app-data.js';
import { isUnsafeWorkspace, type ApiOutcome, type StudioApi } from './connection.js';
import { MSG, RECORDING_STATE_TEXT } from './texts.js';
import type { StudioMcpToolName } from './tool-names.js';

export interface ToolError {
  error: string;
  message: string;
  field?: string;
  [extra: string]: unknown;
}
export type ToolResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolError };

export interface ToolContext {
  api: StudioApi;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** The queue of the approvals (default: the real one of the runtime). */
  requestApproval: (options: RequestApprovalOptions) => Promise<ApprovalOutcome>;
  /** Milliseconds the user has to answer (default: `DAEMONIZE_APPROVAL_TIMEOUT_MS`, else 120000). */
  approvalTimeoutMs: () => number;
  dataDir: () => string | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The confirmation ids of the previews of this session (the agent never sees the folder behind them). */
  previews: Map<string, { kiroPath: string; application: string; scope: 'global' | 'project' }>;
  /** Home folder test seam. */
  home?: string;
}

const fail = (error: string, message: string, extra: Record<string, unknown> = {}): ToolResult => ({ ok: false, error: { error, message, ...extra } });
const ok = (value: Record<string, unknown>): ToolResult => ({ ok: true, value });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Tools that write something in the workspace or the Studio: they refuse a home folder or a drive root. */
const WRITING_TOOLS: ReadonlySet<StudioMcpToolName> = new Set<StudioMcpToolName>([
  'start_recording',
  'finish_recording',
  'compile',
  'install_to_kiro',
  'update_action',
  'delete_action',
]);

// ---- answers of the Studio ---------------------------------------------------------------------------------------

/** The text of a Studio error: its `error` text, or its `message` when `error` is only a code. */
function studioText(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const error = text(body.error);
  const message = text(body.message);
  if (error !== undefined && !/^[a-z0-9_]+$/.test(error)) return error;
  return message ?? error ?? fallback;
}

/** The error of a failed request, or undefined when the Studio answered 2xx. */
function failed(outcome: ApiOutcome): ToolResult | undefined {
  if (outcome.kind === 'unavailable') return fail('studio_unavailable', MSG.studioNotStarted);
  if (outcome.kind === 'timeout') return fail('timeout', MSG.timeout);
  if (outcome.status >= 200 && outcome.status < 300) return undefined;
  const message = studioText(outcome.body, MSG.somethingWentWrong);
  if (outcome.status === 409 && message === SAMPLE_MODE) return fail('sample_mode', message);
  const field = isRecord(outcome.body) ? text(outcome.body.field) : undefined;
  return fail('studio_error', message, field === undefined ? {} : { field: field.slice(0, 60) });
}

async function get(ctx: ToolContext, path: string, timeoutMs?: number): Promise<{ body: unknown } | ToolResult> {
  const outcome = await ctx.api.request('GET', path, undefined, timeoutMs === undefined ? {} : { timeoutMs });
  return failed(outcome) ?? { body: (outcome as { body: unknown }).body };
}
async function post(ctx: ToolContext, path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<{ body: unknown; status: number } | ToolResult> {
  const outcome = await ctx.api.request('POST', path, body, timeoutMs === undefined ? {} : { timeoutMs });
  return failed(outcome) ?? { body: (outcome as { body: unknown }).body, status: (outcome as { status: number }).status };
}
const isFailure = (v: { body: unknown } | ToolResult): v is ToolResult => 'ok' in v;

// ---- actions ----------------------------------------------------------------------------------------------------

interface ActionView {
  summary: Record<string, unknown>;
  steps: string[];
  writeSteps: Array<Record<string, unknown>>;
  label: string;
  application: string;
}

function summaryOf(view: Record<string, unknown>, compiled: boolean): Record<string, unknown> {
  const risk = isRecord(view.risk) && (view.risk.highest === 'write' || view.risk.highest === 'delete') ? view.risk.highest : 'read';
  const description = text(view.description);
  return {
    id: text(view.id) ?? '',
    tool: text(view.toolName) ?? null,
    label: text(view.label) ?? '',
    ...(description === undefined ? {} : { description }),
    risk,
    variables: asArray(view.variables).filter(isRecord).map((v) => ({ name: text(v.name) ?? '', type: text(v.type) ?? 'string', optional: v.optional === true })),
    compiled,
  };
}

async function loadActions(ctx: ToolContext): Promise<{ actions: ActionView[] } | ToolResult> {
  const workflows = await get(ctx, '/api/workflows');
  if (isFailure(workflows)) return workflows;
  const overview = await get(ctx, '/api/overview');
  if (isFailure(overview)) return overview;
  const compiled = isRecord(overview.body) && overview.body.outputCompiled === true;
  const application = isRecord(overview.body) ? text(overview.body.targetName) ?? 'your application' : 'your application';
  const list = isRecord(workflows.body) ? asArray(workflows.body.workflows).filter(isRecord) : [];
  return {
    actions: list.map((view) => ({
      summary: summaryOf(view, compiled),
      steps: asArray(view.steps).filter(isRecord).map((s, i) => text(s.label) ?? `${text(s.action) ?? 'step'} ${i + 1}`),
      writeSteps: asArray(view.writeSteps).filter(isRecord).map((w) => ({ index: w.index, label: w.label, risk: w.risk, kind: w.kind })),
      label: text(view.label) ?? '',
      application,
    })),
  };
}
const isActions = (v: { actions: ActionView[] } | ToolResult): v is { actions: ActionView[] } => 'actions' in v;

// ---- approvals --------------------------------------------------------------------------------------------------

interface ApprovalAsk {
  kind: ApprovalKind;
  tool: string;
  application: string;
  risk: ApprovalRisk;
  summary?: string;
  arguments: unknown;
  writeSteps: WriteStepMeta[];
}

/** Asks the user through the queue. Returns undefined when approved, else the error to answer. */
async function askUser(ctx: ToolContext, ask: ApprovalAsk): Promise<ToolResult | undefined> {
  let outcome: ApprovalOutcome;
  try {
    outcome = await ctx.requestApproval({
      dataDir: ctx.dataDir(),
      source: 'studio-mcp',
      kind: ask.kind,
      tool: ask.tool,
      application: ask.application,
      risk: ask.risk,
      ...(ask.summary === undefined ? {} : { summary: ask.summary }),
      arguments: ask.arguments,
      writeSteps: ask.writeSteps,
      timeoutMs: ctx.approvalTimeoutMs(),
    });
  } catch {
    return fail('approval_unavailable', MSG.approvalUnavailable);
  }
  switch (outcome.decision) {
    case 'approved':
      return undefined;
    case 'denied':
      return fail('approval_denied', MSG.approvalDenied);
    case 'withdrawn':
      return fail('approval_denied', MSG.approvalWithdrawn);
    case 'timeout':
      return fail('approval_timeout', MSG.approvalTimeout);
    default:
      return fail('approval_unavailable', MSG.approvalUnavailable);
  }
}

const writeStepMetas = (steps: Array<Record<string, unknown>>): WriteStepMeta[] =>
  steps
    .filter((s) => typeof s.index === 'number' && (s.risk === 'write' || s.risk === 'delete'))
    .slice(0, 50)
    .map((s) => ({ index: s.index as number, label: String(text(s.label) ?? '').slice(0, 80), risk: s.risk as 'write' | 'delete' }));

// ---- the tools --------------------------------------------------------------------------------------------------

type Args = Record<string, unknown>;
type Tool = (args: Args, ctx: ToolContext) => Promise<ToolResult>;

const listActions: Tool = async (_args, ctx) => {
  const loaded = await loadActions(ctx);
  return isActions(loaded) ? ok({ actions: loaded.actions.map((a) => a.summary) }) : loaded;
};

const getAction: Tool = async (args, ctx) => {
  const loaded = await loadActions(ctx);
  if (!isActions(loaded)) return loaded;
  const found = loaded.actions.find((a) => a.summary.id === args.id);
  if (found === undefined) return fail('unknown_action', MSG.noAction, { knownIds: loaded.actions.map((a) => a.summary.id).slice(0, 100) });
  return ok({ ...found.summary, steps: found.steps, writeSteps: found.writeSteps });
};

const listCredentials: Tool = async (_args, ctx) => {
  const response = await get(ctx, '/api/secrets');
  if (isFailure(response)) return response;
  const credentials = (isRecord(response.body) ? asArray(response.body.secrets) : []).filter(isRecord).map((s) => ({
    name: text(s.name) ?? '',
    kind: s.kind === 'totp' || s.kind === 'token' ? s.kind : 'password',
    configured: s.configured === true,
  }));
  return ok({ credentials, ...(credentials.some((c) => !c.configured) ? { instruction: MSG.credentialInstruction } : {}) });
};

const getActivity: Tool = async (args, ctx) => {
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const response = await get(ctx, `/api/activity?limit=${limit}`);
  if (isFailure(response)) return response;
  return ok({ entries: isRecord(response.body) ? asArray(response.body.entries).slice(0, limit) : [] });
};

const startRecording: Tool = async (args, ctx) => {
  const response = await post(ctx, '/api/record/start', {
    name: args.name,
    url: args.url,
    ...(args.reuseSession === undefined ? {} : { reuseSession: args.reuseSession }),
  });
  if (isFailure(response)) return response;
  return ok({ state: 'recording', message: MSG.recordingStarted });
};

const getRecordingStatus: Tool = async (_args, ctx) => {
  const response = await get(ctx, '/api/record/status');
  if (isFailure(response)) return response;
  const body = isRecord(response.body) ? response.body : {};
  const state = text(body.state) ?? 'idle';
  const variables = asArray(body.variables)
    .filter(isRecord)
    .map((v) => ({ name: text(v.name) ?? '', type: text(v.type) ?? 'string', optional: v.optional === true }));
  return ok({
    state,
    message: state === 'error' ? (text(body.error) ?? RECORDING_STATE_TEXT.error) : (RECORDING_STATE_TEXT[state] ?? RECORDING_STATE_TEXT.idle),
    steps: typeof body.steps === 'number' ? body.steps : 0,
    labels: asArray(body.labels).filter((l): l is string => typeof l === 'string').slice(0, 3),
    ...(variables.length > 0 ? { variables } : {}),
    ...(text(body.sessionNote) === undefined ? {} : { sessionNote: text(body.sessionNote) }),
  });
};

const finishRecording: Tool = async (_args, ctx) => {
  const response = await post(ctx, '/api/record/stop', {});
  if (isFailure(response)) return response;
  return ok({ state: 'saving', message: MSG.recordingSaving });
};

const compile: Tool = async (args, ctx) => {
  const started = await post(ctx, '/api/compile', {
    ...(args.http === undefined ? {} : { http: args.http }),
    ...(args.healSupport === undefined ? {} : { healSupport: args.healSupport }),
  });
  if (isFailure(started)) return started;
  const deadline = ctx.now() + 120_000;
  for (; ;) {
    await ctx.sleep(500);
    const status = await get(ctx, '/api/compile/status', 10_000);
    if (isFailure(status)) return status;
    const body = isRecord(status.body) ? status.body : {};
    const state = text(body.state);
    if (state === 'error') return ok({ state: 'error', message: text(body.error) ?? MSG.compileFailed });
    if (state === 'done' || state === 'idle') return ok({ state: 'done', message: MSG.compileDone });
    if (ctx.now() >= deadline) return ok({ state: 'running', message: MSG.compileStillRunning });
  }
};

interface PlaygroundTool {
  name: string;
  risk: 'read' | 'write' | 'delete';
  writeSteps: Array<Record<string, unknown>>;
  sensitiveArgs: string[];
  label?: string;
}

const testAction: Tool = async (args, ctx) => {
  const status = await get(ctx, '/api/playground');
  if (isFailure(status)) return status;
  const body = isRecord(status.body) ? status.body : {};
  if (body.available === false) return fail('studio_error', text(body.message) ?? MSG.somethingWentWrong);
  const tools: PlaygroundTool[] = asArray(body.tools).filter(isRecord).map((t) => ({
    name: text(t.name) ?? '',
    risk: t.risk === 'read' || t.risk === 'delete' ? t.risk : 'write',
    writeSteps: asArray(t.writeSteps).filter(isRecord),
    sensitiveArgs: asArray(t.sensitiveArgs).filter((s): s is string => typeof s === 'string'),
    ...(text(t.label) === undefined ? {} : { label: text(t.label) }),
  }));
  const tool = tools.find((t) => t.name === args.tool);
  if (tool === undefined) return fail('unknown_action', MSG.noToolWithName, { knownTools: tools.map((t) => t.name).slice(0, 100) });

  const given = isRecord(args.arguments) ? args.arguments : {};
  const secretArgument = Object.keys(given).find((k) => tool.sensitiveArgs.some((s) => s.toLowerCase() === k.toLowerCase()));
  if (secretArgument !== undefined) return fail('invalid_argument', MSG.secretArgument, { field: `arguments.${secretArgument.slice(0, 60)}` });

  let confirm: true | undefined;
  if (tool.risk !== 'read') {
    const writeSteps = writeStepMetas(tool.writeSteps);
    if (args.confirm !== true) {
      return fail('confirmation_required', MSG.confirmationRequired, { risk: tool.risk, writeSteps: tool.writeSteps, field: 'confirm' });
    }
    const refused = await askUser(ctx, {
      kind: 'test-action',
      tool: tool.name,
      application: (await applicationName(ctx)),
      risk: tool.risk,
      arguments: redactForStudio(redactArguments(given, tool.sensitiveArgs), { env: ctx.env }),
      writeSteps,
    });
    if (refused !== undefined) return refused;
    confirm = true;
  }

  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
  const response = await ctx.api.request(
    'POST',
    '/api/playground/call',
    {
      tool: tool.name,
      ...(args.arguments === undefined ? {} : { arguments: given }),
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(confirm === undefined ? {} : { confirm }),
    },
    { timeoutMs: (timeoutMs ?? 60_000) + 15_000 }
  );
  const problem = failed(response);
  if (problem !== undefined) return problem;
  const result = isRecord((response as { body: unknown }).body) ? ((response as { body: unknown }).body as Record<string, unknown>) : {};
  return summarizeTest(result);
};

function summarizeTest(result: Record<string, unknown>): ToolResult {
  if (result.error === 'missing_secret') {
    const failure = isRecord(result.failure) ? result.failure : {};
    const names = [...new Set([...asArray(failure.missing), failure.missingSecret].filter((n): n is string => typeof n === 'string'))]
      .map((n) => n.replace(/^DAEMONIZE_SECRET_/i, ''))
      .slice(0, 50);
    return fail('missing_secret', 'A credential is missing, so nothing ran.', { missing: names, instruction: MSG.credentialInstruction });
  }
  if (result.refused === 'validation') {
    return fail('invalid_argument', text(result.message) ?? 'The arguments do not fit the tool.', { errors: asArray(result.errors).slice(0, 20) });
  }
  const keep = ['success', 'drifted', 'driftChecked', 'healed', 'mode', 'levels', 'skippedSteps', 'text', 'data', 'error', 'message'] as const;
  const out: Record<string, unknown> = {};
  for (const key of keep) if (result[key] !== undefined) out[key] = result[key];
  if (out.success === undefined) out.success = false;
  return ok(out);
}

async function applicationName(ctx: ToolContext): Promise<string> {
  const overview = await get(ctx, '/api/overview');
  return !isFailure(overview) && isRecord(overview.body) ? (text(overview.body.targetName) ?? 'your application') : 'your application';
}

const previewKiroInstall: Tool = async (args, ctx) => {
  const response = await post(ctx, '/api/power/preview', { scope: args.scope, ...(args.scope === 'project' ? { workspacePath: ctx.workspace } : {}) });
  if (isFailure(response)) return response;
  const plan = isRecord(response.body) ? response.body : {};
  const confirmationId = text(plan.confirmationId);
  const scope = args.scope === 'project' ? 'project' : 'global';
  const application = text(plan.serverName) ?? (await applicationName(ctx));
  if (confirmationId === undefined) return fail('studio_error', MSG.somethingWentWrong);
  ctx.previews.set(confirmationId, { kiroPath: text(plan.kiroPath) ?? '', application, scope });
  while (ctx.previews.size > 20) ctx.previews.delete(ctx.previews.keys().next().value as string);
  const actions = await loadActions(ctx);
  const tools = isActions(actions)
    ? actions.actions.filter((a) => typeof a.summary.tool === 'string').map((a) => ({ name: a.summary.tool as string, risk: a.summary.risk as string }))
    : [];
  const missing = asArray(plan.missingSecrets).filter((n): n is string => typeof n === 'string');
  const ask = plan.askBeforeChanges === true;
  return ok({
    application,
    scope,
    tools,
    missingCredentials: missing,
    askBeforeChanges: ask,
    confirmationId,
    message:
      `This would add ${application} to Kiro for ${scope === 'global' ? 'all projects' : 'this project'}.` +
      (missing.length > 0 ? ` These credentials are still missing: ${missing.join(', ')}.` : '') +
      (ask ? ' Kiro will ask the user before any tool changes data.' : ''),
  });
};

const installToKiro: Tool = async (args, ctx) => {
  const preview = typeof args.confirmationId === 'string' ? ctx.previews.get(args.confirmationId) : undefined;
  if (preview === undefined || preview.scope !== args.scope) return fail('invalid_argument', MSG.unknownConfirmation, { field: 'confirmationId' });
  const refused = await askUser(ctx, {
    kind: 'install',
    tool: 'install_to_kiro',
    application: preview.application,
    risk: 'write',
    summary: `Add ${preview.application} to Kiro for ${preview.scope === 'global' ? 'all projects' : 'this project'}`,
    arguments: { scope: preview.scope },
    writeSteps: [],
  });
  if (refused !== undefined) return refused;
  const response = await post(ctx, '/api/power/install', { scope: args.scope, confirmationId: args.confirmationId, kiroPath: preview.kiroPath });
  if (isFailure(response)) return response;
  ctx.previews.delete(args.confirmationId as string);
  const body = isRecord(response.body) ? response.body : {};
  return ok({ installed: true, scope: args.scope, missingCredentials: asArray(body.missingSecrets).filter((n): n is string => typeof n === 'string'), message: MSG.installedReload });
};

const updateAction: Tool = async (args, ctx) => {
  if (args.confirm !== true) return fail('confirmation_required', MSG.confirmationRequired, { field: 'confirm' });
  const { confirm: _confirm, ...fields } = args;
  const response = await post(ctx, '/api/workflows/update', fields);
  if (isFailure(response)) return response;
  const body = isRecord(response.body) ? response.body : {};
  const view = isRecord(body.workflow) ? body.workflow : {};
  return ok(summaryOf(view, body.recompile !== undefined && body.recompile !== 'not-needed'));
};

const deleteAction: Tool = async (args, ctx) => {
  if (args.confirm !== true) return fail('confirmation_required', MSG.confirmationRequired, { field: 'confirm' });
  const loaded = await loadActions(ctx);
  if (!isActions(loaded)) return loaded;
  const found = loaded.actions.find((a) => a.summary.id === args.id);
  if (found === undefined) return fail('unknown_action', MSG.noAction, { knownIds: loaded.actions.map((a) => a.summary.id).slice(0, 100) });
  const refused = await askUser(ctx, {
    kind: 'delete-action',
    tool: 'delete_action',
    application: found.application,
    risk: 'delete',
    summary: `Delete the action ${found.label.slice(0, 80)}`,
    arguments: { id: args.id },
    writeSteps: [],
  });
  if (refused !== undefined) return refused;
  const response = await post(ctx, '/api/workflows/delete', { id: args.id });
  if (isFailure(response)) return response;
  const body = isRecord(response.body) ? response.body : {};
  return ok({ deleted: true, remaining: typeof body.remaining === 'number' ? body.remaining : 0 });
};

export const TOOLS: Record<StudioMcpToolName, Tool> = {
  list_actions: listActions,
  get_action: getAction,
  list_credentials: listCredentials,
  get_activity: getActivity,
  start_recording: startRecording,
  get_recording_status: getRecordingStatus,
  finish_recording: finishRecording,
  compile,
  test_action: testAction,
  preview_kiro_install: previewKiroInstall,
  install_to_kiro: installToKiro,
  update_action: updateAction,
  delete_action: deleteAction,
};

/** Runs one tool whose arguments were already validated. Never throws. */
export async function runTool(name: StudioMcpToolName, args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (WRITING_TOOLS.has(name) && isUnsafeWorkspace(ctx.workspace, ctx.home)) return fail('invalid_argument', MSG.openProjectFolder);
  try {
    return await TOOLS[name](args, ctx);
  } catch {
    return fail('studio_error', MSG.somethingWentWrong);
  }
}

/** The real context: the queue of the runtime and the data folder of the platform. */
export function defaultApprovalDeps(env: NodeJS.ProcessEnv): Pick<ToolContext, 'requestApproval' | 'approvalTimeoutMs' | 'dataDir'> {
  return {
    requestApproval,
    approvalTimeoutMs: () => parseApprovalTimeout(env.DAEMONIZE_APPROVAL_TIMEOUT_MS),
    dataDir: () => defaultAppDataDir({ env }),
  };
}
