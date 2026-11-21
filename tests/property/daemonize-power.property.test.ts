// Feature: kiro-native-agent-and-firewall, Property 36: Installing the Daemonize Power and removing it restores the settings
import { afterAll, beforeAll, describe, it } from 'vitest';
import fc from 'fast-check';
import { expect } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonizePower } from '../../src/studio/daemonize-power.js';
import { createInstallRecords } from '../../src/studio/install-records.js';
import type { AppData } from '../../src/studio/contracts.js';
import { removeDir } from '../helpers/cleanup.js';

const SOURCE_MCP = { mcpServers: { 'daemonize-studio': { type: 'stdio', command: 'daemonize', args: ['mcp'], env: { DAEMONIZE_MODE: 'strict' } } } };

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-power-prop-'));
  const power = join(root, 'power');
  await mkdir(join(power, 'steering'), { recursive: true });
  await mkdir(join(power, 'skills', 'daemonize-builder'), { recursive: true });
  await mkdir(join(power, 'agents'), { recursive: true });
  await writeFile(join(power, 'mcp.json'), JSON.stringify(SOURCE_MCP));
  await writeFile(join(power, 'steering', 'rules.md'), '# Rules\n');
  await writeFile(join(power, 'skills', 'daemonize-builder', 'SKILL.md'), 'Skill\n');
  await writeFile(join(power, 'agents', 'daemonize.md'), 'Agent\n');
});
afterAll(async () => {
  await removeDir(root);
});

const serverName = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/).filter((n) => n !== 'daemonize-studio' && n !== '__proto__');
const otherServer = fc.record({
  type: fc.constant('stdio'),
  command: fc.stringMatching(/^[a-z]{1,8}$/),
  args: fc.array(fc.stringMatching(/^[a-zA-Z0-9./_-]{0,12}$/), { maxLength: 3 }),
});
/** The existing Kiro settings: absent, or an object with other servers and other keys, in any layout. */
const settings = fc.option(
  fc.record({
    servers: fc.option(fc.dictionary(serverName, otherServer, { maxKeys: 4 }), { nil: undefined }),
    extra: fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/).filter((k) => k !== 'mcpServers' && k !== '__proto__'), fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean()), { maxKeys: 3 }),
    indent: fc.constantFrom<number | string>(0, 2, 4, '\t'),
    newline: fc.boolean(),
    bom: fc.boolean(),
  }),
  { nil: undefined }
);

describe('Daemonize Power round trip', () => {
  it('Property 36: Installing the Daemonize Power and removing it restores the settings', async () => {
    // **Validates: Requirements 25.3, 25.5, 25.8, 25.11**
    await fc.assert(
      fc.asyncProperty(settings, fc.constantFrom('global' as const, 'project' as const), fc.constantFrom('power' as const, 'agent' as const), async (existing, scope, parts) => {
        const dir = join(root, `r${counter++}`);
        const home = join(dir, 'home');
        const ws = join(dir, 'ws');
        const data = join(dir, 'data');
        await mkdir(home, { recursive: true });
        await mkdir(ws, { recursive: true });
        await mkdir(data, { recursive: true });
        const base = scope === 'global' ? home : ws;
        const mcp = join(base, '.kiro', 'settings', 'mcp.json');
        let original: string | undefined;
        if (existing !== undefined) {
          const root$: Record<string, unknown> = { ...existing.extra };
          if (existing.servers !== undefined) root$.mcpServers = existing.servers;
          original = (existing.bom ? '\ufeff' : '') + JSON.stringify(root$, null, existing.indent) + (existing.newline ? '\n' : '');
          await mkdir(join(base, '.kiro', 'settings'), { recursive: true });
          await writeFile(mcp, original);
        }
        const appData = { dir: data, check: async () => ({ ok: true, dir: data }), ensure: async () => ({ ok: true, dir: data }) } as unknown as AppData;
        const installer = createDaemonizePower({
          cwd: ws, home, appData, env: {}, powerDir: join(root, 'power'), program: { command: 'node', args: ['/pkg/cli/index.js'] }, records: createInstallRecords({ appData }),
        });
        const plan = await installer.preview({ scope, parts, ...(scope === 'project' ? { workspacePath: ws } : {}) });
        const done = await installer.install({ confirmationId: plan.confirmationId, kiroPath: plan.kiroPath, scope });
        expect(done.alreadyInstalled).toBe(false);
        const installed = JSON.parse((await readFile(mcp, 'utf-8')).replace(/^\ufeff/, ''));
        expect(installed.mcpServers['daemonize-studio']).toBeDefined();
        // Other servers are untouched by the install
        for (const [name, value] of Object.entries(existing?.servers ?? {})) expect(installed.mcpServers[name]).toEqual(value);

        await installer.remove({ scope, parts });
        if (original === undefined) await expect(lstat(mcp)).rejects.toThrow();
        else expect(await readFile(mcp, 'utf-8')).toBe(original);
        await expect(lstat(join(base, '.kiro', 'agents', 'daemonize.md'))).rejects.toThrow();
        await expect(lstat(join(base, '.kiro', 'skills', 'daemonize-builder', 'SKILL.md'))).rejects.toThrow();
        // Nothing was written outside the chosen Kiro folder
        await expect(lstat(join(scope === 'global' ? ws : home, '.kiro'))).rejects.toThrow();
      }),
      { numRuns: 100 }
    );
  }, 120000);
});
