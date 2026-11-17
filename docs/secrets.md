# Secrets and security

## What is never stored

A password, TOTP seed, cookie or token never appears in a workflow file, a compiled artifact (server source, OpenAPI,
Power files, generated tests, sandbox files), a recorded HTTP recipe, a Studio response or a playground response.
A workflow holds the **name** of a secret only.

- Password fields are recorded as a secret reference, not a value. A workflow file that contains a plain secret is rejected.
- Recorded HTTP requests are redacted: sensitive headers, fields and token-like values are replaced and listed as `redacted`.
- Visual-anchor thumbnails are kept outside the compiled output, and are only compiled in with `--heal-support`.
- Typed text that you did **not** mark as a Variable or a secret is stored as typed. The CLI warns about it. Check it.

## How a secret reaches a replay

| Kind | How |
| --- | --- |
| Password or other secret | Environment variable `DAEMONIZE_SECRET_<NAME>` of the server process. In Kiro, the `env` of `mcp.json` holds `${DAEMONIZE_SECRET_<NAME>}`, never a value |
| TOTP | The base32 seed is read from `DAEMONIZE_SECRET_<NAME>` and a code is computed at replay time (RFC 6238). An invalid seed fails with `missing_secret`, naming the variable only |
| Saved login | A Playwright `storageState` file referenced **by path** (`record --storage-state`, or `DAEMONIZE_STORAGE_STATE`). In Docker it is mounted read-only. A `.dockerignore` keeps auth files out of the image |
| HTTP auth | Cookie header from `DAEMONIZE_COOKIE_HEADER` or the storage state |

### Which secrets a server needs
A recorded HTTP request can carry `{"$secret":"NAME"}` references (for example a 2FA login recorded as `CHALLENGE_TOKEN` and `TOTP`).
Only a server compiled with `--http` ever sends a recorded request, and only for the steps it runs over HTTP (the plan of the
workflow). A step that stays on the page does not read its recipe, so its names are **not** required:

- The tool description, the `env` of `mcp.json`, `SKILL.md` and the Kiro power list the typed secrets (`secretRef`, the `secrets` list, TOTP)
  plus the recipe names of the HTTP-planned steps of a `--http` server, and nothing else.
- At run time, `missing_secret` is only raised for those same names. Without `--http`, no recipe name is read, checked or forwarded.
- Studio shows the **required** secrets of the compiled mode, and lists the names that are recorded in HTTP recipes but not read by
  the server apart ("Recorded in HTTP recipes, not read by this server"). If the output directory is not compiled, it says so.
- For each required secret Studio shows `configured` or `missing`: whether `DAEMONIZE_SECRET_<NAME>` is non-empty in the environment the
  playground passes to the server (the allow-listed variables of the Studio environment and the literal entries of `mcp.json`; a
  `${VAR}` placeholder counts for nothing). Only the name and that one word are returned, never the value.

A missing secret fails the call before the sandbox starts (`error: "missing_secret"`). With `serve --sandbox docker` the check runs
on the host, before `docker run`, and the container receives variable names, not values on its command line.

## Checks in this repository

- `npm run check:secrets` scans the files git tracks or would commit for credential shapes (JWTs, `Bearer`/`Basic` values, cloud and
  API key prefixes, private keys, `password=` assignments, cookie headers, `.env`-style lines). It prints file, line and rule, never
  the value, and exits 1 on a finding. The only allowed value is the public demo password of `examples/adminer`.
- Hook `.kiro/hooks/secret-scan-on-save.json` runs `node scripts/check-secrets.mjs --changed` when an example, doc or workflow is saved.
- `tests/integration/examples-no-leak.test.ts` compiles the committed examples with random secret values in the environment and searches
  the output, the Studio API and the static demo for them. Property tests cover compiled artifacts, redaction, the Studio and the playground.

## Replay isolation (`--sandbox docker`)

Each call runs in a throw-away container (`docker run --rm`): memory limit (`--memory`, default 512 MB), CPU limit (`--cpus`, default 1),
all capabilities dropped, no new privileges, no implicit image download, and only the folders given with `--mount host:container[:ro]`.
A terminal program gets no network and a read-only file system by default; a web target gets a bridge network. Change this at compile
or build time with `--sandbox-network` / `sandbox build --network`. Dockerfile inputs (image, packages, install commands) are checked for
injection. Recording itself always happens on the host.

## Strict, heal and the model

Strict mode is the default and is the only mode in which a write or delete step is never touched by a model. In heal mode the model
receives a screenshot, the recorded thumbnail and the step's intent, and returns a location. It does not decide the workflow, the
workflow file is never changed, and a heal result carries `healed: true`. Compile-time suggestions (`compile --suggest`) are off by default
and only rename and describe; they never change replayed steps.

## Studio

`daemonize studio` listens on `127.0.0.1` by default, and each run has a random token. Every `/api` call needs the token (header or the cookie set by
the first visit). A POST also needs the `x-studio-request` header and a matching Origin. The Host header must be one of the server's own
(DNS rebinding), a foreign Origin is refused, no CORS header is sent, and the CSP is `default-src 'self'` with no CDN, font or script from outside.
`--host` with another address needs `--allow-remote`, and then the token is the only protection. Responses and the playground are redacted.
