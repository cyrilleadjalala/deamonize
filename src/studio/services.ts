/**
 * Builds the services of one Studio. Owned by the foundation group: the other groups fill their own modules
 * (the `create*` factories) and never edit this file.
 */
import { homedir, tmpdir } from 'node:os';
import { collectEnvSecretValues, makeScrubber } from './redact.js';
import { createAppData, unavailableAppData } from './app-data.js';
import { createCompileRunner } from './compile-runner.js';
import type { StudioServices } from './contracts.js';
import { InertCompileRunner, InertPowerInstaller, InertRecordingManager, InertSecretVault, InertSessionStore } from './inert-services.js';
import type { PlaygroundSession } from './playground.js';
import { createPowerInstaller } from './power-installer.js';
import { createRecordingManager } from './recording-manager.js';
import { createSecretVault } from './secret-vault.js';
import { createSessionStore } from './session-store.js';

export interface ServiceInfo {
  /** Absolute paths. */
  workflowFile: string;
  outDir: string;
  cwd: string;
  sample: boolean;
  env: Record<string, string | undefined>;
  /** The playground is created after the services: read it lazily. */
  playground: () => PlaygroundSession | undefined;
  /** Secret values found by the last load (a storage state). */
  loadedSecretValues: () => readonly string[];
}

/** Real services, or inert ones in sample mode, with `overrides` (test seam) applied on top. */
export function createServices(overrides: Partial<StudioServices> | undefined, info: ServiceInfo): StudioServices {
  const appData = overrides?.appData ?? (info.sample ? unavailableAppData : createAppData({ cwd: info.cwd, outDir: info.outDir, env: info.env }));
  const vault = overrides?.vault ?? (info.sample ? new InertSecretVault() : createSecretVault({ appData, env: info.env }));
  const sessions = overrides?.sessions ?? (info.sample ? new InertSessionStore() : createSessionStore({ appData }));
  const scrub = (text: string): string =>
    makeScrubber([...collectEnvSecretValues(info.env), ...info.loadedSecretValues(), ...vault.values(), ...sessions.knownValues()])(text);
  const compiler =
    overrides?.compiler ??
    (info.sample
      ? new InertCompileRunner()
      : createCompileRunner({
        workflowFile: info.workflowFile,
        outDir: info.outDir,
        playground: info.playground,
        scrub,
        paths: [info.cwd, homedir(), tmpdir(), ...(appData.dir === undefined ? [] : [appData.dir])],
      }));
  const recording =
    overrides?.recording ?? (info.sample ? new InertRecordingManager() : createRecordingManager({ workflowFile: info.workflowFile, sessions, compiler, scrub }));
  const power = overrides?.power ?? (info.sample ? new InertPowerInstaller(info.outDir, info.cwd) : createPowerInstaller({ outDir: info.outDir, cwd: info.cwd, appData }));
  return { appData, vault, sessions, recording, compiler, power };
}
