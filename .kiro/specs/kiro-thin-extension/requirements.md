# Requirements Document

## Introduction

Daemonize runs today as a local web application, the Studio, started with `daemonize` (the same as `daemonize studio --open`). Kiro is a VS Code based editor. This spec adds a thin Kiro extension (a `.vsix` package) so that a user can record, list, test and connect tools without leaving Kiro, while the Studio and the engine stay exactly where they are.

The spec has two parts.

Part A (Requirements 1 and 2) fixes two defects of the "Connect to Kiro" success dialog. Both must be done and re-tested before Part B starts:

1. `setContent` in `src/studio/ui/js/dialog.js` (and the initial content of `openDialog`) hands `null` children to `replaceChildren`, which writes the text "null" into the page. `showSuccess` in `src/studio/ui/js/views/connect.js` passes `null` for the missing-credentials block and for the auto-add-not-saved line, so the dialog shows "nullnull".
2. `showSuccess` shows "This tool needs no credentials." whenever the install answer has no placeholder. That is wrong when the tool needs credentials that are all saved in the Daemonize Secret_Vault: no placeholder is written, yet the tool does need credentials.

Part B (Requirements 3 to 17) adds `kiro-extension/`:

- The extension is a separate package. It never imports a Daemonize `src/` module and never bundles `playwright` or `node-pty`, which are native modules built for Node and not for the Electron ABI of Kiro.
- The extension starts the Daemonize CLI as a hidden background Node process and talks to it over loopback HTTP from the Extension Host, with the `x-studio-token` header.
- The UI is native: an Activity Bar container with TreeViews, commands, input boxes and modal confirmations. There is no webview and the Studio is never loaded in an iframe.
- The full Studio opens in the default browser through `vscode.env.openExternal`.
- The generated replay server gets a browser fallback chain (bundled Chromium, then Chrome, then Edge), so that a machine without the Playwright browser download still replays.

Constraints that apply to every requirement:

- The Studio security model stays in force and is not weakened: loopback listener, per-process token, HttpOnly SameSite=Strict cookie, Host and Origin checks, `x-studio-request` header on POST for cookie requests, CSP `default-src 'self'`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `redactForStudio` and `knownSecretValues`.
- Existing CLI commands and flags keep their behavior. The only CLI addition is one option of `daemonize studio`.
- No secret value and no Studio token appears in a file written by the extension, in a setting, in a log, in the Output channel, in a notification or in a message of the extension.
- Generated runtime files never import from `src/`.
- All user-facing text of the extension and of the changed Studio screens is Plain_Language.

Assumptions:

- Kiro exposes the VS Code extension API (`vscode`), runs the Extension Host on Node, and installs `.vsix` files (Open VSX format). The minimum engine version is set in the design phase.
- Node.js is installed on the user machine. The extension does not ship Node.
- The Studio takes its working folder from the process working directory: the default workflow file `daemonize.workflows.json` and the default output folder `daemonize-out` are relative to it. The extension therefore starts the process with the workspace folder as `cwd`.
- `GET /api/workflows` returns, for each action, `id`, `label`, `toolName` (when compiled) and `risk.highest` (`read`, `write` or `delete`). `GET /api/secrets?application=<Application_Key>` returns `{ name, kind, configured }` for each required secret. `GET /api/power/info` returns `kiroHomeExists` and the installs. These routes are read from `src/studio/server.ts`, `src/studio/routes/*.ts` and `src/studio/model.ts`.
- The Studio, once started, shows the data of one workflow file, so one Studio process serves one workspace folder.
- The names of required secrets are not values and may be shown. `placeholders`, `missingSecrets` and the new `requiredSecrets` hold names only.
- Publishing to a marketplace, a persistent browser profile, a Chrome MV3 extension and a semantic firewall or approval of write tools (Step 3) are out of scope.

## Glossary

