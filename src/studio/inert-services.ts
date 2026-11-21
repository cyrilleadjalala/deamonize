/**
 * Inert implementations of every service contract. They touch no file and start no process.
 * Used in sample mode, and as the starting stubs that the owning groups replace.
 * Owned by the foundation group.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { AuditEntry } from '../replay/runtime/audit-log.js';
import { sampleApprovals, sampleAuditEntries } from './sample-activity.js';
import {
  PowerError,
  SessionSaveError,
  VaultUnavailableError,
  type ActiveApplication,
  type ActivityQuery,
  type ActivityService,
  type ApplicationLocator,
  type ApprovalsService,
  type ApprovalView,
  type BrowserCheck,
  type DaemonizePowerInstaller,
  type DaemonizePowerParts,
  type DecideOutcome,
  type InstallScope,
  type AutoAddOutcome,
  type AutoAddState,
  type CompileOptionsInput,
  type CompileOutcome,
  type CompileRunner,
  type CompileStatus,
  type PowerInfo,
  type PowerInstaller,
  type RecordingManager,
  type RecordingStatus,
  type SecretVault,
  type SessionStore,
  type StartOutcome,
  type StopOutcome,
} from './contracts.js';
import { applicationKey } from './validate-action.js';

export class InertSecretVault implements SecretVault {
  async names(): Promise<ReadonlySet<string>> {
    return new Set();
  }
  values(): readonly string[] {
    return [];
  }
  async set(): Promise<void> {
    throw new VaultUnavailableError('The secret vault is not available.');
  }
  async remove(): Promise<boolean> {
    throw new VaultUnavailableError('The secret vault is not available.');
  }
  async has(): Promise<boolean> {
    return false;
  }
  async snapshot(): Promise<Record<string, string>> {
    return {};
  }
  async setFor(): Promise<void> {
    throw new VaultUnavailableError('The secret vault is not available.');
  }
  async removeFor(): Promise<boolean> {
    throw new VaultUnavailableError('The secret vault is not available.');
  }
  async namesFor(): Promise<ReadonlySet<string>> {
    return new Set();
  }
  async snapshotFor(): Promise<Record<string, string>> {
    return {};
  }
}

export class InertSessionStore implements SessionStore {
  keyFor(url: string): string | undefined {
    return applicationKey(url);
  }
  async available(): Promise<boolean> {
    return false;
  }
  async pathFor(): Promise<string | undefined> {
    return undefined;
  }
  async save(): Promise<void> {
    throw new SessionSaveError('Saved sessions are not available.');
  }
  async forget(): Promise<void> {
    // Nothing is stored
  }
  knownValues(): readonly string[] {
    return [];
  }
  async refresh(): Promise<void> {
    // Nothing to read
  }
  async problem(): Promise<string | undefined> {
    return undefined;
  }
}

export class InertRecordingManager implements RecordingManager {
  start(): StartOutcome {
    return { status: 409, message: 'Recording is not available.' };
  }
  stop(): StopOutcome {
    return { status: 409, message: 'There is no recording to stop.' };
  }
  status(): RecordingStatus {
    return { state: 'idle', steps: 0, labels: [] };
  }
  isActive(): boolean {
    return false;
  }
  async close(): Promise<void> {
    // Nothing runs
  }
}

export class InertCompileRunner implements CompileRunner {
  status(): CompileStatus {
    return { state: 'idle', phase: null };
  }
  tryStart(_options?: CompileOptionsInput): boolean {
    return false;
  }
  options(): CompileOptionsInput {
    return { http: 'off', healSupport: false };
  }
  async runExclusive(): Promise<CompileOutcome> {
    return { ok: false, message: 'Compiling is not available.', outputMayBeIncomplete: false };
  }
  async close(): Promise<void> {
    // Nothing runs
  }
}

export class InertPowerInstaller implements PowerInstaller {
  constructor(
    private readonly outputPath: string = '',
    private readonly workspace: string = cwd(),
    private readonly home: string = homedir()
  ) { }
  async info(): Promise<PowerInfo> {
    return { available: false, defaultWorkspace: this.workspace, outputPath: this.outputPath, kiroHome: join(this.home, '.kiro'), kiroHomeExists: false, installs: [] };
  }
  async preview(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async install(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async remove(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async snippet(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async getAutoAdd(): Promise<AutoAddState> {
    return { enabled: false, writable: false };
  }
  async disableAutoAdd(): Promise<AutoAddState> {
    return { enabled: false, writable: false };
  }
  async runAutoAdd(): Promise<AutoAddOutcome> {
    return { status: 'disabled' };
  }
}

/** Sample mode: the fictitious pending question of `sample-activity.ts`; a decision is never written. */
export class InertApprovalsService implements ApprovalsService {
  constructor(private readonly sample: boolean = false) { }
  async start(): Promise<void> {
    // No heartbeat: nobody listens
  }
  async list(): Promise<ApprovalView[]> {
    return this.sample ? sampleApprovals() : [];
  }
  async decide(): Promise<DecideOutcome> {
    return { ok: false, reason: 'ended' };
  }
  async close(): Promise<void> {
    // Nothing runs
  }
}

/** Sample mode: the fictitious entries of `sample-activity.ts`, filtered like the real service. */
export class InertActivityService implements ActivityService {
  constructor(private readonly sample: boolean = false) { }
  async list(query: ActivityQuery): Promise<{ entries: AuditEntry[]; tools: string[]; total: number }> {
    const all = this.sample ? sampleAuditEntries() : [];
    const tools = [...new Set(all.map((e) => e.tool))].sort();
    const matching = all.filter((e) => (query.tool === undefined || e.tool === query.tool) && (query.decision === undefined || e.decision === query.decision));
    return { entries: matching.slice(0, query.limit), tools, total: matching.length };
  }
}

export class InertBrowserCheck implements BrowserCheck {
  async check(): Promise<{ available: boolean }> {
    return { available: false };
  }
}

export class InertDaemonizePower implements DaemonizePowerInstaller {
  async info(): Promise<{ installs: Array<{ scope: InstallScope; parts: DaemonizePowerParts }>; agentPresent: { project: boolean; global: boolean } }> {
    return { installs: [], agentPresent: { project: false, global: false } };
  }
  async preview(): Promise<never> {
    throw new PowerError(409, 'Adding the Daemonize assistant to Kiro is not available.');
  }
  async install(): Promise<never> {
    throw new PowerError(409, 'Adding the Daemonize assistant to Kiro is not available.');
  }
  async remove(): Promise<never> {
    throw new PowerError(409, 'Adding the Daemonize assistant to Kiro is not available.');
  }
}

/** Always the base folder: the active application never changes. */
export class InertApplicationLocator implements ApplicationLocator {
  constructor(private readonly outDir: string = '') { }
  private base(): ActiveApplication {
    return { slug: 'application', outDir: this.outDir, legacy: true };
  }
  async current(): Promise<ActiveApplication> {
    return this.base();
  }
  async prepareCompile(): Promise<ActiveApplication> {
    return this.base();
  }
}