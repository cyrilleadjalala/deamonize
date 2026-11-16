import xtermHeadless from '@xterm/headless';

// @xterm/headless is CommonJS: take the class from the default export
const { Terminal } = xtermHeadless;

/**
 * The screen of a terminal program: output bytes go in, the text currently
 * displayed comes out. Rendered by xterm.js without a window, so cursor
 * movements, clears and redraws give what the user would see, not the history
 * of everything the program printed.
 */
export class TerminalScreen {
  private readonly terminal: InstanceType<typeof Terminal>;
  private lastWriteAt = Date.now();
  private touchedAt = Date.now();
  private writesSinceTouch = 0;

  constructor(
    readonly cols = 80,
    readonly rows = 24,
  ) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  /** Feed output of the program to the screen. */
  write(data: string): void {
    this.lastWriteAt = Date.now();
    this.writesSinceTouch += 1;
    this.terminal.write(data);
  }

  /**
   * Note that input was just sent to the program, so `settle` waits for its
   * reaction instead of returning at once because it was already silent.
   */
  touch(): void {
    this.touchedAt = Date.now();
    this.writesSinceTouch = 0;
  }

  /** Resolves once everything written so far has been rendered. */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => this.terminal.write('', resolve));
  }

  /**
   * Resolves once something is displayed, or after `maxWaitMs`. A terminal emits
   * set-up sequences before the program prints anything, so bytes arriving is
   * not the same as the program having shown its first screen.
   */
  async waitForText(maxWaitMs = 5000): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      await this.flush();
      if (this.text() !== '' || Date.now() - startedAt >= maxWaitMs) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Resolves once the program has reacted and gone quiet: `stableMs` of silence
   * after its output, or, when it prints nothing at all after the last `touch`,
   * `silentGraceMs` (a slow program is given time to answer). Gives up after `maxWaitMs`.
   */
  async settle(stableMs = 100, maxWaitMs = 3000, silentGraceMs = 500): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const now = Date.now();
      const done =
        this.writesSinceTouch > 0
          ? now - this.lastWriteAt >= stableMs
          : now - this.touchedAt >= silentGraceMs;
      if (done || now - startedAt >= maxWaitMs) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.flush();
  }

  /** The text on screen, one line per row, without trailing blanks. */
  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row++) {
      lines.push((buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').trimEnd());
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
