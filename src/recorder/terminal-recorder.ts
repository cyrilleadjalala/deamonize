import { keyToSequence } from '../sandbox/keys.js';
import { tokenizeInput, type InputToken } from './key-tokenizer.js';
import { WorkflowRecorder } from './workflow-recorder.js';
import { compileScreenPattern, escapeRegex, lineSpec, PatternError } from '../replay/runtime/pattern-wait.js';
import type { FinalZone, ResultZone, ScreenContent, ScreenWait, Workflow } from '../types.js';

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MENU_TEXT = '\r\n[recording] v: make the last typed text a variable   w: wait for a screen pattern after the last step   e: end recording   any other key: continue\r\n';

/** How long a recorded wait for a prompt lasts when no --wait-timeout is given. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15000;

export interface WaitRecordingOptions {
  /** Detect the prompt shown after each step and wait for it at replay. Default true. */
  auto?: boolean;
  /** A regular expression every step waits for after it ran (`--wait-after`); replaces the automatic prompts. */
  regex?: string;
  /** Timeout of the recorded waits in ms (default 15000). */
  timeoutMs?: number;
}

/**
 * The line as a prompt to wait for, or undefined when the line does not look like one: it ends with
 * `$ > # : ? ] %` (after trimming the end), or is a continuation prompt such as `...`.
 * That covers `sqlite> `, `mysql> `, `>>> `, `(venv) $ `, `user@host:~$ ` and `Your name: `.
 */
