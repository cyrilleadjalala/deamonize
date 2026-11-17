import { describe, it, expect } from 'vitest';
import { withEnv } from '../helpers/with-env';

const NAME = 'DAEMONIZE_TEST_WITH_ENV';

describe('withEnv', () => {
  it('restores an existing variable after a passing body', async () => {
    process.env[NAME] = 'before';
    await withEnv({ [NAME]: 'during' }, () => expect(process.env[NAME]).toBe('during'));
    expect(process.env[NAME]).toBe('before');
    delete process.env[NAME];
  });

  it('restores an existing variable after a throwing body', async () => {
    process.env[NAME] = 'before';
    await expect(withEnv({ [NAME]: 'during' }, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(process.env[NAME]).toBe('before');
    delete process.env[NAME];
  });

  it('removes an absent variable after a passing body', async () => {
    delete process.env[NAME];
    await withEnv({ [NAME]: 'during' }, () => expect(process.env[NAME]).toBe('during'));
    expect(NAME in process.env).toBe(false);
  });

  it('removes an absent variable after a throwing body', async () => {
    delete process.env[NAME];
    await expect(withEnv({ [NAME]: 'during' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(NAME in process.env).toBe(false);
  });
});
