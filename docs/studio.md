# Daemonize Studio

A local, dependency-free web UI over your workflows, replay levels, state graph, schemas and property-test results.

## Run it

```
daemonize studio --sample            # fictitious sample data, nothing is read from disk
daemonize studio daemonize-out --workflows daemonize.workflows.json --open
```

Open the printed address (it carries a per-run token that is moved into a cookie). Everything is served from
`src/studio/ui` (`dist/studio/ui` after `npm run build`, which copies the folder). No CDN, font or script is loaded:
the server's CSP is `default-src 'self'`.

`daemonize studio --machine` is for editor extensions. It opens no browser, prints one JSON line `{ origin, token, pid }` on stdout and sends every message to stderr. It also stops the Studio when the process that started it exits (checked every second), so a crashed editor leaves no Studio running.

## Views

| Route | Shows |
| --- | --- |
| `#/` | Targets, replay level mix, strict/heal/HTTP flags, health strip (tests, drift, secret names) |
| `#/workflows[/id]` | Workflow list; step timeline with a replay-level badge per step, variables, secret names |
| `#/graph[?wf=id]` | Layered SVG graph, pan/zoom (mouse and keyboard), path of a workflow, list view above 200 screens |
| `#/schemas[/id]` | Input/output schema tables, raw JSON, copy, OpenAPI paths |
| `#/tests` | Property-test results, shrunk counterexamples, **Run tests** (disabled in sample mode) |
| `#/playground` | Call the compiled tools; shows each credential as configured or missing, with a link to Credentials |
| `#/record` | Status of the recording in progress: state, step count, last 3 step labels, **Finish and save**, then **Test it** and the connect card |
| `#/credentials` | One row per credential the actions need, with a masked input, **Save** and **Remove** |

Workflow view details:
- A note under the header lists the steps that write (`write` or `delete`): "The only write is the login form: step N, ..." for a login-only workflow, or "Writes data in N steps:" with "Step N: label (write)" for the others. Read-only workflows show no note. Step numbers start at 1.
- The playground confirmation dialog for a write or delete tool lists the same steps (numbers and labels only, no argument or secret value). Without that data it keeps the generic sentence.
- Variable names (`{{name}}` chips of the Variables table) stay on one line; the table scrolls sideways when the column is narrow.
- Secrets show names with a `configured` or `missing` chip; names recorded in HTTP recipes but not read by the compiled server sit in a collapsed list.

Keyboard: Tab / Shift+Tab, Enter on a workflow or screen, arrows in the workflow list, arrows/`+`/`-`/`0` on the graph canvas.
The footer's **Print view** button prints a light, control-free version.

## Studio-first flow

`daemonize` with no command starts the Studio the way `daemonize studio --open` does, and an unknown argument fails with `Unknown argument "<x>"`. The help text reads:

```
Wrap a web application behind a generated MCP server and OpenAPI spec. Run it without a command to open the Studio.
```

The Studio can start with no workflow file and no output folder: every data route answers 200 with zero actions, and nothing is created until a recording ends.

The Overview shows a welcome screen with **+ New action** while there are no actions, and the button above the cards otherwise. The form asks for a name (1 to 80 characters, at least one letter or number, no control characters) and a web address (`http` or `https`, at most 2048 characters, no user name or password). **Reuse my signed-in session** looks up a saved session by the site address only (its origin), never the full address.

### Routes added by the flow

