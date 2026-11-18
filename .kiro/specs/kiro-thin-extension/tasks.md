# Implementation Plan: kiro-thin-extension

## Overview

The implementation language is TypeScript for `src/`, the extension and the tests, and plain ES modules for `src/studio/ui/js` (as the design states). Work follows the design's "Implementation groups" in this order.

- **Group P0** (Part A: dialog and credentials message fixes) runs first and is serial. Its DOM and unit tests are required, not optional, because the two fixes must be re-tested before Part B starts. A checkpoint follows.
- **Group G0** (CLI `--machine`, shared extension types, strings and ports, vitest `extension` project, `.gitignore`, secret-scan scope) is serial and runs after the P0 checkpoint. A checkpoint follows.
- **Groups G1, G2, G3, G4** then run in parallel. Each group edits only the files listed as owned at the top of the group, and the lists are disjoint. A group that needs a change in a file it does not own writes the request in its hand-off note for the checkpoint. No group after G0 edits `types.ts`, `strings.ts`, `ports.ts`, `vitest.config.ts` or `src/cli/**`.
- **Checkpoint C** runs last: the four Root_Checks, the extension build and package with exact results. The work stops after the final report. Step 3 (persistent profile, Chrome extension, semantic firewall) is not started.
- Property tests use `fast-check` with at least 100 runs and a first-line tag `// Feature: kiro-thin-extension, Property N: <title>`. Each property test has its own file so that parallel tasks never share a file. Tests never touch the real `~/.kiro`.
- Tasks marked `*` are optional tests. In group P0 no test is optional.
- Cross-group dependencies: G2 is written against the signatures of this design and compiles once G1 has landed. G4 real-process tests need G0 (CLI) and G1 (process manager) and `npm run build`. G3 generated tests need the G3 generator edits.

## Tasks

