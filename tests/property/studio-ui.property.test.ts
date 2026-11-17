import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as common from '../../src/studio/messages/common.js';
import * as secretsMessages from '../../src/studio/messages/secrets.js';
import * as recordMessages from '../../src/studio/messages/record.js';
import * as compileMessages from '../../src/studio/messages/compile.js';
import { validateName, validateUrl } from '../../src/studio/validate-action.js';
// @ts-expect-error no type declarations for the browser modules
import { validateName as uiName, validateUrl as uiUrl } from '../../src/studio/ui/js/validate.js';
// @ts-expect-error no type declarations for the browser modules
import { announceOnChange, resetAnnouncer } from '../../src/studio/ui/js/announcer.js';
import {
  COMPILE_PHASES,
  COMPILE_STATES,
  COPY,
  RECORDING_STATES,
  SECRET_KINDS,
  TECHNICAL_TEXTS,
  announceText,
  configuredText,
  displayName,
  kindWord,
  statusText,
  stepCountText,
  // @ts-expect-error no type declarations for the browser modules
} from '../../src/studio/ui/js/copy.js';

// Feature: studio-first-flow, Property 1: Action input validation
describe('Property 1: the UI validators equal the server validators', () => {
  const nameArb = fc.oneof(fc.string({ maxLength: 100 }), fc.string({ unit: 'binary', maxLength: 90 }), fc.constantFrom('', '   ', 'ok', ' a ', 'x\ny', 'a'.repeat(81)));
  const urlArb = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.webUrl(),
    fc.webUrl().map((u) => u.replace('://', '://user:pw@')),
    fc.constantFrom('', 'ftp://h/', 'file:///x', 'javascript:1', 'http://h', '  https://h/p  ', `https://h/${'a'.repeat(2050)}`)
  );

  it('gives the same verdict, value and message for every pair', () => {
    // **Validates: Requirements 3.6, 3.7, 3.8**
    fc.assert(
      fc.property(nameArb, urlArb, (name, url) => {
        expect(uiName(name)).toEqual(validateName(name));
        expect(uiUrl(url)).toEqual(validateUrl(url));
      }),
      { numRuns: 300 }
    );
  });
});

// Feature: studio-first-flow, Property 25: One announcement per state change
describe('Property 25: one announcement per state change', () => {
  beforeEach(() => resetAnnouncer());

  it('announces exactly once for each change of state and never for a repeated state', () => {
    // **Validates: Requirements 12.7**
    const states = fc.array(fc.constantFrom('idle', 'recording', 'saving', 'compiling', 'done', 'error'), { maxLength: 60 });
    fc.assert(
      fc.property(states, (sequence) => {
        resetAnnouncer();
        const said: string[] = [];
        for (const state of sequence) announceOnChange('recording', state, announceText('recording', state), (t: string) => said.push(t));
        let changes = 0;
        for (let i = 0; i < sequence.length; i++) if (i === 0 || sequence[i] !== sequence[i - 1]) changes++;
        expect(said).toHaveLength(changes);
      }),
      { numRuns: 200 }
    );
  });

  it('keeps one memory per channel', () => {
    const said: string[] = [];
    const say = (t: string): void => void said.push(t);
    announceOnChange('recording', 'done', 'a', say);
    announceOnChange('compile', 'done', 'b', say);
    announceOnChange('recording', 'done', 'a', say);
    expect(said).toEqual(['a', 'b']);
  });
});

// Feature: studio-first-flow, Property 24: Plain-language copy
describe('Property 24: plain-language copy', () => {
  const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;
  // File paths such as settings/mcp.json are shown in code.path elements and are exempt (Requirement 12.1)
  const withoutPaths = (text: string): string => text.replace(/[\w.-]+(?:\/[\w.<>-]+)+|[\w-]+\.json\b/g, '');

  it('builds no banned term for any state, phase, kind, status or step count', () => {
    // **Validates: Requirements 10.2, 12.1**
    fc.assert(
      fc.property(
        fc.constantFrom(...RECORDING_STATES),
        fc.constantFrom(...COMPILE_STATES),
        fc.constantFrom(...COMPILE_PHASES),
        fc.constantFrom(...SECRET_KINDS),
        fc.boolean(),
        fc.integer({ min: -5, max: 100000 }),
        (recording: string, compile: string, phase: string | null, kind: string, configured: boolean, steps: number) => {
          const texts: string[] = [
            statusText('recording', recording),
            announceText('recording', recording),
            statusText('compile', compile, phase),
            announceText('compile', compile, phase),
            kindWord(kind),
            configuredText(configured),
            stepCountText(steps),
          ];
          for (const text of texts) expect(BANNED.test(text), text).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('shows a sentence-case name, never the variable form, for any secret name', () => {
    // **Validates: Requirements 10.2**
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/), (name) => {
        const shown = displayName(name);
        expect(shown).not.toContain('DAEMONIZE_SECRET');
        expect(shown).not.toContain('_');
        expect(shown.charAt(0)).toBe(shown.charAt(0).toUpperCase());
      }),
      { numRuns: 100 }
    );
  });

  it('builds no banned term in any server message or COPY entry (the technical option excepted)', () => {
    // **Validates: Requirements 12.1**
    const protocol = new Set<string>([common.BODY_TOO_LARGE, common.BODY_NOT_JSON, common.BODY_NOT_OBJECT, common.LOAD_UNREADABLE, common.LOAD_TOO_LARGE, common.LOAD_INVALID]);
    const server = [common, secretsMessages, recordMessages, compileMessages]
      .flatMap((mod) => Object.values(mod as Record<string, unknown>))
      .filter((v): v is string => typeof v === 'string' && !protocol.has(v));
    const ui = (Object.values(COPY) as string[]).filter((t) => !TECHNICAL_TEXTS.has(t));
    const pool = [...server, ...ui];
    expect(pool.length).toBeGreaterThan(20);
    fc.assert(fc.property(fc.constantFrom(...pool), (text) => !BANNED.test(withoutPaths(text))), { numRuns: Math.min(pool.length * 2, 400) });
  });
});

