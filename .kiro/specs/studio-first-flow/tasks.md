# Implementation Plan: studio-first-flow

## Overview

The implementation language is TypeScript for `src/` and the tests, and plain ES modules for `src/studio/ui` (as the design states). Work is split into the design's groups.

- **G0** is serial and goes first. It creates the seams, the contracts and an inert stub for every module another group will own.
- **G1 to G5** then run in parallel. Each group edits only the files it owns (design, "File ownership is disjoint"). No group after G0 edits `server.ts`, `services.ts`, `routes/index.ts`, `contracts.ts` or `routes/types.ts`. A contract change goes back to G0's owner.
- Each group has implementation sub-tasks, unit tests, one property test file with one sub-task per property, and integration tests. Property tests are tagged `// Feature: studio-first-flow, Property N: <title>`.
- Dependencies across groups: the G3 integration test (5.13) needs G1 and G4 complete. The G5 browser test (7.15) needs G1, G2, G3 and G4 complete.
- The last group (9) runs the four repository checks and reports exact counts.

## Tasks

- [x] 1. G0 Foundation (serial, first)
  - [x] 1.1 Write `src/studio/contracts.ts` and `src/studio/routes/types.ts`
    - Add every interface and error class from the design's "Cross-group contracts": `AppData`, `SecretVault`, `VaultUnavailableError`, `VaultUnreadableError`, `RequiredSecret`, `SessionStore`, `RecordingManager` and its status and outcome types, `CompileRunner`, `PowerInstaller`, `PowerError`, `StudioServices`.
    - Add `RouteMethod`, `RouteRequest`, `RouteResponse`, `RouteHandler`, `RouteDef`, `RouteContext` and `RouteFactory` to `routes/types.ts`.
    - _Requirements: 4.1, 6.1, 8.1, 9.1, 11.4, 13.1_

  - [x] 1.2 Implement `app-data.ts`, `validate-action.ts` and the common messages
    - `src/studio/app-data.ts`: per-platform default folder, `DAEMONIZE_DATA_DIR` override (absolute only), `realpath` of the deepest existing ancestor, case-insensitive compare on win32 and darwin, rejection when equal to or inside the cwd, a `.git` ancestor or the Output_Dir, `ensure()` with mode `0o700`, `check()` without side effects.
    - `src/studio/validate-action.ts`: `validateName` (trim, 1 to 80 code points, an ASCII letter or digit, no control characters), `validateUrl` (trim, at most 2048 characters, absolute http or https, no user name or password), `plainName`, `applicationKey`.
    - `src/studio/messages/common.ts` and `messages/index.ts`: plain-language texts for the validators, the 403 remote refusal, 405, 413, 415, 400 and the three fixed load errors.
    - _Requirements: 3.7, 3.8, 3.10, 6.2, 6.3, 13.2, 13.9_

  - [x] 1.3 Update `.gitignore` and the Secret_Scan fixture list
    - Add `secrets.vault.json`, `secrets.vault.json.tmp-*`, `vault.key`, `vault.key.test`, `*.storage-state.json.tmp-*` to `.gitignore`.
    - Add to `SYNTHETIC_FIXTURE_FILES` in `scripts/lib/secret-scan.mjs` every new test file that plants fake credentials: `tests/unit/totp-secret.test.ts`, `tests/unit/secret-vault.test.ts`, `tests/unit/key-providers.test.ts`, `tests/unit/playground-vault-env.test.ts`, `tests/unit/secrets-routes.test.ts`, `tests/unit/session-store.test.ts`, `tests/unit/power-installer.test.ts`, `tests/unit/mcp-snippet.test.ts`, `tests/property/studio-secrets.property.test.ts`, `tests/property/studio-recording.property.test.ts`, `tests/property/studio-compile-power.property.test.ts`, `tests/integration/studio-secrets.test.ts`, `tests/integration/studio-record.test.ts`, `tests/integration/studio-power.test.ts`, `tests/integration/studio-ui-first-flow.test.ts`.
    - _Requirements: 13.12, 14.19_

  - [x] 1.4 Create inert stubs, `services.ts` and `routes/index.ts`
    - Stubs that export the final symbol names and do nothing: `secret-vault.ts` (`NullSecretVault`), `key-providers.ts`, `totp-secret.ts`, `required-secrets.ts`, `session-store.ts`, `recording-manager.ts`, `compile-runner.ts`, `power-installer.ts`, `mcp-snippet.ts`, `routes/record.ts`, `routes/sessions.ts`, `routes/secrets.ts`, `routes/compile.ts`, `routes/power.ts` (route factories return `[]`), `messages/secrets.ts`, `messages/record.ts`, `messages/compile.ts`, and `src/recorder/browser-launcher.ts` (types `LaunchFn`, `BrowserUsed`, `LaunchedBrowser`, `BrowserLaunchError`, and a `launchBrowser` that throws "not implemented").
    - `src/studio/services.ts`: `createServices(options, ctxInfo)` builds the real services, and inert services in sample mode.
    - `src/studio/routes/index.ts`: `DEFAULT_ROUTES = [recordRoutes, sessionRoutes, secretRoutes, compileRoutes, powerRoutes]`.
    - _Requirements: 13.1, 13.10_

  - [x] 1.5 Edit `server.ts` (the seam) and add option types to `playground.ts`
    - Tolerant `loadLive`: a missing Workflow_File gives zero Actions, a missing Output_Dir is never created, the three fixed `LoadError` messages, `stat` size check against `MAX_JSON_FILE` before `readFile`.
    - `GET /api/overview` adds `workflowFileExists`, `outputCompiled`, `recordingActive` (sample mode: `true, true, false`).
    - `dispatchRoute()`: guard order, remote refusal 403, 405 with `Allow`, sample-mode 409, `bodyLimitFor` (64 KiB for registered POST routes), 413, 415, 400, and redaction with `env`, storage-state values, `vault.values()` and `sessions.knownValues()`.
    - `StudioOptions.services` and `StudioOptions.routes` test seams. `close()` order: stop accepting, `recording.close()`, `compiler.close()`, `playground.close()`.
    - `playground.ts`: only the option types `vault` and `requiredSecretNames` (behavior belongs to G2).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.10_

  - [x] 1.6 Create the UI seam `src/studio/ui/js/features.js`
    - Export empty `FEATURE_ROUTES` and `FEATURE_VIEWS`, and import them once in `router.js` and `app.js`, so later UI work touches only feature modules.
    - After this task `src/studio/ui/**` belongs to G5.
    - _Requirements: 12.11, 12.13_

  - [x] 1.7 Update the existing `tests/integration/studio-server.test.ts` (R13.11)
    - Reason: a missing Workflow_File used to answer 500 `workflow file not found: ...` and now answers 200 with zero Actions; the invalid-file messages become the three fixed strings; `/api/overview` gains three fields.
    - Change only the assertions that this behavior changes.
    - _Requirements: 2.3, 2.6, 2.8, 13.11, 14.20_

  - [x]* 1.8 Write unit tests for `app-data` and `validate-action`
    - Files: `tests/unit/app-data.test.ts`, `tests/unit/validate-action.test.ts`.
    - Cover the three platform defaults, `DAEMONIZE_DATA_DIR` relative value, a `.git` file (worktree), a symlinked folder, name and URL edge cases (81 code points, control character, `user:pass@` address, 2049 characters).
    - _Requirements: 3.7, 3.8, 6.2, 6.3, 13.9_

  - [x]* 1.9 Write unit tests for the dispatcher with fake routes
    - File: `tests/unit/studio-dispatcher.test.ts`, using `StudioOptions.routes`.
    - Check the order: 414, 403, 401, then remote 403, 405, sample 409, 413, 415, 400. A path no module owns still falls through to the old 404.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x]* 1.10 Write property test for action input validation
    - File: `tests/property/studio-foundation.property.test.ts`.
    - **Property 1: Action input validation** (server module half).
    - **Validates: Requirements 3.6, 3.7, 3.8**

  - [x]* 1.11 Write property test for the App_Data_Dir exclusion rule
    - Same file. Covers `appData.check()` and `ensure()` creating no file when excluded. The vault and session store halves are checked in tasks 4.9 and 5.5.
    - **Property 15: The App_Data_Dir exclusion rule**
    - **Validates: Requirements 6.2, 6.3**

  - [x]* 1.12 Write property test for load error messages
    - Same file. The workflow-file load errors are always one of the three fixed strings and hold no path or file content.
    - **Property 18: Error messages carry no path and no secret** (load errors)
    - **Validates: Requirements 2.6**

  - [x]* 1.13 Write integration test for the empty start
    - File: `tests/integration/studio-empty-start.test.ts`.
    - Start the Studio in a folder with no Workflow_File and no Output_Dir. Check the five data routes answer 200 with zero Actions, no console output, no Output_Dir created, the invalid-file 500 messages, recovery on the next valid file, and change detection without restart.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 14.3_

  - [x]* 1.14 Write integration test for guard rules on every registered route
    - File: `tests/integration/studio-guard-routes.test.ts`.
    - Iterate over the registered routes (fake routes now, the real ones once merged): 403 with `--allow-remote`, 413, 415, 405 with `Allow`, 400 for `..`, absolute path and NUL in plain-name fields with no file touched.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.9, 14.16_

