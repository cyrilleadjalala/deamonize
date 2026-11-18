import { describe, it, expect } from 'vitest';
import { MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { TerminalRecorder } from '../../src/recorder/terminal-recorder.js';

/** A recorder that has typed 	ext and is waiting for the answer to the first question after the name. */
function asking(text: string): TerminalRecorder {
  const recorder = new TerminalRecorder('Greet', () => 'Your name: ');
  recorder.handleInput(text + '\r');
  recorder.handleInput(MENU_KEY);
  recorder.handleInput('v');
  const first = recorder.handleInput('\r');
  expect(first.echo).toContain('optional? (y/n, Enter = n)');
  return recorder;
}

describe('terminal recorder variable questions', () => {
  it('asks for the omitted behavior only when the Variable is optional, and Enter means skip', () => {
    const recorder = asking('Ada');
    expect(recorder.handleInput('y').echo).toContain('type? (s/n/b, Enter = s)');
    expect(recorder.handleInput('\r').echo).toContain('skip or use the recorded value');
    expect(recorder.handleInput('\r').echo).toContain('saved');
    expect(recorder.finish().variables).toEqual([
      { name: 'your_name', description: 'Your name', optional: true, whenOmitted: 'skip' },
    ]);
  });

  it('stores useRecorded for r and skip for s', () => {
    const r = asking('Ada');
    r.handleInput('y');
    r.handleInput('s');
    r.handleInput('r');
    expect(r.finish().variables[0]).toMatchObject({ optional: true, whenOmitted: 'useRecorded' });

    const s = asking('Ada');
    s.handleInput('y');
    s.handleInput('s');
    s.handleInput('s');
    expect(s.finish().variables[0]).toMatchObject({ optional: true, whenOmitted: 'skip' });
  });

  it('repeats a question after a wrong key and creates nothing', () => {
    const recorder = asking('Ada');
    expect(recorder.handleInput('x').echo).toContain('optional? (y/n, Enter = n)');
    recorder.handleInput('n');
    expect(recorder.handleInput('q').echo).toContain('type? (s/n/b, Enter = s)');
    expect(recorder.constantTypedValues).toBe(1);
    recorder.handleInput('s');
    expect(recorder.finish().variables).toEqual([{ name: 'your_name', description: 'Your name' }]);
  });

  it('writes the type for number and boolean text that converts', () => {
    const number = asking('42');
    number.handleInput('n');
    number.handleInput('n');
    expect(number.finish().variables[0]).toMatchObject({ type: 'number' });

    const bool = asking('true');
    bool.handleInput('n');
    bool.handleInput('b');
    expect(bool.finish().variables[0]).toMatchObject({ type: 'boolean' });
  });

  it('refuses a number or boolean type the typed text does not convert to, and asks the type again', () => {
    const recorder = asking('Ada');
    recorder.handleInput('n');
    const number = recorder.handleInput('n');
    expect(number.echo).toContain('not a number');
    expect(number.echo).toContain('type? (s/n/b, Enter = s)');
    const bool = recorder.handleInput('b');
    expect(bool.echo).toContain('not true or false');
    expect(recorder.constantTypedValues).toBe(1);
    recorder.handleInput('\r');
    expect(recorder.finish().variables).toEqual([{ name: 'your_name', description: 'Your name' }]);
  });
});