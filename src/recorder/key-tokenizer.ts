import { sequenceToKey } from '../sandbox/keys.js';

/** What the user did, as read from the raw bytes of their terminal. */
export type InputToken =
  | { kind: 'text'; text: string }
  | { kind: 'key'; name: string }
  | { kind: 'menu' };

/** Ctrl+] opens the recording menu; it is never sent to the program. */
export const MENU_KEY = '\x1d';

// Application-mode arrows and Home/End: ESC O <letter>
const SS3_KEYS: Record<string, string> = {
  A: 'ArrowUp',
  B: 'ArrowDown',
  C: 'ArrowRight',
  D: 'ArrowLeft',
  H: 'Home',
  F: 'End',
};

/**
 * Split the bytes read from a terminal in raw mode into typed text and named
 * keys. Consecutive printable characters make one text token. Escape sequences
 * that are not a known key are dropped.
 */
export function tokenizeInput(input: string): InputToken[] {
  const tokens: InputToken[] = [];
  let text = '';

  const flushText = (): void => {
    if (text !== '') {
      tokens.push({ kind: 'text', text });
      text = '';
    }
  };
  const pushKey = (name: string): void => {
    flushText();
    tokens.push({ kind: 'key', name });
  };

  let i = 0;
  while (i < input.length) {
    const char = input[i];

    if (char === '\x1b') {
      const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(input.slice(i));
      const ss3 = /^\x1bO[A-Za-z]/.exec(input.slice(i));
      if (csi) {
        const name = sequenceToKey(csi[0]);
        if (name) pushKey(name);
        i += csi[0].length;
      } else if (ss3) {
        const name = SS3_KEYS[ss3[0][2]];
        if (name) pushKey(name);
        i += ss3[0].length;
      } else {
        pushKey('Escape');
        i += 1;
      }
    } else if (char === '\r' || char === '\n') {
      pushKey('Enter');
      // A \r\n pair is one press of Enter
      i += char === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else if (char === MENU_KEY) {
      flushText();
      tokens.push({ kind: 'menu' });
      i += 1;
    } else if (char === '\b') {
      pushKey('Backspace');
      i += 1;
    } else if (char.charCodeAt(0) < 0x20 || char === '\x7f') {
      const name = sequenceToKey(char);
      if (name) pushKey(name);
      i += 1;
    } else {
      text += char;
      i += 1;
    }
  }

  flushText();
  return tokens;
}
