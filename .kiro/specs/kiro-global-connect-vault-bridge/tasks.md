# Implementation Plan: kiro-global-connect-vault-bridge

## Overview

The implementation language is TypeScript for `src/` and the tests, and plain ES modules for `src/studio/ui` (as the design states). Work follows the design's "Implementation groups".

- **Group G5** (test environment, the preparatory step) runs first, then **group G0** (seam and contracts). Both are serial.
- **Groups G1a, G1b, G1c, G2, G3a, G3b, G4a, G4b** then run in parallel. Each group edits only the files listed as owned at the top of the group. A group that needs a change in a file it does not own writes the request in its hand-off note for the owner. No group after G0 edits `contracts.ts`, `services.ts`, `server.ts`, `inert-services.ts` or `routes/types.ts`.
- To keep files disjoint inside and across groups, each property test has its own file (`tests/property/<topic>.property.test.ts`). The design's grouped file names are split accordingly.
- Property tests use `fast-check` with at least 100 runs and a first-line tag `// Feature: kiro-global-connect-vault-bridge, Property N: <title>`. Tests use a fake home, a fake `DAEMONIZE_DATA_DIR` and the `file` test key provider with `NODE_ENV=test`. No test touches the real `~/.kiro`.
- **Group G6** (integration test) and the final checkpoint run last. The work stops after the final report. Step 2 (`.vsix`) and Step 3 (persistent profile, Chrome extension, semantic firewall) are not started.
- Cross-group dependencies: G1b needs the reader signatures of G1a. G1c needs the vault methods of G1a. G2 compile runner needs `CompileOptions.powerName` from G1b. G3b needs the module signatures of G3a. G6 needs every group.

## Tasks

- [x] 1. G5 Test environment (Préalable, serial, first)
  - Owns: `vitest.config.ts`, `tests/setup/clean-env.ts`, `tests/helpers/env-scrub.ts`, `tests/helpers/with-env.ts`, `tests/property/secrets-studio.property.test.ts`, `tests/property/env-scrub.property.test.ts`, `tests/unit/vitest-config.test.ts`, `tests/unit/with-env.test.ts`, and edits to existing tests that depend on ambient `DAEMONIZE_*` variables.

  - [x] 1.1 Create the env scrub helpers and the setup file
    - `tests/helpers/env-scrub.ts`: pure `scrubEnv` (returns a copy) and `isScrubbed` for `DAEMONIZE_SECRET_*`, `DAEMONIZE_MODEL_*`, `DAEMONIZE_DATA_DIR`, `DAEMONIZE_APP_KEY`.
    - `tests/helpers/with-env.ts`: `withEnv(vars, body)` that sets variables and restores previous value or absence in `finally`.
    - `tests/setup/clean-env.ts`: deletes the matching names from `process.env` at import.
    - _Requirements: 1.1, 1.3_

  - [x] 1.2 List the setup file in every vitest project
    - Edit `vitest.config.ts` so `./tests/setup/clean-env.ts` is in `setupFiles` of both the `fast` and the `integration` project, and of any other project the file defines.
    - _Requirements: 1.2_

  - [x] 1.3 Keep the whole-name boundary in the secrets property test
    - In `tests/property/secrets-studio.property.test.ts`, make the name search use `(?![A-Za-z0-9_])` after the name, so `DAEMONIZE_SECRET_PASSWORD` does not match inside `DAEMONIZE_SECRET_PASSWORD_2`.
    - _Requirements: 1.4_

  - [x] 1.4 Fix existing tests that depend on ambient variables
    - Run `npx vitest run` with `DAEMONIZE_SECRET_PASSWORD` set, then with all the scrubbed variables set, and make every test that needs one of them set it through `withEnv`.
    - Run `npx tsc --noEmit` and require 0 errors.
    - _Requirements: 1.3, 1.5, 1.6, 1.7_

  - [x]* 1.5 Write property test for test environment scrubbing
    - File: `tests/property/env-scrub.property.test.ts`.
    - **Property 1: Test environment scrubbing**
    - **Validates: Requirements 1.1**

  - [x]* 1.6 Write smoke test that every vitest project lists the setup file
    - File: `tests/unit/vitest-config.test.ts`. Import the config and assert `fast` and `integration` both list `clean-env.ts`.
    - _Requirements: 1.2_

  - [x]* 1.7 Write unit tests for `withEnv`
    - File: `tests/unit/with-env.test.ts`. Restore after a passing and after a throwing body, for a variable that existed and for one that was absent.
    - _Requirements: 1.3_

