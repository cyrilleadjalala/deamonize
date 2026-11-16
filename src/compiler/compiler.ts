import type { WorkflowSet, CompileResult } from '../types.js';
import { ToolNameDeriver } from './tool-name-deriver.js';
import { OpenApiGenerator } from './openapi-generator.js';
import { McpGenerator, httpEnabled, healEnabled, type GenerateOptions } from './mcp-generator.js';
import { KiroPowerGenerator } from './kiro-power-generator.js';
import { writeFile, mkdir, access, readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { findPlainSecrets, withoutThumbnails } from '../workflow/workflow-set.js';

// What the generated server needs at run time (it has no Daemonize dependency).
const SERVER_DEPENDENCIES = {
  '@modelcontextprotocol/sdk': '^1.32.2',
  ajv: '^8.20.0',
  'ajv-formats': '^3.0.1',
  zod: '^4.6.7',
};

// What each kind of target adds: a browser for web, a pty and a screen renderer for terminals.
const TARGET_DEPENDENCIES = {
  web: { playwright: '^1.65.1' },
  tui: { 'node-pty': '^1.1.0', '@xterm/headless': '^6.0.0' },
};

// What the generated property-based tests need to run
const TEST_DEPENDENCIES = {
  'fast-check': '^3.23.2',
  vite: '^7.3.8',
  vitest: '^5.1.0',
};

// Shared pure run-time logic, copied verbatim into the output (the shipped file is the tested file).
// Resolved from src/compiler or dist/compiler alike: both sit two levels under the package root.
const RUNTIME_SCREEN_HASH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'screen-hash.ts'
);

const RUNTIME_SETTLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'settle.ts'
);

const RUNTIME_EXTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'extract.ts'
);

const RUNTIME_ROW_RESOLVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'row-resolver.ts'
);

const RUNTIME_STEP_PLAN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'step-plan.ts'
);

const RUNTIME_TOTP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'totp.ts'
);

const RUNTIME_PATTERN_WAIT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'pattern-wait.ts'
);

const RUNTIME_WEB_STEPS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'web-steps.ts'
);

const RUNTIME_HTTP_REPLAY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'replay',
  'runtime',
  'http-replay.ts'
);

// The heal modules (`--heal-support` only): src/heal/ is copied verbatim into <out>/heal/. It uses only Node
// built-ins, fetch and structural page types, so the generated server needs nothing from this package.
const RUNTIME_HEAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'heal');

/** Where the recorded thumbnails of a heal-supported output live, relative to the output directory. */
export const ANCHORS_DIR = join('.daemonize', 'anchors');

export interface CompileOptions extends GenerateOptions {
  /**
   * The workflow file the set was read from. With `healSupport`, the thumbnails next to it
   * (`<file>.assets/`) are copied to `<out>/.daemonize/anchors/`.
   */
  workflowFile?: string;
}

/** Every `.ts` file under a folder, as paths relative to it (forward slashes). */
async function listSources(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listSources(root, relative)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative);
  }
  return found.sort();
}

export class Compiler {
  private toolNameDeriver = new ToolNameDeriver();
  private openApiGenerator = new OpenApiGenerator();
  private mcpGenerator = new McpGenerator();
  private kiroPowerGenerator = new KiroPowerGenerator();

