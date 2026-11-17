import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const web: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Vault Web',
  startUrl: 'http://localhost:8080/',
  workflows: [{ id: 'a1111111-1111-4111-8111-111111111111', label: 'Sign in', steps: [{ actionType: 'type', selectors: ['#p'], secretRef: 'PASSWORD' }], variables: [], observedPayloads: [] }],
};
const tui: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Vault Tui',
  startCommand: ['node', '-e', '1'],
  workflows: [{ id: 'b2222222-2222-4222-8222-222222222222', label: 'Run', steps: [{ actionType: 'type', selectors: [], value: 'x' }], variables: [], observedPayloads: [] }],
} as WorkflowSet;

async function compileTo(set: WorkflowSet, options: { powerName?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daemonize-vault-'));
  const log = console.log;
  console.log = () => {};
  try {
    await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir, options);
  } finally {
    console.log = log;
  }
  return dir;
}

async function files(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

const READER_FILES = ['vault-format.ts', 'vault-format.js', 'vault-reader.ts', 'vault-reader.js'];
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await removeDir(dir);
});

describe('generated vault reader files', () => {
  let webDir = '';
  let tuiDir = '';
  beforeAll(async () => {
    webDir = await compileTo(web);
    tuiDir = await compileTo(tui);
    dirs.push(webDir, tuiDir);
  });

  it('writes the reader and its format module next to mcp-server.js for a web target', async () => {
    const found = await files(webDir);
    for (const name of ['mcp-server.js', ...READER_FILES]) expect(found).toContain(name);
  });

  it('writes the reader and its format module next to mcp-server.js for a terminal target', async () => {
    const found = await files(tuiDir);
    for (const name of ['mcp-server.js', ...READER_FILES]) expect(found).toContain(name);
  });

  it('lists the reader files in the sandbox image of a web target', async () => {
    const image = JSON.parse(await readFile(join(webDir, 'sandbox', 'image.json'), 'utf-8')) as { copy: string[] };
    expect(image.copy).toContain('vault-reader.js');
    expect(image.copy).toContain('vault-format.js');
    expect(await readFile(join(webDir, 'sandbox', 'Dockerfile'), 'utf-8')).toContain('vault-reader.js');
  });

  it('resolves the secrets once per call in the generated replay and the docker replay', async () => {
    const replay = await readFile(join(webDir, 'replay.ts'), 'utf-8');
    expect(replay).toContain('import { withResolvedSecrets } from "./vault-reader.js";');
    expect(replay.split('withResolvedSecrets(process.env').length - 1).toBe(1);
    expect(replay).toContain('missingSecrets(steps, env)');
    const docker = await readFile(join(webDir, 'docker-replay.ts'), 'utf-8');
    expect(docker.split('withResolvedSecrets(process.env').length - 1).toBe(1);
    expect(docker).toContain('{ stdio: ["pipe", "pipe", "pipe"], env }');
  });

  it('resolves HTTP secrets in the same single call with --http', () => {
    const source = new McpGenerator().generateReplay(new SchemaInferencer().inferWorkflows(web), { http: 'auto' });
    expect(source.split('withResolvedSecrets(process.env').length - 1).toBe(1);
    expect(source).toContain('missingHttpSecrets(httpSteps, env)');
  });

  it('writes the same files as before when no powerName is given, plus the Power name when it is', async () => {
    const same = await compileTo(web);
    const named = await compileTo(web, { powerName: 'my-app' });
    dirs.push(same, named);
    expect(await files(same)).toEqual(await files(webDir));
    const plugin = JSON.parse(await readFile(join(named, 'plugin.json'), 'utf-8')) as { name: string };
    expect(plugin.name).toBe('my-app');
  });
});