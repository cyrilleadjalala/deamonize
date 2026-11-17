import { afterAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBase32 } from '../../src/replay/runtime/totp.js';
import { requiredSecrets } from '../../src/studio/required-secrets.js';
import { extractTotpSecret, normalizeBase32 } from '../../src/studio/totp-secret.js';
import { createSecretVault } from '../../src/studio/secret-vault.js';
import { redactForStudio } from '../../src/studio/redact.js';
import { PlaygroundSession, type ConnectFn, type LaunchSpec } from '../../src/studio/playground.js';
import { secretRoutes } from '../../src/studio/routes/secrets.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { AppData } from '../../src/studio/contracts.js';
import type { KeyProvider } from '../../src/studio/key-providers.js';
import type { RouteContext } from '../../src/studio/routes/types.js';
import type { WorkflowSet } from '../../src/types.js';
import { rawRequest } from '../helpers/http.js';

vi.setConfig({ testTimeout: 120000 });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Char = fc.integer({ min: 0, max: 31 }).map((i) => B32[i]);
const base32Key = (min: number, max: number) => fc.array(base32Char, { minLength: min, maxLength: max }).map((a) => a.join(''));
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'daemonize-sp-'));
  tmpDirs.push(d);
  return d;
}
const appDataAt = (dir: string): AppData => ({ dir, ensure: async () => ({ ok: true, dir }), check: async () => ({ ok: true, dir }) });
function memoryKey(): KeyProvider {
  let key: Buffer | undefined;
  return { id: 'mem', get: async () => key, create: async (k) => void (key = k) };
}
/** Secret values that cannot appear by chance in base64 text or JSON keys: a fixed prefix and 16 random characters. */
const secretValue = fc.stringMatching(/^[A-Za-z0-9]{16}$/).map((s) => `Zq-${s}`);
const secretName = fc.stringMatching(/^[A-Z][A-Z0-9_]{2,12}$/);

const noisy = (key: string, spaces: boolean[], lower: boolean, padding: number): string => {
  let out = '';
  [...key].forEach((c, i) => {
    out += lower ? c.toLowerCase() : c;
    if (spaces[i % spaces.length] && i % 4 === 3) out += i % 8 === 3 ? ' ' : '-';
  });
  return out + '='.repeat(padding);
};