All are guarded like the playground routes (token or cookie, `x-studio-request`, same Host and Origin). Every route except `GET /api/overview` and `GET /api/compile/status` answers 403 when the Studio is not on a loopback address (`--allow-remote`). Other methods answer 405 with `Allow`, a body above 64 KiB answers 413, a non-JSON body 415, and in `--sample` mode the writing routes answer 409. Error bodies are `{ "error": "..." }` and may add `field`.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/api/overview` | GET | | The existing fields plus `workflowFileExists`, `outputCompiled`, `recordingActive` |
| `/api/record/start` | POST | `{ name, url, reuseSession? }` | 202 `{ state }`, 400 with `field`, 409 when busy, when the workflow file is unreadable, in sample mode, or when `url` has another origin than the actions already in the file (`field: "url"`, see "One application per file") |
| `/api/record/status` | GET | | `{ state, steps, labels, error?, recoveryFile?, sessionNote?, intent?, kiro? }`; step labels only, never typed values. After "Save and add to Kiro", `kiro` is `{ added, message, scope?, missingSecrets?, requiredSecrets? }`: `scope` (`global` or `project`) only when the tool was added, and the two lists hold credential names (never values) |
| `/api/record/stop` | POST | `{}` | 202, or 409 when nothing is recording |
| `/api/sessions` | GET | `?key=<origin>` optional | `{ applicationKey, available }` or a list; no cookie, path or content |
| `/api/sessions/forget` | POST | `{ applicationKey }` | `{ applicationKey, available: false }` |
| `/api/secrets` | GET | | `{ secrets: [{ name, kind, configured }] }` |
| `/api/secrets` | POST | `{ name, value }` | `{ name, configured: true }`; 400 invalid, 503 when secure storage is unavailable |
| `/api/secrets/forget` | POST | `{ name }` | `{ name, configured }` |
| `/api/compile` | POST | `{}` or `{ http?, healSupport? }` | 202, or 409 while one runs. `http` is `"off"` (default) or `"auto"`, `healSupport` a boolean (default `false`); another value or field answers 400 with `field`. The options are kept in memory until the Studio stops and are used by the next compiles, including the one after a recording or an edit. They are never written to the workflow file |
| `/api/compile/status` | GET | | `{ state, phase, error? }` |
| `/api/workflows/update` | POST | `{ id, label?, description?, variables? }` | 200 `{ workflow, recompile }`. `variables` is a list of `{ name, newName?, type?, optional?, whenOmitted?, description? }`: it renames a Variable, changes its type or optional setting, and sets `whenOmitted`. Nothing else in the file changes. 400 (with `field`, and `index` for a Variable) when a value is refused, 404 when the action does not exist, 409 while a recording or a compile runs, when the file is unreadable, and in sample mode, 500 when the file cannot be written (nothing changes). A field other than `id`, `label`, `description` and `variables` answers 400 `UNEXPECTED_FIELD` |
| `/api/workflows/delete` | POST | `{ id }` | 200 `{ ok, remaining, recompile, cleanup? }`; 400 for a field other than `id`, 404 when the action does not exist, 409 while a recording or a compile runs, when the file is unreadable, and in sample mode, 500 when the file cannot be written. `recompile` is `started` or `not-needed` (always `not-needed` when no action remains). `cleanup: "partial"` means some screenshots could not be removed |
| `/api/power/info` | GET | | `{ available, defaultWorkspace, outputPath, serverName? }` |
| `/api/power/snippet` | GET | | `{ snippet }`: placeholders only |
| `/api/power/preview` | POST | `{ workspacePath }` | The plan: exact `.kiro` path, files with `create`, `merge` or `replace`, whether an entry is replaced |
| `/api/power/install` | POST | `{ confirmationId, kiroPath }` | `{ written, placeholders }`; the path must equal the previewed one |

### Recording

One recording at a time. States: `idle`, `recording`, `saving`, `compiling`, `done`, `error`. The status screen polls every 1.5 seconds, shows the state and the last 3 step labels, and stops polling on `done` or `error`. In the recording panel, a checkbox or switch is recorded as one `check` step (a true or false Variable), a group of radio buttons can become one choice Variable that lists the names of the options, and choosing a file in a file field shows a notice that file upload is not supported yet and that the field is not recorded as an input. **Choose the result to capture** outlines the element under the pointer and shows, in a slim bar at the top of the page, a live preview of what the tool will return. **Expand to parent** (ArrowUp) and **Shrink to child** (ArrowDown) move the outline, **Pick** confirms it, and **Clear** forgets the chosen zone so the tool returns the whole page again. In **Review fields**, a radio group is listed as "choose <group name>", taken from its legend, its group label or its `name` attribute. A Variable can be marked optional, with what a call that leaves it out does (`whenOmitted`, see `docs/replay-model.md`). Closing the browser window keeps the recovery file when at least one step exists. Before any step, nothing is written. A finished recording is compiled at once, with the compile options chosen last in this Studio session (both off by default, see "Advanced options").

`recompile` in the two workflow answers is `started` (a compile began because tools were already built), `not-needed` (nothing was built yet) or `busy`. The file is written in one atomic step; if it cannot be written, nothing changes.

### Editing an action
In the Workflows view each action has three buttons: **Rename and describe**, **Edit inputs** and **Delete this action**. They are hidden in sample mode and in the static demo. The forms are prefilled and send only what changed; errors appear beside the control (`role=alert`) and keep what was typed. In **Edit inputs**, an input has a **Type** (Text, Number, True or false), an **Optional** box and, when optional, **If left empty** (Skip this field, Use the recorded value). **Delete this action** opens a dialog that starts on **Cancel**, traps focus and closes with Escape; **Delete** is sent once. When tools were already built, a successful change starts a rebuild and the screen says so. A start page line shows the path only when it differs from the file's start page.

### One application per file
A workflow file holds actions for one application (one origin: scheme, host and port). Starting a recording for another origin than the one already in the file is refused with 409 and a plain message ("This folder already holds actions for <origin>. Another application needs another folder."), and nothing is written. Re-recording the only action of a file on another origin is refused too. A recording of a new file is not affected.

### Advanced options (compile)
The recompile screen has an **Advanced options** group, for web actions only:
- **Run recorded requests directly (faster, no page)** sends `http: "auto"`: steps that have a recorded request run over HTTP when possible (see `docs/replay-model.md`). Requests that change data are sent as recorded and are never retried on the page.
- **Repair steps with a vision model when a page changes** sends `healSupport: true`, which builds the tool so it can heal when started with heal mode. The tool still needs a model set up at run time, or it stops with `heal_unavailable`.
Both are off by default, and the choice stays for the next compiles until the Studio stops.

### Credentials and saved sessions

- **Vault.** Credential values are encrypted with AES-256-GCM in `secrets.vault.json` in the data folder. The key is kept by the operating system (Windows DPAPI, macOS Keychain, Linux `secret-tool`). Without that protection the Studio answers 503 and stores nothing, never plain text. Values are write-only, are removed from every response, and reach only the playground's child server as `DAEMONIZE_SECRET_<NAME>` (a stored value wins over the Studio environment and `mcp.json`).
- **Sessions.** One browser storage file per site, named from a hash of the site address, in the data folder (`<hash>.storage-state.json`). It is never written into the workflow file, the output folder or the repository. **Forget session** deletes it.
- **Data folder.** `DAEMONIZE_DATA_DIR` (absolute) overrides the per-user default. It is refused inside the working directory, a git repository or the output folder.

### Connect to Kiro

**Connect to Kiro** asks for your project folder (prefilled with the Studio's working directory), then shows a confirmation dialog with the exact `.kiro` path and each file with its outcome. Only after **Confirm and connect** are two files written, both inside `.kiro/`: one server entry merged into `settings/mcp.json` (other entries stay as they are; an invalid file is refused and left unchanged) and `skills/<name>/SKILL.md`. The entry holds `${DAEMONIZE_SECRET_<NAME>}` placeholders and `DAEMONIZE_MODE=strict`, never a value. Each placeholder must be set where Kiro runs, and Kiro may ask you to approve it. A folder inside `node_modules`, the output folder or the data folder is refused.

**Choose where Kiro keeps the tool.** On the last screen of the recording panel, when the Kiro folder of your user exists, **Save and add to Kiro** comes with two options: **All my projects** (the default) and **Only this project**. **Only this project**, which is also used when that folder does not exist, adds the tool to the `.kiro` folder of the Studio's working folder. The scope used is reported in `kiro.scope` of the record status.

**Missing credentials.** When the tool needs credentials that are not saved yet, the status screen shows an alert "Credentials are still missing" that lists their names and an **Add your credentials** link, instead of saying only that the tool was added.

### Plain language and keyboard use

The new screens avoid technical terms (the only exceptions are the **Copy MCP configuration** button, secret names and file paths). Every field has a linked label, errors are announced with `role="alert"`, state changes are announced once in the polite live region, dialogs trap focus and close with Escape, and focus outlines are at least 2 px. All text comes from `src/studio/ui/js/copy.js`, which `tests/unit/studio-ui-copy.test.ts` checks.

### Demo and sample mode

The static demo and `--sample` hide **+ New action**, the Credentials links, Connect and Recompile. `#/record` and `#/credentials` show "This is a demo. Install Daemonize to use this."

