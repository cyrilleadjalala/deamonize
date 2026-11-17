import { resolve } from 'node:path';
import { describeTool, secretEnvNames } from './tool-description.js';
import type { WorkflowSet } from '../types.js';

export interface KiroPlugin {
  $schema: string;
  name: string;
  version: string;
  description: string;
  author: { name: string };
  keywords: string[];
}

export interface KiroMcp {
  $schema: string;
  mcpServers: Record<
    string,
    { type: 'stdio'; command: 'node'; args: string[]; env: Record<string, string> }
  >;
}

export interface KiroPower {
  plugin: KiroPlugin;
  mcp: KiroMcp;
  skill: string;
  powerMd: string;
}

/** Lowercase kebab-case identifier of at most 64 characters. */
export function toKebabCase(value: string): string {
  const kebab = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
  return kebab || 'daemonize-power';
}

const yamlString = (value: string): string => JSON.stringify(value);

/** The settings of the model a heal consults: written as `${NAME}` placeholders, never as values. */
const HEAL_MODEL_VARIABLES = ['DAEMONIZE_MODEL_PROVIDER', 'DAEMONIZE_MODEL_NAME', 'DAEMONIZE_MODEL_API_KEY', 'DAEMONIZE_MODEL_BASE_URL'];

export class KiroPowerGenerator {
  /**
   * Generate the content of the Kiro Power files (no I/O).
   *
   * @param set - Annotated workflow set
   * @param toolNames - Map from workflowId to snake_case tool name
   * @param outputDir - Directory where mcp-server.js is written
   */
  generate(set: WorkflowSet, toolNames: Map<string, string>, outputDir: string, options: { http?: 'off' | 'auto'; healSupport?: boolean; powerName?: string } = {}): KiroPower {
    const http = set.targetType === 'web' && options.http === 'auto';
    const healSupport = set.targetType === 'web' && options.healSupport === true;
    const targetName = set.targetName || 'Generated Application';
    const name = options.powerName ?? toKebabCase(set.targetName);
    const description = `Generated MCP server for ${targetName} by Daemonize`;

    const tools = set.workflows.map((workflow) => ({
      workflow,
      name: toolNames.get(workflow.id) ?? workflow.id,
    }));

    const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const keywords = [
      ...new Set([
        targetName.toLowerCase().trim(),
        ...words(targetName),
        ...tools.flatMap((t) => [t.name.toLowerCase(), ...words(t.name)]),
        'daemonize',
        'mcp',
      ].filter((k) => k !== '')),
    ];

    const plugin: KiroPlugin = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version: '1.0.0',
      description,
      author: { name: 'Daemonize' },
      keywords,
    };

    // Names only: Kiro substitutes ${VAR} from its own environment, so no value is ever written to a file
    const secretVariables = [...new Set(set.workflows.flatMap((workflow) => secretEnvNames(workflow, { http })))].sort();
    const env: Record<string, string> = Object.fromEntries(secretVariables.map((v) => [v, '${' + v + '}']));
    // The replay mode is an editable default: "strict" unless the user changes it to "heal"
    env.DAEMONIZE_MODE = 'strict';
    // Only a server compiled with --heal-support can use a model: only then are its settings named here
    if (healSupport) {
      for (const v of HEAL_MODEL_VARIABLES) env[v] = '${' + v + '}';
    }

