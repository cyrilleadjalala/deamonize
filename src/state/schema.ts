import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import schemaJson from "./state-graph.schema.json" with { type: "json" };

// ajv-formats ships as CJS; under NodeNext esModuleInterop the module object
// itself may not carry call signatures in TypeScript's view.  We cast to the
// callable form directly so tsc is satisfied.
const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;

/**
 * The State_Graph JSON Schema (draft 2020-12) as a typed constant.
 */
export const StateGraphSchema: Record<string, unknown> = schemaJson as Record<string, unknown>;

let compiled: ValidateFunction | undefined;

/**
 * Returns a pre-compiled AJV validate function for the State_Graph JSON Schema.
 * Uses JSON Schema draft 2020-12 and includes format validation (date-time, uuid).
 * The schema is compiled once, on first use.
 */
export function createAjvValidator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    compiled = ajv.compile(StateGraphSchema);
  }
  return compiled;
}
