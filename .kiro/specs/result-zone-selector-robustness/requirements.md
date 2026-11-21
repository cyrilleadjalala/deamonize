# Requirements Document

## Introduction

Daemonize records an action in a browser, compiles it into a generated MCP server, and replays it. At the end of a recording the user marks the part of the final screen that holds the result (the Result_Zone). A call returns the data extracted from that zone. Today the zone is stored as one selector. When that selector stops matching after a layout change, the replay returns `result_zone_not_found` although the action itself ran. Steps do not have this weakness: they keep a ranked list of candidate selectors and can heal.

Facts the requirements rely on, verified in the code:

- `buildZoneSelector` (`src/recorder/selector-builder.ts`) calls `buildSelectors` without text and without parent selector, and keeps only the first candidate (`own[0]`). The order is role and name, `data-testid`, non-generated id, `name` attribute, then the CSS path. `buildSelectors` drops a CSS path that contains `:nth-of-type` whenever another candidate exists.
- The CSS path is built by `cssPath` in `src/recorder/capture-script.ts` and by `cssPath` in `src/suggest/html-zone.ts`. It starts at `body` or at the nearest ancestor with an id, and adds `:nth-of-type(n)` at each level. A real recorded path is `body > div:nth-of-type(2) > main > div > div > div:nth-of-type(4) > div:nth-of-type(1) > div > div:nth-of-type(1) > p`.
- `resultInfoOf` (`src/recorder/capture-script.ts`) clears the accessible name for content roles (`CONTENT_ROLES`) and when the content equals or starts with the name, with the comment that the zone is then found by role alone. `buildSelectors` emits a role selector only when `role` and `name` are both set. A zone without a name therefore has no role selector and falls back to test id, id, `name` attribute or the CSS path. This is a confirmed inconsistency.
- `resultInfoOf` replaces a path that contains `:nth-of-type` by `tag.class` only when one class matching `^[a-z][a-z-]{2,30}$` makes the selector unique in the page. Such a class is rare with utility-class frameworks.
- Nothing checks, when the user picks the zone, that the chosen selector matches exactly one element in the live page.
- `handleMarkResult` (`src/recorder/live-recorder.ts`) stores the selector of the zone. The zone is read by `pickResultZone`, `finishWebZone` and `WEB_ZONE_FUNCTION` in `src/replay/runtime/extract.ts`, and the generated `mcp-server.ts` carries a copy of that code and reads `final.resultZone.selector`.
- `ResultZone` (`src/types.ts`) holds `selector`, `rect`, `extractor` and `schema`. `ResultZone` is validated by the `ResultZone` definition in `src/workflow/workflow-set.ts` with `additionalProperties: false`.
- The final-screen suggestion (`src/suggest/html-zone.ts`) builds the selector of a suggested zone from the parsed HTML with the same `buildZoneSelector` and the same kind of CSS path.

Constraints that apply to every requirement:

- Old `daemonize.workflows.json` files load without change, and a workflow whose zone holds only `selector` replays exactly as before. A generated server compiled before this change keeps working. Existing regression snapshot tests keep passing, or change only in a way that Requirement 9 documents.
- `src/replay/runtime/*` stays copyable into the output folder and imports nothing from `src/`.
- The Studio picker behaviour stays unchanged: hover highlight, the Wider and Narrower trail, the live preview badge and the kind suggestion.
- Text shown to the user uses Plain_Language. The banned whole words are `record`, `compile`, `storage state`, `environment variable`, `MCP`, `JSON`, `token` and `CLI`, checked case-insensitively by the copy tests (`tests/unit/studio-ui-copy.test.ts`, `tests/property/connect-copy.property.test.ts`).
- No secret value and no recorded page text appears in a selector, a log or a message.
- Terminal rectangle zones, the picker interaction design and self-healing of zones by AI are out of scope.

## Glossary