- **Studio**: The local web application and JSON API served by `startStudio` in `src/studio/server.ts`.
- **Studio_UI**: The single-page interface served from `src/studio/ui/`, including `dialog.js`, `views/connect.js` and `copy.js`.
- **Connect_Dialog**: The dialog of the Studio_UI opened by "Connect to Kiro", built with `openDialog` and filled by `showPreview` and `showSuccess`.
- **Power_Installer**: `StudioPowerInstaller` in `src/studio/power-installer.ts`, with its routes in `src/studio/routes/power.ts`.
- **Secret_Vault**: The write-only local store of secret values (AES-256-GCM file, key held by the Windows DPAPI, the macOS Keychain or `secret-tool`).
- **Secret_Name**: The name of a required secret, such as `PASSWORD`, for the variable `DAEMONIZE_SECRET_PASSWORD`.
- **Placeholder_List**: The `placeholders` field of the install answer: the names written to the Kiro configuration without a value.
- **Required_Secrets**: The new `requiredSecrets` field, a sorted array of the Secret_Names the tool needs, whether they come from the Secret_Vault or from a placeholder. It holds names only.
- **Vault_Credentials_Message**: The exact text of `COPY.credentialsFromVault` defined in Requirement 2.
- **Plain_Language**: Wording that uses none of the terms {record, compile, storage state, environment variable, MCP, JSON, token, CLI} as a whole word, case-insensitive. Elements of type `code.path` are exempt. In the extension, file paths and the names of commands of the Daemonize CLI shown as code are exempt.
- **Extension**: The VS Code extension in `kiro-extension/`, packed as a `.vsix`.
- **Extension_Host**: The Node process of Kiro in which the Extension runs.
- **Pure_Module**: A module of the Extension that does not import `vscode`, so that it runs in a unit test without a fake editor.
- **Glue_Module**: A module of the Extension that imports `vscode` and calls the Pure_Modules.
- **Studio_Process**: The Daemonize CLI process started by the Extension with `daemonize studio --machine`.
- **Machine_Mode**: The new `--machine` option of `daemonize studio`.
- **Handshake_Line**: The single JSON line `{"origin":"...","token":"...","pid":<number>}` that the Studio_Process writes to stdout in Machine_Mode when the Studio is ready.
- **Studio_Origin**: The `origin` field of a valid Handshake_Line: `http://<loopback host>:<port>`.
- **Studio_Token**: The `token` field of a valid Handshake_Line. It lives in the memory of the Extension_Host only.
- **Studio_Client**: The Pure_Module of the Extension that sends requests to the Studio_Origin with the Studio_Token.
- **Process_Manager**: The Pure_Module of the Extension that starts, watches, restarts and stops the Studio_Process.
- **CLI_Locator**: The Pure_Module of the Extension that finds the Daemonize CLI and the Node runtime.
- **Working_Folder**: `workspaceFolders[0]` of the window.
- **Daemonize_View**: The Activity Bar container "Daemonize" with its TreeViews.
- **Output_Channel**: The Kiro output channel named "Daemonize" that receives redacted stderr lines.
- **Replay_Launcher**: The standalone browser launch code generated into the compiled output (`mcp-server.js` and `replay.ts`), which tries the bundled Chromium, then the `chrome` channel, then the `msedge` channel.
- **Browser_Missing_Error**: A launch error whose message matches "executable doesn't exist" or "Chromium distribution 'chrome' or 'msedge' is not found" (the patterns of `src/recorder/browser-launcher.ts`).
- **Vsix_Package**: The `.vsix` file produced by `@vscode/vsce package` from `kiro-extension/`.
- **Root_Checks**: The four commands `npm run build`, `npm run check:secrets`, `npx tsc --noEmit` and `npx vitest run`, run in the repository root.

## Requirements

### Requirement 1: Dialog content ignores empty children

**User Story:** As a Studio user, I want the Connect to Kiro dialog to show only real content, so that I never see the word "null" on screen.

#### Acceptance Criteria

1. WHEN `setContent` of a dialog receives a child that is `null`, `undefined` or `false`, THE Dialog SHALL leave that child out of the dialog body.
2. WHEN `openDialog` receives `content` that is `null`, `undefined` or `false`, or an array with such children, THE Dialog SHALL leave those children out of the initial dialog body.
3. WHEN `setContent` receives only nodes, THE Dialog SHALL render the nodes in the given order, with the same result as before this change.
4. WHEN `setContent` receives a mix of nodes and empty children, THE Dialog SHALL render the nodes in the given order without a text node for any empty child.
5. WHEN `showSuccess` runs for an install answer with no missing secret and without `autoAddSaved: false`, THE Connect_Dialog SHALL contain neither the text "null" nor the text "undefined".
6. FOR ALL combinations of `placeholders`, `missingSecrets`, `requiredSecrets`, `written` and `autoAddSaved` in an install answer, THE Connect_Dialog SHALL render a body whose text content contains neither "null" nor "undefined" as a whole word.
7. WHEN the unit tests of the Connect_Dialog run, THE tests SHALL cover the cases of criteria 1 to 6 with a DOM test in the style of `tests/unit/connect-view.test.ts`.

### Requirement 2: Correct credentials message on the success screen

**User Story:** As a Studio user, I want the success screen to say that my saved passwords will be used, so that I do not think the tool has no credentials.

#### Acceptance Criteria

