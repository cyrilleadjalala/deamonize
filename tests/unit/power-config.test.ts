import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mergeServer, parseConfig, removeServer, serialize, sha256, targetPaths } from '../../src/studio/power-config.js';
import type { ServerEntry } from '../../src/studio/mcp-snippet.js';

const entry: ServerEntry = { type: 'stdio', command: 'node', args: ['/x.js'], env: { DAEMONIZE_MODE: 'strict' } };

describe('power-config', () => {
  it('parses objects and reports each refusal reason', () => {
    expect(parseConfig(Buffer.from('{"a":1}')).ok).toBe(true);
    expect(parseConfig(Buffer.from('{nope'))).toEqual({ ok: false, reason: 'json' });
    expect(parseConfig(Buffer.from('[1]'))).toEqual({ ok: false, reason: 'not-object' });
    expect(parseConfig(Buffer.from('null'))).toEqual({ ok: false, reason: 'not-object' });
    expect(parseConfig(Buffer.from('{"mcpServers":[]}'))).toEqual({ ok: false, reason: 'servers-not-object' });
  });

  it('merges next to other servers and keeps other root keys', () => {
    const root = { powers: { a: 1 }, mcpServers: { other: { command: 'x' } } };
    const merged = mergeServer(root, 'app', entry) as { powers: unknown; mcpServers: Record<string, unknown> };
    expect(merged.powers).toEqual({ a: 1 });
    expect(merged.mcpServers.other).toEqual({ command: 'x' });
    expect(merged.mcpServers.app).toEqual(entry);
    expect(root.mcpServers).toEqual({ other: { command: 'x' } }); // input untouched
    expect(Object.keys(mergeServer({}, 'app', entry))).toEqual(['mcpServers']);
  });

  it('removes only the named entry', () => {
    const root = { mcpServers: { app: {}, other: { a: 1 } } };
    const out = removeServer(root, 'app');
    expect(out.removed).toBe(true);
    expect(out.root).toEqual({ mcpServers: { other: { a: 1 } } });
    expect(removeServer(root, 'zzz').removed).toBe(false);
    expect(removeServer({}, 'app').removed).toBe(false);
  });

  it('serializes with two spaces and a final newline, and hashes the bytes', () => {
    const bytes = serialize({ a: 1 });
    expect(bytes.toString()).toBe('{\n  "a": 1\n}\n');
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes the target paths', () => {
    const t = targetPaths('global', join('h', '.kiro'), 'app');
    expect(t.mcp).toBe(join('h', '.kiro', 'settings', 'mcp.json'));
    expect(t.backup).toBe(t.mcp + '.bak');
    expect(t.skillDir).toBe(join('h', '.kiro', 'skills', 'app'));
    expect(t.skill).toBe(join(t.skillDir, 'SKILL.md'));
  });
});
