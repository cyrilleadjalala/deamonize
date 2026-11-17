/**
 * Where the 256-bit key of the Secret_Vault is kept: in the protection of the operating system, never next to the
 * vault file in the clear.
 *
 * - Windows: DPAPI (CurrentUser) through powershell.exe. The key travels on stdin, the protected blob is kept in
 *   `<App_Data_Dir>/vault.key` (a blob only this user can open, not the key).
 * - macOS: the login keychain through `security -i`, which reads its commands from stdin, so the key is not in argv.
 * - Linux: the Secret Service through `secret-tool`, key on stdin.
 *
 * Every subprocess is started without a shell, with a small allow-listed environment (so `DAEMONIZE_SECRET_*` of the
 * Studio never reaches it) and a 15 s timeout. There is no plain-text fallback: when the store does not work, the
 * provider throws KeyStoreUnavailableError.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DPAPI_PROTECT, DPAPI_UNPROTECT, KEY_BYTES, KEY_SERVICE as SERVICE, LINUX_KEY_ATTRS, parseHexKey as parseHex } from '../replay/runtime/vault-format.js';

export class KeyStoreUnavailableError extends Error { }

export interface KeyProvider {
  readonly id: string;
  /** undefined when the store works and has no key yet. Throws KeyStoreUnavailableError on any other failure. */
  get(): Promise<Buffer | undefined>;
  /** Throws KeyStoreUnavailableError. */
  create(key: Buffer): Promise<void>;
}

export { KEY_BYTES, DPAPI_PROTECT, DPAPI_UNPROTECT };
const TIMEOUT_MS = 15_000;
const ENV_ALLOW = new Set(
  ['PATH', 'SystemRoot', 'windir', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY'].map((n) => n.toUpperCase())
);

/** The environment of a key-store process: an allow-list copy, so no secret of the Studio is inherited. */
export function minimalEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && ENV_ALLOW.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start (for example ENOENT) or timed out. */
  failure?: 'missing' | 'timeout' | 'error';
}
export interface RunOptions {
  input: string;
  env: Record<string, string>;
  timeoutMs: number;
}
export type RunProcess = (file: string, args: readonly string[], options: RunOptions) => Promise<ProcessResult>;

