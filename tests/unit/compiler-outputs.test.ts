import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { KiroPowerGenerator, toKebabCase } from '../../src/compiler/kiro-power-generator.js';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Compiler } from '../../src/compiler/compiler.js';
import { describeTool } from '../../src/compiler/tool-description.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

function workflow(id: string, label: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    label,
    steps: [{ actionType: 'click', selectors: ['#go'] }],
    variables: [],
    observedPayloads: [],
    ...overrides,
  };
}

const longLabel = 'one two three four five six seven eight nine ten eleven twelve thirteen';

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Legacy CRM',
  startUrl: 'http://localhost:8080/',
  workflows: [
    workflow('d1111111-1111-4111-8111-111111111111', 'Create customer', {
      variables: [{ name: 'email', description: 'Customer e-mail' }, { name: 'vip', type: 'boolean', optional: true }],
      observedPayloads: [{ email: 'a@example.com', vip: true }],
    }),
    workflow('d2222222-2222-4222-8222-222222222222', 'Create customer'),
    workflow('d3333333-3333-4333-8333-333333333333', 'Create customer'),
    workflow('d4444444-4444-4444-8444-444444444444', longLabel),
  ],
};

describe('Compiler outputs', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemonize-outputs-'));
    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
    } finally {
      console.log = log;
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readJson = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf-8'));

  it('emits an OpenAPI 3.1 document that passes the official meta-schema', async () => {
    const openapi = await readJson('openapi.json');
    const result = await new Validator().validate(openapi);

    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(openapi.openapi).toBe('3.1.0');
    expect(Object.keys(openapi.paths)).toHaveLength(4);
    for (const path of Object.keys(openapi.paths)) {
      expect(path).toMatch(/^\/actions\/[0-9a-f-]{36}$/);
      expect(openapi.paths[path].post.operationId).toEqual(expect.any(String));
    }
  });

  it('names the tools in snake_case, suffixes duplicates and truncates at a word boundary', async () => {
    const nameMap = await readJson('name-map.json');

    expect(Object.values(nameMap)).toEqual([
      'create_customer',
      'create_customer_2',
      'create_customer_3',
      'one_two_three_four_five_six_seven_eight_nine_ten_eleven_twelve',
    ]);
  });

  describe('Kiro Power manifest', () => {
    it('writes plugin.json with the fields a plugin needs', async () => {
      const plugin = await readJson('plugin.json');

      expect(plugin.$schema).toEqual(expect.any(String));
      expect(plugin.name).toBe('legacy-crm');
      expect(plugin.version).toEqual(expect.any(String));
      expect(plugin.description).toContain('Legacy CRM');
      expect(plugin.author.name).toEqual(expect.any(String));
      expect(plugin.keywords.length).toBeGreaterThan(0);
    });

    it('writes mcp.json with an absolute path to the emitted server', async () => {
      const mcp = await readJson('mcp.json');
      const server = mcp.mcpServers['legacy-crm'];

      expect(server).toMatchObject({ type: 'stdio', command: 'node' });
      expect(isAbsolute(server.args[0])).toBe(true);
      expect(server.args[0].endsWith('mcp-server.js')).toBe(true);
      await expect(access(server.args[0])).resolves.toBeUndefined();
    });

    it('lists every tool and its inputs in the skill, with the drift note', async () => {
      const nameMap = await readJson('name-map.json');
      const skill = await readFile(join(dir, 'skills', 'legacy-crm', 'SKILL.md'), 'utf-8');

      expect(skill).toMatch(/^---\nname: legacy-crm\ndescription: .+\n---\n/);
      for (const toolName of Object.values(nameMap)) {
        expect(skill).toContain(`\`${toolName}\``);
      }
      expect(skill).toContain('`email` (string, required): Customer e-mail');
      expect(skill).toContain('`vip` (boolean, optional)');
      expect(skill).toContain('drifted');
    });

    it('writes POWER.md with frontmatter, and no kiro-power.json', async () => {
      const power = await readFile(join(dir, 'POWER.md'), 'utf-8');

      expect(power).toMatch(/^---\nname: "legacy-crm"\ndisplayName: "Legacy CRM"\ndescription: ".+"\nkeywords:\n  - /);
      await expect(access(join(dir, 'kiro-power.json'))).rejects.toThrow();
    });
  });

  it('writes a project that can be installed: ES module, scripts and dependencies for a web target', async () => {
    const pkg = await readJson('package.json');

    expect(pkg).toMatchObject({ type: 'module', scripts: { test: 'vitest run' } });
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining(['@modelcontextprotocol/sdk', 'ajv', 'ajv-formats', 'playwright', 'zod'])
    );
    expect(Object.keys(pkg.devDependencies)).toEqual(expect.arrayContaining(['fast-check', 'vitest', 'vite']));
  });

  it('does not overwrite a package.json or vitest config the user has edited', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'package.json'), '{"name":"mine"}');
    await writeFile(join(dir, 'vitest.config.ts'), '// mine');

    const log = console.log;
    console.log = () => { };
    try {
      await new Compiler().compile(new SchemaInferencer().inferWorkflows(set), dir);
    } finally {
      console.log = log;
    }

    expect(await readFile(join(dir, 'package.json'), 'utf-8')).toBe('{"name":"mine"}');
    expect(await readFile(join(dir, 'vitest.config.ts'), 'utf-8')).toBe('// mine');
  });
});

