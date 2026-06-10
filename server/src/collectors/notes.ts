import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { readJson, iso } from '../util.js';
import type { Collector } from './registry.js';
import type { NotesState } from '../../../shared/types.js';

const MAX_DEPTH = 4;
const MAX_FILES = 2000;
const READ_CAP_BYTES = 512 * 1024;

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

/** Read one note from the vault for the in-app reader (GET /api/notes/read).
 *  Shares findVault() with the collector so both resolve the same root. Throws
 *  on any violation — the route maps that to a 400. */
export async function readNote(
  rel: string,
): Promise<{ path: string; title: string; content: string; modifiedAt: string }> {
  if (!rel) throw new Error('missing note path');
  const vault = await findVault();
  if (!vault) throw new Error('no obsidian vault found');

  // lexical containment: resolve and require the result to stay under the vault
  const root = resolve(vault);
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep)) throw new Error('path escapes the vault');
  if (!abs.endsWith('.md')) throw new Error('only .md notes are readable');

  const relPath = relative(root, abs);
  // 'memory' holds a live SurrealKV datastore — never follow into it (same rule as the walker)
  if (relPath.split(sep).includes('memory')) throw new Error('memory/ is not readable');

  // physical containment: a symlink inside the vault must not lead outside it
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error('note not found');
  }
  const realRoot = await realpath(root).catch(() => root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes the vault');
  }

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
