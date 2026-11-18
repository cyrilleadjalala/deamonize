import { describe, it, expect } from 'vitest';
import { tokenizeInput, MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { TerminalRecorder, detectPrompt, parseTerminalDimension, resolveTerminalSize } from '../../src/recorder/terminal-recorder.js';

describe('tokenizeInput', () => {
  it('groups typed characters and names the keys around them', () => {
    expect(tokenizeInput('Ada\r')).toEqual([
      { kind: 'text', text: 'Ada' },
      { kind: 'key', name: 'Enter' },
    ]);
    expect(tokenizeInput('\x1b[A\x1b[B\t\x7f')).toEqual([
      { kind: 'key', name: 'ArrowUp' },
      { kind: 'key', name: 'ArrowDown' },
      { kind: 'key', name: 'Tab' },
      { kind: 'key', name: 'Backspace' },
    ]);
  });

  it('reads application-mode arrows, Escape, Ctrl keys and \r\n as one Enter', () => {
    expect(tokenizeInput('\x1bOC')).toEqual([{ kind: 'key', name: 'ArrowRight' }]);
    expect(tokenizeInput('\x1b')).toEqual([{ kind: 'key', name: 'Escape' }]);
    expect(tokenizeInput('\x03')).toEqual([{ kind: 'key', name: 'Ctrl+C' }]);
    expect(tokenizeInput('\r\n')).toEqual([{ kind: 'key', name: 'Enter' }]);
  });

  it('opens the menu with Ctrl+] and drops escape sequences it does not know', () => {
    expect(tokenizeInput(`a${MENU_KEY}e`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'menu' },
      { kind: 'text', text: 'e' },
    ]);
    expect(tokenizeInput('\x1b[99;99Z')).toEqual([]);
  });
});

describe('TerminalRecorder', () => {
  const prompt = () => 'Your name: ';

  it('records typed text and keys as steps, and forwards them to the program', () => {
    const recorder = new TerminalRecorder('Greet', prompt);

    const typed = recorder.handleInput('Ada');
    const entered = recorder.handleInput('\r1\r');

    expect(typed.forward).toBe('Ada');
    expect(entered.forward).toBe('\r1\r');

    const workflow = recorder.finish();
    expect(workflow.steps.map((s) => [s.actionType, s.value])).toEqual([
      ['type', 'Ada'],
      ['keypress', 'Enter'],
      ['type', '1'],
      ['keypress', 'Enter'],
    ]);
    expect(workflow.steps.every((s) => s.selectors.length === 0)).toBe(true);
    expect(workflow.steps[0].label).toBe('Type at "Your name"');
  });

  it('keeps the corrected text when the user fixes a typo with Backspace', () => {
    const recorder = new TerminalRecorder('Greet');

    const result = recorder.handleInput('Adx\x7fa\r');

    expect(result.forward).toBe('Adx\x7fa\r');
    expect(recorder.finish().steps.map((s) => s.value)).toEqual(['Ada', 'Enter']);
  });

  it('makes the last typed text a variable through the menu, suggesting a name from the prompt', () => {
    const recorder = new TerminalRecorder('Greet', prompt);
    recorder.handleInput('Ada\r');

    const menu = recorder.handleInput(MENU_KEY);
    expect(menu.forward).toBe('');
    expect(menu.echo).toContain('v: make the last typed text a variable');

    const naming = recorder.handleInput('v');
    expect(naming.echo).toContain('variable name: your_name');

    const asked = recorder.handleInput('\r');
    expect(asked.echo).toContain('optional? (y/n, Enter = n)');
    expect(recorder.handleInput('\r').echo).toContain('type? (s/n/b, Enter = s)');
    const saved = recorder.handleInput('\r');
    expect(saved.echo).toContain('variable "your_name" saved');
    expect(saved.forward).toBe('');

    const workflow = recorder.finish();
    expect(workflow.steps[0].variable).toBe('your_name');
    expect(workflow.variables).toEqual([{ name: 'your_name', description: 'Your name' }]);
    expect(workflow.observedPayloads).toEqual([{ your_name: 'Ada' }]);
    expect(recorder.constantTypedValues).toBe(0);
  });

  it('lets the user choose another name, and refuses an invalid one', () => {
    const recorder = new TerminalRecorder('Greet', prompt);
    recorder.handleInput('Ada\r');
    recorder.handleInput(MENU_KEY);
    recorder.handleInput('v');

    // Clear the suggestion (9 characters) and type an invalid name
    recorder.handleInput('\x7f'.repeat('your_name'.length));
    recorder.handleInput('1 bad');
    const refused = recorder.handleInput('\r');
    expect(refused.echo).toContain('use letters, digits and underscores');

    recorder.handleInput('\x7f'.repeat(5));
    recorder.handleInput('who');
    recorder.handleInput('\r');
    recorder.handleInput('\r');
    expect(recorder.handleInput('\r').echo).toContain('variable "who" saved');
    expect(recorder.finish().variables[0].name).toBe('who');
  });

  it('ends the recording from the menu, and tells when there is nothing to mark', () => {
    const recorder = new TerminalRecorder('Greet');

    recorder.handleInput(MENU_KEY);
    expect(recorder.handleInput('v').echo).toContain('nothing to mark');

    recorder.handleInput('x\r');
    recorder.handleInput(MENU_KEY);
    expect(recorder.handleInput('e').ended).toBe(true);
  });

  it('counts the typed values that stay constants', () => {
    const recorder = new TerminalRecorder('Greet', prompt);
    recorder.handleInput('Ada\r');
    recorder.handleInput('1\r');

    recorder.finish();
    expect(recorder.constantTypedValues).toBe(2);
  });

  it('cannot finish without any step', () => {
    expect(() => new TerminalRecorder('Empty').finish()).toThrow(/without steps/);
  });
});

