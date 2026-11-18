# Requirements Document

## Introduction

Daemonize records an action in a browser (or a terminal program), stores it in `daemonize.workflows.json`, compiles it into a generated server, and lets the user test it in the Studio and add it to Kiro. This spec removes eight friction points found in that journey. The numbers match the order of the request.

1. **Optional variables.** `WorkflowVariable.optional` exists in `src/types.ts`, in the schema of `src/workflow/workflow-set.ts`, in `src/schema/schema-inferencer.ts` (an optional variable leaves `required`), in `src/compiler/zod-translator.ts` and in the Playground form (`src/studio/ui/js/schema-form.js`). Three gaps remain. (a) No recorder lets the user mark a variable optional or pick its type: `capture-script.ts` and `live-recorder.ts` send only `{ stepIndex, name }`, and the terminal recorder asks only for a name. (b) `createOfferModel` in `capture-script.ts` drops the "Make variable" offer as soon as the user types in another field (`e.t === 'input'`) or changes route. (c) At replay, `resolveStepValue` (`step-plan.ts`) and `withRecordedDefaults` (`http-replay.ts`) put `step.value` back when the call omits the argument, so an omitted optional value is never left empty.
2. **Several start URLs in one file.** `saveWorkflow` and `mergeWorkflowSets` take `startUrl`, `targetName`, `storageState` from the newest recording (`{ ...newer, workflows }`), and a newer recording without `storageState` erases the older one. The per-application output folder is derived from the origin of `set.startUrl` (`sourceOfSet` in `src/studio/app-names.ts`, `active-app.ts`), so two origins in one file cannot be served correctly.
3. **Checkbox, radio and file inputs.** Only `type` and `select` steps offer "Make variable". A checkbox or radio produces a fixed click, and `input[type=file]` is ignored without a word.
4. **Edit and delete in the Studio.** A recorded workflow can only be renamed, changed or removed by editing the file by hand.
5. **"Test in Studio" from Kiro** ignores the clicked action: `daemonize.testInStudio` takes no argument and `buildBrowserUrl` adds no parameter, although `playground.js` already reads `#/playground?tool=<name>`.
6. **"Save and add to Kiro"** picks the global scope alone when `~/.kiro` exists, and `record-status.js` says "The tool was added to Kiro." even when credentials are still missing.
7. **HTTP and Heal options.** `StudioCompileRunner` always passes `http: 'off'` and `healSupport: false`.
8. **Visual finishing.** `scrollIntoView({ block: 'center' })` cuts the Connect block, and the Studio logo is a ghost close to the Kiro one.

Constraints that apply to every requirement:

- Old `daemonize.workflows.json` files load without change and replay exactly as today. Every new field is optional, and its absence keeps the present behavior. The compiled output of an old file differs from today's output only where a requirement below says so.
- CLI commands, flags and default output stay as they are, except where a requirement names the change (Requirement 12 adds one refusal).
- `src/replay/runtime/*` stays copyable into the output folder and imports nothing from `src/` (`tests/unit/generated-no-src-import.test.ts`).
- `kiro-extension/src/core/` imports neither `vscode` nor the root `src/` (`tests/extension/static/imports.test.ts`). No hard-coded hex colour appears in the extension UI code (`tests/extension/static/no-hardcoded-colors.test.ts`).
- Text on the main screens of the Studio and of the extension uses Plain_Language (`kiro-extension/src/core/plain-language.ts`, `src/studio/ui/js/copy.js`, `tests/extension/static/plain-language.test.ts`).
- `src/studio/ui/app.css` holds no literal colour outside `:root` and every text colour keeps a contrast ratio of at least 4.5:1 (`tests/unit/studio-ui-contrast.test.ts`).
- No secret value appears in a workflow file, a log, a URL, a Studio answer, a notification or a test fixture. `npm run check:secrets` and `findPlainSecrets` keep passing.
- The Studio security model stays in force. New Studio routes are `GET` or `POST` only, carry `remote: 'blocked'`, answer 409 in sample mode when they write, and pass through `redactForStudio`.

Assumptions (taken from the code, not asked):

- `--http` accepts `off` or `auto`, and the bare flag means `auto` (`parseHttpMode` in `src/cli/commands/compile.ts`). `--heal-support` is a boolean. Compiling with heal support contacts no model: the heal modules are copied and the model settings (`DAEMONIZE_MODEL_*`) are read only when a call runs with `DAEMONIZE_MODE=heal`. Without a configured model, a call in heal mode fails on the step that needs healing with the error `heal_unavailable`, and strict calls are unaffected. A server compiled without heal support answers the same error.
- The Studio holds one workflow file. The application of that file is the origin of its `startUrl` (the Application_Key). One output folder, one saved login and one Kiro install exist per application, so the Studio refuses a second origin (Requirement 12) instead of serving several applications from one file. Two start pages of the same origin are supported.
- The saved login used by the Studio (`reuseSession`) lives in the application data folder and never enters the workflow file. Only `daemonize record --storage-state` writes `storageState` into the file.
- A tree row of the Kiro extension has the id `action:<workflowId>`. The tool name comes from `GET /api/workflows`.
- A `check` step (Requirement 7) is replayed in strict mode only. The heal modules are not extended for it.
- The Kiro Power already installed keeps the tool list of the last compile until the user adds the tool again. A deletion followed by a recompile does not rewrite an existing Kiro install.
- A description entered by the user is stored in the workflow file and wins over an accepted suggestion (`src/suggest/apply.ts`) for the same workflow.

## Glossary

- **Workflow_File**: The JSON file `daemonize.workflows.json` holding one Workflow_Set.
- **Workflow_Schema**: The JSON Schema `WorkflowSetSchema` and its loader and writer in `src/workflow/workflow-set.ts`.
- **Workflow_Merger**: `mergeWorkflowSets` in `src/workflow/workflow-set.ts`.
- **Save_Command**: `saveWorkflow` in `src/cli/commands/save-workflow.ts`.
- **Variable**: A `WorkflowVariable` of a workflow.
- **Optional_Variable**: A Variable with `optional: true`.
- **Omitted**: A call argument that is `undefined` or `null`, the same test `resolveStepValue` applies today.
- **When_Omitted**: The new Variable field `whenOmitted`, with the values `useRecorded` (the recorded value is used, as today) and `skip` (the step or field that carries the value is left out). Absence means `useRecorded`.
- **Skipped_Step**: A step that the Replay_Runtime leaves out because its Variable is Omitted and has `whenOmitted: 'skip'`.
- **Skip_List**: The names of the Variables with `optional: true` and `whenOmitted: 'skip'` of one workflow, embedded by the Compiler into the code of its tool.
- **Replay_Runtime**: The files of `src/replay/runtime/` (`step-plan.ts`, `web-steps.ts`, `http-replay.ts`, `row-resolver.ts`) and the `replay.ts` generated by the Compiler.
- **Compiler**: `McpGenerator` in `src/compiler/mcp-generator.ts` and `Compiler` in `src/compiler/compiler.ts`.
- **Recorder_Panel**: The panel injected into the recorded page by `src/recorder/capture-script.ts`, including its End_Sheet.
- **End_Sheet**: The sheet of the Recorder_Panel opened by "Finish and save" in a Studio-driven recording.
- **Live_Recorder**: `LiveRecorder` in `src/recorder/live-recorder.ts`.
- **Workflow_Recorder**: `WorkflowRecorder` in `src/recorder/workflow-recorder.ts`.
- **Terminal_Recorder**: The recorder of `src/recorder/terminal-recorder.ts`, driven by the `v` key.
- **Field_Drawer**: The new part of the Recorder_Panel that lists the fields entered during the session.
- **Session_Field**: A step of the current recording that carries a value a user can turn into a Variable: typed text, a selected option, a checkbox state, a radio choice. A step with `secretRef` is not a Session_Field.
- **Check_Step**: The new step action type `check`, with `value` equal to `true` or `false`.
- **Origin**: The scheme, host and port of a URL (`new URL(url).origin`).
- **Start_Page**: The `startUrl` of a workflow, or of the set when the workflow has none.
- **Studio**: The local web application and JSON API started by `daemonize`.
- **Studio_Server**: `src/studio/server.ts` with the routes of `src/studio/routes/`.
- **Studio_UI**: The pages under `src/studio/ui/`.
- **Workflow_Editor**: The new routes `POST /api/workflows/update` and `POST /api/workflows/delete` and the controls that call them.
- **Recording_Manager**: `src/studio/recording-manager.ts`.
- **Compile_Runner**: `StudioCompileRunner` in `src/studio/compile-runner.ts`.
- **Compile_Options**: The pair `{ http: 'off' | 'auto', healSupport: boolean }`.
- **Kiro_Extension**: The extension in `kiro-extension/`.
- **Install_Scope**: `global` ("All my projects") or `project` ("Only this project").
- **Missing_Secret**: The Secret_Name (for example `PASSWORD`) of a credential the tool needs and the vault does not hold. Names only, never values.
- **Plain_Language**: The rule of `kiro-extension/src/core/plain-language.ts`: none of record, compile, storage state, environment variable, MCP, JSON, token, CLI as a whole word on main screens.
- **Secret_Name**: The upper-case name of a credential (for example `PASSWORD`), matching `^[A-Z][A-Z0-9_]*$`. Never the value.
- **Verification_Suite**: The commands listed in Requirement 24.

## Requirements

### Requirement 1: Define what an omitted optional Variable does

**User Story:** As a workflow author, I want to say what happens when a caller leaves an optional value out, so that the tool can skip a field instead of retyping the recorded value.

#### Acceptance Criteria

