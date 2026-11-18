/**
 * Waits for `work` at most `ms` milliseconds. A rejection of `work` is passed on. When the time runs out the answer is
 * `{ timedOut: true }` and a later result of `work` is ignored (its rejection is swallowed so nothing stays unhandled).
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
