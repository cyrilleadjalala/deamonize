# Daemonize for Kiro

Daemonize is not affiliated with Kiro or AWS. The colours follow the public look of kiro.dev, see `docs/design-tokens.md` in the repository.

A small Kiro extension to create, list, test and connect Daemonize tools from the sidebar. It does not replace the Studio. It starts the Daemonize program in the background, shows your actions and credentials in three side panels, and opens the full Studio in your default browser when you need it.

## What you get

- **Actions**: your tools, each with a label (Reads only, Changes data, Deletes data). "New action" starts a recording, "Finish" saves it.
- **Credentials**: the names of the passwords you saved, with "has a value" or "has no value yet". The extension never shows a value.
- **Kiro**: connect your tools to Kiro or remove them again.
- **Activity**: the calls made by Kiro and the agent, with "Open all activity" for the full list in the Studio.
- **Build a tool with the Daemonize agent**: opens the chat with the `daemonize` agent (`.kiro/agents/daemonize.md`), which builds a tool with you through the Studio MCP (`daemonize mcp`). It can read and record, and it asks before it compiles, tests or installs.
- **Install the Daemonize Power** and **Remove the Daemonize Power**: install or remove the Power in `power/` (the agent, the skill, the rules and the MCP entry). The `daemonize` command must be on your PATH for the Powers panel.
- **Open the Studio** and **Test in the Studio** open the Studio in your default browser. There is no web view inside Kiro.
- Approval questions appear in the Activity panel with the commands "Approve" and "Deny" (`daemonize.approve`, `daemonize.deny`). The Studio shows the same questions. The agent cannot answer them.

## Requirements

- Node.js 20 or newer, to build the extension and to run the Daemonize program.
- A folder open in Kiro. The Daemonize program runs in that folder. Open a normal local folder. Untrusted and virtual workspaces are not supported.
- The Daemonize program, installed in the folder (`node_modules/.bin/daemonize`), or on your PATH, or chosen by you with the `daemonize.cliPath` setting. It must be a version that knows `daemonize studio --machine`.

## Build and package

From the `kiro-extension/` folder:

```powershell
npm ci
npm run typecheck
npm run build
npm run package
```

`npm run build` writes one file, `dist/extension.js`. `npm run package` writes `daemonize-kiro-0.1.0.vsix` in the same folder. `npm run ls` lists the files that go into the package.

You also need to build the Daemonize program itself once, from the repository root: `npm install` then `npm run build`. The program is then `node dist/cli/index.js`.

## Install in Kiro

1. Open the Extensions view in Kiro.
2. Open the "..." menu at the top of that view and choose **Install from VSIX...**.
3. Pick `kiro-extension/daemonize-kiro-0.1.0.vsix`.
4. Reload the window if Kiro asks for it. A Daemonize icon appears in the activity bar.

Expanding the Actions panel starts the Daemonize program for the open folder. You do not need to start anything by hand.

## Settings

Both settings apply to your machine only. A `.vscode/settings.json` inside a downloaded folder cannot change them.

| Setting | Meaning |
|---|---|
| `daemonize.cliPath` | Full path to the Daemonize program (a `.js` file, an `.exe`, or the `daemonize` command). Leave it empty to look in the folder first (`node_modules/.bin`), then on your PATH. If you set a path that does not exist, the extension tells you and does not look elsewhere. |
| `daemonize.nodePath` | Full path to `node`. Leave it empty to use `node` from your PATH. |

### Node and the Electron fallback

When the Daemonize program is a `.js` file, the extension needs Node to run it. It uses `daemonize.nodePath` if set, then `node` from your PATH. If neither exists, it falls back to the Node built into Kiro itself, by running Kiro's own program with the environment variable `ELECTRON_RUN_AS_NODE=1`. The reason: Kiro is built on Electron, which contains Node, so people without a separate Node install can still use the extension. Install Node 20 or newer if you can, as the built-in version may be older.

On Windows, the extension never starts a `.cmd` file. It reads the `daemonize.cmd` shim, finds the `.js` file it points to, and runs that with Node. Recent Node versions refuse to start `.cmd` files without a shell, and the extension does not use a shell.

## Opening the Studio

"Open the Studio" and "Test in the Studio" ask Kiro to open your default browser at the local Studio address. The address carries a one-time sign-in key, which the Studio swaps for a cookie and removes from the address bar. The extension never prints, logs, copies or shows that address. If your system cannot open a browser, the extension says so without showing the address.

## Security

- The sign-in key exists only in memory, in the Kiro extension process, and in the browser you open. The extension writes no file, no cache, and no setting for it.
- The Studio listens on this computer only (`127.0.0.1`). The extension refuses any other address.
- Requests carry the key in a header. Secret values you type are sent once, to the Studio, and are never logged.
- The Daemonize program's messages are redacted before they reach the "Daemonize" output panel.
- No web view is used. Packaged code has no runtime dependencies.

## Known limits

- **Orphan Studio.** The extension stops the Daemonize program when Kiro closes or the extension is turned off, and `studio --machine` also shuts itself down if its parent extension process exits abruptly. If an OS kill leaves any child window or process behind, end the `node` process (Task Manager on Windows) or run **Daemonize: Restart** after the next start. The extension does not restart a crashed program by itself.
- One Studio per window, for the first open folder only. With several folders open, the extension asks you to choose one.
- Generated tools need a browser to replay. Chrome or Edge is used if Chromium is not installed for Playwright.

## Repository

The `repository` field of `package.json` comes from `git remote get-url origin` of this project. If the project has no remote yet, the placeholder `https://github.com/OWNER/daemonize.git` is used. Replace `OWNER` before you publish the package.
