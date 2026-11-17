/** Group G4 owns this file. Stub: an installer that is never available. */
import type { AppData, PowerInstaller } from './contracts.js';
import { InertPowerInstaller } from './inert-services.js';

export interface PowerInstallerDeps {
  /** Absolute paths. */
  outDir: string;
  /** The folder the Studio runs in: the default Target_Workspace. */
  cwd: string;
  appData: AppData;
}

export class NullPowerInstaller extends InertPowerInstaller { }

export function createPowerInstaller(deps: PowerInstallerDeps): PowerInstaller {
  return new NullPowerInstaller(deps.outDir, deps.cwd);
}