- **Result_Zone**: The part of the final screen of a workflow that a call returns, stored as `resultZone` (selector or rectangle, extractor, schema).
- **Zone_Selector**: A selector string that locates the element of a web Result_Zone. It is a Playwright selector (`role=…`, `[data-testid=…]`, `#id`, `[name=…]`) or a CSS selector.
- **Zone_Candidates**: The ranked list of Zone_Selectors stored with a web Result_Zone in a new optional field `selectors`, in addition to the existing `selector`.
- **Primary_Selector**: The field `selector` of a Result_Zone. It stays the first entry of Zone_Candidates when Zone_Candidates exists.
- **Zone_Fingerprint**: A small record of the marked element stored with the Result_Zone: its tag name, its extractor kind and, for a table or a list, its approximate row or item count. It holds no page text.
- **Minimal_Selector**: A CSS selector computed in the live page at pick time that matches exactly one element, the marked element, and is built by the Minimal_Selector_Algorithm.
- **Minimal_Selector_Algorithm**: The procedure that starts from the marked element and climbs ancestors only while `querySelectorAll(selector).length` differs from 1, using anchors and combinators as Requirement 3 defines.
- **Anchor**: A stable part of a selector: a landmark element (`main`, `nav`, `header`, `footer`, `aside`, `form`, `section`, `article`, `table`, `ul`, `ol`, `dl`), a stable id, a `data-testid`, a `role` attribute, or a Stable_Class.
- **Stable_Class**: A class name that is not a Hashed_Class.
- **Hashed_Class**: A class name that looks generated: a run of eight or more hexadecimal characters, a name with a hash suffix after `-` or `_` (such as `css-1a2b3c`, `sc-`, `jsx-`, `_abc123`), or a name that contains a digit run of four or more. The design fixes the exact patterns.
- **Generated_Id**: An id for which `looksGenerated` (`src/recorder/selector-builder.ts`) returns true.
- **Positional_Path**: A selector that depends on the position of an element among its siblings, that is, one that contains `:nth-of-type`, `:nth-child`, `:first-child` or `:last-child`.
- **Fragile_Zone**: A Result_Zone whose Zone_Candidates, after Requirement 3 has run, hold only Positional_Paths.
- **Recording_Panel**: The panel the recorder shows over the page being recorded (`src/recorder/capture-script.ts`).
- **Replay_Runtime**: The code of `src/replay/runtime/extract.ts` and its verbatim copy in a generated server.
- **Recorded_Final_Screen**: The final page as it was when the user marked the zone, or its stored HTML.
- **Suggester**: The final-screen suggestion of `src/suggest/html-zone.ts`.
- **Content_Role**: A role of `CONTENT_ROLES` in the recorder, such as `status`, `alert` or `row`, whose accessible name follows the content.
- **Candidate_Limit**: The maximum number of entries in Zone_Candidates, set to 5.
- **Selector_Length_Limit**: The maximum length of one Zone_Selector, set to 300 characters.

## Requirements

### Requirement 1: Store ranked zone candidates

**User Story:** As a user who recorded a tool, I want the result zone to keep several ways to find it, so that one layout change does not break the tool.

#### Acceptance Criteria

1. WHEN the user marks a web Result_Zone, THE Recorder SHALL store the Primary_Selector and Zone_Candidates, with the Primary_Selector equal to the first entry of Zone_Candidates.
2. THE Recorder SHALL order Zone_Candidates from the most stable to the least stable: role selector, `data-testid`, non-generated id, `name` attribute, Minimal_Selector, then Positional_Path.
3. THE Recorder SHALL store at most the Candidate_Limit entries in Zone_Candidates, with no duplicate entry.
4. THE Recorder SHALL store no Zone_Selector longer than the Selector_Length_Limit.
5. IF a candidate is longer than the Selector_Length_Limit, THEN THE Recorder SHALL leave that candidate out of Zone_Candidates.
6. WHEN the Recorder stores Zone_Candidates, THE Recorder SHALL also store a Zone_Fingerprint of the marked element.
7. THE workflow schema SHALL accept the optional fields `selectors` and `fingerprint` on a Result_Zone, and SHALL keep accepting a Result_Zone that has neither.
8. THE Recorder SHALL write the same Zone_Candidates and Zone_Fingerprint whenever it marks the same element on the same page content (deterministic output).

