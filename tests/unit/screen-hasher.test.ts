import { describe, it, expect } from 'vitest';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import type { ScreenContent } from '../../src/types.js';

const domScreen = (raw: string): ScreenContent => ({
  type: 'dom', raw, normalized: raw, capturedAt: Date.now()
});

const terminalScreen = (raw: string): ScreenContent => ({
  type: 'terminal', raw, normalized: raw, capturedAt: Date.now()
});

describe('ScreenHasher', () => {
  const hasher = new ScreenHasher();

  describe('ScreenId format', () => {
    it('computed ScreenId matches /^[0-9a-f]{16}$/', () => {
      const id = hasher.computeId(domScreen('<div class="app"><p>Hello</p></div>'));
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('terminal ScreenId also matches format', () => {
      const id = hasher.computeId(terminalScreen('$ ls -la\ntotal 8'));
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('Whitespace normalization', () => {
    it('two DOM strings identical except for whitespace between tags yield the same ScreenId', () => {
      const compact = domScreen('<div><p>Hello</p><span>World</span></div>');
      const spaced  = domScreen('<div>  <p>Hello</p>   <span>World</span>  </div>');
      expect(hasher.computeId(compact)).toBe(hasher.computeId(spaced));
    });
  });

  describe('One-character difference', () => {
    it('a DOM string with one character changed produces a different ScreenId', () => {
      const original = domScreen('<div><p>Hello</p></div>');
      const changed  = domScreen('<div><p>Hellx</p></div>');
      expect(hasher.computeId(original)).not.toBe(hasher.computeId(changed));
    });
  });

  describe('Dynamic ID stripping', () => {
    it('two DOM strings differing only in UUID id attributes produce the same ScreenId', () => {
      const withUuid1 = domScreen('<div id="a1b2c3d4-e5f6-7890-abcd-ef1234567890"><p>Content</p></div>');
      const withUuid2 = domScreen('<div id="ffffffff-0000-1111-2222-333333333333"><p>Content</p></div>');
      expect(hasher.computeId(withUuid1)).toBe(hasher.computeId(withUuid2));
    });

    it('non-UUID id attributes are NOT stripped and produce different ScreenIds for different values', () => {
      const id1 = domScreen('<div id="main"><p>Content</p></div>');
      const id2 = domScreen('<div id="sidebar"><p>Content</p></div>');
      expect(hasher.computeId(id1)).not.toBe(hasher.computeId(id2));
    });
  });

  describe('Terminal ANSI stripping', () => {
    it('two terminal buffers differing only in ANSI escape codes produce the same ScreenId', () => {
      const plain   = terminalScreen('error: file not found\ndone');
      const colored = terminalScreen('\x1b[31merror: file not found\x1b[0m\ndone');
      expect(hasher.computeId(plain)).toBe(hasher.computeId(colored));
    });

    it('terminal buffers with different text content produce different ScreenIds', () => {
      const a = terminalScreen('$ echo hello');
      const b = terminalScreen('$ echo world');
      expect(hasher.computeId(a)).not.toBe(hasher.computeId(b));
    });
  });
});