- [x] 2. G0 Seam and contracts (serial, after G5)
  - Owns: `src/studio/contracts.ts`, `src/studio/inert-services.ts`, `src/studio/services.ts`, `src/studio/server.ts`, `src/studio/routes/types.ts`, `src/cli/commands/studio.ts` (only if `home` needs plumbing), `tests/unit/studio-seam.test.ts`, and edits to existing tests broken by the `RouteContext` and `StudioServices` shape changes.

  - [x] 2.1 Add the new contracts
    - `contracts.ts`: `InstallScope`, `PowerInfo`, `PowerPreview`, `InstallSummary`, `AutoAddState`, `AutoAddOutcome`, `ActiveApplication`, `ApplicationLocator`, the extended `SecretVault` (`setFor`, `removeFor`, `namesFor`, `snapshotFor`) and the extended `PowerInstaller` (`preview`, `install`, `remove`, `getAutoAdd`, `disableAutoAdd`, `runAutoAdd`).
    - `routes/types.ts`: `RouteContext.activeApplication()`, keeping `outDir` as the base folder.
    - Signatures exactly as in the design so that wave-2 groups compile against stubs.
    - _Requirements: 2.8, 4.3, 5.11, 6.1, 6.4_

  - [x] 2.2 Update inert services and `services.ts`
    - `inert-services.ts`: inert versions of every new method (sample mode answers as before).
    - `services.ts`: build `AppNames`, `ApplicationLocator`, `InstallRecords` and `AutoAddStore` through stub factories whose real files are owned by G2 and G3a, and pass `home` to the Power_Installer.
    - _Requirements: 4.2, 5.6_

  - [x] 2.3 Edit `server.ts` (the seam)
    - Keep a synchronous `activeOutDir`, refreshed after `current()` at startup, after each `load()` and after each finished compile. Use it in `loadLive`, `readOutputs`, `runPbtSuite`, `RouteContext` and pass `() => activeOutDir` to the Playground.
    - Add `StudioOptions.home` (test seam) and `RouteContext.activeApplication`.
    - After a successful Playground call (`status 200` and `success: true`) call `services.power.runAutoAdd()` and add `autoAdd` to the body when its status is not `disabled`. The existing redaction still wraps the body.
    - Change no CLI command, flag or default output.
    - _Requirements: 4.3, 4.17, 5.11, 5.12, 5.14_

  - [x] 2.4 Update existing tests broken by shape changes
    - Fix the tests that build `RouteContext`, `StudioServices` or `PowerInstallerDeps` by hand. Change only what the new shapes require.
    - _Requirements: 1.5, 1.6_

  - [x]* 2.5 Write unit tests for the seam
    - File: `tests/unit/studio-seam.test.ts`, with fake services.
    - `activeOutDir` follows the locator after load and compile. The auto-add hook runs once after a successful call, never after a failed one, and adds `autoAdd` only when not `disabled`.
    - _Requirements: 4.3, 4.5_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. G1a Vault format, reader, Studio vault (parallel)
  - Owns: `src/replay/runtime/vault-format.ts`, `src/replay/runtime/vault-reader.ts`, `src/studio/secret-vault.ts`, `src/studio/key-providers.ts` (import shared constants only), `tests/property/vault-scoped.property.test.ts`, `tests/property/vault-precedence.property.test.ts`, `tests/property/vault-roundtrip.property.test.ts`, `tests/property/vault-reader-failures.property.test.ts`, `tests/property/vault-reader-readonly.property.test.ts`, `tests/property/vault-redaction.property.test.ts`, `tests/unit/vault-reader.test.ts`, `tests/unit/secret-vault-scoped.test.ts`.

  - [x] 4.1 Write `vault-format.ts`
    - Pure, imports only `node:crypto`: constants (`VAULT_FILE`, `VAULT_AAD`, `KEY_BYTES`, `KEY_SERVICE`, `LINUX_KEY_ATTRS`, DPAPI scripts), `encryptVault`, `decryptVault`, `scopedKey`, `isScopedKey`, `parseHexKey`, `isUnexpandedPlaceholder`, `secretNameOf`, `pickSecret`.
    - _Requirements: 6.4, 7.1, 7.5, 7.12, 7.13_

  - [x] 4.2 Write `vault-reader.ts`
    - Standalone, imports only `node:*` and `./vault-format.js`. Implement `withResolvedSecrets` and `resolveDataDir`: resolve explicit, then scoped (skipped when `DAEMONIZE_APP_KEY` is empty), then generic; touch no file when every variable is explicit; read and decrypt at most once per call; read-only; 5 s key-store limit; swallow every failure and leave the variable unset; no module-level cache.
    - Key providers for win32, darwin, linux and the test providers gated by `NODE_ENV === 'test'` (`file` reads `vault.key.test`, `memory` returns no key).
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.9, 7.11, 7.12, 7.16_

  - [x] 4.3 Extend `secret-vault.ts` with scoped entries
    - Add `setFor`, `removeFor`, `namesFor`, `snapshotFor`. `names`, `has`, `set`, `remove`, `snapshot` act on generic keys (no `/`) only. `values()` returns every value. Re-export `encryptVault`, `decryptVault`, `VAULT_FILE` from `vault-format.ts`. Reuse `exclusive`, `keyForWrite` and the atomic write unchanged.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.9, 6.10_

  - [x] 4.4 Point `key-providers.ts` at the shared constants
    - Import the DPAPI scripts and key constants from `vault-format.ts` and re-export them. No behaviour change.
    - _Requirements: 7.5_

  - [x]* 4.5 Write property test for vault isolation
    - File: `tests/property/vault-scoped.property.test.ts`.
    - **Property 14: Vault isolation between applications**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 6.10, 6.11**

  - [x]* 4.6 Write property test for secret precedence
    - File: `tests/property/vault-precedence.property.test.ts`. Covers the reader, the Studio vault resolution and the Playground launch, and "no file opened when every variable is explicit".
    - **Property 15: Secret precedence**
    - **Validates: Requirements 6.4, 6.7, 7.1, 7.11, 7.12, 7.13, 7.16**

  - [x]* 4.7 Write property test for the Studio write then reader read round trip
    - File: `tests/property/vault-roundtrip.property.test.ts`. Unicode, quotes, spaces, long strings, generic and scoped names.
    - **Property 16: Studio write then reader read round trip**
    - **Validates: Requirements 7.5, 7.14, 7.15**

  - [x]* 4.8 Write property test for reader failures
    - File: `tests/property/vault-reader-failures.property.test.ts`. Missing, truncated, flipped, random, wrong key, unavailable and slow provider.
    - **Property 17: Reader failures never leak**
    - **Validates: Requirements 7.7, 8.10**

  - [x]* 4.9 Write property test that the reader is read-only
    - File: `tests/property/vault-reader-readonly.property.test.ts`. Same bytes, same modification times, same directory listing before and after.
    - **Property 18: The reader is read-only**
    - **Validates: Requirements 7.4**

  - [x]* 4.10 Write property test for redaction of resolved values
    - File: `tests/property/vault-redaction.property.test.ts`.
    - **Property 19: Resolved values are redacted**
    - **Validates: Requirements 7.8**

  - [x]* 4.11 Write unit tests for the reader
    - File: `tests/unit/vault-reader.test.ts`. One test each: (a) key provider unavailable, (b) corrupt vault, (c) missing vault, (d) Unexpanded_Placeholder, all asserting `missing_secret` naming the variable and no value, key or vault path; (e) successful read leaves the vault bytes and modification time unchanged. One test counts key-provider calls for several variables in one call (at most one).
    - _Requirements: 7.4, 7.7, 7.9, 7.12, 10.5_

  - [x]* 4.12 Write unit tests for scoped vault methods
    - File: `tests/unit/secret-vault-scoped.test.ts`. Old vault without scoped keys still works, empty value refused, `values()` covers both kinds.
    - _Requirements: 6.3, 6.9_

