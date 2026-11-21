import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'No Src',
  startUrl: 'http://localhost:8080/',
  workflows: [{ id: 'c3333333-3333-4333-8333-333333333333', label: 'Go', steps: [{ actionType: 'click', selectors: ['#go'] }], variables: [], observedPayloads: [] }],
};

/** Every module specifier of import, export-from, require and dynamic import calls. */
function specifiers(fileName: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('generated reader files do not import from src/', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-nosrc-'));
    const log = console.log;
    console.log = () => {};
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
    } finally {
      console.log = log;
    }
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it.each(['vault-reader.ts', 'vault-reader.js', 'vault-format.ts', 'vault-format.js', 'approval-queue.ts', 'approval-queue.js', 'audit-log.ts', 'audit-log.js', 'firewall.ts', 'firewall.js', 'trace.ts', 'trace.js'])('%s imports only node:* modules and its sibling files', async (name) => {
    const specs = specifiers(name, await readFile(join(dir, name), 'utf-8'));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      const resolved = spec.startsWith('.') ? resolve(dir, spec) : isAbsolute(spec) ? resolve(spec) : undefined;
      if (resolved !== undefined) {
        expect(resolved === SRC || resolved.startsWith(SRC + sep), `${name} imports ${spec}`).toBe(false);
        expect(relative(dir, resolved).startsWith('..'), `${name} imports ${spec} outside its folder`).toBe(false);
      } else {
        expect(spec.startsWith('node:'), `${name} imports ${spec}`).toBe(true);
      }
    }
  });
  it.each(['browser-launch.ts', 'browser-launch.js'])('%s has no import at all', async (name) => {
    expect(specifiers(name, await readFile(join(dir, name), 'utf-8'))).toEqual([]);
  });
});
