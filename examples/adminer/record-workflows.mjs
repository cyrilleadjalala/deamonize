#!/usr/bin/env node
/**
 * Records the Adminer workflows of this example, without any manual clicking.
 *
 * It drives the Daemonize recorder with Playwright against a RUNNING Adminer stack and does what a person does in the
 * real Adminer pages: choose the system, type the login values, click links, select the text of a row, choose a
 * filter operator, mark the result. The recorder sees real keyboard and mouse input, exactly as in a manual session.
 * Nothing in the pages is fabricated: the target is the official `adminer` image on PostgreSQL.
 *
 *   cd examples/adminer && docker compose up -d --wait          # Adminer on http://127.0.0.1:8080
 *   npm run build                                               # once: this script uses dist/
 *   node examples/adminer/record-workflows.mjs                  # writes examples/adminer/daemonize.workflows.json
 *
 * Options (all optional):
 *   --url <url>   Adminer login page (default http://127.0.0.1:8080/, the start URL stored in the file)
 *   --out <file>  workflow file (default examples/adminer/daemonize.workflows.json); it is replaced
 *
 * The database password is read from the environment variable DEMO_DB_PASSWORD (the value the stack was started
 * with; default: the public demo value of docker-compose.yml). It is typed into the login form during the recording and
 * stored NOWHERE: the workflow file only holds the secret name `PASSWORD` (the replay reads DAEMONIZE_SECRET_PASSWORD).
 *
 * Note: recording runs the `rename_customer` workflow once for real, so the status of "Chiara Rossi" in the demo
 * database becomes `pending`. Restart the stack (`docker compose down -v`, then up) to get the initial data back.
 *
 * Workflows (all start on the Adminer login page):
 *   list_customers          log in, open the table `customers`, return its rows            (read)
 *   find_customers          same, then filter: Variables `search_text` and `operator`      (read)
 *   open_customer_for_edit  open the edit form of the row named `customer_name`, return its fields   (read, nothing saved)
 *   rename_customer         same, change `status` (one of active, inactive, pending) and save        (write)
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_URL = 'http://127.0.0.1:8080/';
export const DEFAULT_OUT = resolve(here, 'daemonize.workflows.json');
export const DEFAULT_PASSWORD = 'demo-password-change-me';

const USER = 'demo';
const DATABASE = 'demo';
/** The customer used while recording. His row is found again by the Variable `customer_name`, not by position. */
const RECORDED_CUSTOMER = 'Chiara Rossi';
const STATUSES = ['active', 'inactive', 'pending'];

// ---------------------------------------------------------------------------------------------------------------
// What a person does in the Adminer pages

/** Log in as the demo user. The password is typed like any other value: the recorder stores only its name. */
async function login(page, password) {
  await page.locator('select[name="auth[driver]"]').selectOption('pgsql');
  // The server field is pre-filled by the stack (`db`)
  await page.locator('input[name="auth[username]"]').click();
  await page.keyboard.type(USER);
  await page.locator('input[name="auth[password]"]').click();
  await page.keyboard.type(password);
  await page.locator('input[name="auth[db]"]').click();
  await page.keyboard.type(DATABASE);
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(/username=/);
}

/** Let the page report its last events, then wait until the recorder has stored them. */
async function settle(page, live) {
  await page.waitForTimeout(250);
  await live.idle();
}

/** Open the data of the table `customers` from the menu. */
async function openCustomers(page) {
  await page.getByRole('link', { name: 'select', exact: true }).click();
  await page.waitForURL(/select=customers/);
  await page.locator('table#table').waitFor();
}

/** The user marks what the tool returns: Alt+Shift+R, then a click in the element (the kind can be changed in the page). */
async function markResult(page, live, target, kind) {
  await settle(page, live);
  await page.keyboard.press('Alt+Shift+R');
  await target.click();
  const chosen = page.locator('[data-daemonize-action="result-kind"]');
  await chosen.waitFor();
  if ((await chosen.inputValue()) !== kind) await chosen.selectOption(kind);
  // The page reports the choice to the recorder asynchronously
  await page.waitForFunction(() => document.querySelector('[data-daemonize-action="result-kind"]') !== null);
  await page.waitForTimeout(150);
}

/** Select the text of a cell with the mouse and name it in the "Make variable" box of the page. */
async function nameRowValue(page, live, cell, variable) {
  await cell.scrollIntoViewIfNeeded();
  const box = await cell.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
  await page.mouse.up();
  const make = page.locator('[data-daemonize-action="make-variable"]');
  await make.waitFor();
  await make.click();
  const name = page.locator('[data-daemonize-action="variable-name"]');
  await name.fill(variable);
  await name.press('Enter');
  await page.getByText(`Variable "${variable}" saved`).waitFor();
  await settle(page, live);
}

