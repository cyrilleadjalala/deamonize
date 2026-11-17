/**
 * Spec studio-first-recording-fixes, group G1: phantom HTTP secrets and Studio secret status.
 * Properties 1, 2, 3, 4, 10 and 11 of the design.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
import fc from 'fast-check';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { describeTool, secretEnvNames } from '../../src/compiler/tool-description.js';
import { httpSecretNames, missingHttpSecrets, planSteps, COOKIE_HEADER_VARIABLE, secretVariable } from '../../src/replay/runtime/http-replay.js';
import { buildWorkflowView, isSecretStep, NO_OUTPUTS, type StudioOutputs } from '../../src/studio/model.js';
import { clipText } from '../../src/studio/pbt-result.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest } from '../helpers/http.js';

const ID = '11111111-1111-4111-8111-111111111111';
const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{2,8}$/);

interface StepPlan {
  kind: 'type' | 'click' | 'keypress';
  recipe?: string[]; // names of {"$secret":NAME} in the recipe headers
  secretRef?: string;
}

const stepPlanArb: fc.Arbitrary<StepPlan> = fc.record({
  kind: fc.constantFrom('type' as const, 'click' as const, 'keypress' as const),
  recipe: fc.option(fc.uniqueArray(nameArb, { minLength: 0, maxLength: 3 }), { nil: undefined }),
  secretRef: fc.option(nameArb, { nil: undefined }),
});

interface WorkflowPlan {
  steps: StepPlan[];
  declared: string[];
}

const workflowPlanArb: fc.Arbitrary<WorkflowPlan> = fc.record({
  steps: fc.array(stepPlanArb, { minLength: 1, maxLength: 6 }),
  declared: fc.uniqueArray(nameArb, { minLength: 0, maxLength: 2 }),
});

function toWorkflow(plan: WorkflowPlan, extra: (step: WorkflowStep, index: number) => Partial<WorkflowStep> = () => ({})): Workflow {
  const steps: WorkflowStep[] = plan.steps.map((p, i) => ({
    actionType: p.kind,
    selectors: [`#f${i}`],
    ...(p.secretRef === undefined ? {} : { secretRef: p.secretRef }),
    ...(p.recipe === undefined
      ? {}
      : {
        http: {
          method: 'POST',
          url: `https://app.example.test/api/${i}`,
          query: {},
          headers: Object.fromEntries(p.recipe.map((n, k) => [`x-h${k}`, { $secret: n }])),
          bindings: [],
          redacted: [],
        },
      }),
    ...extra({ actionType: p.kind, selectors: [] }, i),
  }));
  return { id: ID, label: 'Flow', steps, variables: [], observedPayloads: [], ...(plan.declared.length > 0 ? { secrets: plan.declared } : {}) };
}

const PREFIX = 'DAEMONIZE_SECRET_';

/** The listing before the fix: every recipe name, whatever the mode. */
function originalSecretEnvNames(workflow: Workflow): string[] {
  const names = new Set<string>();
  for (const step of workflow.steps) if (step.secretRef !== undefined) names.add(step.secretRef);
  for (const entry of workflow.secrets ?? []) names.add(typeof entry === 'string' ? entry : entry.name);
  for (const step of workflow.steps) for (const name of httpSecretNames(step.http)) names.add(name);
  return [...names].sort().map((n) => `${PREFIX}${n}`);
}

/** What the design says the compiled mode needs, computed independently of the implementation. */
function expectedRequired(workflow: Workflow, http: boolean): string[] {
  const names = new Set<string>();
  for (const step of workflow.steps) if (step.secretRef !== undefined) names.add(step.secretRef);
  for (const entry of workflow.secrets ?? []) names.add(typeof entry === 'string' ? entry : entry.name);
  if (http) {
    const plan = planSteps(workflow.steps);
    workflow.steps.forEach((step, i) => {
      if (plan[i] === 'http') for (const name of httpSecretNames(step.http)) names.add(name);
    });
  }
  return [...names].sort();
}

const allRecipeNames = (workflow: Workflow): string[] => [...new Set(workflow.steps.flatMap((s) => httpSecretNames(s.http)))].sort();

const set = (workflow: Workflow): WorkflowSet => ({ version: '1', targetType: 'web', targetName: 'App', startUrl: 'https://app.example.test/', workflows: [workflow] });
const outputs = (http: boolean): StudioOutputs => ({ ...NO_OUTPUTS, flags: { compiled: true, healSupport: false, http, pbtGenerated: false } });

