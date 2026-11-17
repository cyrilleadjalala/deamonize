/**
 * Group G4: connects the compiled tool to a Kiro workspace. Two steps (preview, then install), bound by a
 * confirmation id and the exact `.kiro` path shown to the user. It writes only inside `<workspace>/.kiro`:
 * `settings/mcp.json` (merged) and `skills/<name>/SKILL.md`. Entries are rebuilt with placeholders only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PowerError, type AppData, type PowerFilePlan, type PowerInstaller, type PowerPreview } from './contracts.js';
import { buildServerEntry, buildSnippetText, secretPlaceholders, type ServerEntry } from './mcp-snippet.js';
import {
  POWER_CONFIRM_INVALID,
  POWER_FIELD_REQUIRED,
  POWER_KIRO_OUTSIDE,
  POWER_NOT_COMPILED,
  POWER_PATH_INVALID,
  POWER_PATH_NOT_ALLOWED,
  POWER_PATH_NOT_FOLDER,
  POWER_SETTINGS_UNREADABLE,
  POWER_TARGET_LINK,
  POWER_WRITE_FAILED,
} from './messages/compile.js';

export interface PowerInstallerDeps {
  /** Absolute paths. */
  outDir: string;
  /** The folder the Studio runs in: the default Target_Workspace. */
  cwd: string;
  appData: AppData;
  /** Test seam. */
  now?: () => number;
}

const SOURCE_CAP = 1024 * 1024;
const SETTINGS_CAP = 2 * 1024 * 1024;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const CONFIRM_MAX = 8;
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface Source {
  serverName: string;
  entry: ServerEntry;
  skill: Buffer;
}
interface Plan {
  realWorkspace: string;
  kiroPath: string;
  realKiro: string;
  mcpPath: string;
  skillPath: string;
  settings: { exists: boolean; root: Record<string, unknown> };
  skillExists: boolean;
  source: Source;
}
interface Confirmation {
  id: string;
  workspace: string;
  kiroPath: string;
  expires: number;
}

const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (foldCase ? p.toLowerCase() : p);