- [x] 5. G1b Generator (parallel)
  - Owns: `src/compiler/compiler.ts`, `src/compiler/mcp-generator.ts`, `src/replay/runtime/step-plan.ts`, `tests/unit/generated-vault-reader.test.ts`, `tests/unit/generated-no-src-import.test.ts`.

  - [x] 5.1 Add `secretVariables` to `step-plan.ts`
    - Additive: returns `DAEMONIZE_SECRET_<ref>` for every `secretRef` of the steps. Existing functions unchanged.
    - _Requirements: 7.1_

  - [x] 5.2 Emit the reader files and add `powerName` in `compiler.ts`
    - Read `vault-format.ts` and `vault-reader.ts` like `totp.ts`, and write `.ts` plus transpiled `.js` of both whenever `mcp-server.js` is written (web and terminal targets).
    - Add `CompileOptions.powerName?: string`.
    - _Requirements: 7.6, 5.10_

  - [x] 5.3 Resolve secrets once per call in every replay variant
    - In `WEB_RUNTIME`, `WEB_RUNTIME_HTTP`, the terminal runtime and `replayInDocker`: `const env = await withResolvedSecrets(process.env, [...secretVariables(steps), ...httpVariables])`, then use `env` in `missingSecrets`, `secretValues`, `resolveStepValue` and `runHttpStep`. Add the `import { withResolvedSecrets } from "./vault-reader.js"` line to the generated `replay.ts`. In Docker, forward the resolved `env` with `-e NAME`. Leave non-secret `process.env` reads alone.
    - Keep the `missing_secret` response shape unchanged.
    - _Requirements: 7.1, 7.8, 7.10_

  - [x]* 5.4 Write unit tests for generated output
    - File: `tests/unit/generated-vault-reader.test.ts`. Output holds `vault-reader.ts/.js` and `vault-format.ts/.js` for a web and a terminal target. Generated `replay` calls the reader once per call. Compile without `powerName` gives the same files as before.
    - _Requirements: 7.6, 5.14_

  - [x]* 5.5 Write test that the generated reader has no import from `src/`
    - File: `tests/unit/generated-no-src-import.test.ts`. Parse `vault-reader.ts/.js` and `vault-format.ts/.js` and assert no `import` or `require` specifier resolves inside `src/`, relative or absolute.
    - _Requirements: 7.6, 10.7_