- [x] 2. Checkpoint - G0 merged
  - Ensure all tests pass, ask the user if questions arise. G1 to G5 start only after this point.

- [x] 3. G1 CLI and recording engine
  - [x] 3.1 Implement `src/recorder/browser-launcher.ts`
    - Replace the stub: `isNotInstalled` (the three Playwright messages), `launchBrowser` with `DAEMONIZE_CHROMIUM_PATH` as the only attempt, else bundled, `chrome`, `msedge`, stopping at the first success or the first non-"not installed" failure. Cause text is the first line, ANSI-stripped, clipped to 200 characters.
    - Do not change `PlaywrightDriver`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.10_

  - [x] 3.2 Add the `record()` options and use the launcher in the `record` command
    - File: `src/cli/commands/record.ts`. Add `launch`, `sessionStorageState` (never copied into `target.storageState`), `captureSessionState`, `windowMode` (`'studio'` never reads stdin, a closed window takes the recovery path), `onLive`, `onBrowser`, `onEnding`, and `RecordSummary.sessionCaptured`.
    - Launch the browser through `launchBrowser` with `headless` defaulting to false. A launcher failure goes to stderr with a non-zero exit and no file.
    - _Requirements: 4.6, 4.7, 4.13, 5.8, 6.4, 6.6, 6.11_

  - [x] 3.3 Implement the default launch and the shared interrupt helper
    - Files: `src/cli/index.ts`, `src/cli/commands/studio.ts`. Root `program.action` calls `studio()` with the `studio --open` arguments, rejects unknown arguments with `Unknown argument "<x>"`, and sets the help description so `daemonize --help` lists all subcommands.
    - `untilInterrupted(handle)` registers SIGINT and SIGTERM once and races `handle.close()` with 4500 ms before `process.exit(0)`. The `studio` subcommand uses it and keeps its behavior.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [x] 3.4 Update the existing `tests/integration/cli.test.ts` (R13.11)
    - Reason: bare `daemonize` used to print the commander help and now starts the Studio. Change only that assertion and keep every subcommand assertion as it is.
    - _Requirements: 1.1, 1.6, 13.11, 14.20_

  - [x]* 3.5 Write unit tests for the default launch
    - File: `tests/unit/cli-default-launch.test.ts`, with injected `deps`.
    - Bare `daemonize` selects `studio --open` with the expected arguments. `record`, `compile`, `merge`, `serve`, `studio`, `sandbox` stay registered with their flags. `daemonize foo` fails with a non-zero code and an error naming `foo`. `-h` exits 0 without starting the Studio.
    - _Requirements: 1.1, 1.6, 1.7, 1.8, 13.10, 14.14_

  - [x]* 3.6 Write unit tests for the Browser_Launcher
    - File: `tests/unit/browser-launcher.test.ts`, with a fake `LaunchFn`.
    - Custom path is the only attempt. Order bundled, `chrome`, `msedge`. A permission error or timeout stops the search. All not installed gives the three-name message. `headless` is applied to every attempt.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 14.12_

  - [x]* 3.7 Write unit tests for the `record()` options
    - File: `tests/unit/record-options.test.ts`, with fakes.
    - `sessionStorageState` is used for the context and absent from the saved Workflow_File and recovery file. `windowMode: 'studio'` does not read stdin. `onLive`, `onBrowser`, `onEnding` fire. `captureSessionState` errors give `sessionCaptured = false`.
    - _Requirements: 4.13, 6.4, 6.11_

  - [x]* 3.8 Write property test for the Browser_Launcher attempt order
    - File: `tests/property/browser-launcher.property.test.ts`.
    - **Property 16: The Browser_Launcher attempt order**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

  - [x]* 3.9 Write integration test for the recording hooks with a real browser
    - File: `tests/integration/record-studio-hooks.test.ts`.
    - `sessionStorageState` never lands in the Workflow_File, `windowMode: 'studio'` closes with a recovery file, hooks fire in order, the launcher failure leaves no file.
    - _Requirements: 4.13, 5.8, 6.4, 6.11_

  - [x]* 3.10 Write integration test for bare `daemonize` as a child process
    - File: `tests/integration/cli-bare-daemonize.test.ts`.
    - Help output and exit 0, unknown argument exit code, address line and Ctrl+C line, exit 0 within 5 seconds after SIGINT, port failure prints `Error:` and exits 1.
    - _Requirements: 1.2, 1.5, 1.7, 1.8, 1.10_

