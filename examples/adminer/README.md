# Example: Adminer on PostgreSQL

Proof of Daemonize on **real, existing software** that we did not write: [Adminer](https://www.adminer.org/)
(official Docker image `adminer`, version 6.1.1 when this was written) in front of PostgreSQL
(official image `postgres:16`). Adminer is a PHP application with server-rendered forms, a login page,
dynamic tables with row-level links and native select boxes.

## Start and stop

```sh
cd examples/adminer
docker compose up -d --wait      # Adminer on http://127.0.0.1:8080
docker compose down -v           # stops and removes containers and data
```

Or, with a free random port (used by the tests): `node scripts/up.mjs` prints the URL, `node scripts/down.mjs` stops
the default project. `node scripts/wait-ready.mjs [port]` waits until Adminer answers.

| Service   | Image         | Port                                   |
| --------- | ------------- | -------------------------------------- |
| `adminer` | `adminer`     | `127.0.0.1:${ADMINER_PORT:-8080}` -> 8080 |
| `db`      | `postgres:16` | not published (reachable as `db`)      |

Login: system `PostgreSQL`, server `db` (pre-filled), user `demo`, database `demo`,
password `demo-password-change-me` unless `DEMO_DB_PASSWORD` is set.
The `customers` table (25 fictitious rows: id, name, email, country, status) is created by `init.sql`.

## Security notes

- Adminer is bound to the loopback interface only. Do not publish it on a network.
- The default password is a public demo value for a throwaway database kept in memory (tmpfs). Never reuse it
  anywhere else. Set `DEMO_DB_PASSWORD` to use another one.
- Daemonize must never store the password: record the password field as a secret and provide it at run time
  through `DAEMONIZE_SECRET_*`.

## What it proves

- Login with a secret taken from the environment (the password is not in the workflow file).
- Navigation between pages (tables list, table data, edit form).
- A native select box (`System`) and form filling (server, user, database, edit form).
- A row-level action chosen by a Variable (the `edit` link of the row whose `id` or `name` is given).

`tests/integration/adminer-stack.test.ts` only checks that this target works
(`DAEMONIZE_DOCKER_TESTS=1 npx vitest run tests/integration/adminer-stack.test.ts`).
Recording, compiling and calling the workflows is described below and tested by `tests/integration/adminer-e2e.test.ts`.

## Use it with Daemonize

Workflows in `daemonize.workflows.json` (committed, no secret in it; the database password is only the secret name `PASSWORD`):

| Tool                     | Variables                                                        | Risk  | Returns                                   |
| ------------------------ | ---------------------------------------------------------------- | ----- | ----------------------------------------- |
| `list_customers`         | none                                                             | read  | `data`: every row of `customers`, keyed by column header |
| `find_customers`         | `search_text`, `operator` (`=` or `LIKE`)                        | read  | `data`: the matching rows                 |
| `open_customer_for_edit` | `customer_name`                                                  | read  | `data`: the fields of the edit form (nothing is saved) |
| `rename_customer`        | `customer_name`, `status` (`active`, `inactive`, `pending`)      | write | `text`: Adminer's confirmation message    |

```sh
# 1. The stack (Adminer on http://127.0.0.1:8080) and the build of Daemonize (the script uses dist/)
cd examples/adminer && docker compose up -d --wait && cd ../..
npm run build

# 2. Record the four workflows (the script drives the recorder with Playwright, like a person using the pages).
#    Set DEMO_DB_PASSWORD if the stack was started with another one. Replaces daemonize.workflows.json.
node examples/adminer/record-workflows.mjs

# 3. Compile to the (git-ignored) examples/adminer/out/
node dist/cli/index.js compile examples/adminer/daemonize.workflows.json --out examples/adminer/out --http auto

# 4. Run the MCP server by hand, or import examples/adminer/out as a Power in Kiro (it holds POWER.md, mcp.json and SKILL.md).
#    The password reaches the server through the environment only:
DAEMONIZE_SECRET_PASSWORD=demo-password-change-me node dist/cli/index.js serve examples/adminer/out
```

In Kiro, set `DAEMONIZE_SECRET_PASSWORD` in the environment of the MCP server (`mcp.json` contains the placeholder
`${DAEMONIZE_SECRET_PASSWORD}`, never a value). The recording of `rename_customer` really changes the status of
"Chiara Rossi" in the database; restart the stack (`docker compose down -v`, then up) to get the initial data back.
`examples/adminer/out/` is generated and never committed.

### What was observed on this real application

- **Level 1 is not available.** Adminer is server-rendered HTML: every action is a form post or a page load, with no JSON
  fetch/XHR. `compile --http auto` therefore produces no HTTP recipe, and the Studio shows Level 2 (role and name, then CSS
  fallbacks) for every step. This is the expected result for this kind of application, not a failure.
- **The password is typed during the recording** and stored nowhere: the step is a `secretRef` `PASSWORD`. The system, the user and
  the database are constants of the workflow (`pgsql`, `demo`, `demo`); the server field is pre-filled by the stack.
- **The row of a customer is found by its name** (a Variable, bound from a text selected in the row), never by position: the `edit`
  link has the same text in every row. A name that is in two rows (or a value such as `France` found in several cells) fails with
  `AMBIGUOUS_ROW` instead of editing a guessed row.
- **`status` is a text column**, shown as a textarea by Adminer, not a select box. The accepted values are given by the `enum` of the
  Variable in the workflow file (`active`, `inactive`, `pending`); a call with another value is refused before the replay starts.
  The same holds for the native select of the filter operator.
- **Risk**: the recorder marks every form submit as `write`, including Adminer's login and its (GET) filter form. The record script
  sets those two clicks to `read` in the file afterwards, so only the `Save` click of `rename_customer` is a `write` step.
- The first column of the data table (checkbox and `edit` link) has no header, so the `list_customers` rows carry a `column_1` key.
- `finalZone` (the part of the final page hashed to detect drift) is the table header for `list_customers` and the page heading
  for the other tools. A zone with the table body would report drift as soon as any row changes.
- Adminer puts a hidden `token` field (different on every page load) in its forms: it is ignored by the recorder and by the drift hash.
- Replay in Docker (`DAEMONIZE_SANDBOX=docker`, image built with `daemonize sandbox build`) reaches Adminer through
  `DAEMONIZE_SANDBOX_URL=http://host.docker.internal:<port>/` on Docker Desktop (the container's traffic is relayed to the
  loopback of the host, where Adminer listens). This was only verified on Docker Desktop (Windows); elsewhere Adminer, bound to
  `127.0.0.1` by the compose file, may not be reachable from a container. The integration test then skips this single case with
  a message instead of failing.

## Adminer DOM notes (6.1.1)

- Login form (`POST`, no JS needed): `select[name="auth[driver]"]` (`server` = MySQL, `pgsql`, `sqlite`, ...),
  `input[name="auth[server]"]`, `input[name="auth[username]"]`, `input[type=password][name="auth[password]"]`,
  `input[name="auth[db]"]`, `input[type=submit][value=Login]`. A hidden `token` field changes on every page load.
  After login the URL becomes `?pgsql=db&username=demo&db=demo&ns=public`; the session is a PHP cookie.
- The driver select has `data-onchange="loginDriver()"`: a script runs on change and may rewrite the server field placeholder.
- Table list and data: plain `<table class="nowrap checkable odds">`, `<thead>` with sortable header links
  (`order[0]=col`), one `<tr>` per row. All rows are on one page up to a limit of 50, then pagination links appear.
- Row actions: the first cell holds `<a class="edit" href="...&edit=customers&where[id]=N">edit</a>` and a checkbox
  `name="check[]" value="where[id]=N"`. The link text is the same ("edit") for every row, so a recorder must
  identify the row by cell contents (a Variable), not by link text.
- Select boxes are native `<select>` (`op`, `order[0]`, `columns[0][col]`, ...), without custom widgets.
- JavaScript is progressive enhancement (`data-onclick` and similar attributes, nonce-protected scripts, a service worker
  registration). `<noscript>` only holds an update-check iframe. The pages are usable without JS, so recorded
  navigations may also be replayed as plain page loads. Adminer sends a `Content-Security-Policy` header, so inline
  event attributes are not used.
- Data URLs requested without the session cookie answer HTTP 403 (observed with a plain HTTP client); always log in first.
