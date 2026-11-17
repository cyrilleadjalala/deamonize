// Feature: kiro-global-connect-vault-bridge, Property 14: Vault isolation between applications
// Fewer runs than 100 are not used: each run writes a few small encrypted files, which is fast enough.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import type { AppData } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';

const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/);
const valueArb = fc.string({ minLength: 1, maxLength: 24 });
const originArb = fc.constantFrom('https://a.example', 'https://b.example', 'http://localhost:3000', 'https://c.example:8443');

function memoryProvider(): KeyProvider {
  let held: Buffer | undefined;
  return { id: 'mem', get: async () => held, create: async (k) => void (held = Buffer.from(k)) };
}

async function withVault<T>(body: (vault: ReturnType<typeof createSecretVault>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-p14-'));
  try {
    const appData: AppData = { dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) };
    return await body(createSecretVault({ appData, keyProvider: memoryProvider() }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Property 14: Vault isolation between applications', () => {
  it('a scoped write, removal or generic write never changes another application or the generic view', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, valueArb, valueArb, valueArb, originArb, originArb, async (name, genericValue, valueA, valueB, appA, appB) => {
        fc.pre(appA !== appB);
        await withVault(async (vault) => {
          await vault.set(name, genericValue);
          await vault.setFor(appA, name, valueA);
          // generic view unchanged
          expect(await vault.snapshot()).toEqual({ [name]: genericValue });
          expect([...(await vault.names())]).toEqual([name]);
          // other application sees the generic value, not A's
          expect((await vault.snapshotFor(appB))[name]).toBe(genericValue);
          expect((await vault.snapshotFor(appA))[name]).toBe(valueA);
          await vault.setFor(appB, name, valueB);
          // removing A's entry leaves B and the generic entry
          expect(await vault.removeFor(appA, name)).toBe(true);
          expect(await vault.removeFor(appA, name)).toBe(false);
          expect((await vault.snapshotFor(appA))[name]).toBe(genericValue);
          expect((await vault.snapshotFor(appB))[name]).toBe(valueB);
          // a generic write leaves scoped entries untouched
          await vault.set(name, `${genericValue}!`);
          expect((await vault.snapshotFor(appB))[name]).toBe(valueB);
          // generic remove leaves scoped
          expect(await vault.remove(name)).toBe(true);
          expect((await vault.snapshotFor(appB))[name]).toBe(valueB);
          expect([...(await vault.namesFor(appA))]).toEqual([]);
          expect([...(await vault.namesFor(appB))]).toEqual([name]);
          expect(vault.values()).toContain(valueB);
        });
      }),
      { numRuns: 100 }
    );
  }, 120_000);
});

