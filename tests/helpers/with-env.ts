/**
 * Runs `body` with `vars` set in process.env (undefined deletes the variable), then restores each
 * variable to its previous value, or to absence, even when `body` throws or rejects.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) previous.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);
  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
