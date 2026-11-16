import fc from 'fast-check';

/*
 * Test support copied verbatim next to every generated property-based test
 * suite, so it must stay self-contained: it imports nothing but fast-check.
 */

export interface PropertyReport {
  name: string;
  passed: boolean;
  runs: number;
  shrinks: number;
  counterexample?: string;   // the shrunk failing input, as JSON
}

const reports: PropertyReport[] = [];

/**
 * Run a property and record its outcome. Throws when it fails, with the shrunk
 * counterexample in the message, so the surrounding test fails too.
 */
export function checkProperty(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  property: fc.IRawProperty<any, false>,
  numRuns = 100,
): PropertyReport {
  const details = fc.check(property, { numRuns });

  const report: PropertyReport = {
    name,
    passed: !details.failed,
    runs: details.numRuns,
    shrinks: details.numShrinks,
  };
  if (details.failed) {
    report.counterexample = JSON.stringify(details.counterexample?.[0]);
  }
  reports.push(report);

  if (details.failed) {
    throw new Error(
      `Property "${name}" failed after ${details.numRuns} runs (shrunk ${details.numShrinks} times). ` +
        `Counterexample: ${report.counterexample}`
    );
  }
  return report;
}

/** The outcomes recorded so far. */
export function getReports(): PropertyReport[] {
  return [...reports];
}

/** Print how many properties passed and failed, with the shrunk counterexamples. */
export function printReport(title: string): void {
  const failing = reports.filter((report) => !report.passed);
  const passing = reports.length - failing.length;

  console.log(`[${title}] ${passing} passing propert${passing === 1 ? 'y' : 'ies'}, ${failing.length} failing`);
  for (const report of failing) {
    console.log(`  - ${report.name}: shrunk counterexample ${report.counterexample}`);
  }
}