  /**
   * Compile the annotated workflow set into all output artifacts.
   * Writes files to outputDir.
   * Returns the CompileResult with all generated artifacts.
   */
  async compile(recorded: WorkflowSet, outputDir: string, options: CompileOptions = {}): Promise<CompileResult> {
    const heal = healEnabled(recorded, options);
    // Thumbnails stay next to the Workflow file: artifacts keep only the rect and the intent of a Visual_Anchor.
    // With --heal-support, the thumbnails are copied to <out>/.daemonize/anchors/ and the steps keep that relative path.
    const set = heal ? await withAnchorThumbnails(recorded, outputDir, options.workflowFile) : withoutThumbnails(recorded);
    const http = httpEnabled(set, options);
    // A literal secret (typed value, credential header or cookie) would be copied into every artifact:
    // refuse before writing anything. Only the JSON paths are reported, never the values.
    const plain = findPlainSecrets(set);
    if (plain.length > 0) {
      throw new Error(
        `Workflow set contains plain-text secrets at ${plain.join(', ')}; use a secretRef or a {"$secret":"NAME"} reference instead`
      );
    }
    // 1. Reset deriver and derive a tool name for every workflow.
    this.toolNameDeriver.reset();
    const toolNames = new Map<string, string>();
    for (const workflow of set.workflows) {
      toolNames.set(workflow.id, this.toolNameDeriver.derive(workflow.label));
    }

    // 2. Generate all artifacts.
    const openApiSpec = await this.openApiGenerator.generate(set, toolNames);
    const mcpServerSource = this.mcpGenerator.generate(set, toolNames, options);
    const replaySource = this.mcpGenerator.generateReplay(set, options);
    const imageTag = `${slugOf(set.targetName)}-sandbox`;
    const dockerReplaySource = this.mcpGenerator.generateDockerReplay(set, imageTag, options);
    const sandbox = this.mcpGenerator.generateSandboxFiles(set, options);
    const screenHashSource = await readFile(RUNTIME_SCREEN_HASH, 'utf-8');
    const settleSource = await readFile(RUNTIME_SETTLE, 'utf-8');
    const extractSource = await readFile(RUNTIME_EXTRACT, 'utf-8');
    const rowResolverSource = await readFile(RUNTIME_ROW_RESOLVER, 'utf-8');
    const stepPlanSource = await readFile(RUNTIME_STEP_PLAN, 'utf-8');
    const totpSource = await readFile(RUNTIME_TOTP, 'utf-8');
    // Waiting for a pattern of the rendered screen: only a terminal target replays a pty
    const patternWaitSource = set.targetType === 'tui' ? await readFile(RUNTIME_PATTERN_WAIT, 'utf-8') : undefined;
    // Strict Level 2 execution with Playwright: only a web target replays a browser
    const webStepsSource = set.targetType === 'web' ? await readFile(RUNTIME_WEB_STEPS, 'utf-8') : undefined;
    // Level 1 (--http): the runtime that executes recorded requests, copied verbatim like the other run-time modules
    const httpReplaySource = http ? await readFile(RUNTIME_HTTP_REPLAY, 'utf-8') : undefined;
    const kiroPower = this.kiroPowerGenerator.generate(set, toolNames, outputDir, options);
    // The heal modules, only for a web target compiled with --heal-support
    const healSources = heal ? await listSources(RUNTIME_HEAL_DIR) : [];
    const healFiles = new Map<string, string>();
    for (const relative of healSources) healFiles.set(relative, await readFile(join(RUNTIME_HEAL_DIR, relative), 'utf-8'));
    assertNoThumbnails({
      'openapi.json': JSON.stringify(openApiSpec),
      'mcp-server.ts': mcpServerSource,
      'replay.ts': replaySource,
      'docker-replay.ts': dockerReplaySource,
      'plugin.json': JSON.stringify(kiroPower.plugin),
      'mcp.json': JSON.stringify(kiroPower.mcp),
      'SKILL.md': kiroPower.skill,
      'POWER.md': kiroPower.powerMd,
    });
    const powerName = kiroPower.plugin.name;

    // 3. Build the name-map (plain object for JSON serialisation).
    const nameMap: Record<string, string> = {};
    for (const [workflowId, toolName] of toolNames) {
      nameMap[workflowId] = toolName;
    }

    // 4. Write to disk. The manifest runs `node ./mcp-server.js`, so the
    // TypeScript sources are also emitted as JavaScript.
    await mkdir(join(outputDir, 'sandbox'), { recursive: true });
    await mkdir(join(outputDir, 'skills', powerName), { recursive: true });
    const files = {
      openapi: join(outputDir, 'openapi.json'),
      source: join(outputDir, 'mcp-server.ts'),
      server: join(outputDir, 'mcp-server.js'),
      replaySource: join(outputDir, 'replay.ts'),
      replay: join(outputDir, 'replay.js'),
      dockerReplaySource: join(outputDir, 'docker-replay.ts'),
      dockerReplay: join(outputDir, 'docker-replay.js'),
      screenHashSource: join(outputDir, 'screen-hash.ts'),
      screenHash: join(outputDir, 'screen-hash.js'),
      settleSource: join(outputDir, 'settle.ts'),
      settle: join(outputDir, 'settle.js'),
      extractSource: join(outputDir, 'extract.ts'),
      extract: join(outputDir, 'extract.js'),
      rowResolverSource: join(outputDir, 'row-resolver.ts'),
      rowResolver: join(outputDir, 'row-resolver.js'),
      stepPlanSource: join(outputDir, 'step-plan.ts'),
      stepPlan: join(outputDir, 'step-plan.js'),
      totpSource: join(outputDir, 'totp.ts'),
      totp: join(outputDir, 'totp.js'),
      ...(patternWaitSource === undefined ? {} : { patternWaitSource: join(outputDir, 'pattern-wait.ts'), patternWait: join(outputDir, 'pattern-wait.js') }),
      ...(webStepsSource === undefined ? {} : { webStepsSource: join(outputDir, 'web-steps.ts'), webSteps: join(outputDir, 'web-steps.js') }),
      ...(httpReplaySource === undefined ? {} : { httpReplaySource: join(outputDir, 'http-replay.ts'), httpReplay: join(outputDir, 'http-replay.js') }),
      plugin: join(outputDir, 'plugin.json'),
      mcp: join(outputDir, 'mcp.json'),
      skill: join(outputDir, 'skills', powerName, 'SKILL.md'),
      powerMd: join(outputDir, 'POWER.md'),
      nameMap: join(outputDir, 'name-map.json'),
    };
    await Promise.all([
      writeFile(files.openapi, JSON.stringify(openApiSpec, null, 2)),
      writeFile(files.source, mcpServerSource),
      writeFile(files.server, this.toJavaScript(mcpServerSource)),
      writeFile(files.replaySource, replaySource),
      writeFile(files.replay, this.toJavaScript(replaySource)),
      writeFile(files.dockerReplaySource, dockerReplaySource),
      writeFile(files.dockerReplay, this.toJavaScript(dockerReplaySource)),
      writeFile(files.screenHashSource, screenHashSource),
      writeFile(files.screenHash, this.toJavaScript(screenHashSource)),
      writeFile(files.settleSource, settleSource),
      writeFile(files.settle, this.toJavaScript(settleSource)),
      writeFile(files.extractSource, extractSource),
      writeFile(files.extract, this.toJavaScript(extractSource)),
      writeFile(files.rowResolverSource, rowResolverSource),
      writeFile(files.rowResolver, this.toJavaScript(rowResolverSource)),
      writeFile(files.stepPlanSource, stepPlanSource),
      writeFile(files.stepPlan, this.toJavaScript(stepPlanSource)),
      writeFile(files.totpSource, totpSource),
      writeFile(files.totp, this.toJavaScript(totpSource)),
      ...(patternWaitSource === undefined ? [] : [
        writeFile(join(outputDir, 'pattern-wait.ts'), patternWaitSource),
        writeFile(join(outputDir, 'pattern-wait.js'), this.toJavaScript(patternWaitSource)),
      ]),
      ...(webStepsSource === undefined ? [] : [
        writeFile(join(outputDir, 'web-steps.ts'), webStepsSource),
        writeFile(join(outputDir, 'web-steps.js'), this.toJavaScript(webStepsSource)),
      ]),
      ...(httpReplaySource === undefined ? [] : [
        writeFile(join(outputDir, 'http-replay.ts'), httpReplaySource),
        writeFile(join(outputDir, 'http-replay.js'), this.toJavaScript(httpReplaySource)),
      ]),
      ...[...healFiles].flatMap(([relative, source]) => [
        this.writeInto(join(outputDir, 'heal', relative), source),
        this.writeInto(join(outputDir, 'heal', relative.replace(/\.ts$/, '.js')), this.toJavaScript(source)),
      ]),
      writeFile(files.plugin, JSON.stringify(kiroPower.plugin, null, 2)),
      writeFile(files.mcp, JSON.stringify(kiroPower.mcp, null, 2)),
      writeFile(files.skill, kiroPower.skill),
      writeFile(files.powerMd, kiroPower.powerMd),
      writeFile(files.nameMap, JSON.stringify(nameMap, null, 2)),
      // What `daemonize sandbox build` needs to build the image replays run in
      writeFile(join(outputDir, 'sandbox', 'Dockerfile'), sandbox.dockerfile),
      writeFile(join(outputDir, 'sandbox', 'package.json'), sandbox.packageJson),
      writeFile(join(outputDir, 'sandbox', 'image.json'), JSON.stringify({ tag: imageTag, targetType: set.targetType, copy: sandbox.copy, ...(set.sandbox === undefined ? {} : { sandbox: set.sandbox }) }, null, 2)),
      writeFile(join(outputDir, '.dockerignore'), sandbox.dockerignore),
      this.writePackageJsonIfMissing(outputDir, set.targetName, set.targetType),
      this.writeVitestConfigIfMissing(outputDir),
    ]);

    // 5. Report to stdout.
    console.log(`Compiled to: ${Object.values(files).join(', ')}`);

    // 6. Return CompileResult.
    return {
      openApiSpec,
      mcpServerSource,
      kiroPower: { ...kiroPower, plugin: { ...kiroPower.plugin }, mcp: { ...kiroPower.mcp } },
      toolNames,
    };
  }