- [x] 4. G2 Secrets
  - [x] 4.1 Implement `totp-secret.ts` and `required-secrets.ts`
    - `normalizeBase32`, `extractTotpSecret` (hand-parsed `otpauth://`, exactly one `secret`, type `totp`), and `requiredSecrets(set)` with the kind precedence from the design.
    - _Requirements: 8.4, 8.10, 8.11, 8.12, 8.13_

  - [x] 4.2 Implement `key-providers.ts`
    - `KeyProvider` for Windows DPAPI, macOS `security -i`, Linux `secret-tool`. `spawn` with `shell: false`, the key on stdin only, `minimalEnv` allow-list, 15 s timeout, `KeyStoreUnavailableError`. `DAEMONIZE_VAULT_KEY_PROVIDER` is read only when `NODE_ENV === 'test'`.
    - _Requirements: 8.1, 8.2, 8.18_

  - [x] 4.3 Implement `secret-vault.ts` and `messages/secrets.ts`
    - AES-256-GCM envelope, `secrets.vault.json` with mode `0o600`, atomic write, mtime and size cache, `set`, `remove`, `has`, `names`, `values`, `snapshot`, `VaultUnavailableError` and `VaultUnreadableError` mapping, repair by a later valid `set`.
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 8.14, 8.18, 8.19, 8.20_

  - [x] 4.4 Implement the vault behavior in `playground.ts`
    - `launchSpec({ strictVault })` with vault values winning and only the `DAEMONIZE_SECRET_<NAME>` key form, `ensureConn` mapping `VaultUnreadableError` to `vault_unreadable`, `configuredSecretVariables()` including vault names, `secretValues` including `vault.values()`, and `stopNow()`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.10, 9.11_

  - [x] 4.5 Implement `routes/secrets.ts`
    - `GET /api/secrets`, `POST /api/secrets` (validation order from the design, 503 on `VaultUnavailableError`, `stopNow()` before the response when a value changed), `POST /api/secrets/forget`. All `remote: 'blocked'`.
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.13, 8.16, 8.17, 8.18, 8.19_

  - [x] 4.6 Update the existing `tests/unit/playground.test.ts` (R13.11)
    - Reason: `configuredSecretVariables()` now also returns the vault names, and the child environment can hold vault values. Add the new cases and change only the assertions that this behavior changes.
    - _Requirements: 9.5, 13.11, 14.20_

  - [x]* 4.7 Write unit tests for TOTP input and required secrets
    - Files: `tests/unit/totp-secret.test.ts` and a case block for `required-secrets` in the same folder (`tests/unit/required-secrets.test.ts`).
    - Padding, grouping, lower case, `=` in the middle, two `secret` parameters, type `hotp`, header kind shown as token.
    - _Requirements: 8.4, 8.10, 8.11, 8.13_

  - [x]* 4.8 Write unit tests for the key providers
    - File: `tests/unit/key-providers.test.ts`, with a fake `spawn`.
    - No key material in `argv`, no `DAEMONIZE_SECRET_*` in the child `env`, not-found versus unavailable per platform, `DAEMONIZE_VAULT_KEY_PROVIDER` ignored outside `NODE_ENV=test`.
    - _Requirements: 8.1, 8.2, 8.18_

  - [x]* 4.9 Write unit tests for the vault
    - File: `tests/unit/secret-vault.test.ts`.
    - Round trip, tampered file, missing key, atomic write failure keeps old values, 503 when the App_Data_Dir is excluded (the vault half of Property 15), no plain text in the file.
    - _Requirements: 6.3, 8.1, 8.2, 8.18, 8.20_

  - [x]* 4.10 Write unit tests for the playground vault environment
    - File: `tests/unit/playground-vault-env.test.ts`.
    - Vault beats Studio and `mcp.json` values of the same name, `process.env` unchanged, nothing in `args`, `vault_unreadable` starts no process, no stored value in `mcp.json`, `mcp-server.js` or the call history.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.8, 9.11, 14.9_

  - [x]* 4.11 Write unit tests for the secrets routes
    - File: `tests/unit/secrets-routes.test.ts`.
    - 200 body holds only `name` and `configured`, 400 cases (not required, empty, 2 characters, over 4096 bytes, NUL, invalid TOTP), 503, guard failures leave the vault unchanged, the Child_Server stops only on accepted changes.
    - _Requirements: 8.3, 8.6, 8.7, 8.8, 8.9, 8.13, 8.16, 8.17, 8.18, 14.6_

  - [x]* 4.12 Write property test for Base32 normalization
    - File: `tests/property/studio-secrets.property.test.ts`.
    - **Property 2: Base32 normalization is idempotent and byte-preserving**
    - **Validates: Requirements 8.10, 8.12**

  - [x]* 4.13 Write property test for the otpauth round trip
    - Same file. At least 100 runs, secrets of 16 to 64 characters.
    - **Property 3: Otpauth round trip**
    - **Validates: Requirements 8.11, 8.12, 14.7**

  - [x]* 4.14 Write property test for invalid TOTP values
    - Same file.
    - **Property 4: Invalid TOTP values are rejected**
    - **Validates: Requirements 8.13**

  - [x]* 4.15 Write property test for the secrets list
    - Same file.
    - **Property 5: The secrets list matches the workflows**
    - **Validates: Requirements 8.4**

  - [x]* 4.16 Write property test for the configured status
    - Same file.
    - **Property 6: Configured status is the union of the three sources**
    - **Validates: Requirements 8.5, 9.5**

  - [x]* 4.17 Write property test for the vault round trip and opacity
    - Same file.
    - **Property 7: Vault round trip and ciphertext opacity**
    - **Validates: Requirements 8.1, 8.2, 8.6, 8.20**

  - [x]* 4.18 Write property test for the Redactor
    - Same file.
    - **Property 8: The Redactor removes every known secret value**
    - **Validates: Requirements 6.12, 8.14, 8.19, 9.10**

  - [x]* 4.19 Write property test for no leak of a stored value
    - Same file. Starts one Studio with the memory key provider. Scans responses, captured output, and files under the test repository, Output_Dir, temp folder and App_Data_Dir.
    - **Property 9: A stored secret value never leaves the vault**
    - **Validates: Requirements 8.3, 8.15, 9.8, 13.8, 14.8**

  - [x]* 4.20 Write property test for the Child_Server environment
    - Same file.
    - **Property 10: The vault wins in the Child_Server environment and only there**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.9**

  - [x]* 4.21 Write property test for plain-name fields of the secrets routes
    - Same file. The file system is byte-identical before and after.
    - **Property 19: Plain-name fields reject path forms** (secrets routes)
    - **Validates: Requirements 13.9**

  - [x]* 4.22 Write integration test for the secrets flow
    - File: `tests/integration/studio-secrets.test.ts`, full Studio with the memory provider.
    - Save, list, replace, forget, Child_Server restart picks up the new value, guard failures, 503 with the `unavailable` provider.
    - _Requirements: 8.3, 8.5, 8.6, 8.7, 8.16, 8.17, 8.18, 9.1, 14.6_