/** The real runner: `spawn` with `shell: false`, input on stdin only. */
export const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: options.env });
    } catch {
      resolveResult({ code: null, stdout: '', stderr: '', failure: 'error' });
      return;
    }
    const timer = setTimeout(() => {
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

const unavailable = (reason: string): KeyStoreUnavailableError => new KeyStoreUnavailableError(`The system key store is not available: ${reason}`);

function parseHexKey(text: string): Buffer {
  try {
    return parseHex(text);
  } catch {
    throw unavailable('the stored key is not valid');
  }
}

// ---------------------------------------------------------------------------
// Windows: DPAPI
// ---------------------------------------------------------------------------

export interface ProviderOptions {
  /** The App_Data_Dir (Windows blob file and the test `file` provider). */
  dataDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  run?: RunProcess;
}

function windowsProvider(options: ProviderOptions): KeyProvider {
  const run = options.run ?? runProcess;
  const env = minimalEnv(options.env ?? process.env);
  const root = (options.env ?? process.env).SystemRoot ?? (options.env ?? process.env).windir ?? process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const blobFile = (): string => {
    if (options.dataDir === undefined) throw unavailable('no data folder');
    return join(options.dataDir, 'vault.key');
  };
  const ps = async (script: string, input: string): Promise<string> => {
    const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { input, env, timeoutMs: TIMEOUT_MS });
    if (result.failure !== undefined || result.code !== 0) throw unavailable('Windows data protection did not answer');
    return result.stdout.trim();
  };
  return {
    id: 'dpapi',
    async get() {
      let blob: string;
      try {
        blob = (await readFile(blobFile(), 'utf-8')).trim();
      } catch (err) {
        if (err instanceof KeyStoreUnavailableError) throw err;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw unavailable('the key file cannot be read');
      }
      const key = Buffer.from(await ps(DPAPI_UNPROTECT, blob), 'base64');
      if (key.length !== KEY_BYTES) throw unavailable('the stored key is not valid');
      return key;
    },
    async create(key) {
      const blob = await ps(DPAPI_PROTECT, key.toString('base64'));
      if (blob === '') throw unavailable('Windows data protection returned nothing');
      const file = blobFile();
      const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        await writeFile(tmp, blob, { mode: 0o600, flag: 'wx' });
        await rename(tmp, file);
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw unavailable('the key file cannot be written');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// macOS: keychain through `security -i`
// ---------------------------------------------------------------------------

function macProvider(options: ProviderOptions): KeyProvider {
  const run = options.run ?? runProcess;
  const env = minimalEnv(options.env ?? process.env);
  const security = '/usr/bin/security';
  return {
    id: 'keychain',
    async get() {
      const r = await run(security, ['find-generic-password', '-a', 'daemonize', '-s', SERVICE, '-w'], { input: '', env, timeoutMs: TIMEOUT_MS });
      if (r.failure !== undefined) throw unavailable('the keychain did not answer');
      if (r.code === 44 || /could not be found/i.test(r.stderr)) return undefined;
      if (r.code !== 0) throw unavailable('the keychain refused the request');
      return parseHexKey(r.stdout);
    },
    async create(key) {
      // `security -i` reads commands from stdin: the key never appears in argv
      const r = await run(security, ['-i'], { input: `add-generic-password -U -a daemonize -s ${SERVICE} -w ${key.toString('hex')}\n`, env, timeoutMs: TIMEOUT_MS });
      if (r.failure !== undefined || r.code !== 0) throw unavailable('the keychain refused to store the key');
    },
  };
}

// ---------------------------------------------------------------------------
// Linux: Secret Service through secret-tool
// ---------------------------------------------------------------------------

function linuxProvider(options: ProviderOptions): KeyProvider {
  const run = options.run ?? runProcess;
  const env = minimalEnv(options.env ?? process.env);
  const attrs = LINUX_KEY_ATTRS;
  return {
    id: 'secret-service',
    async get() {
      const r = await run('secret-tool', ['lookup', ...attrs], { input: '', env, timeoutMs: TIMEOUT_MS });
      if (r.failure !== undefined) throw unavailable('secret-tool did not answer');
      if (r.code === 1 && r.stdout.trim() === '' && r.stderr.trim() === '') return undefined;
      if (r.code !== 0 || r.stderr.trim() !== '') throw unavailable('the keyring did not answer');
      return parseHexKey(r.stdout);
    },
    async create(key) {
      const r = await run('secret-tool', ['store', '--label=Daemonize Studio', ...attrs], { input: key.toString('hex'), env, timeoutMs: TIMEOUT_MS });
      if (r.failure !== undefined || r.code !== 0) throw unavailable('the keyring refused to store the key');
    },
  };
}

// ---------------------------------------------------------------------------
// Test providers (only when NODE_ENV is "test")
// ---------------------------------------------------------------------------

function testProvider(kind: string, options: ProviderOptions): KeyProvider | undefined {
  if (kind === 'unavailable') {
    return {
      id: 'test-unavailable',
      get: async () => {
        throw unavailable('test provider');
      },
      create: async () => {
        throw unavailable('test provider');
      },
    };
  }
  if (kind === 'memory') {
    let held: Buffer | undefined;
    return {
      id: 'test-memory',
      get: async () => held,
      create: async (key) => {
        held = Buffer.from(key);
      },
    };
  }
  if (kind === 'file') {
    const file = (): string => {
      if (options.dataDir === undefined) throw unavailable('no data folder');
      return join(options.dataDir, 'vault.key.test');
    };
    return {
      id: 'test-file',
      async get() {
        try {
          return parseHexKey(await readFile(file(), 'utf-8'));
        } catch (err) {
          if (err instanceof KeyStoreUnavailableError) throw err;
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw unavailable('test key file');
        }
      },
      async create(key) {
        const target = file();
        await writeFile(target, key.toString('hex'), { mode: 0o600 });
        await chmod(target, 0o600).catch(() => undefined);
      },
    };
  }
  return undefined;
}

/**
 * The provider of this platform. `DAEMONIZE_VAULT_KEY_PROVIDER` (memory, file, unavailable) is read only when
 * `NODE_ENV` is "test": in any other process it is ignored.
 */
export function createKeyProvider(options: ProviderOptions = {}): KeyProvider {
  const env = options.env ?? process.env;
  if (process.env.NODE_ENV === 'test') {
    const kind = env.DAEMONIZE_VAULT_KEY_PROVIDER;
    const test = kind === undefined ? undefined : testProvider(kind, options);
    if (test !== undefined) return test;
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return windowsProvider(options);
  if (platform === 'darwin') return macProvider(options);
  return linuxProvider(options);
}
