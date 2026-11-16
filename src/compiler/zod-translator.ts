/*
 * JSON Schema -> Zod translation.
 *
 * The result is TEXT: a Zod expression that is pasted into the generated
 * mcp-server.ts (and can be evaluated in tests with
 * `new Function('z', 'return ' + source)(z)`).
 *
 * Rule: the Zod schema is never silently wider than the JSON Schema. A keyword
 * Zod cannot express is ignored for that fragment only, and the generated
 * source carries the comment `// AJV remains the authority: <keyword>`. The
 * server validates the same payload with AJV before replaying, so AJV makes the
 * final decision for those keywords.
 */

type Schema = Record<string, unknown>;

/** A keyword left to AJV, with the place of the schema it was found in. */
export interface AjvAuthorityNote {
  keyword: string;
  path: string;
}

export interface ZodTranslation {
  /** Zod expression, possibly spanning several lines when it carries `//` comments. */
  source: string;
  /** Keywords Zod does not enforce. */
  ajvAuthority: AjvAuthorityNote[];
}

/** A translated fragment. `undef` is true when the fragment accepts `undefined` (a missing key). */
interface Node {
  src: string;
  undef: boolean;
}

const ANNOTATIONS = [
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  '$defs', 'definitions',
];
const STRING_KEYWORDS = ['minLength', 'maxLength', 'pattern', 'format'];
const NUMBER_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const ARRAY_KEYWORDS = ['items', 'minItems', 'maxItems', 'uniqueItems'];
const OBJECT_KEYWORDS = ['properties', 'required', 'additionalProperties'];
const TYPED_KEYWORDS = [...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS, ...OBJECT_KEYWORDS];
const KNOWN = [...ANNOTATIONS, ...TYPED_KEYWORDS, 'type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf'];
const ALL_TYPES = ['string', 'number', 'boolean', 'null', 'array', 'object'];

