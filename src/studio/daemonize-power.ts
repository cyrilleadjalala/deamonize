/**
 * The installer of the Daemonize Power (the Studio_MCP entry, the agent and the skill), over the transaction of `power-fs.ts`.
 * G0 stub (inert); group G-P replaces the body and keeps the signature.
 */
import type { AppData, DaemonizePowerInstaller } from './contracts.js';
import { InertDaemonizePower } from './inert-services.js';

export interface DaemonizePowerDeps {
  /** The workspace folder of the Studio. */
  cwd: string;
  /** The home folder of the account (or the test seam of the Studio). */
  home: string;
  appData: AppData;
  env: Record<string, string | undefined>;
}

export function createDaemonizePower(_deps: DaemonizePowerDeps): DaemonizePowerInstaller {
  return new InertDaemonizePower();
}
