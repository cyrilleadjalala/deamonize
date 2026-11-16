export interface SecretFinding {
  rule: string;
  line: number;
  /** Masked: never the value */
  excerpt: string;
  /** The matched text, for allow-list checks in tests only: never print it */
  value: string;
}
export interface FileFinding {
  file: string;
  rule: string;
  line: number;
  excerpt: string;
}
export const ALLOWED_DEMO_VALUES: Readonly<Record<string, readonly string[]>>;
export function scanForSecretShapes(text: string): SecretFinding[];
export const SYNTHETIC_FIXTURE_FILES: readonly string[];
export function demoValuesIn(text: string): string[];
export function isBinary(buffer: Uint8Array): boolean;
export function scanFile(root: string, relativePath: string): FileFinding[];
export function scanFiles(root: string, files: string[]): FileFinding[];
export function listCommittableFiles(root: string, options?: { changedOnly?: boolean }): string[] | undefined;
