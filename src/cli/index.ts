#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import { record, type RecordSummary } from './commands/record.js';
import { recordTui } from './commands/record-tui.js';
import { parseTerminalDimension } from '../recorder/terminal-recorder.js';
import { compile, parseHttpMode } from './commands/compile.js';
import { merge } from './commands/merge.js';
import { serve } from './commands/serve.js';
import { buildSandboxImage } from './commands/sandbox.js';
import { validateSandboxSpec } from '../sandbox/dockerfile.js';
import type { SandboxSpec } from '../types.js';

const DEFAULT_WORKFLOWS_FILE = 'daemonize.workflows.json';
const DEFAULT_OUTPUT_DIR = 'daemonize-out';

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** The sandbox flags of record and compile, or undefined when none was given. Invalid values fail before anything runs. */
function sandboxFlags(
  options: { sandboxImage?: string; sandboxPackage?: string[]; sandboxInstall?: string[]; sandboxNetwork?: string },
  targetType?: 'web' | 'tui'
): SandboxSpec | undefined {
  return specFromFlags({ image: options.sandboxImage, packages: options.sandboxPackage, install: options.sandboxInstall, network: options.sandboxNetwork }, targetType);
}

function specFromFlags(flags: { image?: string; packages?: string[]; install?: string[]; network?: string }, targetType?: 'web' | 'tui'): SandboxSpec | undefined {
  const spec: SandboxSpec = {};
  if (flags.image !== undefined) spec.image = flags.image;
  if (flags.packages !== undefined) spec.packages = flags.packages;
  if (flags.install !== undefined) spec.install = flags.install;
  if (flags.network !== undefined) {
    if (flags.network !== 'none' && flags.network !== 'bridge') throw new Error(`Unknown network "${flags.network}": use none or bridge`);
    spec.network = flags.network;
  }
  if (Object.keys(spec).length === 0) return undefined;
  // The target type is known when recording; compile and build check it again against the set
  validateSandboxSpec(spec, targetType ?? 'tui');
  return spec;
}
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('daemonize')
    .description('Wrap a web application behind a generated MCP server and OpenAPI spec');

  program
    .command('record <target...>')
    .description(
      'Record a workflow: give the URL of a web application, or with --type tui the command of a terminal program (after "--")'
    )
    .requiredOption('-l, --label <label>', 'name of the workflow (becomes the tool name)')
    .option('-t, --type <type>', 'web or tui', 'web')
    .option('-n, --name <name>', 'name of the application (default: the host of the URL, or the program)')
    .option('-o, --out <file>', 'workflow file to create or add to', DEFAULT_WORKFLOWS_FILE)
    .option('--storage-state <file>', 'web only: Playwright storage state, to start already logged in')
    .option('--headless', 'web only: run the browser without a window')
    .option('--final-zone <selector>', 'web only: CSS selector; drift is judged on this part of the final page only')
    .option('--final-rect <row,col,rows,cols>', 'tui only: rectangle of the final screen (0-based); drift is judged on it only')
    .option('--result-zone <selector>', 'web only: element whose content the tool returns as `data` instead of the whole page')
    .option('--result-kind <kind>', 'web only: how to read the result zone: text, table, list, fields, json or attribute (default: suggested from the element)')
    .option('--capture-network', 'web only: observe fetch/XHR requests and record Level 1 HTTP recipes (default)')
    .option('--no-capture-network', 'web only: do not observe network requests; every step stays Level 2')
    .option('--no-visual', 'web only: do not capture Visual_Anchors (no thumbnail, no rect, no intent)')
    .option('--result-rect <row,col,rows,cols>', 'tui only: part of the final screen (0-based) the tool returns as `text` and `data`')
    .option('--result-regex <regex>', 'tui only: regular expression applied to the result zone; its named groups become `data`')
    .option('--result-regex-flags <flags>', 'tui only: flags of --result-regex (default m; add g for every match as an array)')
    .option('--cols <n>', 'tui only: terminal width to record and replay at, 20 to 500 (default: your terminal, or 80)')
    .option('--rows <n>', 'tui only: terminal height to record and replay at, 5 to 200 (default: your terminal, or 24)')
    .option('--wait-after <regex>', 'tui only: every step waits at replay until the rendered screen matches this regular expression (default: the prompt shown after each step is detected)')
    .option('--wait-timeout <ms>', 'tui only: timeout of the screen waits, default 15000')
    .option('--sandbox-image <ref>', 'Docker sandbox: base image of the replay container, stored in the workflow file')
    .option('--sandbox-package <name>', 'Docker sandbox: package to install in the image (repeatable), stored in the workflow file', collect)
    .option('--sandbox-install <cmd>', 'Docker sandbox: extra command to run when building the image (repeatable), stored in the workflow file', collect)
    .option('--sandbox-network <mode>', 'Docker sandbox: none or bridge (default none for a terminal program, bridge for a web page), stored in the workflow file')
    .action(async (target: string[], options) => {
      if (options.type === 'tui') {
        if (options.finalZone !== undefined) {
          throw new Error('--final-zone is for web recordings; use --final-rect with --type tui');
        }
        if (options.captureNetwork !== undefined) {
          throw new Error('--capture-network and --no-capture-network are for web recordings');
        }
        if (options.resultZone !== undefined || options.resultKind !== undefined) {
          throw new Error('--result-zone and --result-kind are for web recordings; use --result-rect and --result-regex with --type tui');
        }
        console.log(
          chalk.cyan(
            'Recording. Use the program as usual. Ctrl+] opens a menu: v marks the last typed text as a variable, w waits for a screen pattern after the last step, e ends the recording.'
          )
        );
        const summary = await recordTui({
          command: target,
          label: options.label,
          name: options.name ?? target[0],
          out: options.out,
          finalRect: options.finalRect === undefined ? undefined : parseRect(options.finalRect, '--final-rect'),
          resultRect: options.resultRect === undefined ? undefined : parseRect(options.resultRect, '--result-rect'),
          resultRegex: options.resultRegex,
          resultRegexFlags: options.resultRegexFlags,
          cols: options.cols === undefined ? undefined : parseTerminalDimension(options.cols, 'cols'),
          rows: options.rows === undefined ? undefined : parseTerminalDimension(options.rows, 'rows'),
          waitAfter: options.waitAfter,
          waitTimeoutMs: options.waitTimeout === undefined ? undefined : parseWaitTimeout(options.waitTimeout),
          sandbox: sandboxFlags(options, 'tui'),
        });
        console.log(`\r\n${chalk.green(describeSummary(summary))}`);
        console.log(`Terminal size: ${summary.cols}x${summary.rows}${summary.resized ? ' (you resized the terminal; replay uses this size)' : ''}.`);
        console.log(`Screen waits: ${summary.screenWaits} of ${summary.steps} step(s) wait for a pattern of the screen at replay.`);
        if (summary.programExitCode !== undefined) {
          console.log(chalk.yellow(`The program exited with code ${summary.programExitCode}.`));
        }
        if (summary.constantTypedValues > 0) {
          console.log(
            chalk.yellow(
              `${summary.constantTypedValues} typed value(s) were not marked as variables and are stored as they are in ${summary.out}. Check that none is a secret.`
            )
          );
        }
        return;
      }

      if (options.cols !== undefined || options.rows !== undefined) {
        throw new Error('--cols and --rows are for terminal recordings (--type tui)');
      }
      if (options.waitAfter !== undefined || options.waitTimeout !== undefined) {
        throw new Error('--wait-after and --wait-timeout are for terminal recordings (--type tui)');
      }
      if (options.finalRect !== undefined) {
        throw new Error('--final-rect is for terminal recordings (--type tui); use --final-zone for a web page');
      }
      if (options.resultRect !== undefined || options.resultRegex !== undefined || options.resultRegexFlags !== undefined) {
        throw new Error('--result-rect and --result-regex are for terminal recordings (--type tui); use --result-zone and --result-kind for a web page');
      }
      if (options.resultKind !== undefined && !WEB_RESULT_KINDS.includes(options.resultKind)) {
        throw new Error(`Unknown --result-kind "${options.resultKind}": use ${WEB_RESULT_KINDS.join(', ')}`);
      }
      if (options.resultKind !== undefined && options.resultZone === undefined) {
        throw new Error('--result-kind needs --result-zone');
      }
      if (options.type !== 'web') {
        throw new Error(`Unknown type "${options.type}": use web or tui`);
      }
      if (target.length !== 1) {
        throw new Error('A web recording takes exactly one URL');
      }

      console.log(
        chalk.cyan(
          'Recording. Type in fields and use the "Make variable" box that appears to mark the values the tool should take as input.'
        )
      );
      const summary = await record({
        url: target[0],
        label: options.label,
        name: options.name ?? new URL(target[0]).host,
        out: options.out,
        storageState: options.storageState,
        headless: options.headless,
        finalZone: options.finalZone,
        resultZone: options.resultZone,
        resultKind: options.resultKind,
        captureNetwork: options.captureNetwork ?? true,
        visual: options.visual !== false,
        sandbox: sandboxFlags(options, 'web'),
      });
      console.log(chalk.green(describeSummary(summary)));
      if (options.visual !== false) {
        console.log(chalk.cyan(`${summary.thumbnails} thumbnail(s) saved in ${summary.out}.assets/ (never for password, one-time-code or token fields)`));
      }
      for (const step of summary.network ?? []) {
        const name = step.label === undefined ? '' : ` "${step.label}"`;
        console.log(
          step.level === 'http'
            ? chalk.cyan(`  step ${step.step}${name}: http (${step.request}), accessibility as fallback`)
            : chalk.gray(`  step ${step.step}${name}: accessibility (${step.reason})`)
        );
      }
      for (const secret of summary.secrets) {
        console.log(
          chalk.yellow(
            secret.totp
              ? `Replay needs ${secret.envVariable} (the base32 TOTP seed; the current code is typed at each call).`
              : `Replay needs ${secret.envVariable} (the value typed here was not stored).`
          )
        );
      }
      if (summary.constantTypedValues > 0) {
        console.log(
          chalk.yellow(
            `${summary.constantTypedValues} typed value(s) were not marked as variables and are stored as they are in ${summary.out}. Check that none is a secret.`
          )
        );
      }
    });

  program
    .command('compile [file]')
    .description('Generate the OpenAPI spec, MCP server and Kiro Power from a workflow file')
    .option('-o, --out <dir>', 'output directory', DEFAULT_OUTPUT_DIR)
    .option('--install', 'run "npm install" in the output directory afterwards')
    .option(
      '--http [mode]',
      'web only: execute the recorded HTTP request of each step that has one (auto, the default when the flag is given) instead of driving the page; off disables it'
    )
    .option('--heal-support', 'web only: compile in the Heal modules and the recorded thumbnails so the server can run with --heal (default off: no model code in the output)')
    .option('--sandbox-image <ref>', 'Docker sandbox: base image of the replay container, stored in the workflow file')
    .option('--sandbox-package <name>', 'Docker sandbox: package to install in the image (repeatable), stored in the workflow file', collect)
    .option('--sandbox-install <cmd>', 'Docker sandbox: extra command to run when building the image (repeatable), stored in the workflow file', collect)
    .option('--sandbox-network <mode>', 'Docker sandbox: none or bridge (default none for a terminal program, bridge for a web page), stored in the workflow file')
    .action(async (file: string | undefined, options) => {
      await compile(file ?? DEFAULT_WORKFLOWS_FILE, options.out, { install: options.install, http: parseHttpMode(options.http), healSupport: options.healSupport === true, sandbox: sandboxFlags(options) });
    });

  program
    .command('merge <base> <newer>')
    .description('Merge two workflow files; the newer one wins on identical workflow ids')
    .option('-o, --out <file>', 'output file (default: overwrite <base>)')
    .action(async (base: string, newer: string, options) => {
      const count = await merge(base, newer, options.out ?? base);
      console.log(chalk.green(`Merged: ${count} workflow(s) in ${options.out ?? base}.`));
    });

  program
    .command('serve [dir]')
    .description('Run the compiled MCP server of an output directory over stdio')
    .option('--sandbox <kind>', 'docker: replay every call in a throw-away container instead of on this machine')
    .option('--memory <mb>', 'sandbox memory limit in MB (default 512)', Number)
    .option('--cpus <n>', 'sandbox CPU limit (default 1)', Number)
    .option(
      '--mount <spec>',
      'sandbox only: share a folder of this machine with the container, as host:container[:ro] (repeatable)',
      (spec: string, previous: string[] = []) => [...previous, spec]
    )
    .option('--sandbox-command <json>', 'sandbox only: command to start in the container, as a JSON array, e.g. \'["node","/app/x.mjs"]\'')
    .option('--sandbox-url <url>', 'sandbox only: address the browser opens in the container')
    .option('--strict', 'replay only through recorded, deterministic means; a step that cannot be performed fails the call (default)')
    .option('--heal', 'when every locator of a read step fails (or the page has no DOM), let a vision model locate the element; needs a server compiled with --heal-support')
    .option('--timeout <ms>', 'timeout of a whole call, in ms (DAEMONIZE_TIMEOUT_MS; default 30000)', Number)
    .option('--step-timeout <ms>', 'timeout of a step, in ms (DAEMONIZE_STEP_TIMEOUT_MS; default 8000)', Number)
    .action(async (dir: string | undefined, options) => {
      if (options.sandbox !== undefined && options.sandbox !== 'docker') {
        throw new Error(`Unknown sandbox "${options.sandbox}": use docker`);
      }
      process.exitCode = await serve(dir ?? DEFAULT_OUTPUT_DIR, {
        mode: parseServeMode(options),
        sandbox: options.sandbox,
        memoryMb: options.memory,
        cpus: options.cpus,
        mounts: options.mount,
        command: options.sandboxCommand === undefined ? undefined : JSON.parse(options.sandboxCommand),
        url: options.sandboxUrl,
        timeoutMs: options.timeout,
        stepTimeoutMs: options.stepTimeout,
      });
    });

  program
    .command('sandbox')
    .description('Manage the Docker sandbox of a compiled project')
    .command('build [dir]')
    .description('Build the Docker image each call is replayed in (downloads its base image and packages)')
    .option('--image <ref>', 'base image (Debian, Ubuntu or Alpine family; the runtime is added to it)')
    .option('--package <name>', 'package to install with apt-get or apk (repeatable)', collect)
    .option('--install <cmd>', 'extra command to run as root when building the image, one RUN each (repeatable)', collect)
    .option('--network <mode>', 'network of the replay container: none or bridge (default none for a terminal program, bridge for a web page)')
    .option('--tag <name>', 'name of the image (default: the one chosen at compile time; serve --sandbox docker uses the last one built)')
    .option('--no-cache', 'build without the Docker layer cache')
    .option('--print', 'write the Dockerfile to stdout and build nothing')
    .action(async (dir: string | undefined, options) => {
      const target = dir ?? DEFAULT_OUTPUT_DIR;
      const spec = specFromFlags({ image: options.image, packages: options.package, install: options.install, network: options.network });
      const tag = await buildSandboxImage(target, { ...spec, tag: options.tag, noCache: options.cache === false, print: options.print === true });
      if (options.print === true) {
        process.stdout.write(tag.endsWith('\n') ? tag : `${tag}\n`);
        return;
      }
      console.log(chalk.green(`Built the sandbox image "${tag}". Use it with: daemonize serve ${target} --sandbox docker`));
    });
  return program;
}