- [x] 6. G1c Secrets route and Playground (parallel)
  - Owns: `src/studio/routes/secrets.ts`, `src/studio/messages/secrets.ts`, `src/studio/playground.ts`, `tests/unit/secrets-routes.test.ts`, `tests/unit/playground-vault-env.test.ts`, `tests/property/bridge-no-leak-secrets.property.test.ts`.

  - [x] 6.1 Add the `application` field to the secrets routes
    - `GET /api/secrets?application=<origin>` (default: active application key) answers `{ application?, secrets: [{ name, kind, configured }] }` using `namesFor` or `names`, plus environment. `POST /api/secrets` and `POST /api/secrets/forget` accept an optional `application` that must equal `applicationKey(value)`, else 400 `SECRET_APPLICATION_INVALID`. With it call `setFor` or `removeFor`, without it `set` or `remove`. Keep the existing 400 and 503 answers with no value, key or vault path. Stop a running child server after a change.
    - _Requirements: 6.1, 6.5, 6.6, 6.8, 6.9, 6.10_

  - [x] 6.2 Change Playground precedence and options
    - `outDir: string | (() => string)`, `applicationKey?: () => string | undefined`. `launchSpec` uses `snapshotFor(key)` when a key exists, else `snapshot()`. An environment value that is non-empty and not an Unexpanded_Placeholder wins, then scoped, then generic (via `pickSecret`). This reverses the old "vault wins" rule on purpose. `configuredSecretVariables` uses `namesFor(key)`.
    - _Requirements: 6.7, 7.1, 7.12_

  - [x] 6.3 Update the existing Playground vault-precedence test
    - In `tests/unit/playground-vault-env.test.ts`, change the assertion of the old "vault wins" order to environment over scoped over generic, with the reason in a comment.
    - _Requirements: 6.7_

  - [x]* 6.4 Write unit tests for the secrets routes
    - File: `tests/unit/secrets-routes.test.ts`. Without `application` behaves as before; with an invalid origin 400; names and booleans only; empty value 400; write failure 503 with no value, key or path in the message.
    - _Requirements: 6.5, 6.6, 6.8, 6.9_

  - [x]* 6.5 Write unit tests for Playground precedence
    - Same file as 6.3 is excluded; use `tests/unit/playground-scoped-env.test.ts`. Environment over scoped over generic, placeholder ignored, active application key used.
    - _Requirements: 6.7, 7.12_

  - [x]* 6.6 Write property test for no stored value in secrets responses
    - File: `tests/property/bridge-no-leak-secrets.property.test.ts` (the secrets half of the property; the install half is task 9.19).
    - **Property 20: No stored value appears outside the vault**
    - **Validates: Requirements 6.5, 6.8, 8.11**

- [x] 7. G2 Names and compile (parallel)
  - Owns: `src/studio/app-names.ts`, `src/studio/active-app.ts`, `src/studio/compile-runner.ts`, `src/studio/messages/compile.ts`, `src/compiler/kiro-power-generator.ts`, `tests/property/app-slug.property.test.ts`, `tests/property/app-names-map.property.test.ts`, `tests/unit/app-names.test.ts`, `tests/unit/compile-runner-target.test.ts`, `tests/unit/kiro-power-generator-name.test.ts`, and edits to existing tests of the `SKILL.md` and `POWER.md` secret wording.

  - [x] 7.1 Write `app-names.ts`
    - `deriveSlug` (host, port when not default, lowercase, hyphen runs, punycode via `domainToASCII`, 48-character cut rule, Action-name fallback, `app` when empty), `withSuffix`, `mapKey`, `sourceOfSet`, `AppNamesError`, `createAppNames` with `peek` and `ensure`. `ensure` serializes calls, writes `app-names.json` through temp plus rename with mode 0600 and a 1 MiB limit, and throws `AppNamesError` with no write when the map is unreadable, invalid or unwritable.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 7.2 Write `active-app.ts`
    - `createApplicationLocator`: `current()` reads only (Name_Map entry with a compiled folder, else a compiled `daemonize-out` as legacy keeping its `mcp.json` server key, else the peeked slug); `prepareCompile()` creates the Name_Map entry before any output and returns the sibling folder `join(dirname(baseOutDir), slug)`. Legacy folder files stay unchanged.
    - _Requirements: 5.6, 5.11, 5.12, 5.13_

  - [x] 7.3 Compile into the per-application folder
    - `compile-runner.ts`: replace `outDir` with `target: () => Promise<{ outDir; slug }>`, call it at the start of `run()`, pass `powerName: slug` to `compile`, report `AppNamesError` as a plain failure with no file written and `APP_NAME_NOT_SAVED` in `messages/compile.ts`. A new folder gets its own `npm install`. Never write into `daemonize-out` for an application without a Name_Map entry.
    - _Requirements: 5.9, 5.11, 5.13_

  - [x] 7.4 Use the slug and vault wording in the Power generator
    - `kiro-power-generator.ts`: `name = options.powerName ?? toKebabCase(set.targetName)` for the plugin name, the `mcp.json` server key and the `skills/<name>` folder. Replace the "Secrets" paragraph of `SKILL.md` and `POWER.md` with the vault statement of the design (names only, no value). The CLI does not pass `powerName`, so CLI output is unchanged. Update the existing tests that assert the old wording.
    - _Requirements: 5.10, 5.14, 8.8_

  - [x]* 7.5 Write property test for slug validity and determinism
    - File: `tests/property/app-slug.property.test.ts`.
    - **Property 12: Slug validity and determinism**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.16**

  - [x]* 7.6 Write property test for Name_Map uniqueness and stability
    - File: `tests/property/app-names-map.property.test.ts`. Reload from disk between calls.
    - **Property 13: Name_Map uniqueness and stability**
    - **Validates: Requirements 5.7, 5.8, 5.15, 5.16**

  - [x]* 7.7 Write unit tests for `app-names`
    - File: `tests/unit/app-names.test.ts`. `https://cycyly.vercel.app` gives `cycyly-vercel-app`, `http://localhost:3000` gives `localhost-3000`, an internationalized host, a 60-character host, an empty Action name gives `app`, unreadable map writes nothing.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.9_

  - [x]* 7.8 Write unit tests for the compile target
    - File: `tests/unit/compile-runner-target.test.ts`. Name_Map entry exists before `compile` is called, output goes to the sibling `<slug>` folder and never into `daemonize-out`, a legacy folder stays byte-identical and keeps its server key, an unwritable map writes no output.
    - _Requirements: 5.6, 5.9, 5.11, 5.12, 5.13_

  - [x]* 7.9 Write unit tests for the generator name and wording
    - File: `tests/unit/kiro-power-generator-name.test.ts`. `powerName` sets plugin name, server key and skill folder; without it the CLI output is unchanged; `SKILL.md` and `POWER.md` hold the vault statement and no value.
    - _Requirements: 5.10, 5.14, 8.8_

