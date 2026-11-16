import type { Workflow } from '../types.js';

/**
 * The description shown for a tool: the label of the workflow followed by the
 * inputs it takes, with the description inferred for each one. An agent reads
 * this to know what to pass, for example
 * `Create customer. Inputs: email (Customer e-mail), qty.`
 */
export function describeTool(workflow: Workflow): string {
  const properties = (workflow.inputSchema?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;

  const inputs = Object.entries(properties).map(([name, schema]) =>
    typeof schema['description'] === 'string' && schema['description'] !== ''
      ? `${name} (${schema['description']})`
      : name
  );

  return inputs.length > 0 ? `${workflow.label}. Inputs: ${inputs.join(', ')}.` : workflow.label;
}
