import { KEY_SEQUENCES } from '../sandbox/keys.js';
import { describeTool } from './tool-description.js';
import { propertyToZodSource } from './zod-translator.js';
import type { Workflow, WorkflowSet } from '../types.js';

// The sandbox image of a web target starts from the Playwright image of this exact version,
// whose browsers match the playwright package installed on top of it.
export const PLAYWRIGHT_VERSION = '1.65.1';

/**
 * Standalone runtime embedded in every generated server. Each call starts from
 * the same known state (a fresh browser context, or a freshly started program),
 * replays the recorded steps with the payload values, and returns what the
 * resulting screen shows. Kept free of template literals so it can be embedded
 * verbatim.
 */

// Shared by both kinds of target, in replay.ts: the step type and the lookup of a step's value.
const REPLAY_COMMON = [
  `export type Step = {`,
  `  actionType: string;`,
  `  selectors: string[];`,
  `  value?: string;`,
  `  variable?: string;`,
  `  label?: string;`,
  `  timeoutMs?: number;`,
  `  // Level 2 (web): see step-plan.ts`,
  `  anchor?: any;`,
  `  rowBinding?: any;`,
  `  risk?: "read" | "write" | "delete";`,
  `  secretRef?: string;`,
  `  totp?: boolean;`,
  `};`,
  ``,
  `// Where a replay starts when it runs in a sandbox that cannot reach the recorded one.`,
  `export type Overrides = { command?: string[]; url?: string };`,
  ``,
  `// Timeouts of a call, in the order they apply: the call (_timeoutMs), DAEMONIZE_TIMEOUT_MS, the workflow, the set, 30 s.`,
  `export type Limits = { callMs?: number; workflowMs?: number; setMs?: number };`,
  ``,
  `// What the call is compared with to tell whether the application still looks as recorded.`,
  `// finalZone limits the comparison: a CSS selector (web) or a rectangle of the screen (terminal).`,
  `export type Zone = { selector?: string; rect?: { row: number; col: number; rows: number; cols: number } };`,
  `export type Final = { finalScreenId?: string; finalZone?: Zone };`,
  ``,
  `const MAX_TEXT_LENGTH = 20000;`,
  ``,
  `// Without a recorded final screen nothing can be compared: drifted is false and driftChecked says so.`,
  `function driftFields(hash: string | undefined, final: Final): { drifted: boolean; driftChecked: boolean } {`,
  `  if (final.finalScreenId === undefined) return { drifted: false, driftChecked: false };`,
  `  return { drifted: hash !== final.finalScreenId, driftChecked: true };`,
  `}`,
  ``,
  `function resolveValue(step: Step, args: Record<string, unknown>): string | undefined {`,
  `  if (step.variable !== undefined) {`,
  `    const supplied = args[step.variable];`,
  `    return supplied === undefined || supplied === null ? step.value : String(supplied);`,
  `  }`,
  `  return step.value;`,
  `}`,
  ``,
];

// Payload validation, in mcp-server.ts: every call is checked against the inferred schema before any replay.
const VALIDATION_RUNTIME = [
  `// ajv-formats ships as CJS; cast to the callable form for TypeScript.`,
  `const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;`,
  `const ajv = new Ajv2020({ allErrors: true, strict: false });`,
  `addFormats(ajv);`,
  `// Schemas are compiled once at startup, not per call.`,
  `const validators = new Map<string, ValidateFunction>(`,
  `  Object.entries(INPUT_SCHEMAS).map(([tool, schema]) => [tool, ajv.compile(schema)])`,
  `);`,
  ``,
  `// Returns null when the payload is valid, the list of violations otherwise.`,
  `function validatePayload(tool: string, payload: unknown) {`,
  `  const validate = validators.get(tool);`,
  `  if (validate === undefined || validate(payload)) return null;`,
  `  return (validate.errors ?? []).map((err) => ({`,
  `    instancePath: err.instancePath ?? "",`,
  `    schemaPath: err.schemaPath ?? "",`,
  `    message: err.message ?? "Validation error"`,
  `  }));`,
  `}`,
  ``,
];