- [x] 8. G3a Install core (parallel)
  - Owns: `src/studio/power-config.ts`, `src/studio/power-fs.ts`, `src/studio/install-records.ts`, `src/studio/auto-add-store.ts`, `src/studio/mcp-snippet.ts`, `tests/property/power-targets.property.test.ts`, `tests/property/server-entry.property.test.ts`, `tests/unit/power-config.test.ts`, `tests/unit/power-fs.test.ts`, `tests/unit/install-records.test.ts`, `tests/unit/mcp-snippet.test.ts`.

  - [x] 8.1 Write `power-config.ts`
    - Pure: `parseConfig` (reasons `json`, `not-object`, `servers-not-object`), `mergeServer`, `removeServer`, `serialize` (`JSON.stringify(root, null, 2) + "\n"`), `targetPaths(scope, kiroRoot, slug)`, `sha256`.
    - _Requirements: 2.5, 2.6, 2.11, 2.12, 3.5, 3.8_

  - [x] 8.2 Write `power-fs.ts`
    - Move `inside` and `realDeepest` from the old installer. Add `beginTransaction(fsOps?)` with queued `write` and `remove`, temp file in the same folder plus rename, restore of every touched file on failure, cleanup of temporary files, and an `FsOps` seam for failure injection.
    - _Requirements: 2.9, 2.10, 3.7, 3.11, 4.14_

  - [x] 8.3 Write `install-records.ts`
    - `createInstallRecords`: `list`, `put` (replaces the same `(slug, scope)`), `delete`, in `kiro-installs.json` written through `appData.ensure()`, temp plus rename, mode 0600, no secret value.
    - _Requirements: 4.7, 4.15_

  - [x] 8.4 Write `auto-add-store.ts`
    - `createAutoAddStore`: `read`, `write`, `clear` for `kiro-auto-add.json` (`workspacePath` only for `project`). A failure to read or write surfaces so the caller keeps the option off.
    - _Requirements: 4.2, 4.5, 4.6_

  - [x] 8.5 Write the Server_Entry builder in `mcp-snippet.ts`
    - `buildServerEntry(source, serverJsPath, { dataDir, applicationKey, configuredNames })` returns exactly `type`, `command`, `args`, `env`. `env` holds `DAEMONIZE_MODE: 'strict'`, `DAEMONIZE_DATA_DIR`, `DAEMONIZE_APP_KEY` as plain values and `${DAEMONIZE_SECRET_<NAME>}` only for required names not stored. Never copy a non-placeholder secret value from the source.
    - _Requirements: 3.12, 8.1, 8.2, 8.3, 8.4_

  - [x]* 8.6 Write property test for targets inside the allowed root
    - File: `tests/property/power-targets.property.test.ts`.
    - **Property 2: Targets lie inside the allowed root**
    - **Validates: Requirements 2.5, 2.6, 2.7, 2.9, 2.10**

  - [x]* 8.7 Write property test for the Server_Entry shape and placeholder rule
    - File: `tests/property/server-entry.property.test.ts`.
    - **Property 11: Server_Entry shape and placeholder rule**
    - **Validates: Requirements 3.12, 8.1, 8.2, 8.3, 8.4**

  - [x]* 8.8 Write unit tests for the install core modules
    - Files: `tests/unit/power-config.test.ts`, `power-fs.test.ts`, `install-records.test.ts`, `mcp-snippet.test.ts`. Transaction rollback at each step with `FsOps` injection and no leftover temporary file, record replacement, entry shape for zero, some and all stored names.
    - _Requirements: 3.7, 3.11, 4.7, 8.1_

