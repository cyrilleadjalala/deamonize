import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVER, createHarness, fullInstall, snapshotTree, writeSettings, type Harness } from '../helpers/power-fixture.js';

describe('auto-add', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('stores the consent after a confirmed install with the option on', async () => {
    const { result } = await fullInstall(h, 'global', true);
    expect(result.autoAddSaved).toBe(true);
    expect(await h.autoAddStore.read()).toEqual({ enabled: true, scope: 'global' });
    expect(await h.installer.getAutoAdd()).toMatchObject({ enabled: true, scope: 'global', writable: true });
  });

  it('stores the workspace for the project scope and nothing without the option', async () => {
    const { result } = await fullInstall(h, 'project', true);
    expect(result.autoAddSaved).toBe(true);
    const setting = await h.autoAddStore.read();
    expect(setting?.scope).toBe('project');
    expect(typeof setting?.workspacePath).toBe('string');
    await h.autoAddStore.clear();
    const plain = await fullInstall(h, 'project');
    expect(plain.result.autoAddSaved).toBeUndefined();
    expect(await h.autoAddStore.read()).toBeUndefined();
  });

  it('deletes the consent when turned off', async () => {
    await fullInstall(h, 'global', true);
    const state = await h.installer.disableAutoAdd();
    expect(state.enabled).toBe(false);
    expect(await h.autoAddStore.read()).toBeUndefined();
    expect(await h.installer.runAutoAdd()).toEqual({ status: 'disabled' });
  });

  it('without consent returns disabled and does not touch any Kiro folder', async () => {
    const before = await snapshotTree(h.base);
    expect(await h.installer.runAutoAdd()).toEqual({ status: 'disabled' });
    expect(await snapshotTree(h.base)).toEqual(before);
    expect(await readdir(h.home)).toEqual([]);
  });

  it('adds the tool after a call, then reports unchanged, with no confirmation id', async () => {
    await h.autoAddStore.write({ enabled: true, scope: 'global' });
    expect(await h.installer.runAutoAdd()).toEqual({ status: 'added' });
    const bytes = await readFile(join(h.kiroGlobal, 'settings', 'mcp.json'));
    expect(await h.installer.runAutoAdd()).toEqual({ status: 'unchanged' });
    expect(await readFile(join(h.kiroGlobal, 'settings', 'mcp.json'))).toEqual(bytes);
    expect((await h.records.list()).map((r) => r.scope)).toEqual(['global']);
    expect(await h.installer.getAutoAdd()).toMatchObject({ enabled: true, last: { status: 'unchanged' } });
  });

  it('adds into the stored project workspace', async () => {
    await h.autoAddStore.write({ enabled: true, scope: 'project', workspacePath: h.ws });
    expect(await h.installer.runAutoAdd()).toEqual({ status: 'added' });
    expect(await readdir(join(h.kiroProject, 'skills'))).toEqual([SERVER]);
  });

  it('a failed automatic install leaves the Kiro files as found and keeps the consent', async () => {
    await writeSettings(h.kiroGlobal, '{not json');
    await h.autoAddStore.write({ enabled: true, scope: 'global' });
    const before = await snapshotTree(h.base);
    const outcome = await h.installer.runAutoAdd();
    expect(outcome.status).toBe('failed');
    expect(typeof outcome.message).toBe('string');
    expect(await snapshotTree(h.base)).toEqual(before);
    expect(await h.autoAddStore.read()).toEqual({ enabled: true, scope: 'global' });
  });

  it('a project consent without a usable workspace fails without throwing', async () => {
    await h.autoAddStore.write({ enabled: true, scope: 'project', workspacePath: join(h.base, 'gone') });
    expect((await h.installer.runAutoAdd()).status).toBe('failed');
    await expect(readdir(join(h.base, 'gone'))).rejects.toBeDefined();
  });

  it('keeps the option off when the consent cannot be stored', async () => {
    // A folder where the consent file belongs makes the rename fail
    await mkdir(join(h.appDir, 'kiro-auto-add.json', 'blocker'), { recursive: true });
    const { result } = await fullInstall(h, 'global', true);
    expect(result.autoAddSaved).toBe(false);
    expect((await h.installer.getAutoAdd()).enabled).toBe(false);
  });

  it('reports the App_Data_Dir as not writable', async () => {
    const closed = await createHarness({ appDataOk: false });
    try {
      expect(await closed.installer.getAutoAdd()).toEqual({ enabled: false, writable: false });
    } finally {
      await closed.cleanup();
    }
    await rm(h.appDir, { recursive: true, force: true });
  });
});
