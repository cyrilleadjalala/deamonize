/**
 * SchemaAccumulator: collects observed payloads for a Transition and derives/widens a JSON Schema.
 *
 * Requirements: 4.1, 4.3
 */

export type JsonSchema = Record<string, unknown>;

/**
 * Derive a minimal JSON Schema from a single value.
 */
export function inferType(value: unknown): JsonSchema {
  if (value === null) {
    return { type: 'null' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { type: 'integer' };
    }
    return { type: 'number' };
  }
  if (typeof value === 'string') {
    return { type: 'string' };
  }
  if (Array.isArray(value)) {
    return { type: 'array', items: {} };
  }
  if (typeof value === 'object') {
    // Object: recursively derive properties
    const obj = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      properties[k] = inferType(v);
      required.push(k);
    }
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: true,
    };
  }
  // Fallback for undefined, functions, symbols, etc.
  return {};
}

/**
 * Widen schema1 to also accept schema2.
 * Returns a new schema that accepts both.
 *
 * Rules:
 * - Both are object schemas: merge properties, adjust required, recurse into shared fields
 * - integer + number → number
 * - Conflicting primitive types → anyOf (deduplicated)
 * - anyOf present in either → merge and deduplicate all branches
 */
export function widenSchemas(schema1: JsonSchema, schema2: JsonSchema): JsonSchema {
  const type1 = schema1['type'];
  const type2 = schema2['type'];

  // Both are object types: merge recursively
  if (type1 === 'object' && type2 === 'object') {
    return mergeObjectSchemas(schema1, schema2);
  }

  // integer widens to number
  if (
    (type1 === 'integer' && type2 === 'number') ||
    (type1 === 'number' && type2 === 'integer')
  ) {
    return { type: 'number' };
  }

  // Same type: return schema1 (they are compatible)
  if (type1 !== undefined && type1 === type2) {
    return { ...schema1 };
  }

  // Handle anyOf in either schema
  const branches1 = getAnyOfBranches(schema1);
  const branches2 = getAnyOfBranches(schema2);

  if (branches1.length > 0 || branches2.length > 0) {
    // Collect all branches from both
    const allBranches = [...branches1, ...branches2];
    return deduplicatedAnyOf(allBranches);
  }

  // Conflicting types: emit anyOf
  return deduplicatedAnyOf([schema1, schema2]);
}

/**
 * Extract anyOf branches from a schema: if schema has anyOf, return those branches;
 * otherwise return [schema].
 */
function getAnyOfBranches(schema: JsonSchema): JsonSchema[] {
  if (Array.isArray(schema['anyOf'])) {
    return schema['anyOf'] as JsonSchema[];
  }
  return [schema];
}

/**
 * Merge two object schemas, widening properties and adjusting required.
 */
function mergeObjectSchemas(schema1: JsonSchema, schema2: JsonSchema): JsonSchema {
  const props1 = (schema1['properties'] ?? {}) as Record<string, JsonSchema>;
  const props2 = (schema2['properties'] ?? {}) as Record<string, JsonSchema>;
  const req1 = new Set<string>(
    Array.isArray(schema1['required']) ? (schema1['required'] as string[]) : []
  );
  const req2 = new Set<string>(
    Array.isArray(schema2['required']) ? (schema2['required'] as string[]) : []
  );

  // All keys from both
  const allKeys = new Set([...Object.keys(props1), ...Object.keys(props2)]);

  const mergedProperties: Record<string, JsonSchema> = {};
  const mergedRequired: string[] = [];

  for (const key of allKeys) {
    const inProps1 = key in props1;
    const inProps2 = key in props2;

    if (inProps1 && inProps2) {
      // Recurse: widen the field schema
      mergedProperties[key] = widenSchemas(props1[key], props2[key]);
    } else if (inProps1) {
      mergedProperties[key] = { ...props1[key] };
    } else {
      mergedProperties[key] = { ...props2[key] };
    }

    // Field is required only if it was required in BOTH schemas
    if (req1.has(key) && req2.has(key)) {
      mergedRequired.push(key);
    }
  }

  return {
    type: 'object',
    properties: mergedProperties,
    required: mergedRequired,
    additionalProperties: true,
  };
}

/**
 * Build a deduplicated anyOf schema from a list of branches.
 * Deduplication is by JSON string comparison.
 * If after dedup there is only one branch, return it directly.
 */
function deduplicatedAnyOf(branches: JsonSchema[]): JsonSchema {
  const seen = new Set<string>();
  const unique: JsonSchema[] = [];
  for (const b of branches) {
    const key = JSON.stringify(b);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(b);
    }
  }
  if (unique.length === 1) {
    return unique[0];
  }
  return { anyOf: unique };
}

/**
 * SchemaAccumulator collects observed payloads for a Transition and derives/widens a JSON Schema.
 */
export class SchemaAccumulator {
  private observations: Record<string, unknown>[] = [];

  /**
   * Add an observed payload to the accumulator.
   */
  observe(payload: Record<string, unknown>): void {
    this.observations.push(payload);
  }

  /**
   * Return the widened JSON Schema for all accumulated observations.
   * Returns { type: 'object', properties: {}, required: [], additionalProperties: true }
   * if no observations have been made.
   */
  getSchema(): JsonSchema {
    if (this.observations.length === 0) {
      return {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      };
    }

    // Derive schema for first observation
    let schema = inferType(this.observations[0]) as JsonSchema;

    // Widen with each subsequent observation
    for (let i = 1; i < this.observations.length; i++) {
      const nextSchema = inferType(this.observations[i]) as JsonSchema;
      schema = widenSchemas(schema, nextSchema);
    }

    // Ensure additionalProperties: true on the top-level schema
    if (schema['type'] === 'object' && !('additionalProperties' in schema)) {
      schema = { ...schema, additionalProperties: true };
    }

    return schema;
  }

  /**
   * Number of observations accumulated.
   */
  get count(): number {
    return this.observations.length;
  }
}
