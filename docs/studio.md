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
| `#/playground` | Placeholder until the MCP playground is enabled |

Workflow view details:
- A note under the header lists the steps that write (`write` or `delete`): "The only write is the login form: step N, ..." for a login-only workflow, or "Writes data in N steps:" with "Step N: label (write)" for the others. Read-only workflows show no note. Step numbers start at 1.
- The playground confirmation dialog for a write or delete tool lists the same steps (numbers and labels only, no argument or secret value). Without that data it keeps the generic sentence.
- Variable names (`{{name}}` chips of the Variables table) stay on one line; the table scrolls sideways when the column is narrow.
- Secrets show names with a `configured` or `missing` chip; names recorded in HTTP recipes but not read by the compiled server sit in a collapsed list.

Keyboard: Tab / Shift+Tab, Enter on a workflow or screen, arrows in the workflow list, arrows/`+`/`-`/`0` on the graph canvas.
The footer's **Print view** button prints a light, control-free version.

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