1. THE Power_Installer SHALL include a field `requiredSecrets` in the answer of `POST /api/power/preview` and in the answer of `POST /api/power/install`, holding the sorted Secret_Names the tool needs and no value.
2. THE Power_Installer SHALL fill `requiredSecrets` from the same source as the existing `required` list of its plan, so that `missingSecrets` is always a subset of `requiredSecrets`.
3. WHEN the install answer has an empty Placeholder_List and a `requiredSecrets` list with at least one name, THE Connect_Dialog SHALL show the Vault_Credentials_Message and SHALL NOT show "This tool needs no credentials."
4. WHEN the install answer has an empty `requiredSecrets` list, THE Connect_Dialog SHALL show "This tool needs no credentials." and SHALL NOT show the Vault_Credentials_Message.
5. WHEN the install answer has a non-empty Placeholder_List, THE Connect_Dialog SHALL show the existing placeholders text and the names of the Placeholder_List, and SHALL NOT show the Vault_Credentials_Message.
6. WHEN the install answer has no `requiredSecrets` field (an older server), THE Connect_Dialog SHALL read `requiredSecrets` from the preview answer, and SHALL show no credentials sentence if neither answer has the field.
7. THE Studio_UI SHALL define `COPY.credentialsFromVault` with the exact text "This tool will use the passwords you saved in Daemonize. Nothing else to set up."
8. THE Vault_Credentials_Message SHALL pass the Plain_Language lint of the existing `tests/unit/studio-ui-copy.test.ts`.
9. WHEN the install answer lists Secret_Names in `missingSecrets`, THE Connect_Dialog SHALL keep showing the existing missing-credentials notice in addition to the credentials sentence of criteria 3 to 5.
10. WHEN the unit tests of the Connect_Dialog run, THE tests SHALL cover: all secrets saved, a secret with a placeholder, no secret at all, an answer without the field, and a mix of saved and missing secrets.
11. WHEN `npx vitest run tests/unit/connect-view.test.ts tests/unit/power-routes.test.ts tests/unit/power-installer.test.ts tests/unit/studio-ui-copy.test.ts` is run after Requirements 1 and 2 are complete, THE test run SHALL report 0 failed tests and exit with code 0.

### Requirement 3: Machine-readable startup of the Studio

**User Story:** As the Extension, I want the Studio to announce its address and token in one parsable line, so that I can connect without opening a browser.

#### Acceptance Criteria

1. THE `daemonize studio` command SHALL accept a new option `--machine`, described in its help text.
2. WHEN `daemonize studio --machine` has started the Studio, THE command SHALL write exactly one line to stdout: a JSON object with the fields `origin` (string), `token` (string) and `pid` (number, the process id of the Studio_Process), followed by a newline.
3. WHILE the option `--machine` is set, THE command SHALL write nothing else to stdout, including the address line and the Ctrl+C line that it writes today.
4. WHILE the option `--machine` is set, THE command SHALL NOT open a browser, even when `--open` is also given.
5. WHILE the option `--machine` is set, THE command SHALL send its warnings and messages to stderr, and SHALL NOT write the token to stderr.
6. THE Handshake_Line SHALL carry the `origin` of the `StudioHandle` (no token inside it) and the `token` of the `StudioHandle` as separate fields.
7. IF the Studio fails to start while `--machine` is set, THEN THE command SHALL write a plain error message to stderr, write nothing to stdout, and exit with a non-zero code.
8. WHEN `daemonize studio` runs without `--machine`, THE command SHALL behave exactly as before this feature, including its output lines and its handling of `--open`.
9. WHEN `daemonize` runs with no subcommand, THE command SHALL behave exactly as before this feature.
10. WHILE the option `--machine` is set and the `--host` value is not a loopback address, THE command SHALL apply the existing `--allow-remote` rule, and the Extension SHALL refuse the resulting Handshake_Line under Requirement 5.
11. FOR ALL Handshake_Lines written by Machine_Mode, parsing the line as JSON then serializing then parsing SHALL produce an equal object (round-trip property of the Handshake_Line parser and printer).

### Requirement 4: Finding the Daemonize CLI and Node

**User Story:** As a user, I want the extension to find Daemonize on my machine, so that it works without configuration in the usual installs.

#### Acceptance Criteria

1. WHERE the setting `daemonize.cliPath` is not empty, THE CLI_Locator SHALL use it as the Daemonize CLI, whether it points to a `dist/cli/index.js` file or to a `daemonize` executable.
2. WHERE the setting `daemonize.cliPath` is empty, THE CLI_Locator SHALL look, in this order, for `node_modules/.bin/daemonize` (`daemonize.cmd` on Windows) in the Working_Folder, then `node_modules/daemonize/dist/cli/index.js` in the Working_Folder, then `daemonize` on the `PATH` entries.
3. THE CLI_Locator SHALL resolve each candidate by reading the file system and the `PATH` entries, without starting a shell.
4. WHERE the setting `daemonize.nodePath` is not empty, THE CLI_Locator SHALL use it as the Node runtime for a CLI that is a `.js` file.
5. WHERE the setting `daemonize.nodePath` is empty, THE CLI_Locator SHALL use `node` found on the `PATH` entries as the Node runtime.
6. IF neither `daemonize.nodePath` nor the `PATH` provides Node, THEN THE Process_Manager SHALL use `process.execPath` with the environment variable `ELECTRON_RUN_AS_NODE=1` as the Node runtime, and THE Output_Channel SHALL state that this fallback is in use.
7. WHEN the CLI is an executable (not a `.js` file), THE CLI_Locator SHALL return that executable as the command and SHALL NOT require a Node runtime.
8. IF no CLI is found, THEN THE Extension SHALL show a plain message that says Daemonize was not found and offers the actions "Choose the file" (sets `daemonize.cliPath`) and "Open settings".
9. IF the configured `daemonize.cliPath` does not exist, THEN THE Extension SHALL show a plain message that names the path and offers the same actions, and SHALL NOT fall back to another location.
10. THE CLI_Locator SHALL return the same result for the same file system and environment (deterministic), and a unit test SHALL cover each order step with a fake file system.
11. THE Extension SHALL document in its README the Node fallback of criterion 6 and the reason: the Electron binary is not the Node build for which `node-pty` and `playwright` are installed.