- [x] 5. G3 Recording and sessions
  - [x] 5.1 Implement `session-store.ts` and `messages/record.ts`
    - `keyFor`, `available`, `pathFor` (size, JSON and shape checks), atomic `save` with mode `0o600`, `forget`, `refresh`, `knownValues`, `problem`. File name is the first 40 hex characters of `sha256(key)` plus `.storage-state.json`.
    - _Requirements: 6.1, 6.2, 6.3, 6.7, 6.8, 6.10, 6.11, 6.12, 6.14_

  - [x] 5.2 Implement `recording-manager.ts`
    - Synchronous `start` guard, `stop`, `status`, `isActive`, `close` (10 s deadline), the six-state machine, `NOTHING_RECORDED`, recovery file parsing, session reuse and save (state stays `done` when the save fails).
    - Define a local structural `RecordFn` type with the new hook options. Do not import G1's `RecordOptions` additions. Load the real `record` lazily and cast it, so G3 compiles before G1 merges. Task 5.13 checks the real wiring.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 5.9, 6.4, 6.5, 6.6, 6.15, 6.16, 7.1_

  - [x] 5.3 Implement `routes/sessions.ts`
    - `GET /api/sessions` (list and `?key=<origin>`) and `POST /api/sessions/forget`, exact-origin validation, `remote: 'blocked'`.
    - _Requirements: 3.13, 6.7, 6.8, 6.9, 13.9_

  - [x] 5.4 Implement `routes/record.ts`
    - `POST /api/record/start` (allowed fields `name`, `url`, `reuseSession`; 400 with `field`; 202 or 409), `GET /api/record/status`, `POST /api/record/stop` (empty body only). `remote: 'blocked'`.
    - _Requirements: 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.6, 4.8, 4.10, 4.16_

  - [x]* 5.5 Write unit tests for the Session_Store
    - File: `tests/unit/session-store.test.ts`.
    - File lies outside the cwd, every `.git` ancestor and the Output_Dir, and `pathFor` is undefined when the App_Data_Dir is excluded (the session half of Property 15). The Secret_Scan reports no finding. Invalid JSON, wrong shape and oversize read as "no". `forget` of a missing file succeeds.
    - _Requirements: 6.2, 6.3, 6.10, 6.14, 14.13_

  - [x]* 5.6 Write unit tests for the Recording_Manager
    - File: `tests/unit/recording-manager.test.ts`, with a fake `record()` and a fake compiler.
    - Each edge of the state machine, stop outside `recording` gives 409, launch failure, zero steps, recovery file, session reuse and save, session save failure keeps `done`, `close()` deadline.
    - _Requirements: 4.6, 4.7, 4.8, 4.9, 4.12, 4.13, 4.15, 5.9, 6.4, 6.5, 6.6, 6.15, 6.16_

  - [x]* 5.7 Write unit tests for the record and sessions routes
    - File: `tests/unit/record-routes.test.ts`.
    - Invalid name or URL, extra field, `user:pass@` address and control characters give 400 with `field` and start nothing (the route half of Property 1), 405, 409, status body without typed values.
    - _Requirements: 3.10, 3.11, 4.1, 4.2, 4.10, 4.11, 4.16_

  - [x]* 5.8 Write property test for the Application_Key and session file name
    - File: `tests/property/studio-recording.property.test.ts`.
    - **Property 14: Application key and session file correspond**
    - **Validates: Requirements 6.1**

  - [x]* 5.9 Write property test for at most one recording under concurrency
    - Same file. 2 to 20 concurrent valid starts, at least 100 runs.
    - **Property 11: At most one recording under concurrency**
    - **Validates: Requirements 4.4, 4.5, 14.5**

  - [x]* 5.10 Write property test for the state machine edges
    - Same file.
    - **Property 12: The recording state machine follows its edges**
    - **Validates: Requirements 4.9, 4.14**

  - [x]* 5.11 Write property test for the status content
    - Same file.
    - **Property 13: Status holds step labels only**
    - **Validates: Requirements 4.10, 4.11**

  - [x]* 5.12 Write property test for plain-name fields of the sessions routes
    - Same file. The session folder is byte-identical before and after.
    - **Property 19: Plain-name fields reject path forms** (`applicationKey`)
    - **Validates: Requirements 13.9**

  - [x]* 5.13 Write integration test for recording with a real browser (depends on G1 and G4)
    - File: `tests/integration/studio-record.test.ts`. Run only after G1 (group 3) and G4 (group 6) are complete, because it uses the real `record()` and the real Compile_Runner.
    - One test ends with `POST /api/record/stop`, one with "Finish and save" in the panel. Each checks 202, a second start 409 with the session unchanged, status state, count and at most 3 labels, no typed value in the status, stop outside `recording` gives 409, and the compile starts within 1 second of success.
    - _Requirements: 4.3, 4.4, 4.6, 4.7, 4.8, 4.10, 4.11, 7.1, 14.4_