type Primitive = string | number | boolean | null;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function matchesType(value: Primitive, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/** oneOf can be a plain union when no value can match two branches (same condition as the PBT converter). */
function branchesAreExclusive(branches: unknown[]): boolean {
  if (!branches.every(isSchema)) return false;
  if (branches.every((b) => typeof b['type'] === 'string')) {
    const types = branches.map((b) => b['type'] as string);
    const kinds = new Set(types);
    return kinds.size === types.length && !(kinds.has('integer') && kinds.has('number'));
  }
  if (branches.every((b) => b['const'] !== undefined)) {
    const values = branches.map((b) => JSON.stringify(b['const']));
    return new Set(values).size === values.length;
  }
  return false;
}

// Deep-equality key: object keys sorted, so {a:1,b:2} and {b:2,a:1} are the same item
const UNIQUE_ITEMS_CHECK =
  '(a) => { const c = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ' +
  '? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x); ' +
  'return new Set(a.map(c)).size === a.length; }';

// The uuid and email checks of ajv-formats (default "full" mode), as source: Zod's own
// email, uuid and datetime checks accept and reject different strings than AJV does
const AJV_UUID_REGEX = String.raw`/^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i`;
const AJV_EMAIL_REGEX =
  String.raw`/^[a-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_\`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i`;
// RFC 3339 date-time as ajv-formats validates it: date and time split on "t", "T" or whitespace,
// real calendar dates, a mandatory time zone, leap seconds only at 23:59:60 UTC
const AJV_DATE_TIME_CHECK = [
  '(s) => { const p = s.split(/t|\\s/i); if (p.length !== 2) return false;',
  String.raw`const d = /^(\d\d\d\d)-(\d\d)-(\d\d)$/.exec(p[0]); if (!d) return false;`,
  'const y = +d[1], m = +d[2], day = +d[3];',
  'if (!(m >= 1 && m <= 12 && day >= 1 && day <= (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]))) return false;',
  String.raw`const t = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i.exec(p[1]); if (!t) return false;`,
  'const hr = +t[1], min = +t[2], sec = +t[3], sign = t[5] === "-" ? -1 : 1, tzH = +(t[6] || 0), tzM = +(t[7] || 0);',
  'if (tzH > 23 || tzM > 59 || !t[4]) return false;',
  'if (hr <= 23 && min <= 59 && sec < 60) return true;',
  'const um = min - tzM * sign; const uh = hr - tzH * sign - (um < 0 ? 1 : 0);',
  'return (uh === 23 || uh === -1) && (um === 59 || um === -1) && sec < 61; }',
].join(' ');

class Translator {
  readonly notes: AjvAuthorityNote[] = [];

  /** Comment to append to a fragment for a keyword that is left to AJV. */
  private authority(keyword: string, path: string): string {
    this.notes.push({ keyword, path });
    const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
    return ` // AJV remains the authority: ${clean(keyword)} (at ${clean(path)})\n`;
  }

  /** A fragment whose whole schema node cannot be expressed. */
  private fallback(keyword: string, path: string): Node {
    return { src: `z.unknown()${this.authority(keyword, path)}`, undef: true };
  }

  translate(schema: unknown, path: string, withDescribe = true): Node {
    const node = this.translateBody(schema, path);
    if (withDescribe && isSchema(schema) && typeof schema['description'] === 'string') {
      return { ...node, src: `${node.src}.describe(${JSON.stringify(schema['description'])})` };
    }
    return node;
  }

  /** A property of an object: `.optional()` unless required, then `.describe()`. */
  property(schema: unknown, path: string, required: boolean): string {
    return this.propertyNode(schema, path, required).src;
  }

  /** Like `property`; `undef` tells whether the body accepted a missing value before the presence check. */
  private propertyNode(schema: unknown, path: string, required: boolean): { src: string; undef: boolean } {
    let { src, undef } = this.translate(schema, path, false);
    if (required) {
      if (undef) {
        // A required key must be present: z.unknown() alone would accept a missing key
        src += '.refine((v) => v !== undefined)';
      }
    } else {
      src += '.optional()';
    }
    if (isSchema(schema) && typeof schema['description'] === 'string') {
      src += `.describe(${JSON.stringify(schema['description'])})`;
    }
    return { src, undef };
  }

  private translateBody(schema: unknown, path: string): Node {
    if (schema === true) return { src: 'z.unknown()', undef: true };
    if (schema === false) return { src: 'z.never()', undef: false };
    if (!isSchema(schema)) return this.fallback('schema', path);

    let extras = '';
    for (const keyword of Object.keys(schema)) {
      if (!KNOWN.includes(keyword)) extras += this.authority(keyword, path);
    }

    const declared = schema['type'];
    const declaredTypes: string[] | undefined =
      typeof declared === 'string' ? [declared] : Array.isArray(declared) ? (declared as string[]) : undefined;
    const typedKeywordPresent = TYPED_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
    const hasValueSet = schema['const'] !== undefined || schema['enum'] !== undefined;

    const parts: Node[] = [];

    if (schema['const'] !== undefined) {
      parts.push(this.constNode(schema['const'], declaredTypes, path));
    }
    if (schema['enum'] !== undefined) {
      parts.push(this.enumNode(schema['enum'], declaredTypes, path));
    }
    if (Array.isArray(schema['anyOf'])) {
      parts.push(this.unionNode(schema['anyOf'], `${path}/anyOf`));
    }
    if (Array.isArray(schema['oneOf'])) {
      const node = this.unionNode(schema['oneOf'], `${path}/oneOf`);
      if (!branchesAreExclusive(schema['oneOf'])) {
        node.src += this.authority('oneOf exclusivity', path);
      }
      parts.push(node);
    }
    if (Array.isArray(schema['allOf'])) {
      schema['allOf'].forEach((branch, index) => parts.push(this.translate(branch, `${path}/allOf/${index}`)));
    }

    // With an enum or a const, the declared type only filtered the members (done above)
    if ((declaredTypes !== undefined || typedKeywordPresent) && !(hasValueSet && !typedKeywordPresent)) {
      parts.push(this.typeNode(schema, declaredTypes ?? ALL_TYPES, path));
    }

    let node: Node;
    if (parts.length === 0) {
      node = { src: 'z.unknown()', undef: true };
    } else {
      node = parts.reduce((left, right) => ({
        src: `z.intersection(${left.src}, ${right.src})`,
        undef: left.undef && right.undef,
      }));
    }
    return { src: node.src + extras, undef: node.undef };
  }

  private constNode(value: unknown, types: string[] | undefined, path: string): Node {
    if (!isPrimitive(value)) return this.fallback('const', path);
    if (types !== undefined && !types.some((t) => matchesType(value, t) || (t === 'number' && matchesType(value, 'integer')))) {
      return { src: 'z.never()', undef: false };
    }
    return { src: `z.literal(${JSON.stringify(value)})`, undef: false };
  }

  private enumNode(values: unknown, types: string[] | undefined, path: string): Node {
    if (!Array.isArray(values) || !values.every(isPrimitive)) return this.fallback('enum', path);
    const members = (values as Primitive[]).filter(
      (value) => types === undefined || types.some((t) => matchesType(value, t) || (t === 'number' && matchesType(value, 'integer')))
    );
    if (members.length === 0) return { src: 'z.never()', undef: false };
    if (members.every((member) => typeof member === 'string')) {
      if (members.length === 1) return { src: `z.literal(${JSON.stringify(members[0])})`, undef: false };
      return { src: `z.enum([${members.map((m) => JSON.stringify(m)).join(', ')}])`, undef: false };
    }
    return this.unionOf(members.map((m) => `z.literal(${JSON.stringify(m)})`));
  }

  private unionNode(branches: unknown[], path: string): Node {
    const nodes = branches.map((branch, index) => this.translate(branch, `${path}/${index}`));
    if (nodes.length === 0) return { src: 'z.never()', undef: false };
    if (nodes.length === 1) return nodes[0];
    return { src: `z.union([${nodes.map((n) => n.src).join(', ')}])`, undef: nodes.some((n) => n.undef) };
  }

  private unionOf(sources: string[]): Node {
    return { src: sources.length === 1 ? sources[0] : `z.union([${sources.join(', ')}])`, undef: false };
  }

  /** The part of a schema that depends on the JSON type, for a list of allowed types. */
  private typeNode(schema: Schema, declared: string[], path: string): Node {
    // integer is a kind of number: with both, number alone describes the set
    const types = [...new Set(declared)].filter((t) => !(t === 'integer' && declared.includes('number')));
    if (types.length === 0) return { src: 'z.never()', undef: false };
    const nodes = types.map((type) => {
      switch (type) {
        case 'string': return this.stringNode(schema, path);
        case 'number': return this.numberNode(schema, false, path);
        case 'integer': return this.numberNode(schema, true, path);
        case 'boolean': return 'z.boolean()';
        case 'null': return 'z.null()';
        case 'array': return this.arrayNode(schema, path);
        case 'object': return this.objectNode(schema, path);
        default: return `z.unknown()${this.authority(`type ${JSON.stringify(type)}`, path)}`;
      }
    });
    return { src: nodes.length === 1 ? nodes[0] : `z.union([${nodes.join(', ')}])`, undef: false };
  }

  /** Append `.method(n)` for a numeric keyword, or leave a comment when its value is not a number. */
  private numeric(schema: Schema, keyword: string, method: string, path: string): string {
    const value = schema[keyword];
    if (value === undefined) return '';
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.authority(keyword, path);
    return `.${method}(${JSON.stringify(value)})`;
  }

  /** Refine on the number of code points, or leave a comment when the value is not a number. */
  private length(schema: Schema, keyword: string, operator: '>=' | '<=', path: string): string {
    const value = schema[keyword];
    if (value === undefined) return '';
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.authority(keyword, path);
    return `.refine((s) => [...s].length ${operator} ${JSON.stringify(value)})`;
  }

  private stringNode(schema: Schema, path: string): string {
    let src = 'z.string()';
    const format = schema['format'];
    if (format === 'email') src += `.regex(${AJV_EMAIL_REGEX})`;
    else if (format === 'uuid') src += `.regex(${AJV_UUID_REGEX})`; // the regex of ajv-formats (also accepts a urn:uuid: prefix); z.uuid() checks version and variant
    else if (format === 'date-time') src += `.refine(${AJV_DATE_TIME_CHECK})`;
    else if (format !== undefined) src += this.authority(`format ${JSON.stringify(format)}`, path);

    // JSON Schema counts code points; Zod's .min()/.max() count UTF-16 units
    src += this.length(schema, 'minLength', '>=', path);
    src += this.length(schema, 'maxLength', '<=', path);

    const pattern = schema['pattern'];
    if (typeof pattern === 'string') {
      src += `.regex(new RegExp(${JSON.stringify(pattern)}, "u"))`;
    } else if (pattern !== undefined) {
      src += this.authority('pattern', path);
    }
    return src;
  }

  private numberNode(schema: Schema, integer: boolean, path: string): string {
    // Not .int(): Zod only accepts safe integers there, JSON Schema accepts every integral number (1e21)
    let src = integer ? 'z.number().refine(Number.isInteger)' : 'z.number()';
    src += this.numeric(schema, 'minimum', 'gte', path);
    src += this.numeric(schema, 'maximum', 'lte', path);
    src += this.numeric(schema, 'exclusiveMinimum', 'gt', path);
    src += this.numeric(schema, 'exclusiveMaximum', 'lt', path);
    src += this.numeric(schema, 'multipleOf', 'multipleOf', path);
    return src;
  }

  private arrayNode(schema: Schema, path: string): string {
    const items = schema['items'];
    let itemSrc: string;
    if (items === undefined) {
      itemSrc = 'z.unknown()';
    } else if (isSchema(items) || typeof items === 'boolean') {
      itemSrc = this.translate(items, `${path}/items`).src;
    } else {
      itemSrc = `z.unknown()${this.authority('items', path)}`;
    }

    let src = `z.array(${itemSrc})`;
    src += this.numeric(schema, 'minItems', 'min', path);
    src += this.numeric(schema, 'maxItems', 'max', path);
    if (schema['uniqueItems'] === true) {
      src += `.refine(${UNIQUE_ITEMS_CHECK})`;
    } else if (schema['uniqueItems'] !== undefined && schema['uniqueItems'] !== false) {
      src += this.authority('uniqueItems', path);
    }
    return src;
  }

  private objectNode(schema: Schema, path: string): string {
    const properties = isSchema(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];

    const fields: string[] = [];
    // Required keys with no schema of their own still have to be present
    const mustBePresent: string[] = [];
    for (const [name, child] of Object.entries(properties)) {
      const isRequired = required.includes(name);
      const src = this.property(child, `${path}/properties/${name}`, isRequired);
      fields.push(`${JSON.stringify(name)}: ${src}`);
    }
    for (const name of required) {
      if (!(name in properties)) mustBePresent.push(name);
    }

    let src = `z.object({ ${fields.join(', ')} })`;
    const additional = schema['additionalProperties'];
    if (additional === false) {
      src += '.strict()';
    } else if (additional === undefined || additional === true) {
      src += '.passthrough()';
    } else {
      src += `.catchall(${this.translate(additional, `${path}/additionalProperties`).src})`;
    }

    if (mustBePresent.length > 0) {
      src += `.refine((o) => ${JSON.stringify(mustBePresent)}.every((k) => Object.prototype.hasOwnProperty.call(o, k)))`;
    }
    return src;
  }
}

/** Translate a JSON Schema into the source of a Zod expression, and list the keywords left to AJV. */
export function translateJsonSchemaToZod(schema: unknown): ZodTranslation {
  const translator = new Translator();
  const { src } = translator.translate(schema, '#');
  return { source: src, ajvAuthority: translator.notes };
}

/** Translate a JSON Schema into the source of a Zod expression (the identifier `z` must be in scope). */
export function jsonSchemaToZodSource(schema: unknown): string {
  return translateJsonSchemaToZod(schema).source;
}

/**
 * Source of one property of a tool's input shape: `.optional()` unless the
 * property is required, then `.describe()`.
 */
export function propertyToZodSource(schema: unknown, required: boolean, path: string): { source: string; ajvAuthority: AjvAuthorityNote[] } {
  const translator = new Translator();
  const source = translator.property(schema, path, required);
  return { source, ajvAuthority: translator.notes };
}
