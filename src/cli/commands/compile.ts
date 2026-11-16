import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Compiler } from '../../compiler/compiler.js';
import { PbtGenerator } from '../../pbt/pbt-generator.js';
import { SchemaInferencer } from '../../schema/schema-inferencer.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../workflow/workflow-set.js';
import { mergeSandboxSpec, validateSandboxSpec } from '../../sandbox/dockerfile.js';
import type { CompileResult, SandboxSpec, WorkflowSet } from '../../types.js';

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
  const set = deserializeWorkflowSet(await readFile(file, 'utf-8'));
  await persistSandboxFlags(file, set, options.sandbox);
  const annotated = new SchemaInferencer().inferWorkflows(set);
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