1. THE Workflow_Schema SHALL accept the field `whenOmitted` on a Variable only with the string values `useRecorded` or `skip`.
2. IF a Variable has `whenOmitted` with any other value, including `null`, an empty string, a different letter case or a non-string type, THEN THE Workflow_Schema SHALL reject the Workflow_File with an error that names the workflow id and the Variable name, and THE loader SHALL return no Workflow_Set.
3. IF a Variable has `whenOmitted` and does not have `optional: true` (the field is absent or `false`), THEN THE Workflow_Schema SHALL reject the Workflow_File with an error that names the workflow id and the Variable name, and THE loader SHALL return no Workflow_Set.
4. WHEN a Workflow_File in which no Variable has `whenOmitted` and no workflow has `description` is loaded, THE Workflow_Schema SHALL load it with no error and no change to its content, and THE Replay_Runtime SHALL treat every Variable as `useRecorded`, so that replay results equal those produced before this change.
5. FOR ALL valid Workflow_Sets, WHEN a Workflow_Set is written and loaded again, THE Workflow_Schema SHALL return Variables whose `type`, `optional` and `whenOmitted` equal the original values, with an absent `whenOmitted` staying absent (round-trip).
6. THE Workflow_Schema SHALL accept an optional `description` on a workflow, as a string of 0 to 1000 characters, and SHALL reject a `description` that is not a string or is longer than 1000 characters, with an error that names the workflow id.
7. WHEN the Compiler writes the tool description of a workflow whose `description` has at least 1 character after trimming whitespace, THE Compiler SHALL use the trimmed `description` as the lead text in place of the label.
8. WHEN the Compiler writes the tool description of a workflow whose `description` is absent or empty after trimming, THE Compiler SHALL write the same lead text as today.
9. WHEN a Variable has `optional: true`, THE SchemaInferencer SHALL leave that Variable name out of `required`, with `whenOmitted` set to `useRecorded`, `skip` or absent.
10. FOR ALL workflows, THE Compiler SHALL produce the same input schema (property names, types, `required` list and Zod source) whatever the values of `whenOmitted` and `description`.

### Requirement 2: Skip the page steps of an omitted optional Variable

**User Story:** As a caller of a tool, I want to leave an optional field out and have the field stay empty, so that the call does not type a value I never gave.

#### Acceptance Criteria

1. WHEN a step has a `variable` that is Omitted and the Variable has `optional: true` and `whenOmitted: 'skip'`, THE Replay_Runtime SHALL perform no browser or terminal action for that step, including no typing, selecting, clicking, key press or screenshot, and SHALL not start the wait for its effect (`settle`).
2. WHEN a step is skipped, THE Replay_Runtime SHALL run the next step of the workflow in recorded order and SHALL not mark the call as failed because of the skip.
3. WHEN at least one step is skipped, THE Replay_Runtime SHALL add a field `skippedSteps` to the call result. The field SHALL be an array of the zero-based indexes of the Skipped_Steps in the `steps` list of the workflow, in ascending order, without duplicates.
4. WHEN no step is skipped, THE Replay_Runtime SHALL leave `skippedSteps` out of the call result, so that the result of a call on an old Workflow_File has the same fields as today.
5. WHEN a step has a `variable` that is not Omitted, THE Replay_Runtime SHALL perform the step with the supplied value. A supplied empty string, `0` and `false` are not Omitted and SHALL be used as given.
6. WHEN a step has a `variable` that is Omitted and the Variable has `whenOmitted: 'useRecorded'` or no `whenOmitted`, THE Replay_Runtime SHALL use `step.value`, as `resolveStepValue` does today.
7. WHEN a step has `secretRef`, THE Replay_Runtime SHALL perform the step whatever the value of `optional`, `whenOmitted` or the call argument.
8. WHEN a click step selects an option or radio by the value of a Variable that is Omitted with `whenOmitted: 'skip'`, THE Replay_Runtime SHALL skip that click and SHALL list its index in `skippedSteps`.
9. WHEN a `rowBinding.variable` is Omitted and has `whenOmitted: 'skip'`, THE Replay_Runtime SHALL skip every step bound to that row, SHALL list each index in `skippedSteps`, and SHALL perform no action on any other row.
10. IF a `rowBinding.variable` is Omitted, has `whenOmitted: 'useRecorded'` or no `whenOmitted`, and the binding has no `key.text`, THEN THE Replay_Runtime SHALL fail the call with `ROW_VARIABLE_MISSING` and SHALL perform no step bound to that row.
11. WHEN a `rowBinding.variable` is Omitted, has `whenOmitted: 'useRecorded'` or no `whenOmitted`, and the binding has `key.text`, THE Replay_Runtime SHALL find the row by `key.text`.
12. WHILE a terminal program is replayed, WHEN a `type` step has a Variable that is Omitted with `whenOmitted: 'skip'`, THE Replay_Runtime SHALL send no keystroke for that step and SHALL list its index in `skippedSteps`.
13. WHERE the server runs with `DAEMONIZE_SANDBOX=docker`, THE Replay_Runtime SHALL skip the same step indexes and return the same `skippedSteps` as a replay on the host for the same call arguments.

### Requirement 3: Leave an omitted Variable out of recorded HTTP requests

**User Story:** As a caller of a tool compiled with `--http auto`, I want an omitted optional value to be absent from the request, so that the server does not receive a value I did not give.

#### Acceptance Criteria

1. WHEN a recipe binding of kind `query` names an Omitted Variable with `whenOmitted: 'skip'`, THE Replay_Runtime SHALL send the request without that query key, and SHALL send every other query key with the value it would have had if the Variable were not in the recipe.
2. WHEN a recipe binding of kind `body` names an Omitted Variable with `whenOmitted: 'skip'`, THE Replay_Runtime SHALL send the body without the object property, the array item or the form field that carries the binding, and SHALL leave every other property, item and field unchanged. An array item that is removed SHALL not leave an empty or `null` entry, and the remaining items SHALL keep their order.
3. WHEN a recipe binding of kind `header` names an Omitted Variable with `whenOmitted: 'skip'`, THE Replay_Runtime SHALL send the request without that header, and SHALL still send every header whose value comes from a `secretRef` or from a Variable that is not Omitted.
4. WHEN a query key, a body field or a header value mixes recorded text with a skipped Variable (for example `Bearer {{token}}` or `id-{{n}}`), THE Replay_Runtime SHALL remove the whole key, field or header, and SHALL not send the recorded text alone.
5. WHEN a recipe binding names an Omitted Variable with `whenOmitted: 'useRecorded'` or no `whenOmitted`, THE Replay_Runtime SHALL use the recorded value, as `withRecordedDefaults` does today, and the request SHALL be identical to the request that the same call produces before this change.
6. WHEN a step only fills a field to feed a later recorded request and its Variable is a Skipped_Step, THE Replay_Runtime SHALL perform no action for that step if the browser is started later in the same call (for example after a fallback from HTTP to the page).
7. IF the Compiler builds a server with `--http auto` and a recipe binds a Skip_List Variable in the URL path, THEN THE Compiler SHALL stop with a non-zero exit code and a message that names the workflow and the Variable, and SHALL write no file for that workflow.
8. IF a request reaches the sending step with a URL path placeholder whose Variable is Omitted, THEN THE Replay_Runtime SHALL fail the call with the error kind `invalid` and the Variable name, SHALL send no request, and SHALL leave no secret value in the error text.
9. FOR ALL Variable values and Skip_Lists, THE Replay_Runtime SHALL produce a request in which no secret value appears outside a header or body place that the recipe bound to a `secretRef`, no header whose name matches `CREDENTIAL_HEADER` appears unless the recipe held it, and no placeholder text of the form `{{name}}` appears.

### Requirement 4: Embed the Skip_List in the generated code

**User Story:** As a maintainer, I want the generated server to carry the omission rules, so that the replay decides without reading the workflow file.

#### Acceptance Criteria

1. WHEN the Compiler writes the tool of a workflow that has at least one Skip_List Variable, THE Compiler SHALL pass the Skip_List to `runReplay` as an array of Variable names. The array SHALL hold each name once, in the order the Variables appear in the workflow, in the generated `mcp-server.ts`.
2. IF a workflow has no Variable with `optional: true` and `whenOmitted: 'skip'`, THEN THE Compiler SHALL write the tool code, `replay.ts` and `docker-replay.ts` byte-identical to the output the Compiler produces today for the same Workflow_File.
3. THE Skip_List SHALL contain Variable names only. It SHALL contain no recorded value, no payload value and no `secretRef`.
4. THE Replay_Runtime SHALL receive the Skip_List as a parameter of `replay` and of `replayCore` in the generated web (with and without `--http auto`) and terminal targets. THE Replay_Runtime SHALL import nothing from `src/` to do so. The parameter SHALL be optional, and WHEN it is absent or empty, THE Replay_Runtime SHALL behave as it does today.
5. WHERE the server runs with `DAEMONIZE_SANDBOX=docker`, THE generated `docker-replay.ts` SHALL send the Skip_List to the container together with the steps and the call arguments. THE container SHALL apply the same skip decisions as the host for the same inputs.
6. WHEN a Variable is in the Skip_List and a call supplies a value for it (the argument is neither `undefined` nor `null`), THE Replay_Runtime SHALL use the supplied value and SHALL skip no step because of that Variable.
7. IF the Skip_List holds a name that no step, `rowBinding` or recipe binding of the workflow uses, THEN THE Replay_Runtime SHALL ignore that name and SHALL not fail the call.
8. FOR ALL workflows, THE Compiler SHALL produce the same Skip_List when the same Workflow_File is compiled twice, and SHALL produce an input schema that does not depend on the Skip_List.

### Requirement 5: Choose type and optional when a variable is created in the page

**User Story:** As a person recording in the browser, I want to say that a variable is optional and what type it has when I create it, so that I do not edit the file afterwards.

#### Acceptance Criteria

