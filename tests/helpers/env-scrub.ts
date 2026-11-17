// Names of the ambient variables that must never leak into a test run.
const SCRUBBED_PREFIXES = ['DAEMONIZE_SECRET_', 'DAEMONIZE_MODEL_'];
const SCRUBBED_NAMES = ['DAEMONIZE_DATA_DIR', 'DAEMONIZE_APP_KEY'];

/** True when `name` is one of the variables a test run must not inherit. */
export function isScrubbedName(name: string): boolean {
  return SCRUBBED_NAMES.includes(name) || SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Pure: returns a copy of `env` without the scrubbed variables. The input is not modified. */
export function scrubEnv<T extends Record<string, string | undefined>>(env: T): Partial<T> {
  const copy: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (!isScrubbedName(name)) copy[name] = value;
  return copy as Partial<T>;
}

/** True when `env` holds none of the scrubbed variables. */
export function isScrubbed(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).every((name) => !isScrubbedName(name));
}
