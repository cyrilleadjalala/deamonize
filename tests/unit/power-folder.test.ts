import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { KiroPowerGenerator, toKebabCase } from '../../src/compiler/kiro-power-generator.js';
import { scanForSecretShapes } from '../../scripts/lib/secret-scan.mjs';
import { STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names.js';
import type { WorkflowSet } from '../../src/types.js';

const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(root, 'power', p), 'utf8');
const json = (p: string): Record<string, any> => JSON.parse(read(p));
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function front(text: string): Record<string, any> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new Error('no front matter');
  return parse(m[1]) as Record<string, any>;
}

/** Collects every string of a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

// What the real generator writes for a small set, to compare shapes
const sample = {
  targetType: 'web',
  targetName: 'Sample',
  workflows: [{ id: 'w1', name: 'one', steps: [], inputSchema: { type: 'object', properties: {} } }],
} as unknown as WorkflowSet;
const generated = new KiroPowerGenerator().generate(sample, new Map([['w1', 'one']]), 'out');

describe('power folder', () => {
  const plugin = json('plugin.json');
  const mcp = json('mcp.json');
  const powerFront = front(read('POWER.md'));

  it('has the files of the Power layout', () => {
    for (const f of ['POWER.md', 'plugin.json', 'mcp.json', 'steering/daemonize-rules.md', 'skills/daemonize-builder/SKILL.md', 'agents/daemonize.md']) {
      expect(existsSync(resolve(root, 'power', f)), f).toBe(true);
    }
  });

  it('holds no file outside the list and the steering files', () => {
    const top = readdirSync(resolve(root, 'power')).sort();
    expect(top).toEqual(['POWER.md', 'agents', 'mcp.json', 'plugin.json', 'skills', 'steering']);
    expect(readdirSync(resolve(root, 'power', 'agents'))).toEqual(['daemonize.md']);
    expect(readdirSync(resolve(root, 'power', 'skills'))).toEqual(['daemonize-builder']);
    expect(readdirSync(resolve(root, 'power', 'steering')).every((n) => n.endsWith('.md'))).toBe(true);
  });

  it('plugin.json has the same keys as the generated one', () => {
    expect(Object.keys(plugin).sort()).toEqual(Object.keys(generated.plugin).sort());
    expect(plugin.$schema).toBe(generated.plugin.$schema);
    expect(typeof plugin.author.name).toBe('string');
    expect(Array.isArray(plugin.keywords)).toBe(true);
  });

  it('mcp.json has the shape of the generated one', () => {
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(generated.mcp).sort());
    expect(mcp.$schema).toBe(generated.mcp.$schema);
    const entries = Object.entries<any>(mcp.mcpServers);
    expect(entries).toHaveLength(1);
    const [, server] = entries[0];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('daemonize');
    expect(server.args).toEqual(['mcp']);
    for (const v of Object.values<string>(server.env)) expect(/^\$\{[A-Z0-9_]+\}$/.test(v) || !scanForSecretShapes(v).length).toBe(true);
  });

  it('POWER.md front matter has the generated keys', () => {
    const generatedFront = front(generated.powerMd);
    expect(Object.keys(powerFront).sort()).toEqual(Object.keys(generatedFront).sort());
    expect(powerFront.displayName).toBe('Daemonize');
  });

  it('uses the same kebab-case name in the three places', () => {
    const key = Object.keys(mcp.mcpServers)[0];
    expect(plugin.name).toBe('daemonize-studio');
    expect(powerFront.name).toBe(plugin.name);
    expect(key).toBe(plugin.name);
    expect(KEBAB.test(plugin.name) && plugin.name.length <= 64).toBe(true);
    expect(toKebabCase(plugin.name)).toBe(plugin.name);
  });

  it('the agent resources resolve inside power/', () => {
    const agent = front(read('agents/daemonize.md'));
    for (const r of agent.resources as string[]) {
      const rel = r.replace(/^(file|skill):\/\//, '');
      expect(existsSync(resolve(root, 'power', rel)), r).toBe(true);
    }
  });

  it('POWER.md lists every Studio MCP tool, and the steering covers secrets and drift', () => {
    const power = read('POWER.md');
    for (const n of STUDIO_MCP_TOOL_NAMES) expect(power, n).toContain('`' + n + '`');
    const rules = read('steering/daemonize-rules.md');
    expect(rules).toMatch(/Credentials screen/);
    expect(rules).toMatch(/drifted/);
  });

  it('holds no secret shape, no token and no absolute user path', () => {
    const texts = [read('POWER.md'), read('plugin.json'), read('mcp.json'), read('steering/daemonize-rules.md'), ...strings(plugin), ...strings(mcp)];
    for (const t of texts) {
      expect(scanForSecretShapes(t), t.slice(0, 40)).toEqual([]);
      expect(t).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[A-Za-z]/);
    }
  });
});