1. WHEN the user opens "Make variable" in the Recorder_Panel, THE Recorder_Panel SHALL show a name field, a type choice with the options "text", "number" and "true or false" (default "text"), and an "Optional" checkbox that is unchecked by default.
2. WHEN the user checks "Optional", THE Recorder_Panel SHALL show a choice with the two options "If left empty: skip this field" and "If left empty: use the recorded value", with "skip this field" selected, and WHEN the user unchecks "Optional", THE Recorder_Panel SHALL hide that choice.
3. WHEN the user confirms, THE Recorder_Panel SHALL call `__daemonizeMarkVariable` with `stepIndex` and `name` as today, plus `type` (`string`, `number` or `boolean`) always, `optional: true` only when the box is checked, and `whenOmitted` (`skip` or `useRecorded`) only when the box is checked.
4. WHEN the Live_Recorder receives a request, THE Live_Recorder SHALL accept `type` only as `string`, `number` or `boolean`, `optional` only as a boolean, and `whenOmitted` only as `useRecorded` or `skip`, and SHALL answer `{ ok: false, error }` for any other value, leaving the recorded steps, Variables and payload unchanged.
5. IF `whenOmitted` is sent and `optional` is not `true`, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` and SHALL not create the Variable.
6. IF the request has `type: 'number'` and the recorded value of the step is not a finite number, or `type: 'boolean'` and the recorded value is not `true` or `false`, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` with a message in Plain_Language and SHALL not create the Variable.
7. IF the request carries `rowText`, THEN THE Live_Recorder SHALL accept only `type: 'string'` (or no `type`) and SHALL answer `{ ok: false, error }` for `number` or `boolean`.
8. WHEN the request has none of `type`, `optional` and `whenOmitted`, THE Live_Recorder SHALL create the Variable exactly as today, so that the Variable has no `type`, `optional` or `whenOmitted` field written by this request.
9. WHEN the Live_Recorder answers `{ ok: false, error }`, THE Recorder_Panel SHALL keep the "Make variable" box open with the entered name, type and optional settings, and SHALL show the error text next to the name field.
10. WHEN the Live_Recorder accepts a valid request, THE Workflow_Recorder SHALL store the Variable with the chosen `type`, `optional` and `whenOmitted`, and SHALL store the observed payload value of the step coerced to the chosen type (a JSON number for `number`, a JSON boolean for `boolean`, the recorded text for `string`).
11. THE Recorder_Panel SHALL let a user complete "Make variable" with the keyboard alone: every new control has an accessible name, Tab reaches each control in the order name, type, optional, omitted choice, and the Enter key confirms.

### Requirement 6: Keep earlier fields available and let the user adjust them

**User Story:** As a person recording, I want to turn any field I typed during the session into a variable and adjust its name, type and optional setting before I save, so that I am not limited to the last field.

#### Acceptance Criteria

1. WHEN `createOfferModel` receives an event `{ t: 'input' }` for a field whose `fieldId` differs from the `fieldId` of the current offer, THE `createOfferModel` function SHALL keep the previous offer in a list of earlier offers, SHALL leave the earlier offer available to the Field_Drawer, and SHALL not set the current offer to `null`. The current offer SHALL stay the newest typed or selected field, as for `{ t: 'typed' }` today.
2. WHEN `createOfferModel` receives an event `{ t: 'route' }`, THE `createOfferModel` function SHALL set the current offer to `null` and SHALL keep the list of earlier offers, so that THE Field_Drawer lists the Session_Fields of the whole session across routes.
3. WHEN the Recorder_Panel sends `{ type: 'fields' }`, THE Live_Recorder SHALL answer with a list in which each Session_Field has `stepIndex` (integer, 0 or more), `label` (text of 0 to 200 characters), `kind` (`text`, `choice`, `check` or `radio`) and, only when the field already has a Variable, `variable` holding its `name`, `type`, `optional` and `whenOmitted`.
4. THE answer to `{ type: 'fields' }` SHALL contain no typed value, no selected text, no recorded `value` of a step and no secret value.
5. THE Live_Recorder SHALL leave out of the answer every step that has `secretRef`, every password field, every one-time-code field and every file field.
6. IF the session holds more than 100 Session_Fields, THEN THE Live_Recorder SHALL answer with the 100 most recent, ordered by `stepIndex` ascending.
7. WHEN the user activates "Review fields" in the End_Sheet, THE Recorder_Panel SHALL open the Field_Drawer with the list from `{ type: 'fields' }` and SHALL keep the End_Sheet's "Save and add to Kiro" action unsent until the user closes the drawer.
8. WHEN the user selects a Session_Field that has no Variable, THE Field_Drawer SHALL show the name field, the type choice (text, number, true or false) and the "Optional" checkbox of Requirement 5, and SHALL send the same request to `__daemonizeMarkVariable` on confirmation.
9. WHEN the user confirms an edit of a Session_Field that already has a Variable, THE Field_Drawer SHALL send `{ name, newName, type, optional, whenOmitted }` to the new binding `__daemonizeEditVariable`. THE request SHALL send `type`, `optional` and `whenOmitted` only for settings the user changed.
10. WHEN the Live_Recorder receives a valid edit, THE Workflow_Recorder SHALL, in one step, rename or retype the Variable and update the `variable` of every step, the `rowBinding.variable` of every step, the `bindings` of the recorded recipes and the key of the observed payload, and THE Live_Recorder SHALL answer `{ ok: true }`. A type change SHALL follow the rules of Requirement 5, criteria 4 to 6 (allowed types, `whenOmitted` only with `optional: true`, recorded value convertible to the type).
11. IF an edit names a Variable that does not exist, or a `newName` that another Variable already uses or that does not match `^[A-Za-z_][A-Za-z0-9_]*$`, or a `newName` longer than 64 characters, or breaks a rule of Requirement 5, criteria 4 to 6, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` with a plain message and SHALL leave every Variable, step, recipe binding and payload key unchanged.
12. IF the user activates "Save and add to Kiro" while a Variable edit in the Field_Drawer is open and unconfirmed, THEN THE Recorder_Panel SHALL keep the End_Sheet closed, SHALL show the open edit and SHALL send no save request.
13. WHEN the Terminal_Recorder has received the name of a Variable, THE Terminal_Recorder SHALL ask whether the Variable is optional (keys `y` or `n`, default `n`) and its type (keys `s` for string, `n` for number, `b` for boolean, default `s`). WHEN the answer is optional, THE Terminal_Recorder SHALL then ask the omitted behavior (key `s` to skip, key `r` to use the recorded value, default `s`).
14. IF the Terminal_Recorder receives an answer other than the keys offered for the question, THEN THE Terminal_Recorder SHALL repeat the same question without creating or changing a Variable. An empty answer SHALL select the default.
15. WHEN a Workflow_File is recorded without using the Field_Drawer, `__daemonizeEditVariable` or the new Terminal_Recorder questions, THE Workflow_Recorder SHALL write the same Workflow_File content as before this requirement (backward compatibility). A Variable created without the new questions SHALL carry no `optional` and no `whenOmitted`.

### Requirement 7: Record the state of a checkbox or switch as a boolean Variable

**User Story:** As a person recording, I want a checkbox or switch to become a true or false input, so that a caller can tick or untick it.

#### Acceptance Criteria

1. WHEN the user clicks an `input[type=checkbox]`, an element with `role=checkbox` or an element with `role=switch`, THE Recorder_Panel SHALL record one Check_Step instead of a `click` step. The step's `value` SHALL be the string `"true"` or `"false"`, read from the control's state after the click (the `checked` property, or `aria-checked="true"` for a role element). An `aria-checked` value of `false`, `mixed` or absent SHALL be recorded as `"false"`.
2. THE Workflow_Schema SHALL accept `check` as an `actionType` of a step. It SHALL accept `value` on a Check_Step only as `"true"` or `"false"`, and SHALL reject any other `value`.
3. WHEN the user makes a Check_Step a Variable, THE Live_Recorder SHALL create the Variable with type `boolean`. IF the request names another type, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` with a plain message and SHALL create no Variable.
4. WHEN a Check_Step runs, THE Replay_Runtime SHALL resolve the target state as follows. A Variable value of `true` or `"true"` gives checked. A Variable value of `false` or `"false"` gives unchecked. If the step has no Variable, the recorded `value` is used. THE Replay_Runtime SHALL then read the current state of the control and SHALL click the control once only when the current state differs from the target state.
5. WHEN the control already has the target state, THE Replay_Runtime SHALL perform no click and SHALL report the step as passed.
6. IF the control does not show the target state within the step timeout after the click, THEN THE Replay_Runtime SHALL fail the step with the standard step failure that names the step index and the action `check`. This includes a disabled control.
7. WHEN the Variable of a Check_Step is Omitted and has `whenOmitted: 'skip'`, THE Replay_Runtime SHALL skip the step under Requirement 2, and the control SHALL keep its state from before the step.
8. WHEN the Variable of a Check_Step is Omitted and has `whenOmitted: 'useRecorded'` or no `whenOmitted`, THE Replay_Runtime SHALL apply the recorded `value` as the target state.
9. WHEN the Compiler plans a tool with `--http auto`, THE Replay_Runtime SHALL classify a Check_Step as preparatory, like `type` and `select`, and SHALL replay it on the page only when a later step needs the browser.
10. IF a Check_Step cannot be located, THEN THE Replay_Runtime SHALL fail the step without any repair attempt. This applies in heal mode and in strict mode, and SHALL be reported with the same step failure as in strict mode.
11. WHEN a Workflow_File recorded before this change is loaded, THE Replay_Runtime SHALL replay its `click` steps on checkboxes and switches exactly as before, and the Workflow_Schema SHALL load the file with no change. WHEN a Workflow_File has no `check` step, THE Compiler SHALL write the same code as before this change.
12. FOR ALL Check_Steps and boolean target values, running the step twice in a row on the same control SHALL leave the control in the target state and SHALL perform at most one click in total (idempotence).

### Requirement 8: Record a radio group as a choice Variable

**User Story:** As a person recording, I want a group of radio buttons to become one input with the list of choices, so that a caller can pick one.

#### Acceptance Criteria

