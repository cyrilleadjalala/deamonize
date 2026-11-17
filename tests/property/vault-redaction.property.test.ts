// Feature: kiro-global-connect-vault-bridge, Property 19: Resolved values are redacted
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptVault, VAULT_FILE } from '../../src/replay/runtime/vault-format.js';
import { withResolvedSecrets } from '../../src/replay/runtime/vault-reader.js';
import { describeFailure, secretValues } from '../../src/replay/runtime/step-plan.js';
import { redactForStudio } from '../../src/studio/redact.js';

const key = randomBytes(32);
let root: string;
let counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'daemonize-p19-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// At least 6 characters without "*" so that the replacement text cannot contain the value
const secretArb = fc.stringMatching(/^[A-Za-z0-9!@#$%^&()_+=-]{6,30}$/);

describe('Property 19: Resolved values are redacted', () => {
  it('a value resolved from the vault is in the redaction set and absent from diagnostics', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const dir = join(root, `d${counter++}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, VAULT_FILE), JSON.stringify(encryptVault(key, new Map([['PASSWORD', secret]]))));
        await writeFile(join(dir, 'vault.key.test'), key.toString('hex'));
        const env = await withResolvedSecrets({ DAEMONIZE_DATA_DIR: dir, DAEMONIZE_VAULT_KEY_PROVIDER: 'file' }, ['DAEMONIZE_SECRET_PASSWORD']);
        const steps = [{ actionType: 'type', secretRef: 'PASSWORD' }] as Parameters<typeof secretValues>[0];
        const secrets = secretValues(steps, env);
        expect(secrets).toEqual([secret]);
        const failure = describeFailure({
          stepIndex: 0,
          step: steps[0],
          tried: [`fill ${secret}`],
          reason: `Could not type ${secret} into the field`,
          secrets,
        });
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect(JSON.stringify(redactForStudio({ message: `value ${secret}` }, { env: {}, secretValues: secrets }))).not.toContain(secret);
      }),
      { numRuns: 100 }
    );
  }, 120_000);
});