// Web targets: a fresh Playwright browser context per call; returns the page title and visible text.
// Strict level 2 (see step-plan.ts and web-steps.ts): accessible role and name in the recorded context, frame and page,
// the row bound to a Variable, then the recorded selectors. A step that no locator can perform stops the replay.
const WEB_RUNTIME = [
  `// Timeout of a step (its action and the wait on its effect): the step's own, DAEMONIZE_STEP_TIMEOUT_MS, 8 s.`,
  `const STEP_TIMEOUT_MS = resolveStepTimeoutMs({ env: process.env.DAEMONIZE_STEP_TIMEOUT_MS });`,
  ``,
  `export async function replay(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}, overrides: Overrides = {}) {`,
  `  const startedAt = Date.now();`,
  `  const TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const deadline = startedAt + TIMEOUT_MS;`,
  `  // A secret that is not set fails the call before any step runs; only the name of its variable is reported`,
  `  const missing = missingSecrets(steps, process.env);`,
  `  if (missing.length > 0) {`,
  `    return { success: false, error: "missing_secret", failure: { missingSecret: missing[0], missing }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  const browser = await chromium.launch({`,
  `    headless: true,`,
  `    executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,`,
  `    // Inside a container the container is the sandbox; Chromium's own cannot start there`,
  `    args: process.env.DAEMONIZE_IN_CONTAINER ? ["--no-sandbox"] : []`,
  `  });`,
  `  let timer: NodeJS.Timeout | undefined;`,
  `  try {`,
  `    const context = await browser.newContext(STORAGE_STATE ? { storageState: STORAGE_STATE } : {});`,
  `    const page = await context.newPage();`,
  `    const webRun = createWebRun(context, page);`,
  `    const run = async () => {`,
  `      await page.goto(overrides.url ?? START_URL, { timeout: TIMEOUT_MS });`,
  `      await waitForEffect(page as unknown as SettlePage, { timeoutMs: boundStepTimeoutMs(STEP_TIMEOUT_MS, deadline - Date.now()) });`,
  `      // Strict mode: the first step that no locator can perform stops the replay, no later step runs`,
  `      const outcome = await runStepsStrict(steps, async (step) => {`,
  `        // A step never waits longer than what is left of the whole replay`,
  `        const timeoutMs = boundStepTimeoutMs(resolveStepTimeoutMs({ step: step.timeoutMs, env: process.env.DAEMONIZE_STEP_TIMEOUT_MS }), deadline - Date.now());`,
  `        await executeWebStep(webRun, step, args, { timeoutMs });`,
  `      });`,
  `      if (!outcome.ok) {`,
  `        const shot = await captureFailure(webRun, outcome.stepIndex);`,
  `        const failure = describeFailure({`,
  `          stepIndex: outcome.stepIndex,`,
  `          step: outcome.step,`,
  `          tried: outcome.tried,`,
  `          reason: outcome.reason,`,
  `          screenshot: shot.screenshot,`,
  `          thumbnail: shot.thumbnail,`,
  `          secrets: webRun.secrets`,
  `        });`,
  `        const failed = failureResult(failure, Date.now() - startedAt);`,
  `        // In a container the host keeps the picture: it travels in the result and the host saves it`,
  `        return shot.data === undefined ? failed : { ...failed, failure: { ...failed.failure, screenshotData: shot.data } };`,
  `      }`,
  `      // The steps may have moved to another page (a pop-up)`,
  `      const last = webRun.pages[webRun.current];`,
  `      const finalPage = last !== undefined && !last.isClosed() ? last : page;`,
  `      const text = await finalPage.evaluate(() => document.body.innerText);`,
  `      // The same screen as at recording time: the whole page, or only the zone when there is one`,
  `      let hash: string | undefined;`,
  `      if (final.finalScreenId !== undefined) {`,
  `        const zone = final.finalZone?.selector;`,
  `        // A zone that matches nothing leaves hash undefined, which counts as drift`,
  `        const raw = zone === undefined`,
  `          ? await finalPage.content()`,
  `          : (await finalPage.locator(zone).count()) === 0`,
  `            ? undefined`,
  `            : await finalPage.locator(zone).first().evaluate((el: Element) => el.outerHTML, { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);`,
  `        hash = raw === undefined ? undefined : screenId("dom", raw);`,
  `      }`,
  `      return {`,
  `        success: true,`,
  `        screenType: "dom",`,
  `        title: await finalPage.title(),`,
  `        text: text.slice(0, MAX_TEXT_LENGTH),`,
  `        ...driftFields(hash, final),`,
  `        elapsedMs: Date.now() - startedAt`,
  `      };`,
  `    };`,
  `    const timeout = new Promise<never>((_, reject) => {`,
  `      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);`,
  `    });`,
  `    return await Promise.race([run(), timeout]);`,
  `  } catch (err) {`,
  `    return { success: false, error: (err as Error).message, elapsedMs: Date.now() - startedAt };`,
  `  } finally {`,
  `    clearTimeout(timer);`,
  `    await browser.close().catch(() => {});`,
  `  }`,
  `}`,
];

