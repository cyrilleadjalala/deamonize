import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InertRecordingManager } from '../../src/studio/inert-services.js';
import type { CompileOptionsInput, CompileRunner, CompileStatus, StudioServices } from '../../src/studio/contracts.js';
import { workflowRoutes } from '../../src/studio/routes/workflows.js';
import type { RouteContext, RouteDef, RouteMethod, RouteResponse } from '../../src/studio/routes/types.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { NO_OUTPUTS } from '../../src/studio/model.js';
import { LOAD_UNREADABLE, SAMPLE_MODE, UNEXPECTED_FIELD } from '../../src/studio/messages/common.js';
import { WORKFLOW_NOT_FOUND } from '../../src/studio/messages/workflows.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest } from '../helpers/http.js';
import type { WorkflowSet } from '../../src/types.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
// Built at run time so the file holds no credential-like literal
const PLAIN_SECRET = ['S3cret', 'Value', 'do-not-leak'].join('');

function makeSet(): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'Shop',
    startUrl: 'https://shop.example.com/',
    workflows: [
      {
        id: A,
        label: 'Find order',
        steps: [
          { actionType: 'type', selectors: ['role=textbox'], variable: 'order_id', value: '12' },
          { actionType: 'click', selectors: ['role=button'], visual: { thumbnailPath: 'daemonize.workflows.json.assets/shot-a.png', rect: { x: 0, y: 0, w: 1, h: 1 }, intent: 'go' } },
        ],
        variables: [{ name: 'order_id', type: 'string' }, { name: 'note', type: 'string', optional: true }],
        observedPayloads: [{ order_id: '12' }],
      },
      {
        id: B,
        label: 'Cancel order',
        steps: [{ actionType: 'click', selectors: ['role=button'], visual: { thumbnailPath: 'daemonize.workflows.json.assets/shot-b.png', rect: { x: 0, y: 0, w: 1, h: 1 }, intent: 'cancel' } }],
        variables: [],
        observedPayloads: [],
      },
    ],
  };
}

class Recording extends InertRecordingManager {
  active = false;
  override isActive(): boolean {
    return this.active;
  }
}
class Compiler implements CompileRunner {
  state: CompileStatus['state'] = 'idle';
  accept = true;
  starts: Array<CompileOptionsInput | undefined> = [];
  status(): CompileStatus {
    return { state: this.state, phase: null };
  }
  tryStart(options?: CompileOptionsInput): boolean {
    this.starts.push(options);
    return this.accept;
  }
  async runExclusive() {
    return { ok: true as const };
  }
  options(): CompileOptionsInput {
    return { http: 'off', healSupport: false };
  }
  async close(): Promise<void> { }
}

