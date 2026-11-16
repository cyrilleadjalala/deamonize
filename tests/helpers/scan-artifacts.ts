import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface ArtifactMatch {
  /** Path of the file, relative to the scanned directory. */
  file: string;
  /** The value that was found (tests only: never print it from product code). */
  value: string;
  /** Which form of the value matched. */
  form: 'raw' | 'base64' | 'base64url' | 'url-encoded' | 'json-escaped' | 'hex';
}

export interface ScanOptions {
  /** Directory names that are not scanned (default: node_modules, .git). */
  skipDirs?: string[];
}

/** The forms a value can take once it was serialized, encoded or escaped. */
export function encodedForms(value: string): Array<{ form: ArtifactMatch['form']; text: string }> {
  const bytes = Buffer.from(value, 'utf8');
  const forms: Array<{ form: ArtifactMatch['form']; text: string }> = [
    { form: 'raw', text: value },
    { form: 'json-escaped', text: JSON.stringify(value).slice(1, -1) },
    { form: 'url-encoded', text: encodeURIComponent(value) },
    { form: 'url-encoded', text: encodeURIComponent(value).replace(/%20/g, '+') },
    { form: 'hex', text: bytes.toString('hex') },
  ];
  // Base64 of the value inside a longer base64 stream depends on its offset modulo 3: keep the stable middle of each alignment
  const lead = [0, 2, 3];
  for (let shift = 0; shift < 3; shift++) {
    const full = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64').replace(/=+$/, '');
    const stable = shift === 0 ? full : full.slice(lead[shift]);
    const text = (shift + bytes.length) % 3 === 0 ? stable : stable.slice(0, Math.max(0, stable.length - 1));
    if (text.length >= 6) {
      forms.push({ form: 'base64', text });
      forms.push({ form: 'base64url', text: text.replace(/\+/g, '-').replace(/\//g, '_') });
    }
  }
  return forms.filter((f, i) => f.text !== '' && forms.findIndex((g) => g.form === f.form && g.text === f.text) === i);
}

async function* walk(dir: string, skip: Set<string>): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) yield* walk(path, skip);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

/**
 * Search every file under `dir` (recursively, binary files too) for each value, in its raw form and in its
 * base64, base64url, hex, URL-encoded and JSON-escaped forms. Returns one match per file, value and form.
 * Empty values are ignored (they would match everything).
 */
export async function scanForValues(dir: string, values: readonly string[], options: ScanOptions = {}): Promise<ArtifactMatch[]> {
  const skip = new Set(options.skipDirs ?? ['node_modules', '.git']);
  const wanted = values.filter((v) => v !== '').map((value) => ({ value, forms: encodedForms(value) }));
  const matches: ArtifactMatch[] = [];
  for await (const path of walk(dir, skip)) {
    const content = (await readFile(path)).toString('latin1');
    const utf8 = Buffer.from(content, 'latin1').toString('utf8');
    for (const { value, forms } of wanted) {
      for (const { form, text } of forms) {
        const needle = Buffer.from(text, 'utf8').toString('latin1');
        if (content.includes(needle) || utf8.includes(text)) {
          matches.push({ file: relative(dir, path), value, form });
        }
      }
    }
  }
  return matches;
}
