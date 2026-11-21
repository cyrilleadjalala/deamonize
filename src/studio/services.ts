/**
 * Builds the services of one Studio. Owned by the foundation group: the other groups fill their own modules
 * (the `create*` factories) and never edit this file.
 */
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEnvSecretValues, makeScrubber } from './redact.js';
import { createAppData, unavailableAppData } from './app-data.js';
import { createCompileRunner } from './compile-runner.js';
import type { WorkflowSet } from '../types.js';
import { createApplicationLocator } from './active-app.js';
import { createAppNames } from './app-names.js';
import { createAutoAddStore } from './auto-add-store.js';
import type { StudioServices } from './contracts.js';
import { createInstallRecords } from './install-records.js';
import {
  InertActivityService,
  InertApplicationLocator,
  InertApprovalsService,
  InertBrowserCheck,
  InertCompileRunner,
  InertDaemonizePower,
  InertPowerInstaller,
  InertRecordingManager,
  InertSecretVault,
  InertSessionStore,
} from './inert-services.js';
import { createActivityService } from './activity-service.js';
import { createApprovalsService } from './approvals-service.js';
import { createBrowserCheck } from './browser-check.js';
import { createDaemonizePower } from './daemonize-power.js';
import { toolRiskOf } from './model.js';
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
  /** Test seam: the home folder of the Power_Installer (default the account's home). */
  home?: string;
  /** Reads the Workflow_File only (no output folder refresh); used by the ApplicationLocator. */
  loadSet: () => Promise<{ set: WorkflowSet | undefined }>;
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
        target: () => locator.prepareCompile(),
        playground: info.playground,
        scrub,
        paths: [info.cwd, homedir(), tmpdir(), ...(appData.dir === undefined ? [] : [appData.dir])],
      }));
  const home = info.home ?? homedir();
  const locator = overrides?.locator ?? (info.sample ? new InertApplicationLocator(info.outDir) : createApplicationLocator({ baseOutDir: info.outDir, apps: createAppNames({ appData }), loadSet: info.loadSet }));
  /** Compiled name and risk of each tool, for "Ask before changes" (the one risk function is `toolRiskOf`). Never throws. */
  const toolRisks = async (): Promise<Array<{ toolName: string; risk: 'read' | 'write' | 'delete' }>> => {
    try {
      const { set } = await info.loadSet();
      if (set === undefined) return [];
      const current = await locator.current();
      const nameMap = JSON.parse(await readFile(join(current.outDir, 'name-map.json'), 'utf-8')) as Record<string, unknown>;
      return set.workflows.flatMap((workflow) => {
        const toolName = nameMap[workflow.id];
        return typeof toolName === 'string' ? [{ toolName, risk: toolRiskOf(workflow) }] : [];
      });
    } catch {
      return [];
    }
  };
  // Group G-S adds `toolRisks` to PowerInstallerDeps; passing it through a spread keeps this file stable for them
  const approvalDeps = { toolRisks };
  const power =
    overrides?.power ??
    (info.sample
      ? new InertPowerInstaller(info.outDir, info.cwd, home)
      : createPowerInstaller({
        cwd: info.cwd,
        appData,
        home,
        locate: () => locator.current(),
        vault,
        records: createInstallRecords({ appData }),
        autoAdd: createAutoAddStore({ appData }),
        ...approvalDeps,
      }));
  const recording =
    overrides?.recording ?? (info.sample ? new InertRecordingManager() : createRecordingManager({ workflowFile: info.workflowFile, workspacePath: info.cwd, sessions, compiler, scrub, power }));
  const approvals = overrides?.approvals ?? (info.sample ? new InertApprovalsService(true) : createApprovalsService({ appData }));
  const activity = overrides?.activity ?? (info.sample ? new InertActivityService(true) : createActivityService({ appData }));
  const browser = overrides?.browser ?? (info.sample ? new InertBrowserCheck() : createBrowserCheck({ env: info.env }));
  const daemonizePower =
    overrides?.daemonizePower ?? (info.sample ? new InertDaemonizePower() : createDaemonizePower({ cwd: info.cwd, home, appData, env: info.env }));
  return { appData, vault, sessions, recording, compiler, power, locator, approvals, activity, browser, daemonizePower };
}