// Terminal targets: a freshly started program in a pty per call; returns the text on its screen.
const TERMINAL_RUNTIME = [
  `const COLS = 80;`,
  `const ROWS = 24;`,
  `const STABLE_MS = 150;`,
  `const MAX_SETTLE_MS = 3000;`,
  `const SILENT_GRACE_MS = 500;`,
  ``,
  `// @xterm/headless is CommonJS: take the class from the default export.`,
  `const { Terminal } = xtermHeadless;`,
  ``,
  `export async function replay(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}, overrides: Overrides = {}) {`,
  `  const startedAt = Date.now();`,
  `  const TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const screen = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });`,
  `  let lastActivityAt = Date.now();`,
  `  let touchedAt = Date.now();`,
  `  let writesSinceTouch = 0;`,
  `  let exited = false;`,
  `  let timer: NodeJS.Timeout | undefined;`,
  ``,
  `  const [command, ...commandArgs] = overrides.command ?? START_COMMAND;`,
  `  const program = pty.spawn(command, commandArgs, { cols: COLS, rows: ROWS, name: "xterm-256color" });`,
  `  program.onData((data: string) => {`,
  `    screen.write(data);`,
  `    lastActivityAt = Date.now();`,
  `    writesSinceTouch += 1;`,
  `  });`,
  `  program.onExit(() => {`,
  `    exited = true;`,
  `  });`,
  ``,
  `  // Wait until the program has reacted and gone quiet: a moment of silence after its`,
  `  // output, or a longer grace period if it prints nothing, then until the screen is rendered.`,
  `  const settle = async (graceMs = SILENT_GRACE_MS, maxMs = MAX_SETTLE_MS) => {`,
  `    const waitStart = Date.now();`,
  `    for (;;) {`,
  `      const now = Date.now();`,
  `      const done = writesSinceTouch > 0 ? now - lastActivityAt >= STABLE_MS : now - touchedAt >= graceMs;`,
  `      if (done || now - waitStart >= maxMs) break;`,
  `      await new Promise<void>((resolve) => setTimeout(resolve, 10));`,
  `    }`,
  `    await new Promise<void>((resolve) => screen.write("", resolve));`,
  `  };`,
  ``,
  `  const screenText = () => {`,
  `    const buffer = screen.buffer.active;`,
  `    const lines: string[] = [];`,
  `    for (let row = 0; row < ROWS; row++) {`,
  `      lines.push((buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").trimEnd());`,
  `    }`,
  `    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();`,
  `    return lines.join("\\n");`,
  `  };`,
  ``,
  `  try {`,
  `    const run = async () => {`,
  `      // A program may take a while to start and print its first screen; a terminal`,
  `      // emits set-up sequences first, so wait for text rather than for bytes.`,
  `      const firstTextDeadline = Date.now() + 5000;`,
  `      for (;;) {`,
  `        await new Promise<void>((resolve) => screen.write("", resolve));`,
  `        if (screenText() !== "" || exited || Date.now() >= firstTextDeadline) break;`,
  `        await new Promise<void>((resolve) => setTimeout(resolve, 25));`,
  `      }`,
  `      await settle();`,
  `      for (const step of steps) {`,
  `        const value = resolveValue(step, args);`,
  `        switch (step.actionType) {`,
  `          case "type":`,
  `            program.write(value ?? "");`,
  `            break;`,
  `          case "keypress":`,
  `            program.write(KEY_SEQUENCES[value ?? ""] ?? value ?? "");`,
  `            break;`,
  `          case "form_submit":`,
  `            program.write(KEY_SEQUENCES["Enter"]);`,
  `            break;`,
  `          case "select":`,
  `            program.write((value ?? "") + KEY_SEQUENCES["Enter"]);`,
  `            break;`,
  `          default:`,
  `            throw new Error("Unsupported action for a terminal program: " + step.actionType);`,
  `        }`,
  `        touchedAt = Date.now();`,
  `        writesSinceTouch = 0;`,
  `        await settle();`,
  `      }`,
  `      const finalText = screenText();`,
  `      let hash: string | undefined;`,
  `      if (final.finalScreenId !== undefined) {`,
  `        const rect = final.finalZone?.rect;`,
  `        hash = screenId("terminal", rect === undefined ? finalText : cropTerminal(finalText, rect));`,
  `      }`,
  `      return {`,
  `        success: true,`,
  `        screenType: "terminal",`,
  `        text: finalText.slice(0, MAX_TEXT_LENGTH),`,
  `        ...driftFields(hash, final),`,
  `        elapsedMs: Date.now() - startedAt`,
  `      };`,
  `    };`,
  `    const timeout = new Promise<never>((_, reject) => {`,
  `      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);`,
  `    });`,
  `    return await Promise.race([run(), timeout]);`,
  `  } catch (err) {`,
  `    return { success: false, error: (err as Error).message, elapsedMs: Date.now() - startedAt };`,
  `  } finally {`,
  `    clearTimeout(timer);`,
  `    if (!exited) {`,
  `      try {`,
  `        program.kill();`,
  `      } catch {`,
  `        // Already gone`,
  `      }`,
  `    }`,
  `    screen.dispose();`,
  `  }`,
  `}`,
];

