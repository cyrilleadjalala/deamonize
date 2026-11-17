# Requirements Document

## Introduction

Real-world tests of "Connect to Kiro" on two applications (cycyly.vercel.app and a Next.js application at localhost:3000, "Payer.bj") showed four problems:

1. A password entered in Credentials and accepted by the Playground never reaches the MCP server that Kiro starts. The Secret_Vault is read only by the Studio Playground child server, so "Connect to Kiro" warns that `DAEMONIZE_SECRET_PASSWORD` has no value and Kiro fails with `missing_secret` until the user sets a Windows environment variable by hand.
2. Both applications use the generic secret name `DAEMONIZE_SECRET_PASSWORD` and the same output folder name `daemonize-out`, so one overwrites the other (in `~/.kiro/powers/installed/` and in global environment variables).
3. The Power_Installer writes only `<project>/.kiro`. Kiro also reads a user-level configuration (`%USERPROFILE%\.kiro\settings\mcp.json` on Windows) that applies to every project.
4. `vitest.config.ts` has no setup file that clears `DAEMONIZE_*` variables, so secrets present on a developer machine change test results.

This spec covers a preparatory step and Step 1 of a larger plan. The preparatory step isolates the test environment. Step 1.1 adds a user-level install scope, remembered consent, an undo action, and application-specific names. Step 1.2 adds a read-only bridge so that the MCP server started by Kiro reads secrets from the Secret_Vault without any secret value in `mcp.json`. Step 1.3 defines the verification.

Constraints that apply to every requirement:

- Every CLI command and flag stays unchanged. The Studio security model stays in force: loopback listening, per-process token with HttpOnly SameSite=Strict cookie, Host and Origin checks, `x-studio-request` header on POST, CSP `default-src 'self'`, X-Frame-Options DENY, `redactForStudio` and `knownSecretValues`.
- No secret value appears in `mcp.json`, `SKILL.md`, `POWER.md`, logs, MCP responses, error messages or Studio responses.
- Generated runtime files (`mcp-server.js`, `replay.ts` and the other generated files) never import from `src/`. The bridge reader must therefore be a standalone file generated or copied next to the server. The design phase chooses between that standalone reader and a light launcher such as `daemonize serve --vault`, under this constraint.
- The existing guards of the Power_Installer stay: realpath confinement, size cap, refusal of invalid JSON without writing, single-use confirmation, atomic write that preserves other servers.

Assumptions:

- A user home folder is resolved with `os.homedir()` unless an injected home directory is given. Tests always inject a fake home.
- Kiro reads `mcpServers` at the root of `~/.kiro/settings/mcp.json`, the same shape as the workspace file.
- The Application_Key (normalized origin) of the first step of a workflow identifies the application. When a workflow has no http(s) origin, the Action name is the fallback source of the application name.
- Existing Secret_Vault entries (unscoped names such as `DAEMONIZE_SECRET_PASSWORD`) were written before this feature and must keep working.

Out of scope: Step 2 (a thin Kiro `.vsix` extension) and Step 3 (a persistent browser profile, a Chrome MV3 extension and a semantic firewall). Nothing in this spec implements them.

## Glossary

- **Studio**: The local web application and JSON API served by `startStudio` in `src/studio/server.ts`.
- **Studio_UI**: The single-page interface served from `src/studio/ui/`, including the view `connect.js`.
- **Power_Installer**: `StudioPowerInstaller` in `src/studio/power-installer.ts`, with its routes in `src/studio/routes/power.ts`.
- **Secret_Vault**: The write-only local store of secret values: the AES-256-GCM file `<App_Data_Dir>/secrets.vault.json`, with its 256-bit key held by a Key_Provider.
- **Key_Provider**: The component in `src/studio/key-providers.ts` that holds the vault key (Windows DPAPI blob `vault.key`, macOS Keychain, Linux `secret-tool`, or a test provider selected by `DAEMONIZE_VAULT_KEY_PROVIDER` when `NODE_ENV` is `test`).
- **App_Data_Dir**: The per-user application data folder (`%LOCALAPPDATA%\Daemonize`, `~/Library/Application Support/Daemonize` or `$XDG_DATA_HOME/daemonize`), overridable with `DAEMONIZE_DATA_DIR`.
- **Application_Key**: The normalized origin (scheme, host, port) of an Action, produced by `applicationKey` in `src/studio/validate-action.ts`.
- **Application_Slug**: The kebab-case name of an application derived from its Application_Key, defined in Requirement 5.
- **Name_Map**: The record that links each Application_Key to its Application_Slug and is stored in the App_Data_Dir.
- **Install_Scope**: One of `global` (the user-level `.kiro` folder in the user home) or `project` (the `.kiro` folder of a Target_Workspace).
- **Kiro_Home**: The `.kiro` folder inside the user home folder.
- **Target_Config**: The `settings/mcp.json` file of the chosen Install_Scope.
- **Server_Entry**: The object stored under `mcpServers.<Application_Slug>` in a Target_Config.
- **Install_Record**: A file in the App_Data_Dir that records, for each install, the Install_Scope, the paths written, the SHA-256 hash of the Target_Config bytes that Daemonize wrote, and whether a Backup_File exists. It holds no secret value.
- **Backup_File**: The file `mcp.json.bak` written next to a Target_Config before Daemonize changes that Target_Config.
- **Secret_Name**: The name of a required secret, such as `PASSWORD`, for the variable `DAEMONIZE_SECRET_PASSWORD`.
- **Scoped_Vault_Entry**: A Secret_Vault entry that holds a Secret_Name for one Application_Key.
- **Generic_Vault_Entry**: A Secret_Vault entry that holds a Secret_Name without an Application_Key (the format used before this feature).
- **Vault_Reader**: The standalone, read-only component placed next to `mcp-server.js` that resolves missing secrets from the Secret_Vault. It does not import from `src/`.
- **MCP_Server**: The generated `mcp-server.js` process started by Kiro or by the Playground.
- **Auto_Add_Consent**: The remembered user choice "Add to Kiro automatically after a successful test", stored in the App_Data_Dir.
- **Secret_Placeholder**: A reference of the form `${DAEMONIZE_SECRET_<NAME>}` that stands for a secret value without containing it.
- **Unexpanded_Placeholder**: An environment value that still has the form `${...}`, because the MCP client did not expand it.
- **Test_Env_Setup**: The vitest setup file that clears machine-specific `DAEMONIZE_*` variables.
- **Plain_Language**: Wording that uses none of the terms {record, compile, storage state, environment variable, MCP, JSON, token, CLI} as a whole word, case-insensitive, on the main path screens. Elements of type `code.path` are exempt.

