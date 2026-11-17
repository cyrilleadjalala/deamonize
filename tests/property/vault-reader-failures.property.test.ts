// Feature: kiro-global-connect-vault-bridge, Property 17: Reader failures never leak
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptVault, VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import { withResolvedSecrets, type RunProcess } from '../../src/replay/runtime/vault-reader.js';

const VAR = 'DAEMONIZE_SECRET_PASSWORD';
const SECRET = 'Planted-Failure-Secret-7d2';
const key = randomBytes(32);
let root: string;
let counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-p17-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const good = JSON.stringify(encryptVault(key, new Map([['PASSWORD', SECRET]])));
// Flipping an unused padding bit of a base64 field leaves the decoded bytes, and so the vault, unchanged.
function sameBytes(a: string, b: string): boolean {
  try {
    const x = JSON.parse(a) as Record<string, string>;
    const y = JSON.parse(b) as Record<string, string>;
    return ['iv', 'tag', 'ct'].every((f) => Buffer.from(x[f], 'base64').equals(Buffer.from(y[f], 'base64'))) && x.v === y.v && x.alg === y.alg;
  } catch {
    return false;
  }
}
type Failure = { kind: 'missing' } | { kind: 'truncate'; at: number } | { kind: 'flip'; at: number } | { kind: 'random'; bytes: Uint8Array } | { kind: 'wrongKey' } | { kind: 'noKey' } | { kind: 'unavailable' };
const failureArb: fc.Arbitrary<Failure> = fc.oneof(
  fc.constant<Failure>({ kind: 'missing' }),
  fc.nat({ max: good.length - 1 }).map<Failure>((at) => ({ kind: 'truncate', at })),
  fc.nat({ max: good.length - 1 }).map<Failure>((at) => ({ kind: 'flip', at })),
  fc.uint8Array({ maxLength: 300 }).map<Failure>((bytes) => ({ kind: 'random', bytes })),
  fc.constant<Failure>({ kind: 'wrongKey' }),
  fc.constant<Failure>({ kind: 'noKey' }),
  fc.constant<Failure>({ kind: 'unavailable' })
);

describe('Property 17: Reader failures never leak', () => {
  it('any broken vault or key store leaves the variable unset and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(failureArb, async (failure) => {
        const dir = join(root, `d${counter++}`);
        await mkdir(dir, { recursive: true });
        let text = good;
        if (failure.kind === 'truncate') text = good.slice(0, failure.at);
        if (failure.kind === 'flip') text = good.slice(0, failure.at) + (good[failure.at] === 'A' ? 'B' : 'A') + good.slice(failure.at + 1);
        if (failure.kind === 'random') text = Buffer.from(failure.bytes).toString('latin1');
        if (failure.kind === 'wrongKey') text = JSON.stringify(encryptVault(randomBytes(32), new Map([['PASSWORD', SECRET]])));
        if (failure.kind !== 'missing') await writeFile(join(dir, VAULT_FILE), text);
        if (failure.kind !== 'noKey' && failure.kind !== 'unavailable') await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
        const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: failure.kind === 'unavailable' ? 'unavailable' : 'file' };
        const out = await withResolvedSecrets(env, [VAR]);
        if (failure.kind === 'flip' && sameBytes(text, good)) {
          expect(out[VAR]).toBe(SECRET); // flipping a character to the same character, or truncating nothing
          return;
        }
        expect(out[VAR]).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain(SECRET);
      }),
      { numRuns: 100 }
    );
  }, 120_000);

  it('a key store that never answers is cut off at the time limit', async () => {
    const dir = join(root, 'slow');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, VAULT_FILE), good);
    await writeFile(join(dir, 'vault.key'), 'AAAA');
    const never: RunProcess = () => new Promise(() => undefined);
    const started = Date.now();
    const out = await withResolvedSecrets({ DAEMONIZE_DATA_DIR: dir }, [VAR], { run: never, timeoutMs: 100 });
    expect(out[VAR]).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