### Requirement 2: Check candidates against the live page at pick time

**User Story:** As a user, I want the stored selectors to be proven on the page I am looking at, so that the tool does not start with a selector that never worked.

#### Acceptance Criteria

1. WHEN the user marks a web Result_Zone, THE Recorder SHALL evaluate each candidate in the live page and keep only the candidates that resolve to exactly one element, the marked element.
2. IF no candidate resolves to exactly the marked element, THEN THE Recorder SHALL keep the Positional_Path of the marked element and SHALL treat the zone as a Fragile_Zone.
3. THE Recorder SHALL store a candidate only after the check of criterion 1 has passed for it.
4. IF the live page cannot evaluate a candidate, THEN THE Recorder SHALL leave that candidate out and continue with the others.

### Requirement 3: Compute a minimal unique selector

**User Story:** As a user, I want a short selector that does not depend on the whole page layout, so that the zone is still found when the page around it changes.

#### Acceptance Criteria

1. WHEN the Recorder computes a Minimal_Selector, THE Minimal_Selector_Algorithm SHALL start from the marked element and add one ancestor at a time only while `querySelectorAll(selector).length` is not 1.
2. THE Minimal_Selector_Algorithm SHALL anchor the selector on the nearest ancestor that is an Anchor.
3. THE Minimal_Selector_Algorithm SHALL join levels with the descendant combinator, and SHALL use the child combinator only where the descendant combinator would match more than one element.
4. THE Minimal_Selector_Algorithm SHALL prefer, for each level, a Stable_Class or a stable attribute over `:nth-of-type`, and SHALL add `:nth-of-type` to a level only when no Stable_Class or attribute makes that level unique.
5. THE Minimal_Selector_Algorithm SHALL build no selector from an element text, from `:has-text`, from `text=`, from a Generated_Id or from a Hashed_Class.
6. THE Minimal_Selector_Algorithm SHALL build no selector from an attribute whose value is the value of a secret or a text typed by the user during the recording.
7. FOR ALL pages and marked elements, THE Minimal_Selector SHALL be no longer than the full Positional_Path of the same element.
8. FOR ALL pages and marked elements, IF the Minimal_Selector_Algorithm returns a selector, THEN the selector SHALL match exactly the marked element in the page where it was computed.
9. THE Minimal_Selector_Algorithm SHALL return the same selector whenever it runs twice on the same page and the same element (idempotence).
10. IF the marked element has no Anchor and no unique Stable_Class on any ancestor, THEN THE Minimal_Selector_Algorithm SHALL return the shortest unique Positional_Path it found.
11. THE Minimal_Selector_Algorithm SHALL return a selector that stays within the Selector_Length_Limit, or SHALL return none.

### Requirement 4: Replace the weak class shortcut

**User Story:** As a developer of the recorder, I want one rule for the stable selector of a zone, so that the old shortcut for classes does not compete with the new algorithm.

#### Acceptance Criteria

1. WHEN the recorder builds the info of a marked zone, THE Recorder SHALL use the Minimal_Selector_Algorithm in place of the `tag.class` replacement of `resultInfoOf`.
2. THE Recorder SHALL keep the existing `tag.class` selector as a candidate when it is unique in the page and its class is a Stable_Class.

### Requirement 5: Role-only selector for content roles

**User Story:** As a user who marked a status, an alert or a row, I want the zone to be found by its role when that role is unique on the page, so that a changing message does not break the zone.

#### Acceptance Criteria

1. WHEN the marked element has a Content_Role and no accessible name is stored, THE Recorder SHALL emit the selector `role=<role>` as a candidate.
2. WHEN the marked element has a non-content role and no accessible name is stored, THE Recorder SHALL emit the selector `role=<role>` as a candidate only if it resolves to exactly one element in the live page.
3. IF a role-only selector resolves to more than one element in the live page, THEN THE Recorder SHALL leave that role-only selector out of Zone_Candidates.
4. THE Recorder SHALL emit no role selector that holds the accessible name of a Content_Role.
5. THE workflow-level `buildSelectors` function SHALL keep its current output for a step, so that existing steps and their tests are unchanged.