- **Studio_Guard**: The set of Studio request checks (loopback listener, per-process token cookie, Host and Origin checks, `x-studio-request` header on POST) applied to the `/api/power/*` routes.
- **Target_Workspace**: The project folder whose `.kiro` folder is written when the Install_Scope is `project`.
- **Kiro_Power**: The Kiro power package (`POWER.md` with its files) that Daemonize generates for one application, named by its Application_Slug.

## Requirements

### Requirement 1: Isolated test environment

**User Story:** As a developer, I want tests to run without the secrets of my machine, so that results are the same on every computer.

#### Acceptance Criteria

1. WHEN a vitest run starts, THE Test_Env_Setup SHALL delete from `process.env` every variable whose name starts with `DAEMONIZE_SECRET_` or `DAEMONIZE_MODEL_`, plus `DAEMONIZE_DATA_DIR` and `DAEMONIZE_APP_KEY`, before the first test file of that run executes.
2. THE vitest configuration SHALL list the Test_Env_Setup in `setupFiles` of every project it defines, including `fast` and `integration`, so that no project runs without it.
3. WHEN a test needs one of the removed variables, THE test SHALL set the variable itself before the assertion that depends on it, and SHALL restore the variable to its previous state (previous value, or absent if it was absent) when that test ends, whether the test passes or fails.
4. WHEN the secrets property test (`tests/property/secrets-studio.property.test.ts`) searches a response for a secret name, THE test SHALL use the whole-name boundary check `(?![A-Za-z0-9_])` after the name, so that a search for `DAEMONIZE_SECRET_PASSWORD` does not match inside `DAEMONIZE_SECRET_PASSWORD_2`.
5. WHEN `npx tsc --noEmit` is run on the repository after this feature is complete, THE repository SHALL report 0 type errors and exit with code 0.
6. WHEN `npx vitest run` is run after this feature is complete with `DAEMONIZE_SECRET_PASSWORD` set to a non-empty value in the parent shell, THE test suite SHALL report 0 failed tests and exit with code 0.
7. WHEN `npx vitest run` is run after this feature is complete with `DAEMONIZE_SECRET_PASSWORD`, `DAEMONIZE_MODEL_*`, `DAEMONIZE_DATA_DIR` and `DAEMONIZE_APP_KEY` set to non-empty values in the parent shell, THE test suite SHALL report the same number of passed, failed and skipped tests as a run with none of these variables set.

### Requirement 2: Install scope choice

**User Story:** As a user, I want to choose whether a tool is available in every Kiro project or only in one, so that I do not have to repeat the connection for each project.

#### Acceptance Criteria

