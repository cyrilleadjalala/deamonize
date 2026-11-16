import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import { keyToSequence } from './keys.js';
import { TerminalScreen } from './terminal-screen.js';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../recorder/terminal-recorder.js';
import { compileStepWait, waitForPattern, PatternTimeoutError, type CompiledScreenPattern } from '../replay/runtime/pattern-wait.js';
import type { SandboxDriver } from './driver.js';

const DEFAULT_WAIT_MS = 15000;
import type { ScreenContent, RecordedAction } from '../types.js';

export class PtyDriver implements SandboxDriver {
  readonly onUnexpectedExit = new EventEmitter();
  private ptyProcess: pty.IPty | null = null;
  private screen: TerminalScreen | null = null;
  private stopping = false;
  private exited = false;
  private readonly outputListeners = new Set<() => void>();

  constructor(
    private command: string,
    private args: string[] = [],
    private options: {
      cols?: number;        // default 80 (the size recorded in the workflow, see Replayer)
      rows?: number;        // default 24
      stabilizeMs?: number; // ms of silence = "stable", default 150
      cwd?: string;
    } = {}
  ) { }

  /** The size of the pty and of the screen renderer (the documented fallback is 80x24). */
  get terminalSize(): { cols: number; rows: number } {
    return { cols: this.options.cols ?? DEFAULT_TERMINAL_COLS, rows: this.options.rows ?? DEFAULT_TERMINAL_ROWS };
  }

  async start(): Promise<void> {
    const { cols, rows } = this.terminalSize;
    const screen = new TerminalScreen(cols, rows);
    this.screen = screen;
    this.stopping = false;
    this.exited = false;

    screen.touch();
    const ptyProcess = pty.spawn(this.command, this.args, {
      cols: screen.cols,
      rows: screen.rows,
      name: 'xterm-256color',
      cwd: this.options.cwd,
    });
    this.ptyProcess = ptyProcess;

    ptyProcess.onData((data: string) => {
      screen.write(data);
      for (const listener of this.outputListeners) listener();
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      this.exited = true;
      // Stopping the driver ourselves is not an unexpected exit
      if (!this.stopping) {
        this.onUnexpectedExit.emit('exit', { exitCode });
      }
    });

    // Wait for the first screen: a program may take a while to start and print
    await screen.waitForText(5000);
    await screen.settle(this.options.stabilizeMs ?? 150, 2000);
  }

  async captureScreen(): Promise<ScreenContent> {
    if (!this.screen) {
      throw new Error('PtyDriver is not started. Call start() first.');
    }

    await this.screen.settle(this.options.stabilizeMs ?? 150, 2000);
    const text = this.screen.text();

    return {
      type: 'terminal',
      raw: text,
      normalized: text,
      capturedAt: Date.now(),
    };
  }

  async execute(action: RecordedAction): Promise<ScreenContent> {
    if (!this.ptyProcess) {
      throw new Error('PtyDriver is not started. Call start() first.');
    }

    const wait = action.waitFor === undefined ? undefined : compileStepWait(action.waitFor);
    if (wait !== undefined && action.waitFor?.when === 'before') {
      await this.waitForScreen(wait, action.waitBudgetMs);
    }

    switch (action.actionType) {
      case 'keypress':
        this.ptyProcess.write(keyToSequence(action.value ?? ''));
        break;

      case 'type':
        this.ptyProcess.write(action.value ?? '');
        break;

      case 'click':
        throw new Error('click not supported for TUI/CLI targets');

      case 'form_submit':
        this.ptyProcess.write(keyToSequence('Enter'));
        break;

      case 'select':
        this.ptyProcess.write((action.value ?? '') + keyToSequence('Enter'));
        break;

      default: {
        // Exhaustiveness guard — TypeScript will catch unknown action types at compile time
        const _exhaustive: never = action.actionType;
        throw new Error(`Unknown action type: ${String(_exhaustive)}`);
      }
    }

    this.screen?.touch();
    if (wait !== undefined && action.waitFor?.when !== 'before') {
      // The pattern replaces the silence rule: the step is done as soon as it shows up
      await this.waitForScreen(wait, action.waitBudgetMs);
      return this.snapshot();
    }
    // Wait for the program to react and its output to stabilize, then capture
    return this.captureScreen();
  }

  /** The rendered screen as it is now, once everything the program printed is drawn. */
  private async snapshot(): Promise<ScreenContent> {
    if (!this.screen) {
      throw new Error('PtyDriver is not started. Call start() first.');
    }
    await this.screen.flush();
    const text = this.screen.text();
    return { type: 'terminal', raw: text, normalized: text, capturedAt: Date.now() };
  }

  /** Poll the rendered screen for the pattern, up to its timeout and the time left; a timeout throws PatternTimeoutError. */
  private async waitForScreen(wait: CompiledScreenPattern, budgetMs: number | undefined): Promise<void> {
    const screen = this.screen;
    if (!screen) {
      throw new Error('PtyDriver is not started. Call start() first.');
    }
    const outcome = await waitForPattern(
      async () => {
        await screen.flush();
        return screen.text();
      },
      wait,
      {
        timeoutMs: Math.max(1, Math.min(wait.timeoutMs ?? DEFAULT_WAIT_MS, budgetMs ?? Number.POSITIVE_INFINITY)),
        subscribe: (listener) => {
          this.outputListeners.add(listener);
          return () => this.outputListeners.delete(listener);
        },
        isClosed: () => this.exited,
      }
    );
    if (!outcome.matched) {
      throw new PatternTimeoutError(wait, outcome.elapsedMs, outcome.screenExcerpt ?? '');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.ptyProcess) {
      // Killing a process that already ended makes ConPTY print an error
      if (!this.exited) {
        try {
          this.ptyProcess.kill();
        } catch {
          // Already gone
        }
      }
      this.ptyProcess = null;
    }
    this.screen?.dispose();
    this.screen = null;
  }
}
