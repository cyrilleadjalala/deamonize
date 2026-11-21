/**
 * Group G4: the MCP server entry that the Studio writes or shows. It is rebuilt from the compiled `mcp.json`, never
 * copied: only placeholder names survive, so no secret value can reach the output.
 */
const SECRET_NAME = /^DAEMONIZE_SECRET_[A-Za-z0-9_]+$/;
const MODEL_NAME = /^DAEMONIZE_MODEL_(PROVIDER|NAME|API_KEY|BASE_URL)$/;

export interface ServerEntry extends Record<string, unknown> {
  type: 'stdio';
  command: 'node';
  args: string[];
  env: Record<string, string>;
}

/** The environment keys of a source entry that may be carried over, as `${KEY}` placeholders. */
export function placeholderEnv(sourceEnv: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof sourceEnv === 'object' && sourceEnv !== null && !Array.isArray(sourceEnv)) {
    for (const key of Object.keys(sourceEnv)) {
      if (SECRET_NAME.test(key) || MODEL_NAME.test(key)) env[key] = '${' + key + '}';
    }
  }
  env.DAEMONIZE_MODE = 'strict';
  return env;
}

export interface EntryContext {
  /** Absolute App_Data_Dir; omitted from the entry when undefined or empty. */
  dataDir?: string;
  applicationKey?: string;
  /** Secret_Names with a stored value (names only). Either `PASSWORD` or `DAEMONIZE_SECRET_PASSWORD` is accepted. */
  configuredNames?: ReadonlySet<string>;
  /**
   * Ask before changes. When set, the entry carries DAEMONIZE_ASK_BEFORE_CHANGES (`true` or `false`) and, when
   * `true`, DAEMONIZE_APPROVAL_TIMEOUT_MS=90000 (RC-3: unverified for Kiro settings entries). When undefined,
   * neither key is written. DAEMONIZE_CALL_SOURCE and DAEMONIZE_TRACE are never written.
   */
  askBeforeChanges?: boolean;
}

export const APPROVAL_TIMEOUT_MS = '90000';

/**
 * Rebuilds the entry: exactly `type`, `command`, `args`, `env`. `env` holds the strict mode, the data folder and the
 * application key as plain values, and a `${NAME}` placeholder for every required secret that is not stored.
 * A value of the source is never copied. Without `ctx` the entry carries a placeholder for every required secret.
 */
export function buildServerEntry(source: unknown, serverJsPath: string, ctx: EntryContext = {}): ServerEntry {
  const sourceEnv = typeof source === 'object' && source !== null ? (source as { env?: unknown }).env : undefined;
  const configured = ctx.configuredNames ?? new Set<string>();
  const env: Record<string, string> = { DAEMONIZE_MODE: 'strict' };
  if (ctx.dataDir !== undefined && ctx.dataDir !== '') env.DAEMONIZE_DATA_DIR = ctx.dataDir;
  if (ctx.applicationKey !== undefined && ctx.applicationKey !== '') env.DAEMONIZE_APP_KEY = ctx.applicationKey;
  if (ctx.askBeforeChanges !== undefined) {
    env.DAEMONIZE_ASK_BEFORE_CHANGES = ctx.askBeforeChanges ? 'true' : 'false';
    if (ctx.askBeforeChanges) env.DAEMONIZE_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS;
  }
  for (const [key, value] of Object.entries(placeholderEnv(sourceEnv))) {
    if (key === 'DAEMONIZE_MODE') continue;
    if (SECRET_NAME.test(key) && (configured.has(key) || configured.has(key.slice('DAEMONIZE_SECRET_'.length)))) continue;
    env[key] = value;
  }
  return { type: 'stdio', command: 'node', args: [serverJsPath], env };
}

/** `DAEMONIZE_SECRET_*` names held by an entry. */
export function secretPlaceholders(entry: Record<string, unknown>): string[] {
  const env = entry.env;
  if (typeof env !== 'object' || env === null) return [];
  return Object.keys(env).filter((k) => SECRET_NAME.test(k)).sort();
}

/** The text shown for copy and paste into another client. */
export function buildSnippetText(serverName: string, entry: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2);
}