- [x] 9. G3b Installer and routes (parallel)
  - Owns: `src/studio/power-installer.ts`, `src/studio/routes/power.ts`, `src/studio/messages/power.ts`, `tests/helpers/power-fixture.ts` (fake home helper), `tests/property/power-preview.property.test.ts`, `power-merge.property.test.ts`, `power-idempotent.property.test.ts`, `power-invalid-config.property.test.ts`, `power-backup.property.test.ts`, `power-confirmation.property.test.ts`, `power-roundtrip.property.test.ts`, `power-outside-edit.property.test.ts`, `bridge-no-leak-install.property.test.ts`, `tests/unit/power-installer.test.ts`, `power-installer-guards.test.ts`, `power-two-apps.test.ts`, `power-auto-add.test.ts`, `power-routes.test.ts`, and edits to existing installer tests (400 to 409 statuses, new `PowerInstallerDeps`).

  - [x] 9.1 Write the Power messages
    - `messages/power.ts`: constants for every code of the design's error table (`POWER_SCOPE_INVALID`, `POWER_NOT_COMPILED`, `POWER_KIRO_OUTSIDE`, `POWER_TARGET_LINK`, `POWER_SETTINGS_*`, `POWER_CONFIRM_INVALID`, `POWER_WRITE_FAILED`, `POWER_NOTHING_TO_REMOVE`, `POWER_REMOVE_FAILED`, `POWER_AUTO_ADD_FAILED`, `POWER_AUTO_ADD_NOT_SAVED`). Plain words, no value, key, stack trace or path outside the shown `.kiro` folder.
    - _Requirements: 3.2, 3.4, 3.5, 3.11, 8.9_

  - [x] 9.2 Implement `info`, `preview` and `install`
    - Shared `plan`: `locate()` (409 `POWER_NOT_COMPILED` when the folder lacks `mcp-server.js`, `mcp.json` or the skill), root by scope (`<home>/.kiro` or `<workspace>/.kiro`, with the existing workspace checks), confinement by `realDeepest`, symbolic link refusal, 2 MiB cap, `parseConfig` reasons as 409, vault status by name only (unreadable vault means every name is "no value yet"). `preview` stores a confirmation bound to scope, `.kiro` path and slug (600 s, single use, at most 8, a new preview for the same scope and path replaces the older one) and writes nothing. `install` validates and consumes it, skips writing when bytes are equal, else queues `mcp.json.bak`, the skill file, then `mcp.json` last in a Transaction, then `InstallRecords.put` with the SHA-256 of the written bytes. Store the consent when `autoAdd === true`; a failed consent write does not fail the install.
    - `PowerDeps` gains `locate`, `home`, `appData`, `vault`, `records`, `autoAdd`, `now`, `fsOps`.
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.10, 3.11, 4.2, 4.6, 4.7, 8.2, 8.3, 8.5, 8.9, 8.10_

  - [x] 9.3 Implement `remove`
    - Load the record (409 `POWER_NOTHING_TO_REMOVE` if none), re-check confinement, refuse a present but invalid config with 409 and keep the record. Hash equal and backup recorded: restore the `.bak` bytes. Hash equal and no backup: delete `mcp.json` when only our entry would remain, else remove the entry. Hash differs: remove only our entry and keep the `.bak`. Delete only the recorded skill folder. Missing parts count as removed. A failed step restores everything, keeps the record, answers 500 `POWER_REMOVE_FAILED`. Delete the record on success.
    - _Requirements: 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15_

  - [x] 9.4 Implement auto-add
    - `getAutoAdd`, `disableAutoAdd`, `runAutoAdd` (never throws). No consent returns `disabled` with no access to Kiro folders. Otherwise run the same plan and write steps with the stored scope and workspace, no confirmation id. Return `added`, `unchanged` or `failed`. A failure leaves the Kiro files as found and keeps the consent.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 9.5 Write the Power routes
    - All `remote: 'blocked'`: `GET /api/power/info`, `GET /api/power/snippet` (includes `DAEMONIZE_DATA_DIR` and `DAEMONIZE_APP_KEY`), `POST /api/power/preview`, `POST /api/power/install`, `POST /api/power/remove`, `GET` and `POST /api/power/auto-add` (`{ enabled: false }`). Unknown body fields give 400, a bad `scope` gives 400 `POWER_SCOPE_INVALID`. Answers hold names, paths and counts, never a value.
    - _Requirements: 4.8, 4.16, 4.17, 8.11_

  - [x]* 9.6 Write property test for read-only complete preview
    - File: `tests/property/power-preview.property.test.ts`.
    - **Property 3: Preview is complete and read-only**
    - **Validates: Requirements 2.8**

  - [x]* 9.7 Write property test for merge preservation
    - File: `tests/property/power-merge.property.test.ts`.
    - **Property 4: Merge preserves everything except the installed entry**
    - **Validates: Requirements 2.11, 2.12, 3.8, 3.9**

  - [x]* 9.8 Write property test for install idempotence
    - File: `tests/property/power-idempotent.property.test.ts`.
    - **Property 5: Install is idempotent**
    - **Validates: Requirements 3.10**

  - [x]* 9.9 Write property test for backup fidelity and record content
    - File: `tests/property/power-backup.property.test.ts`.
    - **Property 7: Backup fidelity and record content**
    - **Validates: Requirements 3.6, 4.7**

  - [x]* 9.10 Write property test for confirmation binding
    - File: `tests/property/power-confirmation.property.test.ts`. Includes expiry with an injected clock.
    - **Property 8: Confirmation binding**
    - **Validates: Requirements 3.3, 3.4**

  - [x]* 9.11 Write property test for unusable configuration
    - File: `tests/property/power-invalid-config.property.test.ts`. Covers install and remove.
    - **Property 6: Unusable configuration is refused without any write**
    - **Validates: Requirements 2.13, 3.5, 4.13**

  - [x]* 9.12 Write property test for install then remove
    - File: `tests/property/power-roundtrip.property.test.ts`.
    - **Property 9: Install then remove restores the original state**
    - **Validates: Requirements 4.9, 4.10, 4.12**

  - [x]* 9.13 Write property test for remove after an outside edit
    - File: `tests/property/power-outside-edit.property.test.ts`.
    - **Property 10: Remove after an outside edit keeps later servers**
    - **Validates: Requirements 4.9, 4.11**

  - [x]* 9.14 Write unit tests for the installer cases
    - File: `tests/unit/power-installer.test.ts`, fake home, one test each: (a) creation with `mcpServers`, (b) merge with at least 2 other servers, (c) replacement of the same name, (d) invalid JSON gives 409 and every file keeps its bytes, (e) removal with matching hash restores the backup bytes, (f) removal after an outside change keeps later servers, (g) no written file (`mcp.json`, `SKILL.md`, `POWER.md`, `.bak`) holds the stored secret value.
    - _Requirements: 2.11, 2.13, 3.8, 4.10, 4.11, 8.6, 10.1, 10.2_

  - [x]* 9.15 Write unit test for two applications with the same Secret_Name
    - File: `tests/unit/power-two-apps.test.ts`, scope `global`: different slugs, skill folders, Server_Entries, and different passwords resolved by the reader.
    - _Requirements: 5.10, 6.2, 7.1, 10.3_

  - [x]* 9.16 Write unit tests for guards in both scopes
    - File: `tests/unit/power-installer-guards.test.ts`. Symbolic link target, `.kiro` link leaving the area, file over 2 MiB, rename failure leaves no temporary file, write failure at each step restores every file and writes no record, statuses are 409 and 500.
    - _Requirements: 3.1, 3.2, 3.7, 3.11_

  - [x]* 9.17 Write unit tests for auto-add
    - File: `tests/unit/power-auto-add.test.ts`. Consent stored after a confirmed install with the option on, deleted when turned off, kept after a failed automatic install, option stays off when App_Data_Dir is not writable, one install per successful call and none after a failed call.
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 9.18 Write unit tests for Power routes
    - File: `tests/unit/power-routes.test.ts`. Each new route answers 403 from a remote listener, 400 on an unknown field, 405 on a wrong method, and holds no secret value.
    - _Requirements: 4.17, 8.11_

  - [x]* 9.19 Write property test for no stored value in install outputs
    - File: `tests/property/bridge-no-leak-install.property.test.ts`. Responses of preview, install, auto-add, remove and snippet, logs of those routes, and `mcp.json`, `SKILL.md`, `POWER.md`, `.bak`.
    - **Property 20: No stored value appears outside the vault**
    - **Validates: Requirements 8.5, 8.6, 8.11**

