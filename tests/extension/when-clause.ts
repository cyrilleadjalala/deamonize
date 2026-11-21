/** Evaluates the small `when` clauses of the manifest: `!key`, `key`, `key == n`, `key > n`, joined by `&&`. */
export function whenHolds(when: string, keys: Record<string, boolean | number>): boolean {
  return when.split('&&').every((raw) => {
    const term = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^!\s*([\w.]+)$/.exec(term))) return !keys[m[1]!];
    if ((m = /^([\w.]+)\s*(==|>)\s*(\d+)$/.exec(term))) {
      const left = Number(keys[m[1]!] ?? 0);
      return m[2] === '==' ? left === Number(m[3]) : left > Number(m[3]);
    }
    if ((m = /^([\w.]+)$/.exec(term))) return Boolean(keys[m[1]!]);
    return false; // an expression this helper does not know: the test then fails loudly
  });
}
