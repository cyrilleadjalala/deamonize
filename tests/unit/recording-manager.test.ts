import { describe, expect, it } from 'vitest';
import { createRecordingManager } from '../../src/studio/recording-manager.js';
import { NOTHING_RECORDED } from '../../src/studio/messages/record.js';
import type { RecordingManager, StartInput } from '../../src/studio/contracts.js';
import { FakeCompiler, FakeRecord, MemorySessions } from '../helpers/fake-record.js';

const input: StartInput = { name: 'Find order', url: 'https://shop.test/start', reuseSession: false };

function setup(over: { closeDeadlineMs?: number; scrub?: (t: string) => string } = {}) {
  const fake = new FakeRecord();
  const compiler = new FakeCompiler();
  const sessions = new MemorySessions();
  const manager: RecordingManager = createRecordingManager({
    workflowFile: '/work/daemonize.workflows.json',
    sessions,
    compiler,
    scrub: over.scrub ?? ((t) => t),
    record: fake.fn,
    ...(over.closeDeadlineMs === undefined ? {} : { closeDeadlineMs: over.closeDeadlineMs }),
  });
  return { fake, compiler, sessions, manager };
}
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('Recording_Manager', () => {
  it('starts in idle with zero steps', () => {
    expect(setup().manager.status()).toEqual({ state: 'idle', steps: 0, labels: [] });
  });

  it('start gives recording, a second start is 409, record() is called once with the studio options', async () => {
    const { manager, fake } = setup();
    expect(manager.start(input)).toEqual({ status: 202 });
    expect(manager.start(input).status).toBe(409);
    await settled();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ url: input.url, label: 'Find order', name: 'shop.test', headless: false, windowMode: 'studio' });
    expect(fake.calls[0]).not.toHaveProperty('storageState');
    expect(manager.status().state).toBe('recording');
    expect(manager.isActive()).toBe(true);
  });

  it('walks recording, saving, compiling, done when the panel ends the session', async () => {
    const { manager, fake, compiler } = setup();
    let release: () => void = () => undefined;
    compiler.gate = new Promise((r) => { release = r; });
    manager.start(input);
    fake.steps = 4;
    fake.labels = ['a', 'b', 'c', 'd'];
    expect(manager.status()).toMatchObject({ state: 'recording', steps: 4, labels: ['b', 'c', 'd'] });
    fake.end('panel');
    expect(manager.status().state).toBe('saving');
    fake.succeed();
    await settled();
    expect(manager.status().state).toBe('compiling');
    release();
    await settled();
    expect(manager.status()).toEqual({ state: 'done', steps: 4, labels: ['b', 'c', 'd'] });
    expect(compiler.runs).toBe(1);
    expect(manager.isActive()).toBe(false);
    expect(manager.start(input).status).toBe(202);
  });

  it('stop is 202 and sets saving before returning; outside recording it is 409', async () => {
    const { manager, fake } = setup();
    expect(manager.stop().status).toBe(409);
    manager.start(input);
    fake.steps = 1;
    expect(manager.stop()).toEqual({ status: 202 });
    expect(manager.status().state).toBe('saving');
    expect(manager.stop().status).toBe(409);
    await settled();
    expect(manager.status().state).toBe('done');
    expect(manager.stop().status).toBe(409);
  });

  it('reports a launch failure with the launcher message and no steps', async () => {
    const { manager, fake } = setup();
    fake.launchError = 'Google Chrome is not installed. Set DAEMONIZE_CHROMIUM_PATH.';
    manager.start(input);
    await settled();
    const status = manager.status();
    expect(status.state).toBe('error');
    expect(status.error).toContain('DAEMONIZE_CHROMIUM_PATH');
    expect(status.recoveryFile).toBeUndefined();
  });

  it('reports "nothing recorded" when no step exists, with no recovery file', async () => {
    const { manager } = setup();
    manager.start(input);
    manager.stop();
    await settled();
    expect(manager.status()).toMatchObject({ state: 'error', steps: 0, error: NOTHING_RECORDED });
    expect(manager.status().recoveryFile).toBeUndefined();
  });

  it('keeps the recovery file location and hides the path in the message', async () => {
    const { manager, fake } = setup();
    manager.start(input);
    fake.steps = 2;
    fake.labels = ['one', 'two'];
    fake.end('closed');
    fake.fail(new Error('Recording interrupted: the browser exited. The 2 step(s) recorded so far were saved to C:\\work\\daemonize.workflows.json.recovery.json.'));
    await settled();
    const status = manager.status();
    expect(status.state).toBe('error');
    expect(status.recoveryFile).toBe('C:\\work\\daemonize.workflows.json.recovery.json');
    expect(status.error).toContain('the browser exited');
    expect(status.error).not.toContain('C:\\');
    expect(status.steps).toBe(2);
    expect(status.labels).toEqual(['one', 'two']);
  });

  it('goes to error when the compile fails, and the status keeps the final values until the next start', async () => {
    const { manager, fake, compiler } = setup();
    compiler.outcome = { ok: false, message: 'generation failed in /home/me/out', outputMayBeIncomplete: false };
    manager.start(input);
    fake.steps = 1;
    fake.labels = ['x'];
    manager.stop();
    await settled();
    const status = manager.status();
    expect(status.state).toBe('error');
    expect(status.error).not.toContain('/home/me');
    expect(status.steps).toBe(1);
    fake.steps = 0;
    fake.labels = [];
    expect(manager.start(input).status).toBe(202);
    expect(manager.status()).toMatchObject({ state: 'recording', steps: 0, labels: [] });
  });

  it('does not touch the store when the reuse choice is off', async () => {
    const { manager, fake, sessions } = setup();
    manager.start(input);
    fake.steps = 1;
    manager.stop();
    await settled();
    expect(sessions.pathCalls).toBe(0);
    expect(sessions.saves).toEqual([]);
    expect(fake.calls[0]).not.toHaveProperty('captureSessionState');
    expect(fake.calls[0]).not.toHaveProperty('sessionStorageState');
  });

  it('reuses a saved session and saves the captured one after done', async () => {
    const { manager, fake, sessions } = setup();
    sessions.files.set('https://shop.test', { cookies: [] });
    manager.start({ ...input, reuseSession: true });
    await settled();
    expect(fake.calls[0].sessionStorageState).toBe('/memory/https://shop.test');
    fake.steps = 1;
    await fake.captureSession({ cookies: [{ value: 'abc' }] });
    manager.stop();
    await settled();
    expect(manager.status().state).toBe('done');
    expect(sessions.saves).toEqual([['https://shop.test', { cookies: [{ value: 'abc' }] }]]);
  });

  it('notes when no saved session exists, and starts without one', async () => {
    const { manager, fake } = setup();
    manager.start({ ...input, reuseSession: true });
    await settled();
    expect(fake.calls[0]).not.toHaveProperty('sessionStorageState');
    expect(manager.status().sessionNote).toBeDefined();
  });

  it('does not save the session when the recording ends in error', async () => {
    const { manager, fake, sessions } = setup();
    manager.start({ ...input, reuseSession: true });
    await settled();
    fake.steps = 1;
    await fake.captureSession({ cookies: [] });
    fake.fail(new Error('boom'));
    await settled();
    expect(manager.status().state).toBe('error');
    expect(sessions.saves).toEqual([]);
  });

  it('keeps done and adds a note when the session cannot be saved', async () => {
    const { manager, fake, sessions } = setup();
    sessions.failSave = true;
    manager.start({ ...input, reuseSession: true });
    await settled();
    fake.steps = 1;
    await fake.captureSession({ cookies: [] });
    manager.stop();
    await settled();
    expect(manager.status().state).toBe('done');
    expect(manager.status().sessionNote).toBeDefined();
  });

  it('close() aborts a recording and resolves once the session has ended', async () => {
    const { manager, fake } = setup();
    manager.start(input);
    fake.steps = 1;
    await manager.close();
    expect(manager.isActive()).toBe(false);
    expect(manager.status().state).toBe('done');
  });

  it('close() closes the browser when the session does not end before the deadline', async () => {
    const { manager, fake } = setup({ closeDeadlineMs: 30 });
    fake.endOnAbort = false;
    manager.start(input);
    await manager.close();
    expect(fake.browserClosed).toBe(true);
  });

  it('removes known secret values from labels and errors', async () => {
    const { manager, fake } = setup({ scrub: (t) => t.split('synthetic-secret-value').join('***') });
    manager.start(input);
    fake.steps = 1;
    fake.labels = ['Type synthetic-secret-value'];
    expect(manager.status().labels).toEqual(['Type ***']);
    fake.fail(new Error('failed with synthetic-secret-value'));
    await settled();
    expect(manager.status().error).not.toContain('synthetic-secret-value');
  });
});
