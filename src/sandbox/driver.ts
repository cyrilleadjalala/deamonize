import type { ScreenContent, RecordedAction } from '../types.js';
import { EventEmitter } from 'node:events';

export interface SandboxDriver {
  /** Start the sandbox. Resolves when ready to accept interactions. */
  start(): Promise<void>;

  /** Capture the current screen state. */
  captureScreen(): Promise<ScreenContent>;

  /** Execute an interaction and return the resulting screen. */
  execute(action: RecordedAction): Promise<ScreenContent>;

  /** Stop the sandbox cleanly. */
  stop(): Promise<void>;

  /** Emitted when the sandbox process exits unexpectedly with { exitCode: number }. */
  onUnexpectedExit: EventEmitter;
}

export interface UnexpectedExitEvent {
  exitCode: number;
}
