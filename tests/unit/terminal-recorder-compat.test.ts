import { describe, it, expect } from 'vitest';
import { MENU_KEY } from '../../src/recorder/key-tokenizer.js';
import { TerminalRecorder } from '../../src/recorder/terminal-recorder.js';

const prompt = (): string => 'Your name: ';

describe('terminal recorder backward compatibility', () => {
  it('builds the Variable of before when Enter answers every question', () => {
    const recorder = new TerminalRecorder('Greet', prompt);
    recorder.handleInput('Ada\r');
    recorder.handleInput(MENU_KEY);
    recorder.handleInput('v');
    recorder.handleInput('\r'); // keep the suggested name
    recorder.handleInput('\r'); // optional? default n
    const saved = recorder.handleInput('\r'); // type? default s
    expect(saved.echo).toContain('variable "your_name" saved');

    const workflow = recorder.finish();
    expect(workflow.variables).toEqual([{ name: 'your_name', description: 'Your name' }]);
    expect(workflow.variables[0]).not.toHaveProperty('optional');
    expect(workflow.variables[0]).not.toHaveProperty('whenOmitted');
    expect(workflow.variables[0]).not.toHaveProperty('type');
    expect(workflow.observedPayloads).toEqual([{ your_name: 'Ada' }]);
  });
});