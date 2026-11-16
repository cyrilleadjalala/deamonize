/** Types of the shared simulation module (the module itself is plain JavaScript, also served to browsers). */
export interface SimPictures {
  failure(): string | Promise<string>;
  shot(): string | Promise<string>;
}
export const CUSTOMERS: ReadonlyArray<{ name: string; city: string }>;
export const TIMEOUT_PROPERTY: { type: string; minimum: number; maximum: number };
export function simulate(
  name: string,
  args: Record<string, unknown>,
  mode: string,
  preview: boolean,
  pictures: SimPictures
): Promise<Record<string, unknown>>;