- [x] 10. G4a Connect UI and docs (parallel)
  - Owns: `src/studio/ui/js/views/connect.js`, `src/studio/ui/js/copy.js`, `src/studio/ui/js/api.js`, `src/studio/ui/js/features.js`, the `README.md` section, `tests/property/connect-copy.property.test.ts`, `tests/unit/connect-view.test.ts`.

  - [x] 10.1 Add the connect strings in `copy.js`
    - Plain-language strings for scope choices, the global sentence, auto-add, confirmation, backup and no-backup sentences, success, reload reminder, missing-secret warning, remove, and failure messages. Add the single re-export line for `copy-secrets.js`.
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.7, 4.16, 8.3_

  - [x] 10.2 Rework `connect.js`
    - A `fieldset` with `legend` and two exclusive radios ("All my projects", "Only this project"), preselected from `info.kiroHomeExists`, the user choice wins. The workspace field only for `project`. The global sentence only for `global`. Auto-add checkbox, off without consent, sends `autoAdd: true` on install and shows the "cannot be remembered" sentence when `autoAddSaved` is false. Confirmation shows the `.kiro` path in `code.path`, each file with `create`, `merge` or `replace`, and the backup or no-backup sentence from `preview.backup`. Success lists written files, the reload reminder, and a warning with a Credentials link for each `missingSecrets` name (none when empty). "Remove from Kiro" for each entry of `info.installs` with a confirmation, then `POST /api/power/remove`. A failed action names itself, says the Kiro files were left as they were, keeps the card open. No secret value in any state.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.6, 4.8, 4.15, 4.16, 8.3, 8.4, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 10.3 Add API calls and feature flags
    - `api.js`: calls for the new Power routes. `features.js`: hide the new features in the static demo.
    - _Requirements: 4.17_

  - [x] 10.4 Update the README section
    - Describe global versus project scope, remove, auto-add, per-application names and the vault bridge. No CLI change is documented.
    - _Requirements: 2.1, 4.8, 5.10_

  - [x]* 10.5 Write property test for plain-language copy
    - File: `tests/property/connect-copy.property.test.ts`, loops over the connect copy table.
    - **Property 21: Plain-language copy**
    - **Validates: Requirements 9.1, 9.8**

  - [x]* 10.6 Write DOM tests for the connect screen
    - File: `tests/unit/connect-view.test.ts` with a stubbed `api`. Exactly two exclusive choices, preselection from `kiroHomeExists`, user choice wins, global sentence only for `global`, confirmation content and backup sentence, warning only when `missingSecrets` is non-empty, "Remove from Kiro" only with a record, reload reminder after install and removal, error keeps the card open, absolute paths only in `code.path`, plain-language lint reports zero violations.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.8, 4.15, 4.16, 8.4, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [x] 11. G4b Credentials UI (parallel)
  - Owns: `src/studio/ui/js/views/credentials.js`, `src/studio/ui/js/views/playground.js`, `src/studio/ui/js/copy-secrets.js`, `tests/unit/credentials-view.test.ts`.

  - [x] 11.1 Create `copy-secrets.js`
    - Plain-language strings for the credentials screen (application line, "has a value", "has no value yet") and for the Playground auto-add line. Covered by the existing plain-language lint.
    - _Requirements: 9.1, 9.6_

  - [x] 11.2 Make Credentials per application
    - `credentials.js` sends `application` (from the `GET /api/secrets` answer) on save and forget, and shows which application the passwords belong to (host only). Secrets are shown by name and status only.
    - _Requirements: 6.1, 6.5, 6.10, 9.6_

  - [x] 11.3 Show the auto-add result in the Playground view
    - `playground.js` shows a short line when a call answer carries `autoAdd` with status `added` or `failed`.
    - _Requirements: 4.3, 4.4_

  - [x]* 11.4 Write DOM tests for Credentials and the Playground line
    - File: `tests/unit/credentials-view.test.ts`. `application` is sent on save and forget, no value is rendered, the auto-add line appears for `added` and `failed` only.
    - _Requirements: 4.4, 6.1, 6.8, 9.6_

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. G6 Integration (after all groups)
  - Owns: `tests/integration/vault-bridge.test.ts`.

  - [x]* 13.1 Write the full Studio path integration test
    - File: `tests/integration/vault-bridge.test.ts`, fake home, `DAEMONIZE_DATA_DIR` in a temporary folder, `NODE_ENV=test` and `DAEMONIZE_VAULT_KEY_PROVIDER=file` (the memory provider cannot cross processes). In order: save a secret in Credentials for an application; compile the Action (output goes to the sibling `<slug>` folder); install with scope `global`; start the generated `mcp-server.js` with only the `env` of the written Server_Entry plus the two test selectors; call the tool.
    - Assert the answer is not `missing_secret`, and the secret value appears neither in the answer nor in any file of the fake home or the output folder.
    - _Requirements: 5.11, 7.1, 7.5, 8.6, 10.6_

