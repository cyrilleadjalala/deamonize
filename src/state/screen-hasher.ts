import type { ScreenContent, ScreenId } from '../types.js';
import {
  normalizeScreen,
  normalizedHash as hashScreen,
  screenId,
} from '../replay/runtime/screen-hash.js';

/**
 * Thin wrapper over the shared run-time module `src/replay/runtime/screen-hash.ts`,
 * the single source of truth for normalisation and hashing.
 */
export class ScreenHasher {
  /**
   * Returns the normalized canonical string before hashing.
   */
  normalize(content: ScreenContent): string {
    return normalizeScreen(content.type, content.raw);
  }

  /**
   * Returns the full 64-char SHA-256 hex hash of the normalized content.
   */
  normalizedHash(content: ScreenContent): string {
    return hashScreen(content.type, content.raw);
  }

  /**
   * Returns the 16-char truncated ScreenId.
   */
  computeId(content: ScreenContent): ScreenId {
    return screenId(content.type, content.raw) as ScreenId;
  }
}
