// @ts-check
/**
 * One announcement per state change. The last state of each channel is remembered; a poll that returns the same state
 * says nothing. `say` is a seam for tests, the default writes to the polite live region.
 */
import { announce } from './components.js';

/** @type {Map<string, string>} */
const last = new Map();

/**
 * @param {string} channel e.g. "recording" or "compile"
 * @param {string} state the state key, e.g. "saving" or "running:installing"
 * @param {string} text the sentence to announce when the state changed
 * @param {(text: string) => void} [say]
 * @returns {boolean} true when something was announced
 */
export function announceOnChange(channel, state, text, say = announce) {
  if (last.get(channel) === state) return false;
  last.set(channel, state);
  say(text);
  return true;
}

/** Forget the remembered state of a channel (or of all), for a new screen or a test. @param {string} [channel] */
export function resetAnnouncer(channel) {
  if (channel === undefined) last.clear();
  else last.delete(channel);
}