export function detectPrompt(line: string | undefined): string | undefined {
  const text = (line ?? '').trimEnd();
  if (text.trim() === '' || text.length > 200) return undefined;
  if (/[$>#:?\]%]$/.test(text) || /^\.\.\.$/.test(text.trim())) return text;
  return undefined;
}

/** True when the pattern of the wait contains one of the values (as text or escaped in an expression). */
function waitMentions(wait: ScreenWait, values: readonly string[]): boolean {
  const source = wait.text ?? wait.pattern ?? '';
  return values.some((value) => value !== '' && (source.includes(value) || source.includes(escapeRegex(value))));
}

/** The size a terminal workflow replays at when none was recorded (old files). */
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const TERMINAL_COLS_RANGE = { min: 20, max: 500 } as const;
export const TERMINAL_ROWS_RANGE = { min: 5, max: 200 } as const;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A column or row count given as text (a CLI option) or number; throws a descriptive error when out of range. */
export function parseTerminalDimension(value: string | number, name: 'cols' | 'rows'): number {
  const range = name === 'cols' ? TERMINAL_COLS_RANGE : TERMINAL_ROWS_RANGE;
  const text = typeof value === 'number' ? String(value) : value.trim();
  const n = Number(text);
  if (text === '' || !Number.isInteger(n) || n < range.min || n > range.max) {
    throw new Error(`Invalid --${name} "${value}": expected an integer from ${range.min} to ${range.max}`);
  }
  return n;
}

/**
 * The size to record at: an override, else what the output terminal reports, else 80x24.
 * An override is validated; a size reported by the terminal is clamped into the supported range.
 */
export function resolveTerminalSize(
  overrides: { cols?: number | string; rows?: number | string },
  reported: { columns?: number; rows?: number } = {},
): TerminalSize {
  const clamp = (n: number | undefined, fallback: number, range: { min: number; max: number }): number =>
    n === undefined || !Number.isFinite(n) || n < 1 ? fallback : Math.min(range.max, Math.max(range.min, Math.floor(n)));
  return {
    cols: overrides.cols !== undefined
      ? parseTerminalDimension(overrides.cols, 'cols')
      : clamp(reported.columns, DEFAULT_TERMINAL_COLS, TERMINAL_COLS_RANGE),
    rows: overrides.rows !== undefined
      ? parseTerminalDimension(overrides.rows, 'rows')
      : clamp(reported.rows, DEFAULT_TERMINAL_ROWS, TERMINAL_ROWS_RANGE),
  };
}

export interface InputResult {
  /** Bytes to send to the program. */
  forward: string;
  /** Text to show the user (menu, variable name prompt), not part of the program's screen. */
  echo: string;
  /** The user asked to end the recording. */
  ended: boolean;
}

/**
 * Turns what a user types into a terminal program into the steps of a
 * Workflow. Text typed between two keys is one `type` step; every other key is
 * a `keypress` step. Ctrl+] opens a small menu to mark the last typed text as a
 * variable or to end the recording; its keys are never sent to the program.
 */
export class TerminalRecorder {
  private readonly recorder: WorkflowRecorder;
  private mode: 'normal' | 'menu' | 'naming' | 'waiting' = 'normal';
  /** The last step whose screen after it is not known yet (read at the next input). */
  private awaiting: number | null = null;
  /** The last line of the screen when the current input arrived: the state the previous steps led to. */
  private chunkLine: string | undefined;
  private waitBuffer = '';
  private waitLine: string | undefined;
  private readonly waitTimeoutMs: number;
  private readonly autoWaits: boolean;
  private readonly fixedWait: ScreenWait | undefined;
  private pendingText = '';
  private pendingPrompt: string | undefined;
  private lastTyped: { index: number; prompt?: string; marked: boolean } | null = null;
  private nameBuffer = '';
  private steps = 0;
  private constantValues = 0;
  private current: TerminalSize;
  private resizedFlag = false;

  /**
   * @param label - label of the Workflow (becomes the tool name)
   * @param currentPrompt - the text the program shows where typing starts, e.g. the
   *   last line of the screen; used to describe and suggest a name for variables
   * @param size - size of the terminal at the start of the recording; it becomes the
   *   size of the Workflow (replay uses a fixed size). Default 80x24.
   */
  constructor(
    label: string,
    private readonly currentPrompt: () => string | undefined = () => undefined,
    private readonly size: TerminalSize = { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS },
    waits: WaitRecordingOptions = {},
  ) {
    this.recorder = new WorkflowRecorder(label);
    this.current = { ...size };
    this.waitTimeoutMs = waits.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.autoWaits = waits.regex === undefined && waits.auto !== false;
    if (waits.regex !== undefined) {
      // Refused before the recording starts when the expression is not accepted
      const compiled = compileScreenPattern({ regex: waits.regex, timeoutMs: this.waitTimeoutMs });
      this.fixedWait = { pattern: compiled.source, flags: compiled.flags, mode: 'appear', timeoutMs: this.waitTimeoutMs };
    }
  }

  /** Number of steps that carry a screen wait now. */
  get waitCount(): number {
    return this.recorder.stepsSoFar().filter((s) => s.waitFor !== undefined).length;
  }

  /** The size the Workflow is recorded at: the initial one, whatever the user does later. */
  get initialSize(): TerminalSize {
    return { ...this.size };
  }

  /** The size of the terminal now (after the last resize). */
  get currentSize(): TerminalSize {
    return { ...this.current };
  }

  /** True once the user resized the terminal to a size other than the initial one. */
  get resized(): boolean {
    return this.resizedFlag;
  }

  /**
   * Note a resize of the user's terminal. Returns true only the first time the size
   * differs from the initial one, so the caller warns once.
   */
  noteResize(cols: number, rows: number): boolean {
    this.current = { cols, rows };
    if (this.resizedFlag || (cols === this.size.cols && rows === this.size.rows)) return false;
    this.resizedFlag = true;
    return true;
  }

  /** Number of steps recorded so far. */
  get stepCount(): number {
    return this.steps + (this.pendingText === '' ? 0 : 1);
  }

  /** Number of typed values stored as constants, i.e. not marked as variables. */
  get constantTypedValues(): number {
    return this.constantValues;
  }

  /** Process bytes read from the user's terminal. */
  handleInput(input: string): InputResult {
    const result: InputResult = { forward: '', echo: '', ended: false };

    // What the program showed after the previous step: nothing the user types now is on the screen yet
    this.chunkLine = this.currentPrompt();
    if (this.pendingText === '') this.resolveAwaiting(this.chunkLine);
    else this.awaiting = null;

    for (const token of tokenizeInput(input)) {
      if (result.ended) break;
      switch (this.mode) {
        case 'normal':
          this.handleNormal(token, result);
          break;
        case 'menu':
          this.handleMenu(token, result);
          break;
        case 'naming':
          this.handleNaming(token, result);
          break;
        case 'waiting':
          this.handleWaiting(token, result);
          break;
      }
    }
    return result;
  }

  /** Finish the recording with the screen the user ended on. */
  finish(finalScreen?: ScreenContent, finalZone?: FinalZone, resultZone?: ResultZone): Workflow {
    if (this.pendingText === '') this.resolveAwaiting(this.currentPrompt());
    this.awaiting = null;
    this.flushText();
    const workflow = this.recorder.finish(finalScreen, finalZone, resultZone);
    workflow.cols = this.size.cols;
    workflow.rows = this.size.rows;
    return workflow;
  }

  // -------------------------------------------------------------------------

  private handleNormal(token: InputToken, result: InputResult): void {
    if (token.kind === 'text') {
      if (this.pendingText === '') {
        this.pendingPrompt = this.currentPrompt();
      }
      this.pendingText += token.text;
      result.forward += token.text;
    } else if (token.kind === 'key') {
      if (token.name === 'Backspace' && this.pendingText !== '') {
        // Correcting a typo: the final text is what counts
        this.pendingText = this.pendingText.slice(0, -1);
      } else {
        this.flushText();
        const index = this.recorder.addStep({ actionType: 'keypress', selectors: [], value: token.name, label: `Press ${token.name}` });
        this.steps += 1;
        this.afterStep(index);
      }
      result.forward += keyToSequence(token.name);
    } else {
      this.flushText();
      this.mode = 'menu';
      result.echo += MENU_TEXT;
    }
  }

  private handleMenu(token: InputToken, result: InputResult): void {
    this.mode = 'normal';
    const choice = token.kind === 'text' ? token.text[0] : undefined;

    if (choice === 'e') {
      result.ended = true;
    } else if (choice === 'w') {
      if (this.steps === 0) {
        result.echo += '[recording] nothing to wait after: do something first\r\n';
      } else {
        this.mode = 'waiting';
        this.waitBuffer = '';
        this.waitLine = this.chunkLine?.trimEnd();
        const suggestion = this.waitLine === undefined || this.waitLine === '' ? 'the last line' : `"${this.waitLine}"`;
        result.echo += `[recording] pattern (regular expression) to wait for after the last step; Enter alone waits for ${suggestion}, Esc cancels: `;
      }
    } else if (choice === 'v') {
      if (this.lastTyped === null || this.lastTyped.marked) {
        result.echo += '[recording] nothing to mark: type some text first\r\n';
      } else {
        this.mode = 'naming';
        this.nameBuffer = toSnakeCase(this.lastTyped.prompt ?? '');
        result.echo += `[recording] variable name: ${this.nameBuffer}`;
      }
    } else {
      result.echo += '[recording] continuing\r\n';
    }
  }

  private handleNaming(token: InputToken, result: InputResult): void {
    if (token.kind === 'text') {
      this.nameBuffer += token.text;
      result.echo += token.text;
    } else if (token.kind === 'key' && token.name === 'Backspace') {
      this.nameBuffer = this.nameBuffer.slice(0, -1);
      result.echo += '\b \b';
    } else if (token.kind === 'key' && token.name === 'Escape') {
      this.mode = 'normal';
      result.echo += '\r\n[recording] cancelled\r\n';
    } else if (token.kind === 'key' && token.name === 'Enter') {
      result.echo += '\r\n' + this.markLastTyped();
    }
  }

  private handleWaiting(token: InputToken, result: InputResult): void {
    if (token.kind === 'text') {
      this.waitBuffer += token.text;
      result.echo += token.text;
    } else if (token.kind === 'key' && token.name === 'Backspace') {
      this.waitBuffer = this.waitBuffer.slice(0, -1);
      result.echo += '\b \b';
    } else if (token.kind === 'key' && token.name === 'Escape') {
      this.mode = 'normal';
      result.echo += '\r\n[recording] cancelled\r\n';
    } else if (token.kind === 'key' && token.name === 'Enter') {
      this.mode = 'normal';
      result.echo += '\r\n' + this.markWait();
    }
  }

  /** Store the pattern typed in the menu (or the last line of the screen) on the last step; returns the message to show. */
  private markWait(): string {
    const typed = this.waitBuffer.trim();
    const spec = typed === ''
      ? (this.waitLine === undefined || this.waitLine === '' ? undefined : lineSpec(this.waitLine))
      : { regex: typed, flags: 'm' };
    if (spec === undefined) return '[recording] the screen is empty: type a pattern\r\n';
    try {
      const compiled = compileScreenPattern({ ...spec, timeoutMs: this.waitTimeoutMs });
      const wait: ScreenWait = { pattern: compiled.source, flags: compiled.flags, mode: 'appear', timeoutMs: this.waitTimeoutMs };
      if (waitMentions(wait, this.variableValues())) {
        return '[recording] not stored: the pattern contains a value typed for a variable, which changes at every call\r\n';
      }
      this.recorder.setWaitFor(this.steps - 1, wait);
      return `[recording] after the last step, the replay waits for /${compiled.source}/ (up to ${this.waitTimeoutMs} ms)\r\n`;
    } catch (err) {
      return `[recording] ${err instanceof PatternError ? err.message : (err as Error).message}\r\n`;
    }
  }

  /** The values of the steps made variables: they change at every call, so no pattern may contain them. */
  private variableValues(): string[] {
    return this.recorder.stepsSoFar().flatMap((s) => (s.variable !== undefined && s.value !== undefined ? [s.value] : []));
  }

  /** The wait of a step just recorded: the fixed pattern, else its screen is read at the next input. */
  private afterStep(index: number): void {
    if (this.fixedWait !== undefined) {
      this.recorder.setWaitFor(index, this.fixedWait);
    } else if (this.autoWaits) {
      this.awaiting = index;
    }
  }

  /** The step waiting for its screen gets that screen's last line as the prompt to wait for, when it is one. */
  private resolveAwaiting(line: string | undefined): void {
    const index = this.awaiting;
    this.awaiting = null;
    if (index !== null) this.storePrompt(index, line);
  }

  private storePrompt(index: number, line: string | undefined): void {
    const prompt = detectPrompt(line);
    if (prompt === undefined) return;
    const spec = lineSpec(prompt);
    const wait: ScreenWait = { pattern: spec.regex, flags: spec.flags, mode: 'appear', timeoutMs: this.waitTimeoutMs };
    // A value typed for a variable changes at every call: such a prompt would never be found again
    if (waitMentions(wait, this.variableValues())) return;
    try {
      compileScreenPattern({ regex: wait.pattern, flags: wait.flags });
    } catch {
      return;
    }
    this.recorder.setWaitFor(index, wait);
  }

  /** Mark the last typed text as a variable; returns the message to show. */
  private markLastTyped(): string {
    const name = this.nameBuffer.trim();
    if (!VARIABLE_NAME.test(name)) {
      return '[recording] use letters, digits and underscores, not starting with a digit; variable name: ' + this.nameBuffer;
    }

    try {
      const description = this.lastTyped?.prompt;
      this.recorder.markVariable(this.lastTyped!.index, description ? { name, description } : { name });
      this.lastTyped!.marked = true;
      this.constantValues -= 1;
      this.mode = 'normal';
      // A wait whose pattern contains this value would never match again with another value
      const value = this.recorder.stepsSoFar()[this.lastTyped!.index].value ?? '';
      let dropped = 0;
      this.recorder.stepsSoFar().forEach((step, i) => {
        if (step.waitFor !== undefined && waitMentions(step.waitFor, [value])) {
          this.recorder.setWaitFor(i, undefined);
          dropped += 1;
        }
      });
      const note = dropped > 0 ? `[recording] ${dropped} screen wait(s) contained the value and were removed\r\n` : '';
      return `[recording] variable "${name}" saved\r\n${note}`;
    } catch (err) {
      this.mode = 'normal';
      return `[recording] ${(err as Error).message}\r\n`;
    }
  }

  private flushText(): void {
    if (this.pendingText === '') return;

    const prompt = cleanPrompt(this.pendingPrompt);
    const index = this.recorder.addStep({
      actionType: 'type',
      selectors: [],
      value: this.pendingText,
      label: prompt ? `Type at "${prompt}"` : 'Type text',
    });
    this.steps += 1;
    this.constantValues += 1;
    if (this.fixedWait !== undefined) {
      this.recorder.setWaitFor(index, this.fixedWait);
    }
    // No automatic wait after typed text: what it leads to on the screen is its own echo, which arrives
    // after a delay and is not a prompt. The key that follows (Enter) carries the wait.
    this.lastTyped = { index, prompt, marked: false };
    this.pendingText = '';
    this.pendingPrompt = undefined;
  }
}

/** The prompt without its trailing colon or arrow, e.g. "Your name: " becomes "Your name". */
function cleanPrompt(prompt: string | undefined): string | undefined {
  const cleaned = (prompt ?? '').replace(/[\s:>?$#]+$/, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

function toSnakeCase(prompt: string): string {
  const cleaned = cleanPrompt(prompt) ?? '';
  const snake = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(snake) ? `_${snake}` : snake;
}