- [x] 1. P0 Part A: dialog and credentials message (serial, runs first)
  - Owns: `src/studio/ui/js/dialog.js`, `src/studio/ui/js/credentials-notice.js` (new), `src/studio/ui/js/views/connect.js`, `src/studio/ui/js/copy.js`, `src/studio/contracts.ts`, `src/studio/power-installer.ts`, `tests/unit/dialog.test.ts` (new), `tests/unit/connect-view.test.ts`, `tests/unit/power-installer.test.ts`, `tests/unit/power-routes.test.ts`, `tests/unit/studio-ui-copy.test.ts`, `tests/property/dialog-empty-children.property.test.ts`, `tests/property/connect-success-text.property.test.ts`, `tests/property/credentials-notice.property.test.ts`, `tests/property/required-secrets.property.test.ts`.
  - Do not touch `src/studio/server.ts`.

  - [x] 1.1 Make the dialog ignore empty children
    - In `dialog.js` export `withoutEmpty(children)` that drops `null`, `undefined` and `false` and keeps order.
    - `setContent` calls `body.replaceChildren(...withoutEmpty(nodes))`. `openDialog` passes its `content` (scalar or array) through the same filter.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Add the credentials notice and fix the success screen
    - Create `credentials-notice.js` (no imports) exporting `credentialsNotice(result, preview)` returning `'placeholders' | 'vault' | 'none' | 'unknown'` with the rules of the design.
    - `copy.js`: add `credentialsFromVault: 'This tool will use the passwords you saved in Daemonize. Nothing else to set up.'`.
    - `connect.js`: `showSuccess` uses `credentialsNotice` (placeholders lead and chips, vault paragraph, "This tool needs no credentials.", or nothing). Keep the missing-credentials notice. `failure()` returns only non-empty children. Every direct `setContent` argument that can be `null` stays safe through the filter.
    - Confirm `scripts/copy-studio-ui.mjs` copies the new file.
    - _Requirements: 1.5, 1.6, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 1.3 Return `requiredSecrets` from the Power_Installer
    - `contracts.ts`: add `requiredSecrets: string[]` to `PowerPreview` and to the return type of `PowerInstaller.install`.
    - `power-installer.ts`: add `required: string[]` to `Plan`, set from `source.required` in `plan()`, and return `requiredSecrets: plan.required` from `preview()` and `install()`. `routes/power.ts` is not edited.
    - _Requirements: 2.1, 2.2_

  - [x] 1.4 Write DOM and unit tests for the dialog
    - File: `tests/unit/dialog.test.ts`. Cover `withoutEmpty`, `setContent` with nodes only, with a mix of nodes and empty children, and `openDialog` with scalar and array content including empty children.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7_

  - [x] 1.5 Write DOM tests for the success screen
    - File: `tests/unit/connect-view.test.ts`, in the style of the existing tests. Cover: no "null" or "undefined" for an answer without missing secrets and without `autoAddSaved: false`; all secrets saved; a secret with a placeholder; no secret at all; an answer without `requiredSecrets` (read from the preview, no sentence if absent in both); a mix of saved and missing secrets keeping the missing notice.
    - _Requirements: 1.5, 1.7, 2.3, 2.4, 2.5, 2.6, 2.9, 2.10_

  - [x] 1.6 Write unit tests for `requiredSecrets` in the installer and routes
    - Files: `tests/unit/power-installer.test.ts`, `tests/unit/power-routes.test.ts`. Preview and install answers carry the sorted required names, `missingSecrets` is a subset, no value appears.
    - _Requirements: 2.1, 2.2_

  - [x] 1.7 Extend the copy lint test
    - File: `tests/unit/studio-ui-copy.test.ts`. Assert the exact text of `COPY.credentialsFromVault` and that it passes the Plain_Language lint.
    - _Requirements: 2.7, 2.8_

  - [x] 1.8 Write property test for dialog content filtering
    - File: `tests/property/dialog-empty-children.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 1: Dialog content ignores empty children**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

  - [x] 1.9 Write property test for the success screen text
    - File: `tests/property/connect-success-text.property.test.ts`. Render many generated answers in one page (`page.evaluate` over a generated list) or in the DOM environment used by `connect-view.test.ts`.
    - **Feature: kiro-thin-extension, Property 2: The success screen never prints "null" or "undefined"**
    - **Validates: Requirements 1.5, 1.6**

  - [x] 1.10 Write property test for the credentials decision table
    - File: `tests/property/credentials-notice.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 3: Credentials sentence follows the decision table (Studio)**
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6**

  - [x] 1.11 Write property test for `requiredSecrets`
    - File: `tests/property/required-secrets.property.test.ts`. Fake source with generated required names and vault names.
    - **Feature: kiro-thin-extension, Property 4: `requiredSecrets` is the sorted required names and contains every missing name**
    - **Validates: Requirements 2.1, 2.2**

- [x] 2. Checkpoint - Part A done
  - Run `npx vitest run tests/unit/connect-view.test.ts tests/unit/power-routes.test.ts tests/unit/power-installer.test.ts tests/unit/studio-ui-copy.test.ts tests/unit/dialog.test.ts` and require 0 failed tests and exit code 0. Also run the four new property files. Part B does not start before this passes.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 2.11_

