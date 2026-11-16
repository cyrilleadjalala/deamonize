import pty from 'node-pty';
import { TerminalRecorder } from '../../recorder/terminal-recorder.js';
import { TerminalScreen } from '../../sandbox/terminal-screen.js';
import { cropTerminal } from '../../replay/runtime/screen-hash.js';
import { saveWorkflow } from './save-workflow.js';
import type { RecordSummary } from './record.js';
import type { ScreenContent } from '../../types.js';

/** The part of a terminal input the recorder needs; process.stdin satisfies it. */
export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface RecordTuiOptions {
  command: string[];            // the program and its arguments
  name: string;                 // target application name
  label: string;                // label of the recorded workflow (becomes the tool name)
  out: string;                  // Workflow set file; created, or merged when it exists
  cols?: number;                // default: the width of the output terminal, or 80
  rows?: number;                // default: the height of the output terminal, or 24
  stabilizeMs?: number;         // silence that counts as "the screen is stable", default 150
  finalRect?: { row: number; col: number; rows: number; cols: number }; // drift is judged on this part of the final screen only
  input?: TerminalInput;        // default: process.stdin
  output?: { write(data: string): unknown; columns?: number; rows?: number }; // default: process.stdout
}

export interface RecordTuiSummary extends RecordSummary {
  /** Typed values stored as they are, not marked as variables: they end up in the file. */
  constantTypedValues: number;
  /** Set when the program ended by itself before the user ended the recording. */
  programExitCode?: number;
}

/**
 * Record a workflow by using a terminal program: the user types in their own
 * terminal, everything is forwarded to the program, and the keys become the
 * steps. Ctrl+] opens a menu to mark the last typed text as a variable or to
 * end the recording. The recording also ends when the program exits.
 */
export async function recordTui(options: RecordTuiOptions): Promise<RecordTuiSummary> {
  const input = options.input ?? (process.stdin as unknown as TerminalInput);
  const output = options.output ?? process.stdout;
  const cols = options.cols ?? output.columns ?? 80;
  const rows = options.rows ?? output.rows ?? 24;
  const stabilizeMs = options.stabilizeMs ?? 150;

  const screen = new TerminalScreen(cols, rows);
  const recorder = new TerminalRecorder(options.label, () => lastLine(screen.text()));

  const [command, ...args] = options.command;
  const program = pty.spawn(command, args, { cols, rows, name: 'xterm-256color' });
  let exitCode: number | undefined;

  program.onData((data: string) => {
    output.write(data);
    screen.write(data);
  });

  const cleanup: Array<() => void> = [];
  const done = new Promise<void>((resolve) => {
    program.onExit(({ exitCode: code }: { exitCode: number }) => {
      exitCode = code;
      resolve();
    });

    // Input is handled one chunk at a time, once the screen has rendered everything the
    // program printed: the prompt the user is answering is read from that screen.
    let queue: Promise<void> = Promise.resolve();
    const onInput = (chunk: string): void => {
      queue = queue.then(async () => {
        await screen.flush();
        const result = recorder.handleInput(chunk);
        if (result.forward !== '') {
          program.write(result.forward);
          screen.touch();
        }
        if (result.echo !== '') {
          output.write(result.echo);
        }
        if (result.ended) {
          input.off('data', onInput);
          resolve();
        }
      });
    };

    input.setEncoding('utf8');
    input.on('data', onInput);
    cleanup.push(() => input.off('data', onInput));
  });

  if (input.isTTY) input.setRawMode?.(true);
  input.resume();

  try {
    await done;

    // Let the program finish drawing before keeping the screen it ended on
    await screen.settle(stabilizeMs, 2000);
    const fullText = screen.text();
    const text = options.finalRect ? cropTerminal(fullText, options.finalRect) : fullText;
    const finalScreen: ScreenContent = { type: 'terminal', raw: text, normalized: text, capturedAt: Date.now() };

    const workflow = recorder.finish(finalScreen, options.finalRect ? { rect: options.finalRect } : undefined);
    const totalWorkflows = await saveWorkflow(
      options.out,
      { targetType: 'tui', name: options.name, startCommand: options.command },
      workflow
    );

    const summary: RecordTuiSummary = {
      out: options.out,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      variables: workflow.variables.map((v) => v.name),
      totalWorkflows,
      constantTypedValues: recorder.constantTypedValues,
    };
    if (exitCode !== undefined) {
      summary.programExitCode = exitCode;
    }
    return summary;
  } finally {
    cleanup.forEach((fn) => fn());
    if (input.isTTY) input.setRawMode?.(false);
    input.pause();
    if (exitCode === undefined) {
      try {
        program.kill();
      } catch {
        // Already gone
      }
    }
    screen.dispose();
  }
}

/** The last non-empty line of the screen: where the program is waiting for input. */
function lastLine(text: string): string | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1];
}
