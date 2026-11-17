import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginTransaction, defaultFsOps, inside, realDeepest, type FsOps } from '../../src/studio/power-fs.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'power-fs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file below `dir` with its text, plus every folder, as a sorted list. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + '/' + e.name;
    if (e.isDirectory()) out.push(rel + '/', ...(await tree(join(dir, e.name), rel)));
    else out.push(rel + '=' + (await readFile(join(dir, e.name), 'utf-8')));
  }
  return out.sort();
}

/** Counts every call and fails the call numbered `failAt` (1-based). */
function injecting(failAt: number): { ops: FsOps; calls: () => number } {
  let n = 0;
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    n += 1;
    if (n === failAt) throw new Error('injected');
    return fn(...a);
  };
  const ops: FsOps = {
    readFile: wrap(defaultFsOps.readFile),
    writeFile: wrap(defaultFsOps.writeFile),
    rename: wrap(defaultFsOps.rename),
    rm: wrap(defaultFsOps.rm),
    mkdir: wrap(defaultFsOps.mkdir),
    rmdir: wrap(defaultFsOps.rmdir),
    readdir: wrap(defaultFsOps.readdir),
  };
  return { ops, calls: () => n };
}

async function seed(): Promise<void> {
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(join(root, 'settings', 'mcp.json'), 'old-config');
  await mkdir(join(root, 'skills', 'app'), { recursive: true });
  await writeFile(join(root, 'skills', 'app', 'SKILL.md'), 'old-skill');
  await mkdir(join(root, 'skills', 'gone'), { recursive: true });
  await writeFile(join(root, 'skills', 'gone', 'SKILL.md'), 'gone-skill');
}

function queue(tx: ReturnType<typeof beginTransaction>): void {
  tx.write(join(root, 'settings', 'mcp.json.bak'), Buffer.from('old-config'));
  tx.write(join(root, 'skills', 'app', 'SKILL.md'), Buffer.from('new-skill'));
  tx.write(join(root, 'deep', 'new', 'file.txt'), Buffer.from('fresh'));
  tx.removeDir(join(root, 'skills', 'gone'));
  tx.remove(join(root, 'missing.txt'));
  tx.write(join(root, 'settings', 'mcp.json'), Buffer.from('new-config'));
}

describe('power-fs', () => {
  it('inside and realDeepest', async () => {
    expect(inside(join(root, 'a'), root)).toBe(true);
    expect(inside(root, root)).toBe(true);
    expect(inside(root + 'x', root)).toBe(false);
    const deep = await realDeepest(join(root, 'no', 'such'));
    expect(deep.endsWith(join('no', 'such'))).toBe(true);
  });

  it('commits every queued step in order with no temporary file left', async () => {
    await seed();
    const tx = beginTransaction();
    queue(tx);
    await tx.commit();
    expect(await tree(root)).toEqual(
      [
        '/deep/', '/deep/new/', '/deep/new/file.txt=fresh', '/settings/', '/settings/mcp.json=new-config',
        '/settings/mcp.json.bak=old-config', '/skills/', '/skills/app/', '/skills/app/SKILL.md=new-skill',
      ].sort()
    );
  });

  it('puts everything back when any single step fails, and leaves no temporary file', async () => {
    await seed();
    const before = await tree(root);
    const counter = injecting(0);
    const probe = beginTransaction(counter.ops);
    queue(probe);
    await probe.commit();
    const total = counter.calls();
    expect(total).toBeGreaterThan(10);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    for (let failAt = 1; failAt <= total; failAt += 1) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      await seed();
      const tx = beginTransaction(injecting(failAt).ops);
      queue(tx);
      await expect(tx.commit(), `failure at call ${failAt}`).rejects.toThrow('injected');
      expect(await tree(root), `state after failure at call ${failAt}`).toEqual(before);
    }
  });

  it('refuses a second commit', async () => {
    const tx = beginTransaction();
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow();
  });
});
