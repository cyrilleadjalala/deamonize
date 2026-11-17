// Feature: kiro-global-connect-vault-bridge, Property 21: Plain-language copy
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
// @ts-expect-error no type declarations for the browser modules
import { COPY, TECHNICAL_TEXTS, allCopyTexts } from '../../src/studio/ui/js/copy.js';

const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;
/** File names such as settings/mcp.json are shown in code.path elements and are exempt. */
const withoutPaths = (text: string): string => text.replace(/[\w.-]+(?:\/[\w.<>-]+)+|[\w-]+\.json\b/g, '');

const CONNECT_KEYS = [
  'connectTitle', 'connectLead', 'folderLabel', 'folderHelp', 'connectButton', 'dialogTitle', 'dialogLead', 'outcomeCreate', 'outcomeMerge',
  'outcomeReplace', 'replaceNotice', 'confirm', 'installing', 'connectedTitle', 'connectedLead', 'placeholdersLead', 'noPlaceholders', 'powerInstead',
  'powerLead', 'powerSteps1', 'powerSteps2', 'powerSteps3', 'notBuilt', 'previewFailed', 'installFailed', 'scopeLegend', 'scopeGlobal', 'scopeProject',
  'scopeGlobalSentence', 'autoAddLabel', 'autoAddHelp', 'autoAddNotSaved', 'backupYes', 'backupNone', 'connectedReload', 'missingLead', 'missingLink',
  'removeButton', 'removeLead', 'removeConfirmLead', 'removeConfirm', 'removing', 'removedTitle', 'removedLead', 'removeFailed', 'removeNothing',
];

describe('Property 21: Plain-language copy', () => {
  it('has no banned whole word in any text of the connect copy table', () => {
    const table = CONNECT_KEYS.map((key) => [key, (COPY as Record<string, unknown>)[key]] as const);
    for (const [key, value] of table) expect(typeof value, key).toBe('string');
    fc.assert(
      fc.property(fc.constantFrom(...table), ([key, value]) => {
        expect(BANNED.test(withoutPaths(value as string)), `${key}: ${value}`).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('has no banned whole word anywhere in copy.js, outside the technical option', () => {
    const texts = (allCopyTexts() as string[]).filter((t) => !TECHNICAL_TEXTS.has(t));
    fc.assert(
      fc.property(fc.constantFrom(...texts), (text) => !BANNED.test(withoutPaths(text))),
      { numRuns: 200 }
    );
  });
});