1. WHEN the user clicks an `input[type=radio]` or an element with `role=radio` that has no ancestor row, card or list item (the same containers that give a step a `rowBinding`), THE Recorder_Panel SHALL offer "Make variable" for that click step.
2. WHEN the user opens "Make variable" for a radio click step, THE Recorder_Panel SHALL show the name field and the "Optional" controls of Requirement 5, SHALL not show the type choice, and SHALL send `type: 'string'` in the request of `__daemonizeMarkVariable`.
3. WHEN the Live_Recorder receives a valid request for a radio click step, THE Live_Recorder SHALL create a Variable of type `string` whose `enum` lists the accessible names of the enabled radios of the same group, in document order, and SHALL record the accessible name of the clicked radio as the recorded value of the step.
4. THE Live_Recorder SHALL define a radio group as the radios with the same non-empty `name` attribute inside the same form, or the same document when there is no form, or the `role=radio` elements inside the same `role=radiogroup` ancestor.
5. IF the group has more than 50 radios, or two radios of the group have the same accessible name, or a radio of the group has an empty accessible name or one longer than 200 characters, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` with a message in Plain_Language that gives the reason, SHALL create no Variable, and SHALL keep the click step as recorded.
6. IF the clicked radio is disabled or has no group of at least 2 radios, THEN THE Live_Recorder SHALL answer `{ ok: false, error }` and SHALL create no Variable.
7. WHEN a click step on a radio has a Variable and the Variable is not Omitted, THE Replay_Runtime SHALL locate the radio by role `radio` and an accessible name equal to the value of the Variable (exact match, as it does for an option) and SHALL click it.
8. WHEN the radio named by the value is already selected, THE Replay_Runtime SHALL perform the click without failure and SHALL leave that radio selected.
9. IF the call gives a value that is not in `enum`, THEN THE generated server SHALL refuse the call before the replay with the same validation error that other `enum` Variables give, and THE Replay_Runtime SHALL perform no step.
10. WHEN the Variable of a radio click step is Omitted and `whenOmitted` is `skip`, THE Replay_Runtime SHALL skip the click as in Requirement 2.
11. WHEN the Variable of a radio click step is Omitted and `whenOmitted` is `useRecorded` or absent, THE Replay_Runtime SHALL click the radio whose accessible name equals the recorded value.
12. WHEN a radio click step has no Variable, THE Replay_Runtime SHALL replay the recorded click exactly as today, so that a Workflow_File recorded before this change replays unchanged.
13. IF no radio with the requested accessible name is found during replay, THEN THE Replay_Runtime SHALL fail the step with the same locator failure as for a missing option, and SHALL not click another radio.
14. FOR ALL radio Variables, THE Compiler SHALL produce an input schema whose allowed values equal `enum`, and whose `required` list follows Requirement 1 (criterion 9).

### Requirement 9: Say that a file field is not supported

**User Story:** As a person recording, I want to be told that a file upload cannot be turned into a variable, so that I do not think it was captured.

#### Acceptance Criteria

1. WHEN the user chooses a file in an `input[type=file]` during a recording, THE Recorder_Panel SHALL show a status message within 500 ms that says, in Plain_Language, that file upload is not supported yet and that the field is not recorded as an input.
2. THE Recorder_Panel SHALL keep the status message visible for at least 5 seconds, or until the user dismisses it, and SHALL announce it to screen readers.
3. THE status message SHALL not contain the name, the path, the size or the type of the chosen file.
4. THE Recorder_Panel SHALL send no file name, no path, no size, no type and no file content to the Live_Recorder. It SHALL send only a counter signal that one file field was chosen.
5. WHEN the Live_Recorder receives the counter signal, THE Live_Recorder SHALL add 1 to a session count of unrecorded file fields. It SHALL record no step and no Variable for the choice of a file, and it SHALL not add the field to the answer to `{ type: 'fields' }` (Requirement 6).
6. WHEN the user chooses a file in the same `input[type=file]` more than once, THE Live_Recorder SHALL count that field once.
7. WHILE the session count of unrecorded file fields is 1 or more, THE End_Sheet SHALL show one line with that count and the statement that these fields were not recorded. WHILE the count is 0, THE End_Sheet SHALL show no such line.
8. WHEN a workflow was recorded before this change, THE Workflow_Schema SHALL load it unchanged. THE Workflow_Schema SHALL add no new field to a Workflow_File for this requirement, and the count SHALL not be written to the Workflow_File.
9. IF a call argument holds a file path or file content for a recorded workflow, THEN THE Replay_Runtime SHALL ignore it and SHALL not read or upload any file, and the call SHALL proceed exactly as it did before this change.

### Requirement 10: Store a start page and a login per workflow

**User Story:** As a workflow author, I want each workflow to remember its own start page and login, so that a second action does not change the first.

#### Acceptance Criteria

1. THE Workflow_Schema SHALL accept on a workflow the optional field `startUrl`, an absolute `http` or `https` URL of 1 to 2048 characters, and the optional field `storageState`, either a non-empty string of at most 1024 characters or `null`, where `null` means no saved login.
2. IF a workflow `startUrl` is not an absolute `http` or `https` URL, or a workflow `storageState` is an empty string or a value that is neither a string nor `null`, THEN THE Workflow_Schema SHALL reject the file with an error that names the workflow id and the field, and SHALL load nothing.
3. WHEN a Workflow_File without a workflow-level `startUrl` or `storageState` is loaded, THE Workflow_Schema SHALL load it unchanged and SHALL write it back unchanged, byte for byte apart from the usual formatting of the writer.
4. WHEN the Compiler writes the code of a tool and the workflow has no `startUrl`, THE Compiler SHALL use the `startUrl` of the set as the page where the replay starts, as the recorded start in `rebaseOrigin`, and as the start page in the container.
5. WHEN the Compiler writes the code of a tool and the workflow has a `startUrl`, THE Compiler SHALL use the workflow `startUrl` in the same three places, in `mcp-server.ts`, `replay.ts` and `docker-replay.ts`.
6. WHEN the Compiler writes the code of a tool and the workflow has no `storageState` (the field is absent), THE Compiler SHALL use the `storageState` of the set as the path of the saved login.
7. WHEN the Compiler writes the code of a tool and the workflow has a `storageState` string, THE Compiler SHALL use that string as the path of the saved login in `mcp-server.ts`, `replay.ts` and `docker-replay.ts`.
8. WHEN the Compiler writes the code of a tool and the workflow has `storageState: null`, THE Compiler SHALL write no saved login for that tool, even when the set has a `storageState`, and the replay SHALL start without a saved login and send no cookie taken from a storage state.
9. WHEN no workflow of a set has a `startUrl` or a `storageState`, THE Compiler SHALL write generated code identical to the code it writes today.
10. IF a workflow `startUrl` has an Origin that differs from the Origin of the set `startUrl`, THEN THE Compiler SHALL stop before writing any file, with a message that names the workflow id and the two Origins, and SHALL exit with a non-zero code.
11. IF a workflow has a `startUrl` and the set has no `startUrl` (a terminal target), THEN THE Compiler SHALL stop before writing any file, with a message that names the workflow id and says that a start page applies to a web target only.
12. WHILE the Studio shows the Workflows view of a workflow whose `startUrl` differs from the `startUrl` of the set, THE Studio_UI SHALL show the start page of that workflow as text, with its path and without any query string or fragment.
13. WHILE the Studio shows a workflow without its own `startUrl`, THE Studio_UI SHALL not show a start page line for that workflow.

### Requirement 11: Merge a new recording without changing earlier workflows

**User Story:** As a person who records a second action, I want the first actions to keep working, so that the file grows without breaking.

#### Acceptance Criteria

1. WHEN the Workflow_Merger merges a recording into a base set that holds at least one workflow not replaced by id, THE Workflow_Merger SHALL keep the `targetName`, `startUrl` and `storageState` of the base set (a field absent from the base set stays absent) and SHALL ignore those three fields of the new recording.
2. WHEN the base set holds no workflow, or every workflow of the base set has the id of a workflow in the new recording, THE Workflow_Merger SHALL take `targetName`, `startUrl` and `storageState` from the new recording, as today.
3. IF the Origin of the new recording differs from the Origin of the base set `startUrl` and the base set holds at least one workflow, THEN THE Save_Command SHALL write nothing to the Workflow_File and SHALL fail with a message that names both Origins and contains no path, and THE Save_Command SHALL run this check before any other criterion of this requirement.
4. WHEN the new recording has the same Origin as the base set and a `startUrl` that differs from the base set `startUrl`, THE Save_Command SHALL store that `startUrl` on the new workflow.
5. WHEN the new recording has a `storageState` that differs from the base set `storageState` (including a base set without one), THE Save_Command SHALL store that `storageState` on the new workflow.
6. WHEN the new recording has no `storageState` and the base set has one, THE Save_Command SHALL store `storageState: null` on the new workflow.
7. WHEN the new recording has the same `startUrl` as the base set, THE Save_Command SHALL write no per-workflow `startUrl`, and WHEN it has the same `storageState` as the base set, or neither has one, THE Save_Command SHALL write no per-workflow `storageState`.
8. WHEN a workflow of the new recording replaces a workflow of the base set with the same id, THE Workflow_Merger SHALL replace the whole workflow, including its per-workflow `startUrl` and `storageState`, and SHALL keep the position of the replaced workflow in the list.
9. THE Workflow_Merger SHALL keep, unchanged and in their original order, every workflow of the base set that is not replaced by id, including its per-workflow `startUrl` and `storageState`.
10. THE Workflow_Merger SHALL not modify either input object.
11. WHEN a Workflow_File without per-workflow `startUrl` or `storageState` is merged with a recording that has the same `startUrl` and `storageState`, THE Save_Command SHALL write a file whose old workflows are byte-identical to their serialized form before the merge.
12. FOR ALL pairs of sets that pass criterion 3, THE Workflow_Merger SHALL return a set in which every unreplaced base workflow resolves to the same Start_Page and the same login (`workflow.startUrl ?? set.startUrl`, `workflow.storageState ?? set.storageState`, `null` meaning no login) as before the merge (invariant).

### Requirement 12: Refuse two applications in one file

**User Story:** As a Studio user, I want a clear message when I try to record another application in this folder, so that I do not mix two applications in one file.

#### Acceptance Criteria

1. IF `POST /api/record/start` receives a valid `url` whose Origin differs from the Origin of the set `startUrl` of a Workflow_File that holds at least one workflow, THEN THE Studio_Server SHALL answer 409 with `{ error, field: 'url' }`, SHALL start no recording, and SHALL leave the Workflow_File unchanged. The Origin comparison SHALL use `new URL(url).origin` on both sides, so the default port of a scheme (443 for https, 80 for http) equals the same address written without a port.
2. THE `error` text of criterion 1 SHALL be in Plain_Language, SHALL name the Origin already held by the file, SHALL say that another application needs another folder, and SHALL contain no file path and no secret value.
3. WHEN the `url` has the same Origin as the set `startUrl` of the Workflow_File, THE Studio_Server SHALL accept the request exactly as before this change, including a different path, query or fragment on the same Origin.
4. WHEN the Workflow_File does not exist, holds no workflow, or has a set `startUrl` that is absent or not a valid URL, THE Studio_Server SHALL accept any valid `url` as before this change.
5. WHEN the Workflow_File holds workflows whose own `startUrl` Origins differ from each other (Requirement 10), THE Studio_Server SHALL compare the `url` only with the Origin of the set `startUrl`, and SHALL not refuse or modify the existing file.
6. WHEN the user types or pastes an address on the new action page and its Origin differs from the `startUrl` Origin reported by `GET /api/overview` for a file that holds at least one workflow, THE Studio_UI SHALL show the message of criterion 2 next to the address field within 300 ms of the last keystroke and SHALL disable the button that starts the recording.
7. WHEN the address becomes empty, invalid, or has the same Origin as the file, THE Studio_UI SHALL remove the message and SHALL enable the start button, unless another existing validation disables it.
8. WHEN the message is shown or removed, THE Studio_UI SHALL expose it in a live region with `role="alert"` and SHALL link it to the address field through `aria-describedby`, so that a screen reader announces it.
9. WHEN `daemonize record <url>` is started with a `url` whose Origin differs from the Origin of the set `startUrl` of an existing Workflow_File that holds at least one workflow, THE Save_Command preflight SHALL fail before any browser opens, SHALL print the message of criterion 2, SHALL exit with a non-zero code, and SHALL leave the Workflow_File unchanged.
10. WHEN `daemonize record <url>` is started with the same Origin, with no Workflow_File, or with a Workflow_File that holds no workflow, THE Save_Command preflight SHALL proceed as before this change, and the other CLI commands, flags and default output SHALL stay unchanged.
11. IF the Workflow_File exists and cannot be read or parsed during the check of criterion 1, THEN THE Studio_Server SHALL answer 409 with `{ error, field: 'url' }`, where `error` is the standard "workflow file is unreadable" message from `messages/common.ts`, and SHALL start no recording.
12. IF the Workflow_File cannot be read or parsed during the check of criterion 9, THEN THE Save_Command preflight SHALL fail before any browser opens with the same message and a non-zero exit code.
13. WHILE the Studio runs in sample mode, THE Studio_Server SHALL apply the same check to `POST /api/record/start` and SHALL return the same 409 answer, since the check writes nothing.

### Requirement 13: Rename and describe a workflow from the Studio

**User Story:** As a Studio user, I want to rename an action and write what it does, so that agents read a clear tool description.

#### Acceptance Criteria

1. THE Studio_Server SHALL expose `POST /api/workflows/update` with `remote: 'blocked'`, and the route SHALL accept only the body fields `id`, `label`, `description` and `variables` (Requirement 14). The body field `id` SHALL be required. At least one of `label`, `description` or `variables` SHALL be present.
2. IF the body holds a field other than `id`, `label`, `description` or `variables`, THEN THE Studio_Server SHALL answer 400 with `UNEXPECTED_FIELD` and the field name, and SHALL write nothing.
3. IF `id` is missing or is not a string, THEN THE Studio_Server SHALL answer 400 with `field: 'id'` and SHALL write nothing.
4. IF the body holds only `id`, THEN THE Studio_Server SHALL answer 400 with a plain message saying that nothing was changed, and SHALL write nothing.
5. IF `id` is not the id of a workflow of the file, THEN THE Studio_Server SHALL answer 404 and SHALL write nothing.
6. IF `label` is given and, after trimming leading and trailing whitespace, is shorter than 1 character, longer than 200 characters, or holds a control character (U+0000 to U+001F, U+007F), THEN THE Studio_Server SHALL answer 400 with `field: 'label'` and SHALL write nothing.
7. WHEN `label` is valid, THE Studio_Server SHALL store the trimmed text as the `label` of the workflow.
8. IF `description` is given and is neither the empty string nor a text accepted by `cleanDescription` of `src/suggest/sanitize.ts`, THEN THE Studio_Server SHALL answer 400 with `field: 'description'` and SHALL write nothing.
9. WHEN `description` is the empty string, THE Studio_Server SHALL remove the `description` field from the workflow. WHEN `description` is valid and not empty, THE Studio_Server SHALL store the text returned by `cleanDescription` as the `description` of the workflow.
10. WHEN a field is absent from the body, THE Studio_Server SHALL leave the matching value of the workflow unchanged, and SHALL leave every other workflow, the `startUrl`, the `storageState` and every field of the file that this route does not name byte-equivalent in meaning (same JSON values). A file without the new fields SHALL stay loadable by the Workflow_Schema after the update.
11. WHEN the update is valid, THE Studio_Server SHALL write the Workflow_File through `serializeWorkflowSet`, to a temporary file in the same folder and then rename it over the original.
12. IF the file to write would hold a plain secret (`findPlainSecrets`) or fail the Workflow_Schema, THEN THE Studio_Server SHALL answer 400 without naming any secret value, SHALL keep the original file unchanged, and SHALL leave no temporary file in the folder.
13. IF a recording or a compile is running, THEN THE Studio_Server SHALL answer 409 with a plain message and SHALL write nothing.
14. IF the Workflow_File cannot be read, THEN THE Studio_Server SHALL answer 409 with the standard "workflow file is unreadable" message from `messages/common.ts` and SHALL write nothing.
15. WHEN the write succeeds, THE Studio_Server SHALL answer 200 with the updated workflow view, passed through `redactForStudio`, and a field `recompile` whose value is `started`, `not-needed` or `busy`.
16. WHEN the write succeeds and the output folder holds a compiled server, THE Studio_Server SHALL start a compile with the Compile_Options of the last Studio compile in the current Studio session (Requirement 21), or `{ http: 'off', healSupport: false }` when none ran, and SHALL answer `recompile: 'started'`.
17. WHEN the write succeeds and the output folder holds no compiled server, THE Studio_Server SHALL start no compile and SHALL answer `recompile: 'not-needed'`.
18. IF the write succeeds and a compile cannot be started because another compile began after the checks of criterion 13, THEN THE Studio_Server SHALL keep the written file and SHALL answer `recompile: 'busy'`.
19. WHILE the Studio runs in sample mode, THE Studio_Server SHALL answer 409 with `SAMPLE_MODE` and SHALL write nothing.

### Requirement 14: Change the variables of a workflow from the Studio

**User Story:** As a Studio user, I want to rename a variable, change its type and mark it optional, so that I fix a recording without editing the file.

#### Acceptance Criteria

1. THE body field `variables` of `POST /api/workflows/update` SHALL be an array of 1 to 100 objects. Each object has a `name` (a string holding the current name of a Variable of the workflow) and any of `newName` (string), `type` (string), `optional` (boolean), `whenOmitted` (string) and `description` (string). Every other key, and a value of another JSON type, SHALL make the Studio_Server answer 400 with `field: 'variables'` and the index of the object, and SHALL write nothing.
2. IF a `name` is not a Variable of the workflow, or two objects of the array hold the same `name`, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and the index of the object, and SHALL write nothing.
3. IF `newName` does not match `^[A-Za-z_][A-Za-z0-9_]*$`, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and the index of the object, and SHALL write nothing.
4. IF `newName` is longer than 60 characters, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and the index of the object, and SHALL write nothing.
5. IF `newName` equals the current name of another Variable of the workflow, or equals the `newName` of another object of the array, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and the index of the object, and SHALL write nothing. The comparison uses the names the workflow held before the update, so a swap of two names in one request is refused.
6. IF `newName` equals the current `name` of its own object, THEN THE Studio_Server SHALL treat the rename as no change and SHALL accept the object.
7. IF `type` is not `string`, `number` or `boolean`, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and SHALL write nothing.
8. IF `type` is not `string` and the Variable holds `enum`, `pattern` or `maxLength`, or IF `type` is not `boolean` and the Variable belongs to a Check_Step, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and a plain message naming the Variable, and SHALL write nothing.
9. IF `whenOmitted` is not `useRecorded` or `skip`, or IF `whenOmitted` is given and the Variable would not have `optional: true` after the update, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'` and SHALL write nothing.
10. WHEN an update sets `optional` to `false` and gives no `whenOmitted`, THE Studio_Server SHALL remove `whenOmitted` from the Variable.
11. WHEN an update sets `optional` to `true` and gives no `whenOmitted`, THE Studio_Server SHALL keep the `whenOmitted` the Variable already holds, or SHALL add none when it holds none.
12. WHEN `description` is given for a Variable, THE Studio_Server SHALL accept the empty string (which removes the description) or a text accepted by `cleanDescription` of `src/suggest/sanitize.ts`, and SHALL answer 400 with `field: 'variables'` otherwise.
13. WHEN a Variable is renamed, THE Studio_Server SHALL change in one write: `variable` of the steps, `rowBinding.variable`, the `bindings` of the recorded recipes, the `{{name}}` placeholders of recipe `url`, `query` and `headers`, the `{"$var":name}` leaves of recipe bodies, and the key of every observed payload. Afterwards the old name SHALL appear in none of these places.
14. WHEN a Variable changes type, THE Studio_Server SHALL coerce every value of its observed payloads to the new type with these rules: `string` to `number` when the trimmed text is not empty and `Number(text)` is finite; `string` to `boolean` when the text is exactly `true` or `false`; `number` or `boolean` to `string` as the decimal or `true`/`false` text; `number` to `boolean` and `boolean` to `number` refused. IF a value cannot be coerced, THEN THE Studio_Server SHALL answer 400 with `field: 'variables'`, the Variable name and a plain message, and SHALL write nothing. The `value` of the steps stays as recorded.
15. IF an update makes a Skip_List Variable bound in the URL path of a recipe, THEN THE Studio_Server SHALL answer 400 with the same message as Requirement 3.7 and SHALL write nothing.
16. FOR ALL valid updates followed by the inverse update, THE Workflow_File SHALL return to its original content except for `description` fields set by the user (round-trip). The comparison uses canonical forms: an explicit `optional: false` and an explicit `type: 'string'` count as absent, because an update removes `optional` when it sets it to `false` and sends only `string`, `number` or `boolean` for `type`.
17. WHEN an update changes a Variable, THE Studio_Server SHALL leave `inputSchema` and `outputSchema` of the file to the next compile, which infers them again.
18. IF any object of `variables` is invalid, THEN THE Studio_Server SHALL apply none of the objects, SHALL leave the Workflow_File byte-for-byte unchanged, and SHALL name no value typed by the user other than the Variable name in its answer.
19. WHEN a request holds no `variables` field, or `variables` holds objects that change nothing, THE Studio_Server SHALL leave the `variables` of the workflow and every field of the file that the request does not name unchanged, and SHALL add no `optional`, `whenOmitted` or `description` to a Variable the request does not name.
20. WHILE a Workflow_File recorded before this change (no `whenOmitted` on any Variable) is updated, THE Studio_Server SHALL write only the fields the update changes and SHALL keep every other field and its value as loaded.

