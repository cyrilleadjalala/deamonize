import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names.js';
import { scanForSecretShapes } from '../../scripts/lib/secret-scan.mjs';

const root = resolve(__dirname, '..', '..');
const doc = readFileSync(resolve(root, 'docs', 'dogfooding.md'), 'utf8');

describe('docs/dogfooding.md', () => {
  it('names only Studio MCP tools that exist, and names some', () => {
    const named = [...doc.matchAll(/daemonize-studio\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(STUDIO_MCP_TOOL_NAMES as readonly string[], n).toContain(n);
  });

  it('leaves the table of recorded calls empty and says why', () => {
    const section = doc.split('## Calls recorded during development')[1] ?? '';
    const rows = section.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(2); // header and separator only
    expect(section).toMatch(/empty on purpose/);
    expect(section).toMatch(/have not happened yet/);
  });

  it('says which parts were not done with the agent', () => {
    expect(doc).toMatch(/## What was not done with the agent/);
  });

  it('holds no secret, token or absolute user path', () => {
    expect(scanForSecretShapes(doc)).toEqual([]);
    expect(doc).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[A-Za-z]/);
  });

  it('the settings example and gitignore are in place', () => {
    const example = JSON.parse(readFileSync(resolve(root, '.kiro', 'settings', 'mcp.json.example'), 'utf8'));
    expect(example.mcpServers['daemonize-studio'].args).toEqual(['mcp']);
    expect(example.mcpServers['daemonize-studio'].env).toEqual({});
    const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('.kiro/settings/mcp.json');
    expect(ignore).toContain('kiro-extension/templates/');
    expect(existsSync(resolve(root, 'examples', 'adminer'))).toBe(true);
  });
});
