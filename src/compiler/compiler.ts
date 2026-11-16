import type { WorkflowSet, CompileResult } from '../types.js';
import { ToolNameDeriver } from './tool-name-deriver.js';
import { OpenApiGenerator } from './openapi-generator.js';
import { McpGenerator } from './mcp-generator.js';
import { KiroPowerGenerator } from './kiro-power-generator.js';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

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
  async compile(set: WorkflowSet, outputDir: string): Promise<CompileResult> {
    // 1. Reset deriver and derive a tool name for every workflow.
    this.toolNameDeriver.reset();
    const toolNames = new Map<string, string>();
    for (const workflow of set.workflows) {
      toolNames.set(workflow.id, this.toolNameDeriver.derive(workflow.label));
    }

    // 2. Generate all artifacts.
    const openApiSpec = await this.openApiGenerator.generate(set, toolNames);
    const mcpServerSource = this.mcpGenerator.generate(set, toolNames);
    const replaySource = this.mcpGenerator.generateReplay(set);
    const imageTag = `${slugOf(set.targetName)}-sandbox`;
    const dockerReplaySource = this.mcpGenerator.generateDockerReplay(set, imageTag);
    const sandbox = this.mcpGenerator.generateSandboxFiles(set);
    const kiroPower = this.kiroPowerGenerator.generate(set, toolNames, outputDir);
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
      writeFile(files.plugin, JSON.stringify(kiroPower.plugin, null, 2)),
      writeFile(files.mcp, JSON.stringify(kiroPower.mcp, null, 2)),
      writeFile(files.skill, kiroPower.skill),
      writeFile(files.powerMd, kiroPower.powerMd),
      writeFile(files.nameMap, JSON.stringify(nameMap, null, 2)),
      // What `daemonize sandbox build` needs to build the image replays run in
      writeFile(join(outputDir, 'sandbox', 'Dockerfile'), sandbox.dockerfile),
      writeFile(join(outputDir, 'sandbox', 'package.json'), sandbox.packageJson),
      writeFile(join(outputDir, 'sandbox', 'image.json'), JSON.stringify({ tag: imageTag }, null, 2)),
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

/** The application name as a lowercase identifier usable in package and image names. */
function slugOf(targetName: string): string {
  return targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'generated';
}
