/**
 * G-C: what the firewall change adds to the generated code, and what it leaves alone (Requirements 11.12, 18.1, 28).
 * Every added line ends with `//#fw`; without those lines the generated files equal the snapshot of an old compile.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import ts from 'typescript';
import { Compiler, type CompileOptions } from '../../src/compiler/compiler.js';
import { FW_LINE_PATTERNS, FW_MARK } from '../../src/compiler/firewall-markers.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures', 'regression');
const SNAPSHOT = join(FIXTURES, 'snapshot');
const workspaceRoot = resolve(import.meta.dirname, '../..');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const isMarked = (line: string): boolean => line.trimEnd().endsWith(FW_MARK);
const withoutMarked = (text: string): string => lf(text).split('\n').filter((line) => !isMarked(line)).join('\n');
const ALL_PATTERNS = Object.values(FW_LINE_PATTERNS);
const CASES = [
  { name: 'web', file: 'pre-change.workflows.json' },
  { name: 'tui', file: 'pre-change-tui.workflows.json' },
];
const OPTIONS: Record<string, CompileOptions> = { default: {}, http: { http: 'auto' }, heal: { healSupport: true } };
const TEXTS = ['mcp-server.ts', 'replay.ts', 'docker-replay.ts'] as const;
async function compileTo(file: string, options: CompileOptions): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'daemonize-genfw-'));
  const set = deserializeWorkflowSet(await readFile(join(FIXTURES, file), 'utf-8'));
  const log = console.log;
  console.log = () => undefined;
  try {
    await new Compiler().compile(set, out, options);
  } finally {
    console.log = log;
  }
  return out;
}
describe('generated code of an old workflow set (Requirements 28.1, 28.6)', () => {
  for (const { name, file } of CASES) {
    for (const [optionName, options] of Object.entries(OPTIONS)) {
      it(`${name} ${optionName}: differs from the snapshot only by lines ending with ${FW_MARK}`, async () => {
        const out = await compileTo(file, options);
        try {
          for (const text of TEXTS) {
            const generated = lf(await readFile(join(out, text), 'utf-8'));
            const stored = lf(await readFile(join(SNAPSHOT, `${name}.${optionName}.${text}.txt`), 'utf-8'));
            expect(withoutMarked(generated), `${name}.${optionName}.${text}`).toBe(stored);
            // Every added line is one the regression table knows by name
            for (const line of generated.split('\n').filter(isMarked)) {
              expect(ALL_PATTERNS.some((pattern) => pattern.test(line.trimStart())), line.slice(0, 80)).toBe(true);
            }
          }
          const openapi = JSON.parse(await readFile(join(out, 'openapi.json'), 'utf-8'));
          const nameMap = JSON.parse(await readFile(join(out, 'name-map.json'), 'utf-8'));
          const snapshot = JSON.parse(await readFile(join(SNAPSHOT, `${name}.json`), 'utf-8'));
          expect(openapi).toEqual(snapshot.options[optionName].openapi);
          expect(nameMap).toEqual(snapshot.options[optionName].nameMap);
        } finally {
          await removeDir(out);
        }
      });
    }
  }
  it('adds the table, the wrapper and the trace marks that Requirement 11 asks for', async () => {
    const out = await compileTo('pre-change.workflows.json', {});
    try {
      const server = lf(await readFile(join(out, 'mcp-server.ts'), 'utf-8'));
      const replay = lf(await readFile(join(out, 'replay.ts'), 'utf-8'));
      for (const key of ['firewallImport', 'firewallTable', 'firewallObject', 'approvalGate', 'registerTool', 'toolWrapper'] as const) {
        expect(server.split('\n').filter((line) => isMarked(line) && FW_LINE_PATTERNS[key].test(line)), key).toHaveLength(1);
      }
      expect(server.split('\n').filter((line) => /^async function approvalGate\b/.test(line))).toHaveLength(1);
      for (const key of ['traceImport', 'traceStep', 'enterTraceScope', 'traceResult'] as const) {
        expect(replay.split('\n').some((line) => isMarked(line) && FW_LINE_PATTERNS[key].test(line)), key).toBe(true);
      }
      // docker-replay.ts runs on the host and stays as it was
      expect(lf(await readFile(join(out, 'docker-replay.ts'), 'utf-8'))).not.toContain(FW_MARK);
    } finally {
      await removeDir(out);
    }
  });
  it('compiling twice gives equal bytes', async () => {
    const first = await compileTo('pre-change.workflows.json', { http: 'auto' });
    const second = await compileTo('pre-change.workflows.json', { http: 'auto' });
    try {
      for (const file of ['mcp-server.ts', 'mcp-server.js', 'replay.ts', 'replay.js', 'docker-replay.ts', 'firewall.js', 'trace.js', 'approval-queue.js', 'audit-log.js', 'openapi.json']) {
        expect(await readFile(join(first, file), 'utf-8'), file).toBe(await readFile(join(second, file), 'utf-8'));
      }
    } finally {
      await removeDir(first);
      await removeDir(second);
    }
  });
  it('copies the four runtime files as .ts and .js and adds trace.js to the image', async () => {
    const out = await compileTo('pre-change-tui.workflows.json', {});
    try {
      for (const name of ['approval-queue', 'audit-log', 'firewall', 'trace']) {
        expect(await readFile(join(out, `${name}.ts`), 'utf-8')).toBe(await readFile(join(workspaceRoot, 'src', 'replay', 'runtime', `${name}.ts`), 'utf-8'));
        expect((await readFile(join(out, `${name}.js`), 'utf-8')).length).toBeGreaterThan(0);
      }
      const image = JSON.parse(await readFile(join(out, 'sandbox', 'image.json'), 'utf-8'));
      expect(image.copy).toContain('trace.js');
      expect(image.copy).not.toContain('firewall.js');
    } finally {
      await removeDir(out);
    }
  });
});
describe('a server compiled before this change still starts and answers (Requirement 28.1)', () => {
  let out = '';
  let client: Client;
  let transport: StdioClientTransport;
  beforeAll(async () => {
    out = await compileTo('pre-change-tui.workflows.json', {});
    // The old server: the text of the snapshot, next to the current replay files
    const old = await readFile(join(SNAPSHOT, 'tui.default.mcp-server.ts.txt'), 'utf-8');
    await writeFile(join(out, 'mcp-server.js'), ts.transpileModule(old, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    await symlink(join(workspaceRoot, 'node_modules'), join(out, 'node_modules'), 'junction');
    client = new Client({ name: 'old-server-test', version: '1.0.0' });
    transport = new StdioClientTransport({ command: process.execPath, args: [join(out, 'mcp-server.js')], env: { ...(process.env as Record<string, string>) }, cwd: out });
    await client.connect(transport);
  });
  afterAll(async () => {
    await closeClient(client, transport);
    if (out !== '') await removeDir(out);
  });
  it('lists its tools and answers a call', async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    const result = await client.callTool({ name: tools.tools[0].name, arguments: {} });
    expect((result.content as Array<{ text: string }>).length).toBeGreaterThan(0);
  });
});