describe('describeTool', () => {
  it('lists the inputs with their descriptions, or just the label when there are none', () => {
    expect(
      describeTool(
        workflow('x', 'Search', { inputSchema: { properties: { q: { description: 'Search text' }, page: {} } } })
      )
    ).toBe('Search. Inputs: q (Search text), page.');
    expect(describeTool(workflow('x', 'Log out'))).toBe('Log out');
  });
});

describe('toKebabCase', () => {
  it('strips accents, spaces and punctuation', () => {
    expect(toKebabCase('Légacy CRM')).toBe('legacy-crm');
    expect(toKebabCase('  My App!! v2.0 ')).toBe('my-app-v2-0');
  });

  it('limits the name to 64 characters without a trailing dash', () => {
    const result = toKebabCase(`${'a'.repeat(63)} bbb`);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('falls back to daemonize-power for empty or symbol-only names', () => {
    expect(toKebabCase('')).toBe('daemonize-power');
    expect(toKebabCase('!!! ???')).toBe('daemonize-power');
  });
});

describe('KiroPowerGenerator', () => {
  const generate = (targetName: string, workflows: Workflow[], names: string[]) => {
    const toolNames = new Map(workflows.map((w, i) => [w.id, names[i]!]));
    return new KiroPowerGenerator().generate({ ...set, targetName, workflows }, toolNames, join(tmpdir(), 'out'));
  };

  it('names the power after an accented target with spaces', () => {
    const power = generate('Légacy CRM', [workflow('a', 'Create customer')], ['create_customer']);

    expect(power.plugin.name).toBe('legacy-crm');
    expect(Object.keys(power.mcp.mcpServers)).toEqual(['legacy-crm']);
    expect(power.skill).toContain('name: legacy-crm');
  });

  it('falls back to the default name for a symbol-only target', () => {
    const power = generate('***', [workflow('a', 'Go')], ['go']);

    expect(power.plugin.name).toBe('daemonize-power');
  });

  it('emits lowercase keywords without duplicates', () => {
    const power = generate(
      'CRM crm',
      [workflow('a', 'Create'), workflow('b', 'Create')],
      ['create_customer', 'create_customer']
    );
    const keywords = power.plugin.keywords;

    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords.every((k) => k === k.toLowerCase())).toBe(true);
    expect(keywords).toEqual(expect.arrayContaining(['crm', 'create_customer', 'create', 'customer']));
  });

  it('documents a tool without inputs', () => {
    const power = generate('App', [workflow('a', 'Log out')], ['log_out']);

    expect(power.skill).toContain('### `log_out`');
    expect(power.skill).toContain('Inputs: none.');
  });
});
