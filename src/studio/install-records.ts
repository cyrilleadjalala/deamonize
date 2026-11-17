/**
 * Install records: what an install wrote, so "Remove from Kiro" can undo it. File `kiro-installs.json` in the
 * App_Data_Dir, temp plus rename, mode 0600. Holds paths and a hash, never a secret value.
 * See design "8. Power installer" and "Data Models".
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppData, InstallScope } from './contracts.js';
import { writeFileAtomic } from './power-fs.js';

export interface InstallRecord {
  slug: string;
  applicationKey?: string;
  scope: InstallScope;
  kiroPath: string;
  written: string[];
  skillDir: string;
  configSha256: string;
  backup: boolean;
  installedAt: string;
}
export interface InstallRecords {
  /** `[]` when nothing was stored. Throws when the file exists but cannot be read or is invalid. */
  list(): Promise<InstallRecord[]>;
  /** Replaces the record with the same (slug, scope). Throws when the file cannot be written. */
  put(record: InstallRecord): Promise<void>;
  delete(slug: string, scope: InstallScope): Promise<void>;
}

export const INSTALLS_FILE = 'kiro-installs.json';
const MAX_BYTES = 1024 * 1024;

const isScope = (v: unknown): v is InstallScope => v === 'global' || v === 'project';
const isString = (v: unknown): v is string => typeof v === 'string';

function toRecord(value: unknown): InstallRecord {
  const r = value as Record<string, unknown> | null;
  if (
    typeof r !== 'object' || r === null || !isString(r.slug) || !isScope(r.scope) || !isString(r.kiroPath) ||
    !Array.isArray(r.written) || !r.written.every(isString) || !isString(r.skillDir) || !isString(r.configSha256) ||
    typeof r.backup !== 'boolean' || !isString(r.installedAt) || (r.applicationKey !== undefined && !isString(r.applicationKey))
  ) {
    throw new Error('install records file is invalid');
  }
  return {
    slug: r.slug,
    ...(r.applicationKey !== undefined ? { applicationKey: r.applicationKey } : {}),
    scope: r.scope,
    kiroPath: r.kiroPath,
    written: [...r.written],
    skillDir: r.skillDir,
    configSha256: r.configSha256,
    backup: r.backup,
    installedAt: r.installedAt,
  };
}

export function createInstallRecords(deps: { appData: AppData }): InstallRecords {
  let chain: Promise<unknown> = Promise.resolve();
  /** Serializes read-modify-write cycles. */
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const run = chain.then(body, body);
    chain = run.catch(() => undefined);
    return run;
  };

  async function readAll(dir: string): Promise<InstallRecord[]> {
    const file = join(dir, INSTALLS_FILE);
    let text: string;
    try {
      if ((await stat(file)).size > MAX_BYTES) throw new Error('install records file is too large');
      text = await readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(text) as { v?: unknown; installs?: unknown };
    if (typeof parsed !== 'object' || parsed === null || parsed.v !== 1 || !Array.isArray(parsed.installs)) {
      throw new Error('install records file is invalid');
    }
    return parsed.installs.map(toRecord);
  }

  async function writeAll(dir: string, records: InstallRecord[]): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ v: 1, installs: records }, null, 2) + '\n', 'utf-8');
    await writeFileAtomic(join(dir, INSTALLS_FILE), bytes, 0o600);
  }

  async function writableDir(): Promise<string> {
    const check = await deps.appData.ensure();
    if (!check.ok) throw new Error('app data folder is not usable');
    return check.dir;
  }

  return {
    async list() {
      const check = await deps.appData.check();
      if (!check.ok) return [];
      return exclusive(() => readAll(check.dir));
    },
    put(record) {
      return exclusive(async () => {
        const dir = await writableDir();
        const kept = (await readAll(dir)).filter((r) => !(r.slug === record.slug && r.scope === record.scope));
        await writeAll(dir, [...kept, toRecord(record)]);
      });
    },
    delete(slug, scope) {
      return exclusive(async () => {
        const dir = await writableDir();
        const all = await readAll(dir);
        const kept = all.filter((r) => !(r.slug === slug && r.scope === scope));
        if (kept.length !== all.length) await writeAll(dir, kept);
      });
    },
  };
}