- [x] 6. G4 Compile and Power
  - [x] 6.1 Add `onPhase` to `compile()` and `Compiler`
    - Files: `src/cli/commands/compile.ts`, `src/compiler/compiler.ts`. Type `CompilePhase`; `compile()` calls `generating` first and `installing` before the installer; `Compiler.compile` calls `writing` before its first file system write. The CLI does not pass it and its output does not change.
    - _Requirements: 7.7, 7.10, 7.11_

  - [x] 6.2 Implement `compile-runner.ts` and `messages/compile.ts`
    - `tryStart`, `runExclusive`, `status`, `close`, `install: true` only when `node_modules` is absent, default compile options, `quietInstaller` with the 600 s timeout and tree kill, `scrubMessage`, `playground.stop()` after success and after a failure that wrote files.
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13_

  - [x] 6.3 Implement `routes/compile.ts`
    - `POST /api/compile` (empty body, 202 or 409, `remote: 'blocked'`) and `GET /api/compile/status` (`remote: 'allowed'`, HEAD allowed).
    - _Requirements: 7.2, 7.7, 7.13, 7.14_

  - [x] 6.4 Implement `mcp-snippet.ts`
    - Rebuild the server entry: `type`, `command: 'node'`, absolute `mcp-server.js` path, and `env` holding only `${DAEMONIZE_SECRET_*}`, allowed `DAEMONIZE_MODEL_*` placeholders and `DAEMONIZE_MODE: 'strict'`. Export the snippet text builder.
    - _Requirements: 11.5, 11.14, 11.15, 11.16_

  - [x] 6.5 Implement `power-installer.ts`
    - `info`, `preview` (validation order from the design, confirmation map with 10 min expiry and at most 8 entries), `install` (id and exact `kiroPath` match, re-validation, buffers built first, temp files with `wx`, two renames, restore on failure), `snippet`.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.17, 11.18_

  - [x] 6.6 Implement `routes/power.ts`
    - `GET /api/power/info` (with `outputPath`), `GET /api/power/snippet`, `POST /api/power/preview`, `POST /api/power/install`. All `remote: 'blocked'`, `PowerError` status mapped to `{ error }`.
    - _Requirements: 11.1, 11.2, 11.3, 11.12, 11.13, 11.19_

  - [x]* 6.7 Write unit tests for `onPhase`
    - File: `tests/unit/compile-onphase.test.ts`.
    - Order of events, `writing` before the first write, a plain-secret failure emits no `writing`, the CLI passes no `onPhase`.
    - _Requirements: 7.7, 7.10, 7.11_

  - [x]* 6.8 Write unit tests for the Compile_Runner
    - File: `tests/unit/compile-runner.test.ts`, with a fake `compile()`.
    - `install` flag, status and phase while running, second start 409, `playground.stop()` after success, 600 s timeout with fake timers, `close()` kills the install.
    - _Requirements: 7.4, 7.5, 7.7, 7.8, 7.9, 7.13, 14.10_

  - [x]* 6.9 Write unit tests for the Power_Installer and the snippet
    - Files: `tests/unit/power-installer.test.ts`, `tests/unit/mcp-snippet.test.ts`.
    - No write before a matching confirmation, every refusal in 11.7 to 11.9 and 11.11, invalid `mcp.json` gives 409 and stays byte-identical, merge keeps other entries, replace notice, no secret value written, snippet placeholders only.
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.14, 11.15, 11.16, 11.17, 11.18, 14.11_

  - [x]* 6.10 Write unit tests for the compile and power routes
    - File: `tests/unit/compile-power-routes.test.ts`.
    - Status codes, `Allow` headers, remote refusal, sample mode, `{ error }` bodies.
    - _Requirements: 7.2, 7.13, 7.14, 11.12, 11.13_

  - [x]* 6.11 Write property test for the compile status
    - File: `tests/property/studio-compile-power.property.test.ts`.
    - **Property 17: The compile status follows the phase events**
    - **Validates: Requirements 7.4, 7.5, 7.7, 7.10, 7.11, 7.13**

  - [x]* 6.12 Write property test for compile error messages
    - Same file.
    - **Property 18: Error messages carry no path and no secret** (compile runner)
    - **Validates: Requirements 7.10, 7.11, 4.12**

  - [x]* 6.13 Write property test for the install confirmation
    - Same file.
    - **Property 20: Install needs the displayed path and id**
    - **Validates: Requirements 11.3**

  - [x]* 6.14 Write property test for workspace validation and confinement
    - Same file.
    - **Property 21: Workspace validation and write confinement**
    - **Validates: Requirements 11.7, 11.8, 11.9, 11.11**

  - [x]* 6.15 Write property test for merging
    - Same file.
    - **Property 22: Merging keeps other entries; invalid settings are untouched**
    - **Validates: Requirements 11.4, 11.17, 11.18**

  - [x]* 6.16 Write property test for placeholders only
    - Same file.
    - **Property 23: Installed files and the snippet hold placeholders only**
    - **Validates: Requirements 11.5, 11.6, 11.14, 11.15, 11.16**

  - [x]* 6.17 Write integration test for the Power flow
    - File: `tests/integration/studio-power.test.ts`, with a real temp workspace and a compiled sample Output_Dir.
    - Preview, install, merge into an existing `mcp.json`, written paths inside the real `.kiro`, placeholders listed, snippet contents, compile route status while a fake long compile runs.
    - _Requirements: 11.2, 11.4, 11.5, 11.10, 11.12, 11.14, 11.18_

