// Feature: kiro-global-connect-vault-bridge, Property 11: Server_Entry shape and placeholder rule
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildServerEntry } from '../../src/studio/mcp-snippet.js';

const name = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/);
const VALUE = 'Planted-Value-';

describe('Property 11: Server_Entry shape and placeholder rule', () => {
  /** **Validates: Requirements 3.12, 8.1, 8.2, 8.3, 8.4** */
  it('has the exact shape and a placeholder for exactly the required, not stored names', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(name, { maxLength: 6 }),
        fc.array(fc.boolean(), { maxLength: 6 }),
        fc.stringMatching(/^[A-Za-z0-9_/]{1,20}$/),
        fc.stringMatching(/^https?:\/\/[a-z0-9.]{1,20}$/),
        (required, flags, dir, appKey) => {
          const stored = new Set(required.filter((_, i) => flags[i] === true));
          const sourceEnv: Record<string, string> = {};
          required.forEach((n, i) => (sourceEnv['DAEMONIZE_SECRET_' + n] = VALUE + i));
          const source = { type: 'sse', command: 'x', env: sourceEnv, extra: VALUE };
          const entry = buildServerEntry(source, '/abs/mcp-server.js', { dataDir: dir, applicationKey: appKey, configuredNames: stored });

          expect(Object.keys(entry).sort()).toEqual(['args', 'command', 'env', 'type']);
          expect(entry.type).toBe('stdio');
          expect(entry.command).toBe('node');
          expect(entry.args).toEqual(['/abs/mcp-server.js']);
          expect(entry.env.DAEMONIZE_MODE).toBe('strict');
          expect(entry.env.DAEMONIZE_DATA_DIR).toBe(dir);
          expect(entry.env.DAEMONIZE_APP_KEY).toBe(appKey);
          const placeholders = Object.keys(entry.env).filter((k) => k.startsWith('DAEMONIZE_SECRET_'));
          expect(placeholders.sort()).toEqual(required.filter((n) => !stored.has(n)).map((n) => 'DAEMONIZE_SECRET_' + n).sort());
          for (const k of placeholders) expect(entry.env[k]).toBe('${' + k + '}');
          expect(JSON.stringify(entry)).not.toContain(VALUE);
        }
      ),
      { numRuns: 100 }
    );
  });
});
