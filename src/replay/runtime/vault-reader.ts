/**
 * Read-only access to the Daemonize secret vault for a generated MCP server started by Kiro.
 * Standalone: imports only node:* modules and ./vault-format.js, and is copied next to mcp-server.js.
 * It never writes, creates or deletes anything, caches nothing between calls, and swallows every failure:
 * a variable that cannot be resolved stays unset, so the caller reports the usual `missing_secret`.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import {
  DPAPI_UNPROTECT,
  KEY_BYTES,
  KEY_SERVICE,
  LINUX_KEY_ATTRS,
  VAULT_FILE,
  decryptVault,
  isUnexpandedPlaceholder,
  parseHexKey,
  pickSecret,
  scopedKey,
  secretNameOf,
} from './vault-format.js';

type Env = Record<string, string | undefined>;

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: 'missing' | 'timeout' | 'error';
}
interface RunOptions {
  input: string;
  env: Record<string, string>;
  timeoutMs: number;
}
export type RunProcess = (file: string, args: readonly string[], options: RunOptions) => Promise<ProcessResult>;

export interface ReaderOptions {
  /** Default process.env. */
  env?: Env;
  /** Key store limit, default 5000. */
  timeoutMs?: number;
  /** Test seam for the key-store subprocess. */
  run?: RunProcess;
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_VAULT_BYTES = 4 * 1024 * 1024;
const ENV_ALLOW = new Set(
  ['PATH', 'SystemRoot', 'windir', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY'].map((n) => n.toUpperCase())
);

function minimalEnv(source: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && ENV_ALLOW.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveResult(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: options.env });
    } catch {
      done({ code: null, stdout: '', stderr: '', failure: 'error' });
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, failure: 'timeout' });
    }, options.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, failure: err.code === 'ENOENT' ? 'missing' : 'error' }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  });

/** Directory of the vault: DAEMONIZE_DATA_DIR when non-empty, else the platform default. undefined when unusable. */
export function resolveDataDir(env: Env, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = platform === 'win32' ? win32 : posix;
  const override = env.DAEMONIZE_DATA_DIR;
  if (override !== undefined && override !== '') return path.isAbsolute(override) ? override : undefined;
  let home: string;
  try {
    home = homedir();
  } catch {
    return undefined;
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return local !== undefined && local !== '' && path.isAbsolute(local) ? path.join(local, 'Daemonize') : path.join(home, 'AppData', 'Local', 'Daemonize');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Daemonize');
  const xdg = env.XDG_DATA_HOME;
  return xdg !== undefined && xdg !== '' && path.isAbsolute(xdg) ? path.join(xdg, 'daemonize') : path.join(home, '.local', 'share', 'daemonize');
}

/** The key, or undefined when none is available. Throws on any failure. */
async function readKey(dataDir: string, env: Env, options: ReaderOptions, timeoutMs: number): Promise<Buffer | undefined> {
  const run = options.run ?? runProcess;
  const subEnv = minimalEnv(env);
  const platform = options.platform ?? process.platform;

  if (process.env.NODE_ENV === 'test') {
    const kind = env.DAEMONIZE_VAULT_KEY_PROVIDER;
    if (kind === 'file') {
      try {
        return parseHexKey(await readFile(join(dataDir, 'vault.key.test'), 'utf-8'));
      } catch {
        return undefined;
      }
    }
    if (kind === 'memory' || kind === 'unavailable') return undefined;
  }

  if (platform === 'win32') {
    const blob = (await readFile(join(dataDir, 'vault.key'), 'utf-8')).trim();
    const root = env.SystemRoot ?? env.windir ?? process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', DPAPI_UNPROTECT], { input: blob, env: subEnv, timeoutMs });
    if (r.failure !== undefined || r.code !== 0) return undefined;
    const key = Buffer.from(r.stdout.trim(), 'base64');
    return key.length === KEY_BYTES ? key : undefined;
  }
  if (platform === 'darwin') {
    const r = await run('/usr/bin/security', ['find-generic-password', '-a', 'daemonize', '-s', KEY_SERVICE, '-w'], { input: '', env: subEnv, timeoutMs });
    if (r.failure !== undefined || r.code !== 0) return undefined;
    return parseHexKey(r.stdout);
  }
  const r = await run('secret-tool', ['lookup', ...LINUX_KEY_ATTRS], { input: '', env: subEnv, timeoutMs });
  if (r.failure !== undefined || r.code !== 0 || r.stderr.trim() !== '') return undefined;
  return parseHexKey(r.stdout);
}

/** Reads and decrypts the vault once. Returns an empty map on any failure. */
async function readVault(env: Env, options: ReaderOptions, timeoutMs: number): Promise<Map<string, string>> {
  try {
    const dataDir = resolveDataDir(env, options.platform);
    if (dataDir === undefined) return new Map();
    const bytes = await readFile(join(dataDir, VAULT_FILE));
    if (bytes.length > MAX_VAULT_BYTES) return new Map();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((resolveLimit) => {
      timer = setTimeout(() => resolveLimit(undefined), timeoutMs);
    });
    let key: Buffer | undefined;
    try {
      key = await Promise.race([readKey(dataDir, env, options, timeoutMs).catch(() => undefined), limit]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (key === undefined || key.length !== KEY_BYTES) return new Map();
    return decryptVault(key, bytes.toString('utf-8'));
  } catch {
    return new Map();
  }
}

/**
 * A copy of `env` where each listed DAEMONIZE_SECRET_<NAME> variable holds the resolved value (explicit, then scoped by
 * DAEMONIZE_APP_KEY, then generic) or is deleted when none is usable. Never throws. Reads and decrypts the vault at most
 * once per call, and not at all when every variable is explicit.
 */
export async function withResolvedSecrets(env: Env, variables: readonly string[], options: ReaderOptions = {}): Promise<Env> {
  const out: Env = { ...env };
  try {
    const wanted = [...new Set(variables)].filter((v) => secretNameOf(v) !== undefined);
    const explicitOk = (v: string): boolean => {
      const value = env[v];
      return value !== undefined && value !== '' && !isUnexpandedPlaceholder(value);
    };
    const pending = wanted.filter((v) => !explicitOk(v));
    if (pending.length === 0) return out;
    const vault = await readVault(env, options, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const appKey = env.DAEMONIZE_APP_KEY;
    for (const variable of pending) {
      const name = secretNameOf(variable) as string;
      const picked = pickSecret({
        scoped: appKey !== undefined && appKey !== '' ? vault.get(scopedKey(appKey, name)) : undefined,
        generic: vault.get(name),
      });
      if (picked === undefined) delete out[variable];
      else out[variable] = picked;
    }
  } catch {
    // swallow: unresolved variables stay as they are
  }
  return out;
}
