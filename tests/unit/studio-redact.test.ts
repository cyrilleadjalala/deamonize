import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { REDACTED, collectEnvSecretValues, redactForStudio, storageStateValues } from '../../src/studio/redact.js';

const secretArb = fc.stringMatching(/^[A-Za-z0-9]{10,24}$/).map((s) => `Zq9-${s}`);

describe('redactForStudio', () => {
  it('replaces a secret value wherever it appears in strings and keys', () => {
    const out = redactForStudio({ a: 'x Zq9-secretvalue y', 'k-Zq9-secretvalue': 1, n: [{ deep: 'Zq9-secretvalue' }] }, { secretValues: ['Zq9-secretvalue'], env: {} });
    expect(JSON.stringify(out)).not.toContain('Zq9-secretvalue');
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('removes cookie, authorization and storage state members', () => {
    const out = redactForStudio(
      { headers: { Authorization: 'Bearer abcdefghij', Cookie: 'sid=1', 'Set-Cookie': 'x', ok: 'fine' }, cookies: [{ name: 'a', value: 'b' }], origins: [], keep: 1 },
      { env: {} }
    ) as Record<string, unknown>;
    expect(out).toEqual({ headers: { ok: 'fine' }, keep: 1 });
  });

  it('reduces storageState to the basename of its path and hides an object', () => {
    expect(redactForStudio({ storageState: 'C:\\users\\me\\auth\\state.json' }, { env: {} })).toEqual({ storageState: 'state.json' });
    expect(redactForStudio({ storageState: { cookies: [] } }, { env: {} })).toEqual({ storageState: REDACTED });
  });

  it('replaces a whole string that is a JWT or a bearer credential', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmno';
    expect(redactForStudio({ a: jwt, b: 'Bearer abcdef123456', c: 'plain text' }, { env: {} })).toEqual({ a: REDACTED, b: REDACTED, c: 'plain text' });
  });

  it('collects the DAEMONIZE_SECRET_* and model key values of an environment, nothing else', () => {
    const values = collectEnvSecretValues({ DAEMONIZE_SECRET_PW: 'pw-value-1', DAEMONIZE_MODEL_API_KEY: 'key-value-1', DAEMONIZE_MODEL_NAME: 'gpt-x', PATH: '/bin', DAEMONIZE_SECRET_EMPTY: '' });
    expect(values.sort()).toEqual(['key-value-1', 'pw-value-1']);
  });

  it('collects the cookie and local-storage values of a storage state, and nothing else', () => {
    const values = storageStateValues({
      cookies: [{ name: 'sid', value: 'cookie-value-9', domain: '127.0.0.1', path: '/app', sameSite: 'Lax' }],
      origins: [{ origin: 'https://a.test', localStorage: [{ name: 'k', value: 'ls-value-7' }] }],
    });
    expect(values.sort()).toEqual(['cookie-value-9', 'ls-value-7']);
    // Regression: the domain of a saved session's cookie was treated as a secret, so every Studio
    // response that named the application (http://127.0.0.1:port) came out as http://***:port.
    expect(values).not.toContain('127.0.0.1');
    expect(values).not.toContain('https://a.test');
  });

  it('removes planted env secrets and cookie values from any nested structure', () => {
    fc.assert(
      fc.property(secretArb, secretArb, fc.array(fc.string(), { maxLength: 4 }), (envSecret, cookie, noise) => {
        fc.pre(envSecret !== cookie);
        const doc = {
          label: `before ${envSecret} after`,
          nested: [{ text: cookie, list: noise.concat(`${cookie}${envSecret}`) }],
          [`key ${cookie}`]: true,
        };
        const out = JSON.stringify(redactForStudio(doc, { env: { DAEMONIZE_SECRET_X: envSecret }, secretValues: [cookie] }));
        return !out.includes(envSecret) && !out.includes(cookie);
      }),
      { numRuns: 100 }
    );
  });

  it('does not mutate its input', () => {
    const input = { a: 'Zq9-secretvalue', cookies: [1] };
    redactForStudio(input, { secretValues: ['Zq9-secretvalue'], env: {} });
    expect(input).toEqual({ a: 'Zq9-secretvalue', cookies: [1] });
  });
});
