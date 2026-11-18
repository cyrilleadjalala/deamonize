import { describe, expect, it } from 'vitest';
import { runKiroRecording } from '../helpers/kiro-recording.js';

describe('Recording_Manager: the scope of "Save and add to Kiro" (Requirements 19.8 to 19.13)', () => {
  it('uses global for both preview and install when chosen and the home folder exists', async () => {
    const r = await runKiroRecording('global');
    expect(r.previews).toEqual(['global']);
    expect(r.installs).toEqual(['global']);
    expect(r.manager.status().kiro).toMatchObject({ added: true, scope: 'global' });
  });

  it('uses project for both when chosen', async () => {
    const r = await runKiroRecording('project');
    expect(r.previews).toEqual(['project']);
    expect(r.installs).toEqual(['project']);
    expect(r.manager.status().kiro?.scope).toBe('project');
  });

  it('falls back from global to project when the home folder is gone at install time', async () => {
    const r = await runKiroRecording('global', { homeAtStart: true, homeAtInstall: false });
    expect(r.installs).toEqual(['project']);
    expect(r.manager.status().kiro?.scope).toBe('project');
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

  it('leaves scope and the arrays out when the install fails, and stays done', async () => {
    const r = await runKiroRecording('global', { installFails: 'No write access' });
    const status = r.manager.status();
    expect(status.state).toBe('done');
    expect(status.kiro?.added).toBe(false);
    expect(status.kiro).not.toHaveProperty('scope');
    expect(status.kiro).not.toHaveProperty('missingSecrets');
    expect(status.kiro).not.toHaveProperty('requiredSecrets');
  });

  it('ignores the scope for other intents', async () => {
    const r = await runKiroRecording('project', {}, 'save');
    expect(r.installs).toEqual([]);
    expect(r.manager.status().kiro).toBeUndefined();
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
