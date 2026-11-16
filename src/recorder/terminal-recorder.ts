import { keyToSequence } from '../sandbox/keys.js';
import { tokenizeInput, type InputToken } from './key-tokenizer.js';
import { WorkflowRecorder } from './workflow-recorder.js';
import type { FinalZone, ResultZone, ScreenContent, Workflow } from '../types.js';

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MENU_TEXT = '\r\n[recording] v: make the last typed text a variable   e: end recording   any other key: continue\r\n';

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
  private mode: 'normal' | 'menu' | 'naming' = 'normal';
  private pendingText = '';
  private pendingPrompt: string | undefined;
  private lastTyped: { index: number; prompt?: string; marked: boolean } | null = null;
  private nameBuffer = '';
  private steps = 0;
  private constantValues = 0;

  /**
   * @param label - label of the Workflow (becomes the tool name)
   * @param currentPrompt - the text the program shows where typing starts, e.g. the
   *   last line of the screen; used to describe and suggest a name for variables
   */
  constructor(
    label: string,
    private readonly currentPrompt: () => string | undefined = () => undefined,
  ) {
    this.recorder = new WorkflowRecorder(label);
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
      }
    }
    return result;
  }

  /** Finish the recording with the screen the user ended on. */
  finish(finalScreen?: ScreenContent, finalZone?: FinalZone, resultZone?: ResultZone): Workflow {
    this.flushText();
    return this.recorder.finish(finalScreen, finalZone, resultZone);
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
        this.recorder.addStep({ actionType: 'keypress', selectors: [], value: token.name, label: `Press ${token.name}` });
        this.steps += 1;
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
      return `[recording] variable "${name}" saved\r\n`;
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