// Container entry point of replay.js: `node replay.js --container` reads one request on stdin and
// prints the result as one line on stdout. Nothing else is written to stdout.
const CONTAINER_ENTRY = [
  ``,
  `if (process.argv.includes("--container")) {`,
  `  let input = "";`,
  `  for await (const chunk of process.stdin) input += chunk;`,
  `  const request = JSON.parse(input) as {`,
  `    steps: Step[];`,
  `    args: Record<string, unknown>;`,
  `    final?: Final;`,
  `    limits?: Limits;`,
  `    command?: string[];`,
  `    url?: string;`,
  `  };`,
  `  const result = await replay(request.steps, request.args, request.final ?? {}, request.limits ?? {}, { command: request.command, url: request.url });`,
  `  process.stdout.write(JSON.stringify(result) + "\\n");`,
  `  process.exit(0);`,
  `}`,
];

// docker-replay.ts: replays one call inside a throw-away container, so the target application
// never runs on the host. Needs only the docker command; settings come from the environment.
const DOCKER_RUNTIME = [
  `const DOCKER = process.env.DAEMONIZE_DOCKER ?? "docker";`,
  `const NETWORK = process.env.DAEMONIZE_SANDBOX_NETWORK ?? DEFAULT_NETWORK;`,
  `const IMAGE = process.env.DAEMONIZE_SANDBOX_IMAGE ?? DEFAULT_IMAGE;`,
  `const MEMORY_MB = Number(process.env.DAEMONIZE_SANDBOX_MEMORY_MB ?? 512);`,
  `const CPUS = Number(process.env.DAEMONIZE_SANDBOX_CPUS ?? 1);`,
  `// JSON arrays set by the user: the only folders of the host the container can see, e.g. ["/data:/data:ro"]`,
  `const MOUNTS: string[] = JSON.parse(process.env.DAEMONIZE_SANDBOX_MOUNTS ?? "[]");`,
  `// What to start inside the container, when it differs from what was recorded on the host.`,
  `const COMMAND: string[] | undefined = process.env.DAEMONIZE_SANDBOX_COMMAND`,
  `  ? JSON.parse(process.env.DAEMONIZE_SANDBOX_COMMAND)`,
  `  : undefined;`,
  `const URL_OVERRIDE = process.env.DAEMONIZE_SANDBOX_URL;`,
  `const STARTUP_ALLOWANCE_MS = 20000;`,
  ``,
  `// A failed step comes back with its screenshot as data: keep it on the host, where the caller can open it.`,
  `function keepScreenshot(result: Record<string, unknown>): Record<string, unknown> {`,
  `  const failure = result.failure as Record<string, unknown> | undefined;`,
  `  if (failure === undefined || failure === null || typeof failure.screenshotData !== "string") return result;`,
  `  try {`,
  `    const dir = join(tmpdir(), "daemonize-failures");`,
  `    mkdirSync(dir, { recursive: true });`,
  `    const path = join(dir, "fail-" + Date.now() + "-" + String(failure.stepIndex) + ".png");`,
  `    writeFileSync(path, Buffer.from(failure.screenshotData, "base64"));`,
  `    failure.screenshot = path;`,
  `  } catch {`,
  `    delete failure.screenshot;`,
  `  }`,
  `  delete failure.screenshotData;`,
  `  return result;`,
  `}`,
  ``,
  `export async function replayInDocker(steps: Step[], args: Record<string, unknown>, final: Final = {}, limits: Limits = {}) {`,
  `  const startedAt = Date.now();`,
  `  // Resolved here, so the container applies the same value; the step timeout travels as an environment variable`,
  `  const REPLAY_TIMEOUT_MS = resolveTimeoutMs({ call: limits.callMs, env: process.env.DAEMONIZE_TIMEOUT_MS, workflow: limits.workflowMs, set: limits.setMs });`,
  `  const timeoutEnv = ["-e", "DAEMONIZE_TIMEOUT_MS=" + REPLAY_TIMEOUT_MS];`,
  `  if (process.env.DAEMONIZE_STEP_TIMEOUT_MS) timeoutEnv.push("-e", "DAEMONIZE_STEP_TIMEOUT_MS=" + process.env.DAEMONIZE_STEP_TIMEOUT_MS);`,
  `  const fail = (error: string) => ({ success: false, error, elapsedMs: Date.now() - startedAt });`,
  ``,
  `  // A secret that is not set fails the call before the container starts; the container receives the values from this environment, never on the command line`,
  `  const missing = missingSecrets(steps, process.env);`,
  `  if (missing.length > 0) {`,
  `    return { success: false, error: "missing_secret", failure: { missingSecret: missing[0], missing }, elapsedMs: Date.now() - startedAt };`,
  `  }`,
  `  const secretEnv = [...new Set(steps.filter((s) => s.secretRef !== undefined).map((s) => secretEnvName(s.secretRef as string)))].flatMap((variable) => ["-e", variable]);`,
  ``,
  `  if (HOST_COMMAND && !COMMAND && HOST_COMMAND.some((part) => /^[A-Za-z]:[\\\\/]/.test(part))) {`,
  `    return fail("sandbox: the program was recorded with a path of the host; set DAEMONIZE_SANDBOX_COMMAND to its command line inside the container");`,
  `  }`,
  ``,
  `  const name = "daemonize-" + Math.random().toString(36).slice(2, 10);`,
  `  const dockerArgs = [`,
  `    "run", "--rm", "-i", "--name", name,`,
  `    // Never download an image implicitly: it must have been built on purpose`,
  `    "--pull", "never",`,
  `    "--network", NETWORK,`,
  `    "--memory", MEMORY_MB + "m", "--cpus", String(CPUS),`,
  `    "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",`,
  `    ...EXTRA_FLAGS,`,
  `    ...timeoutEnv,`,
  `    ...secretEnv,`,
  `    ...MOUNTS.flatMap((mount) => ["-v", mount]),`,
  `    IMAGE`,
  `  ];`,
  ``,
  `  return new Promise<Record<string, unknown>>((resolve) => {`,
  `    const child = spawn(DOCKER, dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });`,
  `    let stdout = "";`,
  `    let stderr = "";`,
  `    let settled = false;`,
  `    const finish = (result: Record<string, unknown>) => {`,
  `      if (settled) return;`,
  `      settled = true;`,
  `      clearTimeout(timer);`,
  `      resolve(result);`,
  `    };`,
  ``,
  `    const timer = setTimeout(() => {`,
  `      spawn(DOCKER, ["kill", name], { stdio: "ignore" }).on("error", () => {});`,
  `      finish(fail("timeout"));`,
  `    }, REPLAY_TIMEOUT_MS + STARTUP_ALLOWANCE_MS);`,
  ``,
  `    child.stdout.on("data", (data) => (stdout += data));`,
  `    child.stderr.on("data", (data) => (stderr += data));`,
  `    child.on("error", (err) => finish(fail("sandbox_unavailable: cannot run " + DOCKER + " (" + err.message + ")")));`,
  `    child.on("close", (code) => {`,
  `      const lastLine = stdout.trim().split("\\n").pop() ?? "";`,
  `      try {`,
  `        finish(keepScreenshot(JSON.parse(lastLine)));`,
  `        return;`,
  `      } catch {`,
  `        // Not a result: the container could not run`,
  `      }`,
  `      const detail = stderr.trim().split("\\n").slice(-3).join(" ");`,
  `      const unavailable = /Cannot connect to the Docker daemon|error during connect|No such image|pull access denied/i.test(stderr);`,
  `      finish(fail((unavailable ? "sandbox_unavailable: " : "sandbox failed (exit " + code + "): ") + detail));`,
  `    });`,
  `    // The container may end before it has read everything`,
  `    child.stdin.on("error", () => {});`,
  `    child.stdin.end(JSON.stringify({ steps, args, final, limits: { callMs: REPLAY_TIMEOUT_MS }, command: COMMAND, url: URL_OVERRIDE }));`,
  `  });`,
  `}`,
];

