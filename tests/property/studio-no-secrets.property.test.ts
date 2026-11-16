import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
import fc from 'fast-check';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { redactForStudio } from '../../src/studio/redact.js';
import {
  NO_OUTPUTS,
  buildGraph,
  buildOverview,
  buildPbtView,
  buildSchemas,
  buildWorkflows,
  type StudioTarget,
} from '../../src/studio/model.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest } from '../helpers/http.js';

// Six distinct secret values. The first three are known to the Studio (environment, storage state): wherever the
// model copies text (labels, descriptions, schemas) the redactor must catch them. The other three are planted where
// the model must never copy anything from (typed values, headers, bodies, credentials of URLs, command arguments).
const secretValues = fc
  .uniqueArray(fc.stringMatching(/^[A-Za-z0-9]{12,20}$/), { minLength: 6, maxLength: 6 })
  .map((values) => values.map((v) => `Zq9-${v}`));
const affix = fc.stringMatching(/^[a-z ]{0,6}$/);
const uuidArb = fc.uuid().map((u) => `${u.slice(0, 14)}4${u.slice(15, 19)}8${u.slice(20)}`);

interface Plan {
  secrets: string[];
  pre: string;
  post: string;
  targetType: 'web' | 'tui';
  stepKinds: Array<'type' | 'click' | 'keypress'>;
  id: string;
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  secrets: secretValues,
  pre: affix,
  post: affix,
  targetType: fc.constantFrom('web' as const, 'tui' as const),
  stepKinds: fc.array(fc.constantFrom('type' as const, 'click' as const, 'keypress' as const), { minLength: 1, maxLength: 5 }),
  id: uuidArb,
});

/** A text carrying one of the known secrets (0 to 2). */
const known = (p: Plan, k: number): string => `${p.pre}${p.secrets[k % 3]}${p.post}`;
/** A text carrying one of the secrets the model must never copy (3 to 5). */
const hidden = (p: Plan, k: number): string => `${p.pre}${p.secrets[3 + (k % 3)]}${p.post}`;

function buildSet(p: Plan): WorkflowSet {
  const steps: WorkflowStep[] = p.stepKinds.map((kind, i) => ({
    actionType: kind,
    selectors: [`#${known(p, i)}`.replace(/\s/g, '')],
    value: hidden(p, i),
    label: known(p, i + 1),
    anchor: { role: 'textbox', name: known(p, i + 2), parent: { kind: 'dialog', name: known(p, i) }, frame: [] },
    secretRef: i % 3 === 0 ? 'API_TOKEN' : undefined,
    risk: i % 2 === 0 ? 'read' : 'write',
    http: {
      method: 'POST',
      url: `https://user:${hidden(p, i + 1).replace(/\s/g, '')}@h.test/p/${i}?token=${hidden(p, i + 2).replace(/\s/g, '')}`,
      query: { token: hidden(p, i) },
      headers: { Authorization: `Bearer ${hidden(p, i)}`, Cookie: hidden(p, i + 1) },
      body: { password: hidden(p, i + 2) },
      bindings: [],
      redacted: [],
      auth: 'storageState',
    },
    visual: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, intent: known(p, i + 1), thumbnailPath: `x.assets/${known(p, i).replace(/\s/g, '')}.png` },
    waitFor: { text: known(p, i), timeoutMs: 5 },
    rowBinding: { container: { selectorHint: known(p, i) }, key: { text: hidden(p, i), column: known(p, i + 1) }, variable: 'v' },
  }));
  const workflow: Workflow = {
    id: p.id,
    label: known(p, 0),
    description: known(p, 1),
    steps,
    variables: [{ name: 'v', description: known(p, 2) }],
    secrets: [{ name: 'API_TOKEN', kind: 'token' }],
    observedPayloads: [{ x: hidden(p, 0) }],
    inputSchema: { type: 'object', properties: { v: { type: 'string', description: known(p, 4), default: known(p, 5), enum: [known(p, 0)] } } },
    outputSchema: { type: 'object', description: known(p, 1) },
  };
  return {
    version: '1',
    targetType: p.targetType,
    targetName: known(p, 2),
    startUrl: `https://u:${hidden(p, 0).replace(/\s/g, '')}@h.test/start?apikey=${hidden(p, 1).replace(/\s/g, '')}`,
    startCommand: ['prog', '--password', hidden(p, 2)],
    storageState: `/home/${hidden(p, 0).replace(/\s/g, '')}/state.json`,
    sandbox: { image: 'debian:12', packages: ['curl'], install: [`echo ${hidden(p, 1)}`], mounts: [`${hidden(p, 2).replace(/\s/g, '')}:/x`] },
    workflows: [workflow],
  };
}

