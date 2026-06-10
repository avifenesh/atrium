import { open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { readJson, iso } from '../util.js';
import type { Collector } from './registry.js';
import type { NotesState } from '../../../shared/types.js';

const MAX_DEPTH = 4;
const MAX_FILES = 2000;
const READ_CAP_BYTES = 512 * 1024;
const WRITE_CAP_BYTES = 512 * 1024;

interface ObsidianRegistry {
  vaults?: Record<string, { path?: string; open?: boolean }>;
}

async function findVault(): Promise<string | null> {
  const reg = await readJson<ObsidianRegistry>(config.paths.obsidianRegistry);
  const vaults = Object.values(reg?.vaults ?? {});
  const picked = vaults.find((v) => v.open && v.path) ?? vaults.find((v) => v.path);
  if (picked?.path) return picked.path;
  // registry missing/empty: fall back to the known vault if it exists
  try {
    if ((await stat(config.paths.revutoVault)).isDirectory()) return config.paths.revutoVault;
  } catch {
    /* no fallback vault */
  }
  return null;
}

async function walkMd(root: string): Promise<string[]> {
  const found: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip, keep walking elsewhere
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        // 'memory' holds a live SurrealKV datastore — never descend into it
        if (e.name.startsWith('.') || e.name === 'memory') continue;
        if (depth < MAX_DEPTH) await rec(join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        found.push(join(dir, e.name));
      }
    }
  }
  await rec(root, 0);
  return found;
}

/** Resolve a caller-supplied relative path against the live vault root and apply
 *  the lexical guards shared by read + write: stay under the vault, .md only, no
 *  memory/ dir. Returns the vault root and the resolved absolute path. Throws on
 *  any violation — routes map that to a 400 (a 'conflict:' prefix maps to 409). */
async function resolveInVault(rel: string): Promise<{ root: string; abs: string; relPath: string }> {
  if (!rel) throw new Error('missing note path');
  const vault = await findVault();
  if (!vault) throw new Error('no obsidian vault found');

  // lexical containment: resolve and require the result to stay under the vault
  const root = resolve(vault);
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep)) throw new Error('path escapes the vault');
  if (!abs.endsWith('.md')) throw new Error('only .md notes are allowed');

  const relPath = relative(root, abs);
  // 'memory' holds a live SurrealKV datastore — never follow into it (same rule as the walker)
  if (relPath.split(sep).includes('memory')) throw new Error('memory/ is off limits');

  return { root, abs, relPath };
}

/** Physical containment: a symlink inside the vault must not lead outside it.
 *  realpath of `target` (when it exists) has to stay under realpath(root). */
async function assertRealInVault(root: string, target: string, missingMsg: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error(missingMsg);
  }
  const realRoot = await realpath(root).catch(() => root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes the vault');
  }
  return real;
}

/** Read one note from the vault for the in-app reader (GET /api/notes/read).
 *  Shares findVault() with the collector so both resolve the same root. Throws
 *  on any violation — the route maps that to a 400. */
export async function readNote(
  rel: string,
): Promise<{ path: string; title: string; content: string; modifiedAt: string }> {
  const { root, abs, relPath } = await resolveInVault(rel);

  // physical containment: a symlink inside the vault must not lead outside it
  const real = await assertRealInVault(root, abs, 'note not found');

  const st = await stat(real);
  if (!st.isFile()) throw new Error('not a file');

  let content: string;
  if (st.size > READ_CAP_BYTES) {
    const fh = await open(real, 'r');
    try {
      const buf = Buffer.alloc(READ_CAP_BYTES);
      const { bytesRead } = await fh.read(buf, 0, READ_CAP_BYTES, 0);
      content = buf.subarray(0, bytesRead).toString('utf8') + '\n\n[truncated]';
    } finally {
      await fh.close();
    }
  } else {
    content = await readFile(real, 'utf8');
  }

  return {
    path: relPath,
    title: relPath.split(sep).pop()!.replace(/\.md$/, ''),
    content,
    modifiedAt: iso(st.mtimeMs),
  };
}

