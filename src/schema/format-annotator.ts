/**
 * FormatAnnotator: examines observed string values per field and annotates the JSON Schema
 * with the `format` keyword when ≥ 80% of non-null observations match a known pattern.
 *
 * Requirements: 4.4
 */

import type { JsonSchema } from './schema-accumulator.js';

type FormatType = 'email' | 'date-time' | 'uuid';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORMAT_PATTERNS: Array<{ format: FormatType; regex: RegExp }> = [
  { format: 'uuid', regex: UUID_REGEX },
  { format: 'date-time', regex: DATETIME_REGEX },
  { format: 'email', regex: EMAIL_REGEX },
];

const THRESHOLD = 0.8;

export class FormatAnnotator {
  /**
   * Annotate string fields in the schema with `format` keywords based on observed values.
   *
   * @param schema - The JSON Schema to annotate (mutates in place and returns)
   * @param observations - Array of observed payloads for this Transition
   * @returns The annotated schema
   */
  annotate(schema: JsonSchema, observations: Record<string, unknown>[]): JsonSchema {
    this._annotateObject(schema, observations, []);
    return schema;
  }

  /**
   * Recursively annotate an object schema's string properties.
   *
   * @param schema - The object schema to annotate
   * @param observations - Observed payloads at the current nesting level
   * @param _path - Unused path parameter (kept for potential future use)
   */
  private _annotateObject(
    schema: JsonSchema,
    observations: Record<string, unknown>[],
    _path: string[]
  ): void {
    const properties = schema['properties'];
    if (!properties || typeof properties !== 'object') {
      return;
    }

    const props = properties as Record<string, JsonSchema>;

    for (const [fieldName, fieldSchema] of Object.entries(props)) {
      // The string schema of the field: the field itself, or the string branch of
      // its alternatives (a field that is sometimes null is `anyOf: [string, null]`)
      const stringSchemas = [fieldSchema, ...((fieldSchema['anyOf'] as JsonSchema[] | undefined) ?? [])].filter(
        (candidate) => candidate['type'] === 'string' && !('format' in candidate)
      );

      if (stringSchemas.length > 0) {
        // Collect non-null observed values for this field
        const values: string[] = [];
        for (const obs of observations) {
          const val = obs[fieldName];
          if (val !== null && val !== undefined && typeof val === 'string') {
            values.push(val);
          }
        }

        const format = this._detectFormat(values);
        if (format !== undefined) {
          for (const stringSchema of stringSchemas) {
            stringSchema['format'] = format;
          }
        }
      } else if (fieldSchema['type'] === 'object') {
        // Recursively collect nested observations for this field
        const nestedObservations: Record<string, unknown>[] = [];
        for (const obs of observations) {
          const val = obs[fieldName];
          if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
            nestedObservations.push(val as Record<string, unknown>);
          }
        }
        this._annotateObject(fieldSchema, nestedObservations, [..._path, fieldName]);
      }
    }
  }

  /** The first format (uuid > date-time > email) that at least 80% of the values match. */
  private _detectFormat(values: string[]): FormatType | undefined {
    if (values.length === 0) {
      return undefined;
    }
    for (const { format, regex } of FORMAT_PATTERNS) {
      const matchCount = values.filter((v) => regex.test(v)).length;
      if (matchCount / values.length >= THRESHOLD) {
        return format;
      }
    }
    return undefined;
  }
}