### Requirement 15: Delete a workflow from the Studio

**User Story:** As a Studio user, I want to delete an action I no longer want, so that the tool list stays clean.

#### Acceptance Criteria

1. THE Studio_Server SHALL expose `POST /api/workflows/delete` with `remote: 'blocked'`, and the route SHALL accept only the body field `id`, a non-empty string of at most 200 characters.
2. IF the body holds a field other than `id`, or `id` is missing, is not a string, or is empty, THEN THE Studio_Server SHALL answer 400 with the field name, SHALL write nothing, and SHALL leave the Workflow_File and `<file>.assets/` unchanged.
3. IF `id` is not the id of a workflow of the Workflow_File, THEN THE Studio_Server SHALL answer 404, SHALL write nothing, and SHALL leave `<file>.assets/` unchanged.
4. IF a recording or a compile is running, THEN THE Studio_Server SHALL answer 409 with a message that names the running operation, SHALL write nothing, and SHALL leave `<file>.assets/` unchanged.
5. WHEN the deletion is valid, THE Studio_Server SHALL write the Workflow_File with the atomic write of Requirement 13.11, so that the file holds either the original content or the content without the workflow, and SHALL leave every other workflow and every other top-level field of the file unchanged, including fields it does not know.
6. IF the atomic write fails, THEN THE Studio_Server SHALL answer 500 with an error message, SHALL keep the original Workflow_File, SHALL delete no thumbnail, and SHALL start no compile.
7. WHEN the Workflow_File write succeeds, THE Studio_Server SHALL delete each file of `<file>.assets/` that no remaining workflow references, and SHALL keep each file that a remaining workflow references through `visual.thumbnailPath`.
8. WHEN the Workflow_File write succeeds, at least one workflow remains and the output folder holds a compiled server, THE Studio_Server SHALL start one compile with the Compile_Options of the Compile_Runner and SHALL answer `recompile: 'started'`.
9. WHEN the Workflow_File write succeeds, at least one workflow remains and the output folder holds no compiled server, THE Studio_Server SHALL start no compile and SHALL answer `recompile: 'not-needed'`.
10. WHEN the last workflow is deleted, THE Studio_Server SHALL start no compile, SHALL keep the Workflow_File with `workflows` equal to an empty list, SHALL keep the file loadable by the Workflow_Schema, and SHALL answer `recompile: 'not-needed'`.
11. WHEN the deletion succeeds, THE Studio_Server SHALL answer 200 with `{ ok: true, remaining, recompile }`, where `remaining` is the number of workflows left in the file (0 or more) and `recompile` is `'started'` or `'not-needed'`.
12. IF the thumbnail cleanup fails for at least one file, THEN THE Studio_Server SHALL keep the written Workflow_File, SHALL still answer 200 with `{ ok: true, remaining, recompile }`, and SHALL add `cleanup: 'partial'`.
13. WHILE the Studio runs in sample mode, THE Studio_Server SHALL answer 409 with the `SAMPLE_MODE` message, SHALL write nothing, and SHALL delete no file.
14. WHEN the Studio_Server receives a request on `/api/workflows/delete` with a method other than `GET` or `POST`, THE Workflow_Editor SHALL answer 405 with an `Allow` header, and SHALL write nothing.
15. WHEN the Studio_Server receives a `GET` request on `/api/workflows/delete`, THE Workflow_Editor SHALL answer 405 with `Allow: POST`, and SHALL write nothing.

