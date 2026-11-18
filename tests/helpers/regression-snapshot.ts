/**
 * Builds the regression snapshot of one Workflow_File (Requirement 24.3): what the loader, the compiler and the
 * pure replay runtime make of it. The snapshot is captured once, before any feature changes a source file.
 *
 * The snapshot holds no timestamp, absolute path, port, random id or duration.
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler, type CompileOptions } from '../../src/compiler/compiler.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { buildRowLocator } from '../../src/replay/runtime/row-resolver.js';
import { planLocators, type StepLike } from '../../src/replay/runtime/step-plan.js';
import { buildRequest, planSteps, type HttpRecipeLike } from '../../src/replay/runtime/http-replay.js';
import { launchReplayBrowser } from '../../src/replay/runtime/browser-launch.js';
import { createWebRun, executeWebStep } from '../../src/replay/runtime/web-steps.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { removeDir } from './cleanup.js';

export const OPTION_SETS: Record<string, CompileOptions> = {
  default: {},
  http: { http: 'auto' },
  heal: { healSupport: true },
};

/** The generated files whose full text is part of the snapshot. */
export const SNAPSHOT_TEXTS = ['mcp-server.ts', 'replay.ts', 'docker-replay.ts'] as const;

export interface OptionSnapshot {
  nameMap: Record<string, string>;
  /** The OpenAPI document: it holds the input schema of every tool. */
  openapi: unknown;
  /** Every file written in the output folder, relative, forward slashes, sorted. */
  files: string[];
  /** `sandbox/image.json` (its `copy` list is the list of runtime files of the image). */
  sandboxImage: { copy: string[]; [key: string]: unknown };
  texts: Record<string, string>;
}

export interface Snapshot {
  loaded: WorkflowSet;
  options: Record<string, OptionSnapshot>;
  trace: unknown[];
  /** Present only when a browser was available. */
  liveReplay?: unknown;
}

/** Keys sorted at every level, so equal values give equal text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

async function compileWith(set: WorkflowSet, options: CompileOptions): Promise<OptionSnapshot> {
  const out = await mkdtemp(join(tmpdir(), 'daemonize-regression-'));
  const log = console.log;
  console.log = () => undefined; // the compiler prints the absolute paths it wrote
  try {
    await new Compiler().compile(structuredClone(set), out, options);
  } finally {
    console.log = log;
  }
  try {
    const texts: Record<string, string> = {};
    for (const name of SNAPSHOT_TEXTS) texts[name] = await readFile(join(out, name), 'utf-8');
    return {
      nameMap: JSON.parse(await readFile(join(out, 'name-map.json'), 'utf-8')),
      openapi: JSON.parse(await readFile(join(out, 'openapi.json'), 'utf-8')),
      files: await listFiles(out),
      sandboxImage: JSON.parse(await readFile(join(out, 'sandbox', 'image.json'), 'utf-8')),
      texts,
    };
  } finally {
    await removeDir(out);
  }
}

/** A fixed argument for each Variable, so the pure trace never depends on the clock or on chance. */
function sampleArguments(workflow: Workflow): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const variable of workflow.variables) {
    if (variable.enum !== undefined) args[variable.name] = variable.enum[variable.enum.length - 1];
    else if (variable.type === 'number') args[variable.name] = 42;
    else if (variable.type === 'boolean') args[variable.name] = true;
    else args[variable.name] = variable.name === 'customer' ? 'Grace Hopper' : `sample ${variable.name}`;
  }
  return args;
}