1. WHEN the connect screen opens, THE Studio_UI SHALL display exactly two mutually exclusive choices, "All my projects" (Install_Scope `global`) and "Only this project" (Install_Scope `project`), with exactly one selected at any time.
2. WHEN the connect screen opens and the Kiro_Home exists as a directory, THE Studio_UI SHALL preselect the Install_Scope `global`.
3. WHEN the connect screen opens and the Kiro_Home does not exist, THE Studio_UI SHALL preselect the Install_Scope `project`.
4. WHEN the user changes the selected choice before confirming, THE Studio_UI SHALL use the user's choice instead of the preselection for the preview and for the install.
5. WHERE the Install_Scope is `global`, THE Power_Installer SHALL write the Server_Entry into `<home>/.kiro/settings/mcp.json` under `mcpServers.<Application_Slug>`, and the skill into `<home>/.kiro/skills/<Application_Slug>/SKILL.md`.
6. WHERE the Install_Scope is `project`, THE Power_Installer SHALL write the Server_Entry into `<Target_Workspace>/.kiro/settings/mcp.json` under `mcpServers.<Application_Slug>`, and the skill into `<Target_Workspace>/.kiro/skills/<Application_Slug>/SKILL.md`.
7. THE Power_Installer SHALL resolve `<home>` from the injected home directory when one is given, and from `os.homedir()` otherwise.
8. WHEN the user asks for a preview, THE Power_Installer SHALL return the resolved Install_Scope, the absolute path of the `.kiro` folder that will be written, the list of files to be written each with the outcome `create`, `merge` or `replace`, the name of the Server_Entry, and a boolean stating whether the Server_Entry replaces an existing one, and SHALL NOT create, modify or delete any file.
9. WHILE the Install_Scope is `global`, THE Power_Installer SHALL write only to paths whose realpath is inside the Kiro_Home, and WHILE the Install_Scope is `project`, THE Power_Installer SHALL write only to paths whose realpath is inside the `.kiro` folder of the Target_Workspace.
10. IF a path to be written resolves outside the folder allowed for the selected Install_Scope, THEN THE Power_Installer SHALL refuse the install, write no file, and return an error indicating that the path is outside the allowed folder.
11. IF the Target_Config does not exist, THEN THE Power_Installer SHALL create it with a root object whose only key is `mcpServers`, holding the Server_Entry, and SHALL create any missing parent folders inside the allowed folder.
12. IF the Target_Config exists and its root object has no `mcpServers` key, THEN THE Power_Installer SHALL add `mcpServers` holding the Server_Entry and keep every other root key with its original value.
13. IF the Target_Config exists and is not valid JSON, or its root is not an object, THEN THE Power_Installer SHALL write no file and return an error indicating that the configuration is invalid, leaving the Target_Config bytes unchanged.

### Requirement 3: Safe merge, guards and backup

**User Story:** As a user, I want my other Kiro tools to stay untouched when Daemonize connects, so that connecting never breaks my setup.

#### Acceptance Criteria

1. THE Power_Installer SHALL apply to the Install_Scope `global` every guard it applies to the Install_Scope `project`: realpath confinement of the `.kiro` folder and of each target file, refusal of a target that is a symbolic link, a size cap of 2 MiB (2,097,152 bytes) for an existing Target_Config, and a single-use confirmation identifier that expires 10 minutes (600 seconds) after the preview that issued it.
2. IF a target file is a symbolic link, or its realpath is outside the `.kiro` folder of the chosen Install_Scope, or an existing Target_Config is larger than 2,097,152 bytes, THEN THE Power_Installer SHALL answer status 409 with a plain message naming the reason, SHALL write no file, and SHALL leave the existing files unchanged.
3. THE Power_Installer SHALL bind each confirmation identifier to the Install_Scope, to the exact absolute `.kiro` path shown to the user and to the Application_Slug of the preview.
4. IF an install request carries a confirmation identifier that is unknown, already used, older than 10 minutes, or whose Install_Scope, `.kiro` path or Application_Slug differs from the preview, THEN THE Power_Installer SHALL answer status 409 with a plain message that asks the user to preview again, SHALL write no file, and SHALL keep unchanged the state of every other valid confirmation identifier.
5. IF the existing Target_Config is not valid JSON, is not a JSON object, or has an `mcpServers` value that is not an object, THEN THE Power_Installer SHALL answer status 409 with a plain message naming which of the three conditions holds, and SHALL write no file, including no Backup_File and no skill file.
6. WHEN the Power_Installer writes a Target_Config that already exists, THE Power_Installer SHALL first write its previous bytes, unchanged and byte-identical, to the Backup_File, replacing any earlier Backup_File.
7. THE Power_Installer SHALL write the Target_Config through a temporary file in the same folder followed by a rename, so that a failure leaves the previous Target_Config byte-identical and leaves no temporary file in the folder.
8. WHEN the Power_Installer merges a Server_Entry, THE Power_Installer SHALL keep every other key of `mcpServers` and every other root key with its original value, and SHALL replace only the value stored under `mcpServers.<Application_Slug>`.
9. FOR ALL Target_Configs that are valid JSON objects, installing and then parsing the file SHALL yield an object where each `mcpServers` entry other than the installed Server_Entry, and each root key other than `mcpServers`, is deep-equal to its value before the install (merge-preservation property).
10. FOR ALL Target_Configs, installing the same Server_Entry twice SHALL yield the same Target_Config bytes as installing it once, and the same bytes in the skill file (idempotence property).
11. IF writing the skill file or the Target_Config fails, THEN THE Power_Installer SHALL restore every file it touched to its byte content before the install (or delete it when it did not exist before), SHALL write no Install_Record, and SHALL answer status 500 with a plain message that holds no secret value, no stack trace and no absolute path outside the shown `.kiro` folder.
12. THE Power_Installer SHALL write the Server_Entry with only these keys: `type`, `command`, `args`, `env`. THE `env` object SHALL hold `DAEMONIZE_MODE` with the value `strict`, the non-secret `DAEMONIZE_DATA_DIR` and `DAEMONIZE_APP_KEY` values defined in Requirement 8, and a `${DAEMONIZE_SECRET_<NAME>}` placeholder for each required secret that is not in the Secret_Vault for that application, and no other key.

