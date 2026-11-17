import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Compiler } from '../../compiler/compiler.js';
import { PbtGenerator } from '../../pbt/pbt-generator.js';
import { SchemaInferencer } from '../../schema/schema-inferencer.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../workflow/workflow-set.js';
import { mergeSandboxSpec, validateSandboxSpec } from '../../sandbox/dockerfile.js';
import type { CompileResult, SandboxSpec, WorkflowSet } from '../../types.js';
import { applySuggestions, mergeMissing, readSuggestionsFile, suggestionsPathFor, writeSuggestionsFile } from '../../suggest/apply.js';
import { createSuggester, type CreateSuggesterOptions, type SuggestMode } from '../../suggest/model-suggester.js';

export interface CompileOptions {
  /** Run `npm install` in the output directory once it is written. */
  install?: boolean;
  /** How to install; replaced in tests. */
  installer?: (dir: string) => Promise<void>;
  /**
   * Level 1: `auto` executes the recorded HTTP request of every step that has one, without a browser when
   * all steps do; `off` (default) replays through the page only.
   */
  http?: 'off' | 'auto';
  /**
   * Emit the Heal modules and copy the recorded thumbnails to `<out>/.daemonize/anchors/`, so the server can be run
   * with `--heal`. Off by default: the server then contains no model code at all.
   */
  healSupport?: boolean;
  /** `--sandbox-*` flags: added to the `sandbox` block of the workflow file (which is rewritten), so the compiled project is self-describing. */
  sandbox?: SandboxSpec;
  /**
   * --suggest: write <file>.suggestions.json first. Off by default: without it no model is ever contacted (the accepted
   * entries of an existing suggestions file are still applied).
   */
  suggest?: SuggestOptions;
  /** Progress callback (the Studio shows it). The CLI passes none and its output does not change. */
  onPhase?: (phase: CompilePhase) => void;
}

export type CompilePhase = 'generating' | 'writing' | 'installing';

export interface SuggestOptions extends CreateSuggesterOptions {
  mode: SuggestMode;
  /** --suggest-force: replace the file instead of adding only what it lacks. */
  force?: boolean;
  /** --suggest-graph: a State_Graph file whose final screens give the Result_Zone suggestion something to look at. */
  graphFile?: string;
}

/** The value of `--http`: the bare flag means auto. */
export function parseHttpMode(value: string | boolean | undefined): 'off' | 'auto' {
  if (value === undefined || value === false || value === 'off') return 'off';
  if (value === true || value === 'auto') return 'auto';
  throw new Error(`Unknown --http mode "${String(value)}": use auto or off`);
}

/**
 * Infer the schemas of a recorded Workflow set and compile it into the
 * OpenAPI spec, MCP server, Kiro Power manifest and name map, plus a
 * property-based test suite for every action's input schema.
 */
export async function compile(
  file: string,
  outDir: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  options.onPhase?.('generating');
  const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
  await persistSandboxFlags(file, set, options.sandbox);
  if (options.suggest !== undefined) await writeSuggestions(file, set, options.suggest);
  const { set: suggested, toolNames: toolNameOverrides } = await acceptedSuggestions(file, set);
  const annotated = new SchemaInferencer().inferWorkflows(suggested);
  if (options.http === 'auto' && set.targetType !== 'web') {
    console.warn('--http only applies to web targets: ignored for a terminal program.');
  }
  if (options.healSupport === true && set.targetType !== 'web') {
    console.warn('--heal-support only applies to web targets: ignored for a terminal program.');
  }
  const result = await new Compiler().compile(annotated, outDir, {
    http: options.http ?? 'off',
    healSupport: options.healSupport === true,
    workflowFile: file,
    toolNameOverrides,
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  });
  if (options.healSupport === true && set.targetType === 'web') {
    console.log(`Heal support compiled in: run with "daemonize serve ${outDir} --heal" and the DAEMONIZE_MODEL_* variables. Recorded thumbnails were copied to ${join(outDir, '.daemonize', 'anchors')}.`);
  }

  const tests = await new PbtGenerator().generate(annotated, result.toolNames, outDir);
  console.log(`Generated ${tests.files.length} test file(s) in ${join(outDir, 'tests')}`);
  for (const { tool, reason } of tests.skipped) {
    console.warn(`Property tests skipped for "${tool}": ${reason}`);
  }

  if (options.install) {
    options.onPhase?.('installing');
    await (options.installer ?? npmInstall)(outDir);
  } else {
    // Nothing is downloaded unless the user asked for it
    console.log(`Next: run "npm install" in ${outDir}, then "npm test" for the property tests or "daemonize serve ${outDir}".`);
  }

  return result;
}

