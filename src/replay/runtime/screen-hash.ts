/**
 * Screen normalisation and hashing shared by the compiler-time ScreenHasher and
 * the generated run-time (copied verbatim into the output directory).
 * Pure and dependency-free: only node:crypto. Never import from src/ here.
 */
import { createHash } from 'node:crypto';

export type HashScreenType = 'dom' | 'terminal';

/** Optional zone restricting what is hashed. The caller extracts the fragment. */
export type HashZone = {
  selector?: string;
  rect?: { row: number; col: number; rows: number; cols: number };
};

// RFC 4122 UUID pattern (all five groups: 8-4-4-4-12 hex chars)
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// CSRF token input names
const CSRF_INPUT_NAMES = new Set(['csrf_token', '_token', 'authenticity_token']);

// ANSI escape sequences: CSI sequences like \x1b[...m and others
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// Also catch OSC, single-char ESC sequences, and similar control sequences
const ANSI_EXTENDED = /\x1b[^\x1b]|\x1b/g;
// Cursor movement sequences (CSI sequences with cursor codes A-H, f, s, u)
const CURSOR_ONLY_LINE = /^(\x1b\[[0-9;]*[ABCDEFGHSTfsu])+$/;

/** Normalise a screen of the given type to its canonical string. */
export function normalizeScreen(type: HashScreenType, raw: string): string {
  return type === 'dom' ? normalizeDom(raw) : normalizeTerminal(raw);
}

/** Full 64-char SHA-256 hex hash of the normalised screen. */
export function normalizedHash(type: HashScreenType, raw: string): string {
  return createHash('sha256').update(normalizeScreen(type, raw), 'utf8').digest('hex');
}

/** The 16-char truncated screen id. */
export function screenId(type: HashScreenType, raw: string): string {
  return normalizedHash(type, raw).slice(0, 16);
}

/**
 * Keep only the rectangle (0-based row/col, size rows x cols) of a terminal text.
 * Lines shorter than the rectangle are cropped to what exists.
 */
export function cropTerminal(text: string, rect: NonNullable<HashZone['rect']>): string {
  return text
    .split('\n')
    .slice(rect.row, rect.row + rect.rows)
    .map((line) => line.slice(rect.col, rect.col + rect.cols))
    .join('\n');
}
// ---------------------------------------------------------------------------
// DOM normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an HTML string by:
 * 1. Stripping dynamic attributes (UUID-containing id, nonce, data-reactid,
 *    CSRF token inputs).
 * 2. Sorting attributes alphabetically within each opening tag.
 * 3. Removing whitespace-only text nodes.
 */
export function normalizeDom(html: string): string {
  // Work on the raw HTML string using regex/string manipulation.
  // Step 1 & 2: Process each opening tag.
  let result = html.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^>]*)?(\/?)>/g, (
    _match,
    tagName: string,
    attrsStr: string | undefined,
    selfCloseMarker: string,
  ): string => {
    // A trailing "/" in the attribute string is a self-close marker too (the " /" this
    // function itself emits), so that normalising twice gives the same result.
    let selfClose = selfCloseMarker;
    let attributes = attrsStr ?? '';
    const trailingSlash = /\/\s*$/.exec(attributes);
    if (trailingSlash) {
      selfClose = '/';
      attributes = attributes.slice(0, trailingSlash.index);
    }
    if (!attributes) {
      return `<${tagName}${selfClose ? ' /' : ''}>`;
    }

    // Parse individual attributes from the attribute string.
    const attrs = parseAttributes(attributes);

    // Filter out dynamic attributes.
    const filtered = attrs.filter((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value ?? '';

      // Strip any id attribute whose value contains a UUID
      if (name === 'id' && UUID_PATTERN.test(value)) {
        return false;
      }
      // Strip nonce attributes
      if (name === 'nonce') {
        return false;
      }
      // Strip data-reactid attributes
      if (name === 'data-reactid') {
        return false;
      }
      // Strip CSRF token inputs: <input name="csrf_token|_token|authenticity_token">
      if (name === 'name' && CSRF_INPUT_NAMES.has(value.toLowerCase())) {
        return false;
      }

      return true;
    });

    // Sort attributes alphabetically by name.
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    // Reconstruct the attribute string.
    const attrStr = filtered
      .map((attr) => {
        if (attr.value === null) {
          return attr.name;
        }
        return `${attr.name}=${attr.quote}${attr.value}${attr.quote}`;
      })
      .join(' ');

    const prefix = attrStr ? ` ${attrStr}` : '';
    return `<${tagName}${prefix}${selfClose ? ' /' : ''}>`;
  });

  // Step 3: Remove whitespace-only text nodes.
  // A text node is any sequence of characters between tags that is purely whitespace.
  result = result.replace(/>(\s+)</g, '><');

  return result;
}

interface ParsedAttr {
  name: string;
  value: string | null;
  quote: string;
}

/**
 * Parse an attribute string into individual name/value pairs.
 * Handles quoted values (single and double), unquoted values, and
 * boolean (value-less) attributes.
 */
function parseAttributes(attrsStr: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  // Regex to match: name="value", name='value', name=value, or name (boolean)
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrsStr)) !== null) {
    const name = match[1];
    if (match[2] !== undefined) {
      attrs.push({ name, value: match[2], quote: '"' });
    } else if (match[3] !== undefined) {
      attrs.push({ name, value: match[3], quote: "'" });
    } else if (match[4] !== undefined) {
      attrs.push({ name, value: match[4], quote: '"' });
    } else {
      attrs.push({ name, value: null, quote: '' });
    }
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// Terminal normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a terminal buffer string by:
 * 1. Stripping ANSI escape codes.
 * 2. Trimming trailing whitespace from each line.
 * 3. Removing cursor-position-only lines.
 */
export function normalizeTerminal(text: string): string {
  const lines = text.split('\n');

  const normalized = lines
    .map((line) => {
      // Check if the raw line is cursor-position-only BEFORE stripping ANSI
      if (CURSOR_ONLY_LINE.test(line.trim()) && line.trim().length > 0) {
        return null; // mark for removal
      }

      // Strip ANSI escape codes
      let stripped = line.replace(ANSI_ESCAPE, '').replace(ANSI_EXTENDED, '');

      // Trim trailing whitespace
      stripped = stripped.trimEnd();

      return stripped;
    })
    .filter((line): line is string => line !== null);

  return normalized.join('\n');
}