- [x] 14. Final checkpoint - Run the four repository checks and report
  - Hash the real `~/.kiro` file list before and after the run when it exists and state that it is unchanged.
  - Run `npm run build`, `npm run check:secrets`, `npx tsc --noEmit` and `npx vitest run`. Also run `npx vitest run` once with `DAEMONIZE_SECRET_PASSWORD`, `DAEMONIZE_MODEL_*`, `DAEMONIZE_DATA_DIR` and `DAEMONIZE_APP_KEY` set and once with none set, and compare the counts.
  - Report each command's exit code and, for `npx vitest run`, the exact passed, failed and skipped counts. All four must exit 0 with 0 failed tests.
  - Ensure all tests pass, ask the user if questions arise.
  - Then STOP. Do not start Step 2 (`.vsix` extension) or Step 3 (persistent profile, Chrome extension, semantic firewall) until the user gives a new instruction.
  - _Requirements: 1.5, 1.6, 1.7, 8.7, 10.1, 10.8, 10.9_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP. The integration test 13.1 and the checks in 4.11, 5.5, 9.14, 9.15 are required by Requirements 10.2 to 10.7, so skip them only with the user's agreement.
- Deliberate behaviour changes and their owners: Playground precedence environment over scoped over generic (task 6.2, test 6.3), install refusals as 409 (tasks 9.2, 9.3), per-application output folder (tasks 7.2, 7.3), vault wording in `SKILL.md` and `POWER.md` (task 7.4).
- Property 20 is split across two files: secrets routes (6.6) and install outputs (9.19).
- Each task references requirement clauses for traceability. Checkpoints give incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5", "1.6", "1.7"] },
    { "id": 4, "tasks": ["2.1"] },
    { "id": 5, "tasks": ["2.2"] },
    { "id": 6, "tasks": ["2.3"] },
    { "id": 7, "tasks": ["2.4", "2.5"] },
    { "id": 8, "tasks": ["4.1", "5.1", "7.1", "8.1", "8.2", "8.3", "8.4", "8.5", "9.1", "10.1", "10.3", "10.4", "11.1"] },
    { "id": 9, "tasks": ["4.2", "4.3", "4.4", "7.2", "7.5", "7.6", "7.7", "8.6", "8.7", "8.8", "9.2", "10.2", "11.2", "11.3"] },
    { "id": 10, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "4.11", "4.12", "5.2", "5.3", "6.1", "6.2", "9.3", "9.5", "9.6", "9.7", "9.8", "9.9", "9.10", "10.5", "10.6", "11.4"] },
    { "id": 11, "tasks": ["5.4", "5.5", "6.3", "6.4", "6.5", "6.6", "7.3", "7.4", "9.4", "9.11", "9.12", "9.13", "9.14", "9.15", "9.16", "9.18"] },
    { "id": 12, "tasks": ["7.8", "7.9", "9.17", "9.19"] },
    { "id": 13, "tasks": ["13.1"] }
  ]
}
```
