/**
 * Connects the compiled tool to Kiro, for all projects (`global`, `<home>/.kiro`) or one project
 * (`<workspace>/.kiro`). Two steps (preview, then install), bound by a confirmation id, the scope and the exact
 * `.kiro` path shown to the user. One code path for both scopes: only the root differs. Writes go through one
 * all-or-nothing transaction. Entries are rebuilt with placeholders only. See design "8. Power installer".
 */
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  PowerError,
  type ActiveApplication,
  type AppData,
  type AutoAddOutcome,
  type AutoAddState,
  type InstallScope,
  type PowerFilePlan,
  type PowerInfo,
  type PowerInstaller,
  type PowerPreview,
  type SecretVault,
} from './contracts.js';
import type { AutoAddStore } from './auto-add-store.js';
import type { InstallRecord, InstallRecords } from './install-records.js';
import { buildServerEntry, buildSnippetText, secretPlaceholders, type ServerEntry } from './mcp-snippet.js';
import { mergeServer, parseConfig, removeServer, serialize, sha256, targetPaths, type TargetPaths } from './power-config.js';
import { beginTransaction, inside, realDeepest, type FsOps } from './power-fs.js';
import {
  POWER_AUTO_ADD_FAILED,
  POWER_CONFIRM_INVALID,
  POWER_FIELD_REQUIRED,
  POWER_KIRO_OUTSIDE,
  POWER_NOT_COMPILED,
  POWER_NOTHING_TO_REMOVE,
  POWER_PATH_INVALID,
  POWER_PATH_NOT_ALLOWED,
  POWER_PATH_NOT_FOLDER,
  POWER_REMOVE_FAILED,
  POWER_SCOPE_INVALID,
  POWER_SETTINGS_NOT_JSON,
  POWER_SETTINGS_NOT_OBJECT,
  POWER_SETTINGS_SERVERS_NOT_OBJECT,
  POWER_SETTINGS_TOO_LARGE,
  POWER_SETTINGS_UNREADABLE,
  POWER_TARGET_LINK,
  POWER_WRITE_FAILED,
} from './messages/power.js';

export interface PowerInstallerDeps {
  /** The active application: slug, key and the folder of the compiled tool. */
  locate: () => Promise<ActiveApplication>;
  /** The folder the Studio runs in: the default Target_Workspace. */
  cwd: string;
  /** Injected home folder (default the account's home). */
  home?: string;
  appData: AppData;
  vault: Pick<SecretVault, 'namesFor' | 'names'>;
  records: InstallRecords;
  autoAdd: AutoAddStore;
  /** Test seams. */
  now?: () => number;
  fsOps?: FsOps;
}

const SOURCE_CAP = 1024 * 1024;
const SETTINGS_CAP = 2 * 1024 * 1024;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const CONFIRM_MAX = 8;
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_VARIABLE = /^DAEMONIZE_SECRET_([A-Za-z0-9_]+)$/;