### Requirement 6: Replay tries candidates in order

**User Story:** As a user who calls the tool, I want the replay to find the result even after the page changed, so that I do not get `result_zone_not_found` when the action ran.

#### Acceptance Criteria

1. WHEN a Result_Zone has Zone_Candidates, THE Replay_Runtime SHALL try the candidates in the stored order, one after the other, and SHALL stop at the first accepted candidate.
2. WHEN a Result_Zone has Zone_Candidates, THE Replay_Runtime SHALL accept a candidate only if the candidate resolves to at least one element and the extractor of the Result_Zone can read that element without error.
3. WHERE a Zone_Fingerprint is stored, THE Replay_Runtime SHALL also accept a candidate only if the tag name of the resolved element equals the recorded tag name.
4. WHERE a Zone_Fingerprint with a row or item count is stored, THE Replay_Runtime SHALL accept a candidate only if the count read from the resolved element is within a tolerance of the recorded count, and the design fixes that tolerance.
5. WHEN a candidate is rejected, THE Replay_Runtime SHALL try the next candidate within the time left of the call, and SHALL NOT wait more than the per-candidate share of the zone timeout.
6. IF no candidate is accepted, THEN THE Replay_Runtime SHALL return `result_zone_not_found` and SHALL report how many candidates were tried, without the text of the page.
7. WHEN a candidate other than the Primary_Selector is accepted, THE Replay_Runtime SHALL report in the result that the zone was found by a fallback candidate and the position of that candidate, so that the Studio can show it.
8. WHEN a Result_Zone has no Zone_Candidates, THE Replay_Runtime SHALL use `selector` only and SHALL behave exactly as before this change.
9. THE Replay_Runtime SHALL change no field of the result of a call that finds its zone with the Primary_Selector.
10. THE Replay_Runtime SHALL import nothing from `src/` and SHALL stay copyable verbatim into a generated server.

### Requirement 7: Backward compatibility

**User Story:** As a user with existing workflows and generated servers, I want nothing to change for them, so that this improvement costs me no migration.

#### Acceptance Criteria

1. WHEN a workflow file written before this change is loaded, THE Workflow_Loader SHALL load it without error and without adding Zone_Candidates or a Zone_Fingerprint.
2. WHEN a workflow file written before this change is saved again without edit of the zone, THE Workflow_Store SHALL write the zone byte for byte as before.
3. WHEN a generated server compiled before this change replays a workflow, THE generated server SHALL read `final.resultZone.selector` as before.
4. WHEN a server is compiled from a workflow that has Zone_Candidates, THE Compiler SHALL write `selectors` and `fingerprint` into the `final` object read by the generated server.
5. FOR ALL Result_Zones that have only `selector`, replay with the new Replay_Runtime SHALL return the same result as the Replay_Runtime of the previous version on the same page (backward compatibility).
6. WHEN a workflow with Zone_Candidates is opened by an older version that rejects unknown fields, THE schema SHALL keep `selector` valid on its own, so that an older version can still replay with the Primary_Selector.

### Requirement 8: Warn about a fragile zone

**User Story:** As a user who just marked a result, I want to be told in plain words when the zone may break, so that I can pick a better element or go on knowingly.

#### Acceptance Criteria

1. WHEN the zone the user marks is a Fragile_Zone, THE Recording_Panel SHALL show a warning next to the live preview badge.
2. THE Recording_Panel SHALL word the warning in Plain_Language with no banned word, and SHALL tell the user what to do, for example to try Wider or Narrower or to pick another element.
3. WHEN the zone the user marks has at least one candidate that is not a Positional_Path, THE Recording_Panel SHALL show no fragile-zone warning.
4. WHEN the user moves the trail with Wider or Narrower, THE Recording_Panel SHALL update or remove the warning for the new element.
5. THE Recording_Panel SHALL NOT block the user from accepting a Fragile_Zone.
6. THE warning text SHALL be a key of the recorder copy table that the copy tests cover, and SHALL contain none of the banned words of the Plain_Language lint.
7. THE Recording_Panel SHALL keep the hover highlight, the Wider and Narrower trail, the live preview badge and the kind suggestion unchanged.

