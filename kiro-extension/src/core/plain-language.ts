/** Words the user should not see. Used by the test lint only, not at runtime. */
export const BANNED_TERMS: RegExp = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

/** Banned terms found in `text`. Windows and POSIX file paths and `daemonize ...` commands shown as code are exempt. */
export function bannedTermsIn(text: string): string[] {
  const stripped = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/[A-Za-z]:\\[^\s"']+/g, ' ')
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/)[^\s"']+/g, ' ');
  const found: string[] = [];
  const pattern = new RegExp(BANNED_TERMS.source, 'gi');
  for (const match of stripped.matchAll(pattern)) found.push(match[0]);
  return found;
}
