// Feature: kiro-thin-extension, Property 13: A failed-request log line holds the method, the path without query, and the status
// **Validates: Requirements 9.6**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createStudioClient, StudioClientError, type ClientErrorKind, type Transport } from '../../../kiro-extension/src/core/studio-client';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const path = fc.stringMatching(/^\/api\/[a-z]{1,8}(\/[a-z]{1,8})?$/);
const query = fc.option(fc.stringMatching(/^[a-z]{1,4}=SECRETQ[0-9]{1,6}$/), { nil: undefined });
type Outcome = { kind: 'status'; status: number } | { kind: 'fail'; error: ClientErrorKind } | { kind: 'plain' };
const outcome: fc.Arbitrary<Outcome> = fc.oneof(
  fc.integer({ min: 500, max: 599 }).map((status) => ({ kind: 'status' as const, status })),
  fc.constantFrom(302, 301, 401).map((status) => ({ kind: 'status' as const, status })),
  fc.constantFrom<ClientErrorKind>('network', 'timeout', 'too-large').map((error) => ({ kind: 'fail' as const, error })),
  fc.constant({ kind: 'plain' as const })
);

describe('Property 13: failed-request log line', () => {
  it('is exactly "METHOD path status-or-kind"', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('GET' as const, 'POST' as const), path, query, outcome, async (method, p, q, out) => {
        const lines: string[] = [];
        const transport: Transport = {
          send: async () => {
            if (out.kind === 'fail') throw new StudioClientError(out.error, 'x');
            if (out.kind === 'plain') throw new Error(`boom ${TOKEN}`);
            return { status: out.status, text: '{"secretBody":"BODYTEXT"}' };
          },
        };
        const client = createStudioClient({ origin: 'http://127.0.0.1:5000', token: TOKEN, transport, log: (l) => lines.push(l) });
        const full = q === undefined ? p : `${p}?${q}`;
        await (method === 'GET' ? client.get(full) : client.post(full, { value: 'VALUE123' })).catch(() => undefined);
        const tail = out.kind === 'status' ? String(out.status) : out.kind === 'fail' ? out.error : 'network';
        expect(lines).toEqual([`${method} ${p} ${tail}`]);
        expect(lines[0]).not.toMatch(/SECRETQ|BODYTEXT|VALUE123/);
        expect(lines[0]).not.toContain(TOKEN);
      }),
      { numRuns: 200 }
    );
  });
});