/**
 * Generates the standalone TypeScript files of an MCP server from an annotated
 * Workflow set: the server (`generate`), the replay of a workflow
 * (`generateReplay`) and its replay in a container (`generateDockerReplay`).
 * They import only @modelcontextprotocol/sdk, zod, ajv, ajv-formats and,
 * depending on the target, playwright (web) or node-pty and @xterm/headless
 * (terminal) — no Daemonize runtime dependency.
 */
export class McpGenerator {
  /**
   * Generate a standalone TypeScript MCP server source file.
   *
   * The generated file:
   * - Imports @modelcontextprotocol/sdk, zod, ajv, ajv-formats and playwright
   *   (web) or node-pty and @xterm/headless (terminal)
   * - Validates every payload against the inferred JSON Schema before replaying
   * - Requires NO Daemonize runtime dependency
   * - Registers one tool per Workflow using server.tool()
   * - Replays the workflow from a fresh browser context, or a freshly started
   *   program, on every call
   * - Starts a StdioServerTransport
   *
   * @param set - Annotated workflow set
   * @param toolNames - Map from workflowId to tool name
   * @returns TypeScript source code as a string
   */
  generate(
    set: WorkflowSet,
    toolNames: Map<string, string>
  ): string {
    this.assertTarget(set);

    const toolBlocks = set.workflows
      .map((w) => this.generateToolBlock(set, w, toolNames))
      .join('\n\n');

    const lines: string[] = [
      `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
      `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
      `import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";`,
      `import _addFormats from "ajv-formats";`,
      `import { z } from "zod";`,
      `import { replay } from "./replay.js";`,
      `import { replayInDocker } from "./docker-replay.js";`,
      ``,
      `const INPUT_SCHEMAS: Record<string, object> = ${JSON.stringify(this.collectInputSchemas(set, toolNames))};`,
      ``,
      ...VALIDATION_RUNTIME,
      `// DAEMONIZE_SANDBOX=docker replays every call in a throw-away container instead of on this machine.`,
      `const runReplay = process.env.DAEMONIZE_SANDBOX === "docker" ? replayInDocker : replay;`,
      ``,
      `const server = new McpServer({`,
      `  name: ${JSON.stringify(set.targetName)},`,
      `  version: "1.0.0"`,
      `});`,
      ``,
      toolBlocks,
      ``,
      `const transport = new StdioServerTransport();`,
      `await server.connect(transport);`,
    ];

    return lines.join('\n');
  }