/** Evaluate the HTTP secret helpers of a generated docker-replay.ts (TypeScript lines, evaluated after transpiling). */
async function dockerHelpers(workflow: Workflow, http: 'auto' | 'off'): Promise<{ missing: (steps: WorkflowStep[]) => string[]; variables: (steps: WorkflowStep[]) => string[]; source: string }> {
  const ts = await import('typescript');
  const source = new McpGenerator().generateDockerReplay(set(workflow), 'img:test', { http });
  const lines = source.split('\n').filter((l) => /^const (HTTP_SECRET_VARIABLES|HTTP_MISSING_SECRETS|httpStepsOf)\b/.test(l));
  const js = ts.transpileModule(lines.join('\n') + '\nreturn { HTTP_SECRET_VARIABLES, HTTP_MISSING_SECRETS };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: false,
  }).outputText;
  const scope = { planSteps, httpSecretNames, missingHttpSecrets, secretVariable, COOKIE_HEADER_VARIABLE, process: { env: {} as Record<string, string> } };
  const fn = new Function(...Object.keys(scope), js) as (...args: unknown[]) => { HTTP_SECRET_VARIABLES: (s: WorkflowStep[]) => string[]; HTTP_MISSING_SECRETS: (s: WorkflowStep[]) => string[] };
  const { HTTP_SECRET_VARIABLES, HTTP_MISSING_SECRETS } = fn(...Object.values(scope));
  return { missing: HTTP_MISSING_SECRETS, variables: HTTP_SECRET_VARIABLES, source };
}

/** The 2FA example of the bug: steps plan as ui, ui, ui, http and the login verify recipe sits on a ui step. */
const phantomWorkflow = (): Workflow =>
  toWorkflow({
    declared: [],
    steps: [
      { kind: 'type' },
      { kind: 'click', recipe: ['CHALLENGE_TOKEN', 'TOTP'] },
      { kind: 'click' },
      { kind: 'click', recipe: [] },
    ],
  });