### Requirement 16: Edit and delete controls in the Workflows view

**User Story:** As a Studio user, I want the edit and delete controls where I read the action, with a confirmation I can use with a keyboard.

#### Acceptance Criteria

1. WHEN the Workflows view shows the detail of a workflow and the Studio is not in sample mode or static demo, THE Studio_UI SHALL show three controls in that detail: "Rename and describe", "Edit inputs" and "Delete this action". Each control SHALL be a `button` element with a visible text label and SHALL be reachable with the Tab key.
2. WHEN the user opens "Rename and describe", THE Studio_UI SHALL show a "Name" field prefilled with the current `label` (maximum 200 characters) and a "Description" field prefilled with the current `description` (maximum length accepted by `cleanDescription`), each with a visible label, and SHALL send only `id`, `label` and `description` to `POST /api/workflows/update` when the user confirms.
3. WHEN the user opens "Edit inputs", THE Studio_UI SHALL list one row per Variable of the workflow, and each row SHALL hold a "Name" text field (maximum 60 characters), a "Type" choice (text, number, true or false), an "Optional" checkbox and, only while "Optional" is checked, an "If left empty" choice ("Skip this field" or "Use the recorded value"). Each field SHALL have a visible label.
4. WHEN the user confirms "Edit inputs", THE Studio_UI SHALL send to `POST /api/workflows/update` only the Variables whose name, type, optional or whenOmitted value changed, each as `{ name, newName, type, optional, whenOmitted }` with `name` equal to the current name.
5. WHEN the user clears "Optional" in "Edit inputs", THE Studio_UI SHALL hide "If left empty" and SHALL send no `whenOmitted` for that Variable.
6. IF `POST /api/workflows/update` answers 400, 404 or 409, THEN THE Studio_UI SHALL show the returned message in an element with `role=alert` next to the control that was submitted, SHALL keep every value the user entered, and SHALL leave the workflow detail unchanged.
7. WHEN `POST /api/workflows/update` answers 200, THE Studio_UI SHALL close the form, SHALL show the updated workflow, SHALL announce the result with `announce`, and SHALL show the recompile state when `recompile` is `started`.
8. WHEN the user presses "Delete this action", THE Studio_UI SHALL open the Studio dialog with the name of the action, a sentence stating that the action cannot be recovered from the Studio, a "Delete" button and a "Cancel" button, and SHALL send no request until the user presses "Delete".
9. WHEN the dialog opens, THE Studio_UI SHALL move focus to "Cancel" and SHALL keep Tab and Shift+Tab focus inside the dialog.
10. WHEN the user presses Escape or "Cancel" in the dialog, THE Studio_UI SHALL close the dialog without sending a request and SHALL return focus to "Delete this action".
11. WHEN the user presses "Delete", THE Studio_UI SHALL send `{ id }` only to `POST /api/workflows/delete`, SHALL disable "Delete" and "Cancel" until the server answers, and SHALL send no second request while the first is pending.
12. WHEN `POST /api/workflows/delete` answers 200, THE Studio_UI SHALL close the dialog, SHALL announce the result with `announce`, SHALL open the Workflows list without the deleted action, and SHALL show the recompile state when `recompile` is `started`.
13. IF `POST /api/workflows/delete` answers 404 or 409, THEN THE Studio_UI SHALL keep the dialog open, SHALL show the returned message in an element with `role=alert` inside the dialog, and SHALL re-enable "Delete" and "Cancel".
14. IF `POST /api/workflows/update` or `POST /api/workflows/delete` fails with no server answer or answers 5xx, THEN THE Studio_UI SHALL show a plain message that the change was not saved, in an element with `role=alert`, and SHALL keep the form values or the open dialog.
15. WHEN `GET /api/workflows` answers, THE Studio_Server SHALL include `optional` and, when the Variable is optional, `whenOmitted` for each Variable, and SHALL return `whenOmitted: 'useRecorded'` for an optional Variable of an old Workflow_File that has none.
16. THE Studio_UI text of the three controls, the forms and the dialog SHALL pass the Plain_Language rule.

### Requirement 17: Delete an action from the Kiro sidebar

**User Story:** As a Kiro user, I want to delete an action from the sidebar, so that I do not open the browser for a simple removal.

#### Acceptance Criteria

1. THE Kiro_Extension SHALL contribute the command `daemonize.deleteAction`, titled "Delete this action", with an inline entry in `view/item/context` for rows of the view `daemonize.actions` whose `contextValue` is `action`, and with no entry for any other row.
2. WHEN the command `daemonize.deleteAction` runs with a row whose id matches `^action:.+$`, THE Kiro_Extension SHALL show a modal confirmation that names the action by its label, states that the action cannot be recovered from the Studio, and offers exactly the buttons "Delete" and "Cancel".
3. WHEN the user chooses "Cancel", closes the confirmation, or presses Escape, THE Kiro_Extension SHALL send no request and SHALL leave the Actions view unchanged.
4. WHEN the user chooses "Delete", THE Kiro_Extension SHALL send one `POST /api/workflows/delete` with a body holding only `id`, set to the part of the row id after `action:`, through the existing Studio client and token, and SHALL not send the token in the body, the URL or any message.
5. WHILE a delete request is pending, THE Kiro_Extension SHALL ignore any further `daemonize.deleteAction` for the same workflow id.
6. WHEN the Studio answers 200 with `{ ok: true }`, THE Kiro_Extension SHALL refresh the Actions view and SHALL show an information notification that names the action, contains no token and no path, and, when the answer holds `recompile: 'started'`, says that the tools are being updated.
7. IF the Studio answers 404, THEN THE Kiro_Extension SHALL refresh the Actions view and SHALL show a notification saying that the action no longer exists.
8. IF the Studio answers 409 (a recording or compile is running, or sample mode), THEN THE Kiro_Extension SHALL keep the Actions view as it is and SHALL show the message of the answer after redaction of the token.
9. IF the Studio answers any other error status, does not answer within 10 seconds, or cannot be reached, THEN THE Kiro_Extension SHALL show an error notification with a plain message that contains no token, and SHALL leave the Actions view unchanged.
10. WHEN the command runs without a row, with a row id that does not match `^action:.+$`, or while the Studio is not running, THE Kiro_Extension SHALL send no request and SHALL show no confirmation.
11. THE Kiro_Extension SHALL offer no rename and no variable editing on the sidebar row.
12. THE command title, the confirmation, the button labels and every notification of this requirement SHALL pass the Plain_Language rule and SHALL contain no path and no Studio token.

### Requirement 18: "Test in Studio" opens the clicked action

**User Story:** As a Kiro user, I want "Test in Studio" on an action to open that action, so that I do not search for it again.

#### Acceptance Criteria