  /**
   * Generate `replay.ts`: replays the steps of a workflow from a fresh browser
   * context, or a freshly started program. It runs on the host when imported by
   * the server and inside a container when started with `--container`.
   */
  generateReplay(set: WorkflowSet): string {
    this.assertTarget(set);

    const lines: string[] = [
      ...(set.targetType === 'web'
        ? [
          `import { chromium } from "playwright";`,
          `import { screenId } from "./screen-hash.js";`,
          `import { waitForEffect, resolveTimeoutMs, resolveStepTimeoutMs, boundStepTimeoutMs, type SettlePage } from "./settle.js";`,
          `import { createWebRun, executeWebStep, captureFailure } from "./web-steps.js";`,
          `import { missingSecrets, runStepsStrict, describeFailure, failureResult } from "./step-plan.js";`,
        ]
        : [
          `import pty from "node-pty";`,
          `import xtermHeadless from "@xterm/headless";`,
          `import { screenId, cropTerminal } from "./screen-hash.js";`,
          `import { resolveTimeoutMs } from "./settle.js";`,
        ]),
      ``,
      ...(set.targetType === 'web'
        ? [
          `const START_URL = ${JSON.stringify(set.startUrl)};`,
          `const STORAGE_STATE: string | undefined = ${JSON.stringify(set.storageState)};`,
        ]
        : [
          `const START_COMMAND: string[] = ${JSON.stringify(set.startCommand)};`,
          `const KEY_SEQUENCES: Record<string, string> = ${JSON.stringify(KEY_SEQUENCES)};`,
        ]),
      ``,
      ...REPLAY_COMMON,
      ...(set.targetType === 'web' ? WEB_RUNTIME : TERMINAL_RUNTIME),
      ...CONTAINER_ENTRY,
    ];
    return lines.join('\n') + '\n';
  }