### Requirement 4: Remembered consent and undo

**User Story:** As a user, I want the tool to appear in Kiro right after a successful test and to be able to remove it later, so that connecting and disconnecting are one click.

#### Acceptance Criteria

1. THE Studio_UI SHALL show the option "Add to Kiro automatically after a successful test" on the connect screen, and SHALL show it off when no Auto_Add_Consent is stored.
2. WHEN the user turns the option on and completes a confirmed install, THE Studio SHALL store the Auto_Add_Consent and the Install_Scope in the App_Data_Dir, and for the Install_Scope `project` SHALL also store the absolute path of the Target_Workspace.
3. WHERE the Auto_Add_Consent is stored, WHEN a Playground test of an Action succeeds, THE Studio SHALL run the install for that application with the stored Install_Scope and without a new confirmation, using every guard of Requirement 3 except the confirmation identifier.
4. IF an automatic install fails, THEN THE Studio SHALL leave the Target_Config and the skill files in the state found before the install, SHALL keep the Auto_Add_Consent, and SHALL show a plain message stating that the automatic add failed.
5. WHEN the user turns the option off, THE Studio SHALL delete the stored Auto_Add_Consent, and no later Playground test SHALL trigger an automatic install until the user turns the option on again.
6. IF the App_Data_Dir cannot be written or read, THEN THE Studio SHALL keep the option off, SHALL store no Auto_Add_Consent, and SHALL show a plain message stating that the choice cannot be remembered.
7. WHEN an install succeeds, THE Power_Installer SHALL write one Install_Record for that application, holding the Install_Scope, the absolute paths written, the SHA-256 hash of the Target_Config bytes written, and whether a Backup_File was created, and SHALL replace any earlier Install_Record of the same application and Install_Scope.
8. WHILE an application has an Install_Record, THE Studio_UI SHALL show a "Remove from Kiro" action for that application.
9. WHEN the user confirms "Remove from Kiro", THE Power_Installer SHALL remove from the Target_Config only the Server_Entry named in the Install_Record, SHALL remove only the folder `skills/<Application_Slug>` recorded in the Install_Record, and SHALL keep every other `mcpServers` key and every other root key with its original value.
10. WHEN the user confirms "Remove from Kiro" and the SHA-256 hash of the current Target_Config bytes equals the hash in the Install_Record, THE Power_Installer SHALL restore the Backup_File as the Target_Config when the Install_Record states that a Backup_File exists, and SHALL delete the Target_Config when no Backup_File exists and `mcpServers` would be empty.
11. WHEN the user confirms "Remove from Kiro" and the SHA-256 hash of the current Target_Config bytes differs from the hash in the Install_Record, THE Power_Installer SHALL delete only the Server_Entry, SHALL leave the Backup_File in place, and SHALL keep every server added after the install.
12. IF the Server_Entry or the skill folder is already absent at removal time, THEN THE Power_Installer SHALL treat that part as removed, SHALL remove the other part, and SHALL answer with success.
13. IF the Target_Config is not valid JSON at removal time, THEN THE Power_Installer SHALL answer status 409 with a plain message, SHALL write, restore and delete no file, and SHALL keep the Install_Record.
14. IF a removal step fails, THEN THE Power_Installer SHALL restore the state it found before the removal, SHALL keep the Install_Record, and SHALL answer with a plain message that holds no secret value and no stack trace.
15. WHEN a removal succeeds, THE Power_Installer SHALL delete the Install_Record of that application and Install_Scope, and THE Studio_UI SHALL stop showing "Remove from Kiro" for it.
16. WHEN an install or a removal succeeds, THE Studio_UI SHALL show a message telling the user to reload or reconnect the server in the MCP server panel of Kiro.
17. THE Studio SHALL protect the install, auto-add and removal routes with the Studio_Guard, and SHALL answer status 403 to a request from a remote listener, as it does for the other `/api/power/*` routes.

### Requirement 5: Application-specific names

**User Story:** As a user with several applications, I want each tool to have its own name, so that the tools do not overwrite each other.

#### Acceptance Criteria

