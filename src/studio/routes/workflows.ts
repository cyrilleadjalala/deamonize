/** The routes of the workflow editor: `POST /api/workflows/update` and `POST /api/workflows/delete`. */
import { readFile } from 'node:fs/promises';
import { deserializeWorkflowSet } from '../../workflow/workflow-set.js';
import type { WorkflowSet } from '../../types.js';
import { LOAD_UNREADABLE, SAMPLE_MODE, UNEXPECTED_FIELD } from '../messages/common.js';
import * as text from '../messages/workflows.js';
import { NO_OUTPUTS, buildWorkflowView, type StudioOutputs } from '../model.js';
import { redactForStudio } from '../redact.js';
import { WorkflowContentError, applyDelete, applyUpdate, cleanAssets, writeWorkflowFileAtomic } from '../workflow-editor.js';
import type { RouteContext, RouteDef, RouteResponse } from './types.js';

type Recompile = 'started' | 'not-needed' | 'busy';

export function workflowRoutes(ctx: RouteContext): RouteDef[] {
  const { recording, compiler } = ctx.services;

  /** A running recording or compile: a plain message that names it. */
  const runningOperation = (): string | undefined => {
    if (recording.isActive()) return text.EDIT_RUNNING_RECORDING;
    if (compiler.status().state === 'running') return text.EDIT_RUNNING_BUILD;
    return undefined;
  };
  const readSet = async (): Promise<WorkflowSet | undefined> => {
    try {
      return deserializeWorkflowSet(await readFile(ctx.workflowFile, 'utf-8'));
    } catch {
      return undefined;
    }
  };
  const outputsNow = async (): Promise<StudioOutputs> => {
    try {
      return (await ctx.loadSet()).outputs;
    } catch {
      return NO_OUTPUTS;
    }
  };
  const recompile = (compiled: boolean): Recompile => (!compiled ? 'not-needed' : compiler.tryStart() ? 'started' : 'busy');
  const safe = (response: RouteResponse): RouteResponse => ({
    status: response.status,
    body: redactForStudio(response.body, { env: ctx.studioEnv }),
  });
  /** The write step shared by both routes: 400 when the content is refused, 500 when the file cannot be written. */
  const write = async (set: WorkflowSet, notSaved: string): Promise<RouteResponse | undefined> => {
    try {
      await writeWorkflowFileAtomic(ctx.workflowFile, set);
      return undefined;
    } catch (err) {
      if (err instanceof WorkflowContentError) return { status: 400, body: { error: text.EDIT_REFUSED_CONTENT } };
      return { status: 500, body: { error: notSaved } };
    }
  };

  return [
    {
      path: '/api/workflows/update',
      remote: 'blocked',
      handlers: {
        POST: async ({ body }) => {
          if (ctx.sample) return { status: 409, body: { error: SAMPLE_MODE } };
          const running = runningOperation();
          if (running !== undefined) return { status: 409, body: { error: running } };
          const set = await readSet();
          if (set === undefined) return { status: 409, body: { error: LOAD_UNREADABLE } };
          const edit = applyUpdate(set, body);
          if (!edit.ok) {
            return { status: edit.status, body: { error: edit.error, ...(edit.field === undefined ? {} : { field: edit.field }), ...(edit.index === undefined ? {} : { index: edit.index }) } };
          }
          const failed = await write(edit.value, text.EDIT_NOT_SAVED);
          if (failed !== undefined) return failed;
          const outputs = await outputsNow();
          const workflow = edit.value.workflows.find((w) => w.id === body.id);
          if (workflow === undefined) return { status: 500, body: { error: text.EDIT_NOT_SAVED } };
          const view = buildWorkflowView(edit.value, workflow, outputs);
          return safe({ status: 200, body: { workflow: view, recompile: recompile(outputs.flags.compiled) } });
        },
      },
    },
    {
      path: '/api/workflows/delete',
      remote: 'blocked',
      handlers: {
        POST: async ({ body }) => {
          if (ctx.sample) return { status: 409, body: { error: SAMPLE_MODE } };
          for (const field of Object.keys(body)) {
            if (field !== 'id') return { status: 400, body: { error: UNEXPECTED_FIELD, field } };
          }
          const running = runningOperation();
          if (running !== undefined) return { status: 409, body: { error: running } };
          const set = await readSet();
          if (set === undefined) return { status: 409, body: { error: LOAD_UNREADABLE } };
          const deletion = applyDelete(set, body.id);
          if (!deletion.ok) return { status: deletion.status, body: { error: deletion.error, ...(deletion.field === undefined ? {} : { field: deletion.field }) } };
          const failed = await write(deletion.value.set, text.DELETE_NOT_SAVED);
          if (failed !== undefined) return failed;
          const remaining = deletion.value.set.workflows.length;
          const cleanup = await cleanAssets(ctx.workflowFile, deletion.value.set).catch((): 'partial' => 'partial');
          const outputs = await outputsNow();
          const answer: Recompile = remaining >= 1 ? recompile(outputs.flags.compiled) : 'not-needed';
          return safe({
            status: 200,
            body: { ok: true, remaining, recompile: answer === 'busy' ? 'not-needed' : answer, ...(cleanup === 'partial' ? { cleanup } : {}) },
          });
        },
      },
    },
  ];
}