  private async writeInto(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  /** Transpile the generated server to an ES module that Node can run directly. */
  private toJavaScript(source: string): string {
    return ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
  }

  /** The output folder is a small project: it needs ES modules and its dependencies. */
  private async writePackageJsonIfMissing(
    outputDir: string,
    targetName: string,
    targetType: 'web' | 'tui'
  ): Promise<void> {
    const pkg = {
      name: `${slugOf(targetName)}-mcp-server`,
      private: true,
      type: 'module',
      scripts: { test: 'vitest run' },
      dependencies: { ...SERVER_DEPENDENCIES, ...TARGET_DEPENDENCIES[targetType] },
      devDependencies: TEST_DEPENDENCIES,
    };
    await this.writeIfMissing(join(outputDir, 'package.json'), JSON.stringify(pkg, null, 2));
  }

  /**
   * The generated tests must find themselves whatever folder the project sits
   * in: without its own config, Vitest would use one found in a parent folder.
   */
  private async writeVitestConfigIfMissing(outputDir: string): Promise<void> {
    await this.writeIfMissing(
      join(outputDir, 'vitest.config.ts'),
      [
        `import { defineConfig } from "vitest/config";`,
        ``,
        `export default defineConfig({`,
        `  test: {`,
        `    include: ["tests/**/*.test.ts"],`,
        `    // The report printed by the property tests must always be visible`,
        `    reporters: ["default"],`,
        `  },`,
        `});`,
        ``,
      ].join('\n')
    );
  }

  /** Leave a file the user may have edited alone. */
  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await access(path);
    } catch {
      await writeFile(path, content);
    }
  }
}

