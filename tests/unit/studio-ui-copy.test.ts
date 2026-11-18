import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as common from '../../src/studio/messages/common.js';
import * as secretsMessages from '../../src/studio/messages/secrets.js';
import * as recordMessages from '../../src/studio/messages/record.js';
import * as compileMessages from '../../src/studio/messages/compile.js';
// @ts-expect-error no type declarations for the browser modules
import { COPY, COPY_COMPILE, COPY_EDITOR, COPY_RECORD, TECHNICAL_TEXTS, allCopyTexts, displayName } from '../../src/studio/ui/js/copy.js';

/** The eight Plain_Language terms, as whole words, case-insensitive. */
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;
/** File paths such as settings/mcp.json are shown in code.path elements and are exempt (Requirement 12.1). */
const withoutPaths = (text: string): string => text.replace(/[\w.-]+(?:\/[\w.<>-]+)+|[\w-]+\.json\b/g, '');
const banned = (text: string): boolean => BANNED.test(withoutPaths(text));

// Server texts that are protocol answers (tests and logs read them), or that no screen of the first flow shows.
const NOT_USER_COPY = new Set<string>([common.BODY_TOO_LARGE, common.BODY_NOT_JSON, common.BODY_NOT_OBJECT, common.LOAD_UNREADABLE, common.LOAD_TOO_LARGE, common.LOAD_INVALID]);

const MESSAGES_DIR = resolve(import.meta.dirname, '../../src/studio/messages');
const UI_JS_DIR = resolve(import.meta.dirname, '../../src/studio/ui/js');

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

  it('scans every module of messages/ and finds the workflows messages among them', async () => {
    const names = readdirSync(MESSAGES_DIR).filter((name) => name.endsWith('.ts') && name !== 'index.ts');
    expect(names).toEqual(expect.arrayContaining(['common.ts', 'compile.ts', 'record.ts', 'secrets.ts', 'workflows.ts']));
    const offenders: string[] = [];
    for (const name of names) {
      const mod = (await import(pathToFileURL(join(MESSAGES_DIR, name)).href)) as Record<string, unknown>;
      for (const [exported, text] of strings(mod)) {
        if (NOT_USER_COPY.has(text)) continue;
        if (banned(text)) offenders.push(name + '.' + exported + ': ' + text);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no banned term in any copy-*.js module (record, editor, compile, secrets)', async () => {
    const names = readdirSync(UI_JS_DIR).filter((name) => /^copy-.+\.js$/.test(name));
    expect(names).toEqual(expect.arrayContaining(['copy-record.js', 'copy-editor.js', 'copy-compile.js', 'copy-secrets.js']));
    const offenders: string[] = [];
    for (const name of names) {
      const mod = (await import(pathToFileURL(join(UI_JS_DIR, name)).href)) as Record<string, unknown>;
      const texts: string[] = [];
      for (const value of Object.values(mod)) {
        if (value !== null && typeof value === 'object') texts.push(...Object.values(value as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
        if (typeof value === 'function' && value.length === 0 && /^all\w*Texts$/.test(value.name)) texts.push(...(value() as string[]));
      }
      for (const text of texts) if (banned(text)) offenders.push(name + ': ' + text);
    }
    expect(offenders).toEqual([]);
  });

  it('aggregates the record, editor and compile copy modules in allCopyTexts()', () => {
    const all = allCopyTexts() as string[];
    for (const text of [...Object.values(COPY_RECORD), ...Object.values(COPY_EDITOR), ...Object.values(COPY_COMPILE)] as string[]) {
      expect(all.includes(text)).toBe(true);
    }
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

