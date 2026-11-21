/**
 * Regression test of Requirement 24.3: a Workflow_File written before the user-journey changes must load,
 * compile and replay as it did at the commit where the snapshot was captured.
 *
 * Capture (once, at the commit before any source change):
 *   UPDATE_REGRESSION=1 npx vitest run tests/unit/regression-fixture.test.ts
 * The snapshot and ALLOWED_DIFFERENCES are read-only afterwards.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, splitSnapshot, type Snapshot } from '../helpers/regression-snapshot.js';
import { FW_LINE_PATTERNS, FW_MARK } from '../../src/compiler/firewall-markers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'regression');
const SNAPSHOT_DIR = join(FIXTURES, 'snapshot');

const CASES = [
  { name: 'web', file: 'pre-change.workflows.json' },
  { name: 'tui', file: 'pre-change-tui.workflows.json' },
];

/**
 * The closed list of differences a later change may introduce in the snapshot of an old file:
 * the runtime file `omission.ts` and its compiled `omission.js` are copied into every output folder, and
 * `omission.js` is one more entry of the `copy` list of `sandbox/image.json`. Each entry removes its
 * difference from the freshly built snapshot, so everything else must still be equal.
 */
export interface AllowedDifference {
  description: string;
  /** Removes a difference from the parsed JSON part of the snapshot. */
  remove?: (snapshot: Snapshot) => void;
  /** Removes a difference from the generated texts (`<name>.<option>.<file>.txt`). Only lines that end with FW_MARK may go. */
  removeFromTexts?: (files: Record<string, string>) => void;
}

/** Removes the marked lines that match `pattern` from every text whose name ends with `suffix`. Any other line stays. */
function removeMarkedLines(files: Record<string, string>, suffix: string, pattern: RegExp): void {
  for (const name of Object.keys(files)) {
    if (!name.endsWith(suffix)) continue;
    const eol = files[name].includes('\r\n') ? '\r\n' : '\n';
    files[name] = files[name]
      .split(eol)
      .filter((line) => !(line.trimEnd().endsWith(FW_MARK) && pattern.test(line.trimStart())))
      .join(eol);
  }
}

const FIREWALL_RUNTIME_FILES = ['approval-queue', 'audit-log', 'firewall', 'trace'].flatMap((name) => [`${name}.ts`, `${name}.js`]);
const MCP_SERVER_TEXTS = '.mcp-server.ts.txt';
/** `docker-replay.ts.txt` does not end with this: its dot is a dash. */
const REPLAY_TEXTS = '.replay.ts.txt';

export const ALLOWED_DIFFERENCES: ReadonlyArray<AllowedDifference> = [
  {
    description: 'omission.ts and omission.js in the list of files of the output folder',
    remove: (snapshot) => {
      for (const option of Object.values(snapshot.options)) {
        option.files = option.files.filter((file) => file !== 'omission.ts' && file !== 'omission.js');
      }
    },
  },
  {
    description: 'omission.js in the copy list of the sandbox image',
    remove: (snapshot) => {
      for (const option of Object.values(snapshot.options)) {
        option.sandboxImage.copy = option.sandboxImage.copy.filter((file) => file !== 'omission.js');
      }
    },
  },
  {
    // Requirements 2.10 and 2.11: a row-bound step with no argument plans the row of the recorded value
    // instead of failing with ROW_VARIABLE_MISSING. Only that exact trace value is mapped back.
    description: 'locatorsWithoutArguments of a row-bound step plans the recorded row (Requirements 2.10, 2.11)',
    remove: (snapshot) => {
      const NEW = [
        "getByRole('button', { name: 'Open', exact: true }) in the row containing 'Ada Lovelace'",
        "css: tr button in the row containing 'Ada Lovelace'",
      ];
      const OLD =
        'row of the step: ROW_VARIABLE_MISSING: no value for the variable "customer" that selects the row';
      for (const entry of snapshot.trace as Array<{ steps?: Array<Record<string, any>> }>) {
        for (const step of entry.steps ?? []) {
          const without = step.locatorsWithoutArguments as { ok?: unknown } | undefined;
          if (step.rowLocator !== null && Array.isArray(without?.ok) && JSON.stringify(without.ok) === JSON.stringify(NEW)) {
            without.ok = [OLD];
          }
        }
      }
    },
  },
  // ---- kiro-native-agent-and-firewall: every generated line that the change adds ends with FW_MARK ----
  {
    description: 'approval-queue, audit-log, firewall and trace (.ts and .js) in the list of files of the output folder',
    remove: (snapshot) => {
      for (const option of Object.values(snapshot.options)) {
        option.files = option.files.filter((file) => !FIREWALL_RUNTIME_FILES.includes(file));
      }
    },
  },
  {
    description: 'trace.js in the copy list of the sandbox image',
    remove: (snapshot) => {
      for (const option of Object.values(snapshot.options)) {
        option.sandboxImage.copy = option.sandboxImage.copy.filter((file) => file !== 'trace.js');
      }
    },
  },
  {
    description: 'mcp-server.ts: the import of firewall.js (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.firewallImport),
  },
  {
    description: 'mcp-server.ts: the FIREWALL table (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.firewallTable),
  },
  {
    description: 'mcp-server.ts: the firewall object (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.firewallObject),
  },
  {
    description: 'mcp-server.ts: the function approvalGate (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.approvalGate),
  },
  {
    description: 'mcp-server.ts: the saved server.tool, registerTool (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.registerTool),
  },
  {
    description: 'mcp-server.ts: the wrapper of server.tool (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, MCP_SERVER_TEXTS, FW_LINE_PATTERNS.toolWrapper),
  },
  {
    description: 'replay.ts: the import of trace.js (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, REPLAY_TEXTS, FW_LINE_PATTERNS.traceImport),
  },
  {
    description: 'replay.ts: traceStep(index); in the step loops (marked lines)',
    removeFromTexts: (files) => removeMarkedLines(files, REPLAY_TEXTS, FW_LINE_PATTERNS.traceStep),
  },
  {
    description: 'replay.ts: enterTraceScope(); in the container entry (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, REPLAY_TEXTS, FW_LINE_PATTERNS.enterTraceScope),
  },
  {
    description: 'replay.ts: the trace in the result of the container entry (marked line)',
    removeFromTexts: (files) => removeMarkedLines(files, REPLAY_TEXTS, FW_LINE_PATTERNS.traceResult),
  },
];

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

