import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import fc from 'fast-check';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAppData } from '../../src/studio/app-data.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { validateName, validateUrl } from '../../src/studio/validate-action.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

// Feature: studio-first-flow, Property 1: Action input validation
describe('Property 1: Action input validation', () => {
  // An oracle written from the requirement text, independent of the module under test
  const nameOk = (raw: string): boolean => {
    const t = raw.trim();
    const n = Array.from(t).length;
    return n >= 1 && n <= 80 && /[A-Za-z0-9]/.test(t) && !/[\u0000-\u001f\u007f]/.test(t);
  };
  const urlOk = (raw: string): boolean => {
    const t = raw.trim();
    if (t.length > 2048) return false;
    try {
      const u = new URL(t);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
    } catch {
      return false;
    }
  };
  const nameArb = fc.oneof(fc.string({ maxLength: 100 }), fc.string({ unit: 'binary', maxLength: 90 }), fc.constantFrom('', '   ', 'ok', ' a ', 'x\ny'));
  const urlArb = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.webUrl(),
    fc.webUrl().map((u) => u.replace('://', '://user:pw@')),
    fc.constantFrom('', 'ftp://h/', 'file:///x', 'javascript:1', 'http://h', '  https://h/p  ')
  );

  it('accepts exactly what the rules accept', () => {
    // **Validates: Requirements 3.6, 3.7, 3.8**
    fc.assert(
      fc.property(nameArb, urlArb, (name, url) => {
        expect(validateName(name).ok).toBe(nameOk(name));
        expect(validateUrl(url).ok).toBe(urlOk(url));
      }),
      { numRuns: 300 }
    );
  });
});

// Feature: studio-first-flow, Property 15: The App_Data_Dir exclusion rule
describe('Property 15: The App_Data_Dir exclusion rule', () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'prop15-')));
  });
  afterAll(async () => {
    await removeDir(root);
  });

  it('is ok exactly outside cwd, Output_Dir and every .git ancestor, and ensure creates nothing when excluded', async () => {
    // **Validates: Requirements 6.2, 6.3**
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('equal-cwd', 'in-cwd', 'in-out', 'sibling', 'in-repo', 'outside'),
        fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 2 }),
        async (where, tail) => {
          const base = join(root, `case-${n++}`);
          const work = join(base, 'repo', 'work');
          const outDir = join(base, 'repo', 'work', 'out');
          await mkdir(work, { recursive: true });
          await writeFile(join(base, 'repo', '.git'), 'gitdir: x');
          const target =
            where === 'equal-cwd' ? work
            : where === 'in-cwd' ? join(work, 'd')
            : where === 'in-out' ? join(outDir, 'd')
            : where === 'sibling' ? join(base, 'repo', 'sibling')
            : where === 'in-repo' ? join(base, 'repo', 'deep')
            : join(base, 'elsewhere');
          const dataDir = join(target, ...tail);
          const appData = createAppData({ cwd: work, outDir, env: { DAEMONIZE_DATA_DIR: dataDir } });
          const excluded = where !== 'outside';
          const before = await readdir(base);
          const ensured = await appData.ensure();
          expect(ensured.ok).toBe(!excluded);
          expect((await appData.check()).ok).toBe(!excluded);
          if (excluded) expect(await readdir(base)).toEqual(before);
          await rm(base, { recursive: true, force: true });
        }
      ),
      { numRuns: 40 }
    );
  });
});

// Feature: studio-first-flow, Property 18: Error messages carry no path and no secret (load errors)
describe('Property 18: load errors carry no path and no content', () => {
  let dir: string;
  let handle: StudioHandle;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prop18-'));
    handle = await startStudio({ workflowFile: join(dir, 'w.json'), outDir: join(dir, 'out'), staticDir: join(dir, 'ui'), env: {} });
  });
  afterAll(async () => {
    await handle.close();
    await removeDir(dir);
  });

  it('answers one of the three fixed messages for any unusable file', async () => {
    // **Validates: Requirements 2.6**
    const FIXED = ['workflow file is unreadable', 'workflow file is too large', 'workflow file is not a valid workflow set'];
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 4, maxLength: 80 }).filter((s) => /\S{4}/.test(s) && !/[{}\[\]":,\\]/.test(s) && !/workflow|file|valid|set|is|not/i.test(s)),
        fc.constantFrom('/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt'),
        async (junk, path) => {
          await writeFile(join(dir, 'w.json'), `{"version": "1", "junk": "${junk.replace(/["\\]/g, '')}"`);
          const r = await rawRequest(handle, 'GET', path, { host: `127.0.0.1:${handle.port}`, 'x-studio-token': handle.token });
          expect(r.status).toBe(500);
          const body = JSON.parse(r.text);
          expect(Object.keys(body)).toEqual(['error']);
          expect(FIXED).toContain(body.error);
          expect(r.text).not.toContain(junk);
          expect(r.text).not.toContain(dirname(dir));
        }
      ),
      { numRuns: 25 }
    );
  });
});