describe('detectPrompt', () => {
  it('recognises the prompts of shells and command line programs', () => {
    for (const line of ['sqlite> ', 'mysql> ', '>>> ', '(venv) $ ', 'user@host:~$ ', 'root@box:/# ', 'Your name: ', 'Continue? ', 'In [1]:', 'C:\\work>', '...']) {
      expect(detectPrompt(line), line).toBe(line.trimEnd());
    }
  });

  it('does not take output for a prompt', () => {
    for (const line of ['Hello Ada!', 'item 3', 'sqlite> select 1', '', '   ', undefined, 'x'.repeat(201) + '$']) {
      expect(detectPrompt(line), String(line)).toBeUndefined();
    }
  });
});

describe('TerminalRecorder screen waits', () => {
  const stored = { flags: 'm', mode: 'appear', timeoutMs: 15000 };

  /** A screen whose last line the test sets. */
  function screen(initial: string) {
    const state = { line: initial as string | undefined };
    return { state, read: () => state.line };
  }

  it('stores the prompt shown after a step as the pattern the step waits for', () => {
    const s = screen('sqlite>');
    const recorder = new TerminalRecorder('Query', s.read);

    recorder.handleInput('select 1');
    s.state.line = 'sqlite> select 1';
    recorder.handleInput('\r');
    s.state.line = 'sqlite>';
    recorder.handleInput('quit');
    s.state.line = 'sqlite> quit';
    recorder.handleInput('\r');
    s.state.line = 'Bye';

    const steps = recorder.finish().steps;
    expect(steps.map((st) => st.value)).toEqual(['select 1', 'Enter', 'quit', 'Enter']);
    // Typed text never gets an automatic wait (its screen is its own echo); Enter shows the next prompt; the last screen is output
    expect(steps[0].waitFor).toBeUndefined();
    expect(steps[1].waitFor).toEqual({ pattern: '^sqlite>$', ...stored });
    expect(steps[2].waitFor).toBeUndefined();
    expect(steps[3].waitFor).toBeUndefined();
    expect(recorder.waitCount).toBe(1);
  });

  it('does not wait for a prompt that contains a value typed for a variable, and removes one that does after marking', () => {
    const s = screen('name:');
    const recorder = new TerminalRecorder('Greet', s.read);
    recorder.handleInput('Ada');
    s.state.line = 'name: Ada';
    recorder.handleInput('\r');
    s.state.line = 'Ada>';
    recorder.handleInput('x');
    expect(recorder.finish().steps[1].waitFor).toEqual({ pattern: '^Ada>$', ...stored });

    // Marked as a variable afterwards: the prompt would change with the value
    const t = screen('name:');
    const second = new TerminalRecorder('Greet', t.read);
    second.handleInput('Ada');
    t.state.line = 'name: Ada';
    second.handleInput('\r');
    t.state.line = 'Ada>';
    second.handleInput(MENU_KEY);
    second.handleInput('v');
    second.handleInput('\x7f'.repeat(32));
    second.handleInput('who');
    second.handleInput('\r');
    second.handleInput('\r');
    const saved = second.handleInput('\r');
    expect(saved.echo).toContain('variable "who" saved');
    expect(saved.echo).toContain('1 screen wait(s) contained the value and were removed');
    expect(second.waitCount).toBe(0);

    // Once the variable exists, a prompt with its value is not stored
    t.state.line = 'Ada>';
    second.handleInput('y');
    t.state.line = 'y';
    second.handleInput('\r');
    t.state.line = 'Ada>';
    second.handleInput('z');
    expect(second.finish().steps.every((st) => st.waitFor === undefined)).toBe(true);
  });

  it('records a pattern typed in the menu on the last step, or the last line when none is typed', () => {
    const s = screen('Done >');
    const recorder = new TerminalRecorder('Menu', s.read);
    recorder.handleInput('\r');

    recorder.handleInput(MENU_KEY);
    expect(recorder.handleInput('w').echo).toContain('Enter alone waits for "Done >"');
    recorder.handleInput('^ok \\d+$');
    expect(recorder.handleInput('\r').echo).toContain('waits for /^ok \\d+$/');

    recorder.handleInput('\r');
    recorder.handleInput(MENU_KEY);
    recorder.handleInput('w');
    recorder.handleInput('\r');

    const steps = recorder.finish().steps;
    expect(steps[0].waitFor).toEqual({ pattern: '^ok \\d+$', ...stored });
    expect(steps[1].waitFor).toEqual({ pattern: '^Done >$', ...stored });
  });

  it('refuses a menu pattern that is catastrophic, empty of context or has nothing to wait after', () => {
    const s = screen('$');
    const recorder = new TerminalRecorder('Menu', s.read);
    recorder.handleInput(MENU_KEY);
    expect(recorder.handleInput('w').echo).toContain('nothing to wait after');

    recorder.handleInput('\r');
    recorder.handleInput(MENU_KEY);
    recorder.handleInput('w');
    recorder.handleInput('(a+)+$');
    expect(recorder.handleInput('\r').echo).toContain('repeats a repeated group');

    recorder.handleInput(MENU_KEY);
    recorder.handleInput('w');
    expect(recorder.handleInput('\x1b').echo).toContain('cancelled');
    // The refused and the cancelled patterns left the detected prompt alone
    expect(recorder.finish().steps[0].waitFor).toEqual({ pattern: '^\\$$', ...stored });
  });

  it('puts the --wait-after pattern and timeout on every step, instead of detecting prompts', () => {
    const s = screen('$');
    const recorder = new TerminalRecorder('All', s.read, undefined, { regex: 'ready$', timeoutMs: 500 });
    recorder.handleInput('ls\r');
    s.state.line = '$';
    recorder.handleInput('x');

    const steps = recorder.finish().steps;
    expect(steps.length).toBe(3);
    for (const step of steps) {
      expect(step.waitFor).toEqual({ pattern: 'ready$', flags: 'm', mode: 'appear', timeoutMs: 500 });
    }
    expect(() => new TerminalRecorder('Bad', undefined, undefined, { regex: '(a+)+' })).toThrow(/repeats a repeated group/);
  });

  it('can be turned off', () => {
    const s = screen('$');
    const recorder = new TerminalRecorder('Off', s.read, undefined, { auto: false });
    recorder.handleInput('\r');
    s.state.line = '$';
    recorder.handleInput('\r');
    expect(recorder.finish().steps.every((st) => st.waitFor === undefined)).toBe(true);
  });
});

