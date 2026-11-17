import { describe, expect, it } from 'vitest';
import { buildServerEntry, buildSnippetText, secretPlaceholders } from '../../src/studio/mcp-snippet.js';

const VALUE = ['Planted', 'Secret', 'Value-98765'].join('');

describe('mcp snippet', () => {
  it('rebuilds the entry with placeholders only and strict mode', () => {
    const entry = buildServerEntry(
      {
        type: 'sse',
        command: 'rm',
        args: ['-rf'],
        env: { DAEMONIZE_SECRET_A: VALUE, DAEMONIZE_MODEL_NAME: VALUE, DAEMONIZE_MODEL_OTHER: VALUE, PATH: VALUE, DAEMONIZE_MODE: 'heal' },
      },
      '/abs/mcp-server.js'
    );
    expect(entry).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/abs/mcp-server.js'],
      env: { DAEMONIZE_SECRET_A: '${DAEMONIZE_SECRET_A}', DAEMONIZE_MODEL_NAME: '${DAEMONIZE_MODEL_NAME}', DAEMONIZE_MODE: 'strict' },
    });
    expect(JSON.stringify(entry)).not.toContain(VALUE);
    expect(secretPlaceholders(entry)).toEqual(['DAEMONIZE_SECRET_A']);
  });

  it('survives a source without an env', () => {
    expect(buildServerEntry(undefined, '/x.js').env).toEqual({ DAEMONIZE_MODE: 'strict' });
    expect(buildServerEntry({ env: [] }, '/x.js').env).toEqual({ DAEMONIZE_MODE: 'strict' });
  });

  it('adds data dir and app key, and placeholders only for names that are not stored', () => {
    const source = { env: { DAEMONIZE_SECRET_A: VALUE, DAEMONIZE_SECRET_B: VALUE } };
    const ctx = { dataDir: '/data', applicationKey: 'https://x.test' };
    const none = buildServerEntry(source, '/x.js', { ...ctx, configuredNames: new Set() });
    expect(Object.keys(none).sort()).toEqual(['args', 'command', 'env', 'type']);
    expect(none.env).toEqual({
      DAEMONIZE_MODE: 'strict', DAEMONIZE_DATA_DIR: '/data', DAEMONIZE_APP_KEY: 'https://x.test',
      DAEMONIZE_SECRET_A: '${DAEMONIZE_SECRET_A}', DAEMONIZE_SECRET_B: '${DAEMONIZE_SECRET_B}',
    });
    const some = buildServerEntry(source, '/x.js', { ...ctx, configuredNames: new Set(['A']) });
    expect(secretPlaceholders(some)).toEqual(['DAEMONIZE_SECRET_B']);
    const all = buildServerEntry(source, '/x.js', { ...ctx, configuredNames: new Set(['A', 'B']) });
    expect(secretPlaceholders(all)).toEqual([]);
    expect(JSON.stringify([none, some, all])).not.toContain(VALUE);
  });

  it('builds the snippet text as an mcpServers object', () => {
    const entry = buildServerEntry({ env: { DAEMONIZE_SECRET_A: VALUE } }, '/x.js');
    expect(JSON.parse(buildSnippetText('app', entry))).toEqual({ mcpServers: { app: entry } });
  });
});
