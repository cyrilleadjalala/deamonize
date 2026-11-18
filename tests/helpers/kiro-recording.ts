import { createRecordingManager } from '../../src/studio/recording-manager.js';
import type { PowerInstaller, StartInput } from '../../src/studio/contracts.js';
import { FakeCompiler, FakeRecord, MemorySessions } from './fake-record.js';

const input: StartInput = { name: 'Find order', url: 'https://shop.test/start', reuseSession: false };
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Runs one fake Studio recording that ends with the given end-sheet answer (G-E test helper; FakeRecord has no finishScope). */
export interface PowerOptions {
  homeAtStart?: boolean;
  homeAtInstall?: boolean;
  infoFails?: 'always' | 'first';
  installAnswer?: unknown;
  installFails?: string;
}

/** A recorder fake that also exposes `finishScope` (the shared FakeRecord helper has no such field). */
export async function runKiroRecording(finishScope: unknown, over: PowerOptions = {}, intent: 'save' | 'test' | 'kiro' = 'kiro') {
  const fake = new FakeRecord();
  const previews: unknown[] = [];
  const installs: unknown[] = [];
  let infoCalls = 0;
  const power: Pick<PowerInstaller, 'info' | 'preview' | 'install'> = {
    info: async () => {
      infoCalls++;
      if (over.infoFails === 'always' || (over.infoFails === 'first' && infoCalls === 1)) throw new Error('no info');
      return { kiroHomeExists: infoCalls === 1 ? (over.homeAtStart ?? true) : (over.homeAtInstall ?? over.homeAtStart ?? true) } as never;
    },
    preview: async (request) => {
      previews.push(request.scope);
      return { confirmationId: 'c1', kiroPath: '/home/.kiro' } as never;
    },
    install: async (request) => {
      installs.push(request.scope);
      if (over.installFails !== undefined) throw new Error(over.installFails);
      return (over.installAnswer ?? {}) as never;
    },
  };
  const record: typeof fake.fn = (options) =>
    fake.fn({
      ...options,
      onLive: (live) =>
        options.onLive({
          get stepCount() { return live.stepCount; },
          get finishIntent() { return live.finishIntent; },
          get finishScope() { return finishScope as 'global' | 'project'; },
          panelState: () => live.panelState(),
        }),
    });
  const manager = createRecordingManager({
    workflowFile: '/work/daemonize.workflows.json',
    sessions: new MemorySessions(),
    compiler: new FakeCompiler(),
    scrub: (t) => t,
    record,
    power,
  });
  manager.start(input);
  await settled();
  fake.steps = 2;
  fake.intent = intent;
  fake.end('panel');
  fake.succeed();
  await settled();
  return { manager, fake, previews, installs, kiroHomeAtStart: fake.calls[0]?.kiroHomeExists };
}