function attempt<T>(run: () => T): { ok: T } | { error: string } {
  try {
    return { ok: run() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function pureTrace(set: WorkflowSet): unknown[] {
  return set.workflows.map((workflow) => {
    const steps = workflow.steps as unknown as Array<StepLike & { http?: HttpRecipeLike }>;
    const args = sampleArguments(workflow);
    return {
      workflow: workflow.id,
      planSteps: planSteps(steps),
      steps: steps.map((step, index) => ({
        index,
        locatorsWithArguments: attempt(() => planLocators(step, args).map((c) => c.description)),
        locatorsWithoutArguments: attempt(() => planLocators(step, {}).map((c) => c.description)),
        rowLocator: step.rowBinding === undefined ? null : attempt(() => buildRowLocator(step.rowBinding!, args)),
        request:
          step.http === undefined
            ? null
            : attempt(() => {
                const { secrets: _secrets, ...request } = buildRequest(step.http as HttpRecipeLike, args, {});
                return request;
              }),
      })),
    };
  });
}

const LIVE_PAGE = `<!doctype html><html><body>
<label for="note">Note</label><input id="note" name="note">
<label for="plan">Plan</label>
<select id="plan" name="plan"><option value="free">free</option><option value="pro">pro</option></select>
<table><tbody>
<tr><td>Ada Lovelace</td><td><button onclick="document.getElementById('out').textContent='opened Ada'">Open</button></td></tr>
<tr><td>Grace Hopper</td><td><button onclick="document.getElementById('out').textContent='opened Grace'">Open</button></td></tr>
</tbody></table>
<button id="save" onclick="document.getElementById('out').textContent+=' saved'">Save</button>
<p id="out" role="status"></p>
</body></html>`;

/** One real replay of the first web workflow on an inline page. Undefined when no browser can be started. */
async function liveReplay(set: WorkflowSet): Promise<unknown> {
  if (set.targetType !== 'web') return undefined;
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await launchReplayBrowser(chromium);
  } catch {
    return undefined;
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(LIVE_PAGE);
    const run = createWebRun(context, page);
    const workflow = set.workflows[0];
    const args = sampleArguments(workflow);
    const outcomes: unknown[] = [];
    for (const step of workflow.steps as unknown as StepLike[]) {
      try {
        await executeWebStep(run, step, args, { timeoutMs: 5000, env: {} });
        outcomes.push({ ok: true });
      } catch (err) {
        outcomes.push({ ok: false, error: (err as Error).message });
        break;
      }
    }
    const finalState = await page.evaluate(() => ({
      note: (document.getElementById('note') as HTMLInputElement).value,
      plan: (document.getElementById('plan') as HTMLSelectElement).value,
      status: document.getElementById('out')?.textContent ?? '',
    }));
    await context.close();
    return { workflow: workflow.id, outcomes, finalState };
  } finally {
    await browser.close();
  }
}

/** The canonical JSON of the snapshot of a Workflow_File given as text. */
export async function buildSnapshot(file: string): Promise<string> {
  const loaded = deserializeWorkflowSet(file);
  const options: Record<string, OptionSnapshot> = {};
  for (const [name, compileOptions] of Object.entries(OPTION_SETS)) {
    options[name] = await compileWith(loaded, compileOptions);
  }
  const snapshot: Snapshot = { loaded, options, trace: pureTrace(loaded) };
  const live = await liveReplay(loaded);
  if (live !== undefined) snapshot.liveReplay = live;
  return JSON.stringify(canonical(snapshot), null, 2) + '\n';
}

/** Split a snapshot into the files stored on disk: one JSON file plus one text file per generated source. */
export function splitSnapshot(name: string, json: string): Record<string, string> {
  const snapshot = JSON.parse(json) as Snapshot;
  const files: Record<string, string> = {};
  const { liveReplay: live, ...rest } = snapshot;
  if (live !== undefined) files[`${name}.live-replay.json`] = JSON.stringify(canonical(live), null, 2) + '\n';
  for (const [optionName, option] of Object.entries(rest.options)) {
    for (const [textName, text] of Object.entries(option.texts)) files[`${name}.${optionName}.${textName}.txt`] = text;
    option.texts = {};
  }
  files[`${name}.json`] = JSON.stringify(canonical(rest), null, 2) + '\n';
  return files;
}
