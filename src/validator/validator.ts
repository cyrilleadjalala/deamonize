import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import type { ValidationError } from '../types.js';

// ajv-formats ships as CJS; under NodeNext esModuleInterop the module object
// itself may not carry call signatures in TypeScript's view.
const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;

export class Validator {
  private ajv: Ajv2020;
  private validateFns: Map<string, ValidateFunction>;

  /**
   * Create a Validator and pre-compile all action schemas.
   *
   * @param schemas - Map from actionId to JSON Schema object
   */
  constructor(schemas: Map<string, Record<string, unknown>>) {
    this.ajv = new Ajv2020({ allErrors: true });
    addFormats(this.ajv);

    this.validateFns = new Map();
    for (const [actionId, schema] of schemas) {
      this.validateFns.set(actionId, this.ajv.compile(schema));
    }
  }

  /**
   * Validate a payload against the schema for the given action.
   *
   * @param actionId - The tool name or transition ID
   * @param payload - The JSON payload to validate
   * @returns null if valid, ValidationError if invalid
   */
  validate(actionId: string, payload: unknown): ValidationError | null {
    try {
      const validateFn = this.validateFns.get(actionId);

      // No schema registered for this action — accept it
      if (validateFn === undefined) {
        return null;
      }

      const valid = validateFn(payload);

      if (valid) {
        return null;
      }

      const errors = (validateFn.errors ?? []).map((err) => ({
        instancePath: err.instancePath ?? '',
        schemaPath: err.schemaPath ?? '',
        message: err.message ?? 'Validation error',
      }));

      return { errors };
    } catch {
      // Never throw — return a structured error instead
      return {
        errors: [
          {
            instancePath: '',
            schemaPath: '',
            message: 'Unexpected validation error',
          },
        ],
      };
    }
  }
}