1. THE Studio SHALL derive the Application_Slug from the Application_Key of the Action in this order: take the host, append `-` and the port when the port is not the default port of the scheme (80 for `http`, 443 for `https`), convert to lowercase, replace every run of characters outside `a-z` and `0-9` with one hyphen, and remove leading and trailing hyphens. Example: `https://cycyly.vercel.app` gives `cycyly-vercel-app`, and `http://localhost:3000` gives `localhost-3000`.
2. WHEN a host contains non-ASCII characters, THE Studio SHALL convert the host to its ASCII (punycode) form before it derives the Application_Slug.
3. IF the derived Application_Slug is longer than 48 characters, THEN THE Studio SHALL keep the first 48 characters. IF the last 12 of those 48 characters contain a hyphen, THE Studio SHALL cut before the last such hyphen. THE Studio SHALL then remove any trailing hyphen.
4. IF the Action has no http(s) Application_Key, THEN THE Studio SHALL derive the Application_Slug from the Action name with the lowercase, replacement, trimming and length rules of Criteria 1 and 3. Characters outside `a-z` and `0-9` in the Action name, including non-ASCII characters, are replaced by hyphens. THE Studio SHALL use `app` when the result is empty.
5. THE Application_Slug SHALL match the existing server-name pattern `^[a-z0-9][a-z0-9-]{0,63}$`.
6. WHEN the Studio derives an Application_Slug for an Application_Key that has no Name_Map entry, THE Studio SHALL store the pair in the Name_Map before it writes any output for that application.
7. IF a derived Application_Slug equals the Application_Slug that the Name_Map holds for a different Application_Key, THEN THE Studio SHALL use the slug with the suffix `-2` (then `-3`, `-4` and so on, taking the first unused one). THE Studio SHALL shorten the base slug so that the total length, suffix included, is at most 48 characters, removing any trailing hyphen from the base before it adds the suffix. THE Studio SHALL store the result in the Name_Map, so that the slug is the same on every later run.
8. WHEN the Name_Map holds an entry for an Application_Key, THE Studio SHALL return the stored Application_Slug and SHALL NOT derive a new one.
9. IF the Name_Map cannot be read, is not valid, or cannot be written, THEN THE Studio SHALL write no output file, SHALL leave the existing Name_Map unchanged, and SHALL tell the user in plain words that the application name could not be saved.
10. THE Studio SHALL use the Application_Slug as the key of the Server_Entry, as the name of the skill folder, and as the name of the Kiro_Power.
11. WHEN the Studio compiles an application, THE Studio SHALL write the output into a folder named `<Application_Slug>` in the same parent folder as `daemonize-out`, so that two applications never share a folder.
12. WHILE an existing folder `daemonize-out` holds a compiled server and the Name_Map has no entry for its application, THE Studio SHALL leave every file in that folder unchanged and SHALL keep the server key that its `mcp.json` already holds.
13. WHEN the user compiles an Action for an application that has no Name_Map entry, THE Studio SHALL create the Name_Map entry and write the output into `<Application_Slug>`, and SHALL NOT write any file into the folder `daemonize-out`.
14. WHEN the CLI commands `record`, `compile`, `merge`, `serve`, `studio` and `sandbox` are run without the Studio, THE CLI SHALL use the default folder `daemonize-out` and SHALL produce the same output as before this feature.
15. FOR ALL pairs of different Application_Keys in one Name_Map, THE Application_Slugs SHALL be different (uniqueness property).
16. FOR ALL Application_Keys, deriving the Application_Slug twice with the same Name_Map SHALL give the same value (idempotence property).

### Requirement 6: Application-scoped secrets in the vault

**User Story:** As a user, I want one password per application, so that entering the password of one application does not change another.

#### Acceptance Criteria

