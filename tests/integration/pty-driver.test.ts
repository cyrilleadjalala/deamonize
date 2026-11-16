import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { PtyDriver } from '../../src/sandbox/pty-driver.js';
import { keyToSequence, sequenceToKey } from '../../src/sandbox/keys.js';
import { TerminalScreen } from '../../src/sandbox/terminal-screen.js';

const greeter = join(resolve(import.meta.dirname, '..'), 'fixtures', 'greeter.mjs');

describe('PtyDriver with a real interactive program', () => {
  let driver: PtyDriver | undefined;

  afterEach(async () => {
    await driver?.stop();
    driver = undefined;
  });

  it('shows the first screen, then the effect of typing and pressing Enter', async () => {
    driver = new PtyDriver(process.execPath, [greeter]);
    await driver.start();

    const first = await driver.captureScreen();
    expect(first.type).toBe('terminal');
    expect(first.raw).toContain('Your name:');

    await driver.execute({ actionType: 'type', value: 'Ada' });
    await driver.execute({ actionType: 'keypress', value: 'Enter' });

    // The driver returns after a quiet period; on a loaded machine the program may answer later,
    // so wait for the expected screen instead of assuming how long the answer takes
    const pty = driver;
    let screen = '';
    await vi.waitFor(
      async () => {
        screen = (await pty.captureScreen()).raw;
        expect(screen).toContain('Hello Ada!');
        expect(screen).toContain('Choose [1] Greet again, [2] Quit:');
      },
      { timeout: 20000, interval: 100 },
    );
  }, 30000);

  it('does not report a stop requested by the caller as an unexpected exit', async () => {
    driver = new PtyDriver(process.execPath, [greeter]);
    const onExit = vi.fn();
    driver.onUnexpectedExit.on('exit', onExit);
    await driver.start();

    await driver.stop();
    // The exit event of the killed process arrives asynchronously: give it ample time to (wrongly) fire
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(onExit).not.toHaveBeenCalled();
  }, 30000);

  it('reports the exit code when the program ends by itself', async () => {
    driver = new PtyDriver(process.execPath, ['-e', 'process.exit(3)']);
    const exited = new Promise<{ exitCode: number }>((resolve) => driver!.onUnexpectedExit.once('exit', resolve));

    await driver.start();

    await expect(exited).resolves.toEqual({ exitCode: 3 });
  }, 30000);
});

describe('TerminalScreen', () => {
  it('shows what is on screen, not everything that was printed', async () => {
    const screen = new TerminalScreen(20, 4);
    screen.write('first screen\r\nline two');
    screen.write('\x1b[2J\x1b[H'); // clear and home
    screen.write('second screen');
    await screen.flush();

    expect(screen.text()).toBe('second screen');
    screen.dispose();
  });
});

describe('keys', () => {
  it('maps names to sequences and back', () => {
    expect(keyToSequence('Enter')).toBe('\r');
    expect(keyToSequence('ArrowUp')).toBe('\x1b[A');
    expect(keyToSequence('Ctrl+C')).toBe('\x03');
    expect(keyToSequence('x')).toBe('x');
    expect(sequenceToKey('\x1b[B')).toBe('ArrowDown');
    expect(sequenceToKey('\x03')).toBe('Ctrl+C');
    expect(sequenceToKey('a')).toBeUndefined();
  });
});
