/**
 * Inert implementations of every service contract. They touch no file and start no process.
 * Used in sample mode, and as the starting stubs that the owning groups replace.
 * Owned by the foundation group.
 */
import { cwd } from 'node:process';
import {
  PowerError,
  SessionSaveError,
  VaultUnavailableError,
  type CompileOutcome,
  type CompileRunner,
  type CompileStatus,
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
  tryStart(): boolean {
    return false;
  }
  async runExclusive(): Promise<CompileOutcome> {
    return { ok: false, message: 'Compiling is not available.', outputMayBeIncomplete: false };
  }
  async close(): Promise<void> {
    // Nothing runs
  }
}

export class InertPowerInstaller implements PowerInstaller {
  constructor(private readonly outputPath: string = '', private readonly workspace: string = cwd()) { }
  async info(): Promise<{ available: boolean; defaultWorkspace: string; outputPath: string }> {
    return { available: false, defaultWorkspace: this.workspace, outputPath: this.outputPath };
  }
  async preview(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async install(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
  async snippet(): Promise<never> {
    throw new PowerError(409, 'Connecting to Kiro is not available.');
  }
}