- [x] 7. G5 UI and docs
  - [x] 7.1 Create the UI helper modules
    - `js/copy.js` (all main-path strings and `statusText`), `js/validate.js` (mirror of `validate-action.ts`), `js/announcer.js` (`announceOnChange`), `js/dialog.js` (`openDialog`: role, `aria-modal`, `inert`, focus trap, Escape, focus return).
    - _Requirements: 3.6, 3.7, 3.8, 12.1, 12.7, 12.8, 12.9_

  - [x] 7.2 Extend `js/api.js`
    - Shared `postJson` and no-cache `getFresh`, and the methods for the new routes. A missing `workflowFileExists` is read as true.
    - _Requirements: 3.9, 3.13, 4.17, 12.12_

  - [x] 7.3 Implement the welcome panel, the new-action form and the Overview changes
    - `js/views/welcome.js`, `js/views/new-action.js`, edits in `js/views/overview.js`. Labels linked with `for`, trim and validation, `aria-invalid` and `aria-describedby`, focus on the first invalid field, `role="alert"` for server errors, Cancel returns focus, session hint within 1 second with only the Application_Key sent.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.12, 3.13, 3.14, 12.4, 12.5, 12.6_

  - [x] 7.4 Implement the credentials view
    - `js/views/credentials.js`: rows from `GET /api/secrets`, sentence-case names, kind words, "Configured" and "Missing" text, masked input with label and `autocomplete="off"`, Save and Remove rules, 10 s abort, input cleared in `finally`, help text for authenticator keys, "No credentials needed", error with Retry, no value in URL, storage, cookie, attribute or text node.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 12.10_

  - [x] 7.5 Implement the connect card and dialog
    - `js/views/connect.js`: folder field prefilled from `GET /api/power/info`, preview dialog with exact `kiroPath`, file outcomes and the replace notice, Confirm and Cancel, success screen with written paths and placeholder names, "Copy MCP configuration" through `copyButton`, "Add as a Kiro Power instead" with the Output_Dir path and import steps. Paths in `code.path`.
    - _Requirements: 11.1, 11.2, 11.10, 11.12, 11.14, 11.17, 11.18, 11.19, 12.8, 12.9_

  - [x] 7.6 Implement the recording status view
    - `js/views/record-status.js` for `#/record`: polling at 1500 ms with `getFresh`, compile phase text, last 3 labels, Stop only while recording, "Connection lost" notice, "Test it" link and Connect card on `done`, message and recovery file on `error`, polling stops on `done` and `error`, `announceOnChange`.
    - _Requirements: 4.17, 4.18, 7.15, 12.7, 12.10_

  - [x] 7.7 Wire the features and finish the shared UI files
    - Fill `js/features.js` with the `record` and `credentials` routes and views. Edit `js/views/workflows.js` (Credentials link, saved-session text and "Forget session" button), `js/views/playground.js` (Configured and Missing per secret, notice with link, "Test it" target), and `app.css` (new classes only, no `outline: none`, outline of at least 2 px).
    - Hide "+ New action", Credentials links, Connect and Recompile when `isStatic` or `overview.sample === true`, and show the demo note on the two new routes. Confirm `scripts/build-studio-demo.mjs` needs no new data file and add whatever small change it needs.
    - _Requirements: 6.13, 9.6, 9.7, 12.2, 12.3, 12.11, 12.12, 12.13, 14.18_

  - [x] 7.8 Update the existing UI tests (R13.11)
    - `tests/unit/studio-ui-modules.test.ts`: the empty Overview text is now the welcome screen, and the module list gains `features`, `copy`, `validate`, `dialog`, `announcer`.
    - `tests/integration/studio-ui.test.ts`: where it asserts the empty Overview text. Other `tests/integration/studio-ui*.test.ts` files change only if they assert the empty Overview.
    - _Requirements: 3.1, 13.11, 14.20_

  - [x] 7.9 Write the docs (README, `docs/studio.md`, CLI help text)
    - `README.md`: new "Studio-first" section with the cycle (`daemonize`, new action, record, credentials, test, connect), the browser fallback and `DAEMONIZE_CHROMIUM_PATH`, `DAEMONIZE_DATA_DIR`, and the note that a home folder inside a git repository needs `DAEMONIZE_DATA_DIR`.
    - `docs/studio.md`: the new routes, the guard rules, the vault and session storage, the Power install files, and the `daemonize --help` text as set by task 3.3. The help string itself lives in `src/cli/index.ts` (G1 owns that file).
    - _Requirements: 1.1, 1.7, 5.1, 6.2, 8.1, 11.4_

  - [x]* 7.10 Write unit tests for the copy lint
    - File: `tests/unit/studio-ui-copy.test.ts`.
    - Lint `js/copy.js` and every export of `src/studio/messages/*.ts` against the eight Plain_Language terms, excluding `code.path`, secret names and the "Copy MCP configuration" text.
    - _Requirements: 12.1_

  - [x]* 7.11 Write unit tests for the UI validators
    - File: `tests/unit/studio-ui-validate.test.ts`.
    - Fixed examples for names and addresses, and equality with `validate-action.ts`.
    - _Requirements: 3.6, 3.7, 3.8_

  - [x]* 7.12 Write property test for the UI validator mirror
    - File: `tests/property/studio-ui.property.test.ts`.
    - **Property 1: Action input validation** (UI module equals the server module for every pair)
    - **Validates: Requirements 3.6, 3.7, 3.8**

  - [x]* 7.13 Write property test for announcements
    - Same file.
    - **Property 25: One announcement per state change**
    - **Validates: Requirements 12.7**

  - [x]* 7.14 Write property test for plain-language copy
    - Same file. Runs after the messages of G2, G3 and G4 exist.
    - **Property 24: Plain-language copy**
    - **Validates: Requirements 10.2, 12.1**

  - [x]* 7.15 Write integration test for the first flow in a real browser (depends on G1, G2, G3 and G4)
    - File: `tests/integration/studio-ui-first-flow.test.ts`. Run only after groups 3, 4, 5 and 6 are complete.
    - Welcome screen, new-action form, credentials panel and Connect dialog with the keyboard alone, linked labels, announcements for each state change and each save, focus trap, Escape and focus return, input cleared and value absent from the DOM after a save, outline of at least 2 px, zero CSP violations and zero cross-origin requests.
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 12.2, 12.3, 12.4, 12.7, 12.8, 12.9, 12.12, 14.15_