### Requirement 5: Handshake validation and request rules

**User Story:** As a user, I want the extension to talk only to my own local Studio, so that the token and my data cannot reach another host.

#### Acceptance Criteria

1. WHEN the Studio_Process writes a line to stdout, THE Process_Manager SHALL accept it as the Handshake_Line only if it is a JSON object with a string `origin`, a string `token` and an integer `pid` greater than 0, and no other field of another type that changes these three.
2. THE Process_Manager SHALL accept an `origin` only if it parses as a URL with the scheme `http`, a host equal to `127.0.0.1`, `localhost` or `[::1]`, an explicit port from 1 to 65535, an empty path (or `/`), and no user name, password, query or fragment.
3. THE Process_Manager SHALL accept a `token` only if it matches `^[A-Za-z0-9_-]{16,128}$` (the base64url form of the Studio).
4. IF the Handshake_Line is invalid, or the `origin` is not a loopback address, THEN THE Process_Manager SHALL stop the Studio_Process, show a plain error, and SHALL NOT send any request.
5. IF the Studio_Process writes a second line to stdout that parses as a Handshake_Line, THEN THE Process_Manager SHALL ignore it and keep the first.
6. IF the Studio_Process does not write a valid Handshake_Line within 30 seconds of its start, THEN THE Process_Manager SHALL stop it and show a plain message with the action "Try again".
7. THE Studio_Client SHALL send every request to the Studio_Origin only, with the header `x-studio-token` set to the Studio_Token and with the `Host` header of that origin.
8. THE Studio_Client SHALL send every POST request with the header `Content-Type: application/json`, a JSON object body, and the header `x-studio-request: 1`.
9. THE Studio_Client SHALL refuse a request path that does not start with `/api/`, and SHALL NOT follow a redirect.
10. THE Studio_Client SHALL treat the HTTP status 401 as "the Studio restarted" and SHALL ask the Process_Manager for a fresh start instead of retrying with the same token.
11. THE Studio_Client SHALL apply a timeout of 15 seconds to each request, and 120 seconds to the routes `POST /api/power/install` and `POST /api/power/preview`.
12. FOR ALL strings given to the origin validator, THE validator SHALL accept exactly the loopback `http` origins of criterion 2 and refuse every other string (property test).

### Requirement 6: Opening the Studio in the browser

**User Story:** As a user, I want a button that opens the full Studio in my browser, already signed in, so that I can use pages that need a full screen.

#### Acceptance Criteria

1. WHEN the user runs "Open the Studio", THE Extension SHALL call `vscode.env.openExternal` with the URL `<Studio_Origin>/?token=<Studio_Token>`.
2. THE Extension SHALL rely on the existing first-visit flow of the Studio, which answers with a redirect that sets the HttpOnly SameSite=Strict cookie and removes the token from the address bar.
3. WHEN the user runs "Test in the Studio" for an action, THE Extension SHALL open the Studio Playground by calling `vscode.env.openExternal` with the URL `<Studio_Origin>/?token=<Studio_Token>#<route>`, where `<route>` is the hash route of the Studio_UI Playground (read from `src/studio/ui/js/router.js` at design time).
4. THE Extension SHALL NOT load the Studio in a webview, an iframe or an embedded browser.
5. THE Extension SHALL NOT copy the URL with the token to the clipboard, show it in a message, write it to the Output_Channel, or store it.
6. IF the Studio_Process is not running when the user runs one of these commands, THEN THE Extension SHALL start it first, under Requirement 8.
7. WHEN `vscode.env.openExternal` returns `false`, THE Extension SHALL show a plain message that says the browser could not be opened, without the URL.

### Requirement 7: Working folder

**User Story:** As a user, I want Daemonize to use my project folder, so that my actions are saved with my project.

#### Acceptance Criteria

1. THE Process_Manager SHALL start the Studio_Process with the Working_Folder as its `cwd`.
2. IF no folder is open in the window, THEN THE Daemonize_View SHALL show a plain message that asks the user to open a folder, with a button "Open a folder", and THE Extension SHALL NOT start the Studio_Process.
3. WHEN more than one folder is open, THE Extension SHALL use the first one and SHALL tell the user in the Daemonize_View, in plain words, which folder is used.
4. WHEN the first workspace folder changes (added, removed or reordered), THE Extension SHALL stop the Studio_Process, and SHALL start a new one for the new Working_Folder on the next use.
5. IF the Working_Folder is a virtual or remote folder whose scheme is not `file`, THEN THE Extension SHALL show a plain message that Daemonize needs a folder on this computer, and SHALL NOT start the Studio_Process.

### Requirement 8: Studio process lifecycle

**User Story:** As a user, I want the background process to start when needed and to disappear when I close the window, so that nothing stays running.

#### Acceptance Criteria