## Static demo (no server)

```
npm run build
npm run studio:build              # writes dist-demo/   (or: node scripts/build-studio-demo.mjs --out <dir>)
npx serve dist-demo               # any static file server; file:// does not work (the data is fetched)
```

`dist-demo/` is a plain website: the Studio UI, `data/*.json` (overview, workflows, graph, schemas, pbt,
playground tools) built from the sample data with the same view builders as the live Studio, and two pictures drawn
by the build. It is git-ignored and generated; do not edit it.

- The page selects static mode with `<meta name="daemonize-mode" content="static">`. `js/api.js` then reads
  `./data/*.json` instead of `/api/*`. All URLs are relative, routes are hash routes, so the site works under a
  sub-path such as `/repo/`. There is no token, cookie or request to another host (CSP: `default-src 'self'`).
- The playground is a **simulation that runs in the page**, and says so in a banner ("Simulated demo: no real
  application is driven"). It uses the same `src/studio/ui/js/sim/simulate.js` as `daemonize studio --sample`, so the
  drifted result, the failure with a screenshot, healing, the confirmation for write tools and the argument checks
  behave the same in both.
- The output holds no absolute path, user name, environment value or token (checked by
  `tests/integration/studio-static.test.ts`). It also has `404.html`, `.nojekyll`, Open Graph tags and a `README.txt`.

### GitHub Pages

`.github/workflows/studio-demo.yml` builds the demo with Node 22 (`npm ci`, `npm run build`, `npm run studio:build`)
and publishes `dist-demo/` on every push to `main` and on manual dispatch. For this to work, enable Pages once:
**Settings > Pages > Source: GitHub Actions**. The site is then served at `https://<user>.github.io/<repo>/`. This repository's demo: https://cyrilleadjalala.github.io/deamonize/
Nothing is deployed until you do that and the workflow has run.

## Screenshots

`STUDIO_SCREENSHOTS=1 npx vitest run tests/integration/studio-ui.test.ts` writes 1280x720 PNGs to
`tests/__screenshots__/` (git-ignored): `overview`, `workflows`, `workflow-detail`, `graph`, `schemas`, `tests`, `playground`.

## Look

The colours, radii and components follow kiro.dev. See [design-tokens.md](design-tokens.md) for the values, how they were measured and what was left out.
