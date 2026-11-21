/**
 * The installer of the Daemonize Power (the Studio_MCP entry, the agent, the skill and the steering), over the
 * all-or-nothing transaction of `power-fs.ts`. Files come from the package's own `power/` folder. Two steps (preview,
 * then install) bound by a single-use confirmation id, the scope and the exact `.kiro` path shown to the user.
 * Writes stay inside the chosen `.kiro` folder; only `${NAME}` placeholders and non-secret settings reach the entry.
 */
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PowerError,
  type AppData,
  type DaemonizePowerInstaller,
  type DaemonizePowerParts,
  type DaemonizePowerPlan,
  type InstallScope,
  type PowerFilePlan,
} from './contracts.js';
import { createInstallRecords, type InstallRecord, type InstallRecords } from './install-records.js';
import type { ServerEntry } from './mcp-snippet.js';
import {
  DP_FILES_MISSING,
  DP_NOTHING_TO_REMOVE,
  DP_PARTS_INVALID,
  DP_REMOVE_FAILED,
  DP_REPLACE_INVALID,
  DP_WRITE_FAILED,
} from './messages/daemonize-power.js';
import {
  POWER_CONFIRM_INVALID,
  POWER_FIELD_REQUIRED,
  POWER_KIRO_OUTSIDE,
  POWER_PATH_INVALID,
  POWER_PATH_NOT_ALLOWED,
  POWER_PATH_NOT_FOLDER,
  POWER_SCOPE_INVALID,
  POWER_SETTINGS_NOT_JSON,
  POWER_SETTINGS_NOT_OBJECT,
  POWER_SETTINGS_SERVERS_NOT_OBJECT,
  POWER_SETTINGS_TOO_LARGE,
  POWER_SETTINGS_UNREADABLE,
  POWER_TARGET_LINK,
} from './messages/power.js';
import { mergeServer, parseConfig, removeServer, serialize, sha256 } from './power-config.js';
import { beginTransaction, inside, realDeepest, type FsOps } from './power-fs.js';

export interface DaemonizePowerDeps {
  /** The workspace folder of the Studio. */
  cwd: string;
  /** The home folder of the account (or the test seam of the Studio). */
  home: string;
  appData: AppData;
  env: Record<string, string | undefined>;
  /** Test seams. */
  /** The `power/` folder (default: the one of the package). */
  powerDir?: string;
  /** The located program: `command` and the leading `args` (default: this node and the CLI of the package). */
  program?: { command: string; args: string[] };
  records?: InstallRecords;
  fsOps?: FsOps;
  now?: () => number;
}

/** The key of the Studio_MCP entry. The agent names it as `@daemonize-studio`. */
export const DAEMONIZE_SERVER_KEY = 'daemonize-studio';
const SETTINGS_REL = 'settings/mcp.json';
const SKILL_REL = 'skills/daemonize-builder/SKILL.md';
const AGENT_REL = 'agents/daemonize.md';
const STEERING_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;
const ALLOWED_REL = /^(skills\/daemonize-builder\/SKILL\.md|agents\/daemonize\.md|steering\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md)$/;
const RECORD_SLUG: Record<DaemonizePowerParts, string> = { power: 'daemonize-power', agent: 'daemonize-agent' };
const FILE_CAP = 1024 * 1024;
const SETTINGS_CAP = 2 * 1024 * 1024;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const CONFIRM_MAX = 8;
const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_KEY = /secret|token|password|passwd|credential|api[-_]?key|private/i;
const TOKEN_LIKE = /[A-Za-z0-9+/_-]{32,}/;

const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const same = (a: string, b: string): boolean => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const slash = (p: string): string => p.split('\\').join('/');

/** The files a record wrote, relative to its `.kiro` folder with forward slashes. */
const writtenRels = (record: InstallRecord): string[] => record.written.map((w) => slash(relative(record.kiroPath, w)));

