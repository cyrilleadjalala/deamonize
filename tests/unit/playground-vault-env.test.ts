import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaygroundSession, type ConnectFn, type LaunchSpec } from '../../src/studio/playground.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import type { AppData } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';

const PLANTED = 'Planted-Child-Value-5a7e';
const dirs: string[] = [];
const sessions: PlaygroundSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'daemonize-pve-'));
  dirs.push(d);
  return d;
}
function provider(): KeyProvider {
  let key: Buffer | undefined;
  return { id: 'mem', get: async () => key, create: async (k) => void (key = k) };
}
const appData = (dir: string): AppData => ({ dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) });

function fake(answer: Record<string, unknown> = { success: true, text: 'ok' }) {
  const specs: LaunchSpec[] = [];
  const connect: ConnectFn = async (spec) => {
    specs.push(spec);
    return {
      client: {
        listTools: async () => ({ tools: [{ name: 'login', description: '', inputSchema: { type: 'object', properties: { user: { type: 'string' } } } }] }),
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(answer) }] }),
      },
      onClose: () => undefined,
      close: async () => undefined,
      stderrTail: () => '',
    };
  };
  return { specs, connect };
}

describe('playground with the vault', () => {
  // Precedence reversed on purpose (kiro-global-connect-vault-bridge, Req 6.7 / 7.12): an explicit, non-empty environment value
  // (not a ${...} placeholder) wins over the vault, so what a user sets by hand is never silently replaced.
  it('gives the environment value to the child over the vault and mcp.json values, and the vault value only when there is none', async () => {
    const data = await tempDir();
    const vault = createSecretVault({ appData: appData(data), keyProvider: provider() });
    await vault.set('CRM', PLANTED);
    const { specs, connect } = fake();
    await vault.set('ONLYVAULT', 'vault-only-value');
    const studioEnv = { DAEMONIZE_SECRET_CRM: 'studio-value', daemonize_secret_crm: 'lower-case-value' };
    const before = JSON.stringify(process.env);
    const session = new PlaygroundSession({
      outDir: data,
      env: studioEnv,
      connect,
      launch: () => ({ command: process.execPath, args: ['server.js'], mcpEnv: { DAEMONIZE_SECRET_CRM: 'mcp-literal' }, cwd: data }),
      vault,
      requiredSecretNames: async () => ['CRM', 'ONLYVAULT'],
      healSupport: false,
    });
    sessions.push(session);
    await session.listTools();
    const env = specs[0].env;
    expect(env.DAEMONIZE_SECRET_CRM).toBe('studio-value');
    expect(env.DAEMONIZE_SECRET_ONLYVAULT).toBe('vault-only-value');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'DAEMONIZE_SECRET_CRM')).toEqual(['DAEMONIZE_SECRET_CRM']);
    expect(JSON.stringify(specs[0].args)).not.toContain(PLANTED);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(studioEnv.DAEMONIZE_SECRET_CRM).toBe('studio-value');
  });

  it('does not pass vault names the workflows do not require', async () => {
    const data = await tempDir();
    const vault = createSecretVault({ appData: appData(data), keyProvider: provider() });
    await vault.set('OLD', PLANTED);
    const { specs, connect } = fake();
    const session = new PlaygroundSession({ outDir: data, env: {}, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv: {}, cwd: data }), vault, requiredSecretNames: async () => ['CRM'] });
    sessions.push(session);
    await session.listTools();
    expect(specs[0].env).not.toHaveProperty('DAEMONIZE_SECRET_OLD');
  });

  it('starts no process when the vault file cannot be read', async () => {
    const data = await tempDir();
    const vault = createSecretVault({ appData: appData(data), keyProvider: provider() });
    await vault.set('CRM', PLANTED);
    // Same file, a provider that has no key
    const lost = createSecretVault({ appData: appData(data), keyProvider: provider() });
    const { specs, connect } = fake();
    const session = new PlaygroundSession({ outDir: data, env: {}, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv: {}, cwd: data }), vault: lost, requiredSecretNames: async () => ['CRM'] });
    sessions.push(session);
    const outcome = await session.call({ tool: 'login', arguments: {}, confirm: true });
    expect(outcome.status).toBe(503);
    expect(String(outcome.body.message)).toMatch(/credentials/i);
    expect(specs).toHaveLength(0);
  });

  it('scrubs the vault value from an answer and keeps it out of the call history', async () => {
    const data = await tempDir();
    const vault = createSecretVault({ appData: appData(data), keyProvider: provider() });
    await vault.set('CRM', PLANTED);
    await vault.snapshot();
    const { connect } = fake({ success: true, text: `echo ${PLANTED}`, error: `bad ${PLANTED}` });
    const session = new PlaygroundSession({ outDir: data, env: {}, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv: {}, cwd: data }), vault, requiredSecretNames: async () => ['CRM'], toolMeta: () => ({ risk: 'read', sensitiveArgs: [] }) });
    sessions.push(session);
    const outcome = await session.call({ tool: 'login', arguments: { user: PLANTED } });
    expect(JSON.stringify(outcome.body)).not.toContain(PLANTED);
    expect(JSON.stringify(session.history())).not.toContain(PLANTED);
  });

  it('writes the value into no file of the output folder', async () => {
    const data = await tempDir();
    const out = await tempDir();
    await writeFile(join(out, 'mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'node', args: ['mcp-server.js'], env: { DAEMONIZE_SECRET_CRM: '${DAEMONIZE_SECRET_CRM}' } } } }));
    await writeFile(join(out, 'mcp-server.js'), '// server');
    const vault = createSecretVault({ appData: appData(data), keyProvider: provider() });
    await vault.set('CRM', PLANTED);
    const { connect } = fake();
    const session = new PlaygroundSession({ outDir: out, env: {}, connect, vault, requiredSecretNames: async () => ['CRM'] });
    sessions.push(session);
    await session.listTools();
    for (const name of await readdir(out)) expect(await readFile(join(out, name), 'utf-8')).not.toContain(PLANTED);
  });

  it('stopNow ends the running server at once', async () => {
    const data = await tempDir();
    const { connect } = fake();
    const session = new PlaygroundSession({ outDir: data, env: {}, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv: {}, cwd: data }) });
    sessions.push(session);
    await session.listTools();
    expect(session.serverStarted).toBe(true);
    await session.stopNow();
    expect(session.serverStarted).toBe(false);
  });
});
