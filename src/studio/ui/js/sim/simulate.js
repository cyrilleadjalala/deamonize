// @ts-check
/**
 * The simulated server of the sample mode: one pure, dependency-free ES module, imported by the Node sample server
 * (`src/studio/sample-playground.ts`) and by the static demo in the browser. It answers like a generated MCP server,
 * with fixed fictitious results: one result is drifted, two fail (one with a picture), and heal mode turns the
 * failing chart call into a healed success.
 *
 * It touches no file, no network and no clock: where a picture goes is the caller's business (`pictures`).
 */

export const CUSTOMERS = [
  { name: 'Ada Lovelace', city: 'London' },
  { name: 'Alan Turing', city: 'Wilmslow' },
  { name: 'Grace Hopper', city: 'New York' },
];

/** The reserved argument every generated tool accepts. */
export const TIMEOUT_PROPERTY = { type: 'integer', minimum: 1, maximum: 600000 };

/**
 * What a call answers, as the generated server would (before it is wrapped in an MCP content block).
 * @param {string} name tool name
 * @param {Record<string, unknown>} args
 * @param {string} mode 'strict' or 'heal'
 * @param {boolean} preview a picture of the final screen was asked for
 * @param {{ failure(): string | Promise<string>, shot(): string | Promise<string> }} pictures
 * @returns {Promise<Record<string, unknown>>}
 */
export async function simulate(name, args, mode, preview, pictures) {
  const heal = mode === 'heal';
  /** @param {boolean} [healed] @param {unknown[]} [steps] */
  const modeFields = (healed = false, steps = []) => ({ mode, ...(heal ? { healed, healedSteps: steps } : {}) });
  const finalShot = async () => (preview ? { screenshot: await pictures.shot() } : {});
  switch (name) {
    case 'search_customers': {
      const query = String(args.query ?? '');
      const rows = CUSTOMERS.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
      const drifted = /drift/i.test(query);
      return {
        success: true,
        screenType: 'dom',
        title: drifted ? 'Customers (new layout)' : 'Customers',
        text: rows.map((r) => `${r.name}\t${r.city}`).join('\n'),
        data: rows,
        drifted,
        driftChecked: true,
        levels: ['http', 'accessibility'],
        ...modeFields(),
        elapsedMs: 412,
        ...(await finalShot()),
      };
    }
    case 'create_customer': {
      const who = String(args.name ?? '');
      if (/^fail$/i.test(who)) {
        return {
          success: false,
          error: 'step_failed',
          drifted: true,
          failure: {
            stepIndex: 5,
            action: 'click',
            risk: 'write',
            label: 'Save',
            tried: ['role=button[name="Save"] in dialog "New customer"', '#save'],
            reason: 'No element matched any locator: the Save button is not in the dialog any more.',
            screenshot: await pictures.failure(),
          },
          ...modeFields(false, []),
          ...(heal ? { heal: { attempted: true, reason: 'no mark matched the intent' } } : {}),
          elapsedMs: 3090,
        };
      }
      const healed = heal && /^heal$/i.test(who);
      return {
        success: true,
        screenType: 'dom',
        title: 'Customer created',
        text: `Customer ${who} was created.`,
        drifted: healed,
        driftChecked: true,
        levels: ['accessibility', 'accessibility', 'accessibility', 'accessibility', 'accessibility', healed ? 'vision' : 'accessibility'],
        ...modeFields(healed, healed ? [{ stepIndex: 5, source: 'model' }] : []),
        elapsedMs: healed ? 6120 : 1980,
        ...(await finalShot()),
      };
    }
    case 'open_sales_chart':
      if (!heal) {
        return {
          success: false,
          error: 'step_failed',
          drifted: true,
          failure: {
            stepIndex: 1,
            action: 'click',
            risk: 'read',
            label: 'Quarter bar',
            tried: ['role=canvas'],
            reason: 'The target is a canvas: only heal mode can find it by its picture.',
            screenshot: await pictures.failure(),
          },
          ...modeFields(),
          elapsedMs: 1250,
        };
      }
      return {
        success: true,
        screenType: 'dom',
        title: 'Sales by quarter',
        text: 'Q1 12\nQ2 18\nQ3 21 (selected)\nQ4 17',
        drifted: false,
        driftChecked: true,
        levels: ['accessibility', 'coordinates'],
        ...modeFields(true, [{ stepIndex: 1, source: 'coordinates' }]),
        elapsedMs: 2740,
        ...(await finalShot()),
      };
    case 'count_customers_in_a_table': {
      const table = String(args.table ?? 'customers');
      return {
        success: true,
        screenType: 'terminal',
        text: `sqlite> select count(*) from ${table};\n3\nsqlite> `,
        data: { count: '3' },
        drifted: false,
        driftChecked: true,
        mode,
        elapsedMs: 380,
      };
    }
    default:
      return { success: false, error: 'unknown_tool' };
  }
}