  /**
   * Generate `docker-replay.ts`: replays a call in a throw-away container with
   * limits on memory and CPU, no capabilities, no implicit image download, and
   * no network for a terminal program.
   *
   * @param imageTag - default tag of the sandbox image built by `daemonize sandbox build`
   */
  generateDockerReplay(set: WorkflowSet, imageTag: string): string {
    this.assertTarget(set);

    const terminal = set.targetType === 'tui';
    const lines: string[] = [
      `import { spawn } from "node:child_process";`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { tmpdir } from "node:os";`,
      `import { join } from "node:path";`,
      `import type { Step, Final, Limits } from "./replay.js";`,
      `import { resolveTimeoutMs } from "./settle.js";`,
      `import { missingSecrets, secretEnvName } from "./step-plan.js";`,
      ``,
      `const DEFAULT_IMAGE = ${JSON.stringify(imageTag)};`,
      terminal
        ? `// A terminal program needs nothing from the network.`
        : `// A browser must reach the application; the container still has no access to the host network stack.`,
      `const DEFAULT_NETWORK = ${JSON.stringify(terminal ? 'none' : 'bridge')};`,
      terminal
        ? `// Read-only file system with a scratch /tmp; the program runs as an unprivileged user.`
        : `// Chromium needs more shared memory than a container gets by default.`,
      `const EXTRA_FLAGS: string[] = ${JSON.stringify(terminal ? ['--read-only', '--tmpfs', '/tmp'] : ['--shm-size', '512m'])};`,
      `const HOST_COMMAND: string[] | undefined = ${JSON.stringify(terminal ? set.startCommand : undefined)};`,
      ``,
      ...DOCKER_RUNTIME,
    ];
    return lines.join('\n') + '\n';
  }