interface Source {
  slug: string;
  entry: ServerEntry;
  skill: Buffer;
  /** Names (without the prefix) of the secrets the compiled tool needs. */
  required: string[];
}
interface Plan {
  scope: InstallScope;
  slug: string;
  applicationKey?: string;
  /** Real workspace (project scope only). */
  workspace?: string;
  /** The `.kiro` path shown to the user. */
  kiroPath: string;
  paths: TargetPaths;
  existing?: Buffer;
  existingBackup?: Buffer;
  existingSkill?: Buffer;
  skillExists: boolean;
  /** Folders this install would create, deepest first. */
  newDirs: string[];
  merged: Buffer;
  skill: Buffer;
  configWrite: boolean;
  skillWrite: boolean;
  entry: ServerEntry;
  replacesEntry: boolean;
  missing: string[];
  /** Sorted names of every secret the tool needs (names only). */
  required: string[];
  otherScopeInstalled?: InstallScope;
}
interface Confirmation {
  id: string;
  scope: InstallScope;
  kiroPath: string;
  slug: string;
  workspace?: string;
  expires: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const same = (a: string, b: string): boolean => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCapped(path: string, cap: number): Promise<Buffer | undefined> {
  try {
    const info = await stat(path);
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

export class StudioPowerInstaller implements PowerInstaller {
  private confirmations: Confirmation[] = [];
  private lastAutoAdd: AutoAddOutcome | undefined;
  private readonly now: () => number;
  private readonly home: string;

  constructor(private readonly deps: PowerInstallerDeps) {
    this.now = deps.now ?? Date.now;
    this.home = deps.home ?? homedir();
  }

  async info(): Promise<PowerInfo> {
    let app: ActiveApplication | undefined;
    try {
      app = await this.deps.locate();
    } catch {
      app = undefined;
    }
    const source = app === undefined ? undefined : await this.readSource(app).catch(() => undefined);
    const kiroHome = join(this.home, '.kiro');
    const records = await this.deps.records.list().catch(() => [] as InstallRecord[]);
    const installs = records
      .filter((r) => app === undefined || r.slug === app.slug)
      .map((r) => ({ scope: r.scope, slug: r.slug, kiroPath: r.kiroPath }));
    return {
      kiroHome,
      kiroHomeExists: await exists(kiroHome),
      installs,
      available: source !== undefined,
      defaultWorkspace: this.deps.cwd,
      outputPath: app?.outDir ?? this.deps.cwd,
      ...(source === undefined ? {} : { serverName: source.slug }),
    };
  }

  async snippet(): Promise<string> {
    const app = await this.deps.locate();
    const source = await this.readSource(app);
    const { entry } = await this.buildEntry(app, source);
    return buildSnippetText(source.slug, entry);
  }

  async preview(request: { scope: unknown; workspacePath?: unknown }): Promise<PowerPreview> {
    const scope = parseScope(request.scope);
    const app = await this.deps.locate();
    const plan = await this.plan(app, scope, request.workspacePath);
    const id = randomUUID();
    this.remember({
      id,
      scope,
      kiroPath: plan.kiroPath,
      slug: plan.slug,
      ...(plan.workspace === undefined ? {} : { workspace: plan.workspace }),
      expires: this.now() + CONFIRM_TTL_MS,
    });
    const files: PowerFilePlan[] = [
      { path: 'settings/mcp.json', outcome: plan.existing === undefined ? 'create' : 'merge' },
      { path: `skills/${plan.slug}/SKILL.md`, outcome: plan.skillExists ? 'replace' : 'create' },
    ];
    return {
      confirmationId: id,
      scope,
      kiroPath: plan.kiroPath,
      files,
      replacesEntry: plan.replacesEntry,
      serverName: plan.slug,
      placeholders: secretPlaceholders(plan.entry),
      missingSecrets: plan.missing,
      requiredSecrets: plan.required,
      backup: plan.existing !== undefined,
      ...(plan.otherScopeInstalled === undefined ? {} : { otherScopeInstalled: plan.otherScopeInstalled }),
    };
  }

  async install(request: { confirmationId: unknown; kiroPath: unknown; scope: unknown; autoAdd?: unknown }): Promise<{
    written: string[];
    placeholders: string[];
    missingSecrets: string[];
    requiredSecrets: string[];
    scope: InstallScope;
    autoAddSaved?: boolean;
  }> {
    const scope = parseScope(request.scope);
    const { confirmationId, kiroPath } = request;
    if (typeof confirmationId !== 'string' || typeof kiroPath !== 'string') throw new PowerError(409, POWER_CONFIRM_INVALID);
    this.prune();
    const app = await this.deps.locate();
    const index = this.confirmations.findIndex((c) => c.id === confirmationId);
    const stored = index < 0 ? undefined : this.confirmations[index];
    if (stored === undefined || stored.scope !== scope || stored.kiroPath !== kiroPath || stored.slug !== app.slug) {
      throw new PowerError(409, POWER_CONFIRM_INVALID);
    }
    this.confirmations.splice(index, 1); // single use
    const plan = await this.plan(app, scope, stored.workspace);
    if (plan.kiroPath !== stored.kiroPath) throw new PowerError(409, POWER_CONFIRM_INVALID);

    const result = await this.perform(plan, app);
    let autoAddSaved: boolean | undefined;
    if (request.autoAdd === true) {
      try {
        await this.deps.autoAdd.write({ enabled: true, scope, ...(scope === 'project' && plan.workspace !== undefined ? { workspacePath: plan.workspace } : {}) });
        autoAddSaved = true;
      } catch {
        autoAddSaved = false;
      }
    }
    return {
      written: result.written,
      placeholders: secretPlaceholders(plan.entry),
      missingSecrets: plan.missing,
      requiredSecrets: plan.required,
      scope,
      ...(autoAddSaved === undefined ? {} : { autoAddSaved }),
    };
  }

  async remove(request: { scope: unknown }): Promise<{ removed: string[] }> {
    const scope = parseScope(request.scope);
    const app = await this.deps.locate();
    let records: InstallRecord[];
    try {
      records = await this.deps.records.list();
    } catch {
      throw new PowerError(500, POWER_REMOVE_FAILED);
    }
    const record = records.find((r) => r.slug === app.slug && r.scope === scope);
    if (record === undefined) throw new PowerError(409, POWER_NOTHING_TO_REMOVE);

    // Re-check confinement of what the record names
    const kiroPath = record.kiroPath;
    if (!isAbsolute(kiroPath) || basename(kiroPath) !== '.kiro') throw new PowerError(409, POWER_KIRO_OUTSIDE);
    const base = dirname(kiroPath);
    if (scope === 'global' && !same(await realDeepest(base), await realDeepest(this.home))) throw new PowerError(409, POWER_KIRO_OUTSIDE);
    const realKiro = await this.confineKiro(await realDeepest(base), kiroPath);
    const paths = targetPaths(scope, realKiro, record.slug);
    if (!same(paths.skillDir, record.skillDir) && !same(join(kiroPath, 'skills', record.slug), record.skillDir)) {
      throw new PowerError(409, POWER_KIRO_OUTSIDE);
    }
    await this.checkTargets(realKiro, [paths.mcp, paths.backup, paths.skill], paths.skillDir);

    // What the config needs
    const tx = beginTransaction(this.deps.fsOps);
    const removed: string[] = [];
    const bytes = await this.readSettings(paths.mcp);
    if (bytes !== undefined) {
      const parsed = this.parseSettings(bytes);
      if (sha256(bytes) === record.configSha256 && record.backup && (await exists(paths.backup))) {
        const backupBytes = await readCapped(paths.backup, SETTINGS_CAP);
        if (backupBytes === undefined) throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
        tx.write(paths.mcp, backupBytes);
        removed.push(paths.mcp);
      } else {
        const servers = parsed.mcpServers;
        const onlyOurs =
          sha256(bytes) === record.configSha256 && !record.backup && Object.keys(parsed).length === 1 &&
          isPlainObject(servers) && Object.keys(servers).length === 1 && has(servers, record.slug);
        if (onlyOurs) {
          tx.remove(paths.mcp);
          removed.push(paths.mcp);
        } else {
          const result = removeServer(parsed, record.slug);
          if (result.removed) {
            tx.write(paths.mcp, serialize(result.root));
            removed.push(paths.mcp);
          }
        }
      }
    }
    if (await exists(paths.skillDir)) {
      tx.removeDir(paths.skillDir);
      removed.push(paths.skillDir);
    }
    try {
      await tx.commit();
    } catch {
      throw new PowerError(500, POWER_REMOVE_FAILED);
    }
    // The files are already restored; a stale record is harmless because removal can be repeated
    await this.deps.records.delete(record.slug, record.scope).catch(() => undefined);
    return { removed };
  }

  async getAutoAdd(): Promise<AutoAddState> {
    let enabled = false;
    let scope: InstallScope | undefined;
    try {
      const setting = await this.deps.autoAdd.read();
      if (setting !== undefined) {
        enabled = true;
        scope = setting.scope;
      }
    } catch {
      enabled = false;
    }
    const writable = (await this.deps.appData.check()).ok;
    return { enabled, ...(scope === undefined ? {} : { scope }), writable, ...(this.lastAutoAdd === undefined ? {} : { last: this.lastAutoAdd }) };
  }

  async disableAutoAdd(): Promise<AutoAddState> {
    try {
      await this.deps.autoAdd.clear();
    } catch {
      throw new PowerError(500, POWER_AUTO_ADD_FAILED);
    }
    return this.getAutoAdd();
  }

  async runAutoAdd(): Promise<AutoAddOutcome> {
    try {
      let setting;
      try {
        setting = await this.deps.autoAdd.read();
      } catch {
        return { status: 'disabled' };
      }
      if (setting === undefined) return { status: 'disabled' };
      let outcome: AutoAddOutcome;
      try {
        if (setting.scope === 'project' && setting.workspacePath === undefined) throw new PowerError(409, POWER_AUTO_ADD_FAILED);
        const app = await this.deps.locate();
        const plan = await this.plan(app, setting.scope, setting.workspacePath);
        const result = await this.perform(plan, app);
        outcome = { status: result.changed ? 'added' : 'unchanged' };
      } catch (error) {
        outcome = { status: 'failed', message: error instanceof PowerError ? error.message : POWER_AUTO_ADD_FAILED };
      }
      this.lastAutoAdd = outcome;
      return outcome;
    } catch {
      return { status: 'failed', message: POWER_AUTO_ADD_FAILED };
    }
  }

  // ---- internals -----------------------------------------------------------

  private prune(): void {
    const now = this.now();
    this.confirmations = this.confirmations.filter((c) => c.expires > now);
  }

  private remember(entry: Confirmation): void {
    this.prune();
    this.confirmations = this.confirmations.filter((c) => !(c.scope === entry.scope && same(c.kiroPath, entry.kiroPath)));
    this.confirmations.push(entry);
    while (this.confirmations.length > CONFIRM_MAX) this.confirmations.shift();
  }

  /** The compiled `mcp.json` entry, the skill, and the secret names the tool needs. */
  private async readSource(app: ActiveApplication): Promise<Source> {
    const notCompiled = new PowerError(409, POWER_NOT_COMPILED);
    if (!SERVER_NAME.test(app.slug)) throw notCompiled;
    const serverJs = join(app.outDir, 'mcp-server.js');
    const serverInfo = await stat(serverJs).catch(() => undefined);
    if (serverInfo === undefined || !serverInfo.isFile()) throw notCompiled;
    const raw = await readCapped(join(app.outDir, 'mcp.json'), SOURCE_CAP);
    if (raw === undefined) throw notCompiled;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      throw notCompiled;
    }
    const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined;
    if (!isPlainObject(servers)) throw notCompiled;
    const source = has(servers, app.slug) ? servers[app.slug] : servers[Object.keys(servers)[0] ?? ''];
    if (!isPlainObject(source)) throw notCompiled;
    const skill = await readCapped(join(app.outDir, 'skills', app.slug, 'SKILL.md'), SOURCE_CAP);
    if (skill === undefined) throw notCompiled;
    const env = isPlainObject(source.env) ? source.env : {};
    const required = Object.keys(env)
      .map((k) => SECRET_VARIABLE.exec(k)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
    // Placeholders only: the entry is rebuilt below, the source is never copied
    return { slug: app.slug, entry: buildServerEntry(source, resolve(serverJs)), skill, required };
  }

  /** The entry for this application, with the vault status of each required name (names only). */
  private async buildEntry(app: ActiveApplication, source: Source): Promise<{ entry: ServerEntry; missing: string[] }> {
    let configured: ReadonlySet<string>;
    try {
      configured = app.applicationKey === undefined ? await this.deps.vault.names() : await this.deps.vault.namesFor(app.applicationKey);
    } catch {
      configured = new Set<string>();
    }
    const appData = await this.deps.appData.check().catch(() => undefined);
    const serverJs = resolve(join(app.outDir, 'mcp-server.js'));
    const sourceEnv: Record<string, string> = {};
    for (const name of source.required) sourceEnv[`DAEMONIZE_SECRET_${name}`] = '';
    const entry = buildServerEntry({ env: sourceEnv }, serverJs, {
      ...(appData?.ok === true ? { dataDir: appData.dir } : {}),
      ...(app.applicationKey === undefined ? {} : { applicationKey: app.applicationKey }),
      configuredNames: configured,
    });
    const missing = source.required.filter((n) => !configured.has(n));
    return { entry, missing };
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

  /** Every target stays inside the real `.kiro`, is not a link and is a regular file when it exists. */
  private async checkTargets(realKiro: string, files: string[], skillDir: string): Promise<void> {
    const dirInfo = await lstat(skillDir).catch(() => undefined);
    if (dirInfo?.isSymbolicLink() === true) throw new PowerError(409, POWER_TARGET_LINK);
    for (const file of files) {
      if (!inside(await realDeepest(dirname(file)), realKiro)) throw new PowerError(409, POWER_KIRO_OUTSIDE);
      const info = await lstat(file).catch(() => undefined);
      if (info?.isSymbolicLink() === true) throw new PowerError(409, POWER_TARGET_LINK);
      if (info !== undefined && !info.isFile()) throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
    }
  }

  /** Bytes of `settings/mcp.json`, or undefined when absent. Over the cap is a refusal. */
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

  /** The base folder (real) of the scope: the home, or the validated workspace. */
  private async resolveBase(app: ActiveApplication, scope: InstallScope, workspacePath: unknown): Promise<{ base: string; workspace?: string }> {
    if (scope === 'global') return { base: await realDeepest(this.home) };
    if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) throw new PowerError(400, POWER_FIELD_REQUIRED);
    const text = workspacePath.trim();
    const absolute = process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text) : isAbsolute(text);
    if (text.length > 1024 || text.includes('\0') || !absolute || !isAbsolute(text)) throw new PowerError(400, POWER_PATH_INVALID);
    let realWorkspace: string;
    try {
      realWorkspace = await realpath(text);
      if (!(await stat(realWorkspace)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new PowerError(400, POWER_PATH_NOT_FOLDER);
    }
    if (realWorkspace.split(/[\\/]/).includes('node_modules')) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    const forbidden = [await realDeepest(app.outDir)];
    if (this.deps.appData.dir !== undefined) forbidden.push(await realDeepest(this.deps.appData.dir));
    if (forbidden.some((f) => inside(realWorkspace, f))) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    return { base: realWorkspace, workspace: realWorkspace };
  }

  /** Validates the scope root and the files to write, and builds the bytes. Reads only. */
  private async plan(app: ActiveApplication, scope: InstallScope, workspacePath: unknown): Promise<Plan> {
    const { base, workspace } = await this.resolveBase(app, scope, workspacePath);
    const realKiro = await this.confineKiro(base, join(base, '.kiro'));
    const source = await this.readSource(app);
    const paths = targetPaths(scope, realKiro, source.slug);
    await this.checkTargets(realKiro, [paths.mcp, paths.backup, paths.skill], paths.skillDir);

    const existing = await this.readSettings(paths.mcp);
    const root = existing === undefined ? {} : this.parseSettings(existing);
    const { entry, missing } = await this.buildEntry(app, source);
    const merged = serialize(mergeServer(root, source.slug, entry));
    const servers = root.mcpServers;
    const skillExists = await exists(paths.skill);
    const existingSkill = skillExists ? await readCapped(paths.skill, SETTINGS_CAP) : undefined;
    const existingBackup = (await exists(paths.backup)) ? await readCapped(paths.backup, SETTINGS_CAP) : undefined;

    const newDirs: string[] = [];
    for (const dir of [paths.skillDir, dirname(paths.skillDir), dirname(paths.mcp), realKiro]) if (!(await exists(dir))) newDirs.push(dir);
    let otherScopeInstalled: InstallScope | undefined;
    try {
      const other: InstallScope = scope === 'global' ? 'project' : 'global';
      if ((await this.deps.records.list()).some((r) => r.slug === source.slug && r.scope === other)) otherScopeInstalled = other;
    } catch {
      otherScopeInstalled = undefined;
    }
    return {
      scope,
      slug: source.slug,
      ...(app.applicationKey === undefined ? {} : { applicationKey: app.applicationKey }),
      ...(workspace === undefined ? {} : { workspace }),
      kiroPath: join(base, '.kiro'),
      paths,
      ...(existing === undefined ? {} : { existing }),
      ...(existingBackup === undefined ? {} : { existingBackup }),
      ...(existingSkill === undefined ? {} : { existingSkill }),
      skillExists,
      newDirs,
      merged,
      skill: source.skill,
      configWrite: existing === undefined || !existing.equals(merged),
      skillWrite: existingSkill === undefined || !existingSkill.equals(source.skill),
      entry,
      replacesEntry: isPlainObject(servers) && has(servers, source.slug),
      missing,
      required: [...source.required],
      ...(otherScopeInstalled === undefined ? {} : { otherScopeInstalled }),
    };
  }

  /** Writes the plan in one transaction, then stores the record. Nothing is written when the bytes already match. */
  private async perform(plan: Plan, app: ActiveApplication): Promise<{ written: string[]; changed: boolean }> {
    const written = [plan.paths.mcp, plan.paths.skill];
    const changed = plan.configWrite || plan.skillWrite;
    if (changed) {
      const tx = beginTransaction(this.deps.fsOps);
      if (plan.configWrite && plan.existing !== undefined) tx.write(plan.paths.backup, plan.existing);
      if (plan.skillWrite) tx.write(plan.paths.skill, plan.skill);
      if (plan.configWrite) tx.write(plan.paths.mcp, plan.merged); // last
      try {
        await tx.commit();
      } catch {
        throw new PowerError(500, POWER_WRITE_FAILED);
      }
    }
    let prior: InstallRecord | undefined;
    try {
      prior = (await this.deps.records.list()).find((r) => r.slug === plan.slug && r.scope === plan.scope);
    } catch {
      prior = undefined;
    }
    if (changed || prior === undefined) {
      const backup = plan.configWrite ? plan.existing !== undefined : (prior?.backup ?? false);
      const record: InstallRecord = {
        slug: plan.slug,
        ...(app.applicationKey === undefined ? {} : { applicationKey: app.applicationKey }),
        scope: plan.scope,
        kiroPath: plan.kiroPath,
        written: backup ? [...written, plan.paths.backup] : written,
        skillDir: plan.paths.skillDir,
        configSha256: sha256(plan.configWrite ? plan.merged : (plan.existing as Buffer)),
        backup,
        installedAt: new Date(this.now()).toISOString(),
      };
      try {
        await this.deps.records.put(record);
      } catch {
        await this.undo(plan);
        throw new PowerError(500, POWER_WRITE_FAILED);
      }
    }
    return { written, changed };
  }

  /** Puts every file the install touched back to its previous bytes, or removes it. Best effort. */
  private async undo(plan: Plan): Promise<void> {
    const tx = beginTransaction(this.deps.fsOps);
    if (plan.configWrite) {
      if (plan.existing === undefined) tx.remove(plan.paths.mcp);
      else tx.write(plan.paths.mcp, plan.existing);
      if (plan.existingBackup === undefined) tx.remove(plan.paths.backup);
      else tx.write(plan.paths.backup, plan.existingBackup);
    }
    if (plan.skillWrite) {
      if (plan.existingSkill === undefined) tx.remove(plan.paths.skill);
      else tx.write(plan.paths.skill, plan.existingSkill);
    }
    await tx.commit().catch(() => undefined);
    // Folders the install created, deepest first; rmdir only removes empty ones
    for (const dir of plan.newDirs) await rmdir(dir).catch(() => undefined);
  }
}

export function createPowerInstaller(deps: PowerInstallerDeps): PowerInstaller {
  return new StudioPowerInstaller(deps);
}