1. THE Process_Manager SHALL start the Studio_Process with `child_process.spawn`, with `shell: false`, `windowsHide: true`, `stdio` set to `['ignore', 'pipe', 'pipe']`, and the command, arguments and `cwd` returned by the CLI_Locator and the Working_Folder.
2. THE Process_Manager SHALL start the Studio_Process with the arguments `studio --machine` and no `--open`.
3. THE Process_Manager SHALL keep at most one Studio_Process per window.
4. WHEN the user first runs a command that needs the Studio, or first expands the Daemonize_View, THE Process_Manager SHALL start the Studio_Process if none is running, and SHALL wait for the Handshake_Line before the command sends its request.
5. WHILE a start is in progress, THE Process_Manager SHALL give every further caller the same pending start instead of spawning a second process.
6. WHEN the Extension deactivates or the window closes, THE Process_Manager SHALL stop the Studio_Process and its child processes.
7. WHILE the platform is Windows, THE Process_Manager SHALL stop the process tree with `taskkill /pid <pid> /T /F` started without a shell.
8. WHILE the platform is not Windows, THE Process_Manager SHALL send `SIGTERM` to the process group, and SHALL send `SIGKILL` if the process is still alive 5 seconds later.
9. WHEN the Studio_Process exits while the Extension is active and the exit was not requested, THE Process_Manager SHALL mark the state "stopped unexpectedly", and THE Daemonize_View SHALL show a plain message with a button "Restart".
10. WHEN the user runs "Restart Daemonize", THE Process_Manager SHALL stop the current Studio_Process, wait until it has exited, start a new one, and refresh the Daemonize_View.
11. THE Process_Manager SHALL NOT restart the Studio_Process by itself after a crash.
12. WHEN the user runs "Stop Daemonize", THE Process_Manager SHALL stop the Studio_Process and THE Daemonize_View SHALL show the state "stopped".
13. WHEN the Extension deactivates, THE Process_Manager SHALL leave no Studio_Process of this window running, checked by a test that spawns a real CLI, deactivates, and checks that the pid is gone within 10 seconds.
14. THE Process_Manager SHALL pass to the Studio_Process an environment copied from the Extension_Host with no added secret, and SHALL NOT add the Studio_Token to the environment.
15. THE Process_Manager SHALL expose its state (`stopped`, `starting`, `running`, `crashed`) as a value that the Daemonize_View and the status bar read.

### Requirement 9: Logs without secrets

**User Story:** As a user, I want a log that helps me find problems and never shows my passwords.

#### Acceptance Criteria

1. THE Extension SHALL create one Output_Channel named "Daemonize".
2. WHEN the Studio_Process writes a line to stderr, THE Extension SHALL write that line to the Output_Channel after redaction.
3. THE redactor SHALL replace with `***` every occurrence of the Studio_Token, every value of an environment variable of the Extension_Host whose name starts with `DAEMONIZE_SECRET_`, every `token=` query value, and every value of the form `Bearer <text>`.
4. THE Extension SHALL NOT write any stdout line of the Studio_Process to the Output_Channel.
5. THE Extension SHALL NOT write a secret value that the user types in an input box to the Output_Channel, to a notification, to a setting, to a file or to the error text of a failed request.
6. WHEN a request to the Studio fails, THE Extension SHALL log the method, the path (without query) and the HTTP status only.
7. FOR ALL strings that contain the Studio_Token, THE redactor output SHALL NOT contain the Studio_Token (property test).

### Requirement 10: Daemonize view and status

**User Story:** As a user, I want a Daemonize icon in the sidebar that shows what is going on, so that I find my tools in one place.

#### Acceptance Criteria

1. THE Extension SHALL contribute an Activity Bar container "Daemonize" with its own icon file, containing the TreeViews "Actions", "Credentials" and "Kiro".
2. THE Extension SHALL contribute the commands of Requirements 6 to 15 to the command palette under the category "Daemonize".
3. THE Extension SHALL show the state of the Process_Manager in the Daemonize_View as a plain sentence (for example "Daemonize is starting", "Daemonize is ready", "Daemonize stopped").
4. WHILE the state is `crashed` or `stopped`, THE Daemonize_View SHALL show the button "Restart" or "Start" as the first item.
5. THE Extension SHALL NOT use a webview, a `WebviewViewProvider` or a `WebviewPanel`.
6. THE Extension SHALL NOT activate on startup of the editor: THE activation events SHALL be the Daemonize_View, the Daemonize commands, and nothing else.
7. THE Extension SHALL show every user-facing string (labels, descriptions, messages, tooltips, input prompts, button names) in Plain_Language, and THE test suite SHALL lint all strings of `package.json` contributions and of the string table of the Extension with the Plain_Language list.
8. THE Extension SHALL keep all user-facing strings in one string table module, so that the lint of criterion 7 reads one source.

### Requirement 11: New action from the sidebar

**User Story:** As a user, I want to record a new action from Kiro by answering three questions, so that I start without reading the Studio.

#### Acceptance Criteria