### Requirement 9: Final-screen suggestion

**User Story:** As a user who lets Daemonize suggest the result zone from the final screen, I want the suggestion to use the same robust selectors, so that a suggested zone is as steady as a picked one.

#### Acceptance Criteria

1. WHEN the Suggester proposes a web Result_Zone from the parsed final HTML, THE Suggester SHALL compute Zone_Candidates with the same Minimal_Selector_Algorithm and the same ranking rules as the Recorder.
2. THE Suggester SHALL keep only candidates that its selector resolver resolves to exactly the suggested node on the parsed document.
3. THE Suggester SHALL leave out of Zone_Candidates a selector that its resolver cannot read, as it does today.
4. THE Suggester SHALL return the Primary_Selector in the existing `selector` field of `SuggestedResultZone`, and SHALL add the optional `selectors` field.
5. IF a regression snapshot of the Suggester changes because of this requirement, THEN THE change SHALL be limited to the added `selectors` field or to a shorter selector, and the pull request SHALL list each changed snapshot with the reason.
6. THE Minimal_Selector_Algorithm SHALL have one shared implementation for the capture script and the Suggester where the two environments allow it, or two implementations that a single test suite checks against the same cases.

### Requirement 10: Safety of the stored selectors

**User Story:** As a user, I want the selectors to leak nothing, so that sharing a workflow file exposes no secret or page content.

#### Acceptance Criteria

1. THE Recorder SHALL write no text content of the page into a Zone_Selector or a Zone_Fingerprint.
2. THE Recorder SHALL write no secret value and no value typed into a secret field into a Zone_Selector or a Zone_Fingerprint.
3. IF a candidate contains the value of a known secret of the workflow, THEN THE Recorder SHALL leave that candidate out.
4. THE Recorder SHALL escape every attribute value and class name it puts in a CSS selector, so that the selector is valid and cannot add a clause.
5. THE Replay_Runtime SHALL treat the stored selectors as data: it SHALL pass a candidate to the page query function only, and SHALL NOT run it as code.
6. IF a stored candidate is not a string, is longer than the Selector_Length_Limit, or the list holds more than the Candidate_Limit entries, THEN THE workflow validator SHALL reject the zone with a message that names the field.

### Requirement 11: Property-testable behaviour and regression tests

**User Story:** As a maintainer, I want the guarantees to be tested over many pages, so that a change to the algorithm cannot silently weaken them.

#### Acceptance Criteria

1. THE test suite SHALL include a property test: FOR ALL generated pages and marked elements, every stored candidate of Zone_Candidates resolves to exactly the marked element on the Recorded_Final_Screen.
2. THE test suite SHALL include a property test: FOR ALL generated pages and marked elements, the Minimal_Selector is not longer than the full Positional_Path.
3. THE test suite SHALL include a property test: FOR ALL generated pages and marked elements, the Minimal_Selector_Algorithm returns the same selector when it runs twice.
4. THE test suite SHALL include a property test: FOR ALL generated pages that contain an element with a Generated_Id, a Hashed_Class or text, no stored candidate contains that id, that class or that text.
5. THE test suite SHALL include a property test: FOR ALL generated Zone_Candidates, serialising the workflow then loading it returns an equal zone (round trip).
6. THE test suite SHALL include a property test: FOR ALL Result_Zones with only `selector`, the new Replay_Runtime and the previous Replay_Runtime give the same result.
7. THE test suite SHALL include an example test for each of: the real positional path of the Introduction, the role-only case of Requirement 5, replay with a first candidate that no longer matches and a second that does, and replay where no candidate matches.
8. THE test suite SHALL include an example test that the fragile-zone warning appears for a Fragile_Zone and does not appear otherwise, and a copy test that the warning has no banned word.
9. THE property tests SHALL run at least 100 iterations each.
10. THE test suite SHALL keep `tests/unit/generated-no-src-import.test.ts` passing.