- [x] 8. Checkpoint - Groups G1 to G5 merged
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Final checkpoint
  - [x] 9.1 Run `npm run build`
    - Write the output to a uniquely named file, for example `$env:TEMP\studio-first-flow-build-<timestamp>.txt`. Report the exit code and the number of TypeScript errors (expected 0). Check that `dist/studio/ui/js/features.js` exists.
    - _Requirements: 14.17_

  - [x] 9.2 Run `npm run studio:build`
    - Output to `$env:TEMP\studio-first-flow-studio-build-<timestamp>.txt`. Report the exit code and that `dist-demo/index.html` exists with no vault, session or App_Data_Dir content.
    - _Requirements: 14.18_

  - [x] 9.3 Run `npm run check:secrets`
    - Output to `$env:TEMP\studio-first-flow-check-secrets-<timestamp>.txt`. Report the exit code (expected 0) and the number of findings. Also run `git check-ignore` for `secrets.vault.json`, `vault.key` and a `<hash>.storage-state.json` name.
    - _Requirements: 13.12, 14.19_

  - [x] 9.4 Run `npm test`
    - Output to `$env:TEMP\studio-first-flow-test-<timestamp>.txt`. Report the exact counts for both projects (test files passed, failed and skipped; tests passed, failed and skipped) and the exit code. Fix any failure in the owning group's files and run again.
    - _Requirements: 14.1, 14.2, 14.20_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Core implementation tasks, the existing-test updates and the final checkpoint are never optional.