1. WHEN the user saves a secret in Credentials for an application, THE Secret_Vault SHALL store the value as a Scoped_Vault_Entry for the Application_Key of that application. This SHALL replace any earlier value for the same pair of Application_Key and Secret_Name. Every Generic_Vault_Entry and every Scoped_Vault_Entry of another Application_Key SHALL stay byte-for-byte unchanged in value.
2. THE Secret_Vault SHALL keep exactly one value per pair of Application_Key and Secret_Name, so that saving `PASSWORD` for one application leaves the `PASSWORD` of every other application unchanged.
3. WHILE a Secret_Vault holds Generic_Vault_Entries, THE Secret_Vault SHALL keep returning them, SHALL NOT require a migration step before they can be used, and SHALL NOT convert or delete them when a Scoped_Vault_Entry is saved.
4. WHEN a secret is requested for an application, THE Secret_Vault SHALL return the Scoped_Vault_Entry for that Application_Key and Secret_Name when its value has at least 1 character. Otherwise it SHALL return the Generic_Vault_Entry for that Secret_Name when its value has at least 1 character. Otherwise it SHALL report the secret as not found.
5. WHEN the Studio lists the secret status of an application, THE Studio SHALL report a Secret_Name as configured when a Scoped_Vault_Entry with at least 1 character or a Generic_Vault_Entry with at least 1 character exists for it. Otherwise THE Studio SHALL report it as not configured. The status SHALL contain Secret_Names only and no secret value.
6. WHEN a `set`, `remove` or `names` request carries no Application_Key, THE Secret_Vault SHALL act on Generic_Vault_Entries only, as it did before this feature, so that the existing `/api/secrets` contract stays valid for requests that carry no application.
7. WHEN the Studio starts the Playground child server for an application, THE Studio SHALL resolve each secret of that application in the same order as Requirement 7, Criterion 1: explicit environment variable, then Scoped_Vault_Entry, then Generic_Vault_Entry, then `missing_secret`.
8. THE Studio SHALL return no secret value in any response to `GET` or `POST` on `/api/secrets`, whether the request carries an Application_Key or not.
9. IF a save request has an empty value, or the Secret_Vault cannot be written, THEN THE Studio SHALL refuse the save and show a plain message that names the Secret_Name. The previous Secret_Vault content SHALL stay unchanged, and the message SHALL contain no secret value, no key material and no absolute path of the vault.
10. WHEN the user removes a secret for an application, THE Secret_Vault SHALL delete only the Scoped_Vault_Entry for that Application_Key and Secret_Name. Every Generic_Vault_Entry and every Scoped_Vault_Entry of another Application_Key SHALL stay unchanged.
11. FOR ALL pairs of different Application_Keys A and B, saving or removing a value for A SHALL leave the value resolved for B unchanged (isolation property).

### Requirement 7: Read-only vault bridge for the MCP server run by Kiro

**User Story:** As a user, I want a password I typed once in Credentials to work when Kiro runs the tool, so that I do not set system variables by hand.

#### Acceptance Criteria

1. WHEN the MCP_Server needs the value of a secret variable `DAEMONIZE_SECRET_<NAME>`, THE Vault_Reader SHALL return the first non-empty value in this order: (a) the explicit environment variable `DAEMONIZE_SECRET_<NAME>`, when it is not an Unexpanded_Placeholder; (b) the Scoped_Vault_Entry for the Application_Key in `DAEMONIZE_APP_KEY`; (c) the Generic_Vault_Entry. IF none of the three has a non-empty value, THEN THE Vault_Reader SHALL return `missing_secret` naming the variable.
2. THE MCP_Server SHALL locate the Secret_Vault from the environment values `DAEMONIZE_DATA_DIR` (the App_Data_Dir) and `DAEMONIZE_APP_KEY` (the Application_Key). Both values are non-secret and both are written into the Server_Entry by the Power_Installer.
3. IF `DAEMONIZE_DATA_DIR` is unset or an empty string, THEN THE Vault_Reader SHALL use the default App_Data_Dir of the platform.
4. THE Vault_Reader SHALL open the Secret_Vault file and the Key_Provider for reading only. THE MCP_Server SHALL NOT create, change, rename or delete any file in the App_Data_Dir. After any MCP_Server call, the vault file SHALL have the same bytes and the same modification time as before the call.
5. THE Vault_Reader SHALL read the vault key through the same Key_Provider mechanism that the Studio uses (Windows DPAPI, macOS Keychain, Linux `secret-tool`). THE Vault_Reader SHALL decrypt the file with the same format: AES-256-GCM, additional data `daemonize-vault-v1`.
6. THE compiler SHALL emit the Vault_Reader as a standalone file in the same folder as `mcp-server.js` whenever it emits `mcp-server.js`. The Vault_Reader SHALL NOT import from `src/`.
7. IF the Key_Provider is unavailable, does not answer within 5 seconds, the vault file is missing, the vault file is corrupt, or the decryption fails, THEN THE Vault_Reader SHALL treat the secret as not found and THE MCP_Server SHALL answer `missing_secret`. The answer SHALL be a message in plain words that names the variable and contains no secret value, no key material and no absolute path of the vault. No file SHALL be written.
8. WHEN the MCP_Server resolves a secret from the Secret_Vault, THE MCP_Server SHALL add the value to its redaction set before the value is used by the tool. The redaction set SHALL remove that value from every log line, error message and tool response of the same call.
9. THE Vault_Reader SHALL read and decrypt the Secret_Vault at most once per MCP_Server call. After the call ends, the Vault_Reader SHALL keep no decrypted value, except the values held in the redaction set of Criterion 8.
10. IF the Secret_Vault has no non-empty entry for a secret that the tool needs and no explicit value exists, THEN THE MCP_Server SHALL answer `missing_secret` with the same response shape that it returns today when a secret is absent.
11. IF the explicit environment variable `DAEMONIZE_SECRET_<NAME>` is non-empty and is not an Unexpanded_Placeholder, THEN THE MCP_Server SHALL use that value without opening the Secret_Vault file and without calling the Key_Provider.
12. IF the value of an environment variable begins with `${` and ends with `}` (an Unexpanded_Placeholder), THEN THE MCP_Server SHALL treat the variable as not set and SHALL continue with the next source of Criterion 1.
13. FOR ALL combinations of explicit value, Scoped_Vault_Entry and Generic_Vault_Entry, each non-empty or absent, THE Vault_Reader SHALL return the first non-empty value in the order of Criterion 1, or `missing_secret` when none is present (precedence property).
14. FOR ALL non-empty values stored in the Secret_Vault, writing the value with the Studio and reading it with the Vault_Reader SHALL return a value equal byte for byte (round-trip property).
15. WHEN the Studio has written a vault file on Windows, macOS or Linux, THE Vault_Reader running on that same platform SHALL decrypt the file without a conversion step.
16. IF `DAEMONIZE_APP_KEY` is unset or an empty string, THEN THE Vault_Reader SHALL skip the Scoped_Vault_Entry lookup and SHALL continue with the Generic_Vault_Entry.

