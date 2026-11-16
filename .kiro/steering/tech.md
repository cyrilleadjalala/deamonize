---
inclusion: always
---

# Technology

- TypeScript (strict), Node.js 20 or newer, ES modules (`"type": "module"`, `NodeNext` resolution). Import local files with the `.js` extension.
- Tests: Vitest. Property-based tests: `fast-check` 3. Run with `npx vitest run` (never watch mode in automation).
- Schemas: AJV 8 (`Ajv2020` for the State_Graph, `ajv-formats`). Validators are compiled once at startup, never per request.
- MCP: `@modelcontextprotocol/sdk` and `zod`. The generated server must not import anything from `src/`.
- Web recording and replay: Playwright. Terminal: `node-pty` plus the `@xterm/headless` renderer.
- Replay isolation: the `docker` command (`docker run --rm`), not the Docker SDK. `SandboxManager` (dockerode) is a library tested against a fake Docker.
- `json-schema-fast-check` is **not** used: it bundles fast-check 1.x. Arbitraries come from `src/pbt/schema-arbitrary.ts`.

## Commands

- `npx tsc --noEmit` type-check, `npm run build` build.
- `npx vitest run` all tests. Docker tests are skipped unless `DAEMONIZE_DOCKER_TESTS=1`.
- `node dist/cli/index.js <record|compile|merge|serve|studio|sandbox build>`.
- `npm run check:secrets` scans for credential shapes; `npm run studio:build` writes the static Studio demo to `dist-demo/`.

## Constraints

- On Windows `node-pty` prints a harmless "AttachConsole failed" trace when it kills a process. Do not treat it as a failure.
- Never add `.kiro/` to `.gitignore`. The hackathon requires it in the repository.