1. WHEN the user runs "New action", THE Extension SHALL ask, in this order, for the name (input box), the start address (input box), and whether to reuse a saved login (quick pick "Yes" or "No").
2. THE name input box SHALL validate the text as the Studio does in `validateName` (trimmed, 1 to 80 characters, an ASCII letter or digit, no control character) and SHALL show the plain error text of the Studio for an invalid value.
3. THE address input box SHALL validate the text as the Studio does in `validateUrl` (trimmed, at most 2048 characters, absolute `http` or `https`, no user name or password).
4. THE validators of the Extension SHALL be Pure_Modules that give the same verdict as `validateName` and `validateUrl` for the same input, checked by a test over a shared list of valid and invalid inputs.
5. WHEN the user confirms the three answers, THE Extension SHALL send `POST /api/record/start` with the body `{ "name": <name>, "url": <url>, "reuseSession": <boolean> }`.
6. IF the Studio answers 400 with a `field`, THEN THE Extension SHALL show the plain `error` text of the answer and SHALL offer to correct that field.
7. IF the Studio answers 409, THEN THE Extension SHALL show the plain `error` text of the answer, for example that a recording is already running.
8. WHEN the Studio answers 202, THE Extension SHALL start polling `GET /api/record/status` every 1 second and SHALL stop polling when the state is no longer a recording state.
9. WHILE a recording runs, THE Daemonize_View SHALL show the state in plain words and the last steps of the status answer, and THE status bar SHALL show a "Recording" item.
10. WHILE a recording runs, THE Extension SHALL show a "Finish" button in the Daemonize_View title and in the status bar item.
11. WHEN the user runs "Finish", THE Extension SHALL send `POST /api/record/stop` with an empty JSON object, and SHALL keep polling until the state shows that the recording is saved or has failed.
12. WHEN the recording is saved, THE Extension SHALL refresh the list of actions and show a plain message with the name of the new action.
13. IF the recording fails, THEN THE Extension SHALL show the plain message of the status answer.
14. IF the status polling fails three times in a row, THEN THE Extension SHALL stop polling and show a plain message with the action "Restart".
15. THE Extension SHALL NOT start more than one polling loop at the same time.

### Requirement 12: List of actions and tools

**User Story:** As a user, I want to see my actions with their risk, so that I know which ones change data.

#### Acceptance Criteria

1. WHEN the "Actions" view is shown or refreshed, THE Extension SHALL send `GET /api/workflows` and show one tree item per workflow, labelled with its `label`.
2. THE Extension SHALL show, for each item, a plain description of `risk.highest`: "Reads only" for `read`, "Changes data" for `write`, and "Deletes data" for `delete`, with a distinct icon for each level.
3. WHERE the workflow has a `toolName`, THE Extension SHALL show it in the tooltip of the item.
4. WHERE the workflow has no `toolName`, THE Extension SHALL show in the tooltip that the action is not connected yet.
5. IF the answer holds no workflow, THEN THE Daemonize_View SHALL show a plain message with the button "New action".
6. IF the request fails, THEN THE Daemonize_View SHALL show a plain message and a button "Try again", and SHALL NOT show a stack trace.
7. THE Extension SHALL send no workflow content other than the fields above to the UI, and SHALL NOT log the answer.
8. THE item of an action SHALL offer the inline commands "Test in the Studio" and "Connect to Kiro".
9. WHEN the user runs "Refresh", THE Extension SHALL reload the list of actions, the credentials and the Kiro installs.

### Requirement 13: Credentials per application

**User Story:** As a user, I want to see which passwords are saved and to set them from Kiro, so that I do not leave the editor.

#### Acceptance Criteria

1. WHEN the "Credentials" view is shown or refreshed, THE Extension SHALL send `GET /api/secrets` and show one tree item per required secret with its name and kind.
2. WHERE the secret has `configured: true`, THE Extension SHALL show "has a value".
3. WHERE the secret has `configured: false`, THE Extension SHALL show "has no value yet".
4. WHEN the user runs "Set a credential" on an item, THE Extension SHALL open `vscode.window.showInputBox` with `password: true`, `ignoreFocusOut: true` and a plain prompt that names the secret.
5. WHEN the user confirms a non-empty value, THE Extension SHALL send `POST /api/secrets` with the body `{ "name": <name>, "value": <value> }`, and SHALL drop the value from memory after the request ends, by letting it go out of scope without storing it in a field, a cache or a closure that outlives the request.
6. WHERE the secret has the kind `totp`, THE Extension SHALL accept an `otpauth://` link or a Base32 key in the input box, send the text unchanged, and let the Studio extract the key as `extractTotpSecret` does.
7. IF the Studio answers 400, THEN THE Extension SHALL show the plain `error` text of the answer, without the value.
8. IF the Studio answers 503, THEN THE Extension SHALL show the plain `error` text of the answer, which says that the safe store of this computer is unavailable.
9. WHEN the answer is 200, THE Extension SHALL refresh the Credentials view and show "has a value" for the secret.
10. THE Extension SHALL NOT write a secret value to the Output_Channel, a setting, a file, the clipboard, a notification, a tree item, a tooltip or the error text.
11. WHEN the user runs "Forget a credential" on an item, THE Extension SHALL ask for confirmation in a modal message, then send `POST /api/secrets/forget` with `{ "name": <name> }`.
12. WHEN the user dismisses the input box, THE Extension SHALL send no request.
13. FOR ALL secret values typed in tests, THE Extension SHALL send each value only in the body of the one `POST /api/secrets` request and in no other output of the Extension (test with a recording fake client and a fake `vscode`).