interface Item {
  rel: string;
  abs: string;
  bytes: Buffer;
  prev?: Buffer;
  state: 'same' | 'create' | 'replace';
}
interface Source {
  files: Array<{ rel: string; bytes: Buffer }>;
  entry: Record<string, unknown>;
}
interface Plan {
  scope: InstallScope;
  parts: DaemonizePowerParts;
  workspace?: string;
  kiroPath: string;
  realKiro: string;
  items: Item[];
  settingsAbs: string;
  backupAbs: string;
  existing?: Buffer;
  existingBackup?: Buffer;
  merged: Buffer;
  /** The entry would change the settings file. */
  entryChanges: boolean;
  replacesEntry: boolean;
  newDirs: string[];
  conflicts: string[];
}
interface Confirmation {
  id: string;
  scope: InstallScope;
  parts: DaemonizePowerParts;
  kiroPath: string;
  workspace?: string;
  expires: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads a regular file (never a link) up to `cap` bytes; undefined otherwise. */
async function readRegular(path: string, cap: number): Promise<Buffer | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > cap) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

function parseScope(value: unknown): InstallScope {
  if (value === 'global' || value === 'project') return value;
  throw new PowerError(400, POWER_SCOPE_INVALID);
}
function parseParts(value: unknown): DaemonizePowerParts {
  if (value === undefined) return 'power';
  if (value === 'power' || value === 'agent') return value;
  throw new PowerError(400, DP_PARTS_INVALID);
}