### Requirement 8: No secret value outside the vault

**User Story:** As a user, I want to be sure that no password is written in a file that Kiro or git can see, so that connecting is safe.

#### Acceptance Criteria

1. WHEN the Power_Installer writes a Server_Entry, THE Power_Installer SHALL set `DAEMONIZE_DATA_DIR` to the absolute path of the App_Data_Dir and `DAEMONIZE_APP_KEY` to the Application_Key as plain values, and SHALL write no `DAEMONIZE_SECRET_*` key whose value is anything other than a Secret_Placeholder.
2. WHEN the Power_Installer writes a Server_Entry for an application, and a non-empty Scoped_Vault_Entry or a non-empty Generic_Vault_Entry exists in the Secret_Vault for a Secret_Name that the application requires, THE Power_Installer SHALL NOT write a `DAEMONIZE_SECRET_<NAME>` key for that Secret_Name into the Server_Entry.
3. WHEN the Power_Installer writes a Server_Entry for an application, and a required Secret_Name has no non-empty Scoped_Vault_Entry and no non-empty Generic_Vault_Entry, THE Power_Installer SHALL write the Secret_Placeholder `${DAEMONIZE_SECRET_<NAME>}` as the value of `DAEMONIZE_SECRET_<NAME>` in the Server_Entry, and THE Studio_UI SHALL show a warning in Plain_Language that names that Secret_Name and states that it has no value yet.
4. WHEN every required Secret_Name of the application has a non-empty Scoped_Vault_Entry or a non-empty Generic_Vault_Entry, THE Studio_UI SHALL NOT show any warning that a secret was written without a value.
5. THE Power_Installer SHALL determine the vault status of a Secret_Name by name only, and SHALL NOT decrypt, return or log any secret value.
6. FOR ALL install runs, THE files `mcp.json`, `SKILL.md`, `POWER.md` and the Backup_File written or kept by Daemonize SHALL NOT contain, as a substring, any non-empty value stored in the Secret_Vault (no-leak property).
7. WHEN `npm run check:secrets` is run, THE secret scan SHALL exit with code 0 and report zero secret values in the generated output and in the Studio source files.
8. WHEN the Studio generates `SKILL.md` and `POWER.md`, THE Studio SHALL include in each a statement in Plain_Language that the password is read from the Daemonize vault of the user and that the user enters it once in the Studio Credentials screen, and SHALL include no secret value in either file.
9. IF an install is requested for an application whose Application_Slug has no compiled output, THEN THE Power_Installer SHALL answer status 409 with a message in Plain_Language that tells the user to compile the action first, SHALL write no file, and SHALL leave every existing Target_Config, skill folder and Install_Record unchanged.
10. IF the Secret_Vault cannot be read when the Power_Installer checks vault status (Key_Provider unavailable, vault file missing, vault file corrupt, or decryption fails), THEN THE Power_Installer SHALL treat every required Secret_Name as not stored, SHALL apply Criterion 3 to each of them, and SHALL include no key material, no secret value and no absolute path of the vault file in any message.
11. THE Studio SHALL NOT include any value stored in the Secret_Vault in any response of the preview, install, auto-add and removal routes, nor in any log line written by these routes.

### Requirement 9: Plain-language connect screen

**User Story:** As a non-technical user, I want the connect screen to use everyday words, so that I understand each choice.

#### Acceptance Criteria