### Requirement 14: Connect to Kiro and remove

**User Story:** As a user, I want one click to add a tool to Kiro, with a clear confirmation of what will be written.

#### Acceptance Criteria

1. WHEN the user runs "Connect to Kiro" on an action, THE Extension SHALL send `GET /api/power/info`, and SHALL choose the scope `global` when `kiroHomeExists` is `true`, and `project` otherwise.
2. WHEN the scope is `project`, THE Extension SHALL send the Working_Folder path as `workspacePath` in the preview request.
3. THE Extension SHALL send `POST /api/power/preview` with the body `{ "scope": <scope>, "workspacePath": <path> }` (the `workspacePath` field only for `project`).
4. WHEN the preview answer arrives, THE Extension SHALL show a modal confirmation with `vscode.window.showWarningMessage` and `{ modal: true }`, whose detail text lists the `kiroPath`, each file path with its outcome in plain words (create, merge, replace), and the backup statement.
5. WHERE the preview answer has `replacesEntry: true`, THE modal confirmation SHALL say that an existing entry will be replaced.
6. WHERE the preview answer has a non-empty `missingSecrets` list, THE modal confirmation SHALL list those names and say that the tool may fail until they get a value.
7. WHEN the user confirms, THE Extension SHALL send `POST /api/power/install` with the `confirmationId`, `kiroPath` and `scope` of the preview answer.
8. WHEN the user cancels the modal, THE Extension SHALL send no install request.
9. WHEN the install answer arrives with status 200, THE Extension SHALL show a plain message with the written files and the reminder that Kiro must reload the tool list or restart, the same advice as `COPY.connectedReload`.
10. WHEN the install answer arrives with an empty Placeholder_List and a non-empty `requiredSecrets` list, THE Extension SHALL show the Vault_Credentials_Message, and WHEN `requiredSecrets` is empty THE Extension SHALL show "This tool needs no credentials."
11. IF the Studio answers 409 or 400, THEN THE Extension SHALL show the plain `error` text of the answer.
12. WHEN the user runs "Remove from Kiro", THE Extension SHALL read the installs from `GET /api/power/info`, ask for the scope when more than one install exists, show a modal confirmation with the `kiroPath`, and send `POST /api/power/remove` with `{ "scope": <scope> }`.
13. WHERE no install exists, THE "Remove from Kiro" command SHALL show a plain message that nothing is connected.
14. THE "Kiro" view SHALL list the installs of `GET /api/power/info` with their scope and path, and offer the inline command "Remove from Kiro".
15. THE Extension SHALL NOT write any file in a `.kiro` folder by itself: every write goes through the Power_Installer routes.

### Requirement 15: Replay browser fallback in generated servers

**User Story:** As a user, I want a compiled tool to replay on a machine that has Chrome or Edge but not the Playwright browser download, so that it works after a plain install.

#### Acceptance Criteria

1. THE generator of `src/compiler/mcp-generator.ts` SHALL emit, for web targets, a standalone Replay_Launcher in the generated runtime, and SHALL use it at every place where the generated code calls `chromium.launch` today (the replay server launch at about line 301 and the playground session launch at about line 376).
2. WHEN the environment variable `DAEMONIZE_CHROMIUM_PATH` is not empty, THE Replay_Launcher SHALL launch that executable first, as the generated code does today.
3. WHEN the launch with the bundled Chromium fails with a Browser_Missing_Error, THE Replay_Launcher SHALL try the channel `chrome`, and WHEN that fails with a Browser_Missing_Error, THE Replay_Launcher SHALL try the channel `msedge`.
4. WHEN a launch fails with an error that is not a Browser_Missing_Error, THE Replay_Launcher SHALL throw that error without trying another browser.
5. WHEN all attempts fail with a Browser_Missing_Error, THE Replay_Launcher SHALL throw an error whose message says that no browser was found and names `DAEMONIZE_CHROMIUM_PATH`, and the existing error handling of the generated code SHALL turn it into the existing structured failure.
6. WHERE the environment variable `DAEMONIZE_IN_CONTAINER` is set, THE Replay_Launcher SHALL pass `--no-sandbox` to every attempt, as the generated code does today.
7. THE Replay_Launcher SHALL keep `headless: true` and the other launch options that the generated code passes today.
8. THE generated runtime files SHALL NOT import from `src/`, and the existing test `tests/unit/generated-no-src-import.test.ts` SHALL stay green.
9. THE generator SHALL emit the Replay_Launcher as a separate generated file or as an inline function whose text is the same on every compile of the same input (deterministic output).
10. THE tests SHALL run the generated Replay_Launcher with a fake `chromium` object and cover: the bundled browser works, the bundled browser is missing and Chrome works, the bundled browser and Chrome are missing and Edge works, all three are missing, and a non-missing error stops the chain.
11. THE tests SHALL assert that the order of attempts, the Browser_Missing_Error patterns and the container flag of the generated Replay_Launcher match those of `src/recorder/browser-launcher.ts`.