/** Install the dependencies of the generated project; fails when npm does. */
function npmInstall(dir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // npm is a .cmd script on Windows, which only a shell can start
    const child = spawn('npm', ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install failed in ${dir} (exit code ${code})`))
    );
  });
}

/** Add the sandbox flags to the set and to its file. Fails before anything is written when a value is not valid. */
async function persistSandboxFlags(file: string, set: WorkflowSet, flags: SandboxSpec | undefined): Promise<void> {
  if (flags === undefined || Object.values(flags).every((v) => v === undefined)) return;
  const merged = mergeSandboxSpec(set.sandbox, flags);
  validateSandboxSpec(merged, set.targetType);
  if (merged !== undefined) set.sandbox = merged;
  await writeFile(file, serializeWorkflowSet(set));
}
/** The final screens of the workflows, from a State_Graph file (by workflow id). */
async function finalSnapshotsFrom(graphFile: string, set: WorkflowSet): Promise<Map<string, string>> {
  const graph = JSON.parse(await readFile(graphFile, 'utf-8')) as { screens?: Record<string, { snapshot?: string }> };
  const snapshots = new Map<string, string>();
  for (const workflow of set.workflows) {
    const snapshot = workflow.finalScreenId === undefined ? undefined : graph.screens?.[workflow.finalScreenId]?.snapshot;
    if (typeof snapshot === 'string') snapshots.set(workflow.id, snapshot);
  }
  return snapshots;
}

/** `--suggest`: ask the suggester, write or merge `<file>.suggestions.json`, and say which source ran. */
async function writeSuggestions(file: string, set: WorkflowSet, options: SuggestOptions): Promise<void> {
  const path = suggestionsPathFor(file);
  const finalSnapshots = options.graphFile === undefined ? undefined : await finalSnapshotsFrom(options.graphFile, set);
  const fresh = await createSuggester(options.mode, options).suggest(set, { finalSnapshots });
  const existing = options.force === true ? undefined : await readSuggestionsFile(path);
  let written = fresh;
  let note = '';
  if (existing !== undefined) {
    const { merged, added, keptAccepted } = mergeMissing(existing, fresh);
    written = merged;
    note = ` (kept your edits; added ${added} missing item(s)${keptAccepted > 0 ? `, left ${keptAccepted} accepted entr${keptAccepted > 1 ? 'ies' : 'y'} untouched` : ''})`;
  }
  await writeSuggestionsFile(path, written);
  const source = fresh.source === 'model' ? `model ${fresh.model ?? ''}`.trim() : 'deterministic rules';
  console.log(`Suggestions from ${source}: ${fresh.workflows.length} workflow(s) written to ${path}${note}.`);
  if (fresh.fallbackReason !== undefined) console.warn(`Deterministic rules were used instead of a model: ${fresh.fallbackReason}.`);
  console.log('Edit the file and set "accepted": true on an entry to use it; "compile" applies accepted entries only.');
}

/** Apply the accepted entries of `<file>.suggestions.json` when it exists; names and texts only. */
async function acceptedSuggestions(file: string, set: WorkflowSet): Promise<{ set: WorkflowSet; toolNames: Record<string, string> }> {
  const suggestions = await readSuggestionsFile(suggestionsPathFor(file));
  if (suggestions === undefined) return { set, toolNames: {} };
  const result = applySuggestions(set, suggestions);
  if (result.applied.length > 0) console.log(`Applied ${result.applied.length} accepted suggestion(s) from ${suggestionsPathFor(file)}.`);
  for (const reason of result.skipped) console.warn(`Suggestion skipped, ${reason}.`);
  return { set: result.set, toolNames: result.toolNames };
}