import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { KiroPowerGenerator, toKebabCase } from '../../src/compiler/kiro-power-generator.js';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Compiler } from '../../src/compiler/compiler.js';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { describeTool, httpSecretSplit, secretEnvNames } from '../../src/compiler/tool-description.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

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
    await removeDir(dir);
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

  it('mentions drifted and driftChecked in the output schema, the OpenAPI document and the skill', async () => {
    const openapi = await readJson('openapi.json');
    const skill = await readFile(join(dir, 'skills', 'legacy-crm', 'SKILL.md'), 'utf-8');
    const response = Object.values<any>(openapi.paths)[0].post.responses['200'];
    const schema = response.content['application/json'].schema;

    expect(schema.properties.drifted.type).toBe('boolean');
    expect(schema.properties.driftChecked.type).toBe('boolean');
    expect(schema.required).toEqual(expect.arrayContaining(['drifted', 'driftChecked']));
    expect(response.description).toContain('drifted');
    expect(skill).toContain('driftChecked');
  });

  it('writes generated files that import nothing from src/', async () => {
    const generated = ['mcp-server', 'replay', 'docker-replay', 'screen-hash'].flatMap((name) => [`${name}.ts`, `${name}.js`]);
    for (const file of generated) {
      const source = await readFile(join(dir, file), 'utf-8');
      const specifiers = [
        ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
        ...source.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']/g),
      ].map((m) => m[1]);

      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/(^|\/)src\//);
      }
    }
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

describe('secrets listed by mode', () => {
  const recipe = (name: string) => ({ method: 'POST', url: 'https://app.test/api/x', query: {}, headers: { 'x-t': { $secret: name } }, bindings: [], redacted: [] });
  // plan: ui, ui, ui, http: the login verify recipe sits on a step that stays on the page
  const twoFactor = workflow('tf', 'Search clients', {
    secrets: ['TYPED'],
    steps: [
      { actionType: 'type', selectors: ['#a'] },
      { actionType: 'click', selectors: ['#b'], http: recipe('TOTP') },
      { actionType: 'click', selectors: ['#c'] },
      { actionType: 'click', selectors: ['#d'], http: recipe('SEARCH') },
    ],
  });

  it('splits the recipe names by whether the compiled mode runs the step over HTTP', () => {
    expect(httpSecretSplit(twoFactor, { http: true })).toEqual({ used: ['SEARCH'], unused: ['TOTP'] });
    expect(httpSecretSplit(twoFactor, {})).toEqual({ used: [], unused: ['SEARCH', 'TOTP'] });
  });

  it('lists typed secrets always and recipe names only for HTTP-planned steps of a --http server', () => {
    expect(secretEnvNames(twoFactor)).toEqual(['DAEMONIZE_SECRET_TYPED']);
    expect(secretEnvNames(twoFactor, { http: false })).toEqual(['DAEMONIZE_SECRET_TYPED']);
    expect(secretEnvNames(twoFactor, { http: true })).toEqual(['DAEMONIZE_SECRET_SEARCH', 'DAEMONIZE_SECRET_TYPED']);
    expect(describeTool(twoFactor, { http: false })).not.toContain('TOTP');
    expect(describeTool(twoFactor, { http: true })).not.toContain('TOTP');
    expect(describeTool(twoFactor, { http: true })).toContain('DAEMONIZE_SECRET_SEARCH');
  });

  it('names the same secrets in mcp.json and SKILL.md as in the tool description', () => {
    const toolNames = new Map([['tf', 'search_clients']]);
    const web = { ...set, workflows: [twoFactor] };
    const without = new KiroPowerGenerator().generate(web, toolNames, join(tmpdir(), 'out'), { http: 'off' });
    expect(Object.keys(Object.values(without.mcp.mcpServers)[0]!.env).sort()).toEqual(['DAEMONIZE_MODE', 'DAEMONIZE_SECRET_TYPED']);
    expect(without.skill).not.toContain('DAEMONIZE_SECRET_TOTP');
    expect(without.skill).not.toContain('DAEMONIZE_SECRET_SEARCH');
    const withHttp = new KiroPowerGenerator().generate(web, toolNames, join(tmpdir(), 'out'), { http: 'auto' });
    expect(Object.keys(Object.values(withHttp.mcp.mcpServers)[0]!.env).sort()).toEqual(['DAEMONIZE_MODE', 'DAEMONIZE_SECRET_SEARCH', 'DAEMONIZE_SECRET_TYPED']);
    expect(withHttp.skill).toContain('`DAEMONIZE_SECRET_SEARCH`');
    expect(withHttp.skill).not.toContain('DAEMONIZE_SECRET_TOTP');
  });

  it('checks recipe secrets only for HTTP-planned steps in the generated replay, and not at all without --http', () => {
    const web = { ...set, workflows: [twoFactor] };
    const generator = new McpGenerator();
    const withHttp = generator.generateReplay(web, { http: 'auto' });
    expect(withHttp.indexOf('const plan = planSteps(steps)')).toBeLessThan(withHttp.indexOf('missingHttpSecrets(httpSteps'));
    expect(withHttp).toContain('httpSecretValues(httpSteps');
    const without = generator.generateReplay(web, {});
    expect(without).not.toContain('missingHttpSecrets');
    const docker = generator.generateDockerReplay(web, 'img', { http: 'auto' });
    expect(docker).toContain('missingHttpSecrets(httpStepsOf(steps)');
    expect(generator.generateDockerReplay(web, 'img', {})).toContain('const HTTP_MISSING_SECRETS = (_steps: Step[], _env?: Record<string, string | undefined>): string[] => [];');
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

describe('Compiler outputs and Visual_Anchors', () => {
  it('keeps rect and intent but no thumbnail path, image data or assets folder in any artifact', async () => {
    const out = await mkdtemp(join(tmpdir(), 'daemonize-visual-'));
    try {
      const withVisual: WorkflowSet = {
        ...set,
        workflows: [
          workflow('d5555555-5555-4555-8555-555555555555', 'Save customer', {
            steps: [
              {
                actionType: 'click',
                selectors: ['#go'],
                visual: {
                  thumbnailPath: 'workflows.json.assets/step-d5555555-5555-4555-8555-555555555555-0.png',
                  rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
                  intent: "Click the button 'Save'",
                },
              },
            ],
          }),
        ],
      };
      const log = console.log;
      console.log = () => { };
      try {
        await new Compiler().compile(new SchemaInferencer().inferWorkflows(withVisual), out);
      } finally {
        console.log = log;
      }
      const files = (await readdir(out, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      expect(files.length).toBeGreaterThan(5);
      for (const entry of files) {
        const text = await readFile(join(entry.parentPath, entry.name), 'utf-8');
        if (entry.name === '.dockerignore') continue; // lists `*.assets` as something to leave out of the image
        expect(text, entry.name).not.toMatch(/data:image\/[a-z+]+;base64,[A-Za-z0-9+\/]{40,}|iVBORw0KGgo|\.assets[\\/]|step-d5555555/);
      }
    } finally {
      await removeDir(out);
    }
  });
});
