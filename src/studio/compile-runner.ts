/** Group G4: runs one compile at a time for the Studio and reports its progress. */
import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compile as realCompile, type CompilePhase } from '../cli/commands/compile.js';
import type { CompileOptionsInput, CompileOutcome, CompilePhaseView, CompileRunner, CompileStatus } from './contracts.js';
import { AppNamesError } from './app-names.js';
import {
  APP_NAME_NOT_SAVED,
  COMPILE_FAILED_INCOMPLETE,
  COMPILE_FAILED_UNCHANGED,
  COMPILE_INSTALL_STOPPED,
  COMPILE_INSTALL_TIMEOUT,
} from './messages/compile.js';
import type { PlaygroundSession } from './playground.js';

type CompileFn = typeof realCompile;

export interface CompileRunnerDeps {
  /** Absolute paths. */
  workflowFile: string;
  /** Where to write: creates the Name_Map entry first and answers the per-application folder. Throws AppNamesError. */
  target: () => Promise<{ outDir: string; slug: string }>;
  /** The playground is created after the services: read it lazily. */
  playground: () => PlaygroundSession | undefined;
  /** Removes known secret values and paths from a text. */
  scrub: (text: string) => string;
  /** Folders to replace with <folder> in messages (cwd, home, temp, App_Data_Dir ...). */
  paths: string[];
  /** Test seams. */
  compile?: CompileFn;
  installTimeoutMs?: number;
  installer?: (dir: string) => Promise<void>;
}

const MAX_MESSAGE = 300;

/** Raised by the quiet installer when it passes its time limit. */
export class InstallTimeout extends Error { }
/** Raised by the quiet installer when the Studio closes during an install. */
export class InstallStopped extends Error { }

/** Kills a process and its children. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // The process is already gone
  }
}

/**
 * Replaces the known folders with <folder>, any other absolute path with <path>, and clips the text.
 * Longest folders go first so a nested folder is not split.
 */
export function scrubMessage(text: string, paths: readonly string[]): string {
  let out = text;
  const folders = paths.filter((p) => p.length > 1).sort((a, b) => b.length - a.length);
  for (const folder of folders) {
    const forms = new Set([folder, folder.replace(/\\/g, '/'), folder.replace(/\//g, '\\')]);
    for (const form of forms) out = out.split(form).join('<folder>');
    // Match ignoring case on Windows drive paths
    if (/^[A-Za-z]:/.test(folder)) {
      const escaped = folder.replace(/[.*+?^${}()|[\]\\/]/g, (c) => (c === '\\' || c === '/' ? '[\\\\/]' : `\\${c}`));
      out = out.replace(new RegExp(escaped, 'gi'), '<folder>');
    }
  }
  out = out.replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>');
  out = out.replace(/\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*/g, '<path>');
  out = out.replace(/(^|[\s("'=])\/(?:[^\s/"'<>|]+\/)+[^\s/"'<>|]*/g, (_m, lead: string) => `${lead}<path>`);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}\u2026` : out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class StudioCompileRunner implements CompileRunner {
  private current: CompileStatus = { state: 'idle', phase: null };
  private running: Promise<CompileOutcome> | undefined;
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  private readonly compileFn: CompileFn;
  private readonly timeoutMs: number;

  constructor(private readonly deps: CompileRunnerDeps) {
    this.compileFn = deps.compile ?? realCompile;
    this.timeoutMs = deps.installTimeoutMs ?? 600_000;
  }

  status(): CompileStatus {
    return { ...this.current };
  }

  /** In memory only: replaced when a compile with options starts, used by every later compile without options. */
  private stored: CompileOptionsInput = { http: 'off', healSupport: false };
  tryStart(options?: CompileOptionsInput): boolean {
    if (this.running !== undefined) return false;
    if (options !== undefined) this.stored = { http: options.http, healSupport: options.healSupport };
    this.start();
    return true;
  }
  options(): CompileOptionsInput {
    return { ...this.stored };
  }

  async runExclusive(): Promise<CompileOutcome> {
    while (this.running !== undefined) await this.running.catch(() => undefined);
    return this.start();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.children) killTree(child.pid);
  }

  /** Sync: marks the run as started before any await, so a second caller is refused. */
  private start(): Promise<CompileOutcome> {
    this.current = { state: 'running', phase: 'generating' };
    const run = this.run().finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private setPhase(phase: CompilePhaseView): void {
    if (this.current.state === 'running') this.current = { state: 'running', phase };
  }

  private async run(): Promise<CompileOutcome> {
    let wrote = false;
    let outDir = '';
    try {
      const target = await this.deps.target();
      outDir = target.outDir;
      const hasModules = await isDirectory(join(outDir, 'node_modules'));
      // powerName is read by the compiler (CompileOptions.powerName); the options are typed loosely until the CLI command forwards it
      const options = {
        powerName: target.slug,
        http: this.stored.http,
        healSupport: this.stored.healSupport,
        ...(hasModules ? {} : { install: true }),
        installer: this.deps.installer ?? ((dir) => this.quietInstaller(dir)),
        onPhase: (phase: CompilePhase) => {
          if (phase === 'writing') wrote = true;
          else this.setPhase(phase);
        },
      };
      await this.compileFn(this.deps.workflowFile, outDir, options);
      this.current = { state: 'done', phase: null };
      await this.stopPlayground();
      return { ok: true };
    } catch (error) {
      if (wrote) await this.stopPlayground();
      const message = this.failureMessage(error, wrote, outDir);
      this.current = { state: 'error', phase: null, error: message };
      return { ok: false, message, outputMayBeIncomplete: wrote };
    }
  }

  private async stopPlayground(): Promise<void> {
    try {
      await this.deps.playground()?.stop();
    } catch {
      // A playground that cannot stop does not change the compile result
    }
  }

  private failureMessage(error: unknown, wrote: boolean, outDir: string): string {
    if (error instanceof AppNamesError) return APP_NAME_NOT_SAVED;
    let base = wrote ? COMPILE_FAILED_INCOMPLETE : COMPILE_FAILED_UNCHANGED;
    if (error instanceof InstallTimeout) return COMPILE_INSTALL_TIMEOUT;
    if (error instanceof InstallStopped) return COMPILE_INSTALL_STOPPED;
    const raw = error instanceof Error ? error.message : '';
    const first = raw.split(/\r?\n/)[0]?.trim() ?? '';
    if (first.length > 0) {
      const detail = scrubMessage(this.deps.scrub(first), [...this.deps.paths, outDir, dirname(this.deps.workflowFile)]);
      base = `${base} Cause: ${detail}`;
    }
    return this.deps.scrub(base.length > MAX_MESSAGE * 2 ? base.slice(0, MAX_MESSAGE * 2) : base);
  }

  /** `npm install` without terminal output, with a time limit, killed as a tree. */
  private quietInstaller(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new InstallStopped());
        return;
      }
      const child = spawn('npm', ['install'], {
        cwd: dir,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.children.add(child);
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        killTree(child.pid);
        finish(new InstallTimeout());
      }, this.timeoutMs);
      child.on('error', (e) => finish(e));
      child.on('exit', (code, signal) => {
        if (this.closed && code !== 0) finish(new InstallStopped());
        else if (code === 0) finish();
        else finish(new Error(`npm install failed (${code ?? signal ?? 'unknown'})`));
      });
    });
  }
}

export class NullCompileRunner extends StudioCompileRunner { }

export function createCompileRunner(deps: CompileRunnerDeps): CompileRunner {
  return new StudioCompileRunner(deps);
}