function withoutAllowedDifferences(name: string, files: Record<string, string>): Record<string, string> {
  const json = `${name}.json`;
  const snapshot = JSON.parse(files[json]) as Snapshot;
  for (const allowed of ALLOWED_DIFFERENCES) allowed.remove?.(snapshot);
  const result: Record<string, string> = { ...files, [json]: JSON.stringify(snapshot, null, 2) + '\n' };
  for (const allowed of ALLOWED_DIFFERENCES) allowed.removeFromTexts?.(result);
  return result;
}

/** The lines that end with FW_MARK in the texts: after every named entry ran, none may be left. */
function leftoverMarkedLines(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    text.split(/\r?\n/).flatMap((line, index) => (line.trimEnd().endsWith(FW_MARK) ? [`${file}:${index + 1}: ${line.trim().slice(0, 100)}`] : []))
  );
}

describe('regression fixture (Requirement 24.3)', () => {
  for (const { name, file } of CASES) {
    it(`an old ${name} Workflow_File gives the snapshot captured before the change`, async () => {
      const text = await readFile(join(FIXTURES, file), 'utf-8');
      const actual = splitSnapshot(name, await buildSnapshot(text));

      if (process.env.UPDATE_REGRESSION === '1') {
        await mkdir(SNAPSHOT_DIR, { recursive: true });
        for (const stored of await readdir(SNAPSHOT_DIR)) {
          if (stored.startsWith(`${name}.`)) await rm(join(SNAPSHOT_DIR, stored));
        }
        for (const [fileName, content] of Object.entries(actual)) await writeFile(join(SNAPSHOT_DIR, fileName), content);
        return;
      }

      const stored: Record<string, string> = {};
      for (const fileName of await readdir(SNAPSHOT_DIR)) {
        if (fileName.startsWith(`${name}.`)) stored[fileName] = lf(await readFile(join(SNAPSHOT_DIR, fileName), 'utf-8'));
      }
      expect(Object.keys(stored).length, 'the snapshot was never captured (UPDATE_REGRESSION=1)').toBeGreaterThan(0);

      const live = `${name}.live-replay.json`;
      // The real replay needs a browser: without one it is not compared
      if (actual[live] === undefined) delete stored[live];
      else if (stored[live] === undefined) delete actual[live];

      const compared = withoutAllowedDifferences(name, actual);
      // A marked line that no named entry accounts for is an unexplained difference
      expect(leftoverMarkedLines(compared), 'lines ending with //#fw that no entry of ALLOWED_DIFFERENCES removes').toEqual([]);
      expect(Object.keys(compared).sort()).toEqual(Object.keys(stored).sort());
      for (const fileName of Object.keys(stored)) {
        expect(lf(compared[fileName]), fileName).toBe(stored[fileName]);
      }
    }, 120_000);
  }
});
