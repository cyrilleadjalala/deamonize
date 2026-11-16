import pty from 'node-pty';
import { TerminalRecorder, resolveTerminalSize } from '../../recorder/terminal-recorder.js';
import { TerminalScreen } from '../../sandbox/terminal-screen.js';
import { cropTerminal } from '../../replay/runtime/screen-hash.js';
import { saveWorkflow } from './save-workflow.js';
import type { SandboxSpec } from '../../types.js';
import type { RecordSummary } from './record.js';
import { extractTerminalZone } from '../../replay/runtime/extract.js';
import { dataSchemaFor } from '../../schema/data-schema.js';
import type { ResultZone, ScreenContent } from '../../types.js';

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
  startCommand?: string[];      // what the file stores as the program to start, when command is a wrapper of it (e.g. docker run -it ... sqlite3 notes.db)
  cwd?: string;                 // working directory of the program (default: the one of this process)
  name: string;                 // target application name
  label: string;                // label of the recorded workflow (becomes the tool name)
  out: string;                  // Workflow set file; created, or merged when it exists
  cols?: number;                // 20..500; default: the width of the output terminal, or 80
  rows?: number;                // 5..200; default: the height of the output terminal, or 24
  waitAfter?: string;           // regular expression every step waits for on the rendered screen after it ran (replaces the automatic prompt waits)
  sandbox?: SandboxSpec;        // `--sandbox-*` flags: stored in the `sandbox` block of the file
  waitTimeoutMs?: number;       // timeout of the recorded screen waits, default 15000
  stabilizeMs?: number;         // silence that counts as "the screen is stable", default 150
  finalRect?: { row: number; col: number; rows: number; cols: number }; // drift is judged on this part of the final screen only
  resultRect?: { row: number; col: number; rows: number; cols: number }; // the tool returns this part of the final screen, not all of it
  resultRegex?: string;         // applied to the result zone: the named capture groups become `data` (add flags with resultRegexFlags)
  resultRegexFlags?: string;    // e.g. "gm": every match, as an array of objects
  input?: TerminalInput;        // default: process.stdin
  output?: TerminalOutput;      // default: process.stdout
}

/** The part of a terminal output the recorder needs; process.stdout satisfies it. Resizes are optional. */
export interface TerminalOutput {
  write(data: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface RecordTuiSummary extends RecordSummary {
  /** Typed values stored as they are, not marked as variables: they end up in the file. */
  constantTypedValues: number;
  /** The terminal size stored in the workflow, and replayed at. */
  cols: number;
  rows: number;
  /** The user resized the terminal during the recording. */
  resized: boolean;
  /** Steps that wait for a pattern of the screen at replay. */
  screenWaits: number;
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
  // The real size of the user's terminal at the start (or the override); replay uses this fixed size
  const { cols, rows } = resolveTerminalSize({ cols: options.cols, rows: options.rows }, output);
  const stabilizeMs = options.stabilizeMs ?? 150;

  const screen = new TerminalScreen(cols, rows);
  const recorder = new TerminalRecorder(options.label, () => lastLine(screen.text()), { cols, rows }, {
    regex: options.waitAfter,
    timeoutMs: options.waitTimeoutMs,
  });

  const [command, ...args] = options.command;
  const program = pty.spawn(command, args, { cols, rows, name: 'xterm-256color', cwd: options.cwd });
  let exitCode: number | undefined;

  // The program follows the user's window, but the workflow keeps the initial size
  const onResize = (): void => {
    const c = output.columns;
    const r = output.rows;
    if (c === undefined || r === undefined || c < 1 || r < 1) return;
    // With an explicit --cols/--rows the program keeps that size; otherwise it follows the window
    if (options.cols === undefined && options.rows === undefined) {
      try {
        program.resize(c, r);
      } catch {
        // The program already ended
      }
    }
    if (recorder.noteResize(c, r)) {
      output.write(
        `\r\n[recording] the terminal was resized; the workflow keeps the initial size ${cols}x${rows} and replays at that size\r\n`
      );
    }
  };
  output.on?.('resize', onResize);

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
    // A program that redraws all the time never settles: the capture can fall just after it cleared the
    // screen. Read again, within a bounded window, until the asked result zone can be read on it.
    const { fullText, resultZone } = await readFinalScreen(() => screen.text(), options);
    const text = options.finalRect ? cropTerminal(fullText, options.finalRect) : fullText;
    const finalScreen: ScreenContent = { type: 'terminal', raw: text, normalized: text, capturedAt: Date.now() };
    const workflow = recorder.finish(finalScreen, options.finalRect ? { rect: options.finalRect } : undefined, resultZone);
    const totalWorkflows = await saveWorkflow(
      options.out,
      { targetType: 'tui', name: options.name, startCommand: options.startCommand ?? options.command, sandbox: options.sandbox },
      workflow
    );

    const summary: RecordTuiSummary = {
      out: options.out,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      variables: workflow.variables.map((v) => v.name),
      totalWorkflows,
      secrets: [],
      constantTypedValues: recorder.constantTypedValues,
      thumbnails: 0,
      cols,
      rows,
      resized: recorder.resized,
      screenWaits: workflow.steps.filter((s) => s.waitFor !== undefined).length,
    };
    if (resultZone !== undefined) {
      summary.resultZone = { rect: resultZone.rect, kind: resultZone.extractor?.kind ?? 'text' };
    }
    if (exitCode !== undefined) {
      summary.programExitCode = exitCode;
    }
    return summary;
  } finally {
    output.off?.('resize', onResize);
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

/** How long the final screen is read again when the result zone cannot be read on it yet. */
const FINAL_SCREEN_RETRY_MS = 3000;
const FINAL_SCREEN_POLL_MS = 50;

/**
 * The final screen and the result zone read on it. A redrawing program can be caught mid-redraw, so the
 * screen is read again every few milliseconds until the zone reads, for at most FINAL_SCREEN_RETRY_MS;
 * after that the last error is reported. Without a result zone the first capture is kept.
 */
export async function readFinalScreen(
  read: () => string,
  options: Pick<RecordTuiOptions, 'resultRect' | 'resultRegex' | 'resultRegexFlags'>,
  retryMs = FINAL_SCREEN_RETRY_MS
): Promise<{ fullText: string; resultZone: ResultZone | undefined }> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    const fullText = read();
    try {
      return { fullText, resultZone: readResultZone(fullText, options) };
    } catch (err) {
      if (Date.now() >= deadline) throw err;
    }
    await new Promise((r) => setTimeout(r, FINAL_SCREEN_POLL_MS));
  }
}

/** The Result_Zone asked for on the command line, checked against the final screen; undefined when none was asked for. */
function readResultZone(
  screenText: string,
  options: Pick<RecordTuiOptions, 'resultRect' | 'resultRegex' | 'resultRegexFlags'>
): ResultZone | undefined {
  if (options.resultRect === undefined && options.resultRegex === undefined) return undefined;
  const zone: ResultZone = {
    ...(options.resultRect === undefined ? {} : { rect: options.resultRect }),
    extractor: options.resultRegex === undefined
      ? { kind: 'text' }
      : { kind: 'regex', pattern: options.resultRegex, ...(options.resultRegexFlags === undefined ? {} : { flags: options.resultRegexFlags }) },
  };
  const read = extractTerminalZone(screenText, zone);
  if (!read.ok) {
    throw new Error(`The result zone cannot be read on the final screen: ${read.message}`);
  }
  zone.schema = dataSchemaFor(zone.extractor);
  return zone;
}

/** The last non-empty line of the screen: where the program is waiting for input. */
function lastLine(text: string): string | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1];
}