/** `--strict` and `--heal` exclude each other; neither means strict. */
export function parseServeMode(options: { strict?: boolean; heal?: boolean }): 'strict' | 'heal' {
  if (options.strict === true && options.heal === true) {
    throw new Error('--strict and --heal cannot be used together: choose one (strict is the default)');
  }
  return options.heal === true ? 'heal' : 'strict';
}

const WEB_RESULT_KINDS = ['text', 'table', 'list', 'fields', 'json', 'attribute'];

function parseWaitTimeout(text: string): number {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(n) || n < 1 || n > 600000) {
    throw new Error(`Invalid --wait-timeout "${text}": expected a whole number of milliseconds from 1 to 600000`);
  }
  return n;
}

function parseRect(text: string, option: string): { row: number; col: number; rows: number; cols: number } {
  const parts = text.split(',').map((part) => Number(part.trim()));
  const [row, col, rows, cols] = parts;
  if (parts.length !== 4 || !parts.every(Number.isInteger) || row < 0 || col < 0 || rows < 1 || cols < 1) {
    throw new Error(`Invalid ${option} "${text}": expected row,col,rows,cols (0-based, size at least 1)`);
  }
  return { row, col, rows, cols };
}

function describeSummary(summary: RecordSummary): string {
  const variables = summary.variables.length > 0 ? summary.variables.join(', ') : 'none';
  return `Saved ${summary.steps} steps (variables: ${variables}) to ${summary.out}; ${summary.totalWorkflows} workflow(s) in total.`;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

// Run only when executed directly, not when imported (tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
