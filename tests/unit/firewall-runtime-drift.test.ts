import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SENSITIVE_KEY } from '../../src/replay/runtime/audit-log.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const patternOf = (source: string): string => {
  const match = /const SENSITIVE_KEY(?:\s*:\s*RegExp)?\s*=\s*(\/.+\/[a-z]*);/.exec(source);
  if (match === null) throw new Error('SENSITIVE_KEY not found');
  return match[1];
};

describe('runtime copy of SENSITIVE_KEY', () => {
  it('has the same source as the one in playground.ts', () => {
    const studio = patternOf(read('../../src/studio/playground.ts'));
    expect(String(SENSITIVE_KEY)).toBe(studio);
    expect(patternOf(read('../../src/replay/runtime/audit-log.ts').replace('export const', 'const'))).toBe(studio);
  });
});
