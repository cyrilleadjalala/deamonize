// Feature: kiro-thin-extension, Property 11: The process manager keeps at most one live process and never restarts alone
// **Validates: Requirements 8.3, 8.5, 8.9, 8.11, 8.12, 8.15**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createProcessManager, type StudioSession } from '../../../kiro-extension/src/core/process-manager';
import type { ProcessState } from '../../../kiro-extension/src/core/types';
import { createHarness, flush, handshakeLine } from './helpers/fake-process';

type Event =
  | { kind: 'ensure'; callers: number }
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'handshake' }
  | { kind: 'exit-unrequested' }
  | { kind: 'markStale' };

const event: fc.Arbitrary<Event> = fc.oneof(
  fc.integer({ min: 1, max: 3 }).map((callers) => ({ kind: 'ensure' as const, callers })),
  fc.constant({ kind: 'restart' as const }),
  fc.constant({ kind: 'stop' as const }),
  fc.constant({ kind: 'handshake' as const }),
  fc.constant({ kind: 'exit-unrequested' as const }),
  fc.constant({ kind: 'markStale' as const })
);
const STATES: ProcessState[] = ['stopped', 'starting', 'running', 'crashed'];

describe('Property 11: process manager model', () => {
  it('keeps at most one live child, shares pending starts, crashes on unrequested exit and never restarts alone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(event, { minLength: 1, maxLength: 25 }), async (events) => {
        const h = createHarness();
        const manager = createProcessManager(h.deps);
        let restartOpen = 0;
        const shaken = new Set<number>();
        for (const ev of events) {
          const spawnsBefore = h.spawnCalls.length;
          const stateBefore = manager.state;
          if (ev.kind === 'ensure') {
            const sessions: Array<StudioSession | undefined> = [];
            const calls = Array.from({ length: ev.callers }, () => manager.ensureStarted().then((s) => void sessions.push(s as StudioSession), () => undefined));
            await flush();
            if (restartOpen === 0) expect(h.spawnCalls.length - spawnsBefore).toBeLessThanOrEqual(1);
            const live = h.live()[0];
            if (live !== undefined && manager.state === 'starting' && !shaken.has(live.pid)) {
              // one pending start: every caller is still waiting on the same process
              expect(sessions).toHaveLength(0);
            }
            void calls;
          } else if (ev.kind === 'restart') {
            restartOpen += 1;
            void manager.restart().then(() => void (restartOpen -= 1), () => void (restartOpen -= 1));
            await flush();
          } else if (ev.kind === 'stop') {
            await manager.stop();
            await flush();
            if (restartOpen === 0) {
              expect(manager.state).toBe('stopped');
              expect(h.live()).toHaveLength(0);
            }
          } else if (ev.kind === 'handshake') {
            const child = h.live().find((c) => !shaken.has(c.pid));
            if (child !== undefined && manager.state === 'starting') {
              shaken.add(child.pid);
              child.emitStdout(handshakeLine(5000 + h.children.indexOf(child), 7));
              await flush();
            }
          } else if (ev.kind === 'exit-unrequested') {
            const child = h.live()[0];
            if (child !== undefined) {
              const wasRunning = manager.state === 'running';
              child.emitExit(1);
              await flush();
              if (wasRunning && restartOpen === 0) {
                expect(manager.state).toBe('crashed');
                expect(manager.session).toBeUndefined();
              }
              // no automatic restart, whatever the state was
              if (restartOpen === 0) expect(h.spawnCalls.length).toBe(spawnsBefore);
            }
          } else {
            manager.markStale();
            await flush();
            if (restartOpen === 0) expect(h.spawnCalls.length).toBe(spawnsBefore);
          }
          expect(h.live().length).toBeLessThanOrEqual(1);
          expect(STATES).toContain(manager.state);
          if (manager.state === 'crashed') expect(stateBefore === 'running' || stateBefore === 'crashed').toBe(true);
          if (manager.state === 'running') expect(manager.session).toBeDefined();
          if (restartOpen === 0 && ev.kind !== 'ensure' && ev.kind !== 'restart' && ev.kind !== 'handshake' && ev.kind !== 'stop') {
            expect(h.spawnCalls.length).toBe(spawnsBefore);
          }
        }
      }),
      { numRuns: 120 }
    );
  });

  it('callers of one pending start receive the same session and one spawn', async () => {
    const h = createHarness();
    const manager = createProcessManager(h.deps);
    const all = [manager.ensureStarted(), manager.ensureStarted(), manager.ensureStarted()];
    await flush();
    h.children[0]!.emitStdout(handshakeLine());
    const sessions = await Promise.all(all);
    expect(new Set(sessions).size).toBe(1);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('a requested stop ends in stopped, an unrequested exit in crashed, and a crashed manager restarts only on request', async () => {
    const h = createHarness();
    const manager = createProcessManager(h.deps);
    const states: ProcessState[] = [];
    manager.onDidChangeState((s) => states.push(s));
    let p = manager.ensureStarted();
    await flush();
    h.children[0]!.emitStdout(handshakeLine());
    await p;
    h.children[0]!.emitExit(3);
    await flush();
    expect(manager.state).toBe('crashed');
    expect(h.spawnCalls).toHaveLength(1);
    p = manager.restart();
    await flush();
    h.children[1]!.emitStdout(handshakeLine());
    await p;
    await manager.stop();
    expect(manager.state).toBe('stopped');
    expect(h.killed).toContain(h.children[1]!.pid);
    expect(states).toEqual(['starting', 'running', 'crashed', 'stopped', 'starting', 'running', 'stopped']);
  });

  it('markStale makes the next ensureStarted start a new process and stop the old one', async () => {
    const h = createHarness();
    const manager = createProcessManager(h.deps);
    let p = manager.ensureStarted();
    await flush();
    h.children[0]!.emitStdout(handshakeLine());
    const first = await p;
    manager.markStale();
    p = manager.ensureStarted();
    await flush();
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.exited).toBe(true);
    h.children[1]!.emitStdout(handshakeLine(6000));
    expect(await p).not.toBe(first);
  });
});
