import type { Workflow } from '../types.js';
import { pickResultZone } from '../replay/runtime/extract.js';
import { zoneDataSchema } from '../schema/data-schema.js';
import { httpSecretNames, planSteps } from '../replay/runtime/http-replay.js';

/**
 * The description shown for a tool: the label of the workflow followed by the
 * inputs it takes, with the description inferred for each one. An agent reads
 * this to know what to pass, for example
 * `Create customer. Inputs: email (Customer e-mail), qty.`
 */
export function describeTool(workflow: Workflow, options: { http?: boolean } = {}): string {
  const properties = (workflow.inputSchema?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;

  const inputs = Object.entries(properties).map(([name, schema]) =>
    typeof schema['description'] === 'string' && schema['description'] !== ''
      ? `${name} (${schema['description']})`
      : name
  );

  const output = describeOutput(workflow);
  const base = (inputs.length > 0 ? `${workflow.label}. Inputs: ${inputs.join(', ')}.` : workflow.label) + (output === undefined ? '' : ` ${output}`);
  const secrets = secretEnvNames(workflow);
  const withLevel = options.http === true ? `${base} ${describeLevels(workflow)}` : base;
  return secrets.length > 0
    ? `${withLevel} Requires the environment variable(s) ${secrets.join(', ')} in the MCP server environment (names only; never pass them as inputs).`
    : withLevel;
}

/**
 * What `data` holds when the workflow has a Result_Zone, for example
 * `Returns data: an array of objects, one per table row, with the string properties id, name.`
 */
export function describeOutput(workflow: Workflow): string | undefined {
  const zone = pickResultZone(workflow);
  if (zone === undefined) return undefined;
  const schema = zoneDataSchema(zone);
  const names = (value: unknown): string => {
    const properties = Object.keys((value as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    return properties.length > 0 ? ` with the string properties ${properties.join(', ')}` : '';
  };
  const items = schema['items'];
  let shape: string;
  switch (zone.extractor?.kind ?? 'text') {
    case 'table':
      shape = `an array of objects, one per table row, keyed by column header${names(items)}`;
      break;
    case 'list':
      shape = 'an array of strings, one per list item';
      break;
    case 'fields':
      shape = `an object of label and value strings${names(schema)}`;
      break;
    case 'json':
      shape = 'the JSON value found in the result zone';
      break;
    case 'regex':
      shape = items !== undefined
        ? `an array with one object per match of the pattern${names(items)}`
        : `an object holding the named groups of the pattern${names(schema)}`;
      break;
    case 'attribute':
      shape = 'the value read from the result zone, a string';
      break;
    default:
      shape = 'the text of the result zone, a string';
  }
  return `Returns data: ${shape}; text holds the zone text only.`;
}

/**
 * The environment variables a workflow needs: `DAEMONIZE_SECRET_<NAME>` for every secretRef of its steps
 * and every name of its `secrets` list. Names only, never values.
 */
export function secretEnvNames(workflow: Workflow): string[] {
  const names = new Set<string>();
  for (const step of workflow.steps) {
    if (step.secretRef !== undefined) names.add(step.secretRef);
  }
  for (const entry of workflow.secrets ?? []) {
    names.add(typeof entry === 'string' ? entry : entry.name);
  }
  // Names that only appear as {"$secret":NAME} references of a recorded HTTP request (Level 1)
  for (const step of workflow.steps) {
    for (const name of httpSecretNames(step.http)) names.add(name);
  }
  return [...names].sort().map((name) => `DAEMONIZE_SECRET_${name}`);
}

/**
 * Which steps run over HTTP when the server is compiled with `--http`, for the tool description and SKILL.md:
 * the whole call without a browser, or the steps that have a recipe while the others use the page.
 */
export function describeLevels(workflow: Workflow): string {
  const plan = planSteps(workflow.steps);
  const http = plan.flatMap((mode, index) => (mode === 'http' ? [index + 1] : []));
  if (http.length === 0) return 'Runs in the browser (no recorded HTTP request).';
  if (plan.every((mode) => mode !== 'ui')) return 'Runs over HTTP, without a browser.';
  const needsPage = plan.flatMap((mode, index) => (mode === 'ui' ? [index + 1] : []));
  return `Step${http.length > 1 ? 's' : ''} ${http.join(', ')} ${http.length > 1 ? 'run' : 'runs'} over HTTP; step${needsPage.length > 1 ? 's' : ''} ${needsPage.join(', ')} use${needsPage.length > 1 ? '' : 's'} the browser. A read step whose request fails is repeated in the browser; a write or delete step is never repeated.`;
}
