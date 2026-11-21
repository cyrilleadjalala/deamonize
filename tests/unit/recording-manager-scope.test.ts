import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices } from '../../src/studio/services.js';
import { FakeCompiler, FakeRecord } from '../helpers/fake-record.js';
import { removeDir } from '../helpers/cleanup.js';
import { SERVER, writeCompiledOutput } from '../helpers/power-fixture.js';
import { runKiroRecording } from '../helpers/kiro-recording.js';

describe('Recording_Manager: the scope of "Save and add to Kiro" (Requirements 19.8 to 19.13)', () => {
  it('uses global for both preview and install when chosen and the home folder exists', async () => {
    const r = await runKiroRecording('global');
    expect(r.previews).toEqual(['global']);
    expect(r.previewRequests).toEqual([{ scope: 'global' }]);
    expect(r.installs).toEqual(['global']);
    expect(r.manager.status().kiro).toMatchObject({ added: true, scope: 'global' });
  });

  it('uses project for both when chosen and passes workspacePath to preview', async () => {
    const r = await runKiroRecording('project');
    expect(r.previews).toEqual(['project']);
    expect(r.previewRequests).toEqual([{ scope: 'project', workspacePath: '/work' }]);
    expect(r.installs).toEqual(['project']);
    expect(r.manager.status().kiro?.scope).toBe('project');
  });

  it('uses explicit workspacePath for project scope and omits it for global scope', async () => {
    const projectRun = await runKiroRecording('project', {
      workspacePath: '/custom/project',
      workflowFile: '/other/daemonize.workflows.json',
    });
    expect(projectRun.previewRequests).toEqual([{ scope: 'project', workspacePath: '/custom/project' }]);
    expect(projectRun.installs).toEqual(['project']);

    const globalRun = await runKiroRecording('global', {
      workspacePath: '/custom/project',
      homeAtStart: true,
      homeAtInstall: true,
    });
    expect(globalRun.previewRequests).toEqual([{ scope: 'global' }]);
  });

  it('falls back from global to project when the home folder is gone at install time', async () => {
    const r = await runKiroRecording('global', { homeAtStart: true, homeAtInstall: false });
    expect(r.previewRequests).toEqual([{ scope: 'project', workspacePath: '/work' }]);
    expect(r.installs).toEqual(['project']);
    expect(r.manager.status().kiro?.scope).toBe('project');
  });

  it('passes workspacePath when ~/.kiro does not exist and resolveInstallScope picks project', async () => {
    const undefRun = await runKiroRecording(undefined, { homeAtStart: false });
    expect(undefRun.previewRequests).toEqual([{ scope: 'project', workspacePath: '/work' }]);
    expect(undefRun.installs).toEqual(['project']);

    const globalChosenRun = await runKiroRecording('global', { homeAtStart: false });
    expect(globalChosenRun.previewRequests).toEqual([{ scope: 'project', workspacePath: '/work' }]);
    expect(globalChosenRun.installs).toEqual(['project']);
  });

  it('keeps today\'s default when no valid scope exists', async () => {
    expect((await runKiroRecording(undefined)).installs).toEqual(['global']);
    expect((await runKiroRecording('everywhere', { homeAtStart: false })).installs).toEqual(['project']);
  });

  it('counts a failure of power.info at the start as no home folder', async () => {
    const r = await runKiroRecording('global', { infoFails: 'first' });
    expect(r.kiroHomeAtStart).toBe(false);
    expect(r.installs).toEqual(['global']);
  });

  it('passes kiroHomeExists to record()', async () => {
    expect((await runKiroRecording('project', { homeAtStart: true })).kiroHomeAtStart).toBe(true);
    expect((await runKiroRecording('project', { homeAtStart: false })).kiroHomeAtStart).toBe(false);
  });

  it('leaves scope and the arrays out when the install fails, and stays done without leaking paths or secrets', async () => {
    const masked = ['synthetic', 'private', 'val-xyz'].join('-');
    const r = await runKiroRecording('project', {
      workspacePath: 'C:\\private\\project',
      previewFails: `Cannot write C:\\private\\project\\.kiro with ${masked}`,
      scrub: (t) => t.split(masked).join('***'),
    });
    const status = r.manager.status();
    expect(status.state).toBe('done');
    expect(status.kiro?.added).toBe(false);
    expect(status.kiro?.message).not.toContain('C:\\private');
    expect(status.kiro?.message).not.toContain(masked);
    expect(status.kiro).not.toHaveProperty('scope');
    expect(status.kiro).not.toHaveProperty('missingSecrets');
    expect(status.kiro).not.toHaveProperty('requiredSecrets');
  });

  it('ignores the scope for other intents', async () => {
    const r = await runKiroRecording('project', {}, 'save');
    expect(r.installs).toEqual([]);
    expect(r.manager.status().kiro).toBeUndefined();
  });

  it('createServices wires info.cwd as workspacePath into Recording_Manager for project-scope installs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'services-scope-'));
    const ws = join(base, 'workspace');
    const meta = join(base, 'meta');
    const home = join(base, 'home');
    const out = join(base, 'out');
    const fake = new FakeRecord();
    try {
      await mkdir(ws, { recursive: true });
      await mkdir(meta, { recursive: true });
      await mkdir(join(home, '.kiro'), { recursive: true });
      await writeCompiledOutput(out, SERVER);

      vi.doMock('../../src/cli/commands/record.js', () => ({
        record: (options: Parameters<typeof fake.fn>[0]) =>
          fake.fn({
            ...options,
            onLive: (live) =>
              options.onLive({
                get stepCount() { return live.stepCount; },
                get finishIntent() { return live.finishIntent; },
                get finishScope() { return 'project' as const; },
                panelState: () => live.panelState(),
              }),
          }),
      }));

      const services = createServices(
        { compiler: new FakeCompiler() },
        {
          workflowFile: join(meta, 'daemonize.workflows.json'),
          outDir: out,
          cwd: ws,
          sample: false,
          env: { DAEMONIZE_DATA_DIR: join(base, 'appdata') },
          home,
          loadSet: async () => ({ set: undefined }),
          playground: () => undefined,
          loadedSecretValues: () => [],
        },
      );

      expect(services.recording.start({ name: 'Test', url: 'https://shop.test/', reuseSession: false })).toEqual({ status: 202 });
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      fake.steps = 1;
      fake.intent = 'kiro';
      fake.end('panel');
      fake.succeed();
      await vi.waitFor(() => expect(services.recording.status().state).toBe('done'), { timeout: 20000 });

      const status = services.recording.status();
      expect(status.state).toBe('done');
      expect(status.kiro).toMatchObject({ added: true, scope: 'project' });
      expect(existsSync(join(ws, '.kiro', 'settings', 'mcp.json'))).toBe(true);
      expect(existsSync(join(home, '.kiro', 'settings', 'mcp.json'))).toBe(false);
      expect(existsSync(join(meta, '.kiro'))).toBe(false);
      const mcp = JSON.parse(await readFile(join(ws, '.kiro', 'settings', 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers).toHaveProperty(SERVER);
    } finally {
      vi.doUnmock('../../src/cli/commands/record.js');
      await removeDir(base);
    }
  });
});

describe('Recording_Manager: missing credentials (Requirements 20.1 to 20.5)', () => {
  it('normalizes the lists to sorted, unique, valid names', async () => {
    const r = await runKiroRecording('global', {
      installAnswer: { missingSecrets: ['ZED', 'API_KEY', 'API_KEY', 'bad name', 7, null, 'a_lower'], requiredSecrets: ['B1', 'A1'] },
    });
    expect(r.manager.status().kiro).toMatchObject({ added: true, missingSecrets: ['API_KEY', 'ZED'], requiredSecrets: ['A1', 'B1'] });
  });

  it('gives empty arrays when the answer holds no list', async () => {
    const r = await runKiroRecording('global', { installAnswer: {} });
    expect(r.manager.status().kiro).toMatchObject({ missingSecrets: [], requiredSecrets: [] });
  });

  it('holds no secret value in the status', async () => {
    const value = 'super-secret-value-123';
    const r = await runKiroRecording('global', { installAnswer: { missingSecrets: ['TOKEN_1', value], requiredSecrets: [value] } });
    expect(JSON.stringify(r.manager.status())).not.toContain(value);
  });
});