describe('workflow editor routes', () => {
  let dir: string;
  let file: string;
  let recording: Recording;
  let compiler: Compiler;
  let compiled: boolean;
  let sample: boolean;
  let unreadable: boolean;
  let routes: RouteDef[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-routes-'));
    file = join(dir, 'daemonize.workflows.json');
    await writeFile(file, serializeWorkflowSet(makeSet()));
    await mkdir(`${file}.assets`);
    for (const name of ['shot-a.png', 'shot-b.png']) await writeFile(join(`${file}.assets`, name), 'png');
    recording = new Recording();
    compiler = new Compiler();
    compiled = false;
    sample = false;
    unreadable = false;
    const ctx = {
      services: { recording, compiler } as unknown as StudioServices,
      workflowFile: file,
      outDir: join(dir, 'out'),
      get sample() {
        return sample;
      },
      studioEnv: {},
      loadSet: async () => {
        if (unreadable) throw new Error('unreadable');
        return { set: undefined, outputs: { flags: { ...NO_OUTPUTS.flags, compiled } } };
      },
    } as unknown as RouteContext;
    routes = workflowRoutes(ctx);
  });
  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => undefined);
    await removeDir(dir);
  });

  const call = async (path: string, body: Record<string, unknown>, method: RouteMethod = 'POST'): Promise<RouteResponse> => {
    const handler = routes.find((r) => r.path === path)?.handlers[method];
    if (handler === undefined) throw new Error(`no ${method} ${path}`);
    return handler({ method, query: new URLSearchParams(), body, signal: new AbortController().signal });
  };
  const update = (body: Record<string, unknown>) => call('/api/workflows/update', body);
  const del = (body: Record<string, unknown>) => call('/api/workflows/delete', body);
  const onDisk = async (): Promise<string> => readFile(file, 'utf-8');
  const noTemporary = async (): Promise<void> => expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);

  it('registers two remote-blocked routes that accept only POST', () => {
    expect(routes.map((r) => [r.path, Object.keys(r.handlers), r.remote])).toEqual([
      ['/api/workflows/update', ['POST'], 'blocked'],
      ['/api/workflows/delete', ['POST'], 'blocked'],
    ]);
  });

  describe('POST /api/workflows/update', () => {
    it('writes a valid request, answers the updated view and no rebuild when nothing is built', async () => {
      const res = await update({ id: A, label: ' Find an order ', description: 'Looks an order up by number' });
      expect(res.status).toBe(200);
      const body = res.body as { workflow: { label: string; description: string; variables: unknown[] }; recompile: string };
      expect(body.recompile).toBe('not-needed');
      expect(body.workflow.label).toBe('Find an order');
      expect(body.workflow.description).toBe('Looks an order up by number');
      const saved = deserializeWorkflowSet(await onDisk());
      expect(saved.workflows[0].label).toBe('Find an order');
      expect(saved.workflows[1]).toEqual(makeSet().workflows[1]);
      expect(compiler.starts).toEqual([]);
      await noTemporary();
    });

    it('renames and retypes a variable and shows optional and whenOmitted in the view', async () => {
      const res = await update({ id: A, variables: [{ name: 'order_id', newName: 'order_number', type: 'number' }, { name: 'note', optional: true, whenOmitted: 'skip' }] });
      expect(res.status).toBe(200);
      const view = (res.body as { workflow: { variables: Array<Record<string, unknown>> } }).workflow;
      expect(view.variables).toEqual([
        { name: 'order_number', type: 'number', optional: false },
        { name: 'note', type: 'string', optional: true, whenOmitted: 'skip' },
      ]);
      const saved = deserializeWorkflowSet(await onDisk());
      expect(saved.workflows[0].observedPayloads).toEqual([{ order_number: 12 }]);
      expect(saved.workflows[0].steps[0].variable).toBe('order_number');
    });

    it('answers 400 with the field and index and leaves the file as it was', async () => {
      const before = await onDisk();
      const res = await update({ id: A, variables: [{ name: 'order_id' }, { name: 'nope', newName: 'x' }] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ field: 'variables', index: 1 });
      expect((await update({ id: A })).status).toBe(400);
      expect(await update({ id: A, label: 'x', extra: 1 })).toEqual({ status: 400, body: { error: UNEXPECTED_FIELD, field: 'extra' } });
      expect(await update({ label: 'x' })).toMatchObject({ status: 400, body: { field: 'id' } });
      expect(await onDisk()).toBe(before);
      await noTemporary();
    });

    it('answers 404 for an unknown id', async () => {
      expect(await update({ id: 'missing', label: 'x' })).toEqual({ status: 404, body: { error: WORKFLOW_NOT_FOUND } });
    });

    it('answers 409 in sample mode and writes nothing', async () => {
      sample = true;
      const before = await onDisk();
      expect(await update({ id: A, label: 'x' })).toEqual({ status: 409, body: { error: SAMPLE_MODE } });
      expect(await onDisk()).toBe(before);
    });

    it('answers 409 while a recording or a build runs, and when the file is unreadable', async () => {
      recording.active = true;
      const recordingRes = await update({ id: A, label: 'x' });
      expect(recordingRes.status).toBe(409);
      recording.active = false;
      compiler.state = 'running';
      const buildRes = await update({ id: A, label: 'x' });
      expect(buildRes.status).toBe(409);
      expect((recordingRes.body as { error: string }).error).not.toBe((buildRes.body as { error: string }).error);
      compiler.state = 'idle';
      await writeFile(file, '{ not json');
      expect(await update({ id: A, label: 'x' })).toEqual({ status: 409, body: { error: LOAD_UNREADABLE } });
      expect(await readFile(file, 'utf-8')).toBe('{ not json');
    });

    it('starts a rebuild when a compiled tool exists, and keeps the file when a build began meanwhile', async () => {
      compiled = true;
      const started = await update({ id: A, label: 'One' });
      expect(started.body).toMatchObject({ recompile: 'started' });
      expect(compiler.starts).toEqual([undefined]);
      compiler.accept = false;
      const busy = await update({ id: A, label: 'Two' });
      expect(busy).toMatchObject({ status: 200, body: { recompile: 'busy' } });
      expect(deserializeWorkflowSet(await onDisk()).workflows[0].label).toBe('Two');
    });

    it('does not leak a typed value in an answer', async () => {
      const res = await update({ id: A, label: 'x', description: `see https://x.example.com ${PLAIN_SECRET}` });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SECRET);
    });
  });

  describe('POST /api/workflows/delete', () => {
    it('deletes one workflow, keeps the other, and cleans only its thumbnail', async () => {
      const res = await del({ id: A });
      expect(res).toEqual({ status: 200, body: { ok: true, remaining: 1, recompile: 'not-needed' } });
      expect(deserializeWorkflowSet(await onDisk()).workflows.map((w) => w.id)).toEqual([B]);
      expect((await readdir(`${file}.assets`)).sort()).toEqual(['shot-b.png']);
      expect(compiler.starts).toEqual([]);
      await noTemporary();
    });

    it('keeps a loadable file with no workflows after the last deletion and starts no build', async () => {
      compiled = true;
      expect((await del({ id: A })).body).toMatchObject({ remaining: 1, recompile: 'started' });
      expect(await del({ id: B })).toEqual({ status: 200, body: { ok: true, remaining: 0, recompile: 'not-needed' } });
      expect(deserializeWorkflowSet(await onDisk()).workflows).toEqual([]);
      expect(compiler.starts).toHaveLength(1);
    });

    it('answers 400 for a bad body and 404 for an unknown id, writing nothing', async () => {
      const before = await onDisk();
      expect(await del({ id: A, extra: true })).toEqual({ status: 400, body: { error: UNEXPECTED_FIELD, field: 'extra' } });
      for (const body of [{}, { id: '' }, { id: 4 }, { id: 'x'.repeat(201) }]) {
        expect(await del(body)).toMatchObject({ status: 400, body: { field: 'id' } });
      }
      expect(await del({ id: 'missing' })).toEqual({ status: 404, body: { error: WORKFLOW_NOT_FOUND } });
      expect(await onDisk()).toBe(before);
      expect((await readdir(`${file}.assets`)).sort()).toEqual(['shot-a.png', 'shot-b.png']);
    });

    it('answers 409 in sample mode, while something runs, and for an unreadable file', async () => {
      sample = true;
      expect(await del({ id: A })).toEqual({ status: 409, body: { error: SAMPLE_MODE } });
      sample = false;
      recording.active = true;
      expect((await del({ id: A })).status).toBe(409);
      recording.active = false;
      compiler.state = 'running';
      expect((await del({ id: A })).status).toBe(409);
      compiler.state = 'idle';
      await writeFile(file, 'nope');
      expect(await del({ id: A })).toEqual({ status: 409, body: { error: LOAD_UNREADABLE } });
      expect((await readdir(`${file}.assets`)).sort()).toEqual(['shot-a.png', 'shot-b.png']);
    });

    it('answers 500 and keeps the file and the thumbnails when the write fails', async () => {
      const before = await onDisk();
      // A read-only file cannot be replaced by the rename of the temporary file
      await chmod(file, 0o444);
      try {
        const res = await del({ id: A });
        expect(res.status).toBe(500);
        expect(compiler.starts).toEqual([]);
      } finally {
        await chmod(file, 0o644);
      }
      expect(await onDisk()).toBe(before);
      expect((await readdir(`${file}.assets`)).sort()).toEqual(['shot-a.png', 'shot-b.png']);
      await noTemporary();
    });

    it('adds cleanup partial when the thumbnails cannot be cleaned, and still answers 200', async () => {
      await removeDir(`${file}.assets`);
      await writeFile(`${file}.assets`, 'not a folder');
      expect((await del({ id: A })).body).toEqual({ ok: true, remaining: 1, recompile: 'not-needed', cleanup: 'partial' });
      expect(deserializeWorkflowSet(await onDisk()).workflows.map((w) => w.id)).toEqual([B]);
    });

    it('skips a folder named like a thumbnail', async () => {
      await mkdir(join(`${file}.assets`, 'folder.png'));
      expect((await del({ id: A })).body).toEqual({ ok: true, remaining: 1, recompile: 'not-needed' });
      expect((await readdir(`${file}.assets`)).sort()).toEqual(['folder.png', 'shot-b.png']);
    });
    it('answers the recompile values started and not-needed', async () => {
      compiled = true;
      expect((await del({ id: A })).body).toMatchObject({ recompile: 'started' });
    });
  });

  describe('through the Studio server', () => {
    let handle: StudioHandle | undefined;
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
    });
    const open = async (sampleData = false) => {
      handle = await startStudio({ workflowFile: file, outDir: join(dir, 'out'), env: {}, sampleData, playground: false });
      const h = handle;
      return (method: string, path: string, body?: string) =>
        rawRequest(h, method, path, { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, 'x-studio-request': '1', origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' }, body);
    };

    it('answers 405 with Allow: POST for GET and other methods on both routes', async () => {
      const request = await open();
      for (const path of ['/api/workflows/delete', '/api/workflows/update']) {
        for (const method of ['GET', 'PUT', 'DELETE']) {
          const res = await request(method, path);
          expect(res.status, `${method} ${path}`).toBe(405);
          expect(res.headers.allow).toBe('POST');
        }
      }
      expect(deserializeWorkflowSet(await onDisk()).workflows).toHaveLength(2);
    });

    it('updates and deletes through HTTP, and answers 409 SAMPLE_MODE in sample mode', async () => {
      const request = await open();
      const updated = await request('POST', '/api/workflows/update', JSON.stringify({ id: A, label: 'Renamed' }));
      expect(updated.status).toBe(200);
      expect(JSON.parse(updated.text).workflow.label).toBe('Renamed');
      const deleted = await request('POST', '/api/workflows/delete', JSON.stringify({ id: B }));
      expect(JSON.parse(deleted.text)).toEqual({ ok: true, remaining: 1, recompile: 'not-needed' });
      await handle?.close();
      handle = undefined;
      const sampleRequest = await open(true);
      const refused = await sampleRequest('POST', '/api/workflows/delete', JSON.stringify({ id: A }));
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.text).error).toBe(SAMPLE_MODE);
    });
  });
});
