// Feature: daemonize, Property 14: strict failure never executes later steps
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  StepExecutionError,
  describeFailure,
  failureResult,
  planLocators,
  resolveStepValue,
  runStepsStrict,
  secretEnvName,
  type StepLike,
  type StepRiskLike,
} from '../../src/replay/runtime/step-plan.js';

/**
 * **Validates: Requirements 12.5, 12.6, 14.7**
 *
 * The harness plays the part of the web executor on a scripted page: it tries the planned locators in
 * order, stops at the first that works, never retries a write or delete step, and types the value
 * of the step (a secret included) so that a failure message may echo it.
 */
interface Attempt {
  step: number;
  locator: string;
}

interface Scenario {
  steps: StepLike[];
  /** Index of the step every locator of which fails, or undefined. */
  k: number | undefined;
  /** For a read step that succeeds, the index of the locator that works (the ones before it fail). */
  works: number[];
  secrets: string[];
  env: Record<string, string>;
}

const riskArb: fc.Arbitrary<StepRiskLike> = fc.constantFrom('read', 'write', 'delete');
const secretArb = fc.stringMatching(/^[0-9a-f]{12}$/).map((hex) => `sk-${hex}`);

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.array(
      fc.record({
        risk: riskArb,
        selectors: fc.integer({ min: 1, max: 4 }),
        works: fc.nat(3),
        secret: fc.boolean(),
        secretValue: secretArb,
      }),
      { minLength: 1, maxLength: 12 },
    ),
    fc.nat(11),
    fc.boolean(),
  )
  .map(([raw, kSeed, fails]) => {
    const env: Record<string, string> = {};
    const secrets: string[] = [];
    const steps: StepLike[] = raw.map((r, i) => {
      const step: StepLike = {
        actionType: 'type',
        selectors: Array.from({ length: r.selectors }, (_, j) => `#s${i}_${j}`),
        label: `step ${i}`,
        risk: r.risk,
      };
      if (r.secret) {
        step.secretRef = `S${i}`;
        env[secretEnvName(`S${i}`)] = r.secretValue + `-${i}`;
        secrets.push(r.secretValue + `-${i}`);
      } else {
        step.value = `plain${i}`;
      }
      return step;
    });
    return {
      steps,
      k: fails ? kSeed % steps.length : undefined,
      works: raw.map((r) => (r.works % r.selectors)),
      secrets,
      env,
    };
  });

describe('Property 14: strict failure stops the replay', () => {
  it('a failing step ends the replay with step_failed and no later step runs', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { steps, k, works, env, secrets } = scenario;
        const attempts: Attempt[] = [];
        const started: number[] = [];

        const outcome = await runStepsStrict(steps, async (step, index) => {
          started.push(index);
          const typed = resolveStepValue(step, {}, env);
          const candidates = planLocators(step, {});
          const descriptions = candidates.map((c) => c.description);
          const succeedsAt = index === k ? -1 : (step.risk ?? 'read') === 'read' ? works[index] : 0;
          for (let j = 0; j < candidates.length; j++) {
            attempts.push({ step: index, locator: descriptions[j] });
            if (j === succeedsAt) return;
            // A write or delete step is never attempted a second time
            if ((step.risk ?? 'read') !== 'read') break;
          }
          throw new StepExecutionError(descriptions, `no locator matched while typing "${typed}"`);
        });

        const planned = (i: number): string[] => planLocators(steps[i], {}).map((c) => c.description);
        const ran = (i: number): Attempt[] => attempts.filter((a) => a.step === i);

        if (k === undefined) {
          expect(outcome).toEqual({ ok: true });
          expect(started).toEqual(steps.map((_, i) => i));
          for (let i = 0; i < steps.length; i++) {
            const expected = (steps[i].risk ?? 'read') === 'read' ? works[i] + 1 : 1;
            // each step ran once, tried the planned locators in order and stopped at the first that worked
            expect(ran(i).map((a) => a.locator)).toEqual(planned(i).slice(0, expected));
          }
          return;
        }

        // steps 0..k-1 ran once, in order; step k ran; nothing after k started or tried a locator
        expect(started).toEqual(Array.from({ length: k + 1 }, (_, i) => i));
        expect(attempts.every((a) => a.step <= k)).toBe(true);
        for (let i = 0; i < k; i++) {
          const expected = (steps[i].risk ?? 'read') === 'read' ? works[i] + 1 : 1;
          expect(ran(i).map((a) => a.locator)).toEqual(planned(i).slice(0, expected));
        }
        // the failing step used its locators only in the planned order; no second attempt for write/delete
        const failingRisk = steps[k].risk ?? 'read';
        expect(ran(k).map((a) => a.locator)).toEqual(failingRisk === 'read' ? planned(k) : planned(k).slice(0, 1));

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.stepIndex).toBe(k);

        const result = failureResult(
          describeFailure({ stepIndex: outcome.stepIndex, step: outcome.step, tried: outcome.tried, reason: outcome.reason, secrets }),
          0,
        );
        expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed', failure: { stepIndex: k, action: 'type', risk: failingRisk } });
        expect(result.failure.tried).toEqual(planned(k));

        const serialized = JSON.stringify(result);
        for (const secret of secrets) expect(serialized).not.toContain(secret);
        for (const secret of Object.values(env)) expect(serialized).not.toContain(secret);
      }),
      { numRuns: 300 },
    );
  });
});
