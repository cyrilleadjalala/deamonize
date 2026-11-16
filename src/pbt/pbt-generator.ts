import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findUnsupported } from './schema-arbitrary.js';
import type { WorkflowSet } from '../types.js';

// Support modules copied next to the generated tests
const SUPPORT_MODULES = ['schema-arbitrary', 'property-runner'];

export interface PbtResult {
  /** Paths of the files written. */
  files: string[];
  /** Actions whose schema uses something the generator cannot build values for. */
  skipped: Array<{ tool: string; reason: string }>;
}

/**
 * Generates a self-contained property-based test suite for the input schema of
 * every compiled Action. The files run with `vitest run` in the output
 * directory and import nothing from Daemonize.
 */
export class PbtGenerator {
  /**
   * Write one test file per Workflow, plus the support modules, into
   * `<outputDir>/tests`. When an action's schema is outside what the generator
   * supports, its tests are written as explicitly skipped (with the reason)
   * rather than as properties that would pass without proving anything.
   *
   * @param set - Annotated workflow set (inputSchema on each workflow)
   * @param toolNames - Map from workflowId to tool name
   * @param outputDir - The compiler output directory
   */
  async generate(
    set: WorkflowSet,
    toolNames: Map<string, string>,
    outputDir: string
  ): Promise<PbtResult> {
    const testsDir = join(outputDir, 'tests');
    await mkdir(testsDir, { recursive: true });

    const files: string[] = [];
    const skipped: PbtResult['skipped'] = [];

    for (const name of SUPPORT_MODULES) {
      const { file, source } = await readSupportModule(name);
      const path = join(testsDir, file);
      await writeFile(path, source);
      files.push(path);
    }

    for (const workflow of set.workflows) {
      const toolName = toolNames.get(workflow.id) ?? workflow.id;
      const path = join(testsDir, `${toolName}.property.test.ts`);
      const schema = workflow.inputSchema ?? { type: 'object' };
      const reason = findUnsupported(schema);
      if (reason !== null) {
        skipped.push({ tool: toolName, reason });
      }
      await writeFile(path, reason === null ? this.testSource(toolName, schema) : this.skippedSource(toolName, reason));
      files.push(path);
    }

    return { files, skipped };
  }

  /** A test file whose properties are skipped, with the reason in their titles. */
  private skippedSource(toolName: string, reason: string): string {
    const why = JSON.stringify(`unsupported schema, ${reason}`);
    return [
      `import { describe, it } from "vitest";`,
      ``,
      `// The "${toolName}" input schema uses something the test generator cannot build values for.`,
      `// The properties are skipped instead of passing without proving anything.`,
      `describe(${JSON.stringify(`${toolName} input schema`)}, () => {`,
      `  it.skip("accepts every payload generated from the schema (" + ${why} + ")", () => {});`,
      `  it.skip("rejects every payload that violates the schema (" + ${why} + ")", () => {});`,
      `});`,
      ``,
    ].join('\n');
  }

  private testSource(toolName: string, inputSchema: Record<string, unknown>): string {
    const title = JSON.stringify(`${toolName} input schema`);

    return [
      `import { describe, it, afterAll } from "vitest";`,
      `import fc from "fast-check";`,
      `import { Ajv2020 } from "ajv/dist/2020.js";`,
      `import _addFormats from "ajv-formats";`,
      `import { schemaArbitrary, invalidPayloadArbitrary } from "./schema-arbitrary.js";`,
      `import { checkProperty, printReport } from "./property-runner.js";`,
      ``,
      `// The input schema of the "${toolName}" action, as compiled.`,
      `const SCHEMA: Record<string, unknown> = ${JSON.stringify(inputSchema, null, 2)};`,
      ``,
      `// Same validator settings as the generated MCP server.`,
      `const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;`,
      `const ajv = new Ajv2020({ allErrors: true, strict: false });`,
      `addFormats(ajv);`,
      `const validate = ajv.compile(SCHEMA);`,
      ``,
      `describe(${title}, () => {`,
      `  afterAll(() => printReport(${JSON.stringify(toolName)}));`,
      ``,
      `  // Feature: daemonize, Property 7: PBT valid round-trip`,
      `  it("accepts every payload generated from the schema", () => {`,
      `    checkProperty(`,
      `      "valid payloads are accepted",`,
      `      fc.property(schemaArbitrary(SCHEMA), (payload) => validate(payload) === true)`,
      `    );`,
      `  });`,
      ``,
      `  // Feature: daemonize, Property 8: PBT invalid rejection`,
      `  it("rejects every payload that violates the schema", () => {`,
      `    checkProperty(`,
      `      "invalid payloads are rejected",`,
      `      fc.property(invalidPayloadArbitrary(SCHEMA), (payload) => validate(payload) === false)`,
      `    );`,
      `  });`,
      `});`,
      ``,
    ].join('\n');
  }
}

/**
 * Read a support module from this package: the TypeScript source when running
 * from src, the compiled JavaScript when running from dist.
 */
async function readSupportModule(name: string): Promise<{ file: string; source: string }> {
  for (const extension of ['ts', 'js']) {
    try {
      const source = await readFile(new URL(`./${name}.${extension}`, import.meta.url), 'utf-8');
      return {
        file: `${name}.${extension}`,
        source: source.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'),
      };
    } catch {
      // Try the next extension
    }
  }
  throw new Error(`Support module "${name}" not found next to the PBT generator`);
}
