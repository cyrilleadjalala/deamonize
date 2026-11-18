import type { WhenOmitted } from '../types.js';

/** What the page and the recorder exchange through the bindings. Types only. */
export type VariableType = 'string' | 'number' | 'boolean';

export type PanelRequest =
  | { type: 'state' }
  | { type: 'summary' }
  | { type: 'collapse'; collapsed: boolean }
  | { type: 'fields' }
  | { type: 'file'; fieldId: string };

export interface PanelFieldVariable {
  name: string;
  type: VariableType;
  optional: boolean;
  whenOmitted?: WhenOmitted;
}

export interface PanelField {
  stepIndex: number;
  label: string;
  kind: 'text' | 'choice' | 'check' | 'radio';
  variable?: PanelFieldVariable;
}

/** At most 100 fields, stepIndex ascending, no typed value. */
export interface FieldsAnswer {
  fields: PanelField[];
}

export interface MarkVariableRequest {
  stepIndex: number;
  name: string;
  rowText?: string;
  type?: VariableType;
  optional?: boolean;
  whenOmitted?: WhenOmitted;
}

export interface EditVariableRequest {
  name: string;
  newName?: string;
  type?: VariableType;
  optional?: boolean;
  whenOmitted?: WhenOmitted;
}

export type VariableAnswer = { ok: true } | { ok: false; error: string };

export interface FinishRequest {
  intent?: unknown;
  scope?: unknown;
}

/** names: enabled radios of the group, document order, at most 52. */
export interface RadioInfo {
  names: string[];
  total: number;
  clicked: string;
  clickedDisabled: boolean;
}

export interface PanelSummary {
  steps: number;
  variables: string[];
  secrets: number;
  files: number;
}

export interface PanelState {
  kiroHomeExists: boolean;
}
