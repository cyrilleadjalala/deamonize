import { describe, it, expect } from 'vitest';
import { tokenizeInput, MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { TerminalRecorder } from '../../src/recorder/terminal-recorder.js';

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
