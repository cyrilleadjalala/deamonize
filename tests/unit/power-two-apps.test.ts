import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withResolvedSecrets } from '../../src/replay/runtime/vault-reader.js';
import { createKeyProvider } from '../../src/studio/key-providers.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { createHarness, fullInstall, type Harness } from '../helpers/power-fixture.js';

const KEY_A = 'https://alpha.example';
const KEY_B = 'https://beta.example:8443';
const SLUG_A = 'alpha-example';
const SLUG_B = 'beta-example-8443';

describe('two applications with the same Secret_Name (global scope)', () => {
  let a: Harness;
  let b: Harness;
  beforeEach(async () => {
    // Same fake home and same App_Data_Dir: both harnesses share one base folder
    const first = await createHarness({ slug: SLUG_A, applicationKey: KEY_A });
    const dir = first.appDir;
    await mkdir(dir, { recursive: true });
    const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', NODE_ENV: 'test' };
    const vault = createSecretVault({
      appData: { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) },
      keyProvider: createKeyProvider({ dataDir: dir, env }),
    });
    await vault.setFor(KEY_A, 'PASSWORD', 'password-of-alpha');
    await vault.setFor(KEY_B, 'PASSWORD', 'password-of-beta');
    a = await createHarness({ base: first.base, slug: SLUG_A, applicationKey: KEY_A, vault });
    b = await createHarness({ base: first.base, slug: SLUG_B, applicationKey: KEY_B, vault });
  });
  afterEach(async () => {
    await a.cleanup();
  });

  it('gives different slugs, skill folders and Server_Entries, and the reader resolves different passwords', async () => {
    await fullInstall(a, 'global');
    await fullInstall(b, 'global');
    const root = JSON.parse(await readFile(join(a.kiroGlobal, 'settings', 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    expect(Object.keys(root.mcpServers)).toEqual([SLUG_A, SLUG_B]);
    expect((await readdir(join(a.kiroGlobal, 'skills'))).sort()).toEqual([SLUG_A, SLUG_B]);
    const entryA = root.mcpServers[SLUG_A]!;
    const entryB = root.mcpServers[SLUG_B]!;
    expect(entryA.args).not.toEqual(entryB.args);
    expect(entryA.env.DAEMONIZE_APP_KEY).toBe(KEY_A);
    expect(entryB.env.DAEMONIZE_APP_KEY).toBe(KEY_B);
    // The stored name has no placeholder, the other required name still has one
    expect(entryA.env.DAEMONIZE_SECRET_PASSWORD).toBeUndefined();
    expect(entryA.env.DAEMONIZE_SECRET_TOTP).toBe('${DAEMONIZE_SECRET_TOTP}');

    const resolve = async (env: Record<string, string>) =>
      (await withResolvedSecrets({ ...env, DAEMONIZE_VAULT_KEY_PROVIDER: 'file', NODE_ENV: 'test' }, ['DAEMONIZE_SECRET_PASSWORD'])).DAEMONIZE_SECRET_PASSWORD;
    expect(await resolve(entryA.env)).toBe('password-of-alpha');
    expect(await resolve(entryB.env)).toBe('password-of-beta');

    // Neither password is written in any Kiro file
    for (const file of [join(a.kiroGlobal, 'settings', 'mcp.json'), join(a.kiroGlobal, 'skills', SLUG_A, 'SKILL.md'), join(a.kiroGlobal, 'skills', SLUG_B, 'SKILL.md')]) {
      const text = await readFile(file, 'utf-8');
      expect(text).not.toContain('password-of-');
    }
  });

  it('removing one application keeps the other', async () => {
    await fullInstall(a, 'global');
    await fullInstall(b, 'global');
    await a.installer.remove({ scope: 'global' });
    const root = JSON.parse(await readFile(join(a.kiroGlobal, 'settings', 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(root.mcpServers)).toEqual([SLUG_B]);
    expect(await readdir(join(a.kiroGlobal, 'skills'))).toEqual([SLUG_B]);
    expect((await b.records.list()).map((r) => r.slug)).toEqual([SLUG_B]);
  });
});
