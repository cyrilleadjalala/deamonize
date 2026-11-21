import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names.js';
import { bannedTermsIn } from '../../kiro-extension/src/core/plain-language.js';

const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const SKILL = '.kiro/skills/daemonize-builder/SKILL.md';
const text = read(SKILL);
const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
const front = parse(m[1]) as Record<string, string>;
const body = m[2]!;

function section(title: string): string {
  const parts = body.split(/^## /m);
  const hit = parts.find((p) => p.startsWith(`${title}\n`));
  if (hit === undefined) throw new Error(`missing section ${title}`);
  return hit;
}

describe('Builder_Skill', () => {
  it('has name and a short description', () => {
    expect(Object.keys(front).sort()).toEqual(['description', 'name']);
    expect(front.name).toBe('daemonize-builder');
    expect(front.description.length).toBeLessThanOrEqual(300);
    expect(front.description).toMatch(/^Use when/);
  });

  it('has the four required sections', () => {
    for (const t of ['When to use', 'Steps', 'Safety rules', 'Troubleshooting']) expect(section(t).length).toBeGreaterThan(40);
    expect(section('When to use')).toMatch(/no API/);
    expect(section('When to use')).toMatch(/Do not use Daemonize/);
  });

  it('names every Studio MCP tool, and only those', () => {
    const named = new Set([...body.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((x) => x[1]!));
    for (const tool of STUDIO_MCP_TOOL_NAMES) expect(named.has(tool), tool).toBe(true);
    const steps = section('Steps');
    for (const tool of STUDIO_MCP_TOOL_NAMES) expect(steps).toContain(`\`${tool}\``);
    const known = new Set<string>(STUDIO_MCP_TOOL_NAMES);
    const results = ['missing_secret', 'drifted', 'approval_denied', 'approval_timeout', 'approval_unavailable', 'storage_state_missing'];
    for (const n of named) if (/_/.test(n) && !results.includes(n)) expect(known.has(n), n).toBe(true);
  });

  it('covers the six results and the safety rules', () => {
    const t = section('Troubleshooting');
    for (const r of ['missing_secret', 'drifted', 'approval_denied', 'approval_timeout', 'approval_unavailable', 'storage_state_missing']) expect(t).toContain(`\`${r}\``);
    expect(t).toMatch(/time-out/);
    const s = section('Safety rules');
    expect(s).toMatch(/Credentials screen/);
    expect(s).toMatch(/drifted: true/);
    expect(s).toMatch(/approval/);
  });

  it('is plain language with no secret, token or user path', () => {
    expect(bannedTermsIn(`${front.description}\n${body}`)).toEqual([]);
    expect(text).not.toMatch(/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z]:\\Users\\|\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\/)/);
  });

  it('the power copy has the same bytes', () => {
    expect(readFileSync(resolve(root, 'power/skills/daemonize-builder/SKILL.md'))).toEqual(readFileSync(resolve(root, SKILL)));
  });
});