- Every property file holds one sub-task per property, so the sub-tasks of one file sit in different waves of the graph.
- Manual platform checks from the design (macOS `security -i` with a `ps` check, Linux `secret-tool` with and without a keyring, Windows DPAPI round trip) are for the maintainer and are not coding tasks. The key provider unit tests (4.8) use a fake `spawn`.
- The CLI help string is set in `src/cli/index.ts` by task 3.3 (G1 owns that file). The docs task 7.9 (G5) documents it.
- Design changes made with this task list: Requirement 12.1 now exempts `code.path` file paths; Requirements 3.7 and 3.8 include the control-character and credential-in-address rules; session storage files stay plain JSON.

### Existing tests that change (Requirement 13.11)

| Existing test | Owner | Task | Reason |
|---|---|---|---|
| `tests/integration/studio-server.test.ts` | G0 | 1.7 | A missing Workflow_File now answers 200 with zero Actions instead of 500. Invalid-file errors become the three fixed messages. `/api/overview` gains three fields. |
| `tests/integration/studio-ui.test.ts` | G5 | 7.8 | The empty Overview now shows the welcome screen. |
| `tests/unit/studio-ui-modules.test.ts` | G5 | 7.8 | The empty Overview text changes and new UI modules exist. |
| `tests/integration/cli.test.ts` | G1 | 3.4 | Bare `daemonize` starts the Studio and no longer prints the help. |
| `tests/unit/playground.test.ts` | G2 | 4.6 | `configuredSecretVariables()` includes vault names and the child environment can hold vault values. |

All other existing Studio server, playground, redaction, recording panel and compiler tests must pass unchanged.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5", "1.6"] },
    { "id": 4, "tasks": ["1.7", "1.8", "1.9", "1.10"] },
    { "id": 5, "tasks": ["1.11", "1.13", "1.14", "3.1", "3.3", "4.1", "4.2", "4.4", "5.1", "6.1", "6.4", "7.1", "7.2"] },
    { "id": 6, "tasks": ["1.12", "3.2", "3.4", "3.5", "3.6", "3.8", "4.3", "4.5", "4.6", "4.7", "4.8", "4.10", "4.12", "5.2", "5.3", "5.5", "5.8", "6.2", "6.5", "6.7", "7.3", "7.4", "7.5", "7.11", "7.12"] },
    { "id": 7, "tasks": ["3.7", "3.9", "3.10", "4.9", "4.11", "4.13", "5.4", "5.6", "6.3", "6.6", "6.8", "6.9", "6.11", "7.6", "7.13"] },
    { "id": 8, "tasks": ["4.14", "4.22", "5.7", "5.9", "6.10", "6.12", "6.17", "7.7"] },
    { "id": 9, "tasks": ["4.15", "5.10", "6.13", "7.8", "7.9", "7.10", "7.14"] },
    { "id": 10, "tasks": ["4.16", "5.11", "6.14"] },
    { "id": 11, "tasks": ["4.17", "5.12", "6.15"] },
    { "id": 12, "tasks": ["4.18", "6.16"] },
    { "id": 13, "tasks": ["4.19", "5.13"] },
    { "id": 14, "tasks": ["4.20"] },
    { "id": 15, "tasks": ["4.21"] },
    { "id": 16, "tasks": ["7.15"] },
    { "id": 17, "tasks": ["9.1"] },
    { "id": 18, "tasks": ["9.2"] },
    { "id": 19, "tasks": ["9.3"] },
    { "id": 20, "tasks": ["9.4"] }
  ]
}
```
