/**
 * Derives unique snake_case tool names from human-readable labels.
 * Truncates to 64 characters at a word boundary.
 * Appends _2, _3, … for conflicts.
 */
export class ToolNameDeriver {
  private usedNames = new Set<string>();

  /**
   * Derive a unique snake_case tool name from a human-readable label.
   * Truncates to 64 characters at a word boundary.
   * Appends _2, _3, … for conflicts.
   *
   * Call reset() between compilations.
   */
  derive(label: string): string {
    const base = this.toSnakeCase(label);
    const name = base.length === 0 ? 'action' : this.truncate(base);
    const unique = this.resolve(name);
    this.usedNames.add(unique);
    return unique;
  }

  /** Clear the used-names set for a fresh compilation. */
  reset(): void {
    this.usedNames.clear();
  }

  private toSnakeCase(input: string): string {
    // Lowercase the entire string
    const lower = input.toLowerCase();
    // Replace any run of non-alphanumeric characters with a single _
    const replaced = lower.replace(/[^a-z0-9]+/g, '_');
    // Collapse multiple consecutive _ into one (already handled by the + quantifier above)
    // Strip leading and trailing _
    const stripped = replaced.replace(/^_+|_+$/g, '');
    return stripped;
  }

  private truncate(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    // Truncate to 64 characters and find the last _ at or before position 63
    const candidate = name.slice(0, 64);
    const lastUnderscore = candidate.lastIndexOf('_');
    if (lastUnderscore === -1) {
      // No word boundary found — hard truncate at 64
      return candidate;
    }
    return candidate.slice(0, lastUnderscore);
  }

  private resolve(name: string): string {
    if (!this.usedNames.has(name)) {
      return name;
    }
    let suffix = 2;
    while (true) {
      const candidate = `${name}_${suffix}`;
      if (!this.usedNames.has(candidate)) {
        return candidate;
      }
      suffix++;
    }
  }
}

/** Reserve the accepted names first, so a derived name never takes one of them; the deriver adds _2 on a conflict. */
export function deriveToolNames(set: { workflows: Array<{ id: string; label: string }> }, overrides: Record<string, string>): Map<string, string> {
  const deriver = new ToolNameDeriver();
  const names = new Map<string, string>();
  for (const workflow of set.workflows) {
    const override = overrides[workflow.id];
    if (override !== undefined) names.set(workflow.id, deriver.derive(override));
  }
  for (const workflow of set.workflows) {
    if (!names.has(workflow.id)) names.set(workflow.id, deriver.derive(workflow.label));
  }
  return names;
}

