import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_SECRET_VALUE = ['Planted', 'Secret', 'Value-98765'].join('');
export const SERVER = 'sample-app';

/** A compiled Output_Dir with just what the Power_Installer reads. The source env holds a literal value on purpose. */
export async function writeCompiledOutput(dir: string, serverName = SERVER): Promise<void> {
  await mkdir(join(dir, 'skills', serverName), { recursive: true });
  await writeFile(join(dir, 'mcp-server.js'), '// server\n');
  await writeFile(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        [serverName]: {
          type: 'stdio',
          command: 'npx',
          args: ['evil'],
          env: {
            DAEMONIZE_SECRET_PASSWORD: FAKE_SECRET_VALUE,
            DAEMONIZE_SECRET_TOTP: '${DAEMONIZE_SECRET_TOTP}',
            DAEMONIZE_MODEL_API_KEY: FAKE_SECRET_VALUE,
            OTHER_TOKEN: FAKE_SECRET_VALUE,
            DAEMONIZE_MODE: 'heal',
          },
        },
      },
    })
  );
  await writeFile(join(dir, 'skills', serverName, 'SKILL.md'), `---\nname: ${serverName}\n---\nUse the tools.\n`);
}

// ---- fake home harness (G3b) ------------------------------------------------
// Everything lives in a temporary folder: a fake home, a workspace, an App_Data_Dir and a compiled output.
// The real ~/.kiro is never touched.
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FsOps } from '../../src/studio/power-fs.js';
import type { AppData, InstallScope, PowerInstaller, SecretVault } from '../../src/studio/contracts.js';
import { createAutoAddStore, type AutoAddStore } from '../../src/studio/auto-add-store.js';
import { createInstallRecords, type InstallRecords } from '../../src/studio/install-records.js';
import { createPowerInstaller } from '../../src/studio/power-installer.js';
import { removeDir } from './cleanup.js';

export interface Harness {
  base: string;
  home: string;
  ws: string;
  out: string;
  appDir: string;
  slug: string;
  /** What locate answers; change slug to simulate another active application. */
  app: { slug: string; outDir: string };
  /** The vault given in the options, or the stub. */
  vault: Pick<SecretVault, 'names' | 'namesFor'>;
  /** `<home>/.kiro` */
  kiroGlobal: string;
  /** `<ws>/.kiro` */
  kiroProject: string;
  installer: PowerInstaller;
  records: InstallRecords;
  autoAddStore: AutoAddStore;
  /** Names the stub vault reports as stored (bare Secret_Names). */
  stored: Set<string>;
  clock: { t: number };
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  /** Reuse a folder (a second application in the same fake home). */
  base?: string;
  slug?: string;
  applicationKey?: string;
  fsOps?: FsOps;
  stored?: string[];
  /** false: the App_Data_Dir cannot be used. */
  appDataOk?: boolean;
  /** A vault that fails on every call. */
  brokenVault?: boolean;
  /** A vault, or a factory that gets the App_Data_Dir (created first). Only 
ames and 
amesFor are used by the installer. */
  vault?: Pick<SecretVault, 'names' | 'namesFor'> | ((appDir: string) => Pick<SecretVault, 'names' | 'namesFor'>);
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'power-h-')));
  const slug = options.slug ?? SERVER;
  const home = join(base, 'home');
  const ws = join(base, 'ws');
  const appDir = join(base, 'appdata');
  const out = join(base, 'out', slug);
  await mkdir(home, { recursive: true });
  await mkdir(ws, { recursive: true });
  await writeCompiledOutput(out, slug);
  const appDataOk = options.appDataOk !== false;
  const appData: AppData = {
    dir: appDir,
    ensure: async () => {
      if (!appDataOk) return { ok: false, problem: 'not-writable' };
      await mkdir(appDir, { recursive: true });
      return { ok: true, dir: appDir };
    },
    check: async () => (appDataOk ? { ok: true, dir: appDir } : { ok: false, problem: 'not-writable' }),
  };
  const stored = new Set(options.stored ?? []);
  if (typeof options.vault === 'function' && appDataOk) await mkdir(appDir, { recursive: true });
  const app = { slug, outDir: out };
  const vault = (typeof options.vault === 'function' ? options.vault(appDir) : options.vault) ?? {
    names: async (): Promise<ReadonlySet<string>> => {
      if (options.brokenVault === true) throw new Error('vault unreadable');
      return new Set(stored);
    },
    namesFor: async (_key: string): Promise<ReadonlySet<string>> => {
      if (options.brokenVault === true) throw new Error('vault unreadable');
      return new Set(stored);
    },
  };
  const records = createInstallRecords({ appData });
  const autoAddStore = createAutoAddStore({ appData });
  const clock = { t: 1_000_000 };
  const installer = createPowerInstaller({
    locate: async () => ({ slug: app.slug, outDir: app.outDir, legacy: false, ...(options.applicationKey === undefined ? {} : { applicationKey: options.applicationKey }) }),
    cwd: ws,
    home,
    appData,
    vault,
    records,
    autoAdd: autoAddStore,
    now: () => clock.t,
    ...(options.fsOps === undefined ? {} : { fsOps: options.fsOps }),
  });
  return {
    base, home, ws, out, appDir, slug, app, vault,
    kiroGlobal: join(home, '.kiro'),
    kiroProject: join(ws, '.kiro'),
    installer, records, autoAddStore, stored, clock,
    cleanup: () => removeDir(base),
  };
}