- [x] 3. G0 CLI option, shared extension contracts, test project (serial, after the P0 checkpoint)
  - Owns: `src/cli/commands/studio.ts`, `src/cli/index.ts`, `tests/unit/studio-machine.test.ts` (new), `tests/property/studio-machine-handshake.property.test.ts` (new), `kiro-extension/src/core/types.ts`, `kiro-extension/src/core/strings.ts`, `kiro-extension/src/core/ports.ts`, `vitest.config.ts`, `.gitignore` (workspace), `scripts/lib/secret-scan.mjs`.

  - [x] 3.1 Add `--machine` to `daemonize studio`
    - `studio.ts`: add `machine`, `stdout`, `stderr` to `StudioCommandOptions`, export `Handshake` and `formatHandshakeLine`. With `machine`: messages go to stderr, one JSON line `{origin, token, pid}` plus `\n` goes to stdout after `startStudio` resolved, no URL line, no Ctrl+C line, no browser even with `--open`. On failure nothing goes to stdout.
    - `index.ts`: add the `--machine` option with its help text and pass `machine: options.machine === true`. Leave the default action and the output without `--machine` unchanged.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x] 3.2 Create shared types, strings and ports
    - `types.ts`: the types of the design (`Handshake`, `ProcessState`, `Risk`, `RecordingState`, `InstallScope`, row and answer types, `ApiResult`, `TreeNode`).
    - `strings.ts`: the frozen table `S` with every user-facing text (including the fixed texts "Reads only", "Changes data", "Deletes data", "has a value", "has no value yet", "This tool needs no credentials.", `credentialsFromVault`, the button names) and `CONTRIBUTION_STRINGS`.
    - `ports.ts`: the interfaces shared by glue and core (`ProcessManager`, `StudioApi`, `Redactor`, `RecordingPoller`), declared in the file itself.
    - _Requirements: 10.8, 12.3, 13.2, 14.10, 17.1_

  - [x] 3.3 Add the `extension` vitest project
    - `vitest.config.ts`: a third project `extension` with `resolve.alias: { vscode: tests/extension/fake-vscode.ts }`, `setupFiles: ['./tests/setup/clean-env.ts']`, `include: ['tests/extension/**/*.test.ts']`, timeouts of 60000 ms, `sequence.groupOrder: 1`. Keep `fast` and `integration` unchanged.
    - _Requirements: 17.1, 17.9_

  - [x] 3.4 Scope the ignore file and the secret scan
    - `.gitignore`: add `kiro-extension/dist/`, `kiro-extension/*.vsix`, `kiro-extension/node_modules/`.
    - `scripts/lib/secret-scan.mjs`: add to `SYNTHETIC_FIXTURE_FILES` the files `tests/extension/glue/secrets-never-leak.test.ts`, `tests/extension/pure/redactor.property.test.ts`, `tests/extension/real/studio-handshake.test.ts`, `tests/unit/studio-machine.test.ts`, `tests/property/studio-machine-handshake.property.test.ts`.
    - _Requirements: 16.9, 17.7_

  - [x]* 3.5 Write unit tests for machine mode
    - File: `tests/unit/studio-machine.test.ts`, with a fake `startStudio`. Exactly one stdout line with three fields, nothing else on stdout, no browser with `--open --machine`, non-loopback warning on stderr, no token on stderr, error path writes nothing to stdout, no output change without `--machine`.
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.10_

  - [x]* 3.6 Write property test for the handshake line
    - File: `tests/property/studio-machine-handshake.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 5: Handshake round trip and single line**
    - **Validates: Requirements 3.2, 3.6, 3.11**

- [x] 4. Checkpoint - Contracts and CLI seam
  - Run `npx tsc --noEmit` and `npx vitest run tests/unit/studio-machine.test.ts` and confirm the existing suites still pass.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. G1 Extension core, pure modules (parallel)
  - Owns: `kiro-extension/src/core/handshake.ts`, `origin.ts`, `studio-url.ts`, `cli-locator.ts`, `process-manager.ts`, `studio-client.ts`, `studio-api.ts`, `redactor.ts`, `validate.ts`, `recording-poller.ts`, `plain-language.ts`, `kiro-extension/src/core/models/*.ts`, `tests/extension/pure/**`, `tests/extension/static/plain-language.test.ts`.
  - G1 does not edit `types.ts`, `strings.ts` or `ports.ts`. No file under `core/` imports `vscode` or anything from the root `src/`.

  - [x] 5.1 Implement handshake, origin and browser URL
    - `handshake.ts` (`parseHandshakeLine`, `formatHandshake`), `origin.ts` (`isLoopbackOrigin`, `isStudioToken`), `studio-url.ts` (`buildBrowserUrl`, `StudioRoute`) with the rules of the design.
    - _Requirements: 3.11, 5.1, 5.2, 5.3, 5.12, 6.1, 6.3_

  - [x] 5.2 Implement the CLI locator
    - `cli-locator.ts`: `locateCli` with the documented order, `.cmd` shim reading (no shell), Node runtime order with the Electron fallback and `ELECTRON_RUN_AS_NODE=1`, `configured-missing` without fallback, deterministic result.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10_

  - [x] 5.3 Implement the redactor
    - `redactor.ts`: strip ANSI, replace sensitive literals (longest first, skip literals shorter than 3 characters) and `DAEMONIZE_SECRET_*` values, then `token=` and `Bearer` values.
    - _Requirements: 9.3, 9.7_

  - [x] 5.4 Implement the Studio client and API
    - `studio-client.ts`: `createHttpTransport`, `StudioClientError`, `createStudioClient` (path confinement, headers, no `Origin`, no redirect, 15 s and 120 s timeouts, 401 as `unauthorized`, log line `METHOD /path STATUS` only).
    - `studio-api.ts`: `createStudioApi` with tolerant parsers for every route of the design.
    - _Requirements: 5.7, 5.8, 5.9, 5.10, 5.11, 9.6_

  - [x] 5.5 Implement the process manager
    - `process-manager.ts`: `createProcessManager`, `StudioSession`, `StartError`. `spawn` with `shell: false`, `windowsHide: true`, one pending start shared by callers, first stdout line decides the handshake, 30 s timeout, `old-cli` detection, tree kill, no automatic restart after `crashed`, environment copied without additions.
    - _Requirements: 5.4, 5.5, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.14, 8.15_

  - [x] 5.6 Implement the poller and the validators
    - `recording-poller.ts`: `createRecordingPoller` (one loop, in-flight guard, stop on a non-recording state, give up after three failures in a row).
    - `validate.ts`: `validateName`, `validateUrl` with the same rules and texts as `src/studio/validate-action.ts`.
    - _Requirements: 11.2, 11.3, 11.4, 11.8, 11.14, 11.15_

  - [x] 5.7 Implement tree models, formatters and the language lint helper
    - `models/actions-model.ts`, `credentials-model.ts`, `kiro-model.ts`, `status-model.ts`, `preview-format.ts`, `credentials-notice.ts`, and `plain-language.ts` (`BANNED_TERMS`, `bannedTermsIn`). Only `id`, `label`, `toolName` and the risk reach an action node. No credential node has a field that can hold a value.
    - _Requirements: 10.6, 10.7, 12.1, 12.2, 12.3, 12.4, 12.7, 13.1, 13.2, 13.3, 14.4, 14.5, 14.6, 14.10_

  - [x]* 5.8 Write property test for handshake and origin validation
    - File: `tests/extension/pure/handshake-origin.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 6: Handshake and origin validation accept exactly the valid forms**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.12**

  - [x]* 5.9 Write property test for the browser URL
    - File: `tests/extension/pure/studio-url.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 9: The browser URL carries the token and the route**
    - **Validates: Requirements 6.1, 6.3**

  - [x]* 5.10 Write property test and unit tests for the CLI locator
    - File: `tests/extension/pure/cli-locator.property.test.ts`. Add unit cases with a fake file system for each order step, the `.cmd` shim, `configured-missing` and the Electron fallback.
    - **Feature: kiro-thin-extension, Property 10: CLI location is deterministic and follows the documented order**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 4.10**

  - [x]* 5.11 Write property test for the redactor
    - File: `tests/extension/pure/redactor.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 12: Redacted text never contains a sensitive value**
    - **Validates: Requirements 9.3, 9.7**

  - [x]* 5.12 Write property test for the Studio client
    - File: `tests/extension/pure/studio-client.property.test.ts`, with a fake transport.
    - **Feature: kiro-thin-extension, Property 8: The client sends only confined, authenticated requests**
    - **Validates: Requirements 5.7, 5.8, 5.9**

  - [x]* 5.13 Write property test for the failed-request log line
    - File: `tests/extension/pure/client-log.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 13: A failed-request log line holds the method, the path without query, and the status**
    - **Validates: Requirements 9.6**

  - [x]* 5.14 Write property test for the first stdout line
    - File: `tests/extension/pure/handshake-first-line.property.test.ts`, with a fake child.
    - **Feature: kiro-thin-extension, Property 7: The first stdout line decides the handshake**
    - **Validates: Requirements 5.4, 5.5**

  - [x]* 5.15 Write model-based property test for the process manager
    - File: `tests/extension/pure/process-manager.property.test.ts`. Generated event scripts, invariants checked after every step.
    - **Feature: kiro-thin-extension, Property 11: The process manager keeps at most one live process and never restarts alone**
    - **Validates: Requirements 8.3, 8.5, 8.9, 8.11, 8.12, 8.15**

  - [x]* 5.16 Write property test for validator parity
    - File: `tests/extension/pure/validate-parity.property.test.ts`, comparing with `src/studio/validate-action.ts`.
    - **Feature: kiro-thin-extension, Property 14: Extension validators agree with the Studio validators**
    - **Validates: Requirements 11.2, 11.3, 11.4**

  - [x]* 5.17 Write property test for the recording poller
    - File: `tests/extension/pure/recording-poller.property.test.ts`, with fake timers.
    - **Feature: kiro-thin-extension, Property 15: The recording poller has one loop and stops at the right moment**
    - **Validates: Requirements 11.8, 11.14, 11.15**

  - [x]* 5.18 Write property test for the actions tree
    - File: `tests/extension/pure/actions-model.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 16: The actions tree shows each valid workflow with its risk and tool tooltip**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.7**

  - [x]* 5.19 Write property test for the credentials tree
    - File: `tests/extension/pure/credentials-model.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 17: The credentials tree shows names and flags, never values**
    - **Validates: Requirements 13.1, 13.2, 13.3**

  - [x]* 5.20 Write property test for the confirmation text
    - File: `tests/extension/pure/preview-format.property.test.ts`.
    - **Feature: kiro-thin-extension, Property 19: The confirmation text lists everything that will be written**
    - **Validates: Requirements 14.4, 14.5, 14.6**

  - [x]* 5.21 Write property test for credentials sentence parity
    - File: `tests/extension/pure/credentials-notice-parity.property.test.ts`. Imports the Studio `credentials-notice.js` and `COPY`.
    - **Feature: kiro-thin-extension, Property 20: The extension and the Studio choose the same credentials sentence**
    - **Validates: Requirements 14.10**

  - [x]* 5.22 Write the Plain_Language lint test
    - File: `tests/extension/static/plain-language.test.ts`. Every string of `S` and `CONTRIBUTION_STRINGS` passes `bannedTermsIn`.
    - _Requirements: 10.7, 10.8_

- [x] 6. G2 Extension glue, manifest, bundling, packaging (parallel)
  - Owns: `kiro-extension/src/extension.ts`, `kiro-extension/src/ui/**`, `kiro-extension/package.json`, `package.nls.json`, `tsconfig.json`, `.vscodeignore`, `LICENSE`, `scripts/bundle.mjs`, `media/**`, `tests/extension/fake-vscode.ts`, `tests/extension/glue/**`, `tests/extension/static/manifest.test.ts`, `tests/extension/static/imports.test.ts`, `tests/extension/packaging.test.ts`.
  - G2 imports the core only through the functions and types named in the design.

  - [x] 6.1 Create the manifest, build files and icon
    - `package.json` (no `dependencies`, `engines.vscode ^1.85.0`, untrusted and virtual workspaces unsupported, activation events, views, 17 commands, menus, two `machine` scope settings), `package.nls.json` generated from `CONTRIBUTION_STRINGS`, `tsconfig.json`, `.vscodeignore`, `LICENSE`, `media/daemonize.svg`, and `scripts/bundle.mjs` (esbuild, one CommonJS file, `vscode` external, fails on any input outside `src` or on `playwright`, `node-pty`, `node_modules`).
    - _Requirements: 10.1, 10.2, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.9_

  - [x] 6.2 Create the fake `vscode` module
    - `tests/extension/fake-vscode.ts` with the subset of the design and the recording API `__calls`, `__script`, `__reset`.
    - _Requirements: 17.1_

  - [x] 6.3 Implement the composition root and shared glue
    - `extension.ts` (`activate`, `activateWith`, `deactivate` that stops the process), `ui/controller.ts` (`withStudio`, error mapping, one transparent GET retry after 401, no POST replay), `ui/settings.ts`, `ui/logger.ts` (redacts stderr, no stdout path), `ui/status-bar.ts`.
    - _Requirements: 4.8, 4.9, 5.10, 8.13, 9.1, 9.2, 9.4, 10.5_

  - [x] 6.4 Implement the three tree views
    - `ui/views/actions-view.ts`, `credentials-view.ts`, `kiro-view.ts`: `TreeDataProvider`s over the pure tree models. The first expansion of the Actions view starts the Studio once.
    - _Requirements: 10.3, 10.4, 10.6, 12.5, 12.6, 12.8, 12.9, 14.14_

  - [x] 6.5 Implement lifecycle and Studio commands
    - `ui/commands/lifecycle.ts` (start, stop, restart, refresh, show log, choose CLI file, workspace folder rules) and `ui/commands/studio.ts` (`openStudio`, `testInStudio` through `openExternal`, URL never logged or shown).
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 8.9, 8.10, 8.12_

  - [x] 6.6 Implement record, credentials and Kiro commands
    - `ui/commands/record.ts` (new action with validators, finish, poller wiring), `ui/commands/credentials.ts` (value in a local `const`, sent only to `api.setSecret`; forget with modal), `ui/commands/kiro.ts` (preview, modal, install, final message from `credentialsNotice`, remove).
    - _Requirements: 11.1, 11.5, 11.6, 11.7, 11.9, 11.10, 11.11, 11.12, 11.13, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 13.12, 14.1, 14.2, 14.3, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.15_

  - [x]* 6.7 Write property test for secret value confinement
    - File: `tests/extension/glue/secrets-never-leak.test.ts`, with a recording fake client and the fake `vscode`.
    - **Feature: kiro-thin-extension, Property 18: A typed secret value appears only in the body of one POST**
    - **Validates: Requirements 9.5, 13.5, 13.6, 13.10, 13.13**

  - [x]* 6.8 Write glue example tests for the commands
    - Files under `tests/extension/glue/`: no folder, non-`file` scheme, several folders, `openExternal` returning `false`, dismissed input boxes send no request, cancelled modals send no install request, 401 handling, missing CLI and missing configured path messages.
    - _Requirements: 4.8, 4.9, 6.7, 7.1, 7.4, 7.5, 11.6, 13.12, 14.8, 14.11_

  - [x]* 6.9 Write static manifest and import checks
    - Files: `tests/extension/static/manifest.test.ts`, `tests/extension/static/imports.test.ts`. Manifest fields, no `dependencies`, `package.nls.json` equals `CONTRIBUTION_STRINGS`, `S.credentialsFromVault` equals `COPY.credentialsFromVault`, `core/` imports no `vscode`, no import into the root `src/`, no webview, no file write.
    - _Requirements: 10.8, 16.2, 16.3, 16.5, 17.1_

  - [x]* 6.10 Write the packaging test
    - File: `tests/extension/packaging.test.ts`. Run the bundle, `vsce ls --no-dependencies` and `vsce package --no-dependencies`, check forbidden paths and the 500 KB limit. Skip with a visible reason when `kiro-extension/node_modules` is absent, and fail instead when `DAEMONIZE_REQUIRE_EXTENSION_BUILD=1`.
    - _Requirements: 16.7, 16.8, 16.9_

- [x] 7. G3 Generated browser fallback (parallel)
  - Owns: `src/replay/runtime/browser-launch.ts` (new), `src/compiler/mcp-generator.ts`, `src/compiler/compiler.ts`, `tests/unit/browser-launch.test.ts` (new), `tests/unit/browser-launch-generated.test.ts` (new), and existing compiler or sandbox tests that assert the old `chromium.launch` text or the old `copy` list.

  - [x] 7.1 Create the replay launcher runtime file
    - `browser-launch.ts`, no imports: `isBrowserMissing`, `launchReplayBrowser` with the attempt chain bundled, `chrome`, `msedge`, `DAEMONIZE_CHROMIUM_PATH` alone with no fallback, `--no-sandbox` when `DAEMONIZE_IN_CONTAINER` is set, `headless: true`, and the "no browser" error text.
    - _Requirements: 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 7.2 Wire the launcher into the generator and compiler
    - `mcp-generator.ts`: both `chromium.launch` sites become `launchReplayBrowser(chromium)` with the import in the web and web-http blocks, and `browser-launch.js` in the sandbox `copy` list for web targets.
    - `compiler.ts`: read `RUNTIME_BROWSER_LAUNCH` for web targets and write `browser-launch.ts` and `browser-launch.js` (through `toJavaScript`), deterministic output.
    - Update existing tests that assert the old text or list. Run `tests/unit/generated-no-src-import.test.ts`.
    - _Requirements: 15.1, 15.8, 15.9_

  - [x]* 7.3 Write property test for the launch attempt chain
    - File: `tests/unit/browser-launch.test.ts`, with a fake `chromium`. Add the named scenarios of the requirements: bundled works, Chrome works, Edge works, all missing, non-missing error stops the chain.
    - **Feature: kiro-thin-extension, Property 21: The replay launcher follows the attempt chain**
    - **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.10**

  - [x]* 7.4 Write property test for parity with the recorder launcher
    - File: `tests/unit/browser-launch-generated.test.ts`. Load the generated copy from a compiled temporary output folder, compare with `src/recorder/browser-launcher.ts`, assert two compiles give the same bytes.
    - **Feature: kiro-thin-extension, Property 22: The generated launcher matches `src/recorder/browser-launcher.ts`**
    - **Validates: Requirements 15.9, 15.11**

- [x] 8. G4 Documentation and real-process tests (parallel)
  - Owns: `kiro-extension/README.md`, `README.md` (root), `tests/extension/real/**`, `tests/extension/static/readme.test.ts`.

  - [x] 8.1 Write the extension README
    - Build, install the `.vsix` in Kiro, the two settings, Node requirement and the Electron fallback with its reason, the orphan limit, the Studio opening in the default browser, the repository URL note.
    - _Requirements: 4.11, 16.12_

  - [x] 8.2 Add a short section to the root README
    - One short section that points to `kiro-extension/`.
    - _Requirements: 16.12_

  - [x]* 8.3 Write real-process tests
    - Files under `tests/extension/real/` (including `studio-handshake.test.ts`). Spawn `dist/cli/index.js studio --machine` in a temporary folder through the real `createProcessManager`. Read the handshake, call `GET /api/health`, `/api/workflows`, `/api/secrets` with the token and expect 401 without it, check the first-visit `302` with `Set-Cookie`, exactly one stdout line, no token on stderr, stop and wait up to 10 s for the pid to disappear. Add failure paths (occupied port, non-zero exit, empty stdout). Fail with "run npm run build first" when `dist/cli/index.js` is absent.
    - _Requirements: 3.2, 3.3, 5.4, 5.7, 8.13, 17.5_

  - [x]* 8.4 Write the README check
    - File: `tests/extension/static/readme.test.ts`. The README mentions build, install, the two settings, the Node requirement and the browser.
    - _Requirements: 16.12_

- [x] 9. Checkpoint C - Final checks (serial, after G1 to G4)
  - The only step that may edit any file, and only to fix integration errors. Run in this order and report the exact results of each command:
    1. In `kiro-extension/`: `npm ci`, `npm run typecheck`, `npm run build`, `npm run package`, and `npm run ls` (vsce ls) to list the package files and check the forbidden paths and the 500 KB limit.
    2. In the repository root, with `DAEMONIZE_REQUIRE_EXTENSION_BUILD=1`: `npm run build`, `npm run check:secrets`, `npx tsc --noEmit`, `npx vitest run`.
    3. `npx vitest run` once more with `DAEMONIZE_SECRET_PASSWORD` set in the shell.
  - Then STOP and tell the user to load the `.vsix` in Kiro. Do not start Step 3.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.13_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. In group P0 every test is required.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation. Part A must pass before Part B starts.
- Property tests validate universal correctness properties. Unit tests validate specific examples and edge cases.
- Real-process tests and the packaging test need `npm run build` and `npm ci` in `kiro-extension/` first.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "3.4"] },
    { "id": 3, "tasks": ["3.5", "3.6"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "7.1", "8.1", "8.2"] },
    { "id": 5, "tasks": ["5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15", "5.16", "5.17", "5.18", "5.19", "5.20", "5.21", "5.22", "6.7", "6.8", "6.9", "6.10", "7.2", "8.3", "8.4"] },
    { "id": 6, "tasks": ["7.3", "7.4"] }
  ]
}
```