  /**
   * Files needed to build the sandbox image, relative to the output directory:
   * the Dockerfile (to build with the output directory as context) and the
   * minimal package.json of what runs inside the container.
   */
  generateSandboxFiles(set: WorkflowSet): { dockerfile: string; packageJson: string; dockerignore: string } {
    this.assertTarget(set);

    const terminal = set.targetType === 'tui';
    const dependencies = terminal
      ? { 'node-pty': '^1.1.0', '@xterm/headless': '^6.0.0' }
      : { playwright: PLAYWRIGHT_VERSION };

    const dockerfile = [
      '# Sandbox of the generated server: each call is replayed in a throw-away container made from this image.',
      '# Build it from the output directory: daemonize sandbox build',
      terminal ? 'FROM node:20' : `FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`,
      'WORKDIR /sandbox',
      'ENV DAEMONIZE_IN_CONTAINER=1',
      ...(terminal ? [] : ['ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1']),
      'COPY sandbox/package.json ./package.json',
      'RUN npm install --omit=dev',
      'COPY replay.js ./replay.js',
      'COPY screen-hash.js ./screen-hash.js',
      'COPY settle.js ./settle.js',
      ...(terminal ? [] : ['COPY row-resolver.js ./row-resolver.js', 'COPY step-plan.js ./step-plan.js', 'COPY web-steps.js ./web-steps.js']),
      terminal ? 'USER node' : 'USER pwuser',
      'ENTRYPOINT ["node", "replay.js", "--container"]',
      '',
    ].join('\n');

    return {
      dockerfile,
      packageJson: JSON.stringify({ name: 'sandbox', private: true, type: 'module', dependencies }, null, 2),
      dockerignore: ['node_modules', 'tests', '*.md', ''].join('\n'),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertTarget(set: WorkflowSet): void {
    if (set.targetType === 'web' && !set.startUrl) {
      throw new Error('A web target needs a startUrl');
    }
    if (set.targetType === 'tui' && (!set.startCommand || set.startCommand.length === 0)) {
      throw new Error('A terminal target needs a startCommand');
    }
  }

  private generateToolBlock(
    set: WorkflowSet,
    workflow: Workflow,
    toolNames: Map<string, string>
  ): string {
    const toolName = toolNames.get(workflow.id) ?? workflow.id;
    const description = `${describeTool(workflow)}\n\nOptional reserved argument _timeoutMs (integer, 1 to 600000): timeout in milliseconds of the whole call; it is not part of the payload.`;
    const zodSchema = this.buildZodSchema(workflow);

    const lines: string[] = [
      `// Tool: ${toolName} (from workflow: ${JSON.stringify(workflow.label)})`,
      `server.tool(`,
      `  ${JSON.stringify(toolName)},`,
      `  ${JSON.stringify(description)},`,
      `  {`,
    ];

    for (const propLine of zodSchema) {
      lines.push(`    ${propLine}`);
    }

    lines.push(
      `    // Reserved: the timeout of this call. Never part of the inferred payload schema.`,
      `    "_timeoutMs": z.number().int().min(1).max(600000).optional(),`,
      `  },`,
      `  async ({ _timeoutMs, ...args }) => {`,
      `    // The payload is validated against the full inferred schema before any replay.`,
      `    const errors = validatePayload(${JSON.stringify(toolName)}, args);`,
      `    if (errors !== null) {`,
      `      return {`,
      `        content: [{ type: "text", text: JSON.stringify({ success: false, error: "validation", errors }) }],`,
      `        isError: true`,
      `      };`,
      `    }`,
      `    const result = await runReplay(${JSON.stringify(workflow.steps)}, args, ${JSON.stringify(this.finalOf(workflow))}, { callMs: _timeoutMs, workflowMs: ${JSON.stringify(workflow.timeoutMs)}, setMs: ${JSON.stringify(set.timeoutMs)} });`,
      `    return {`,
      `      content: [{ type: "text", text: JSON.stringify(result) }],`,
      `      isError: !result.success`,
      `    };`,
      `  }`,
      `);`
    );

    return lines.join('\n');
  }

  /** The recorded final screen of a workflow (and its zone), embedded for the drift check. */
  private finalOf(workflow: Workflow): { finalScreenId?: string; finalZone?: Workflow['finalZone'] } {
    const final: { finalScreenId?: string; finalZone?: Workflow['finalZone'] } = {};
    if (workflow.finalScreenId !== undefined) final.finalScreenId = workflow.finalScreenId;
    if (workflow.finalZone !== undefined) final.finalZone = workflow.finalZone;
    return final;
  }

  /** Input schema of each tool, keyed by tool name. */
  private collectInputSchemas(
    set: WorkflowSet,
    toolNames: Map<string, string>
  ): Record<string, unknown> {
    const schemas: Record<string, unknown> = {};
    for (const workflow of set.workflows) {
      schemas[toolNames.get(workflow.id) ?? workflow.id] = workflow.inputSchema ?? { type: 'object' };
    }
    return schemas;
  }

  /**
   * Convert the JSON Schema properties of a Workflow's inputSchema into an
   * array of "propName: z.xxx()," lines suitable for embedding in an object
   * literal.
   */
  private buildZodSchema(workflow: Workflow): string[] {
    const schema = workflow.inputSchema;
    if (!schema) {
      return [];
    }

    const properties = schema['properties'];
    if (!properties || typeof properties !== 'object') {
      return [];
    }

    const required: string[] = Array.isArray(schema['required'])
      ? (schema['required'] as string[])
      : [];

    const lines: string[] = [];

    for (const [propName, propSchema] of Object.entries(
      properties as Record<string, unknown>
    )) {
      // Recursive translation; optional unless required, then described
      const zodExpr = propertyToZodSource(propSchema, required.includes(propName), `#/properties/${propName}`).source;

      lines.push(`${JSON.stringify(propName)}: ${zodExpr},`);
    }

    return lines;
  }
}