function packagePowerDir(): string {
  // src/studio or dist/studio: two levels under the package root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'power');
}
function packageProgram(): { command: string; args: string[] } {
  return { command: process.execPath, args: [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js')] };
}

class StudioDaemonizePower implements DaemonizePowerInstaller {
  private confirmations: Confirmation[] = [];
  private readonly records: InstallRecords;
  private readonly now: () => number;

  constructor(private readonly deps: DaemonizePowerDeps) {
    this.records = deps.records ?? createInstallRecords({ appData: deps.appData });
    this.now = deps.now ?? Date.now;
  }

  async info(): Promise<{ installs: Array<{ scope: InstallScope; parts: DaemonizePowerParts }>; agentPresent: { project: boolean; global: boolean } }> {
    const list = await this.records.list().catch(() => [] as InstallRecord[]);
    const installs: Array<{ scope: InstallScope; parts: DaemonizePowerParts }> = [];
    for (const r of list) {
      const parts = (Object.keys(RECORD_SLUG) as DaemonizePowerParts[]).find((p) => RECORD_SLUG[p] === r.slug);
      if (parts !== undefined) installs.push({ scope: r.scope, parts });
    }
    return {
      installs,
      agentPresent: {
        project: await exists(join(this.deps.cwd, '.kiro', AGENT_REL)),
        global: await exists(join(this.deps.home, '.kiro', AGENT_REL)),
      },
    };
  }

  async preview(request: { scope: unknown; parts?: unknown; workspacePath?: unknown }): Promise<DaemonizePowerPlan> {
    const scope = parseScope(request.scope);
    const parts = parseParts(request.parts);
    const plan = await this.plan(scope, parts, request.workspacePath);
    const id = randomUUID();
    this.remember({
      id,
      scope,
      parts,
      kiroPath: plan.kiroPath,
      ...(plan.workspace === undefined ? {} : { workspace: plan.workspace }),
      expires: this.now() + CONFIRM_TTL_MS,
    });
    const files: PowerFilePlan[] = plan.items
      .filter((i) => i.state !== 'same')
      .map((i) => ({ path: i.rel, outcome: i.state === 'create' ? ('create' as const) : ('replace' as const) }));
    if (plan.entryChanges) files.push({ path: SETTINGS_REL, outcome: plan.existing === undefined ? 'create' : 'merge' });
    return {
      confirmationId: id,
      scope,
      parts,
      kiroPath: plan.kiroPath,
      files,
      conflicts: plan.conflicts,
      alreadyInstalled: files.length === 0,
      replacesEntry: plan.replacesEntry,
    };
  }

  async install(request: { confirmationId: unknown; kiroPath: unknown; scope: unknown; replace?: unknown }): Promise<{
    written: string[];
    skipped: string[];
    alreadyInstalled: boolean;
  }> {
    const scope = parseScope(request.scope);
    let replace: Set<string>;
    if (request.replace === undefined) replace = new Set();
    else if (Array.isArray(request.replace) && request.replace.length <= 64 && request.replace.every((r) => typeof r === 'string')) {
      replace = new Set(request.replace as string[]);
    } else throw new PowerError(400, DP_REPLACE_INVALID);
    const { confirmationId, kiroPath } = request;
    if (typeof confirmationId !== 'string' || typeof kiroPath !== 'string') throw new PowerError(409, POWER_CONFIRM_INVALID);
    this.prune();
    const index = this.confirmations.findIndex((c) => c.id === confirmationId);
    const stored = index < 0 ? undefined : this.confirmations[index];
    if (stored === undefined || stored.scope !== scope || stored.kiroPath !== kiroPath) throw new PowerError(409, POWER_CONFIRM_INVALID);
    this.confirmations.splice(index, 1); // single use
    const plan = await this.plan(scope, stored.parts, stored.workspace);
    if (plan.kiroPath !== stored.kiroPath) throw new PowerError(409, POWER_CONFIRM_INVALID);

    const toWrite = plan.items.filter((i) => i.state === 'create' || (i.state === 'replace' && replace.has(i.rel)));
    const entryReplaceAsked = !plan.replacesEntry || replace.has(SETTINGS_REL);
    const writeEntry = plan.entryChanges && entryReplaceAsked;
    const skipped = plan.conflicts.filter((c) => !replace.has(c));
    if (toWrite.length === 0 && !writeEntry) return { written: [], skipped, alreadyInstalled: skipped.length === 0 };

    const prior = await this.priorRecords(scope, plan.kiroPath);
    const holdsEntry = (r: InstallRecord): boolean => writtenRels(r).includes(SETTINGS_REL);
    const entryOwned = prior.some(holdsEntry);
    const backupNow = writeEntry && plan.existing !== undefined && !entryOwned;

    const tx = beginTransaction(this.deps.fsOps);
    if (backupNow) tx.write(plan.backupAbs, plan.existing as Buffer);
    for (const item of toWrite) tx.write(item.abs, item.bytes);
    if (writeEntry) tx.write(plan.settingsAbs, plan.merged); // last
    try {
      await tx.commit();
    } catch {
      throw new PowerError(500, DP_WRITE_FAILED);
    }

    const slug = RECORD_SLUG[plan.parts];
    const own = prior.find((r) => r.slug === slug);
    const written = [...toWrite.map((i) => i.rel), ...(writeEntry ? [SETTINGS_REL] : [])].map((rel) => join(plan.kiroPath, ...rel.split('/')));
    const backup = backupNow ? true : (own?.backup ?? prior.find(holdsEntry)?.backup ?? false);
    const record: InstallRecord = {
      slug,
      scope,
      kiroPath: plan.kiroPath,
      written: [...new Set([...(own?.written ?? []), ...written])],
      skillDir: join(plan.realKiro, 'skills', 'daemonize-builder'),
      configSha256: sha256(writeEntry ? plan.merged : (plan.existing ?? Buffer.alloc(0))),
      backup,
      installedAt: new Date(this.now()).toISOString(),
    };
    try {
      await this.records.put(record);
    } catch {
      await this.undo(plan, toWrite, writeEntry, backupNow);
      throw new PowerError(500, DP_WRITE_FAILED);
    }
    return {
      written: [...toWrite.map((i) => i.rel), ...(writeEntry ? [SETTINGS_REL] : [])],
      skipped,
      alreadyInstalled: false,
    };
  }

  async remove(request: { scope: unknown; parts?: unknown }): Promise<{ removed: string[] }> {
    const scope = parseScope(request.scope);
    const chosen: DaemonizePowerParts[] = request.parts === undefined ? ['power', 'agent'] : [parseParts(request.parts)];
    let all: InstallRecord[];
    try {
      all = await this.records.list();
    } catch {
      throw new PowerError(500, DP_REMOVE_FAILED);
    }
    const slugs = chosen.map((p) => RECORD_SLUG[p]);
    const targets = all.filter((r) => r.scope === scope && slugs.includes(r.slug));
    if (targets.length === 0) throw new PowerError(409, DP_NOTHING_TO_REMOVE);

    const tx = beginTransaction(this.deps.fsOps);
    const removed = new Set<string>();
    const dirs = new Set<string>();
    const settingsDone = new Set<string>();
    for (const record of targets.sort((a, b) => a.installedAt.localeCompare(b.installedAt))) {
      const realKiro = await this.confineRecord(record);
      const keep = all.filter((r) => r !== record && !targets.includes(r) && r.scope === scope && same(r.kiroPath, record.kiroPath));
      const stillWritten = (rel: string): boolean => keep.some((r) => writtenRels(r).includes(rel));
      const settingsAbs = join(realKiro, 'settings', 'mcp.json');
      const backupAbs = settingsAbs + '.bak';
      const rels = writtenRels(record);
      const ownsEntry = rels.includes(SETTINGS_REL);
      // never delete anything the installer would not write
      const fileRels = rels.filter((rel) => ALLOWED_REL.test(rel));
      const fileTargets = fileRels.map((rel) => join(realKiro, ...rel.split('/')));
      await this.checkTargets(realKiro, [...fileTargets, settingsAbs, backupAbs]);
      fileRels.forEach((rel, i) => {
        if (stillWritten(rel) || removed.has(rel)) return;
        const file = fileTargets[i] as string;
        tx.remove(file);
        removed.add(rel);
        dirs.add(dirname(file));
      });
      if (ownsEntry && !stillWritten(SETTINGS_REL) && !settingsDone.has(settingsAbs)) {
        settingsDone.add(settingsAbs);
        const bytes = await this.readSettings(settingsAbs);
        if (bytes !== undefined) {
          const root = this.parseSettings(bytes);
          const servers = root.mcpServers;
          const backupBytes = record.backup ? await readRegular(backupAbs, SETTINGS_CAP) : undefined;
          if (sha256(bytes) === record.configSha256 && backupBytes !== undefined) {
            tx.write(settingsAbs, backupBytes);
            removed.add(SETTINGS_REL);
          } else if (
            sha256(bytes) === record.configSha256 && !record.backup && Object.keys(root).length === 1 &&
            isPlainObject(servers) && Object.keys(servers).length === 1 && has(servers, DAEMONIZE_SERVER_KEY)
          ) {
            tx.remove(settingsAbs);
            removed.add(SETTINGS_REL);
          } else {
            const result = removeServer(root, DAEMONIZE_SERVER_KEY);
            if (result.removed) {
              tx.write(settingsAbs, serialize(result.root));
              removed.add(SETTINGS_REL);
            }
          }
        }
      }
    }
    try {
      await tx.commit();
    } catch {
      throw new PowerError(500, DP_REMOVE_FAILED);
    }
    // The files are already restored; a stale record is harmless because removal can be repeated
    for (const record of targets) await this.records.delete(record.slug, record.scope).catch(() => undefined);
    for (const dir of dirs) await rmdir(dir).catch(() => undefined); // only empty folders go
    return { removed: [...removed].sort() };
  }

  // ---- internals -----------------------------------------------------------

  private prune(): void {
    const now = this.now();
    this.confirmations = this.confirmations.filter((c) => c.expires > now);
  }

  private remember(entry: Confirmation): void {
    this.prune();
    this.confirmations = this.confirmations.filter((c) => !(c.scope === entry.scope && c.parts === entry.parts && same(c.kiroPath, entry.kiroPath)));
    this.confirmations.push(entry);
    while (this.confirmations.length > CONFIRM_MAX) this.confirmations.shift();
  }

  private async priorRecords(scope: InstallScope, kiroPath: string): Promise<InstallRecord[]> {
    try {
      const slugs = Object.values(RECORD_SLUG);
      return (await this.records.list()).filter((r) => r.scope === scope && slugs.includes(r.slug) && same(r.kiroPath, kiroPath));
    } catch {
      return [];
    }
  }

  /** The files of the package's `power/` folder, and the entry rebuilt from `mcp.json` (placeholders and plain settings only). */
  private async readSource(parts: DaemonizePowerParts): Promise<Source> {
    const dir = this.deps.powerDir ?? packagePowerDir();
    const missing = new PowerError(409, DP_FILES_MISSING);
    const files: Array<{ rel: string; bytes: Buffer }> = [];
    const skill = await readRegular(join(dir, ...SKILL_REL.split('/')), FILE_CAP);
    const agent = await readRegular(join(dir, ...AGENT_REL.split('/')), FILE_CAP);
    const rawMcp = await readRegular(join(dir, 'mcp.json'), FILE_CAP);
    if (skill === undefined || agent === undefined || rawMcp === undefined) throw missing;
    files.push({ rel: SKILL_REL, bytes: skill }, { rel: AGENT_REL, bytes: agent });
    if (parts === 'power') {
      let names: string[] = [];
      try {
        names = (await readdir(join(dir, 'steering'))).filter((n) => STEERING_FILE.test(n)).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const bytes = await readRegular(join(dir, 'steering', name), FILE_CAP);
        if (bytes !== undefined) files.push({ rel: `steering/${name}`, bytes });
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMcp.toString('utf-8'));
    } catch {
      throw missing;
    }
    const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined;
    const first = isPlainObject(servers) ? servers[Object.keys(servers)[0] ?? ''] : undefined;
    if (!isPlainObject(first)) throw missing;
    const sourceArgs = Array.isArray(first.args) && first.args.every((a) => typeof a === 'string') ? (first.args as string[]) : [];
    const program = this.deps.program ?? packageProgram();
    const useProgram = first.command === 'daemonize';
    const env: Record<string, string> = {};
    if (isPlainObject(first.env)) {
      for (const key of Object.keys(first.env).sort()) {
        const value = first.env[key];
        if (typeof value !== 'string') continue;
        const placeholder = PLACEHOLDER.test(value);
        if (!placeholder && (SECRET_KEY.test(key) || value.length > 200 || TOKEN_LIKE.test(value))) continue;
        env[key] = value;
      }
    }
    const command = useProgram ? program.command : typeof first.command === 'string' ? first.command : undefined;
    if (command === undefined) throw missing;
    return { files, entry: { type: 'stdio', command, args: useProgram ? [...program.args, ...sourceArgs] : sourceArgs, env } };
  }

  /** Real base folder of the scope: the home, or the validated workspace (default: the folder of the Studio). */
  private async resolveBase(scope: InstallScope, workspacePath: unknown): Promise<{ base: string; workspace?: string }> {
    if (scope === 'global') return { base: await realDeepest(this.deps.home || homedir()) };
    const chosen = workspacePath === undefined ? this.deps.cwd : workspacePath;
    if (typeof chosen !== 'string' || chosen.trim().length === 0) throw new PowerError(400, POWER_FIELD_REQUIRED);
    const text = chosen.trim();
    const absolute = process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text) : isAbsolute(text);
    if (text.length > 1024 || text.includes('\0') || !absolute || !isAbsolute(text)) throw new PowerError(400, POWER_PATH_INVALID);
    let real: string;
    try {
      real = await realpath(text);
      if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new PowerError(400, POWER_PATH_NOT_FOLDER);
    }
    if (real.split(/[\\/]/).includes('node_modules')) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    if (this.deps.appData.dir !== undefined && inside(real, await realDeepest(this.deps.appData.dir))) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    return { base: real, workspace: real };
  }

  /** `.kiro` must be a folder whose real path lies inside `base`. Returns its real path (or the plain path when absent). */
  private async confineKiro(base: string, kiroPath: string): Promise<string> {
    if (!(await exists(kiroPath))) return join(base, '.kiro');
    try {
      const real = await realpath(kiroPath);
      if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
      if (!inside(real, base)) throw new Error('outside');
      return real;
    } catch {
      throw new PowerError(409, POWER_KIRO_OUTSIDE);
    }
  }

  /** Re-checks the `.kiro` folder that an install record names. */
  private async confineRecord(record: InstallRecord): Promise<string> {
    const kiroPath = record.kiroPath;
    if (!isAbsolute(kiroPath) || basename(kiroPath) !== '.kiro') throw new PowerError(409, POWER_KIRO_OUTSIDE);
    const base = dirname(kiroPath);
    if (record.scope === 'global' && !same(await realDeepest(base), await realDeepest(this.deps.home || homedir()))) {
      throw new PowerError(409, POWER_KIRO_OUTSIDE);
    }
    return this.confineKiro(await realDeepest(base), kiroPath);
  }

  /** Every target stays inside the real `.kiro`, is not a link and is a regular file when it exists. */
  private async checkTargets(realKiro: string, files: string[]): Promise<void> {
    for (const file of files) {
      if (!inside(await realDeepest(dirname(file)), realKiro)) throw new PowerError(409, POWER_KIRO_OUTSIDE);
      let current = dirname(file);
      while (inside(current, realKiro) && !same(current, realKiro)) {
        const dirInfo = await lstat(current).catch(() => undefined);
        if (dirInfo?.isSymbolicLink() === true) throw new PowerError(409, POWER_TARGET_LINK);
        current = dirname(current);
      }
      const info = await lstat(file).catch(() => undefined);
      if (info?.isSymbolicLink() === true) throw new PowerError(409, POWER_TARGET_LINK);
      if (info !== undefined && !info.isFile()) throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
    }
  }

  private async readSettings(path: string): Promise<Buffer | undefined> {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return undefined;
    if (info.size > SETTINGS_CAP) throw new PowerError(409, POWER_SETTINGS_TOO_LARGE);
    try {
      return await readFile(path);
    } catch {
      throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
    }
  }

  private parseSettings(bytes: Buffer): Record<string, unknown> {
    const parsed = parseConfig(bytes);
    if (parsed.ok) return parsed.root;
    throw new PowerError(
      409,
      parsed.reason === 'json' ? POWER_SETTINGS_NOT_JSON : parsed.reason === 'not-object' ? POWER_SETTINGS_NOT_OBJECT : POWER_SETTINGS_SERVERS_NOT_OBJECT
    );
  }

  /** Validates the scope root and the files to write, and builds the bytes. Reads only. */
  private async plan(scope: InstallScope, parts: DaemonizePowerParts, workspacePath: unknown): Promise<Plan> {
    const { base, workspace } = await this.resolveBase(scope, workspacePath);
    const realKiro = await this.confineKiro(base, join(base, '.kiro'));
    const source = await this.readSource(parts);
    const settingsAbs = join(realKiro, 'settings', 'mcp.json');
    const backupAbs = settingsAbs + '.bak';
    const items: Item[] = [];
    for (const f of source.files) {
      const abs = join(realKiro, ...f.rel.split('/'));
      const prev = await readRegular(abs, FILE_CAP);
      const info = await lstat(abs).catch(() => undefined);
      // an existing item that is not a readable regular file is refused by checkTargets below
      items.push({ rel: f.rel, abs, bytes: f.bytes, ...(prev === undefined ? {} : { prev }), state: info === undefined ? 'create' : prev?.equals(f.bytes) === true ? 'same' : 'replace' });
    }
    await this.checkTargets(realKiro, [...items.map((i) => i.abs), settingsAbs, backupAbs]);

    const existing = await this.readSettings(settingsAbs);
    const root = existing === undefined ? {} : this.parseSettings(existing);
    const merged = serialize(mergeServer(root, DAEMONIZE_SERVER_KEY, source.entry as ServerEntry));
    const servers = root.mcpServers;
    const replacesEntry = isPlainObject(servers) && has(servers, DAEMONIZE_SERVER_KEY) && JSON.stringify(servers[DAEMONIZE_SERVER_KEY]) !== JSON.stringify(source.entry);
    const entryChanges = existing === undefined || !existing.equals(merged);
    const existingBackup = await readRegular(backupAbs, SETTINGS_CAP);

    const newDirs: string[] = [];
    for (const dir of new Set([...items.filter((i) => i.state === 'create').map((i) => dirname(i.abs)), dirname(settingsAbs), realKiro])) {
      if (!(await exists(dir))) newDirs.push(dir);
    }
    newDirs.sort((a, b) => b.length - a.length);
    const conflicts = items.filter((i) => i.state === 'replace').map((i) => i.rel);
    if (replacesEntry) conflicts.push(SETTINGS_REL);
    return {
      scope,
      parts,
      ...(workspace === undefined ? {} : { workspace }),
      kiroPath: join(base, '.kiro'),
      realKiro,
      items,
      settingsAbs,
      backupAbs,
      ...(existing === undefined ? {} : { existing }),
      ...(existingBackup === undefined ? {} : { existingBackup }),
      merged,
      entryChanges,
      replacesEntry,
      newDirs,
      conflicts,
    };
  }

  /** Puts every file the install touched back to its previous bytes, or removes it. Best effort. */
  private async undo(plan: Plan, written: Item[], wroteEntry: boolean, wroteBackup: boolean): Promise<void> {
    const tx = beginTransaction(this.deps.fsOps);
    for (const item of written) {
      if (item.prev === undefined) tx.remove(item.abs);
      else tx.write(item.abs, item.prev);
    }
    if (wroteEntry) {
      if (plan.existing === undefined) tx.remove(plan.settingsAbs);
      else tx.write(plan.settingsAbs, plan.existing);
    }
    if (wroteBackup) {
      if (plan.existingBackup === undefined) tx.remove(plan.backupAbs);
      else tx.write(plan.backupAbs, plan.existingBackup);
    }
    await tx.commit().catch(() => undefined);
    for (const dir of plan.newDirs) await rmdir(dir).catch(() => undefined);
  }
}

export function createDaemonizePower(deps: DaemonizePowerDeps): DaemonizePowerInstaller {
  return new StudioDaemonizePower(deps);
}