    const mcp: KiroMcp = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        [name]: {
          type: 'stdio',
          command: 'node',
          args: [resolve(outputDir, 'mcp-server.js')],
          env,
        },
      },
    };

    const toolSections = tools.map(({ workflow, name: toolName }) => {
      const properties = (workflow.inputSchema?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set(
        Array.isArray(workflow.inputSchema?.['required']) ? (workflow.inputSchema['required'] as string[]) : []
      );
      const fields = Object.entries(properties).map(([field, schema]) => {
        const type = typeof schema['type'] === 'string' ? schema['type'] : 'string';
        const text = typeof schema['description'] === 'string' && schema['description'] !== ''
          ? `: ${schema['description']}`
          : '';
        return `- \`${field}\` (${type}, ${required.has(field) ? 'required' : 'optional'})${text}`;
      });
      return [
        `### \`${toolName}\``,
        '',
        describeTool(workflow, { http }),
        '',
        ...(fields.length > 0 ? ['Inputs:', '', ...fields] : ['Inputs: none.']),
        '',
      ].join('\n');
    });

    const skill = [
      '---',
      `name: ${name}`,
      `description: ${yamlString(`Use when the user wants to operate ${targetName}.`)}`,
      '---',
      '',
      `# ${targetName}`,
      '',
      '## When to use',
      '',
      `Use these tools when the user asks to perform, in ${targetName}, one of the tasks listed below. Each tool replays a workflow recorded in the application and returns what the final screen shows.`,
      '',
      '## Tools',
      '',
      ...toolSections,
      ...(secretVariables.length > 0
        ? [
          '## Passwords',
          '',
          'The password is read from the Daemonize vault of your account on this computer. Enter it once in the Daemonize Studio, on the Credentials screen. Nothing secret is written in this file. A value set in the environment where Kiro runs is used first when it exists. Names used by this tool (names only, never values):',
          '',
          ...secretVariables.map((v) => `- \`${v}\``),
          '',
          'A name with no value anywhere makes the call fail with `missing_secret` naming it, before any step runs. A variable used for a one-time code holds the base32 TOTP seed; the current code is computed at each call.',
          '',
        ]
        : []),
      ...(http
        ? [
          '## HTTP replay',
          '',
          'This server was compiled with `--http`. A tool whose steps all have a recorded HTTP request runs over HTTP without a browser (tens of milliseconds); the description of each tool says which steps run over HTTP. The result lists the level each step used in `levels` (`http` or `accessibility`) and sets `levelFallback: true` when a read step\'s request failed and the step was repeated in the browser. A write or delete step whose request fails is not repeated: the call returns `error: "http_failed"` with `drifted: true`.',
          '',
          'Authentication comes from the saved login (`DAEMONIZE_STORAGE_STATE`, a Playwright storage state file), or from `DAEMONIZE_COOKIE_HEADER` (a Cookie header value, set in the environment, never in a file), plus the `DAEMONIZE_SECRET_<NAME>` variables listed above for header tokens.',
          '',
        ]
        : []),
      ...(set.targetType === 'tui' && set.sandbox?.network === 'bridge'
        ? [
          '## Network',
          '',
          'In a Docker sandbox (`daemonize serve --sandbox docker`) this program runs with network access (`sandbox.network: "bridge"` in the workflow file). A terminal program has none by default; this one needs it, so it can reach the internet and the services of the host. The server logs a warning about it.',
          '',
        ]
        : []),
      '## Modes: strict and heal',
      '',
      'The server replays in strict mode unless told otherwise: every step runs through recorded, deterministic means only, and a step that cannot be performed fails the call with `success: false` and `drifted: true`. Nothing is guessed. Every result carries `mode` (`strict` or `heal`).',
      '',
      ...(healSupport
        ? [
          'This server was compiled with `--heal-support`, so heal mode is available. To turn it on, set `DAEMONIZE_MODE` to `heal` in the `env` of `mcp.json` (or start the server with `daemonize serve --heal`) and set the model variables of `mcp.json`:',
          '',
          ...HEAL_MODEL_VARIABLES.map((v) => `- \`${v}\``),
          '',
          'In heal mode, when every locator of a read step fails (or the page has no DOM, such as a canvas), the server looks for the element in this order: a locator cached by an earlier heal, the recorded coordinates (canvas), then a multimodal model that sees a screenshot with numbered marks, the recorded thumbnail and the intent of the step. A write or delete step is healed only when it has `allowHeal: true`. The result then has `healed: true` and `healedSteps` (step index and source: `cache`, `coordinates` or `model`). If no model is configured the call fails with `error: "heal_unavailable"`. The workflow is never modified; only `.daemonize/heal-cache.json` is written.',
          '',
        ]
        : [
          'This server was compiled without heal support. To use heal mode, recompile with `daemonize compile --heal-support`, then set `DAEMONIZE_MODE` to `heal` in the `env` of `mcp.json` (or start the server with `daemonize serve --heal`). A server in strict mode never contacts a model.',
          '',
        ]),
      '## Drift',
      '',
      'A result with `drifted: true` means the final screen differs from the one recorded (only the recorded zone is compared when the workflow has one), so the application probably changed. Double-check the result before relying on it. `driftChecked: false` means no final screen was recorded: `drifted` is then always `false` and says nothing.',
      '',
    ].join('\n');

    const powerMd = [
      '---',
      `name: ${yamlString(name)}`,
      `displayName: ${yamlString(targetName)}`,
      `description: ${yamlString(description)}`,
      'keywords:',
      ...keywords.map((k) => `  - ${yamlString(k)}`),
      '---',
      '',
      `# ${targetName}`,
      '',
      description + '.',
      '',
      'The MCP server exposes these tools:',
      '',
      ...tools.map((t) => `- \`${t.name}\``),
      '',
      `See \`skills/${name}/SKILL.md\` for the inputs of each tool.`,
      '',
    ].join('\n');

    return { plugin, mcp, skill, powerMd };
  }
}