// Feature: studio-first-flow, Property 2: Base32 normalization is idempotent and byte-preserving
describe('Property 2: Base32 normalization is idempotent and byte-preserving', () => {
  // **Validates: Requirements 8.10, 8.12**
  it('normalizes noise away, twice gives the same result and the decoded bytes do not change', () => {
    fc.assert(
      fc.property(base32Key(8, 64), fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), fc.boolean(), fc.integer({ min: 0, max: 6 }), (key, spaces, lower, padding) => {
        const once = normalizeBase32(noisy(key, spaces, lower, padding));
        expect(once).toBe(key);
        expect(normalizeBase32(once as string)).toBe(once);
        expect(decodeBase32(once as string).equals(decodeBase32(key))).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});

// Feature: studio-first-flow, Property 3: Otpauth round trip
describe('Property 3: Otpauth round trip', () => {
  // **Validates: Requirements 8.11, 8.12, 14.7**
  it('extracts exactly the secret of an address, whatever the label, issuer and other parameters', () => {
    const label = fc.stringMatching(/^[A-Za-z0-9 ._@-]{1,20}$/);
    fc.assert(
      fc.property(base32Key(16, 64), label, label, fc.boolean(), fc.constantFrom('', '&digits=8', '&period=60&algorithm=SHA256'), (key, name, issuer, lower, extra) => {
        const secret = lower ? key.toLowerCase() : key;
        const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(name)}?issuer=${encodeURIComponent(issuer)}&secret=${secret}${extra}`;
        expect(extractTotpSecret(uri)).toBe(key);
        expect(extractTotpSecret(` ${uri} `)).toBe(key);
      }),
      { numRuns: 200 }
    );
  });
});

// Feature: studio-first-flow, Property 4: Invalid TOTP values are rejected
describe('Property 4: Invalid TOTP values are rejected', () => {
  // **Validates: Requirements 8.13**
  it('rejects hotp, repeated or missing secret, a bad alphabet, an inner = and too short keys', () => {
    fc.assert(
      fc.property(base32Key(16, 40), base32Key(16, 40), (a, b) => {
        expect(extractTotpSecret(`otpauth://hotp/x?secret=${a}&counter=1`)).toBeUndefined();
        expect(extractTotpSecret(`otpauth://totp/x?secret=${a}&secret=${b}`)).toBeUndefined();
        expect(extractTotpSecret(`otpauth://totp/x?issuer=${a}`)).toBeUndefined();
        expect(extractTotpSecret(`${a.slice(0, 5)}=${a.slice(5)}`)).toBeUndefined();
        expect(extractTotpSecret(`${a}1`)).toBeUndefined();
        expect(extractTotpSecret(`${a}!`)).toBeUndefined();
        expect(extractTotpSecret(a.slice(0, 2))).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: studio-first-flow, Property 5: The secrets list matches the workflows
describe('Property 5: The secrets list matches the workflows', () => {
  // **Validates: Requirements 8.4**
  it('lists exactly the names the workflows use, sorted, each once, with the kind precedence', () => {
    const entry = fc.record({ name: secretName, kind: fc.constantFrom('password', 'totp', 'token', 'header') });
    const workflow = fc.record({
      declared: fc.array(entry, { maxLength: 4 }),
      typed: fc.array(fc.record({ name: secretName, totp: fc.boolean() }), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(fc.array(workflow, { minLength: 1, maxLength: 3 }), (workflows) => {
        const set = {
          version: '1', targetType: 'web', targetName: 'A',
          workflows: workflows.map((w, i) => ({ id: String(i), label: 'L', secrets: w.declared, steps: w.typed.map((t) => ({ actionType: 'type', selectors: [], secretRef: t.name, ...(t.totp ? { totp: true } : {}) })) })),
        } as unknown as WorkflowSet;
        const expected = new Set(workflows.flatMap((w) => [...w.declared.map((d) => d.name), ...w.typed.map((t) => t.name)]));
        const result = requiredSecrets(set);
        expect(result.map((r) => r.name)).toEqual([...expected].sort((x, y) => x.localeCompare(y)));
        for (const r of result) expect(['password', 'totp', 'token']).toContain(r.kind);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: studio-first-flow, Property 6: Configured status is the union of the three sources
describe('Property 6: Configured status is the union of the three sources', () => {
  // **Validates: Requirements 8.5, 9.5**
  it('a name is configured exactly when the Studio env, the mcp.json env or the vault holds a non-empty value', async () => {
    const { connect } = fakeConnect();
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(secretName, { minLength: 1, maxLength: 5 }), fc.array(fc.constantFrom('env', 'mcp', 'vault', 'empty', 'none'), { minLength: 5, maxLength: 5 }), async (names, kinds) => {
        const env: Record<string, string> = {};
        const mcpEnv: Record<string, string> = {};
        const vaultNames = new Set<string>();
        names.forEach((n, i) => {
          const kind = kinds[i];
          if (kind === 'env') env[`DAEMONIZE_SECRET_${n}`] = 'abc-value';
          if (kind === 'mcp') mcpEnv[`DAEMONIZE_SECRET_${n}`] = 'literal-value';
          if (kind === 'vault') vaultNames.add(n);
          if (kind === 'empty') env[`DAEMONIZE_SECRET_${n}`] = '';
        });
        const vault = { snapshot: async () => Object.fromEntries([...vaultNames].map((n) => [n, 'vault-value'])), names: async () => vaultNames as ReadonlySet<string>, values: () => [] as string[] };
        const session = new PlaygroundSession({ outDir: tmpdir(), env, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv, cwd: tmpdir() }), vault, requiredSecretNames: async () => names });
        const configured = await session.configuredSecretVariables();
        names.forEach((n, i) => expect(configured.has(`DAEMONIZE_SECRET_${n}`)).toBe(kinds[i] === 'env' || kinds[i] === 'mcp' || kinds[i] === 'vault'));
        await session.close();
      }),
      { numRuns: 60 }
    );
  });
});

function fakeConnect(): { specs: LaunchSpec[]; connect: ConnectFn } {
  const specs: LaunchSpec[] = [];
  const connect: ConnectFn = async (spec) => {
    specs.push(spec);
    return {
      client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) },
      onClose: () => undefined,
      close: async () => undefined,
      stderrTail: () => '',
    };
  };
  return { specs, connect };
}

// Feature: studio-first-flow, Property 7: Vault round trip and ciphertext opacity
describe('Property 7: Vault round trip and ciphertext opacity', () => {
  // **Validates: Requirements 8.1, 8.2, 8.6, 8.20**
  it('returns what was stored, and the file holds neither a name nor a value', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.tuple(secretName, secretValue), { minLength: 1, maxLength: 5, selector: (e) => e[0] }), async (entries) => {
        const dir = await tempDir();
        const provider = memoryKey();
        const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
        for (const [n, v] of entries) await vault.set(n, v);
        const reopened = createSecretVault({ appData: appDataAt(dir), keyProvider: provider });
        expect(await reopened.snapshot()).toEqual(Object.fromEntries(entries));
        const text = await readFile(join(dir, 'secrets.vault.json'), 'utf-8');
        for (const [n, v] of entries) {
          expect(text).not.toContain(v);
          expect(text).not.toContain(`"${n}"`);
        }
        expect((await readdir(dir)).sort()).toEqual(['secrets.vault.json']);
      }),
      { numRuns: 25 }
    );
  });
});

// Feature: studio-first-flow, Property 8: The Redactor removes every known secret value
describe('Property 8: The Redactor removes every known secret value', () => {
  // **Validates: Requirements 6.12, 8.14, 8.19, 9.10**
  it('no vault value survives in any string, key or nesting of a response', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(secretValue, { minLength: 1, maxLength: 4 }), fc.array(fc.string({ maxLength: 12 }), { maxLength: 3 }), async (values, noise) => {
        const dir = await tempDir();
        const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: memoryKey() });
        for (const [i, v] of values.entries()) await vault.set(`N${i}`, v);
        const body = { text: values.map((v, i) => `${noise[0] ?? ''}${v}${noise[1] ?? ''}`).join(' '), nested: { list: values.map((v) => [`x ${v} y`]) }, [values[0]]: 'k', error: `failed with ${values[values.length - 1]}` };
        const safe = JSON.stringify(redactForStudio(body, { env: {}, secretValues: vault.values() }));
        for (const v of values) expect(safe).not.toContain(v);
      }),
      { numRuns: 40 }
    );
  });
});

// Feature: studio-first-flow, Property 9: A stored secret value never leaves the vault
describe('Property 9: A stored secret value never leaves the vault', () => {
  // **Validates: Requirements 8.3, 8.15, 9.8, 13.8, 14.8**
  it('responses, captured output and files hold no stored value', async () => {
    const root = await tempDir();
    const data = join(root, 'data');
    const out = join(root, 'out');
    await mkdir(out, { recursive: true });
    const set = {
      version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://app.example',
      workflows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Log in', variables: [], observedPayloads: [{}], steps: [{ actionType: 'type', selectors: [], secretRef: 'PW' }] }],
    } as unknown as WorkflowSet;
    await writeFile(join(root, 'workflows.json'), serializeWorkflowSet(set));
    const captured: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(' '))));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (captured.push(String(chunk)), true)) as never);
    const handle: StudioHandle = await startStudio({
      workflowFile: join(root, 'workflows.json'),
      outDir: out,
      token: 'tok',
      playground: false,
      env: { PATH: process.env.PATH, DAEMONIZE_VAULT_KEY_PROVIDER: 'memory', DAEMONIZE_DATA_DIR: data },
    });
    const responses: string[] = [];
    const call = async (method: string, path: string, body?: unknown): Promise<void> => {
      const headers: Record<string, string> = { host: `127.0.0.1:${handle.port}`, 'x-studio-token': 'tok' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await rawRequest(handle, method, path, headers, body === undefined ? undefined : JSON.stringify(body));
      responses.push(res.text);
    };
    try {
      await fc.assert(
        fc.asyncProperty(secretValue, async (value) => {
          await call('POST', '/api/secrets', { name: 'PW', value });
          for (const path of ['/api/secrets', '/api/overview', '/api/workflows', '/api/schemas', '/api/playground/status']) await call('GET', path);
          // A request that fails must not echo it either
          await call('POST', '/api/secrets', { name: 'NOPE', value });
          await call('POST', '/api/secrets', { name: 'PW', value, extra: value });
          const scanned = [...responses, ...captured];
          for (const text of scanned) expect(text).not.toContain(value);
          for (const folder of [root, tmpdir() === root ? '' : join(tmpdir(), 'daemonize-studio-shots-none')]) {
            if (folder === '') continue;
            for (const file of await listFiles(folder)) expect(await readFile(file, 'utf-8').catch(() => '')).not.toContain(value);
          }
        }),
        { numRuns: 6 }
      );
    } finally {
      spies.forEach((s) => s.mockRestore());
      stdout.mockRestore();
      await handle.close();
    }
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

// Feature: studio-first-flow, Property 10: The vault wins in the Child_Server environment and only there
describe('Property 10: The vault wins in the Child_Server environment and only there', () => {
  // **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.9**
  it('the vault value is in the child env under the one key form, and in no other place', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(secretName, { minLength: 1, maxLength: 4 }), secretValue, fc.constantFrom('studio', 'mcp', 'both', 'none'), async (names, value, other) => {
        const dir = await tempDir();
        const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: memoryKey() });
        for (const n of names) await vault.set(n, `${value}-${n}`);
        const env: Record<string, string> = {};
        const mcpEnv: Record<string, string> = {};
        for (const n of names) {
          if (other === 'studio' || other === 'both') env[`daemonize_secret_${n}`] = 'studio-other';
          if (other === 'mcp' || other === 'both') mcpEnv[`DAEMONIZE_SECRET_${n}`] = 'mcp-other';
        }
        const { specs, connect } = fakeConnect();
        const processBefore = JSON.stringify(process.env);
        const envBefore = JSON.stringify(env);
        const session = new PlaygroundSession({ outDir: dir, env, connect, launch: () => ({ command: process.execPath, args: ['s.js'], mcpEnv, cwd: dir }), vault, requiredSecretNames: async () => names });
        await session.listTools();
        const child = specs[0].env;
        for (const n of names) {
          // Precedence reversed on purpose (kiro-global-connect-vault-bridge, Req 6.7): a non-empty environment value wins over the vault
          const actual = child[`DAEMONIZE_SECRET_${n}`];
          if (other === 'both') expect(['studio-other', 'mcp-other']).toContain(actual);
          else expect(actual).toBe(other === 'studio' ? 'studio-other' : other === 'mcp' ? 'mcp-other' : `${value}-${n}`);
          expect(Object.keys(child).filter((k) => k.toUpperCase() === `DAEMONIZE_SECRET_${n}`.toUpperCase())).toHaveLength(1);
        }
        expect(JSON.stringify(specs[0].args)).not.toContain(value);
        expect(JSON.stringify(process.env)).toBe(processBefore);
        expect(JSON.stringify(env)).toBe(envBefore);
        await session.close();
      }),
      { numRuns: 40 }
    );
  });
});