### Requirement 16: Packaging of the Extension

**User Story:** As a maintainer, I want a small `.vsix` that holds no native module, so that it installs in Kiro on every platform.

#### Acceptance Criteria

1. THE repository SHALL contain `kiro-extension/` with its own `package.json`, `tsconfig.json`, a bundle script that uses `esbuild`, a `.vscodeignore`, a `README.md` and a `LICENSE` reference.
2. THE `package.json` of the Extension SHALL declare `engines.vscode`, `main`, `activationEvents`, `contributes` (commands, views, viewsContainers, menus, configuration with `daemonize.cliPath` and `daemonize.nodePath`), `publisher`, `name`, `version` and `repository`.
3. THE bundle script SHALL produce one CommonJS file for the Extension_Host, with `vscode` marked as external, from the sources of `kiro-extension/` only.
4. THE bundle SHALL NOT include `playwright`, `node-pty` or any module of the root `src/` folder, and THE sources of `kiro-extension/` SHALL NOT import a path that resolves into the root `src/` folder.
5. THE Extension SHALL have no runtime dependency (`dependencies` empty); build tools SHALL be `devDependencies`.
6. WHEN `npx @vscode/vsce package` is run in `kiro-extension/`, THE command SHALL produce a Vsix_Package and exit with code 0.
7. WHEN `npx @vscode/vsce ls` is run in `kiro-extension/`, THE file list SHALL contain no path with `playwright`, `node-pty`, `node_modules`, `src/` of the root project, `.map` files, or test files.
8. THE test suite SHALL include a packaging check that lists the files of the Vsix_Package and fails when one of the paths of criterion 7 is present or the file size exceeds 500 KB.
9. THE root `package.json` SHALL stay free of the Extension dependencies, and `npm run build` of the root project SHALL NOT build the Extension.
10. THE root `tsconfig.json` (`include: ["src/**/*"]`) SHALL stay unchanged, so that `npx tsc --noEmit` does not compile `kiro-extension/`, and the Extension SHALL have its own `tsc --noEmit` check through a script `typecheck`.
11. THE `.gitignore` SHALL exclude the build output and the `.vsix` file of `kiro-extension/`.
12. THE README of the Extension SHALL state how to build and how to install the `.vsix` in Kiro, the two settings, the Node requirement, and that the Studio opens in the default browser.

### Requirement 17: Tests, checks and checkpoint

**User Story:** As a maintainer, I want the feature proven by tests and the repository checks green, so that I can trust the result before I try it in Kiro.

#### Acceptance Criteria

1. THE Extension SHALL separate Pure_Modules (handshake parser, origin validator, CLI_Locator, Process_Manager core, Studio_Client, validators, redactor, string table, tree models) from Glue_Modules (activation, commands, TreeView providers, status bar).
2. THE unit tests of the Pure_Modules SHALL run with no `vscode` module, and THE unit tests of the Glue_Modules SHALL run against a fake `vscode` module that records calls (`showInputBox`, `showWarningMessage`, `openExternal`, `createOutputChannel`, `registerCommand`).
3. THE Extension tests SHALL run in the root vitest configuration as an added project named `extension`, under `tests/extension/**/*.test.ts`, using the setup file `./tests/setup/clean-env.ts`, so that `npx vitest run` covers them.
4. THE root `tsc --noEmit` SHALL stay at 0 errors, which means the tests under `tests/extension/` import the Extension sources through relative paths and the root `tsconfig.json` is unchanged (tests are outside its `include`).
5. THE tests SHALL include an integration test that spawns the real CLI (`dist/cli/index.js`) with `studio --machine` in a temporary folder, reads the Handshake_Line, calls `GET /api/health`, `GET /api/workflows` and `GET /api/secrets` with the `x-studio-token` header, checks that a request without the token answers 401, and stops the process.
6. THE integration test SHALL check that stdout of the process holds exactly one line, and that the token appears in no stderr line.
7. THE tests for Requirement 3 SHALL cover: one stdout line, no browser opened with `--open --machine`, no output change without `--machine`, the error path with a non-zero exit code, and the round-trip of Criterion 3.11.
8. WHEN the Root_Checks are run after all requirements are complete, THE repository SHALL report: `npm run build` exit code 0, `npm run check:secrets` exit code 0, `npx tsc --noEmit` 0 errors and exit code 0, and `npx vitest run` 0 failed tests and exit code 0.
9. WHEN `npx vitest run` is run with `DAEMONIZE_SECRET_PASSWORD` set in the parent shell, THE test suite SHALL report 0 failed tests.
10. WHEN the Extension build, `typecheck` and `vsce package` are run in `kiro-extension/`, THE commands SHALL exit with code 0.
11. WHEN the final checkpoint is reached, THE implementation SHALL report the exact results of the four Root_Checks and of the Extension build and package commands, and SHALL then stop for validation by the user in Kiro, without starting Step 3.
12. THE `npm run check:secrets` script SHALL scan `kiro-extension/` and report no finding.
13. IF a Root_Check fails, THEN THE implementation SHALL report the failure and its cause instead of marking the feature complete.