1. WHEN `buildBrowserUrl` receives a route and a target of kind tool with a name matching `^[A-Za-z0-9_-]{1,64}$`, THE `buildBrowserUrl` function SHALL return a URL whose fragment is `#/playground?tool=<encodeURIComponent(toolName)>`.
2. WHEN `buildBrowserUrl` receives a route and a target of kind workflow with an id, THE `buildBrowserUrl` function SHALL return a URL whose fragment is `#/workflows/<encodeURIComponent(id)>`.
3. WHEN `buildBrowserUrl` receives a target, THE `buildBrowserUrl` function SHALL put `token` in the query string only, SHALL leave it out of the fragment, and SHALL leave the origin and the query parameters other than `token` as they are without a target.
4. IF a tool name does not match `^[A-Za-z0-9_-]{1,64}$`, THEN THE `buildBrowserUrl` function SHALL ignore the target and return the same URL as when no target is given for that route, with no error raised.
5. THE `StudioRoute` type SHALL include `workflows` in addition to its existing members, and calls of `buildBrowserUrl` without a target SHALL return the same URL as before this change.
6. WHEN `daemonize.testInStudio` runs with a row whose id is `action:<id>` and the workflow `<id>` in the list read by criterion 10 has a non-empty `toolName` matching `^[A-Za-z0-9_-]{1,64}$`, THE Kiro_Extension SHALL open the Studio at `#/playground?tool=<toolName>`.
7. WHEN `daemonize.testInStudio` runs with a row `action:<id>` and the workflow `<id>` has no `toolName` (a workflow file recorded before this change, or not compiled yet), THE Kiro_Extension SHALL open the Studio at `#/workflows/<id>`.
8. WHEN `daemonize.testInStudio` runs with a row `action:<id>` and no workflow in the list has the id `<id>`, THE Kiro_Extension SHALL open the Studio at `#/playground` without a tool.
9. WHEN `daemonize.testInStudio` runs without a row, or with a row whose id does not start with `action:`, THE Kiro_Extension SHALL open the Studio at `#/playground` without a tool and without calling `GET /api/workflows`.
10. WHEN `daemonize.testInStudio` runs with a row `action:<id>`, THE Kiro_Extension SHALL call `GET /api/workflows` once during that click, SHALL take the workflow by exact match of `<id>` with the workflow id, and SHALL not use the label of the row.
11. IF `GET /api/workflows` fails, does not answer within 5 seconds, or answers a body that is not a list of workflows, THEN THE Kiro_Extension SHALL open the Studio at `#/playground` without a tool and SHALL show no error notification.
12. THE Kiro_Extension SHALL not write the opened address to any log or output channel, SHALL not copy it to the clipboard, and SHALL not show it in a notification or message.
13. FOR ALL tool names matching `^[A-Za-z0-9_-]{1,64}$`, THE route returned by `parseRoute` of the Studio for the fragment built by `buildBrowserUrl` SHALL be `playground` with the same tool name (round-trip).
14. THE Kiro_Extension SHALL read the workflow fields it needs (`id`, `toolName`) without requiring any new field in the Workflow_File, and a Workflow_File recorded before this change SHALL give the same result as a new one for criteria 6 to 8.

### Requirement 19: Choose the Kiro scope on the End_Sheet

**User Story:** As a person finishing a recording, I want to choose "All my projects" or "Only this project" before the tool is added to Kiro.

#### Acceptance Criteria

1. WHERE `power.info` reported `kiroHomeExists: true` when the recording started, THE End_Sheet SHALL show, next to "Save and add to Kiro", a group of two radio options "All my projects" (Install_Scope `global`) and "Only this project" (Install_Scope `project`), with "All my projects" selected when the End_Sheet opens.
2. WHERE `power.info` reported `kiroHomeExists: false` when the recording started, THE End_Sheet SHALL show the static text "Only this project" and SHALL show no radio group.
3. WHEN the user presses "Save and add to Kiro", THE Recorder_Panel SHALL call `__daemonizeFinish` with `{ intent: 'kiro', scope }`, where `scope` is `global` or `project` and equals the option selected at that moment, or `project` when criterion 2 applies.
4. WHEN the user presses "Finish and save" or the button for testing in the Studio, THE Recorder_Panel SHALL call `__daemonizeFinish` with `{ intent }` only (`save` or `test`) and SHALL send no `scope` field.
5. IF the Live_Recorder receives `intent: 'save'` or `intent: 'test'` together with a `scope`, THEN THE Live_Recorder SHALL discard the `scope`.
6. IF the Live_Recorder receives `intent: 'kiro'` and a `scope` that is not the string `global` and not the string `project` (including a missing value, `null`, a number or any other string), THEN THE Live_Recorder SHALL discard the value, SHALL finish the recording without error, and THE Recording_Manager SHALL apply criterion 8.
7. WHEN the Live_Recorder has received `intent: 'kiro'` with `scope: 'global'` or `scope: 'project'`, THE Live_Recorder SHALL expose that value as `finishScope` to the Recording_Manager.
8. WHEN the Recording_Manager adds the tool to Kiro and no valid `finishScope` exists, THE Recording_Manager SHALL use `global` if `power.info` reports `kiroHomeExists: true` and `project` otherwise, as it does today.
9. IF the chosen scope is `global` and `power.info`, called when the tool is added, reports `kiroHomeExists: false`, THEN THE Recording_Manager SHALL use `project`.
10. WHEN the Recording_Manager adds the tool to Kiro, THE Recording_Manager SHALL pass the same scope value to both `power.preview` and `power.install`.
11. WHEN the install succeeds, THE answer of `GET /api/record/status` SHALL report the scope used, `global` or `project`, in `kiro.scope`.
12. IF the install fails, THEN THE answer of `GET /api/record/status` SHALL report `kiro.added: false` and SHALL leave `kiro.scope` out.
13. IF `power.info` fails when the recording starts, THEN THE Recording_Manager SHALL treat `kiroHomeExists` as `false`, so that criterion 2 applies and the End_Sheet offers only `project`.
14. THE End_Sheet SHALL expose the radio group with the role `radiogroup` and an accessible name (for example "Where to add the tool"), and SHALL let the user reach every option with the Tab key, move between options with the arrow keys, and select one with the Space key, with a visible focus indicator on the focused option.
15. THE existing `daemonize.workflows.json` files and the CLI commands SHALL load and run unchanged, because the scope is held in memory by the Recording_Manager and is written to no Workflow_File.

### Requirement 20: Warn when credentials are still missing

**User Story:** As a person who added a tool to Kiro, I want to be told which credentials are still missing, so that the tool does not fail on its first use.

#### Acceptance Criteria

1. WHEN `power.install` succeeds in the Recording_Manager, THE Recording_Manager SHALL set `kiro.missingSecrets` to the Missing_Secrets of the `install` answer, sorted in ascending code-point order, without duplicates, with at most 100 entries, and SHALL set `kiro.requiredSecrets` to the Secret_Names the tool needs, sorted and deduplicated in the same way.
2. IF the `install` answer holds no list of Missing_Secrets or no list of required Secret_Names, THEN THE Recording_Manager SHALL set the corresponding array to `[]`.
3. IF an entry of either list does not match `^[A-Z][A-Z0-9_]*$`, THEN THE Recording_Manager SHALL leave that entry out of the stored array.
4. WHEN `kiro.added` is `false`, THE Recording_Manager SHALL leave `kiro.missingSecrets` and `kiro.requiredSecrets` out of the answer of `GET /api/record/status`.
5. WHEN `kiro.added` is `true`, THE answer of `GET /api/record/status` SHALL contain `kiro.missingSecrets` and `kiro.requiredSecrets` as arrays of strings, each string being a Secret_Name that matches `^[A-Z][A-Z0-9_]*$`, and SHALL contain no secret value in either array.
6. WHILE `kiro.added` is `true` and `kiro.missingSecrets` is not empty, THE Studio_UI SHALL show a block with `role="alert"` placed before the Connect block, listing every Missing_Secret by name and stating that the user must press "Add your credentials" before using the tool in Kiro.
7. WHILE the block of criterion 6 is shown, THE Studio_UI SHALL include in it one link that opens the Credentials view and can be reached and activated with the keyboard.
8. WHILE `kiro.added` is `true` and `kiro.missingSecrets` is empty, THE Studio_UI SHALL show the existing success message and no credentials block.
9. IF the install fails (`kiro.added` is `false`), THEN THE Studio_UI SHALL show the existing failure message, SHALL show no credentials block, and SHALL keep the recorded workflow saved.
10. WHEN `GET /api/record/status` answers for a Workflow_File or a status written before this requirement, THE Studio_UI SHALL treat an absent `kiro.missingSecrets` as `[]` and SHALL show no credentials block, and no change to `daemonize.workflows.json` SHALL be required.
11. THE text of the block SHALL pass the Plain_Language rule and SHALL contain neither the Studio token nor any secret value.
12. FOR ALL `install` answers, THE answer of `GET /api/record/status` SHALL contain no string equal to a known secret value after `redactForStudio` is applied.

### Requirement 21: Choose HTTP and Heal options when recompiling

**User Story:** As a Studio user, I want to switch the HTTP and Heal options before I recompile, so that I do not use the command line.

#### Acceptance Criteria

