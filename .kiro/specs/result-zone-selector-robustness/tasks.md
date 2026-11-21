# Implementation Plan: result-zone-selector-robustness

## Overview

The implementation language is TypeScript for `src/` and `tests/`, as the design states. The one exception is `MINIMAL_SELECTOR_SOURCE`, which is plain JavaScript source text inside `src/recorder/minimal-selector.ts` (design decision 5). Work follows the design's "Implementation groups" and its waves.

- **Group G0** (the seam) runs first and serial: types, schema, stubs with the final signatures, the real `ZONE_COPY` text and the shared test arbitraries. Commit **CG-0**. Every other group starts from that state.
- **Wave 1 groups** run in parallel after G0: G-A (algorithm, CG-1), G-C (replay, CG-2), G-D (generator, CG-3). **Wave 2** is G-B (recorder and panel, CG-4) and G-E (suggester, CG-5); both need G-A finished in the working tree. **Wave 3** is G-F (end-to-end tests, CG-6), after G-B, G-C and G-D.
- Each group edits only the files listed after "Owns:". The lists are disjoint, and each file has one owner. `capture-script.ts` is owned by G-B alone. `extract.ts` is owned by G0 (types and stubs) and then by G-C, never at the same time. A group that needs a change in a file it does not own stops and asks the conductor. Groups do not commit, push or change the root `package.json`.
- A group's own tests pass without another group's real code (use the G0 stubs). A test that needs another group's real code begins with `// checkpoint-only: needs G-x` and runs at the final checkpoint.
- The **final checkpoint** (task 11) runs the full verification, checks that the regression snapshots of old workflows are byte-identical, then creates one commit per group, CG-0 to CG-6, in that order, with `git add` of the paths of that group only. Nothing is pushed.
- Conflicts are resolved as the design says. **RC-1**: a role alone is emitted for every role and kept only when it resolves to exactly one element (2.1 wins over 5.1). **RC-2**: a role alone ranks after the `name` attribute and before the Minimal_Selector (1.2 means role and name). **RC-3**: 7.6 cannot be met literally; the tests only check that `selector` stays valid alone. **RC-4**: 3.7 is measured in levels (compound selectors), not characters. **RC-7**: three existing assertions change and are listed in the commit messages: `tests/integration/result-zone-interactive.test.ts:127` (task 10.1), and `tests/unit/suggest.test.ts:123` and `:130` (task 8.2).
- Property tests use `fast-check` with at least 100 runs and a tag comment `// Feature: result-zone-selector-robustness, Property N: <title>`. Each property is one separate test. Page generators come from `tests/helpers/zone-arbitraries.ts` (G0). Tests use no network and no real secret.
- Test sub-tasks marked `*` are optional. **Not optional:**
  - the old-file compatibility checks: tasks 1.5, 4.6 and 5.3;
  - the plain-language check of the warning text (`zone-copy.test.ts`, task 7.4);
  - the update of the three existing assertions: tasks 8.2 and 10.1.
- `tests/unit/regression-fixture.test.ts` gets no new `ALLOWED_DIFFERENCES` entry. No group edits it.

## Tasks

