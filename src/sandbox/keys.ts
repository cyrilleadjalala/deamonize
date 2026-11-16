/**
 * Terminal byte sequences of the named keys. Single source of truth for the
 * recorder (sequence → name), the replayer (name → sequence) and the generated
 * server, which embeds this table.
 */
export const KEY_SEQUENCES: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

// Ctrl+A to Ctrl+Z, except the ones that are the same byte as a named key
// (Ctrl+I is Tab, Ctrl+J and Ctrl+M are Enter)
for (let code = 1; code <= 26; code++) {
  if (code === 9 || code === 10 || code === 13) continue;
  KEY_SEQUENCES[`Ctrl+${String.fromCharCode(64 + code)}`] = String.fromCharCode(code);
}

/** The bytes to send for a key name; anything that is not a known name is sent as typed. */
export function keyToSequence(key: string): string {
  return KEY_SEQUENCES[key] ?? key;
}

const SEQUENCE_KEYS = new Map(Object.entries(KEY_SEQUENCES).map(([name, sequence]) => [sequence, name]));

/** The name of the key a byte sequence stands for, if it is a known key. */
export function sequenceToKey(sequence: string): string | undefined {
  return SEQUENCE_KEYS.get(sequence);
}
