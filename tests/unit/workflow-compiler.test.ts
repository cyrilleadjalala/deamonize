import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Legacy CRM',
  startUrl: 'http://localhost:8080/',
  workflows: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Create customer',
      steps: [
        { actionType: 'type', selectors: ['#email'], variable: 'email' },
        { actionType: 'click', selectors: ['role=button[name="Save"]', '#save'] },
      ],
      variables: [
        { name: 'email', description: 'Customer e-mail' },
        { name: 'vip', type: 'boolean', optional: true },
      ],
      observedPayloads: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    },
  ],
};

describe('SchemaInferencer.inferWorkflows', () => {
  it('builds the input schema from the marked variables', () => {
    const [workflow] = new SchemaInferencer().inferWorkflows(set).workflows;
    const schema = workflow.inputSchema as Record<string, any>;

    expect(schema.properties.email).toMatchObject({
      type: 'string',
      format: 'email',
      description: 'Customer e-mail',
    });
    expect(schema.properties.vip.type).toBe('boolean');
    expect(schema.required).toEqual(['email']);
  });

  it('keeps alternatives observed for an untyped variable, and lets an explicit type win', () => {
    const base = set.workflows[0];
    const make = (variables: WorkflowSet['workflows'][0]['variables']): WorkflowSet => ({
      ...set,
      workflows: [{ ...base, variables, observedPayloads: [{ code: 'abc' }, { code: 5 }] }],
    });

    const untyped = new SchemaInferencer().inferWorkflows(make([{ name: 'code' }])).workflows[0];
    const typed = new SchemaInferencer().inferWorkflows(make([{ name: 'code', type: 'number' }])).workflows[0];

    const untypedCode = (untyped.inputSchema as any).properties.code;
    expect(untypedCode.anyOf).toHaveLength(2);
    expect(untypedCode.type).toBeUndefined();

    const typedCode = (typed.inputSchema as any).properties.code;
    expect(typedCode).toEqual({ type: 'number' });
  });

  it('does not mutate its input', () => {
    new SchemaInferencer().inferWorkflows(set);
    expect(set.workflows[0].inputSchema).toBeUndefined();
  });
});

describe('Compiler with workflows', () => {
  it('writes the four artifacts with one tool per workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-'));
    const log = console.log;
    console.log = () => { };
    try {
      const annotated = new SchemaInferencer().inferWorkflows(set);
      const result = await new Compiler().compile(annotated, dir);

      expect([...result.toolNames.values()]).toEqual(['create_customer']);

      const openapi = JSON.parse(await readFile(join(dir, 'openapi.json'), 'utf-8'));
      expect(openapi.openapi).toBe('3.1.0');
      expect(Object.keys(openapi.paths)).toEqual([`/actions/${set.workflows[0].id}`]);

      const plugin = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf-8'));
      expect(plugin.keywords).toContain('create_customer');
    } finally {
      console.log = log;
      await removeDir(dir);
    }
  });
});

describe('McpGenerator', () => {
  const names = new Map([[set.workflows[0].id, 'create_customer']]);

  it('embeds the steps and validation in the server, which replays through replay.ts', () => {
    const source = new McpGenerator().generate(new SchemaInferencer().inferWorkflows(set), names);

    expect(source).toContain('server.tool(');
    expect(source).toContain('"create_customer"');
    expect(source).toContain('import { replay } from "./replay.js"');
    expect(source).toContain('import { replayInDocker } from "./docker-replay.js"');
    expect(source).toContain('process.env.DAEMONIZE_SANDBOX === "docker" ? replayInDocker : replay');
    expect(source).toContain('"selectors":["role=button[name=\\"Save\\"]","#save"]');
    // The email format is checked with the ajv-formats regex, so Zod and AJV agree
    expect(source).toMatch(/"email": z\.string\(\)\.regex\(\/\^\[a-z0-9!#\$%&'\*\+\/=\?\^_[^\n]*\/i\)\.describe\("Customer e-mail"\)/);
    expect(source).toContain('validatePayload("create_customer", args)');
  });

  it('puts the replay of a web target in replay.ts, with a container entry point', () => {
    const replay = new McpGenerator().generateReplay(set);

    expect(replay).toContain('export async function replay(');
    expect(replay).toContain('chromium.launch');
    expect(replay).toContain('--no-sandbox');
    expect(replay).toContain('overrides.url ?? START_URL');
    expect(replay).toContain('process.argv.includes("--container")');
    // The result is the only thing written to stdout in the container
    expect(replay).toContain('process.stdout.write(JSON.stringify(result) + "\\n")');
  });

  it('generates the docker replay with the isolation flags of a web target', () => {
    const source = new McpGenerator().generateDockerReplay(set, 'legacy-crm-sandbox');

    expect(source).toContain('const DEFAULT_IMAGE = "legacy-crm-sandbox"');
    expect(source).toContain('const DEFAULT_NETWORK = "bridge"');
    expect(source).toContain('["--shm-size","512m"]');
    for (const flag of ['"--pull", "never"', '"--cap-drop", "ALL"', 'no-new-privileges', '"--rm"', '"--pids-limit"']) {
      expect(source).toContain(flag);
    }
    expect(source).toContain('DAEMONIZE_SANDBOX_MEMORY_MB ?? 512');
    expect(source).toContain('DAEMONIZE_SANDBOX_CPUS ?? 1');
  });

  it('gives a terminal target no network and a read-only file system', () => {
    const terminal: WorkflowSet = {
      ...set,
      targetType: 'tui',
      startUrl: undefined,
      startCommand: ['node', '/app/greeter.mjs'],
    };
    const source = new McpGenerator().generateDockerReplay(terminal, 'greeter-sandbox');

    expect(source).toContain('const DEFAULT_NETWORK = "none"');
    expect(source).toContain('["--read-only","--tmpfs","/tmp"]');
    expect(new McpGenerator().generateReplay(terminal)).toContain('overrides.command ?? START_COMMAND');
  });

  it('describes the sandbox image: Playwright image for the web, Node for a terminal', () => {
    const web = new McpGenerator().generateSandboxFiles(set);
    expect(web.dockerfile).toContain('FROM mcr.microsoft.com/playwright:v1.65.1-noble');
    expect(web.dockerfile).toContain('USER pwuser');
    expect(web.dockerfile).toContain('ENTRYPOINT ["node", "replay.js", "--container"]');
    expect(JSON.parse(web.packageJson).dependencies).toEqual({ playwright: '1.65.1' });
    expect(web.dockerignore).toContain('node_modules');

    const terminal = new McpGenerator().generateSandboxFiles({ ...set, targetType: 'tui', startCommand: ['x'] });
    expect(terminal.dockerfile).toContain('FROM node:20');
    expect(terminal.dockerfile).toContain('USER node');
    expect(Object.keys(JSON.parse(terminal.packageJson).dependencies)).toEqual(['node-pty', '@xterm/headless']);
  });

  it('refuses a target that has nothing to start', () => {
    expect(() => new McpGenerator().generate({ ...set, startUrl: undefined }, new Map())).toThrow(/needs a startUrl/);
    expect(() =>
      new McpGenerator().generate({ ...set, targetType: 'tui', startUrl: undefined }, new Map())
    ).toThrow(/needs a startCommand/);
  });
});
