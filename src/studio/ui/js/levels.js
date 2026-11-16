// @ts-check
/** The replay levels, in the order the replayer tries them, and the vocabulary shared by every view. */

/**
 * @typedef {'http' | 'accessibility' | 'vision' | 'coordinates' | 'terminal' | 'none'} Level
 */

/** @type {Record<Level, { label: string, glyph: string, description: string }>} */
export const LEVELS = {
  http: { label: 'API / HTTP', glyph: '\u25C6', description: 'Replays a recorded request directly. Fastest, no browser rendering.' },
  accessibility: { label: 'Accessibility', glyph: '\u25CF', description: 'Finds the control by its role and name, or a recorded selector.' },
  vision: { label: 'Vision', glyph: '\u25D0', description: 'Heal mode: finds the control from its picture and intent.' },
  coordinates: { label: 'Coordinates', glyph: '\u271A', description: 'Last resort: clicks the recorded position on the screen.' },
  terminal: { label: 'Terminal', glyph: '\u25AE', description: 'Types into a program and waits for text on its rendered screen.' },
  none: { label: 'No level', glyph: '\u25CB', description: 'Nothing recorded lets this step be replayed on its own.' },
};

export const WEB_LEVELS = /** @type {Level[]} */ (['http', 'accessibility', 'vision', 'coordinates']);

export const RISK = {
  read: { label: 'read', glyph: '\u25CB' },
  write: { label: 'write', glyph: '\u25D1' },
  delete: { label: 'delete', glyph: '\u25CF' },
};

/** @param {string} level */
export function levelInfo(level) {
  return LEVELS[/** @type {Level} */ (level)] ?? LEVELS.none;
}

/** @param {string} risk */
export function riskInfo(risk) {
  return RISK[/** @type {'read'} */ (risk)] ?? RISK.read;
}
