// Feature: daemonize, Property 12: no env-supplied secret value appears in any compiled artifact
// **Validates: Requirements 16.1, 16.9**
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../../src/compiler/compiler.js';
import { PbtGenerator } from '../../src/pbt/pbt-generator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { SecretReference, Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { encodedForms, scanForValues } from '../helpers/scan-artifacts.js';

vi.setConfig({ testTimeout: 300000, hookTimeout: 60000 });

const NUM_RUNS = 40;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const secretName = fc.stringMatching(/^[A-Z][A-Z0-9_]{2,9}$/);
// High entropy, with characters that JSON, URLs and shells treat specially
const SECRET_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-!@#$%&"\\ ';
const secretValue = fc
  .array(fc.constantFrom(...SECRET_CHARS), { minLength: 24, maxLength: 40 })
  .map((chars) => `s${chars.join('')}9`);
const words = fc.stringMatching(/^[A-Za-z][A-Za-z ]{3,24}[A-Za-z]$/);
const variableName = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,9}$/);

interface Scenario {
  set: WorkflowSet;
  /** Secret name -> value, for the names the workflows use. */
  used: Array<[string, string]>;
  /** Names and values that look like seeds, passwords or cookies and that no workflow uses. */
  decoys: Array<[string, string]>;
  planted: { kind: 'password' | 'authorization' | 'cookie'; value: string };
}

