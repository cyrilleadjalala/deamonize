// Feature: result-zone-selector-robustness, Properties 1, 2 and 20 (candidate list shape, ranking order, typed values never appear)
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { zoneCandidateSelectors, limitCandidates, zoneFingerprint, CANDIDATE_LIMIT, SELECTOR_LENGTH_LIMIT } from '../../src/recorder/zone-candidates';
import { isPositionalSelector } from '../../src/recorder/minimal-selector';
import { buildSelectors } from '../../src/recorder/selector-builder';
import { elementInfo, zoneFacts, zoneKind } from '../helpers/zone-arbitraries';

const runs = { numRuns: 150 };

describe('zone candidates', () => {
  // Feature: result-zone-selector-robustness, Property 1: Candidate list shape
  it('Property 1: Candidate list shape', () => {
    // Validates: Requirements 1.3, 1.4, 1.5, 1.6
    fc.assert(
      fc.property(elementInfo, zoneFacts, (info, facts) => {
        const list = limitCandidates(zoneCandidateSelectors(info, facts), []);
        expect(new Set(list).size).toBe(list.length);
        expect(list.length).toBeLessThanOrEqual(CANDIDATE_LIMIT);
        expect(list.filter((s) => !isPositionalSelector(s)).length).toBeLessThanOrEqual(4);
        expect(list.filter((s) => isPositionalSelector(s)).length).toBeLessThanOrEqual(1);
        for (const s of list) expect(s.length).toBeLessThanOrEqual(SELECTOR_LENGTH_LIMIT);
        const at = list.findIndex((s) => isPositionalSelector(s));
        if (at >= 0) expect(at).toBe(list.length - 1);
      }),
      runs
    );
  });

  // Feature: result-zone-selector-robustness, Property 2: Ranking order
  it('Property 2: Ranking order', () => {
    // Validates: Requirements 1.2, 5.1, 5.4
    fc.assert(
      fc.property(elementInfo, zoneFacts, (info, facts) => {
        const expected = [
          ...buildSelectors({ role: info.role, name: info.name, id: info.id, testId: info.testId, nameAttr: info.nameAttr }),
          ...(info.role ? [`role=${info.role}`] : []),
          ...(facts.minimal ? [facts.minimal] : []),
          ...(facts.positional ? [facts.positional] : []),
        ];
        const list = zoneCandidateSelectors(info, facts);
        expect(list).toEqual([...new Set(expected)]);
        // info.css is never used
        if (info.css && !expected.includes(info.css)) expect(list).not.toContain(info.css);
        // stable entries keep the ranking order after limiting
        const limited = limitCandidates(list, []);
        const stableInOrder = limited.filter((s) => !isPositionalSelector(s));
        const raw = list.filter((s) => stableInOrder.includes(s));
        expect(stableInOrder).toEqual(raw.slice(0, stableInOrder.length));
      }),
      runs
    );
  });

  // Feature: result-zone-selector-robustness, Property 20: Typed values never appear
  it('Property 20: Typed values never appear', () => {
    // Validates: Requirements 10.1, 10.2, 10.3
    fc.assert(
      fc.property(
        elementInfo,
        zoneFacts,
        zoneKind,
        fc.stringMatching(/^[a-z0-9]{3,8}$/),
        (info, facts, kind, value) => {
          const list = limitCandidates(zoneCandidateSelectors(info, facts), [value]);
          for (const s of list) expect(s.includes(value)).toBe(false);
          const fp = zoneFingerprint(facts, kind);
          if (fp) {
            expect(fp.tag).toBe(fp.tag.toLowerCase());
            expect(fp.kind).toBe(kind);
            if (fp.count !== undefined) {
              expect(Number.isInteger(fp.count)).toBe(true);
              expect(fp.count).toBeGreaterThanOrEqual(1);
              expect(kind === 'table' || kind === 'list').toBe(true);
            }
          }
        }
      ),
      runs
    );
  });
});