// Feature: studio-first-flow, Property 19: Plain-name fields reject path forms (secrets routes)
describe('Property 19: Plain-name fields reject path forms (secrets routes)', () => {
  // **Validates: Requirements 13.9**
  it('a name with .., a separator, a drive letter or NUL answers 400 and the file system does not change', async () => {
    const dir = await tempDir();
    const vault = createSecretVault({ appData: appDataAt(dir), keyProvider: memoryKey() });
    await vault.set('PW', 'Zq-existing-value-1');
    const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all((await listFiles(dir)).map(async (f) => [f, (await readFile(f)).toString('base64')])));
    const ctx = {
      services: { vault }, playground: undefined, sample: false,
      loadSet: async () => ({ set: { version: '1', targetType: 'web', targetName: 'A', workflows: [{ id: 'a', label: 'L', steps: [{ actionType: 'type', selectors: [], secretRef: 'PW' }] }] } as unknown as WorkflowSet, outputs: {} }),
      configuredSecretVariables: async () => new Set<string>(), studioEnv: {},
    } as unknown as RouteContext;
    const routes = new Map(secretRoutes(ctx).map((r) => [r.path, r]));
    const piece = fc.stringMatching(/^[A-Za-z0-9_]{0,8}$/);
    const pathForm = fc.oneof(
      piece.map((p) => `../${p}`),
      piece.map((p) => `${p}/..`),
      piece.map((p) => `${p}\\${p}`),
      piece.map((p) => `/${p}PW`),
      piece.map((p) => `C:\\${p}`),
      piece.map((p) => `PW\0${p}`),
      fc.constant('..'),
      fc.constant('PW/x')
    );
    const before = await snapshot();
    await fc.assert(
      fc.asyncProperty(pathForm, async (name) => {
        for (const [path, body] of [['/api/secrets', { name, value: 'Zq-new-value-2' }], ['/api/secrets/forget', { name }]] as const) {
          const res = await routes.get(path)!.handlers.POST!({ method: 'POST', query: new URLSearchParams(), body: { ...body }, signal: new AbortController().signal });
          expect(res.status).toBe(400);
        }
        expect(await snapshot()).toBe(before);
      }),
      { numRuns: 100 }
    );
  });
});
