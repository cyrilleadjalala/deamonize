/**
 * Requirements 4.1, 4.3, 4.5, 10.4 to 10.8, 10.10, 10.11: the call block of the generated code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler, type CompileOptions } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { SKIP_IN_PATH_MESSAGE } from '../../src/workflow/workflow-scope.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const A = 'a1111111-1111-4111-8111-111111111111';
const B = 'b2222222-2222-4222-8222-222222222222';
const C = 'c3333333-3333-4333-8333-333333333333';

function workflow(id: string, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    label: `Workflow ${id.slice(0, 1)}`,
    steps: [{ actionType: 'type', selectors: ['#nick'], value: 'ada', variable: 'nickname' }, { actionType: 'click', selectors: ['#go'] }],
    variables: [{ name: 'nickname', optional: true, whenOmitted: 'skip' }, { name: 'nickname2' }],
    observedPayloads: [],
    ...extra,
  };
}

const webSet = (workflows: Workflow[]): WorkflowSet => ({
  version: '1',
  targetType: 'web',
  targetName: 'Call Block',
  startUrl: 'https://app.test/start',
  storageState: 'login.json',
  workflows,
});

const tuiSet = (workflows: Workflow[]): WorkflowSet => ({
  version: '1',
  targetType: 'tui',
  targetName: 'Call Term',
  startCommand: ['prog'],
  workflows,
});

async function generated(set: WorkflowSet, options: CompileOptions = {}): Promise<{ server: string; replay: string; docker: string; copy: string[] }> {
  const inferred = new SchemaInferencer().inferWorkflows(set);
  const names = new Map(inferred.workflows.map((w) => [w.id, `tool_${w.id.slice(0, 1)}`]));
  const generator = new McpGenerator();
  return {
    server: generator.generate(inferred, names, options),
    replay: generator.generateReplay(inferred, options),
    docker: generator.generateDockerReplay(inferred, 'img', options),
    copy: generator.generateSandboxFiles(inferred, options).copy,
  };
}

describe('the call block of the generated code', () => {
  it('embeds the Skip_List as names only, once each, per workflow, and no value', async () => {
    const withTwice = workflow(A, { variables: [{ name: 'nickname', optional: true, whenOmitted: 'skip' }, { name: 'nickname', optional: true, whenOmitted: 'skip' }, { name: 'other', optional: true, whenOmitted: 'skip' }] });
    const out = await generated(webSet([withTwice, workflow(B, { variables: [{ name: 'nickname', optional: true }] })]));
    expect(out.server).toContain('{"skip":["nickname","other"]}');
    // the second workflow has no Skip_List and no scope: the call is not passed
    expect(out.server.match(/\{"skip":/g)).toHaveLength(1);
    expect(out.server).not.toContain('"ada"}');
    expect(out.server).toContain('call: WorkflowCall = {}');
    expect(out.replay).toContain('planSkips');
    expect(out.replay).toContain('skippedSteps');
    expect(out.replay).toContain('export type WorkflowCall');
    expect(out.copy).toContain('omission.js');
  });

  it('gives each workflow its own start page and login, null meaning no saved login', async () => {
    const out = await generated(
      webSet([
        workflow(A, { startUrl: 'https://app.test/other', storageState: 'other-login.json' }),
        workflow(B, { storageState: null }),
        workflow(C),
      ]),
    );
    expect(out.server).toContain('"startUrl":"https://app.test/other","storageState":"other-login.json"}');
    expect(out.server).toContain('"storageState":null}');
    expect(out.replay).toContain('if (call.storageState === null) return undefined;');
    expect(out.replay).toContain('overrides.url ?? call.startUrl ?? START_URL');
    expect(out.docker).toContain('call.storageState === null');
    expect(out.docker).toContain('url: URL_OVERRIDE, call }');
    expect(out.replay).toContain('request.call ?? {}');
  });

  it('loops test the skipped set before the action, in web, HTTP and terminal replays', async () => {
    const web = await generated(webSet([workflow(A)]));
    expect(web.replay.indexOf('skippedSet.has(index)')).toBeLessThan(web.replay.indexOf('await runStep(webRun'));
    const http = await generated(webSet([workflow(A)]), { http: 'auto' });
    expect(http.replay).toContain('omittedSkips(args, call.skip)');
    expect(http.replay).toContain('withRecordedDefaults(steps, args, skipped)');
    expect(http.replay.indexOf('skippedSet.has(index)')).toBeLessThan(http.replay.indexOf('plan[index] === "prep"'));
    const term = await generated(tuiSet([workflow(A, { steps: [{ actionType: 'type', selectors: [], value: 'x', variable: 'nickname' }] })]));
    expect(term.replay.indexOf('skippedSet.has(index)')).toBeLessThan(term.replay.indexOf('const wait = step.waitFor'));
    expect(term.replay).toContain('skippedSteps');
  });

  it('a container request carries the call', async () => {
    const out = await generated(webSet([workflow(A)]));
    expect(out.docker).toContain('call: WorkflowCall = {}');
    expect(out.docker).toContain('resolveHostStorageState(call)');
  });

  describe('refusals write no file', () => {
    let parent = '';
    beforeAll(async () => {
      parent = await mkdtemp(join(tmpdir(), 'daemonize-callblock-'));
    });
    afterAll(async () => {
      await removeDir(parent);
    });
    const attempt = async (name: string, set: WorkflowSet, options: CompileOptions = {}): Promise<{ message: string; out: string }> => {
      const out = join(parent, name);
      const log = console.log;
      console.log = () => undefined;
      try {
        await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), out, options);
      } catch (error) {
        return { message: (error as Error).message, out };
      } finally {
        console.log = log;
      }
      throw new Error('compile did not refuse');
    };

    it('a workflow start page on another origin', async () => {
      const { message, out } = await attempt('origin', webSet([workflow(A, { startUrl: 'https://elsewhere.test/x' })]));
      expect(message).toContain(A);
      expect(message).toContain('same origin');
      expect(existsSync(out)).toBe(false);
    });

    it('a workflow start page on a terminal target', async () => {
      const { message, out } = await attempt('terminal', tuiSet([workflow(A, { startUrl: 'https://app.test/x', steps: [{ actionType: 'type', selectors: [], value: 'x' }], variables: [] })]));
      expect(message).toContain('web target only');
      expect(existsSync(out)).toBe(false);
    });

    it('a skipped Variable in a recorded URL path with --http auto', async () => {
      const recipe = { method: 'GET', url: 'https://app.test/api/{{nickname}}', query: {}, bindings: [{ variable: 'nickname', in: 'path' as const, name: '0' }], redacted: [] };
      const w = workflow(A, { steps: [{ actionType: 'click', selectors: ['#go'], http: recipe }] });
      const { message, out } = await attempt('path', webSet([w]), { http: 'auto' });
      expect(message).toBe(SKIP_IN_PATH_MESSAGE(A, 'nickname'));
      expect(existsSync(out)).toBe(false);
      // without --http the same set compiles
      const ok = join(parent, 'path-ok');
      const log = console.log;
      console.log = () => undefined;
      try {
        await new Compiler().compile(new SchemaInferencer().inferWorkflows(webSet([w])), ok, {});
      } finally {
        console.log = log;
      }
      expect(await readFile(join(ok, 'replay.ts'), 'utf-8')).toContain('WorkflowCall');
    });
  });
});