/** `a` equals `b` or lies inside it. */
function inside(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `realpath` of the deepest existing ancestor, followed by the missing tail. */
async function realDeepest(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (; ;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export class StudioPowerInstaller implements PowerInstaller {
  private confirmations: Confirmation[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: PowerInstallerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async info(): Promise<{ available: boolean; defaultWorkspace: string; outputPath: string; serverName?: string }> {
    const source = await this.readSource().catch(() => undefined);
    return {
      available: source !== undefined,
      defaultWorkspace: this.deps.cwd,
      outputPath: this.deps.outDir,
      ...(source === undefined ? {} : { serverName: source.serverName }),
    };
  }

  async snippet(): Promise<string> {
    const source = await this.readSource();
    return buildSnippetText(source.serverName, source.entry);
  }

  async preview(workspacePath: unknown): Promise<PowerPreview> {
    const plan = await this.plan(workspacePath);
    const id = randomUUID();
    this.remember({ id, workspace: plan.realWorkspace, kiroPath: plan.kiroPath, expires: this.now() + CONFIRM_TTL_MS });
    const files: PowerFilePlan[] = [
      { path: 'settings/mcp.json', outcome: plan.settings.exists ? 'merge' : 'create' },
      { path: `skills/${plan.source.serverName}/SKILL.md`, outcome: plan.skillExists ? 'replace' : 'create' },
    ];
    const servers = plan.settings.root.mcpServers;
    return {
      confirmationId: id,
      kiroPath: plan.kiroPath,
      files,
      replacesEntry: isPlainObject(servers) && has(servers, plan.source.serverName),
      serverName: plan.source.serverName,
      placeholders: secretPlaceholders(plan.source.entry),
    };
  }

  async install(request: { confirmationId: unknown; kiroPath: unknown }): Promise<{ written: string[]; placeholders: string[] }> {
    const { confirmationId, kiroPath } = request;
    if (typeof confirmationId !== 'string' || typeof kiroPath !== 'string') throw new PowerError(400, POWER_CONFIRM_INVALID);
    this.prune();
    const index = this.confirmations.findIndex((c) => c.id === confirmationId);
    const stored = index < 0 ? undefined : this.confirmations[index];
    if (stored === undefined || stored.kiroPath !== kiroPath) throw new PowerError(400, POWER_CONFIRM_INVALID);
    this.confirmations.splice(index, 1); // single use
    const plan = await this.plan(stored.workspace);
    if (plan.kiroPath !== stored.kiroPath) throw new PowerError(400, POWER_CONFIRM_INVALID);

    // Build everything first: nothing is written when a buffer cannot be made
    const name = plan.source.serverName;
    const root = plan.settings.root;
    const servers: Record<string, unknown> = isPlainObject(root.mcpServers) ? root.mcpServers : {};
    servers[name] = plan.source.entry;
    const merged: Record<string, unknown> = { ...root, mcpServers: servers };
    const mcpBuffer = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    const oldSkill = plan.skillExists ? await readCapped(plan.skillPath, SETTINGS_CAP) : undefined;

    const suffix = randomBytes(6).toString('hex');
    const mcpTmp = `${plan.mcpPath}.tmp-${suffix}`;
    const skillTmp = `${plan.skillPath}.tmp-${suffix}`;
    const cleanup = async (): Promise<void> => {
      await unlink(mcpTmp).catch(() => undefined);
      await unlink(skillTmp).catch(() => undefined);
    };
    let skillRenamed = false;
    try {
      await mkdir(dirname(plan.mcpPath), { recursive: true });
      await mkdir(dirname(plan.skillPath), { recursive: true });
      // The folders now exist: they must still lie inside the real .kiro
      for (const file of [plan.mcpPath, plan.skillPath]) {
        if (!inside(await realDeepest(dirname(file)), plan.realKiro)) throw new PowerError(400, POWER_KIRO_OUTSIDE);
      }
      await writeFile(mcpTmp, mcpBuffer, { flag: 'wx', mode: 0o644 });
      await writeFile(skillTmp, plan.source.skill, { flag: 'wx', mode: 0o644 });
      await rename(skillTmp, plan.skillPath);
      skillRenamed = true;
      await rename(mcpTmp, plan.mcpPath);
    } catch (error) {
      await cleanup();
      if (skillRenamed) {
        if (oldSkill !== undefined) await writeFile(plan.skillPath, oldSkill).catch(() => undefined);
        else await unlink(plan.skillPath).catch(() => undefined);
      }
      if (error instanceof PowerError) throw error;
      throw new PowerError(500, POWER_WRITE_FAILED);
    }
    return { written: ['settings/mcp.json', `skills/${name}/SKILL.md`], placeholders: secretPlaceholders(plan.source.entry) };
  }

  // ---- internals -----------------------------------------------------------

  private prune(): void {
    const now = this.now();
    this.confirmations = this.confirmations.filter((c) => c.expires > now);
  }

  private remember(entry: Confirmation): void {
    this.prune();
    this.confirmations = this.confirmations.filter((c) => norm(c.workspace) !== norm(entry.workspace));
    this.confirmations.push(entry);
    while (this.confirmations.length > CONFIRM_MAX) this.confirmations.shift();
  }

  /** The compiled `mcp.json` and skill, rebuilt into a placeholder-only entry. */
  private async readSource(): Promise<Source> {
    const notCompiled = new PowerError(409, POWER_NOT_COMPILED);
    const outDir = this.deps.outDir;
    const serverJs = join(outDir, 'mcp-server.js');
    const serverInfo = await stat(serverJs).catch(() => undefined);
    if (serverInfo === undefined || !serverInfo.isFile()) throw notCompiled;
    const raw = await readCapped(join(outDir, 'mcp.json'), SOURCE_CAP);
    if (raw === undefined) throw notCompiled;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      throw notCompiled;
    }
    const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined;
    if (!isPlainObject(servers)) throw notCompiled;
    const serverName = Object.keys(servers)[0];
    if (serverName === undefined || !SERVER_NAME.test(serverName)) throw notCompiled;
    const skill = await readCapped(join(outDir, 'skills', serverName, 'SKILL.md'), SOURCE_CAP);
    if (skill === undefined) throw notCompiled;
    return { serverName, entry: buildServerEntry(servers[serverName], resolve(serverJs)), skill };
  }

  /** Validates the workspace and the files to write. Reads only. */
  private async plan(workspacePath: unknown): Promise<Plan> {
    // 1. shape
    if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) throw new PowerError(400, POWER_FIELD_REQUIRED);
    const text = workspacePath.trim();
    const absolute =
      process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text) : isAbsolute(text);
    if (text.length > 1024 || text.includes('\0') || !absolute || !isAbsolute(text)) throw new PowerError(400, POWER_PATH_INVALID);
    // 2. a real folder
    let realWorkspace: string;
    try {
      realWorkspace = await realpath(text);
      if (!(await stat(realWorkspace)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new PowerError(400, POWER_PATH_NOT_FOLDER);
    }
    // 3. not a place the Studio owns
    if (realWorkspace.split(/[\\/]/).includes('node_modules')) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    const forbidden = [await realDeepest(this.deps.outDir)];
    if (this.deps.appData.dir !== undefined) forbidden.push(await realDeepest(this.deps.appData.dir));
    if (forbidden.some((f) => inside(realWorkspace, f))) throw new PowerError(400, POWER_PATH_NOT_ALLOWED);
    // 4. the .kiro folder and every target stay inside it
    const kiroLink = join(realWorkspace, '.kiro');
    let realKiro = kiroLink;
    if (await exists(kiroLink)) {
      let kiroReal: string;
      try {
        kiroReal = await realpath(kiroLink);
        if (!(await stat(kiroReal)).isDirectory()) throw new Error('not a folder');
      } catch {
        throw new PowerError(400, POWER_KIRO_OUTSIDE);
      }
      if (!inside(kiroReal, realWorkspace)) throw new PowerError(400, POWER_KIRO_OUTSIDE);
      realKiro = kiroReal;
    }
    const source = await this.readSource();
    const mcpPath = join(realKiro, 'settings', 'mcp.json');
    const skillPath = join(realKiro, 'skills', source.serverName, 'SKILL.md');
    for (const file of [mcpPath, skillPath]) {
      if (!inside(await realDeepest(dirname(file)), realKiro)) throw new PowerError(400, POWER_KIRO_OUTSIDE);
      const info = await lstat(file).catch(() => undefined);
      if (info?.isSymbolicLink() === true) throw new PowerError(400, POWER_TARGET_LINK);
      if (info !== undefined && !info.isFile()) throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
    }
    // 5. an existing settings file must be usable
    let settings: Plan['settings'] = { exists: false, root: {} };
    if (await exists(mcpPath)) {
      const bytes = await readCapped(mcpPath, SETTINGS_CAP);
      let root: unknown;
      try {
        root = bytes === undefined ? undefined : JSON.parse(bytes.toString('utf-8'));
      } catch {
        root = undefined;
      }
      if (!isPlainObject(root) || (has(root, 'mcpServers') && !isPlainObject(root.mcpServers))) {
        throw new PowerError(409, POWER_SETTINGS_UNREADABLE);
      }
      settings = { exists: true, root };
    }
    const skillExists = await exists(skillPath);
    const kiroPath = join(realWorkspace, '.kiro');
    if (relative(realWorkspace, kiroPath) !== '.kiro') throw new PowerError(400, POWER_PATH_INVALID);
    return { realWorkspace, kiroPath, realKiro, mcpPath, skillPath, settings, skillExists, source };
  }
}

/** Kept for callers that use the earlier stub name. */
export class NullPowerInstaller extends StudioPowerInstaller { }

export function createPowerInstaller(deps: PowerInstallerDeps): PowerInstaller {
  return new StudioPowerInstaller(deps);
}
