import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { readJson, iso } from '../util.js';
import type { Collector } from './registry.js';
import type { NotesState } from '../../../shared/types.js';

const MAX_DEPTH = 4;
const MAX_FILES = 2000;

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
