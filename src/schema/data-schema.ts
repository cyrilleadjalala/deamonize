import { regexGroupNames } from '../replay/runtime/extract.js';
import type { Extractor, ResultZone } from '../types.js';

type Schema = Record<string, unknown>;

const STRING: Schema = { type: 'string' };

/** JSON Schema of a plain JSON value: types only, no `required` (the next call may omit a field). */
export function inferJsonSchema(value: unknown): Schema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const items: Schema[] = [];
    for (const item of value) {
      const schema = inferJsonSchema(item);
      if (!items.some((known) => JSON.stringify(known) === JSON.stringify(schema))) items.push(schema);
    }
    if (items.length === 0) return { type: 'array' };
    return { type: 'array', items: items.length === 1 ? items[0] : { anyOf: items } };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, Schema> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) properties[key] = inferJsonSchema(inner);
      return { type: 'object', properties };
    }
    default:
      return {};
  }
}

function objectOfStrings(names: string[], description: string): Schema {
  return {
    type: 'object',
    description,
    properties: Object.fromEntries(names.map((name) => [name, STRING])),
    additionalProperties: STRING,
  };
}

function keysOf(rows: unknown[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row !== null && typeof row === 'object') {
      for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * JSON Schema of the `data` a Result_Zone returns, from its extractor and, when known, a sample read
 * while recording: table is an array of objects with the header names as string properties, list an
 * array of strings, fields an object of strings, text and attribute a string, regex an object (or an
 * array of objects with `g`) whose properties are the named groups, json the structure of the sample.
 */
export function dataSchemaFor(extractor: Extractor | undefined, sample?: unknown): Schema {
  const kind = extractor?.kind ?? 'text';
  switch (kind) {
    case 'text':
      return { type: 'string', description: 'Text of the result zone' };
    case 'attribute':
      return { type: 'string', description: 'Value read from the result zone' };
    case 'list':
      return { type: 'array', description: 'Items of the list in the result zone', items: STRING };
    case 'table': {
      const names = Array.isArray(sample) ? keysOf(sample) : [];
      return {
        type: 'array',
        description: 'Rows of the table in the result zone, each an object keyed by the column headers',
        items: objectOfStrings(names, 'One row'),
      };
    }
    case 'fields': {
      const names = sample !== null && typeof sample === 'object' && !Array.isArray(sample) ? Object.keys(sample) : [];
      return objectOfStrings(names, 'Label and value pairs of the result zone');
    }
    case 'regex': {
      const regex = extractor as Extract<Extractor, { kind: 'regex' }>;
      const names = regexGroupNames(regex.pattern);
      const one = objectOfStrings(names.length > 0 ? names : ['match'], 'Named groups captured by the pattern');
      return (regex.flags ?? '').includes('g') ? { type: 'array', description: 'One object per match of the pattern', items: one } : one;
    }
    case 'json':
      return sample === undefined
        ? { description: 'JSON parsed from the text of the result zone' }
        : { ...inferJsonSchema(sample), description: 'JSON parsed from the text of the result zone' };
  }
}

/** The schema of `data` for a zone: the one stored with it, else the one its extractor implies. */
export function zoneDataSchema(zone: ResultZone): Schema {
  return zone.schema ?? dataSchemaFor(zone.extractor);
}
