import type { Redactor } from './ports';

export type { Redactor };

export interface RedactorSources {
  sensitiveValues(): string[];
  env(): Record<string, string | undefined>;
}

const MASK = '***';
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** Strips ANSI sequences, then masks sensitive literals, DAEMONIZE_SECRET_* values, `token=` values and Bearer values. */
export function createRedactor(sources: RedactorSources): Redactor {
  return (text: string): string => {
    let out = String(text).replace(ANSI, '');
    const literals = new Set<string>();
    for (const v of sources.sensitiveValues()) if (typeof v === 'string' && v.length >= 3) literals.add(v);
    const env = sources.env();
    for (const [key, value] of Object.entries(env)) {
      if (/^DAEMONIZE_SECRET_/i.test(key) && typeof value === 'string' && value.length >= 3) literals.add(value);
    }
    for (const literal of [...literals].sort((a, b) => b.length - a.length)) out = out.split(literal).join(MASK);
    out = out.replace(/(token=)[^&\s"']+/gi, `$1${MASK}`);
    out = out.replace(/(Bearer\s+)\S+/gi, `$1${MASK}`);
    return out;
  };
}
