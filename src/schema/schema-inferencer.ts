/**
 * SchemaInferencer: wires SchemaAccumulator, FormatAnnotator, and LabelExtractor together
 * to infer input and output schemas for every Transition in a StateGraph.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type { StateGraph, AnnotatedStateGraph, ScreenContent, WorkflowSet } from '../types.js';
import { SchemaAccumulator } from './schema-accumulator.js';
import { FormatAnnotator } from './format-annotator.js';
import { LabelExtractor } from './label-extractor.js';
import { zoneDataSchema } from './data-schema.js';
import { pickResultZone } from '../replay/runtime/extract.js';

export class SchemaInferencer {
  private formatAnnotator = new FormatAnnotator();
  private labelExtractor = new LabelExtractor();

  /**
   * Infer input and output schemas for all Transitions in the graph.
   * Returns an AnnotatedStateGraph with inputSchema and outputSchema set on each Transition.
   */
  infer(graph: StateGraph): AnnotatedStateGraph {
    // Deep-clone to avoid mutating the input
    const annotated: AnnotatedStateGraph = {
      ...(JSON.parse(JSON.stringify(graph)) as StateGraph),
      targetName: '',
    };

    for (const transition of annotated.transitions) {
      // ── Input schema ────────────────────────────────────────────────────────
      const accumulator = new SchemaAccumulator();
      for (const payload of transition.observedPayloads) {
        accumulator.observe(payload);
      }

      let inputSchema = accumulator.getSchema();
      inputSchema = this.formatAnnotator.annotate(inputSchema, transition.observedPayloads);

      // Apply label descriptions from the source screen
      const sourceScreen = annotated.screens[transition.sourceScreenId];
      if (sourceScreen) {
        const fieldNames = Object.keys(
          (inputSchema['properties'] as Record<string, unknown> | undefined) ?? {}
        );

        if (fieldNames.length > 0) {
          // Build a minimal ScreenContent from Screen fields so LabelExtractor can parse it
          const screenContent: ScreenContent = {
            type: sourceScreen.type,
            raw: sourceScreen.snapshot,
            normalized: sourceScreen.snapshot,
            capturedAt: 0,
          };

          const labels = this.labelExtractor.extractLabels(screenContent, fieldNames);

          const properties = inputSchema['properties'] as Record<string, Record<string, unknown>>;
          for (const [field, description] of labels) {
            if (properties[field] !== undefined) {
              properties[field] = { ...properties[field], description };
            }
          }
        }
      }

      transition.inputSchema = inputSchema;

      // ── Output schema ────────────────────────────────────────────────────────
      const destScreen = annotated.screens[transition.destinationScreenId];
      if (destScreen?.snapshot !== undefined) {
        transition.outputSchema = {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Screen content (DOM or terminal buffer)',
            },
            screenId: {
              type: 'string',
              description: 'Identifier of the resulting screen',
            },
            screenType: {
              type: 'string',
              enum: ['dom', 'terminal'],
            },
          },
          required: ['content', 'screenId', 'screenType'],
        };
      }
    }

    return annotated;
  }

  /**
   * Infer input and output schemas for every Workflow in the set.
   * The input schema is built from the variables the user marked while
   * recording, widened by any observed payloads and annotated with formats.
   */
  inferWorkflows(set: WorkflowSet): WorkflowSet {
    // Deep-clone to avoid mutating the input
    const annotated = JSON.parse(JSON.stringify(set)) as WorkflowSet;

    for (const workflow of annotated.workflows) {
      const accumulator = new SchemaAccumulator();
      for (const payload of workflow.observedPayloads) {
        accumulator.observe(payload);
      }

      const inputSchema = this.formatAnnotator.annotate(
        accumulator.getSchema(),
        workflow.observedPayloads
      );
      const properties = (inputSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set<string>(
        Array.isArray(inputSchema['required']) ? (inputSchema['required'] as string[]) : []
      );

      // Variables marked by the user are authoritative over inferred fields
      for (const variable of workflow.variables) {
        const field: Record<string, unknown> = { ...properties[variable.name] };
        if (variable.type !== undefined) {
          // An explicit type wins over what was inferred from the observations
          delete field['anyOf'];
          field['type'] = variable.type;
        } else if (field['type'] === undefined && field['anyOf'] === undefined) {
          field['type'] = 'string';
        }
        if (variable.description !== undefined) {
          field['description'] = variable.description;
        }
        if (variable.enum !== undefined) {
          delete field['anyOf'];
          field['type'] = 'string';
          field['enum'] = [...variable.enum];
        }
        if (variable.pattern !== undefined || variable.maxLength !== undefined) {
          // Constraints on a text only: a number or a boolean has no pattern
          delete field['anyOf'];
          field['type'] = 'string';
          if (variable.pattern !== undefined) field['pattern'] = variable.pattern;
          if (variable.maxLength !== undefined) field['maxLength'] = variable.maxLength;
        }
        properties[variable.name] = field;
        if (variable.optional) {
          required.delete(variable.name);
        } else {
          required.add(variable.name);
        }
      }

      workflow.inputSchema = {
        ...inputSchema,
        type: 'object',
        properties,
        required: [...required],
      };

      const zone = pickResultZone(workflow);
      workflow.outputSchema = {
        type: 'object',
        properties: {
          screenType: { type: 'string', enum: ['dom', 'terminal'] },
          title: { type: 'string', description: 'Page title (web only)' },
          text: {
            type: 'string',
            description: zone === undefined
              ? 'Visible text of the resulting screen'
              : 'Text of the result zone only (at most 20000 characters)',
          },
          ...(zone === undefined ? {} : { data: zoneDataSchema(zone) }),
          drifted: {
            type: 'boolean',
            description: 'True when the resulting screen differs from the recorded one',
          },
          driftChecked: {
            type: 'boolean',
            description: 'False when the workflow has no recorded final screen, so drifted could not be judged',
          },
        },
        required: ['screenType', 'text', 'drifted', 'driftChecked'],
      };
    }

    return annotated;
  }
}
