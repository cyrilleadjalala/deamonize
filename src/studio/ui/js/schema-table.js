// @ts-check
/** Turns a JSON Schema into flat, readable rows. Pure: no DOM. */

const MAX_DEPTH = 6;
const MAX_ROWS = 300;

/**
 * @typedef {{ path: string, type: string, required: boolean, format: string, constraints: string[], description: string, depth: number }} SchemaRow
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {any} schema */
export function typeOf(schema) {
  if (!isObject(schema)) return 'any';
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (typeof schema.type === 'string') {
    if (schema.type === 'array') return `array of ${isObject(schema.items) ? typeOf(schema.items) : 'any'}`;
    return schema.type;
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) return schema[key].map(typeOf).join(' | ');
  }
  if (Array.isArray(schema.enum)) return 'enum';
  if (isObject(schema.properties)) return 'object';
  return 'any';
}

/** @param {any} schema */
export function constraintsOf(schema) {
  if (!isObject(schema)) return [];
  /** @type {string[]} */
  const out = [];
  if (Array.isArray(schema.enum)) out.push(`one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  if (schema.const !== undefined) out.push(`equals ${JSON.stringify(schema.const)}`);
  const pairs = [
    ['minimum', 'min'], ['maximum', 'max'], ['exclusiveMinimum', '> '], ['exclusiveMaximum', '< '],
    ['minLength', 'min length'], ['maxLength', 'max length'], ['minItems', 'min items'], ['maxItems', 'max items'],
    ['multipleOf', 'multiple of'],
  ];
  for (const [key, label] of pairs) if (typeof schema[key] === 'number') out.push(label.endsWith(' ') ? `${label}${schema[key]}` : `${label} ${schema[key]}`);
  if (typeof schema.pattern === 'string') out.push(`pattern ${schema.pattern}`);
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.additionalProperties === false) out.push('no extra properties');
  if (schema.uniqueItems === true) out.push('unique items');
  return out;
}

/**
 * @param {any} schema
 * @returns {SchemaRow[]}
 */
export function flattenSchema(schema) {
  /** @type {SchemaRow[]} */
  const rows = [];
  const visit = (node, path, required, depth) => {
    if (rows.length >= MAX_ROWS) return;
    if (path !== '') {
      rows.push({
        path,
        type: typeOf(node),
        required,
        format: isObject(node) && typeof node.format === 'string' ? node.format : '',
        constraints: constraintsOf(node),
        description: isObject(node) && typeof node.description === 'string' ? node.description : '',
        depth,
      });
    }
    if (!isObject(node) || depth >= MAX_DEPTH) return;
    if (isObject(node.properties)) {
      const needed = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [name, child] of Object.entries(node.properties)) visit(child, path === '' ? name : `${path}.${name}`, needed.has(name), depth + 1);
    }
    if (node.type === 'array' && isObject(node.items) && (isObject(node.items.properties) || node.items.type === 'array')) {
      visit(node.items, `${path}[]`, false, depth);
    }
  };
  if (!isObject(schema)) return [];
  if (!isObject(schema.properties) && schema.type !== undefined && schema.type !== 'object') {
    visit(schema, '(value)', false, 1);
  } else visit(schema, '', false, 0);
  return rows;
}
