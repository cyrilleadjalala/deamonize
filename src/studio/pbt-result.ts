/**
 * The result of the generated property-based suite, as the Studio stores and shows it. Pure: turns the JSON of
 * `vitest run --reporter=json` into a small summary, and checks a stored summary before it is trusted.
 */

export interface PbtCounterexample {
  property: string;
  counterexample?: string;
}

export interface PbtToolResult {
  tool: string;
  passing: number;
  failing: number;
  skipped: number;
  counterexamples: PbtCounterexample[];
  /** Why a file could not run at all (an import error, for example). */
  error?: string;
}

export interface PbtRunResult {
  ranAt: string;
  durationMs: number;
  /** passed: every property passed; failed: a property failed; error: the suite did not run (timeout, no vitest). */
  status: 'passed' | 'failed' | 'error';
  totals: { passing: number; failing: number; skipped: number };
  tools: PbtToolResult[];
  error?: string;
}

const MAX_TEXT = 500;
const MAX_TOOLS = 500;
const MAX_COUNTEREXAMPLES = 20;

export function clipText(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function toolOfFile(path: string): string | undefined {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  return /^(.+)\.property\.test\.ts$/.exec(name)?.[1];
}

/** `Property "name" failed after N runs ... Counterexample: <json>` as written by the generated property runner. */
function counterexampleOf(message: string, title: string): PbtCounterexample {
  const found = /Property "([^"]*)" failed[\s\S]*?Counterexample: ([^\r\n]*)/.exec(message);
  return found === null
    ? { property: clipText(title, 200) }
    : { property: clipText(found[1], 200), counterexample: clipText(found[2]) };
}

function totalsOf(tools: PbtToolResult[]): PbtRunResult['totals'] {
  return {
    passing: tools.reduce((n, t) => n + t.passing, 0),
    failing: tools.reduce((n, t) => n + t.failing, 0),
    skipped: tools.reduce((n, t) => n + t.skipped, 0),
  };
}

/** Summary of the JSON report of vitest (`testResults[].assertionResults[]`). */
export function summarizeVitestJson(report: unknown, ranAt: string, durationMs: number): PbtRunResult {
  const files = Array.isArray(asObject(report)?.testResults) ? (asObject(report)?.testResults as unknown[]) : [];
  const byTool = new Map<string, PbtToolResult>();
  for (const raw of files) {
    const file = asObject(raw);
    const tool = typeof file?.name === 'string' ? toolOfFile(file.name) : undefined;
    if (file === undefined || tool === undefined) continue;
    const entry = byTool.get(tool) ?? { tool, passing: 0, failing: 0, skipped: 0, counterexamples: [] };
    byTool.set(tool, entry);
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const item of assertions) {
      const a = asObject(item);
      if (a === undefined) continue;
      if (a.status === 'passed') entry.passing += 1;
      else if (a.status === 'failed') {
        entry.failing += 1;
        const messages = Array.isArray(a.failureMessages) ? a.failureMessages.filter((m): m is string => typeof m === 'string') : [];
        if (entry.counterexamples.length < MAX_COUNTEREXAMPLES) {
          entry.counterexamples.push(counterexampleOf(messages.join('\n'), String(a.fullName ?? a.title ?? 'property')));
        }
      } else entry.skipped += 1;
    }
    if (assertions.length === 0 && file.status === 'failed') {
      entry.failing += 1;
      entry.error = clipText(typeof file.message === 'string' && file.message !== '' ? file.message : 'the test file could not run');
    }
  }
  const tools = [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool));
  const totals = totalsOf(tools);
  return { ranAt, durationMs, status: totals.failing > 0 ? 'failed' : 'passed', totals, tools };
}

/** A result for a run that produced no report. */
export function errorResult(message: string, ranAt: string, durationMs: number): PbtRunResult {
  return { ranAt, durationMs, status: 'error', totals: { passing: 0, failing: 0, skipped: 0 }, tools: [], error: clipText(message) };
}

/** A stored result, checked and bounded; undefined when the file is not a result. */
export function normalizePbtResult(raw: unknown): PbtRunResult | undefined {
  const r = asObject(raw);
  if (r === undefined || !Array.isArray(r.tools)) return undefined;
  const status = r.status === 'passed' || r.status === 'failed' || r.status === 'error' ? r.status : undefined;
  if (status === undefined) return undefined;
  const tools: PbtToolResult[] = [];
  for (const item of r.tools.slice(0, MAX_TOOLS)) {
    const t = asObject(item);
    if (t === undefined || typeof t.tool !== 'string') continue;
    const examples = Array.isArray(t.counterexamples) ? t.counterexamples : [];
    tools.push({
      tool: clipText(t.tool, 100),
      passing: asCount(t.passing),
      failing: asCount(t.failing),
      skipped: asCount(t.skipped),
      counterexamples: examples.slice(0, MAX_COUNTEREXAMPLES).flatMap((e) => {
        const c = asObject(e);
        return c === undefined || typeof c.property !== 'string'
          ? []
          : [{ property: clipText(c.property, 200), ...(typeof c.counterexample === 'string' ? { counterexample: clipText(c.counterexample) } : {}) }];
      }),
      ...(typeof t.error === 'string' ? { error: clipText(t.error) } : {}),
    });
  }
  return {
    ranAt: typeof r.ranAt === 'string' ? clipText(r.ranAt, 40) : '',
    durationMs: asCount(r.durationMs),
    status,
    totals: totalsOf(tools),
    tools,
    ...(typeof r.error === 'string' ? { error: clipText(r.error) } : {}),
  };
}