const workflowArb = (targetType: 'web' | 'tui', names: string[]): fc.Arbitrary<Workflow> =>
  fc
    .record({
      id: fc.uuid({ version: 4 }),
      label: words,
      variables: fc.uniqueArray(fc.record({ name: variableName, description: words }), { selector: (v) => v.name, maxLength: 3 }),
      password: fc.constantFrom(...names),
      otp: fc.constantFrom(...names),
      token: fc.constantFrom(...names),
      stepLabel: words,
      withHttp: fc.boolean(),
    })
    .map(({ id, label, variables, password, otp, token, stepLabel, withHttp }) => {
      const web = targetType === 'web';
      const steps: WorkflowStep[] = [
        { actionType: 'click', selectors: web ? ['#open'] : [], label: stepLabel },
        ...variables.map((v): WorkflowStep => ({ actionType: 'type', selectors: web ? [`#${v.name}`] : [], variable: v.name })),
        { actionType: 'type', selectors: web ? ['input[type=password]'] : [], secretRef: password, label: 'Password' },
        { actionType: 'type', selectors: web ? ['#code'] : [], secretRef: otp, totp: true },
      ];
      if (withHttp && web) {
        steps.push({
          actionType: 'click',
          selectors: ['#save'],
          http: {
            method: 'POST',
            url: '/api/save',
            query: { access_token: { $secret: token } },
            headers: { Authorization: { $secret: password }, Cookie: { $secret: token } },
            body: { note: 'x' },
            bindings: [],
            redacted: [
              { in: 'header', name: 'Authorization', secret: password },
              { in: 'header', name: 'Cookie', secret: token },
              { in: 'query', name: 'access_token', secret: token },
            ],
          },
        });
      }
      const secrets: SecretReference[] = [
        { name: password, kind: 'password' },
        { name: otp, kind: 'totp' },
      ];
      return {
        id,
        label,
        steps,
        variables: variables.map((v) => ({ name: v.name, description: v.description })),
        observedPayloads: [],
        ...(web ? {} : { cols: 80, rows: 24 }),
        secrets: secrets.filter((s, i) => secrets.findIndex((o) => o.name === s.name) === i),
      } satisfies Workflow;
    });

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    targetType: fc.constantFrom<'web' | 'tui'>('web', 'tui'),
    pool: fc.uniqueArray(fc.tuple(secretName, secretValue), { selector: (t) => t[0], minLength: 3, maxLength: 8 }),
    decoyCount: fc.integer({ min: 1, max: 3 }),
    decoyValues: fc.array(secretValue, { minLength: 3, maxLength: 3 }),
    targetName: words,
    count: fc.integer({ min: 1, max: 3 }),
    planted: fc.record({ kind: fc.constantFrom<'password' | 'authorization' | 'cookie'>('password', 'authorization', 'cookie'), value: secretValue }),
  })
  .chain((base) => {
    const usedPool = base.pool.slice(0, base.pool.length - 1);
    const usedNames = usedPool.map((t) => t[0]);
    return fc.array(workflowArb(base.targetType, usedNames), { minLength: base.count, maxLength: base.count }).map((workflows): Scenario => {
      const set: WorkflowSet =
        base.targetType === 'web'
          ? { version: '1', targetType: 'web', targetName: base.targetName, startUrl: 'http://localhost:8080/', workflows }
          : { version: '1', targetType: 'tui', targetName: base.targetName, startCommand: ['node', 'app.js'], workflows };
      const used = usedPool.filter(([name]) =>
        workflows.some((w) => JSON.stringify(w).includes(`"${name}"`))
      );
      // Decoys: seeds, passwords and cookies set in the environment that no workflow refers to
      const taken = new Set(base.pool.map((t) => t[0]));
      const decoyNames = ['TOTP_SEED', 'ADMIN_PASSWORD', 'SESSION_COOKIE'].filter((n) => !taken.has(n)).slice(0, base.decoyCount);
      const decoys = decoyNames.map((n, i): [string, string] => [n, base.decoyValues[i]]);
      return { set, used, decoys, planted: base.planted };
    });
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => { };
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

async function withEnv<T>(values: Array<[string, string]>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of values) {
    const key = `DAEMONIZE_SECRET_${name}`;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, old] of previous) {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
}

/** The set with one literal secret planted in a new step. */
function withPlantedLiteral(set: WorkflowSet, planted: Scenario['planted']): { set: WorkflowSet; path: string } {
  const copy = structuredClone(set);
  const steps = copy.workflows[0].steps;
  const web = copy.targetType === 'web';
  const recipe = (headers: Record<string, string>) => ({
    method: 'GET' as const,
    url: '/api/me',
    query: {},
    headers,
    bindings: [],
    redacted: [],
  });
  const step: WorkflowStep =
    planted.kind === 'password'
      ? { actionType: 'type', selectors: web ? ['input[type=password]'] : [], label: 'Password', value: planted.value }
      : {
        actionType: 'click',
        selectors: ['#me'],
        http: recipe(planted.kind === 'authorization' ? { Authorization: planted.value } : { Cookie: planted.value }),
      };
  steps.push(step);
  return { set: copy, path: `$.workflows[0].steps[${steps.length - 1}]` };
}

describe('Property 12: no env-supplied secret value appears in any compiled artifact', () => {
  it('compiles to files without any DAEMONIZE_SECRET_* value, and refuses a plain-text secret', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ set, used, decoys, planted }) => {
        const values = [...used, ...decoys].map(([, value]) => value);
        const dirs: string[] = [];
        try {
          await withEnv([...used, ...decoys], async () => {
            // The serialized workflow set holds names only
            const serialized = serializeWorkflowSet(set);
            for (const value of values) {
              for (const { text } of encodedForms(value)) expect(serialized.includes(text)).toBe(false);
            }
            expect(deserializeWorkflowSet(serialized)).toEqual(set);
            // Every artifact, tests and sandbox files included
            const outDir = await mkdtemp(join(tmpdir(), 'daemonize-noleak-'));
            dirs.push(outDir);
            await silently(async () => {
              const annotated = new SchemaInferencer().inferWorkflows(set);
              const result = await new Compiler().compile(annotated, outDir);
              await new PbtGenerator().generate(annotated, result.toolNames, outDir);
            });
            expect(existsSync(join(outDir, 'sandbox', 'Dockerfile'))).toBe(true);
            expect(existsSync(join(outDir, 'mcp.json'))).toBe(true);
            expect(await scanForValues(outDir, values)).toEqual([]);
            // The names are what the artifacts carry
            const mcp = JSON.parse(readFileSync(join(outDir, 'mcp.json'), 'utf8'));
            const env = Object.values(mcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env;
            const typed = new Set(set.workflows.flatMap((w) => w.steps.flatMap((s) => (s.secretRef === undefined ? [] : [s.secretRef]))));
            // Names that only appear as {"$secret": NAME} references in a recorded HTTP request are listed too
            const referenced = new Set(
              set.workflows.flatMap((w) => w.steps.flatMap((s) => [...JSON.stringify(s.http ?? {}).matchAll(/"\$secret":"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1])))
            );
            const expected = [...new Set([...typed, ...referenced])].map((n) => `DAEMONIZE_SECRET_${n}`).sort();
            expect(Object.keys(env).sort()).toEqual(expected);
            const httpOnly = [...referenced].filter((n) => !typed.has(n));
            for (const name of httpOnly) expect(env[`DAEMONIZE_SECRET_${name}`]).toBe(`\${DAEMONIZE_SECRET_${name}}`);
            // Compiled with --http the same names (and still no value) are in every artifact
            if (set.targetType === 'web') {
              const httpDir = await mkdtemp(join(tmpdir(), 'daemonize-noleak-http-'));
              dirs.push(httpDir);
              await silently(async () => {
                await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), httpDir, { http: 'auto' });
              });
              expect(existsSync(join(httpDir, 'http-replay.js'))).toBe(true);
              expect(await scanForValues(httpDir, values)).toEqual([]);
              const httpMcp = JSON.parse(readFileSync(join(httpDir, 'mcp.json'), 'utf8'));
              expect(Object.keys(Object.values(httpMcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env).sort()).toEqual(expected);
            }
            for (const [name, placeholder] of Object.entries(env)) expect(placeholder).toBe(`\${${name}}`);
            // A literal secret makes the compiler refuse: the path is named, the value is not, nothing is written
            const bad = withPlantedLiteral(set, planted);
            const refusedDir = join(tmpdir(), `daemonize-refused-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            let message = '';
            try {
              await silently(() => new Compiler().compile(bad.set, refusedDir));
              dirs.push(refusedDir);
            } catch (err) {
              message = (err as Error).message;
            }
            expect(message).toContain(bad.path);
            for (const { text } of encodedForms(planted.value)) expect(message.includes(text)).toBe(false);
            expect(existsSync(refusedDir)).toBe(false);
          });
        } finally {
          for (const dir of dirs) await removeDir(dir);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

describe('mcp.json placeholders (checked-in sample shape of the secrets end-to-end test)', () => {
  it('writes ${DAEMONIZE_SECRET_X} strings, never values', async () => {
    // The workflow recorded by tests/integration/secrets-e2e.test.ts: a password and a one-time code
    const sample: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'login-app',
      startUrl: 'http://127.0.0.1:8080/',
      workflows: [
        {
          id: '5c0b3e1a-6f6d-4f0e-9a0e-0d3b0f1c2a77',
          label: 'Sign in with a one-time code',
          steps: [
            { actionType: 'type', selectors: ['#user'], value: 'ada' },
            { actionType: 'type', selectors: ['#pass'], secretRef: 'PASSWORD' },
            { actionType: 'type', selectors: ['#code'], secretRef: 'OTP', totp: true },
            { actionType: 'click', selectors: ['button'] },
          ],
          variables: [],
          observedPayloads: [],
          secrets: [{ name: 'PASSWORD', kind: 'password' }, { name: 'OTP', kind: 'totp' }],
        },
      ],
    };
    const outDir = await mkdtemp(join(tmpdir(), 'daemonize-sample-'));
    try {
      await withEnv([['PASSWORD', 'Tr0ub4dor&3-xyzzy-sample'], ['OTP', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP']], async () => {
        await silently(() => new Compiler().compile(new SchemaInferencer().inferWorkflows(sample), outDir));
        const mcp = JSON.parse(readFileSync(join(outDir, 'mcp.json'), 'utf8'));
        const env = Object.values(mcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env;
        expect(env).toEqual({
          DAEMONIZE_SECRET_OTP: '${DAEMONIZE_SECRET_OTP}',
          DAEMONIZE_SECRET_PASSWORD: '${DAEMONIZE_SECRET_PASSWORD}',
        });
        expect(await readdir(outDir)).toContain('mcp.json');
        expect(await scanForValues(outDir, ['Tr0ub4dor&3-xyzzy-sample', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'])).toEqual([]);
      });
    } finally {
      await removeDir(outDir);
    }
  });
});