describe('Phantom HTTP secrets', () => {
  it('the 2FA workflow plans as ui, ui, ui, http', () => {
    expect(planSteps(phantomWorkflow().steps)).toEqual(['ui', 'ui', 'ui', 'http']);
  });

  // Feature: studio-first-recording-fixes, Property 1: Bug Condition - Only HTTP-planned steps need HTTP secrets
  it('lists recipe-only secrets only for HTTP-planned steps of a --http server', () => {
    fc.assert(
      fc.property(workflowPlanArb, fc.boolean(), (plan, http) => {
        const workflow = toWorkflow(plan);
        const expected = expectedRequired(workflow, http).map((n) => `${PREFIX}${n}`);
        expect(secretEnvNames(workflow, { http })).toEqual(expected);
        const description = describeTool(workflow, { http });
        for (const name of allRecipeNames(workflow)) {
          if (!expected.includes(`${PREFIX}${name}`)) expect(description).not.toContain(`${PREFIX}${name}`);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('names no phantom secret in the tool description without --http', () => {
    const workflow = phantomWorkflow();
    expect(describeTool(workflow, { http: false })).not.toContain('DAEMONIZE_SECRET_TOTP');
    expect(describeTool(workflow, { http: true })).not.toContain('DAEMONIZE_SECRET_TOTP');
    expect(secretEnvNames(workflow, { http: true })).toEqual([]);
  });

  it('host side of docker-replay.ts needs no secret of a step that stays on ui', async () => {
    const workflow = phantomWorkflow();
    const { missing, variables } = await dockerHelpers(workflow, 'auto');
    expect(missing(workflow.steps)).toEqual([]);
    expect(variables(workflow.steps)).toEqual([]);
  });

  it('generated replay: the plan comes before the HTTP secret check and only HTTP steps are passed', () => {
    const source = new McpGenerator().generateReplay(set(phantomWorkflow()), { http: 'auto' });
    const planAt = source.indexOf('const plan = planSteps(steps)');
    const checkAt = source.indexOf('missingHttpSecrets(httpSteps');
    expect(planAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(planAt);
    expect(source).toContain('httpSecretValues(httpSteps');
    // exactly one plan computation
    expect(source.split('const plan = planSteps(steps)').length - 1).toBe(1);
  });

  it('without --http the generated files read no HTTP secret', async () => {
    const workflow = phantomWorkflow();
    const replay = new McpGenerator().generateReplay(set(workflow), {});
    expect(replay).not.toContain('missingHttpSecrets');
    expect(replay).not.toContain('httpSecretValues');
    const { missing, variables, source } = await dockerHelpers(workflow, 'off');
    expect(source).toMatch(/const HTTP_MISSING_SECRETS = \(_steps: Step\[\]\): string\[\] => \[\];/);
    expect(missing(workflow.steps)).toEqual([]);
    expect(variables(workflow.steps)).toEqual([]);
  });

  // Feature: studio-first-recording-fixes, Property 2: Preservation - Secrets that are used stay required
  it('keeps the listing and the missing names of workflows whose recipe secrets all run over HTTP', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ secretRef: fc.option(nameArb, { nil: undefined }), recipe: fc.uniqueArray(nameArb, { minLength: 0, maxLength: 3 }) }), { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(nameArb, { minLength: 0, maxLength: 2 }),
        fc.uniqueArray(nameArb, { minLength: 0, maxLength: 6 }),
        (rows, declared, present) => {
          // Only HTTP steps: every step has a recipe, so the plan is http throughout, except secretRef steps typed on the page
          const plan: WorkflowPlan = { declared, steps: rows.map((r) => ({ kind: 'click' as const, recipe: r.recipe, secretRef: undefined })) };
          const workflow = toWorkflow(plan);
          const modes = planSteps(workflow.steps);
          fc.pre(modes.every((m) => m === 'http'));
          expect(secretEnvNames(workflow, { http: true })).toEqual(originalSecretEnvNames(workflow));
          const env = Object.fromEntries(present.map((n) => [secretVariable(n), 'x']));
          const httpSteps = workflow.steps.filter((_, i) => modes[i] === 'http');
          expect(missingHttpSecrets(httpSteps, env)).toEqual(missingHttpSecrets(workflow.steps, env));
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: studio-first-recording-fixes, Property 2: Preservation - Secrets that are used stay required
  it('always lists secretRef names and the declared secrets, whatever the mode', () => {
    fc.assert(
      fc.property(workflowPlanArb, fc.boolean(), (plan, http) => {
        const workflow = toWorkflow(plan);
        const typed = new Set<string>([...plan.declared, ...plan.steps.flatMap((s) => (s.secretRef === undefined ? [] : [s.secretRef]))]);
        const listed = secretEnvNames(workflow, { http });
        for (const name of typed) expect(listed).toContain(`${PREFIX}${name}`);
      }),
      { numRuns: 200 }
    );
  });

  it('generated runtime files import nothing from src/', () => {
    const generator = new McpGenerator();
    for (const http of ['auto', 'off'] as const) {
      for (const source of [generator.generateReplay(set(phantomWorkflow()), { http }), generator.generateDockerReplay(set(phantomWorkflow()), 'img', { http })]) {
        expect(source).not.toMatch(/from ["'][^"']*\/src\//);
        expect(source).not.toMatch(/from ["']\.\.\//);
      }
    }
  });
});

describe('Studio secrets view', () => {
  // Feature: studio-first-recording-fixes, Property 3: Bug Condition - Studio shows the secrets of the compiled mode with a status
  it('lists the required secrets of the compiled mode with a status, and the recipe-only names apart', () => {
    fc.assert(
      fc.property(workflowPlanArb, fc.boolean(), fc.uniqueArray(nameArb, { maxLength: 8 }), (plan, http, configuredNames) => {
        const workflow = toWorkflow(plan);
        const configured = new Set(configuredNames.map((n) => `${PREFIX}${n}`));
        const view = buildWorkflowView(set(workflow), workflow, outputs(http), { configured });
        const required = expectedRequired(workflow, http);
        expect(view.secrets.map((s) => s.name).sort()).toEqual(required);
        expect(view.secrets.map((s) => `${PREFIX}${s.name}`).sort()).toEqual(secretEnvNames(workflow, { http }).sort());
        const unused = allRecipeNames(workflow).filter((n) => !required.includes(n));
        expect((view.unusedSecrets ?? []).map((s) => s.name).sort()).toEqual(unused);
        for (const secret of view.secrets) {
          expect(secret.status).toBe(configured.has(`${PREFIX}${secret.name}`) ? 'configured' : 'missing');
          expect(Object.keys(secret).every((k) => ['name', 'kind', 'envVariable', 'status'].includes(k))).toBe(true);
        }
        expect(view.secretsBasis).toBe(http ? 'http' : 'ui-only');
      }),
      { numRuns: 200 }
    );
  });

  // Feature: studio-first-recording-fixes, Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line (data)
  it('lists the write steps in order and classifies the login', () => {
    const stepArb = fc.record({
      risk: fc.constantFrom('read' as const, 'write' as const, 'delete' as const),
      secret: fc.boolean(),
      label: fc.option(fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim() !== ''), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 8 }), (rows) => {
        const steps: WorkflowStep[] = rows.map((r, i) => ({
          actionType: r.secret ? 'type' : 'click',
          selectors: [`#s${i}`],
          risk: r.risk,
          ...(r.secret ? { secretRef: 'PWD' } : {}),
          ...(r.label === undefined ? {} : { label: r.label }),
        }));
        const workflow: Workflow = { id: ID, label: 'W', steps, variables: [], observedPayloads: [] };
        const view = buildWorkflowView(set(workflow), workflow, NO_OUTPUTS);
        const writes = steps.flatMap((s, i) => ((s.risk ?? 'read') === 'read' ? [] : [i]));
        expect((view.writeSteps ?? []).map((w) => w.index)).toEqual(writes);
        (view.writeSteps ?? []).forEach((w) => {
          const s = steps[w.index];
          expect(w.label).toBe(s.label === undefined ? `${s.actionType} ${w.index + 1}` : clipText(s.label, 80));
          expect(w.risk).toBe(s.risk);
        });
        const first = writes[0];
        const loginIndex = first !== undefined && steps.slice(0, first).some(isSecretStep) ? first : undefined;
        const logins = (view.writeSteps ?? []).filter((w) => w.kind === 'login');
        expect(logins.map((w) => w.index)).toEqual(loginIndex === undefined ? [] : [loginIndex]);
        const summary = writes.length === 0 ? 'none' : writes.length === 1 && loginIndex !== undefined ? 'login-only' : 'actions';
        expect(view.writeSummary).toBe(summary);
        const highest = steps.some((s) => s.risk === 'delete') ? 'delete' : writes.length > 0 ? 'write' : 'read';
        expect(view.risk.highest).toBe(highest);
      }),
      { numRuns: 200 }
    );
  });

  // Feature: studio-first-recording-fixes, Property 11: Preservation - Read-only tools and the confirmation flow are unchanged (server)
  it('shows no write data for a workflow without a write step', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('type' as const, 'click' as const, 'keypress' as const), { minLength: 1, maxLength: 8 }), (kinds) => {
        const steps: WorkflowStep[] = kinds.map((actionType, i) => ({ actionType, selectors: [`#s${i}`] }));
        const workflow: Workflow = { id: ID, label: 'W', steps, variables: [], observedPayloads: [] };
        const view = buildWorkflowView(set(workflow), workflow, NO_OUTPUTS);
        expect(view.risk).toEqual({ read: kinds.length, write: 0, delete: 0, highest: 'read' });
        expect(view.writeSteps ?? []).toEqual([]);
        expect(view.writeSummary ?? 'none').toBe('none');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Studio server never exposes a secret value', () => {
  let dir: string;
  let handle: StudioHandle;
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-secrets-'));
    handle = await startStudio({ workflowFile: join(dir, 'workflows.json'), outDir: join(dir, 'out'), env, staticDir: join(dir, 'ui') });
  });
  afterAll(async () => {
    await handle?.close();
    if (dir) await removeDir(dir);
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    rawRequest(handle, 'GET', path, { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token, ...headers });

  // Feature: studio-first-recording-fixes, Property 4: Preservation - Studio never exposes a value and its security is unchanged
  it('keeps secret values out of /api/workflows and /api/playground', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9]{12,20}$/), { minLength: 2, maxLength: 2 }).map((v) => v.map((x) => `Zq9-${x}`)),
        async ([totp, token]) => {
          const workflow = toWorkflow({ declared: ['API_TOKEN'], steps: [{ kind: 'click', recipe: ['TOTP'] }, { kind: 'click', recipe: [] }] });
          await writeFile(join(dir, 'workflows.json'), serializeWorkflowSet(set(workflow)));
          env.DAEMONIZE_SECRET_API_TOKEN = token;
          env.DAEMONIZE_SECRET_TOTP = totp;
          for (const path of ['/api/workflows', '/api/playground', '/api/overview']) {
            const r = await get(path);
            expect(r.text, path).not.toContain(totp);
            expect(r.text, path).not.toContain(token);
          }
        }
      ),
      { numRuns: 8 }
    );
  });

  it('keeps the token, Host and x-studio-request checks', async () => {
    expect((await rawRequest(handle, 'GET', '/api/workflows', { host: `127.0.0.1:${handle.port}` })).status).not.toBe(200);
    expect((await get('/api/workflows', { host: 'evil.example.test' })).status).not.toBe(200);
    expect((await rawRequest(handle, 'POST', '/api/playground/call', { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token, 'content-type': 'application/json' }, '{}')).status).not.toBe(200);
  });
});
