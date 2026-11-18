// Feature: kiro-thin-extension, Property 7: The first stdout line decides the handshake
// **Validates: Requirements 5.4, 5.5**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createProcessManager, StartError } from '../../../kiro-extension/src/core/process-manager';
import { createHarness, flush, handshakeLine, TOKEN } from './helpers/fake-process';

const laterLines = fc.array(fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, ' ')), { maxLength: 4 });
const invalidFirst = fc.oneof(
  fc.constantFrom('', 'hello', '{}', '[]', 'null', '{"origin":"http://evil.com:5","token":"abcdefghijklmnopqrstuvwxyz012345","pid":1}', '{"origin":"http://127.0.0.1:5000","token":"short","pid":1}', '{"origin":"http://127.0.0.1:5000","token":"abcdefghijklmnopqrstuvwxyz012345","pid":0}'),
  fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, ' '))
).filter((line) => {
  try {
    const v = JSON.parse(line);
    return !(v && typeof v === 'object' && 'origin' in v && 'token' in v && 'pid' in v && String(v.origin).startsWith('http://127.0.0.1:') && v.token === TOKEN && v.pid > 0);
  } catch {
    return true;
  }
});

describe('Property 7: first stdout line', () => {
  it('a valid first line gives a running session and later lines change nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 65535 }).filter((n) => n !== 80), fc.integer({ min: 1, max: 9999 }), laterLines, fc.integer({ min: 1, max: 20 }), async (port, pid, later, cut) => {
        const h = createHarness();
        const manager = createProcessManager(h.deps);
        const started = manager.ensureStarted();
        await flush();
        const child = h.children[0]!;
        const first = handshakeLine(port, pid);
        child.emitStdout(first.slice(0, cut));
        child.emitStdout(first.slice(cut) + later.join('\n') + (later.length > 0 ? '\n' : ''));
        const session = await started;
        expect(session.origin).toBe(`http://127.0.0.1:${port}`);
        expect(session.pid).toBe(pid);
        expect(manager.state).toBe('running');
        child.emitStdout('{"origin":"http://127.0.0.1:1","token":"zzzzzzzzzzzzzzzzzzzzzzzz","pid":2}\n');
        expect(manager.session).toBe(session);
        expect(h.stderrLines).toEqual([]);
        expect(h.clientsCreated).toHaveLength(1);
        expect(h.killed).toEqual([]);
      }),
      { numRuns: 120 }
    );
  });

  it('an invalid first line kills the child and creates no client', async () => {
    await fc.assert(
      fc.asyncProperty(invalidFirst, laterLines, async (first, later) => {
        const h = createHarness();
        const manager = createProcessManager(h.deps);
        const started = manager.ensureStarted();
        const outcome = started.then(() => undefined, (e: unknown) => e);
        await flush();
        const child = h.children[0]!;
        child.emitStdout(`${first}\n${later.join('\n')}\n`);
        const error = await outcome;
        expect(error).toBeInstanceOf(StartError);
        expect((error as StartError).reason).toBe('handshake-invalid');
        expect(manager.state).not.toBe('running');
        expect(h.killed).toEqual([child.pid]);
        expect(h.clientsCreated).toHaveLength(0);
        expect(manager.session).toBeUndefined();
      }),
      { numRuns: 120 }
    );
  });
});

describe('process manager start examples', () => {
  it('spawns without a shell, hidden, in the workspace folder, with the documented arguments and an untouched environment', async () => {
    const h = createHarness({ env: { PATH: '/bin', KEEP: '1' } });
    const manager = createProcessManager(h.deps);
    const started = manager.ensureStarted();
    await flush();
    h.children[0]!.emitStdout(handshakeLine());
    await started;
    const call = h.spawnCalls[0]!;
    expect(call.command).toBe('node');
    expect(call.args).toEqual(['cli.js', 'studio', '--machine']);
    expect(call.options).toMatchObject({ cwd: '/ws', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    expect(call.options.env).toEqual({ PATH: '/bin', KEEP: '1' });
  });

  it('adds only the locator extra environment and is not detached on Windows', async () => {
    const h = createHarness({
      platform: 'win32',
      locate: async () => ({ kind: 'ok', command: 'k.exe', baseArgs: ['c.js'], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, cliFile: 'c.js', usedElectronNode: true }),
    });
    const manager = createProcessManager(h.deps);
    const started = manager.ensureStarted();
    await flush();
    h.children[0]!.emitStdout(handshakeLine());
    await started;
    expect(h.spawnCalls[0]!.options.detached).toBe(false);
    expect(h.spawnCalls[0]!.options.env).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('reports old-cli when the child exits with the unknown option message, and exited-early otherwise', async () => {
    const h = createHarness();
    const manager = createProcessManager(h.deps);
    const p1 = manager.ensureStarted().catch((e: unknown) => e);
    await flush();
    h.children[0]!.emitStderr("error: unknown option '--machine'\n");
    h.children[0]!.emitExit(1);
    expect((await p1 as StartError).reason).toBe('old-cli');
    const p2 = manager.ensureStarted().catch((e: unknown) => e);
    await flush();
    h.children[1]!.emitExit(1);
    expect((await p2 as StartError).reason).toBe('exited-early');
  });

  it('shares one pending start and passes stderr lines to onStderr', async () => {
    const h = createHarness();
    const manager = createProcessManager(h.deps);
    const a = manager.ensureStarted();
    const b = manager.ensureStarted();
    await flush();
    h.children[0]!.emitStderr('one\ntwo\n');
    h.children[0]!.emitStdout(handshakeLine());
    expect(await a).toBe(await b);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.stderrLines).toEqual(['one', 'two']);
  });

  it('reports no-folder and locator failures', async () => {
    const none = createProcessManager(createHarness({ workspaceFolder: () => undefined }).deps);
    await expect(none.ensureStarted()).rejects.toMatchObject({ reason: 'no-folder' });
    const missing = createProcessManager(createHarness({ locate: async () => ({ kind: 'not-found' }) }).deps);
    await expect(missing.ensureStarted()).rejects.toMatchObject({ reason: 'locator' });
    expect(missing.state).toBe('stopped');
  });
});
