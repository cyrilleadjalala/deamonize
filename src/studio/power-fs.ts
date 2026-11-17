/**
 * File helpers of the Kiro installer: path confinement and an all-or-nothing transaction.
 * Every write goes to a temporary file in the same folder, then a rename. A failure restores every touched file.
 */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (foldCase ? p.toLowerCase() : p);

/** `a` equals `b` or lies inside it. */
export function inside(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep);
}

/** Real path of the deepest existing ancestor, with the missing tail appended. */
export async function realDeepest(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (; ;) {
    try {
      return join(await fsp.realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}

/** The file operations the transaction uses. Tests wrap the default to inject a failure at any step. */
export interface FsOps {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** Returns the first folder created, like `mkdir` with `recursive`. */
  mkdir(path: string): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
}

export const defaultFsOps: FsOps = {
  readFile: (path) => fsp.readFile(path),
  // 'wx' so a temporary name collision never overwrites anything.
  writeFile: (path, data, options) => fsp.writeFile(path, data, { mode: options.mode, flag: 'wx' }),
  rename: (from, to) => fsp.rename(from, to),
  rm: (path, options) => fsp.rm(path, options),
  mkdir: (path) => fsp.mkdir(path, { recursive: true }),
  rmdir: (path) => fsp.rmdir(path),
  readdir: async (path) => (await fsp.readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
};

export interface Transaction {
  /** Queued: temporary file in the same folder, then rename. Missing folders are created. */
  write(path: string, bytes: Buffer): void;
  /** Queued: deletes a file. A missing file counts as removed. */
  remove(path: string): void;
  /** Queued: deletes a folder and everything in it. A missing folder counts as removed. */
  removeDir(path: string): void;
  /** Applies the queue in order. On any failure every touched file and folder is put back and the error is thrown. */
  commit(): Promise<void>;
}

type Op = { kind: 'write'; path: string; bytes: Buffer } | { kind: 'remove'; path: string } | { kind: 'removeDir'; path: string };

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const tmpName = (path: string): string => join(dirname(path), `${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);

/** Folders from `first` down to `dir` (both included). `first` is the first folder that `mkdir` created. */
function chain(first: string, dir: string): string[] {
  const out: string[] = [];
  let current = resolve(dir);
  const stop = resolve(first);
  for (; ;) {
    out.push(current);
    if (norm(current) === norm(stop)) return out;
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

export function beginTransaction(fsOps: FsOps = defaultFsOps): Transaction {
  const ops: Op[] = [];
  let used = false;

  async function readIfThere(path: string): Promise<Buffer | undefined> {
    try {
      return await fsOps.readFile(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Every file below `dir`, as relative-to-nothing absolute paths, with their bytes. */
  async function snapshotTree(dir: string, files: Map<string, Buffer>, dirs: string[]): Promise<void> {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = await fsOps.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    dirs.push(dir);
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory) await snapshotTree(child, files, dirs);
      else files.set(child, await fsOps.readFile(child));
    }
  }

  return {
    write(path, bytes) {
      ops.push({ kind: 'write', path, bytes });
    },
    remove(path) {
      ops.push({ kind: 'remove', path });
    },
    removeDir(path) {
      ops.push({ kind: 'removeDir', path });
    },
    async commit() {
      if (used) throw new Error('transaction already committed');
      used = true;
      const previous = new Map<string, Buffer | undefined>(); // file -> bytes before the transaction
      const treeDirs: string[] = [];
      const createdDirs: string[] = [];
      const temps = new Set<string>();
      let started = false;
      try {
        // 1. snapshot everything that will be touched, before changing anything
        for (const op of ops) {
          if (op.kind === 'removeDir') {
            const files = new Map<string, Buffer>();
            await snapshotTree(op.path, files, treeDirs);
            for (const [file, bytes] of files) if (!previous.has(file)) previous.set(file, bytes);
          } else if (!previous.has(op.path)) {
            previous.set(op.path, await readIfThere(op.path));
          }
        }
        // 2. apply in order
        started = true;
        for (const op of ops) {
          if (op.kind === 'write') {
            const dir = dirname(op.path);
            const first = await fsOps.mkdir(dir);
            if (first !== undefined) createdDirs.push(...chain(first, dir));
            const tmp = tmpName(op.path);
            temps.add(tmp);
            await fsOps.writeFile(tmp, op.bytes, { mode: 0o644 });
            await fsOps.rename(tmp, op.path);
            temps.delete(tmp);
          } else if (op.kind === 'remove') {
            await fsOps.rm(op.path, { force: true });
          } else {
            await fsOps.rm(op.path, { recursive: true, force: true });
          }
        }
      } catch (error) {
        for (const tmp of temps) await fsOps.rm(tmp, { force: true }).catch(() => undefined);
        temps.clear();
        if (started) await restore(previous, treeDirs, createdDirs);
        throw error;
      } finally {
        for (const tmp of temps) await fsOps.rm(tmp, { force: true }).catch(() => undefined);
      }
    },
  };

  /** Best effort, in reverse: put every file back and remove what the transaction created. */
  async function restore(previous: Map<string, Buffer | undefined>, treeDirs: string[], createdDirs: string[]): Promise<void> {
    // recreate removed folders first, so their files can be written back
    for (const dir of treeDirs) await fsOps.mkdir(dir).catch(() => undefined);
    for (const [path, bytes] of previous) {
      if (bytes === undefined) {
        await fsOps.rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      const tmp = tmpName(path);
      try {
        await fsOps.mkdir(dirname(path));
        await fsOps.writeFile(tmp, bytes, { mode: 0o644 });
        await fsOps.rename(tmp, path);
      } catch {
        await fsOps.rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    // folders created by the transaction, deepest first; rmdir only removes empty ones
    const sorted = [...new Set(createdDirs)].sort((a, b) => b.length - a.length);
    for (const dir of sorted) await fsOps.rmdir(dir).catch(() => undefined);
  }
}

/** Writes `bytes` to `path` through a temporary file in the same folder and a rename. The old file survives a failure. */
export async function writeFileAtomic(path: string, bytes: Buffer, mode = 0o600, fsOps: FsOps = defaultFsOps): Promise<void> {
  const tmp = tmpName(path);
  try {
    await fsOps.writeFile(tmp, bytes, { mode });
    await fsOps.rename(tmp, path);
  } catch (error) {
    await fsOps.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
