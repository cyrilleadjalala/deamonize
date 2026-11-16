import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import { keyToSequence } from './keys.js';
import { TerminalScreen } from './terminal-screen.js';
import type { SandboxDriver } from './driver.js';
import type { ScreenContent, RecordedAction } from '../types.js';

export class PtyDriver implements SandboxDriver {
  readonly onUnexpectedExit = new EventEmitter();
  private ptyProcess: pty.IPty | null = null;
  private screen: TerminalScreen | null = null;
  private stopping = false;
  private exited = false;

  constructor(
    private command: string,
    private args: string[] = [],
    private options: {
      cols?: number;        // default 80
      rows?: number;        // default 24
      stabilizeMs?: number; // ms of silence = "stable", default 150
      cwd?: string;
    } = {}
  ) {}

  async start(): Promise<void> {
    const screen = new TerminalScreen(this.options.cols ?? 80, this.options.rows ?? 24);
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

    ptyProcess.onData((data: string) => screen.write(data));

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

    // Wait for the program to react and its output to stabilize, then capture
    this.screen?.touch();
    return this.captureScreen();
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
