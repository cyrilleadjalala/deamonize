import { resolve } from 'node:path';
import { describeTool } from './tool-description.js';
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

export class KiroPowerGenerator {
  /**
   * Generate the content of the Kiro Power files (no I/O).
   *
   * @param set - Annotated workflow set
   * @param toolNames - Map from workflowId to snake_case tool name
   * @param outputDir - Directory where mcp-server.js is written
   */
  generate(set: WorkflowSet, toolNames: Map<string, string>, outputDir: string): KiroPower {
    const targetName = set.targetName || 'Generated Application';
    const name = toKebabCase(set.targetName);
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

    const mcp: KiroMcp = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        [name]: {
          type: 'stdio',
          command: 'node',
          args: [resolve(outputDir, 'mcp-server.js')],
          env: {},
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
        describeTool(workflow),
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
