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
| `/api/record/start` | POST | `{ name, url, reuseSession? }` | 202 `{ state }`, 400 with `field`, 409 when busy |
| `/api/record/status` | GET | | `{ state, steps, labels, error?, recoveryFile?, sessionNote? }`; step labels only, never typed values |
| `/api/record/stop` | POST | `{}` | 202, or 409 when nothing is recording |
| `/api/sessions` | GET | `?key=<origin>` optional | `{ applicationKey, available }` or a list; no cookie, path or content |
| `/api/sessions/forget` | POST | `{ applicationKey }` | `{ applicationKey, available: false }` |
| `/api/secrets` | GET | | `{ secrets: [{ name, kind, configured }] }` |
| `/api/secrets` | POST | `{ name, value }` | `{ name, configured: true }`; 400 invalid, 503 when secure storage is unavailable |
| `/api/secrets/forget` | POST | `{ name }` | `{ name, configured }` |
| `/api/compile` | POST | `{}` | 202, or 409 while one runs |
| `/api/compile/status` | GET | | `{ state, phase, error? }` |
| `/api/power/info` | GET | | `{ available, defaultWorkspace, outputPath, serverName? }` |
| `/api/power/snippet` | GET | | `{ snippet }`: placeholders only |
| `/api/power/preview` | POST | `{ workspacePath }` | The plan: exact `.kiro` path, files with `create`, `merge` or `replace`, whether an entry is replaced |
| `/api/power/install` | POST | `{ confirmationId, kiroPath }` | `{ written, placeholders }`; the path must equal the previewed one |

### Recording

One recording at a time. States: `idle`, `recording`, `saving`, `compiling`, `done`, `error`. The status screen polls every 1.5 seconds, shows the state and the last 3 step labels, and stops polling on `done` or `error`. Closing the browser window keeps the recovery file when at least one step exists. Before any step, nothing is written. A finished recording is compiled at once, with the options `daemonize compile` uses with no flag.

### Credentials and saved sessions

- **Vault.** Credential values are encrypted with AES-256-GCM in `secrets.vault.json` in the data folder. The key is kept by the operating system (Windows DPAPI, macOS Keychain, Linux `secret-tool`). Without that protection the Studio answers 503 and stores nothing, never plain text. Values are write-only, are removed from every response, and reach only the playground's child server as `DAEMONIZE_SECRET_<NAME>` (a stored value wins over the Studio environment and `mcp.json`).
- **Sessions.** One browser storage file per site, named from a hash of the site address, in the data folder (`<hash>.storage-state.json`). It is never written into the workflow file, the output folder or the repository. **Forget session** deletes it.
- **Data folder.** `DAEMONIZE_DATA_DIR` (absolute) overrides the per-user default. It is refused inside the working directory, a git repository or the output folder.

### Connect to Kiro

**Connect to Kiro** asks for your project folder (prefilled with the Studio's working directory), then shows a confirmation dialog with the exact `.kiro` path and each file with its outcome. Only after **Confirm and connect** are two files written, both inside `.kiro/`: one server entry merged into `settings/mcp.json` (other entries stay as they are; an invalid file is refused and left unchanged) and `skills/<name>/SKILL.md`. The entry holds `${DAEMONIZE_SECRET_<NAME>}` placeholders and `DAEMONIZE_MODE=strict`, never a value. Each placeholder must be set where Kiro runs, and Kiro may ask you to approve it. A folder inside `node_modules`, the output folder or the data folder is refused.

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