/** Write one note back to the vault (POST /api/notes/write). Same containment as
 *  readNote: stays under the vault root, .md only, no traversal, no symlink escape,
 *  no memory/ dir. Editing an existing note OR creating a new one is allowed as long
 *  as it resolves inside the vault and ends .md. Optimistic concurrency: when
 *  baseModifiedAt is given, a newer on-disk mtime OR a target that no longer exists
 *  throws a 'conflict:' error (route → 409); an unparseable baseModifiedAt is a 400.
 *  A truly-new note (no baseModifiedAt) is a fresh create. Writes atomically (tmp in
 *  the same dir + rename). Returns the new mtime ISO. Body fields only — no
 *  token/secret ever touches this path. */
export async function writeNote(
  body: any,
): Promise<{ ok: true; modifiedAt: string }> {
  const rel = body?.path;
  const content = body?.content;
  const baseModifiedAt = body?.baseModifiedAt;
  if (typeof rel !== 'string' || !rel) throw new Error('missing note path');
  if (typeof content !== 'string') throw new Error('missing note content');
  // size cap on the bytes we actually write, not the JS string length
  if (Buffer.byteLength(content, 'utf8') > WRITE_CAP_BYTES) {
    throw new Error('note too large (512KB max)');
  }

  const { root, abs } = await resolveInVault(rel);

  // physical containment. The file may not exist yet (a new note), in which case the
  // parent dir must already exist and resolve inside the vault — we never mkdir new
  // trees and never create a file outside the vault via a symlinked parent.
  let existed = false;
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error('target is not a file');
    existed = true;
  } catch (err) {
    if (err instanceof Error && err.message === 'target is not a file') throw err;
    existed = false;
  }

  // the tmp file is created in — and renamed within — the parent dir, so the parent's
  // realpath must stay inside the vault in BOTH cases (a symlinked dir could escape).
  await assertRealInVault(root, dirname(abs), 'note folder does not exist');

  if (existed) {
    // an existing target must also not itself be a symlink leading out of the vault
    await assertRealInVault(root, abs, 'note not found');
  }

  if (baseModifiedAt) {
    const base = new Date(baseModifiedAt).getTime();
    // a garbage/unparseable base must fail loudly, not silently disable the guard
    if (Number.isNaN(base)) throw new Error('invalid baseModifiedAt');
    // the client only sends baseModifiedAt when it had the note open, so a missing
    // target now means the file was deleted/renamed out from under it — a real conflict
    if (!existed) {
      throw new Error('conflict: file was removed on disk since you opened it');
    }
    const cur = (await stat(abs)).mtimeMs;
    // a millisecond of slop guards float/serialization jitter; anything newer is a real edit
    if (cur - base > 1) {
      throw new Error('conflict: file changed on disk since you opened it');
    }
  }

  // atomic write: tmp in the SAME dir (so rename is atomic on one filesystem) + rename
  const tmp = `${abs}.atrium-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // don't leave a stray .tmp behind
    throw err;
  }

  const st = await stat(abs);
  return { ok: true, modifiedAt: iso(st.mtimeMs) };
}

async function run(): Promise<void> {
  const state: NotesState = { updatedAt: iso(), vaultPath: null, recent: [], error: null };

  try {
    const vault = await findVault();
    if (!vault) {
      state.error = 'no obsidian vault found';
      store.setSection('notes', state);
      return;
    }
    state.vaultPath = vault;

    const files = await walkMd(vault);
    const stats = await Promise.all(
      files.map(async (abs) => {
        try {
          return { abs, mtimeMs: (await stat(abs)).mtimeMs };
        } catch {
          return null; // deleted mid-walk
        }
      }),
    );
    state.recent = stats
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 15)
      .map((s) => ({
        path: relative(vault, s.abs),
        title: s.abs.split('/').pop()!.replace(/\.md$/, ''),
        modifiedAt: iso(s.mtimeMs),
      }));
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  store.setSection('notes', state);
}

const collector: Collector = { name: 'notes', intervalMs: config.poll.notesMs, run };
export default collector;
