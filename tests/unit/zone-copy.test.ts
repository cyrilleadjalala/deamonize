import { describe, it, expect } from 'vitest';
import { ZONE_COPY } from '../../src/recorder/zone-copy.js';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

// Same regex as tests/unit/studio-ui-copy.test.ts
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

describe('ZONE_COPY', () => {
  for (const [name, text] of Object.entries(ZONE_COPY)) {
    it(`${name} has no banned word and is part of the page script without backtick or dollar-brace`, () => {
      expect(BANNED.test(text)).toBe(false);
      expect(text).not.toMatch(/`|\$\{/);
      expect(CAPTURE_SCRIPT.includes(text)).toBe(true);
    });
  }
});
