import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaygroundSession, type ConnectFn, type LaunchSpec } from '../../src/studio/playground.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import type { AppData } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';

const APP_A = 'https://a.example';
const APP_B = 'https://b.example';
const dirs: string[] = [];
const sessions: PlaygroundSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(env: Record<string, string>, key: string | undefined, vaultValues: { generic?: string; scoped?: string; other?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-pse-'));
  dirs.push(dir);
  const appData: AppData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
  let k: Buffer | undefined;
  const provider: KeyProvider = { id: 'mem', get: async () => k, create: async (b) => void (k = b) };
  const vault = createSecretVault({ appData, keyProvider: provider });
  if (vaultValues.generic !== undefined) await vault.set('CRM', vaultValues.generic);
  if (vaultValues.scoped !== undefined) await vault.setFor(APP_A, 'CRM', vaultValues.scoped);
  if (vaultValues.other !== undefined) await vault.setFor(APP_B, 'CRM', vaultValues.other);
  const specs: LaunchSpec[] = [];
  const connect: ConnectFn = async (spec) => {
    specs.push(spec);
    return {
      client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) },
      onClose: () => undefined,
      close: async () => undefined,
      stderrTail: () => '',
    };
  };
  const session = new PlaygroundSession({
    outDir: () => dir,
    applicationKey: () => key,
    env,
    connect,
    launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv: {}, cwd: dir }),
    vault,
    requiredSecretNames: async () => ['CRM'],
    healSupport: false,
  });
  sessions.push(session);
  await session.listTools();
  return { env: specs[0].env, session };
}

describe('playground secret precedence', () => {
  it('environment wins over scoped and generic', async () => {
    const { env } = await setup({ DAEMONIZE_SECRET_CRM: 'from-env' }, APP_A, { generic: 'generic-v', scoped: 'scoped-v' });
    expect(env.DAEMONIZE_SECRET_CRM).toBe('from-env');
  });

  it('scoped wins over generic when the environment has none', async () => {
    const { env } = await setup({}, APP_A, { generic: 'generic-v', scoped: 'scoped-v' });
    expect(env.DAEMONIZE_SECRET_CRM).toBe('scoped-v');
  });

  it('an unexpanded placeholder or an empty value in the environment is ignored', async () => {
    const placeholder = await setup({ DAEMONIZE_SECRET_CRM: '${DAEMONIZE_SECRET_CRM}' }, APP_A, { scoped: 'scoped-v' });
    expect(placeholder.env.DAEMONIZE_SECRET_CRM).toBe('scoped-v');
    const empty = await setup({ DAEMONIZE_SECRET_CRM: '' }, APP_A, { generic: 'generic-v' });
    expect(empty.env.DAEMONIZE_SECRET_CRM).toBe('generic-v');
  });

  it('uses the active application key: another application scoped value is never given', async () => {
    const { env } = await setup({}, APP_B, { generic: 'generic-v', scoped: 'scoped-a' });
    expect(env.DAEMONIZE_SECRET_CRM).toBe('generic-v');
    const none = await setup({}, APP_B, { scoped: 'scoped-a' });
    expect(none.env).not.toHaveProperty('DAEMONIZE_SECRET_CRM');
  });

  it('without an application key only generic values are given', async () => {
    const { env } = await setup({}, undefined, { generic: 'generic-v', scoped: 'scoped-v' });
    expect(env.DAEMONIZE_SECRET_CRM).toBe('generic-v');
  });

  it('configuredSecretVariables follows the active application', async () => {
    const a = await setup({}, APP_A, { scoped: 'scoped-v' });
    expect((await a.session.configuredSecretVariables()).has('DAEMONIZE_SECRET_CRM')).toBe(true);
    const b = await setup({}, APP_B, { scoped: 'scoped-v' });
    expect((await b.session.configuredSecretVariables()).has('DAEMONIZE_SECRET_CRM')).toBe(false);
  });
});