describe('terminal size', () => {
  it('validates --cols and --rows (20..500, 5..200, whole numbers)', () => {
    expect(parseTerminalDimension('120', 'cols')).toBe(120);
    expect(parseTerminalDimension(20, 'cols')).toBe(20);
    expect(parseTerminalDimension('500', 'cols')).toBe(500);
    expect(parseTerminalDimension('5', 'rows')).toBe(5);
    expect(parseTerminalDimension(200, 'rows')).toBe(200);
    for (const [value, name] of [['19', 'cols'], ['501', 'cols'], ['4', 'rows'], ['201', 'rows'], ['80.5', 'cols'], ['abc', 'rows'], ['', 'cols']] as const) {
      expect(() => parseTerminalDimension(value, name)).toThrow(new RegExp(`--${name}`));
    }
  });

  it('takes the size of the output terminal, falls back to 80x24, and lets overrides win', () => {
    expect(resolveTerminalSize({}, { columns: 132, rows: 50 })).toEqual({ cols: 132, rows: 50 });
    expect(resolveTerminalSize({}, {})).toEqual({ cols: 80, rows: 24 });
    expect(resolveTerminalSize({}, { columns: 0, rows: undefined })).toEqual({ cols: 80, rows: 24 });
    expect(resolveTerminalSize({ cols: 120 }, { columns: 132, rows: 50 })).toEqual({ cols: 120, rows: 50 });
    expect(() => resolveTerminalSize({ rows: 3 }, {})).toThrow(/--rows/);
  });

  it('stores the initial size in the workflow, not the size after a resize', () => {
    const recorder = new TerminalRecorder('Size', undefined, { cols: 100, rows: 30 });
    recorder.handleInput('a\r');

    expect(recorder.noteResize(100, 30)).toBe(false);
    expect(recorder.resized).toBe(false);

    expect(recorder.noteResize(140, 50)).toBe(true);
    expect(recorder.noteResize(90, 20)).toBe(false); // warns once
    expect(recorder.resized).toBe(true);
    expect(recorder.currentSize).toEqual({ cols: 90, rows: 20 });
    expect(recorder.initialSize).toEqual({ cols: 100, rows: 30 });

    const workflow = recorder.finish();
    expect(workflow).toMatchObject({ cols: 100, rows: 30 });
  });

  it('records 80x24 when no size is given', () => {
    const recorder = new TerminalRecorder('Default');
    recorder.handleInput('\r');
    const workflow = recorder.finish();
    expect(workflow).toMatchObject({ cols: 80, rows: 24 });
  });
});
