/**
 * LabelExtractor: derives human-readable `description` text for each inferred field
 * from the screen snapshot.
 *
 * Requirements: 4.5
 */

import type { ScreenContent } from '../types.js';

/**
 * Escape special regex metacharacters in a string so it can be used literally in a RegExp.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class LabelExtractor {
  /**
   * Extract field descriptions from a screen snapshot.
   *
   * Returns a map of fieldName → description string.
   * Returns an empty map if no labels can be found.
   */
  extractLabels(screen: ScreenContent, fieldNames: string[]): Map<string, string> {
    const result = new Map<string, string>();

    if (screen.type === 'dom') {
      for (const name of fieldNames) {
        result.set(name, this._extractDomLabel(screen.raw, name));
      }
    } else {
      // terminal
      const lines = screen.raw.split('\n');
      for (const name of fieldNames) {
        result.set(name, this._extractTerminalLabel(lines, name));
      }
    }

    return result;
  }

  // ── DOM strategy ─────────────────────────────────────────────────────────

  private _extractDomLabel(raw: string, name: string): string {
    const escaped = escapeRegex(name);

    // 1. <label for="fieldName">text</label>
    const labelForRegex = new RegExp(
      `<label[^>]*\\bfor=["']${escaped}["'][^>]*>([^<]+)<\\/label>`,
      'i'
    );
    const labelForMatch = labelForRegex.exec(raw);
    if (labelForMatch) {
      return this._stripTags(labelForMatch[1]).trim();
    }

    // 2. <input name="fieldName" placeholder="...">  — also handles reversed attribute order
    const placeholderRegex = new RegExp(
      `<input[^>]*\\bname=["']${escaped}["'][^>]*\\bplaceholder=["']([^"']+)["']`,
      'i'
    );
    const placeholderMatch = placeholderRegex.exec(raw);
    if (placeholderMatch) {
      return placeholderMatch[1].trim();
    }

    // Also try the placeholder-first / name-last order
    const placeholderRegex2 = new RegExp(
      `<input[^>]*\\bplaceholder=["']([^"']+)["'][^>]*\\bname=["']${escaped}["']`,
      'i'
    );
    const placeholderMatch2 = placeholderRegex2.exec(raw);
    if (placeholderMatch2) {
      return placeholderMatch2[1].trim();
    }

    // 3. <input id="fieldName"> preceded by a <label> — find the label that appears just before
    //    the input tag with this id.
    const inputIdRegex = new RegExp(
      `(<label[^>]*>([^<]*)<\\/label>)\\s*(?:<[^>]+>\\s*)*<input[^>]*\\bid=["']${escaped}["']`,
      'is'
    );
    const inputIdMatch = inputIdRegex.exec(raw);
    if (inputIdMatch) {
      return this._stripTags(inputIdMatch[2]).trim();
    }

    // 4. Fallback: return the field name itself
    return name;
  }

  /**
   * Strip HTML tags from a string to get plain text.
   */
  private _stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
  }

  // ── Terminal strategy ─────────────────────────────────────────────────────

  private _extractTerminalLabel(lines: string[], name: string): string {
    const lower = name.toLowerCase();

    for (const line of lines) {
      if (line.toLowerCase().includes(lower)) {
        return line.trim();
      }
    }

    // No matching line — return the field name as fallback
    return name;
  }
}