/** The row of a customer in the data table (the `edit` link is the same text in every row). */
function customerRow(page, name) {
  return page.locator('table#table tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) });
}

/** From the data table: name the customer as a Variable, then click `edit` in that row. */
async function openEditForm(page, live) {
  const row = customerRow(page, RECORDED_CUSTOMER);
  await nameRowValue(page, live, row.getByRole('cell', { name: RECORDED_CUSTOMER, exact: true }), 'customer_name');
  await row.getByRole('link', { name: 'edit', exact: true }).click();
  await page.waitForURL(/edit=customers/);
  await page.locator('table.layout').waitFor();
}

// ---------------------------------------------------------------------------------------------------------------
// The four workflows. Each `drive` runs inside `record()`, after the browser opened the login page.

/** Variable of a native select step: the values a call may give. */
function markEnum(live, stepIndex, name, values, description) {
  live.markVariable(stepIndex, { name, enum: values, description });
}

export function workflows(password) {
  return [
    {
      label: 'list_customers',
      finalZone: 'table#table > thead',
      drive: async (page, live) => {
        await login(page, password);
        await openCustomers(page);
        await markResult(page, live, page.locator('table#table tbody tr').first().locator('td').last(), 'table');
      },
    },
    {
      label: 'find_customers',
      finalZone: 'h2',
      drive: async (page, live) => {
        await login(page, password);
        await openCustomers(page);
        // The filter fields are folded: open "Search" like a person would
        await page.locator('a.toggle', { hasText: 'Search' }).click();
        await page.locator('select[name="where[0][op]"]').selectOption('LIKE');
        await settle(page, live);
        markEnum(live, live.stepCount - 1, 'operator', ['=', 'LIKE'], 'Comparison used by the filter');
        await page.locator('input[name="where[0][val]"]').click();
        await page.keyboard.type('Fran%');
        await page.keyboard.press('Tab');
        await settle(page, live);
        live.markVariable(live.stepCount - 1, { name: 'search_text', description: 'Value to look for in any column; with LIKE, % matches any text' });
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.waitForURL(/where/);
        await page.locator('table#table').waitFor();
        await markResult(page, live, page.locator('table#table tbody tr').first().locator('td').last(), 'table');
      },
    },
    {
      label: 'open_customer_for_edit',
      finalZone: 'h2',
      drive: async (page, live) => {
        await login(page, password);
        await openCustomers(page);
        await openEditForm(page, live);
        await markResult(page, live, page.locator('table.layout th').first(), 'fields');
      },
    },
    {
      label: 'rename_customer',
      finalZone: 'h2',
      drive: async (page, live) => {
        await login(page, password);
        await openCustomers(page);
        await openEditForm(page, live);
        const status = page.locator('textarea[name="fields[status]"]');
        await status.click();
        await page.keyboard.press('Control+A');
        // A different status than the current one, otherwise the field does not change and nothing is recorded
        await page.keyboard.type((await status.inputValue()) === 'pending' ? 'active' : 'pending');
        await page.keyboard.press('Tab');
        await settle(page, live);
        markEnum(live, live.stepCount - 1, 'status', STATUSES, 'New status of the customer');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForURL(/select=customers/);
        await markResult(page, live, page.locator('div.message').first(), 'text');
      },
    },
  ];
}

/** The submit buttons that only read: logging in and filtering the table (a GET form). The recorder marks every submit as a write. */
const READ_ONLY_SUBMITS = ['role=button[name="Login"]', 'role=button[name="Select"]'];

/**
 * Record the four workflows into `out` (replaced). `record` is the `record` function of Daemonize
 * (`dist/cli/commands/record.js`); it is a parameter so that tests can give the TypeScript source.
 */
export async function recordAdminerWorkflows({ record, url = DEFAULT_URL, out = DEFAULT_OUT, password = DEFAULT_PASSWORD, headless = true, log = console.log }) {
  await rm(out, { force: true });
  await rm(`${out}.assets`, { recursive: true, force: true });
  const summaries = [];
  for (const workflow of workflows(password)) {
    log(`Recording ${workflow.label} ...`);
    const summary = await record({
      url,
      name: 'adminer',
      label: workflow.label,
      out,
      headless,
      finalZone: workflow.finalZone,
      drive: workflow.drive,
    });
    summaries.push(summary);
    log(`  ${summary.steps} steps, variables: ${summary.variables.join(', ') || '-'}, secrets: ${summary.secrets.map((s) => s.envVariable).join(', ') || '-'}`);
  }
  await editWorkflowFile(out);
  return summaries;
}

/** Two things the recorder cannot know, said in the file as a person editing it would: which clicks only read, and what a row text means. */
async function editWorkflowFile(out) {
  const set = JSON.parse(await readFile(out, 'utf8'));
  for (const workflow of set.workflows) {
    // Only saving the form writes: the login and the filter are read steps
    for (const step of workflow.steps) {
      if (step.actionType === 'click' && READ_ONLY_SUBMITS.includes(step.selectors[0])) step.risk = 'read';
    }
    for (const variable of workflow.variables) {
      if (variable.name === 'customer_name') variable.description = 'Exact name of the customer, as shown in the name column of the table';
    }
  }
  await writeFile(out, `${JSON.stringify(set, null, 2)}\n`);
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { record } = await import(pathToFileURL(resolve(here, '../../dist/cli/commands/record.js')).href).catch(() => {
    throw new Error('dist/ is missing: run "npm run build" in the repository root first');
  });
  recordAdminerWorkflows({
    record,
    url: option('url', DEFAULT_URL),
    out: resolve(option('out', DEFAULT_OUT)),
    password: process.env.DEMO_DB_PASSWORD || DEFAULT_PASSWORD,
    headless: process.env.DAEMONIZE_HEADED !== '1',
  }).then(
    () => console.log('Done.'),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