/**
 * A copy of the set whose Visual_Anchor thumbnails were copied from `<workflowFile>.assets/` to
 * `<out>/.daemonize/anchors/`; each step then refers to its picture by that relative path. A thumbnail
 * that cannot be read is dropped from its step (the heal then has no picture to compare with).
 */
async function withAnchorThumbnails(recorded: WorkflowSet, outputDir: string, workflowFile: string | undefined): Promise<WorkflowSet> {
  const copy = structuredClone(recorded);
  const target = join(outputDir, ANCHORS_DIR);
  for (const workflow of copy.workflows ?? []) {
    for (const step of workflow.steps ?? []) {
      const visual = step.visual;
      if (visual?.thumbnailPath === undefined) continue;
      const name = visual.thumbnailPath.split(/[\\/]/).pop() as string;
      try {
        if (workflowFile === undefined) throw new Error('no workflow file');
        const picture = await readFile(resolve(dirname(resolve(workflowFile)), visual.thumbnailPath));
        await mkdir(target, { recursive: true });
        await writeFile(join(target, name), picture);
        visual.thumbnailPath = `${ANCHORS_DIR.replace(/\\/g, '/')}/${name}`;
      } catch {
        delete visual.thumbnailPath;
      }
    }
  }
  return copy;
}

/** Generated artifacts never carry a thumbnail: no inline image data and no path into the assets folder. */
function assertNoThumbnails(artifacts: Record<string, string>): void {
  for (const [name, text] of Object.entries(artifacts)) {
    if (/data:image\/[a-z+]+;base64,[A-Za-z0-9+\/]{40,}|iVBORw0KGgo|\.assets[\\/]/.test(text)) {
      throw new Error(`Generated artifact ${name} would contain a thumbnail or a reference to one`);
    }
  }
}

/** The application name as a lowercase identifier usable in package and image names. */
function slugOf(targetName: string): string {
  return targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'generated';
}