1. WHEN a request reaches `POST /api/compile`, THE Studio_Server SHALL accept a JSON body that is empty or holds only the optional fields `http` (the string `'off'` or `'auto'`) and `healSupport` (the boolean `true` or `false`).
2. IF the body holds a field other than `http` or `healSupport`, THEN THE Studio_Server SHALL answer 400 with code `UNEXPECTED_FIELD` and the name of the first unexpected field, SHALL start no compile, and SHALL leave the stored Compile_Options unchanged.
3. IF `http` is present and is not `'off'` or `'auto'`, or `healSupport` is present and is not a boolean, THEN THE Studio_Server SHALL answer 400 with the name of the invalid field, SHALL start no compile, and SHALL leave the stored Compile_Options unchanged.
4. WHEN the body is empty or omits one of the two fields, THE Compile_Runner SHALL use `'off'` for a missing `http` and `false` for a missing `healSupport`.
5. WHEN a compile starts, THE Compile_Runner SHALL pass the options to `compile` as `http` and `healSupport`.
6. WHEN a compile started by a recording or by the Workflow_Editor runs, THE Compile_Runner SHALL use the Compile_Options of the last accepted `POST /api/compile` of this Studio process, and `{ http: 'off', healSupport: false }` when there was none.
7. THE Compile_Runner SHALL keep the Compile_Options in memory only, SHALL NOT write them to `daemonize.workflows.json` or to any other file, and SHALL reset them to `{ http: 'off', healSupport: false }` when the Studio process restarts.
8. THE Studio_UI SHALL show, before the "Recompile" button, an "Advanced options" group with a checkbox "Run recorded requests directly (faster, no page)" and a checkbox "Repair steps with a vision model when a page changes", both unchecked when the Studio page loads and no compiled output is shown.
9. WHILE the checkbox "Repair steps" is checked, THE Studio_UI SHALL show the sentence that the repair needs a model to be set up when the tool runs, and that without one the tool stops with "heal unavailable" on the step that needs repair.
10. WHILE the checkbox "Run recorded requests directly" is checked, THE Studio_UI SHALL show the sentence that write requests are sent as recorded and are not retried on the page.
11. WHEN the Studio loads the overview of a compiled output, THE Studio_UI SHALL set the checkbox "Run recorded requests directly" checked if and only if `modes.http` of the target is `'auto'`, and SHALL set the checkbox "Repair steps" checked if and only if `modes.healSupport` of the target is `true`.
12. WHILE the target is a terminal program, THE Studio_UI SHALL show the two checkboxes disabled and unchecked, and SHALL show the sentence that they apply to web actions.
13. WHEN a compile ends in `done`, THE `overview.js` view SHALL refresh the flags "HTTP" and "Heal" within 2 seconds, each showing the value of `modes.http` and `modes.healSupport` of the new output.
14. WHILE the Studio runs as the static demo or in sample mode, THE Studio_UI SHALL not render the "Advanced options" group.
15. WHEN a compile request carries no body, a body that was written by an earlier Studio version, or an existing `daemonize.workflows.json` that holds no option fields, THE Studio_Server SHALL accept it and SHALL compile with the options of criterion 4 or 6, without changing the content of `daemonize.workflows.json`.
16. FOR ALL bodies, THE Studio_Server SHALL either start a compile with exactly the validated options or answer a 4xx status and start none.

### Requirement 22: Keep the Connect block readable after "Save and add to Kiro"

**User Story:** As a person finishing a recording, I want to see the whole Connect block, including "Remove from Kiro", so that I can read the result.

#### Acceptance Criteria

1. WHEN the record status view reaches the state `done` with `intent: 'kiro'`, THE Studio_UI SHALL call `scrollIntoView` once, on the `#connect-card` element, with `{ block: 'start' }`, and SHALL NOT call it with `block: 'center'`.
2. IF the Kiro result message (`#kiro-result`) is shown, THEN THE Studio_UI SHALL call `scrollIntoView` with `{ block: 'start' }` on the `outcome` container that holds `#kiro-result`, the "Test it" and "Add credentials" buttons and `#connect-card`, instead of scrolling to `#connect-card`, so that the result message is visible at the top of the window.
3. THE scroll target SHALL carry a `scroll-margin-top` equal to or greater than the rendered height in pixels of `.app-header`, so that the header does not cover the first line of the target.
4. WHILE the record status view is shown, THE Studio_UI SHALL leave bottom padding after the `outcome` container, so that the page can scroll far enough that the bottom edge of `#connect-card`, including the "Remove from Kiro" control, sits at least 16 px above the bottom edge of the window.
5. WHEN the target is taller than the window height, THE Studio_UI SHALL leave the top edge of the target aligned with the top edge of the window below the header, and SHALL NOT scroll further.
6. WHERE the user prefers reduced motion (`prefers-reduced-motion: reduce`), THE Studio_UI SHALL call `scrollIntoView` with `behavior: 'auto'`. IF the user has no such preference, THEN THE Studio_UI SHALL use `behavior: 'smooth'`.
7. WHEN the state is `done` with an `intent` other than `kiro`, THE Studio_UI SHALL NOT call `scrollIntoView`, and the `intent: 'test'` behavior (click on `#test-it`) SHALL stay unchanged.
8. THE new CSS rules for this requirement SHALL hold no literal colour outside `:root` and SHALL change no text colour, so the 4.5:1 contrast test (`tests/unit/studio-ui-contrast.test.ts`) keeps passing.
9. THE change SHALL alter only Studio_UI files. It SHALL NOT change `daemonize.workflows.json` files, the compiled output, or any Studio route or answer.

### Requirement 23: Replace the Studio logo

**User Story:** As a Studio user, I want a logo that looks related to the Kiro extension and not like the Kiro ghost.

#### Acceptance Criteria

1. THE `src/studio/ui/favicon.svg` file SHALL be valid SVG that contains exactly one `<path>` whose `d` attribute equals the shield outline path of `kiro-extension/media/icon.svg`, and exactly one further `<path>` or `<polyline>` that draws the check mark inside the shield bounds.
2. THE `src/studio/ui/favicon.svg` file SHALL contain no `<ellipse>` or `<circle>` element, no path that reproduces the ghost outline of the previous logo (the path starting `M7 35 V19`), and no `id` containing `ghost`.
3. THE inline logo in `src/studio/ui/index.html` SHALL be one `<svg>` element with class `logo`, `aria-hidden="true"` and `focusable="false"`, that draws the same shield path and check mark as the favicon.
4. THE inline logo SHALL set every `fill` and `stroke` through `var(--…)` custom properties defined in `:root` of `src/studio/ui/app.css`, and SHALL contain no literal colour (hex, `rgb()`, `hsl()` or named colour) in an attribute or `style`.
5. THE favicon SHALL draw the shield as an outline (`fill="none"`, stroke `#9147ff`), as `kiro-extension/media/icon.svg` does, SHALL use the stroke `#c59eff` for the check mark, and SHALL use the surface `#19161d` as the background, which are the values named in `docs/design-tokens.md`.
6. WHEN the header is rendered on the dark theme and on the light theme, THE logo SHALL keep a contrast ratio of at least 3:1 between each of its two marks (the shield outline and the check mark) and the backdrop behind that mark (the surface of the favicon, or the header behind the inline logo). The contrast is measured per mark against its backdrop, not between the shield and the check mark.
7. THE `docs/design-tokens.md` file SHALL replace the line "The Studio logo (a ghost) looks close to the Kiro one: decide whether to redraw it." with a line stating that the Studio logo is an original shield with a check mark, and SHALL list `src/studio/ui/favicon.svg` and the inline logo among the uses of the extension icon source `kiro-extension/media/icon.svg`.
8. THE `src/studio/ui/index.html` file SHALL contain no `linearGradient` with id `ghost-body`, no `<ellipse>` element, and no reference `url(#ghost-body)`.
9. THE brand text "Daemonize Studio" in the header of `src/studio/ui/index.html` SHALL stay byte-identical to its text before this change.
10. THE logo change SHALL leave the format and content of `daemonize.workflows.json` files and the compiled output unchanged.

### Requirement 24: Tests and verification

**User Story:** As a maintainer, I want each new behavior covered by tests and the whole suite green, so that the changes can be shipped one feature at a time.

#### Acceptance Criteria

1. THE repository SHALL hold at least one unit test, each with a distinct test name, for every behavior in this list. A behavior is covered only when a test asserts both its success path and its refusal or error path where one exists.
   - Optional Variable replay with `useRecorded` and `skip`, in each of: page step, row binding, terminal step, HTTP query, HTTP body, HTTP header. For the HTTP path, the test also covers the refusal of a Skip on a path segment.
   - The schema rules of Requirement 1.
   - The Skip_List embedded in generated code.
   - Checkbox and radio capture and replay.
   - The file notice.
   - `createOfferModel`.
   - The Live_Recorder requests and edits.
   - The Workflow_Merger and the Save_Command with two or more Start_Pages.
   - The origin refusal of the Studio and the origin refusal of `daemonize record`.
   - `POST /api/workflows/update` and `POST /api/workflows/delete`, each with these cases: valid request, invalid request, unknown workflow (404), sample mode (409), refusal of a secret value, and refusal of a method other than `POST`.
   - The compile body validation of Compile_Options.
   - The scope choice (Install_Scope) and the Missing_Secret fields.
   - The record status DOM: the scroll call and the alert.
   - `buildBrowserUrl` and `daemonize.testInStudio`.
   - The logo markup.
2. THE repository SHALL hold property tests, each run with at least 100 generated cases, for these properties:
   - Round-trip of the Variable fields, including `optional` and `whenOmitted` (Requirement 1.5).
   - The invariant of Requirement 11.12.
   - The idempotence of Requirement 7.12.
   - The rename round-trip of Requirement 14.16.
   - The URL round-trip of Requirement 18.13.
   - The absence of unreplaced placeholders and of secret values in a built request (Requirement 3.9).
3. THE repository SHALL hold a regression test that loads a committed `daemonize.workflows.json` fixture recorded before this change. The fixture SHALL contain no `whenOmitted`, no `check` step and no per-workflow `startUrl`. The test SHALL compile it and replay it, then compare the result with a snapshot generated by the previous version and committed with the fixture. The comparison SHALL pass only if the loaded set, the generated tool names and input schemas, and the replayed steps are identical, except for differences that a requirement of this spec names.
4. WHEN the verification runs at the repository root, THE commands `npm run build`, `npx tsc --noEmit`, `npm run check:secrets` and `npm run studio:build` SHALL each exit with code 0.
5. WHEN the verification runs in `kiro-extension/`, THE commands `npm run typecheck`, `npm run build` and `npm run package` SHALL each exit with code 0. WHEN `npm run package` finishes, THE file `daemonize-kiro-0.1.0.vsix` SHALL exist and its modification time SHALL be later than the start of that command.
6. WHEN the full test suite runs, THE suite SHALL finish with 0 failed tests; tests may be skipped only when gated by Docker (`DAEMONIZE_DOCKER_TESTS`) or by the platform, as today.
7. THE changes SHALL be delivered as one commit per feature group: Requirements 1 to 4, 5 and 6, 7 to 9, 10 to 12, 13 to 17, 18, 19 and 20, 21, 22 and 23, with the tests of a feature in the same commit as the feature. THE last commit SHALL satisfy criteria 4, 5 and 6.
8. THE file `docs/studio.md` SHALL describe each new Studio route (`POST /api/workflows/update`, `POST /api/workflows/delete` and every other route added by this spec) and each Advanced option of Compile_Options. THE file `docs/replay-model.md` SHALL describe `whenOmitted` with its two values and the default, the per-workflow start page, and the `check` step.
