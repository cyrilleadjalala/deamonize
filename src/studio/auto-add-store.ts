/**
 * Remembered consent for "add to Kiro automatically". File `kiro-auto-add.json` in the App_Data_Dir, temp plus
 * rename, mode 0600. Deleting the file turns the option off. A failure to read or write is thrown so the caller
 * keeps the option off. See design "8. Power installer" and "Data Models".
 */
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppData, InstallScope } from './contracts.js';
import { writeFileAtomic } from './power-fs.js';

export interface AutoAddSetting {
  enabled: true;
  scope: InstallScope;
  workspacePath?: string;
}
export interface AutoAddStore {
  /** `undefined` when no consent is stored. Throws when the file exists but cannot be read or is invalid. */
  read(): Promise<AutoAddSetting | undefined>;
  write(setting: AutoAddSetting): Promise<void>;
  clear(): Promise<void>;
}

export const AUTO_ADD_FILE = 'kiro-auto-add.json';
const MAX_BYTES = 64 * 1024;

export function createAutoAddStore(deps: { appData: AppData }): AutoAddStore {
  return {
    async read() {
      const check = await deps.appData.check();
      if (!check.ok) return undefined; // nothing can be stored without a usable folder
      const file = join(check.dir, AUTO_ADD_FILE);
      let text: string;
      try {
        if ((await stat(file)).size > MAX_BYTES) throw new Error('auto-add file is too large');
        text = await readFile(file, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      const v = JSON.parse(text) as Record<string, unknown> | null;
      if (
        typeof v !== 'object' || v === null || v.v !== 1 || v.enabled !== true ||
        (v.scope !== 'global' && v.scope !== 'project') ||
        (v.workspacePath !== undefined && typeof v.workspacePath !== 'string')
      ) {
        throw new Error('auto-add file is invalid');
      }
      return {
        enabled: true,
        scope: v.scope,
        ...(v.scope === 'project' && typeof v.workspacePath === 'string' ? { workspacePath: v.workspacePath } : {}),
      };
    },
    async write(setting) {
      const check = await deps.appData.ensure();
      if (!check.ok) throw new Error('app data folder is not usable');
      const body: Record<string, unknown> = { v: 1, enabled: true, scope: setting.scope };
      if (setting.scope === 'project' && setting.workspacePath !== undefined) body.workspacePath = setting.workspacePath;
      await writeFileAtomic(join(check.dir, AUTO_ADD_FILE), Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf-8'), 0o600);
    },
    async clear() {
      const check = await deps.appData.check();
      if (!check.ok) return;
      await rm(join(check.dir, AUTO_ADD_FILE), { force: true });
    },
  };
}