1. THE Studio_UI SHALL word every label, button, message and warning that this spec adds or changes on the connect screen in Plain_Language, so that a case-insensitive whole-word search of the visible text of the screen finds none of the terms {record, compile, storage state, environment variable, MCP, JSON, token, CLI}, with text inside elements of type `code.path` excluded from the search.
2. WHEN the connect screen shows an absolute path, THE Studio_UI SHALL render that path inside an element of type `code.path` and SHALL NOT show an absolute path anywhere else in the visible text of the screen.
3. WHEN the Studio_UI shows the install confirmation step, THE Studio_UI SHALL show, before the user can confirm, the absolute path of the `.kiro` folder returned by the preview, each file to be written with its outcome (`create`, `merge` or `replace`), and a statement that a backup of the previous file is kept.
4. WHERE the Target_Config does not exist, WHEN the Studio_UI shows the install confirmation step, THE Studio_UI SHALL replace the backup statement with a statement that no previous file exists and so no backup is made.
5. WHEN the Install_Scope `global` is selected, either by the user or by preselection, THE Studio_UI SHALL show a sentence stating that the tool will be available in every Kiro project, and WHEN the Install_Scope `project` is selected, THE Studio_UI SHALL NOT show that sentence.
6. THE Studio_UI SHALL NOT display any secret value in any state of the connect screen (initial, loading, preview, confirmation, success, warning and error), and SHALL show the secrets of an application only by Secret_Name together with the status "has a value" or "has no value yet".
7. IF a preview, an install or a removal request fails, THEN THE Studio_UI SHALL show a message in Plain_Language that states which action failed and that the existing Kiro configuration was left as it was before the request, SHALL show no stack trace and no secret value, and SHALL keep the connect screen open so that the user can try again.
8. WHEN the Plain_Language lint of the Studio runs on the connect screen, THE lint SHALL report zero violations for the text that this spec adds or changes.

### Requirement 10: Verification

**User Story:** As a maintainer, I want automated checks for the new behavior, so that regressions in secrets and file merging are caught.

#### Acceptance Criteria

1. THE test suite SHALL include unit tests that use a fake home folder created in a temporary directory, and THE tests SHALL NOT read or write the real user home folder, so that the real `~/.kiro` folder has the same file list and the same SHA-256 hash for every file before and after `npx vitest run`.
2. THE test suite SHALL include one separate unit test for each of these Power_Installer cases, using the fake home folder of Criterion 1:
   - (a) Target_Config creation when none exists, with a root object that holds `mcpServers`.
   - (b) Merge with at least 2 other servers, which are deep-equal to their values before the install.
   - (c) Replacement of an existing Server_Entry with the same name, leaving the other servers unchanged.
   - (d) Invalid JSON in the Target_Config refused with status 409 and no file written, so every file in the fake home has the same bytes as before.
   - (e) Removal with a matching SHA-256 hash restores the Backup_File bytes exactly.
   - (f) Removal when the Target_Config changed after the install deletes only the Server_Entry and keeps the servers added after the install.
   - (g) Each file written by the install (`mcp.json`, `SKILL.md`, `POWER.md`, Backup_File) contains zero occurrences of the secret value stored in the Secret_Vault.
3. THE test suite SHALL include one unit test, run with the Install_Scope `global`, in which 2 applications with different Application_Keys each hold a different value for the same Secret_Name, and THE test SHALL assert that the 2 applications have different Application_Slugs, different skill folders, different Server_Entries, and different passwords resolved by the Vault_Reader.
4. THE test suite SHALL include property tests, run with the existing `fast-check` runner and at least 100 generated cases each, for these 6 properties:
   - Merge preservation (Requirement 3, Criterion 9).
   - Install idempotence (Requirement 3, Criterion 10).
   - Slug uniqueness and stability (Requirement 5, Criteria 15 and 16).
   - Secret precedence (Requirement 7, Criterion 13).
   - Vault write-then-read round trip (Requirement 7, Criterion 14).
   - No-leak (Requirement 8, Criterion 6).
5. THE test suite SHALL include one separate Vault_Reader unit test for each of these cases:
   - (a) Key_Provider unavailable.
   - (b) Corrupt vault file.
   - (c) Missing vault file.
   - (d) Environment value that is an Unexpanded_Placeholder.
   - (e) Successful read after which the vault file has the same bytes and the same modification time as before.

   For cases (a) to (d), THE test SHALL assert that the result is `missing_secret` naming the variable, and that the message holds no secret value, no key material and no absolute path of the vault.
6. THE test suite SHALL include one Studio integration test that uses the memory or file test Key_Provider and a fake home folder, and THE test SHALL run these steps in order:
   - (a) Save a secret in Credentials for an application.
   - (b) Compile the Action.
   - (c) Install with the Install_Scope `global`.
   - (d) Start the generated `mcp-server.js` with only the `env` values of the written Server_Entry.
   - (e) Call the tool.

   THE test SHALL assert that the tool response is not `missing_secret`, and that the secret value is absent from the tool response and from every file written in the fake home and in the output folder.
7. THE test suite SHALL include one test that reads the generated Vault_Reader file and asserts that it contains no `import` or `require` specifier that resolves inside `src/`, whether relative or absolute.
8. WHEN the work of this spec is complete, THE final checkpoint report SHALL state, for each of `npm run build`, `npm run check:secrets`, `npx tsc --noEmit` and `npx vitest run`, the exit code and, for `npx vitest run`, the counts of passed, failed and skipped tests, and THE report SHALL show exit code 0 and 0 failed tests for all four commands.
9. WHEN the final checkpoint report is delivered, THE work SHALL stop and SHALL NOT start Step 2 or Step 3, until the user gives a new instruction.
