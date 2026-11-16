import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { jsonSchemaToZodSource, translateJsonSchemaToZod } from '../../src/compiler/zod-translator.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { removeDir } from '../helpers/cleanup.js';
import type { WorkflowSet } from '../../src/types.js';

/** Evaluate the generated source against the real zod package, as the generated server does. */
function build(schema: unknown): z.ZodType {
  const source = jsonSchemaToZodSource(schema);
  return new Function('z', 'return ' + source)(z) as z.ZodType;
}

const accepts = (schema: unknown, value: unknown): boolean => build(schema).safeParse(value).success;

describe('JSON Schema to Zod translation', () => {
  describe('strings', () => {
    it('type string', () => {
      expect(accepts({ type: 'string' }, 'a')).toBe(true);
      expect(accepts({ type: 'string' }, 1)).toBe(false);
    });

    it('minLength and maxLength', () => {
      const schema = { type: 'string', minLength: 2, maxLength: 3 };
      expect(accepts(schema, 'ab')).toBe(true);
      expect(accepts(schema, 'a')).toBe(false);
      expect(accepts(schema, 'abcd')).toBe(false);
    });

    it('pattern', () => {
      const schema = { type: 'string', pattern: '^[a-z]+\\d$' };
      expect(accepts(schema, 'abc1')).toBe(true);
      expect(accepts(schema, 'ABC1')).toBe(false);
    });

    it('patterns with special characters, quotes and backslashes', () => {
      const schema = { type: 'string', pattern: '^"q"\\\\[\\.]\\/\\n$' };
      expect(accepts(schema, '"q"\\./\n')).toBe(true);
      expect(accepts(schema, '"q"\\./')).toBe(false);
    });

    it('format email', () => {
      expect(accepts({ type: 'string', format: 'email' }, 'a@example.com')).toBe(true);
      expect(accepts({ type: 'string', format: 'email' }, 'nope')).toBe(false);
    });

    it('format uuid', () => {
      expect(accepts({ type: 'string', format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(accepts({ type: 'string', format: 'uuid' }, 'nope')).toBe(false);
    });

    it('format date-time', () => {
      expect(accepts({ type: 'string', format: 'date-time' }, '2024-01-02T03:04:05Z')).toBe(true);
      expect(accepts({ type: 'string', format: 'date-time' }, '2024-01-02T03:04:05+02:00')).toBe(true);
      expect(accepts({ type: 'string', format: 'date-time' }, '2024-01-02')).toBe(false);
    });

    it('leaves another format to AJV with a comment', () => {
      const { source, ajvAuthority } = translateJsonSchemaToZod({ type: 'string', format: 'uri' });
      expect(source).toContain('// AJV remains the authority: format "uri"');
      expect(ajvAuthority.map((note) => note.keyword)).toEqual(['format "uri"']);
    });
  });

  describe('numbers', () => {
    it('integer', () => {
      expect(accepts({ type: 'integer' }, 3)).toBe(true);
      expect(accepts({ type: 'integer' }, 3.5)).toBe(false);
    });

    it('number', () => {
      expect(accepts({ type: 'number' }, 3.5)).toBe(true);
      expect(accepts({ type: 'number' }, '3')).toBe(false);
    });

    it('minimum and maximum are inclusive', () => {
      const schema = { type: 'number', minimum: 1, maximum: 3 };
      expect(accepts(schema, 1)).toBe(true);
      expect(accepts(schema, 3)).toBe(true);
      expect(accepts(schema, 0.5)).toBe(false);
      expect(accepts(schema, 3.5)).toBe(false);
    });

    it('exclusiveMinimum and exclusiveMaximum', () => {
      const schema = { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 3 };
      expect(accepts(schema, 2)).toBe(true);
      expect(accepts(schema, 1)).toBe(false);
      expect(accepts(schema, 3)).toBe(false);
    });

    it('multipleOf', () => {
      expect(accepts({ type: 'integer', multipleOf: 5 }, 10)).toBe(true);
      expect(accepts({ type: 'integer', multipleOf: 5 }, 11)).toBe(false);
    });
  });

  it('boolean', () => {
    expect(accepts({ type: 'boolean' }, false)).toBe(true);
    expect(accepts({ type: 'boolean' }, 'false')).toBe(false);
  });

  it('null', () => {
    expect(accepts({ type: 'null' }, null)).toBe(true);
    expect(accepts({ type: 'null' }, 0)).toBe(false);
  });

  describe('enum and const', () => {
    it('string enum', () => {
      const schema = { enum: ['red', 'green'] };
      expect(accepts(schema, 'red')).toBe(true);
      expect(accepts(schema, 'blue')).toBe(false);
    });

    it('mixed enum', () => {
      const schema = { enum: ['a', 1, null, true] };
      for (const value of ['a', 1, null, true]) expect(accepts(schema, value)).toBe(true);
      expect(accepts(schema, 'b')).toBe(false);
      expect(accepts(schema, 2)).toBe(false);
      expect(accepts(schema, false)).toBe(false);
    });

    it('enum values with quotes, backslashes and newlines', () => {
      const values = ['say "hi"', 'back\\slash', 'line\nbreak', '\u2028'];
      const schema = { type: 'string', enum: values };
      for (const value of values) expect(accepts(schema, value)).toBe(true);
      expect(accepts(schema, 'say hi')).toBe(false);
    });

    it('const', () => {
      expect(accepts({ const: 'x' }, 'x')).toBe(true);
      expect(accepts({ const: 'x' }, 'y')).toBe(false);
      expect(accepts({ const: 7 }, 7)).toBe(true);
      expect(accepts({ const: null }, null)).toBe(true);
      expect(accepts({ const: null }, 0)).toBe(false);
    });

    it('enum next to a type drops the members of another type', () => {
      const schema = { type: 'string', enum: ['a', 1] };
      expect(accepts(schema, 'a')).toBe(true);
      expect(accepts(schema, 1)).toBe(false);
    });
  });

  describe('arrays', () => {
    it('items', () => {
      const schema = { type: 'array', items: { type: 'integer' } };
      expect(accepts(schema, [1, 2])).toBe(true);
      expect(accepts(schema, [1, 'a'])).toBe(false);
      expect(accepts(schema, 'a')).toBe(false);
    });

    it('minItems and maxItems', () => {
      const schema = { type: 'array', minItems: 1, maxItems: 2 };
      expect(accepts(schema, [1])).toBe(true);
      expect(accepts(schema, [])).toBe(false);
      expect(accepts(schema, [1, 2, 3])).toBe(false);
    });

    it('uniqueItems compares objects regardless of key order', () => {
      const schema = { type: 'array', uniqueItems: true };
      expect(accepts(schema, [1, 2, { a: 1, b: 2 }])).toBe(true);
      expect(accepts(schema, [1, 1])).toBe(false);
      expect(accepts(schema, [{ a: 1, b: 2 }, { b: 2, a: 1 }])).toBe(false);
    });
  });

  describe('objects', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    };

    it('properties and required', () => {
      expect(accepts(schema, { name: 'Ada' })).toBe(true);
      expect(accepts(schema, { name: 'Ada', age: 3 })).toBe(true);
      expect(accepts(schema, { age: 3 })).toBe(false);
      expect(accepts(schema, { name: 'Ada', age: 'x' })).toBe(false);
      expect(accepts(schema, [])).toBe(false);
      expect(accepts(schema, null)).toBe(false);
    });

    it('additionalProperties absent or true allows extra fields', () => {
      expect(accepts(schema, { name: 'Ada', extra: 1 })).toBe(true);
      expect(accepts({ ...schema, additionalProperties: true }, { name: 'Ada', extra: 1 })).toBe(true);
    });

    it('additionalProperties false rejects extra fields', () => {
      expect(accepts({ ...schema, additionalProperties: false }, { name: 'Ada', extra: 1 })).toBe(false);
      expect(accepts({ ...schema, additionalProperties: false }, { name: 'Ada' })).toBe(true);
    });

    it('additionalProperties schema validates extra fields', () => {
      const typed = { ...schema, additionalProperties: { type: 'number' } };
      expect(accepts(typed, { name: 'Ada', extra: 1 })).toBe(true);
      expect(accepts(typed, { name: 'Ada', extra: 'x' })).toBe(false);
    });

    it('a required field without a schema must be present', () => {
      const loose = { type: 'object', required: ['k'] };
      expect(accepts(loose, { k: 1 })).toBe(true);
      expect(accepts(loose, {})).toBe(false);
      const unconstrained = { type: 'object', properties: { k: {} }, required: ['k'] };
      expect(accepts(unconstrained, { k: null })).toBe(true);
      expect(accepts(unconstrained, {})).toBe(false);
    });

    it('nested objects and arrays', () => {
      const nested = {
        type: 'object',
        properties: {
          customer: {
            type: 'object',
            properties: {
              emails: { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1 },
              address: { type: 'object', properties: { zip: { type: 'string', pattern: '^\\d{5}$' } }, required: ['zip'] },
            },
            required: ['emails'],
          },
        },
        required: ['customer'],
      };
      expect(accepts(nested, { customer: { emails: ['a@b.co'], address: { zip: '12345' } } })).toBe(true);
      expect(accepts(nested, { customer: { emails: [] } })).toBe(false);
      expect(accepts(nested, { customer: { emails: ['bad'] } })).toBe(false);
      expect(accepts(nested, { customer: { emails: ['a@b.co'], address: { zip: 'abc' } } })).toBe(false);
      expect(accepts(nested, {})).toBe(false);
    });
  });

  describe('combinators', () => {
    it('anyOf', () => {
      const schema = { anyOf: [{ type: 'string', minLength: 3 }, { type: 'integer' }] };
      expect(accepts(schema, 'abc')).toBe(true);
      expect(accepts(schema, 4)).toBe(true);
      expect(accepts(schema, 'ab')).toBe(false);
      expect(accepts(schema, 4.5)).toBe(false);
    });

    it('oneOf with exclusive branches is a plain union', () => {
      const translation = translateJsonSchemaToZod({ oneOf: [{ type: 'string' }, { type: 'boolean' }] });
      expect(translation.ajvAuthority).toEqual([]);
      const schema = { oneOf: [{ type: 'string' }, { type: 'boolean' }] };
      expect(accepts(schema, 'a')).toBe(true);
      expect(accepts(schema, 1)).toBe(false);
    });

    it('oneOf with overlapping branches says AJV enforces the exclusivity', () => {
      const { source } = translateJsonSchemaToZod({ oneOf: [{ type: 'string' }, { minLength: 1 }] });
      expect(source).toContain('// AJV remains the authority: oneOf exclusivity');
    });

    it('type lists', () => {
      const schema = { type: ['string', 'null'], minLength: 2 };
      expect(accepts(schema, null)).toBe(true);
      expect(accepts(schema, 'ab')).toBe(true);
      expect(accepts(schema, 'a')).toBe(false);
      expect(accepts(schema, 3)).toBe(false);
    });

    it('allOf is an intersection', () => {
      const schema = { allOf: [{ type: 'string' }, { minLength: 2 }] };
      expect(accepts(schema, 'ab')).toBe(true);
      expect(accepts(schema, 'a')).toBe(false);
    });
  });

  describe('keywords left to AJV', () => {
    it('emits z.unknown() only for the fragment, with a comment', () => {
      const schema = {
        type: 'object',
        properties: { a: { $ref: '#/$defs/x' }, b: { type: 'string' } },
        required: ['b'],
      };
      const { source, ajvAuthority } = translateJsonSchemaToZod(schema);
      expect(source).toContain('"a": z.unknown() // AJV remains the authority: $ref');
      expect(source).toContain('"b": z.string()');
      expect(ajvAuthority).toEqual([{ keyword: '$ref', path: '#/properties/a' }]);
      expect(accepts(schema, { b: 'x', a: 5 })).toBe(true);
      expect(accepts(schema, { a: 5 })).toBe(false);
    });

    it('stays valid source when the comment is followed by .optional() and .describe()', () => {
      const schema = { type: 'object', properties: { a: { not: { type: 'string' }, description: 'x' } } };
      expect(accepts(schema, { a: 1 })).toBe(true);
      expect(accepts(schema, {})).toBe(true);
    });

    it('a comment cannot be broken out of by a newline in a keyword', () => {
      const schema = { 'x\nz.never()': 1 };
      expect(accepts(schema, 'anything')).toBe(true);
    });
  });

  describe('equivalence with AJV on edge cases (Property 10 regressions)', () => {
    it('counts string length in code points, as JSON Schema does', () => {
      const schema = { type: 'string', minLength: 1, maxLength: 1 };
      expect(accepts(schema, '\u{1F600}')).toBe(true);
      expect(accepts({ type: 'string', minLength: 2 }, '\u{1F600}')).toBe(false);
    });
    it('accepts integral numbers beyond the safe integer range', () => {
      expect(accepts({ type: 'integer' }, 1e21)).toBe(true);
      expect(accepts({ type: 'integer' }, 2 ** 53 + 2)).toBe(true);
      expect(accepts({ type: 'integer' }, 1.5)).toBe(false);
    });
    it('uuid format follows ajv-formats (urn prefix, any version)', () => {
      const schema = { type: 'string', format: 'uuid' };
      expect(accepts(schema, 'urn:uuid:123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(accepts(schema, '00000000-0000-0000-0000-000000000000')).toBe(true);
    });
    it('date-time format follows ajv-formats (space separator, real dates, time zone required)', () => {
      const schema = { type: 'string', format: 'date-time' };
      expect(accepts(schema, '2024-01-02 03:04:05Z')).toBe(true);
      expect(accepts(schema, '2024-02-30T03:04:05Z')).toBe(false);
      expect(accepts(schema, '2024-01-02T03:04:05')).toBe(false);
      expect(accepts(schema, '2016-12-31T23:59:60Z')).toBe(true);
    });
  });

  describe('description', () => {
    it('escapes quotes, backslashes and newlines', () => {
      const description = 'He said "hi"\\ \n next line\r\n and \u2028 sep `tick` ${x}';
      const schema = build({ type: 'string', description });
      expect(schema.description).toBe(description);
    });

    it('describes optional properties', () => {
      const schema = build({ type: 'object', properties: { a: { type: 'string', description: 'The "a"' } } });
      expect((schema as z.ZodObject<z.ZodRawShape>).shape['a'].description).toBe('The "a"');
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('keeps required properties required', () => {
      const required = build({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
      expect(required.safeParse({}).success).toBe(false);
    });
  });

  describe('generated mcp-server.ts', () => {
    const workspaceRoot = resolve(import.meta.dirname, '../..');
    let dir: string;

    const sample: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Zod Sample',
      startUrl: 'http://localhost:8080/',
      workflows: [
        {
          id: 'e1111111-1111-4111-8111-111111111111',
          label: 'Create order',
          steps: [{ actionType: 'click', selectors: ['#go'] }],
          variables: [{ name: 'email', description: 'Mail of "the" customer\nsecond line' }],
          observedPayloads: [{ email: 'a@example.com' }],
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email', description: 'Mail of "the" customer\nsecond line' },
              code: { type: 'string', pattern: '^[A-Z]{2}\\d+$', maxLength: 10 },
              qty: { type: 'integer', minimum: 1, maximum: 9 },
              tags: { type: 'array', items: { enum: ['a', 'b'] }, uniqueItems: true },
              other: { not: { type: 'string' } },
            },
            required: ['email', 'qty'],
          },
        },
      ],
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'daemonize-zod-'));
      const log = console.log;
      console.log = () => { };
      try {
        await new Compiler().compile(sample, dir);
      } finally {
        console.log = log;
      }
      await symlink(join(workspaceRoot, 'node_modules'), join(dir, 'node_modules'), 'junction');
    }, 60000);

    afterAll(async () => {
      if (dir) await removeDir(dir);
    });

    it('contains the translated schema and the AJV comment', async () => {
      const source = await readFile(join(dir, 'mcp-server.ts'), 'utf-8');
      expect(source).toContain('"qty": z.number().refine(Number.isInteger).gte(1).lte(9),');
      expect(source).toContain('.regex(new RegExp("^[A-Z]{2}\\\\d+$", "u"))');
      expect(source).toContain('// AJV remains the authority: not');
      expect(source).toContain('.describe("Mail of \\"the\\" customer\\nsecond line")');
    });

    it('is syntactically valid JavaScript', () => {
      expect(() => execFileSync(process.execPath, ['--check', join(dir, 'mcp-server.js')], { stdio: 'pipe' })).not.toThrow();
    });

    it('type-checks the translated shape against the zod package', async () => {
      const tsc = join(workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
      const output = (() => {
        try {
          execFileSync(
            process.execPath,
            [tsc, '--noEmit', '--skipLibCheck', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', join(dir, 'mcp-server.ts')],
            { stdio: 'pipe', cwd: dir }
          );
          return '';
        } catch (error) {
          return String((error as { stdout?: Buffer }).stdout ?? error);
        }
      })();
      // Only errors about the translated schema matter here
      expect(output).not.toMatch(/mcp-server\.ts.*(z\.|zod|Zod)/);
    }, 120000);
  });
});