- [x] 1. G0 seam (serial, first, commit CG-0)
  - Owns: `src/types.ts`, `src/workflow/workflow-set.ts` (schema only), `src/recorder/minimal-selector.ts` (signatures and stub), `src/recorder/zone-candidates.ts` (signatures and stubs), `src/recorder/zone-copy.ts` (new, real text), `src/replay/runtime/extract.ts` (types and stubs only), `tests/helpers/zone-arbitraries.ts` (new), `tests/property/zone-schema.property.test.ts` (new).
  - Functions that belong to another group throw `Error('not implemented: <group>')`, except `MINIMAL_SELECTOR_SOURCE`, which declares `daemonizeMinimalSelector` returning `{ positional: '', levels: { minimal: 0, positional: 0 } }`. Final signatures are those of the design's "Components and Interfaces". Later groups may add exports and may not change one.

  - [x] 1.1 Add the zone types and the schema fields
    - `src/types.ts`: add `ZoneFingerprint { tag; kind; count? }` and the optional `selectors` and `fingerprint` on `ResultZone`.
    - `src/workflow/workflow-set.ts`: add `selectors` (array, 1 to 5 items, strings of 1 to 300 characters) and `fingerprint` (required `tag` pattern `^[a-z][a-z0-9-]{0,30}$` and `kind` enum, optional integer `count` of at least 1, `additionalProperties: false`) to `$defs.ResultZone.properties`. Keep `additionalProperties: false` on `ResultZone`. A zone with neither field validates and serializes as before.
    - _Requirements: 1.7, 7.1, 7.2, 7.6, 10.6_

  - [x] 1.2 Add the recorder stubs and the warning text
    - `minimal-selector.ts`: `NodeAdapter`, `MinimalSelectorOptions`, `MinimalSelectorResult`, `MINIMAL_SELECTOR_SOURCE` (stub as above), `createMinimalSelector`, `isUnstableClass`, `isGeneratedId` (stubs), and the real `isPositionalSelector`.
    - `zone-candidates.ts`: `ZoneFacts`, `CANDIDATE_LIMIT = 5`, `STABLE_SLOTS = 4`, `SELECTOR_LENGTH_LIMIT = 300`, and stubs of `zoneCandidateSelectors`, `limitCandidates`, `isFragile`, `zoneFingerprint`.
    - `zone-copy.ts`: `ZONE_COPY.fragile` with the exact text of the design (no apostrophe, backtick or `${`, no banned word).
    - _Requirements: 3.7, 3.11, 8.2, 8.6, 9.6_

  - [x] 1.3 Add the replay runtime types and stubs
    - `extract.ts`: `FingerprintLike`, the optional `selectors` and `fingerprint` on `ZoneLike`, the `Verdict` type, the optional `fallback` and `tried` on `ZoneOutcome`, and stubs of `zoneCandidatesOf`, `candidateBudgets`, `zoneCount`, `judgeCandidate`. `zoneCandidatesOf` returns `undefined` in the stub so the old path stays active. The file imports nothing from `src/`.
    - _Requirements: 6.1, 6.8, 6.10_

  - [x] 1.4 Add the shared page generators
    - `tests/helpers/zone-arbitraries.ts`: an arbitrary of HTML documents (nested elements, repeated siblings, ids and classes of every family of the design's unstable table, `data-testid`, `role`, text, hostile attribute values with quotes, brackets, `>`, spaces and backslashes), a chooser of the marked element, and arbitraries of element info, `ZoneFacts` and zones. Other groups import it and do not edit it. No value is a real secret.
    - _Requirements: 11.9_

  - [x] 1.5 Write the property tests for the schema (required)
    - File: `tests/property/zone-schema.property.test.ts`.
    - **Property 18: Serialization round trip.** A set with neither field serializes to the text produced before the change.
    - **Property 19: Bounds are enforced.** The message holds the path of the field.
    - _Requirements: 1.7, 7.1, 7.2, 10.6, 11.5_

- [x] 2. Checkpoint - G0 seam done
  - Require `npx tsc --noEmit`, the existing suite and `tests/unit/regression-fixture.test.ts` to pass with the stubs in place.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. G-A minimal selector algorithm (CG-1)
  - Owns: `src/recorder/minimal-selector.ts`, `tests/unit/minimal-selector.test.ts`, `tests/property/minimal-selector.property.test.ts`, `tests/property/minimal-selector-safety.property.test.ts`, `tests/property/minimal-selector-parity.property.test.ts`.

  - [x] 3.1 Implement the source text and the class rules
    - Write `MINIMAL_SELECTOR_SOURCE` as plain JavaScript with no backtick and no `${`: the levels 1 to 6, the Anchor rule, the climbing procedure with `A T` then `A > T`, the positional extension, the shortest unique suffix fallback, and the 300 character limit. Use only identifiers matching `^-?[A-Za-z_][A-Za-z0-9_-]*$` and attribute values of the set `[A-Za-z0-9 _.:/@-]` up to 60 characters. Define `isUnstableClass` and `isGeneratedId` inside the source with the ten families of the design table.
    - The full Positional_Path keeps the format of today's `cssPath`; `includeBody` selects the browser or the `html-zone` start.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.10, 3.11, 4.2, 10.4_

  - [x] 3.2 Implement the typed wrapper and the exports
    - `createMinimalSelector` evaluates the source once with `new Function`. `isUnstableClass` and `isGeneratedId` are exported from the same source text so TypeScript and the page cannot drift. `minimal` is `undefined` when it is longer than `maxLength`.
    - _Requirements: 3.7, 3.8, 3.9, 9.6_

  - [x]* 3.3 Write unit tests for the algorithm
    - File: `tests/unit/minimal-selector.test.ts`. Cases: the real recorded path of the Introduction (shorter unique selector when an anchor exists, the whole path when none), each unstable-class family, BEM names kept, a hostile attribute value, no-anchor fallback, drift guard that `isGeneratedId` equals `looksGenerated` on generated strings.
    - _Requirements: 3.4, 3.5, 3.10, 11.7_

  - [x]* 3.4 Write property tests for uniqueness, length and idempotence
    - File: `tests/property/minimal-selector.property.test.ts`.
    - **Property 4: Minimal selector is unique** (HTML adapter here; the browser adapter is run in a Playwright page with `page.setContent`, many documents per `page.evaluate`).
    - **Property 5: Minimal selector uses no more levels than the positional path**
    - **Property 6: Idempotence**
    - _Requirements: 3.1, 3.7, 3.8, 3.9, 3.11, 11.1, 11.2, 11.3_

  - [x]* 3.5 Write property tests for volatile sources and the safe grammar
    - File: `tests/property/minimal-selector-safety.property.test.ts`.
    - **Property 7: No volatile source**
    - **Property 8: Safe grammar**
    - _Requirements: 3.4, 3.5, 4.2, 10.4, 11.4_

  - [x]* 3.6 Write the property test for one behavior in both environments
    - File: `tests/property/minimal-selector-parity.property.test.ts`. Begin with `// checkpoint-only: needs G-E` (the HTML adapter uses the parser and resolver of `src/suggest/html-zone.ts`, which G-E owns; it runs at the final checkpoint). Do not edit `html-zone.ts` here.
    - **Property 12: One behavior in both environments**
    - _Requirements: 9.1, 9.6_

- [x] 4. G-C candidate replay (CG-2)
  - Owns: `src/replay/runtime/extract.ts`, `src/replay/runtime/web-steps.ts`, `tests/unit/extract.test.ts` (additions), `tests/unit/zone-candidates-replay.test.ts`, `tests/property/zone-replay.property.test.ts`, `tests/property/zone-budget.property.test.ts`, `tests/property/zone-compat.property.test.ts`.
  - Both runtime files import nothing from `src/` (`tests/unit/generated-no-src-import.test.ts` stays green).

  - [x] 4.1 Implement the pure replay functions
    - `extract.ts`: `zoneCandidatesOf` (undefined without `selectors`, otherwise `dedupe([selector, ...selectors])`, at most 6), `candidateBudgets` (`ceil(T/2)` for the first, `floor((T - first) / (n - 1))` for the others, each at least 1), `zoneCount`, `judgeCandidate` with the four rules of the design, `fallback` on success, `tried` on failure, `notFoundAfterCandidates`, and `candidatesTried` in `zoneFailureResult` only when `tried` is defined. `notFoundMessage` stays unchanged for a zone without candidates. No page text in any message.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_

  - [x] 4.2 Add the candidate branch to `extractWebZone`
    - `web-steps.ts`: begin with `const list = zoneCandidatesOf(zone); if (list === undefined) { ...current body, unchanged }`. The new branch loops over `list` with `candidateBudgets`, waits for `attached` per candidate, reads `{ tag, raw }` through the installed `window.__daemonizeZone`, treats a thrown error as `rejected` for that candidate only, keeps the first `soft` verdict, returns the first `accepted`, and sets `fallback` when the index is not the first. Delete `window.__daemonizeZone` in `finally`. A candidate is passed to the page query function only, never run as code.
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7, 6.9, 10.5_

  - [x]* 4.3 Write unit tests for replay
    - Files: `tests/unit/extract.test.ts` (additions), `tests/unit/zone-candidates-replay.test.ts`. Cases: first candidate gone and second present (`zoneFallback.position === 2`), no candidate matches (`candidatesTried`, no page text), a table with a header only returned from the primary with no fallback, a faulty candidate followed by a good one, a hand-edited invalid selector rejected for that candidate only.
    - _Requirements: 6.1, 6.2, 6.6, 6.7, 11.7_

  - [x]* 4.4 Write property tests for the first accepted candidate and the fingerprint rule
    - File: `tests/property/zone-replay.property.test.ts`.
    - **Property 14: First accepted candidate wins**
    - **Property 15: Fingerprint rule**
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.9_

  - [x]* 4.5 Write the property test for the time budget
    - File: `tests/property/zone-budget.property.test.ts`.
    - **Property 16: Time budget**
    - _Requirements: 6.5_

  - [x] 4.6 Write the backward-compatibility property test (required)
    - File: `tests/property/zone-compat.property.test.ts`. Keep the previous `extractWebZone` as an oracle inside the test.
    - **Property 17: A zone without candidates behaves as before**
    - _Requirements: 6.8, 7.5, 11.6_

- [x] 5. G-D generator and output schema (CG-3)
  - Owns: `src/compiler/mcp-generator.ts`, `src/schema/schema-inferencer.ts`, `tests/unit/generated-zone-candidates.test.ts`, `tests/property/generated-zone.property.test.ts`.

  - [x] 5.1 Patch the generated server only when a zone has `selectors`
    - `mcp-generator.ts`: add `usesZoneCandidates(set)`. When true, apply `patchLines` once to the assembled web lines: the extended `ResultZone` type, the `let fallback` declaration before the `if`, `fallback = read.fallback;` after `text = read.text;`, and the `zoneFallback` spread line. `patchLines` throws when an anchor line is missing. When false, emit nothing new. `finalOf` stays unchanged. A terminal set is unchanged.
    - _Requirements: 6.7, 7.3, 7.4_

  - [x] 5.2 Describe `zoneFallback` in the output schema
    - `schema-inferencer.ts`: add `zoneFallback: { type: 'object', properties: { position: integer, of: integer } }` to `outputSchema.properties` only when the zone has `selectors`. `drifted` and the other fields stay untouched.
    - _Requirements: 6.7, 7.4_

  - [x] 5.3 Write generator compatibility tests (required)
    - File: `tests/unit/generated-zone-candidates.test.ts`. For a set with no `selectors`, the generated `mcp-server.ts`, `replay.ts` and `docker-replay.ts` equal the old text. For a set with `selectors`, the `final` object holds `selectors` and `fingerprint`, and a deleted anchor line makes generation throw. `generated-compat.test.ts` and `generator-firewall.test.ts` pass unchanged.
    - _Requirements: 7.3, 7.4, 11.6_

  - [x]* 5.4 Write the property test for the generated text
    - File: `tests/property/generated-zone.property.test.ts`.
    - **Property 21: Generated text differs only by the named lines**
    - _Requirements: 7.3, 7.4, 11.6_

- [x] 6. Checkpoint - wave 1 groups done (G-A, G-C, G-D)
  - Require `npx tsc --noEmit`, the tests of the three groups (except tests flagged `checkpoint-only`), `tests/unit/regression-fixture.test.ts`, `tests/unit/generated-compat.test.ts` and `tests/unit/generated-no-src-import.test.ts` to pass.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. G-B recorder and panel (CG-4)
  - Owns: `src/recorder/zone-candidates.ts`, `src/recorder/live-recorder.ts`, `src/recorder/capture-script.ts`, `tests/unit/zone-candidates.test.ts`, `tests/unit/zone-copy.test.ts`, `tests/property/zone-candidates.property.test.ts`, `tests/property/zone-candidates-page.property.test.ts`, `tests/property/zone-copy.property.test.ts`.
  - `selector-builder.ts` and `buildSelectors` are not modified (Requirement 5.5).

  - [x] 7.1 Implement the candidate ranking
    - `zone-candidates.ts`: `zoneCandidateSelectors` (the four kinds through `buildSelectors`, then `role=<role>` when a role is set, then `minimal`, then `positional`; no use of `info.css`), `limitCandidates` (drop a candidate that holds a known value of 3 or more characters, at most 4 stable plus 1 positional, each within 300 characters, positional last, no duplicate), `isFragile`, `zoneFingerprint` (`count` only for `table` and `list` and only when at least 1).
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 5.1, 5.4, 10.1, 10.2, 10.3_

  - [x] 7.2 Wire the page script and the warning
    - `capture-script.ts`: interpolate `MINIMAL_SELECTOR_SOURCE` once near `cssPath` (leave `cssPath` unchanged), add `zoneFactsOf(el)` with the browser adapter (`includeBody: true`), add `count` to the `analyzeZone` table and list results (other fields unchanged), remove the `tag.class` replacement in `resultInfoOf` and set `info.css` to the Minimal_Selector when there is one, pass `zone: zoneFactsOf(el)` from `finishMarkResult`, the Wider and Narrower handler and the kind tabs, keep `zoneTarget` and `__daemonizeHelpers.isZoneTarget`, and show `div[data-daemonize-action=result-fragile]` with `ZONE_COPY.fragile` after the badge row when `lastMark.fragile` is true. The text uses `K.text` and `K.muted`. Nothing disables "Finish and save". Hover highlight, trail, badge and kind suggestion stay unchanged.
    - _Requirements: 3.2, 4.1, 4.2, 5.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 7.3 Verify candidates on the live page
    - `live-recorder.ts`: add `zone?: ZoneFacts` to `MarkResultRequest` and `selectors?`, `fragile?` to the success result. Add `markResultInFrame(request, frame)`: build the raw list, keep a candidate only when `frame.locator(c).count() === 1` and `isZoneTarget` is true for it, leave out a candidate whose check throws, apply `limitCandidates` with `recorder.variableValues()`, fall back to `facts.positional` when the list is empty (fragile), and fall back to the legacy `selector` alone without `zone`. Cache the candidates per element for kind-tab clicks. The binding `__daemonizeMarkResult` calls it with `source.frame`. `handleMarkResult` stays synchronous and unchanged.
    - _Requirements: 1.1, 1.6, 1.8, 2.1, 2.2, 2.3, 2.4, 5.2, 5.3, 10.3_

  - [x] 7.4 Write the unit tests for ranking and the warning text (required)
    - Files: `tests/unit/zone-candidates.test.ts`, `tests/unit/zone-copy.test.ts`. `zone-copy.test.ts` applies the banned-word regex of `studio-ui-copy.test.ts` to every `ZONE_COPY` text and checks that the text is part of `CAPTURE_SCRIPT` without backtick or `${`. `zone-candidates.test.ts` covers the role-only case, a faulty frame, a fragile zone that can still be accepted, and the warning that appears for a positional-only zone, is absent otherwise and goes away after Wider. `capture-panel-logic.test.ts` keeps passing.
    - _Requirements: 2.4, 5.1, 8.1, 8.3, 8.5, 8.6, 11.7, 11.8_

  - [x]* 7.5 Write property tests for the pure ranking
    - File: `tests/property/zone-candidates.property.test.ts`.
    - **Property 1: Candidate list shape**
    - **Property 2: Ranking order**
    - **Property 20: Typed values never appear**
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.2, 10.3_

  - [x]* 7.6 Write the property test for the warning text
    - File: `tests/property/zone-copy.property.test.ts`.
    - **Property 22: Panel text is plain**
    - _Requirements: 8.2, 8.6, 11.8_

  - [x]* 7.7 Write property tests on a live page
    - File: `tests/property/zone-candidates-page.property.test.ts` (Playwright, `page.setContent`, no network).
    - **Property 3: Determinism of the stored zone**
    - **Property 9: Candidates are proven**
    - **Property 10: Fragile classification**
    - **Property 11: A role alone is emitted and kept only when unique**
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 3.9, 5.1, 5.2, 5.3, 5.4, 8.1, 8.3, 11.1_

- [x] 8. G-E suggester (CG-5)
  - Owns: `src/suggest/html-zone.ts`, `src/suggest/suggester.ts`, `src/suggest/model-suggester.ts`, `src/suggest/deterministic.ts` (only if the grep of task 8.1 shows that the copy of a suggested zone happens there), `tests/unit/suggest.test.ts` (the two named lines), `tests/property/suggest-zone.property.test.ts`.
  - Studio code that applies a suggested zone, if the grep finds any, is added to this list by the conductor before the task starts. A search of `src/studio/**` before planning found no copy of `resultZone`, so none is expected.

  - [x] 8.1 Use the shared algorithm in the Suggester
    - `html-zone.ts`: `zoneSelectorFor(node, root)` builds facts with `createMinimalSelector()` and the `html-zone` adapter (`includeBody: false`), builds the raw list with `zoneCandidateSelectors`, keeps only the candidates for which `resolveSelector(root, c)` is exactly `[node]`, and applies `limitCandidates(…, [])`. `suggestResultZone` returns `{ selector: list[0], selectors: list, extractor }`. Remove the local `cssPath` in favour of `positional`. Set no fingerprint.
    - `suggester.ts`: add `selectors?: string[]` to `SuggestedResultZone` and to the JSON schema of the model suggester. Run `grep` for `resultZone` in `src/suggest/**` and `src/studio/**` (including `ui/js`) and make any code that copies a suggested zone into a workflow copy `selectors` too.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6_

  - [x] 8.2 Update the two existing suggester assertions (required)
    - `tests/unit/suggest.test.ts` lines 123 and 130: change `toEqual` to `toMatchObject` and add a check that `selectors[0] === selector`. List both lines and the reason in the commit message.
    - _Requirements: 9.4, 9.5_

  - [x]* 8.3 Write the property test for suggested candidates
    - File: `tests/property/suggest-zone.property.test.ts`.
    - **Property 13: Suggested candidates resolve to the suggested node**
    - _Requirements: 9.2, 9.4_

- [x] 9. Checkpoint - wave 2 groups done (G-B, G-E)
  - Require `npx tsc --noEmit`, the tests of G-B and G-E, the `checkpoint-only` test of task 3.6, `tests/unit/capture-panel-logic.test.ts`, the banned-word tests (`tests/unit/studio-ui-copy.test.ts`, `tests/property/connect-copy.property.test.ts`) and `tests/unit/regression-fixture.test.ts` to pass.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. G-F end-to-end tests (CG-6)
  - Owns: `tests/integration/result-zone-robustness.test.ts` (new), `tests/integration/result-zone-interactive.test.ts` (line 127 only).
  - Both files begin with `// checkpoint-only: needs G-B, G-C, G-D`.

  - [x] 10.1 Update the interactive zone assertion (required)
    - `tests/integration/result-zone-interactive.test.ts` line 127: change `toEqual({ selector: '#wiki-results', extractor: { kind: 'list' } })` to `toMatchObject` of the same object plus `selectors[0] === selector`. Other assertions of the file stay unchanged. `result-zone.test.ts` stays unchanged. List the change in the commit message.
    - _Requirements: 1.1, 1.2_

  - [x]* 10.2 Write the integration test for a changed layout
    - File: `tests/integration/result-zone-robustness.test.ts`. Mark a zone on a local page, add a wrapper div, reorder siblings and rename a generated class, then replay through a generated server. Check that the result is returned and that `zoneFallback` is reported when the first candidate broke. Add the case where no candidate matches (`result_zone_not_found`, `candidatesTried`) and the case of an old zone with only `selector` (same result as before).
    - _Requirements: 6.1, 6.6, 6.7, 6.8, 7.3, 7.5_

- [x] 11. Final checkpoint - full verification and commits
  - [x] 11.1 Run the full verification
    - In the repository root: `npm run build`, `npx tsc --noEmit`, `npm run check:secrets`, `npm run studio:build`.
    - In `kiro-extension`: its typecheck, build and package scripts (names as in its `package.json`).
    - In the repository root: `$env:DAEMONIZE_REQUIRE_EXTENSION_BUILD='1'; npm test` (all `checkpoint-only` tests included). Report exact pass and fail counts.
    - _Requirements: 6.10, 11.9, 11.10_

  - [x] 11.2 Check the regression snapshots of old workflows
    - Require that `git diff --exit-code` shows no change in the stored expected snapshot files used by `tests/unit/regression-fixture.test.ts`, that `ALLOWED_DIFFERENCES` has no new entry, and that `generated-compat.test.ts`, `merge-compat.test.ts` and `workflow-set-compat.test.ts` pass with their old fixtures. The only changed assertions are the three named in the Overview.
    - _Requirements: 7.1, 7.2, 7.3, 7.5_

  - [x] 11.3 Create one commit per group (no push)
    - In order, with `git add` of the paths of that group only, no `--no-verify`:
      - CG-0 `feat: zone candidate types, schema and seams` (group G0)
      - CG-1 `feat: minimal selector algorithm for result zones` (G-A)
      - CG-2 `feat: replay result zone candidates in order` (G-C)
      - CG-3 `feat: generator and output schema for zone fallback` (G-D)
      - CG-4 `feat: recorder verifies zone candidates and warns on fragile zones` (G-B)
      - CG-5 `feat: suggester returns ranked zone candidates` (G-E, name the two changed assertions)
      - CG-6 `test: end-to-end result zone robustness` (G-F, name the changed assertion)
    - Run `npx tsc --noEmit` and the regression tests before each commit. Do not push.
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster first version. The required tests protect old workflows and the plain-language rule.
- Each task references the requirement criteria it covers. Property tasks name the design property.
- Tests flagged `checkpoint-only` need code from another group and run at the final checkpoint.
- Every commit is made at task 11.3, after the full verification passes.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.5"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2"] },
    { "id": 4, "tasks": ["3.3", "3.4", "3.5", "3.6", "4.3", "4.4", "4.5", "4.6", "5.3", "5.4"] },
    { "id": 5, "tasks": ["7.1", "8.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6", "8.2", "8.3"] },
    { "id": 7, "tasks": ["7.7"] },
    { "id": 8, "tasks": ["10.1", "10.2"] }
  ]
}
```
