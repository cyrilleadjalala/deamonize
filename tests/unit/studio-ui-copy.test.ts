import { describe, it, expect } from 'vitest';
import * as common from '../../src/studio/messages/common.js';
import * as secretsMessages from '../../src/studio/messages/secrets.js';
import * as recordMessages from '../../src/studio/messages/record.js';
import * as compileMessages from '../../src/studio/messages/compile.js';
// @ts-expect-error no type declarations for the browser modules
import { COPY, TECHNICAL_TEXTS, allCopyTexts, displayName } from '../../src/studio/ui/js/copy.js';

/** The eight Plain_Language terms, as whole words, case-insensitive. */
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;
/** File paths such as settings/mcp.json are shown in code.path elements and are exempt (Requirement 12.1). */
const withoutPaths = (text: string): string => text.replace(/[\w.-]+(?:\/[\w.<>-]+)+|[\w-]+\.json\b/g, '');
const banned = (text: string): boolean => BANNED.test(withoutPaths(text));

// Server texts that are protocol answers (tests and logs read them), or that no screen of the first flow shows.
const NOT_USER_COPY = new Set<string>([common.BODY_TOO_LARGE, common.BODY_NOT_JSON, common.BODY_NOT_OBJECT, common.LOAD_UNREADABLE, common.LOAD_TOO_LARGE, common.LOAD_INVALID]);

function strings(module: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(module).filter((e): e is [string, string] => typeof e[1] === 'string');
}

describe('Plain-language copy of the first flow', () => {
  it('has no banned term in any text of copy.js, outside the technical option', () => {
    const offenders = (allCopyTexts() as string[]).filter((t) => !TECHNICAL_TEXTS.has(t) && banned(t));
    expect(offenders).toEqual([]);
  });

  it('keeps the explicit technical option exactly as the requirement words it', () => {
    expect(COPY.copyMcp).toBe('Copy MCP configuration');
    expect([...TECHNICAL_TEXTS]).toEqual([COPY.copyMcp, COPY.copyMcpDone]);
  });

  it('has no banned term in the server messages of the first flow', () => {
    const offenders: string[] = [];
    for (const [file, mod] of [['common', common], ['secrets', secretsMessages], ['record', recordMessages], ['compile', compileMessages]] as const) {
      for (const [name, text] of strings(mod as Record<string, unknown>)) {
        if (NOT_USER_COPY.has(text)) continue;
        if (banned(text)) offenders.push(`${file}.${name}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('words the vault credentials message exactly and keeps it plain', () => {
    expect(COPY.credentialsFromVault).toBe('This tool will use the passwords you saved in Daemonize. Nothing else to set up.');
    expect(banned(COPY.credentialsFromVault)).toBe(false);
    expect((allCopyTexts() as string[]).includes(COPY.credentialsFromVault)).toBe(true);
  });

  it('shows the sentence-case name and the three kind words', () => {
    expect(displayName('CRM_PASSWORD')).toBe('Crm password');
    expect(COPY.kindPassword).toBe('Password');
    expect(COPY.kindTotp).toBe('Authenticator key');
    expect(COPY.kindToken).toBe('Access code');
  });
});

