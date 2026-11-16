import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import { Compiler } from '../../src/compiler/compiler.js';
import {
  cropTerminal,
  normalizeScreen,
  normalizedHash,
  screenId,
} from '../../src/replay/runtime/screen-hash.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const hasher = new ScreenHasher();

const DOM_SAMPLES = [
  '<div id="a1b2c3d4-e5f6-7890-abcd-ef1234567890" class="x" data-reactid="3" nonce="n"><input name="csrf_token" type="hidden"> <p>Hi</p>\n  </div>',
  '<form  method=\'post\' action="/go"><input type="text" name="q" disabled/></form>',
  '',
];
const TERMINAL_SAMPLES = [
  'Menu   \n\x1b[31mred\x1b[0m line  \n\x1b[2;3H\n\nEnd',
  '',
  'plain',
];

describe('runtime screen-hash equals ScreenHasher', () => {
  const contents = [
    ...DOM_SAMPLES.map((raw) => ({ type: 'dom' as const, raw })),
    ...TERMINAL_SAMPLES.map((raw) => ({ type: 'terminal' as const, raw })),
  ];

  it.each(contents)('same canonical form, hash and id for $type %#', ({ type, raw }) => {
    const content = { type, raw, normalized: '' };
    expect(normalizeScreen(type, raw)).toBe(hasher.normalize(content));
    const hash = normalizedHash(type, raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hasher.normalizedHash(content));
    expect(screenId(type, raw)).toBe(hasher.computeId(content));
    expect(screenId(type, raw)).toHaveLength(16);
  });
});

describe('cropTerminal', () => {
  const text = ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx'].join('\n');

  it('keeps only the rectangle', () => {
    expect(cropTerminal(text, { row: 1, col: 2, rows: 2, cols: 3 })).toBe('ijk\nopq');
  });

  it('clips to what exists', () => {
    expect(cropTerminal(text, { row: 3, col: 4, rows: 5, cols: 10 })).toBe('wx');
  });
});

describe('copied file', () => {
  let out: string;
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'daemonize-screen-hash-'));
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'App',
      startUrl: 'http://localhost/',
      workflows: [
        { id: 'w1', label: 'Go', steps: [{ actionType: 'click', selectors: ['#go'] }], variables: [], observedPayloads: [] },
      ],
    };
    const log = console.log;
    console.log = () => {};
    try {
      await new Compiler().compile(set, out);
    } finally {
      console.log = log;
    }
  });
  afterAll(() => removeDir(out));

  it('is a verbatim copy of the tested source, with no src/ import', async () => {
    const source = await readFile(join(__dirname, '../../src/replay/runtime/screen-hash.ts'), 'utf-8');
    const copied = await readFile(join(out, 'screen-hash.ts'), 'utf-8');
    expect(copied).toBe(source);
    const shipped = await readFile(join(out, 'screen-hash.js'), 'utf-8');
    for (const file of [copied, shipped]) {
      expect(file).not.toMatch(/from\s+['"][^'"]*src\//);
      const specifiers = [...file.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.every((s) => s === 'node:crypto')).toBe(true);
    }
  });

  it('puts the copy in the docker build context', async () => {
    const dockerfile = await readFile(join(out, 'sandbox', 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('COPY screen-hash.js ./screen-hash.js');
  });
});
