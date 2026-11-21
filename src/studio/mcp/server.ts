/**
 * The Studio_MCP server: the low-level MCP `Server` with `ListTools` and `CallTool` handlers. The tool schemas are plain
 * JSON Schema with `additionalProperties: false` and are enforced with Ajv, so a field that is not listed is refused
 * (and named) before any request is made. Every answer passes `redactForStudio`, is cut at 20000 characters, and an
 * error is `isError: true` with plain text: no stack, path, address or token.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactForStudio } from '../redact.js';
import type { ApprovalOutcome, RequestApprovalOptions } from '../../replay/runtime/approval-queue.js';
import type { StudioApi } from './connection.js';
import { describeTools, validateInput } from './schemas.js';
import { MSG, SERVER_NAME } from './texts.js';
import { STUDIO_MCP_TOOL_NAMES, type StudioMcpToolName } from './tool-names.js';
import { defaultApprovalDeps, runTool, type ToolContext, type ToolError } from './tools.js';

export interface StudioMcpDeps {
  api: StudioApi;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  requestApproval?: (options: RequestApprovalOptions) => Promise<ApprovalOutcome>;
  approvalTimeoutMs?: () => number;
  dataDir?: () => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  home?: string;
}

/** The longest text of one answer. */
export const MAX_ANSWER_CHARS = 20_000;

/** The text of an answer: the JSON as it is, or `{ truncated: true, text }` holding the start of it. Always valid JSON. */
export function boundAnswer(json: string, max: number = MAX_ANSWER_CHARS): string {
  if (json.length <= max) return json;
  let keep = max - 60;
  for (;;) {
    const wrapped = JSON.stringify({ truncated: true, message: MSG.truncated, text: json.slice(0, Math.max(keep, 0)) });
    if (wrapped.length <= max || keep <= 0) return wrapped;
    keep = Math.floor(keep * 0.9);
  }
}

function answer(deps: StudioMcpDeps, value: unknown, isError: boolean): CallToolResult {
  let safe: unknown;
  try {
    safe = redactForStudio(value, { env: deps.env ?? process.env, secretValues: deps.api.secretValues() });
  } catch {
    safe = { error: 'studio_error', message: MSG.somethingWentWrong };
    isError = true;
  }
  const text = boundAnswer(JSON.stringify(safe) ?? '{}');
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const refusal = (deps: StudioMcpDeps, error: ToolError): CallToolResult => answer(deps, error, true);

/** One tool call: validation first, then the tool. Never throws. */
export async function handleToolCall(deps: StudioMcpDeps, name: string, args: unknown, context: ToolContext): Promise<CallToolResult> {
  if (!(STUDIO_MCP_TOOL_NAMES as readonly string[]).includes(name)) return refusal(deps, { error: 'invalid_argument', message: MSG.unknownTool, field: 'name' });
  const checked = validateInput(name as StudioMcpToolName, args);
  if (!checked.ok) return refusal(deps, { error: checked.error, message: checked.message, field: checked.field });
  const result = await runTool(name as StudioMcpToolName, checked.value, context);
  return result.ok ? answer(deps, result.value, false) : refusal(deps, result.error);
}

export function createStudioMcpServer(deps: StudioMcpDeps): Server {
  const env = deps.env ?? process.env;
  const context: ToolContext = {
    api: deps.api,
    workspace: deps.workspace,
    env,
    ...defaultApprovalDeps(env),
    ...(deps.requestApproval === undefined ? {} : { requestApproval: deps.requestApproval }),
    ...(deps.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: deps.approvalTimeoutMs }),
    ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    previews: new Map(),
    ...(deps.home === undefined ? {} : { home: deps.home }),
  };
  const server = new Server({ name: SERVER_NAME, version: deps.version ?? '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: describeTools().map((t) => ({ ...t, inputSchema: t.inputSchema as { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(deps, request.params.name, request.params.arguments, context));
  return server;
}
