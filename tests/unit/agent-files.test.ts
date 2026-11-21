import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { STUDIO_MCP_ALLOWED_TOOLS, STUDIO_MCP_ASK_TOOLS, STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names.js';
import { bannedTermsIn } from '../../kiro-extension/src/core/plain-language.js';

const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

/** Fields of the Kiro agent configuration reference. */
const DOCUMENTED_FIELDS = new Set([
  'name', 'description', 'prompt', 'mcpServers', 'tools', 'toolAliases', 'allowedTools', 'permissions', 'toolsSettings',
  'resources', 'hooks', 'includeMcpJson', 'includePowers', 'excludedTools', 'model', 'keyboardShortcut', 'welcomeMessage',
]);
const SERVER_FIELDS = new Set(['command', 'url', 'args', 'env', 'timeout', 'requestTimeout', 'oauth', 'oauthScopes', 'type', 'headers']);
const RULE_FIELDS = new Set(['capability', 'match', 'effect', 'exclude']);

function splitFrontMatter(text: string): { front: Record<string, any>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no front matter');
  return { front: parse(m[1]) as Record<string, any>, body: m[2] };
}

const FILES = ['.kiro/agents/daemonize.md', 'power/agents/daemonize.md'];

describe('Builder_Agent files', () => {
  for (const file of FILES) {
    describe(file, () => {
      const text = read(file);
      const { front, body } = splitFrontMatter(text);

      it('uses only documented fields', () => {
        for (const key of Object.keys(front)) expect(DOCUMENTED_FIELDS.has(key), key).toBe(true);
        for (const server of Object.values<any>(front.mcpServers)) for (const key of Object.keys(server)) expect(SERVER_FIELDS.has(key), key).toBe(true);
        for (const rule of front.permissions.rules) for (const key of Object.keys(rule)) expect(RULE_FIELDS.has(key), key).toBe(true);
        for (const absent of ['model', 'prompt', 'hooks', 'includePowers', 'toolsSettings']) expect(front[absent]).toBeUndefined();
      });

      it('has the required header', () => {
        expect(front.name).toBe('daemonize');
        expect(String(front.description).length).toBeLessThanOrEqual(200);
        expect(front.tools).toEqual(['read', '@daemonize-studio']);
        expect(typeof front.welcomeMessage).toBe('string');
        expect(front.mcpServers['daemonize-studio'].requestTimeout).toBe(300000);
        expect(text).toMatch(/#.*unverified/i);
        expect(body.trim().length).toBeGreaterThan(200);
      });

      it('has no allow rule for shell or fs_write, and denies both', () => {
        const rules: any[] = front.permissions.rules;
        expect(rules.filter((r) => ['shell', 'fs_write'].includes(r.capability) && r.effect === 'allow')).toEqual([]);
        expect(rules.some((r) => r.capability === 'shell' && r.effect === 'deny' && r.match.includes('**') && r.match.includes('*'))).toBe(true);
        expect(rules.some((r) => r.capability === 'fs_write' && r.effect === 'deny' && r.match.includes('**'))).toBe(true);
        expect(rules.some((r) => r.capability === 'fs_read' && r.effect === 'allow')).toBe(true);
        expect(rules.some((r) => r.capability === 'fs_read' && r.effect === 'deny' && r.match.length === 3)).toBe(true);
      });

      it('names exactly the Studio MCP tools, allow and ask', () => {
        const mcp = (effect: string): string[] =>
          (front.permissions.rules as any[]).filter((r) => r.capability === 'mcp' && r.effect === effect).flatMap((r) => r.match as string[]);
        const strip = (names: string[]): string[] => names.map((n) => n.replace(/^daemonize-studio\//, ''));
        expect(strip(mcp('allow')).sort()).toEqual([...STUDIO_MCP_ALLOWED_TOOLS].sort());
        expect(strip(mcp('ask')).sort()).toEqual([...STUDIO_MCP_ASK_TOOLS].sort());
        expect([...strip(mcp('allow')), ...strip(mcp('ask'))].sort()).toEqual([...STUDIO_MCP_TOOL_NAMES].sort());
        expect((front.permissions.rules as any[]).some((r) => r.capability === 'mcp' && r.effect === 'deny')).toBe(false);
      });

      it('mcp env values, if any, are placeholders', () => {
        for (const server of Object.values<any>(front.mcpServers)) for (const v of Object.values<string>(server.env ?? {})) expect(v).toMatch(/^\$\{[A-Z0-9_]+\}$/);
      });

      it('uses plain language and holds no secret', () => {
        expect(bannedTermsIn(`${front.description}\n${front.welcomeMessage}\n${body}`)).toEqual([]);
        expect(text).not.toMatch(/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z]:\\Users\\|\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\/)/);
        expect(text).toMatch(/Credentials screen/);
      });

      it('lists the journey in order', () => {
        const order = ['list_actions', 'start_recording', 'finish_recording', 'update_action', 'compile', 'test_action', 'install_to_kiro', 'list_credentials'];
        const at = order.map((n) => body.indexOf(`\`${n}\``));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect(body.indexOf('start_recording')).toBeLessThan(body.indexOf('compile'));
        expect(body.indexOf('compile')).toBeLessThan(body.indexOf('test_action'));
        expect(body.indexOf('test_action')).toBeLessThan(body.indexOf('install_to_kiro'));
      });
    });
  }

  it('the .kiro resources resolve to existing files', () => {
    const { front } = splitFrontMatter(read('.kiro/agents/daemonize.md'));
    expect(front.resources).toEqual(['file://.kiro/steering/product.md', 'file://README.md', 'skill://.kiro/skills/daemonize-builder/SKILL.md']);
    for (const r of front.resources as string[]) expect(existsSync(resolve(root, r.replace(/^(file|skill):\/\//, ''))), r).toBe(true);
  });

  it('the power copy differs only in resources', () => {
    const a = splitFrontMatter(read('.kiro/agents/daemonize.md'));
    const b = splitFrontMatter(read('power/agents/daemonize.md'));
    expect(b.body).toBe(a.body);
    const { resources: ra, ...restA } = a.front;
    const { resources: rb, ...restB } = b.front;
    expect(restB).toEqual(restA);
    expect(rb).toEqual(['file://steering/daemonize-rules.md', 'skill://skills/daemonize-builder/SKILL.md']);
    expect(ra).not.toEqual(rb);
  });
});