/** Preview then install with the id and path of the preview. */
export async function fullInstall(h: Harness, scope: InstallScope, autoAdd?: boolean) {
  const preview = await h.installer.preview({ scope, ...(scope === 'project' ? { workspacePath: h.ws } : {}) });
  const result = await h.installer.install({ confirmationId: preview.confirmationId, kiroPath: preview.kiroPath, scope, ...(autoAdd === undefined ? {} : { autoAdd }) });
  return { preview, result };
}

/** `path:hex` of every file below `dir`, sorted. A missing folder gives []. */
export async function snapshotTree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        found.push(`${p}/`);
        await walk(p);
      } else found.push(`${p}:${(await readFile(p)).toString('hex')}`);
    }
  };
  await walk(dir);
  return found.sort();
}

/** Writes `settings/mcp.json` under a `.kiro` folder. */
export async function writeSettings(kiroDir: string, content: string | Buffer): Promise<string> {
  const file = join(kiroDir, 'settings', 'mcp.json');
  await mkdir(join(kiroDir, 'settings'), { recursive: true });
  await writeFile(file, content);
  return file;
}

// ---- generators for the property tests --------------------------------------
import fc from 'fast-check';
import { createKeyProvider } from '../../src/studio/key-providers.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';

/** A real vault with the `file` test key provider, stored in `dir` (a fake App_Data_Dir). */
export function realVaultIn(dir: string): SecretVault {
  const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', NODE_ENV: 'test' };
  return createSecretVault({
    appData: { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) },
    keyProvider: createKeyProvider({ dataDir: dir, env }),
  });
}

export const scopeArb: fc.Arbitrary<InstallScope> = fc.constantFrom<InstallScope>('global', 'project');

const scalar = fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean(), fc.constant(null));
const otherName = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/).filter((n) => n !== SERVER);
export const otherServers = fc.dictionary(
  otherName,
  fc.record({ command: fc.string({ maxLength: 6 }), args: fc.array(fc.string({ maxLength: 4 }), { maxLength: 2 }) }),
  { maxKeys: 4 }
);
export const topKeys = fc.dictionary(fc.stringMatching(/^[a-z][a-zA-Z]{1,8}$/).filter((k) => k !== 'mcpServers'), scalar, { maxKeys: 3 });

export interface ConfigCase {
  top: Record<string, unknown>;
  /** undefined: the object has no `mcpServers` key. */
  servers: Record<string, unknown> | undefined;
  /** The configuration already holds an entry under our server name. */
  withOurs: boolean;
  indent: 0 | 2 | 4 | '\t';
  bom: boolean;
  newline: boolean;
}
export const configArb: fc.Arbitrary<ConfigCase> = fc.record({
  top: topKeys,
  servers: fc.option(otherServers, { nil: undefined }),
  withOurs: fc.boolean(),
  indent: fc.constantFrom<0 | 2 | 4 | '\t'>(0, 2, 4, '\t'),
  bom: fc.boolean(),
  newline: fc.boolean(),
});

/** Text of a valid Target_Config for `c`, with its own whitespace and key order. */
export function renderConfig(c: ConfigCase): string {
  const root: Record<string, unknown> = { ...c.top };
  if (c.servers !== undefined || c.withOurs) root.mcpServers = { ...(c.servers ?? {}), ...(c.withOurs ? { [SERVER]: { command: 'old' } } : {}) };
  return (c.bom ? '\uFEFF' : '') + JSON.stringify(root, null, c.indent) + (c.newline ? '\n' : '');
}

export const kiroDirOf = (h: Harness, scope: InstallScope): string => (scope === 'global' ? h.kiroGlobal : h.kiroProject);
export const mcpPathOf = (h: Harness, scope: InstallScope): string => join(kiroDirOf(h, scope), 'settings', 'mcp.json');
export const skillDirOf = (h: Harness, scope: InstallScope): string => join(kiroDirOf(h, scope), 'skills', SERVER);
export const previewRequest = (h: Harness, scope: InstallScope) => ({ scope, ...(scope === 'project' ? { workspacePath: h.ws } : {}) });

/** Runs `body` with a fresh fake-home harness and always cleans it up. */
export async function withHarness<T>(body: (h: Harness) => Promise<T>, options?: HarnessOptions): Promise<T> {
  const h = await createHarness(options);
  try {
    return await body(h);
  } finally {
    await h.cleanup();
  }
}

/** Bytes of a file, or undefined when it does not exist. */
export async function readIfThere(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}