const gone = (text: string, secrets: readonly string[]): string | undefined => secrets.find((s) => text.includes(s));

describe('Studio responses never contain secret values', () => {
  // Feature: daemonize, Property 20: Studio responses never contain secret values
  it('holds for every view model, whatever the workflow carries', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const set = buildSet(plan);
        const target: StudioTarget = { set, outputs: { ...NO_OUTPUTS, nameMap: { [plan.id]: 'tool_name' } } };
        const env = { DAEMONIZE_SECRET_API_TOKEN: plan.secrets[0] };
        const stateGraph = { screens: { a: { id: 'a', label: known(plan, 0), snapshot: hidden(plan, 0) } }, transitions: [] };
        const views = [
          buildOverview([target], false),
          buildWorkflows([target]),
          buildGraph([target]),
          buildGraph([target], stateGraph),
          buildSchemas([target]),
          buildPbtView(undefined, [target], false),
        ];
        for (const view of views) {
          const text = JSON.stringify(redactForStudio(view, { env, secretValues: [plan.secrets[1], plan.secrets[2]] }));
          const leaked = gone(text, plan.secrets);
          if (leaked !== undefined) return false;
        }
        return true;
      }),
      { numRuns: 150 }
    );
  });

  describe('through the HTTP server', () => {
    let dir: string;
    let handle: StudioHandle;
    const env: Record<string, string | undefined> = {};
    const file = (): string => join(dir, 'workflows.json');

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'studio-prop-'));
      await mkdir(join(dir, 'auth'), { recursive: true });
      handle = await startStudio({ workflowFile: file(), outDir: join(dir, 'out'), env, staticDir: join(dir, 'ui') });
    });
    afterAll(async () => {
      await handle?.close();
      if (dir) await removeDir(dir);
    });

    // Feature: daemonize, Property 20: Studio responses never contain secret values
    it('holds for every API response of a server reading files with planted secrets', async () => {
      await fc.assert(
        fc.asyncProperty(planArb, async (plan) => {
          // A file the loader accepts: no typed value on a secret step, no literal credential in a request
          const set = buildSet(plan);
          set.targetType = 'web';
          delete set.startCommand;
          set.storageState = 'auth/state.json';
          for (const wf of set.workflows) {
            wf.steps = wf.steps.map((s, i) => {
              const { http: _http, ...rest } = s;
              void _http;
              return { ...rest, secretRef: undefined, totp: undefined, label: s.label?.replace(/pass(word|wd)/gi, ''), value: i % 2 === 0 ? undefined : s.value };
            });
            wf.secrets = [{ name: 'API_TOKEN', kind: 'token' }];
            // Not part of the workflow file
            delete wf.description;
          }
          await writeFile(file(), serializeWorkflowSet(set));
          // The storage state holds cookie values; the environment holds a secret
          await writeFile(join(dir, 'auth', 'state.json'), JSON.stringify({ cookies: [{ name: 'sid', value: plan.secrets[1] }], origins: [{ origin: 'https://h.test', localStorage: [{ name: 'k', value: plan.secrets[2] }] }] }));
          env.DAEMONIZE_SECRET_API_TOKEN = plan.secrets[0];
          for (const path of ['/api/health', '/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt']) {
            const r = await rawRequest(handle, 'GET', path, { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token });
            expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBe(200);
            // The typed constant of a step (hidden secrets 3 to 5) is not part of any view either
            const leaked = gone(r.text, plan.secrets);
            expect(leaked, `${path} leaked ${leaked}`).toBeUndefined();
          }
        }),
        { numRuns: 12 }
      );
    });
  });
});
