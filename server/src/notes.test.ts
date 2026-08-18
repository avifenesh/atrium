import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { selectNewest, walkNotes } from './collectors/notes.js';

// The notes walk is the only thing standing between the owner's real note piles and
// the snapshot, and both of its bounds used to lie: a depth wall dropped whole
// subtrees while reporting truncated:false, and the file cap kept whatever the
// directory order handed over first. These pin both — the depth a real agent-export
// tree actually uses, and recency deciding who survives the cap.

/** A chain of `depth` nested dirs under `base`, with one note at the bottom.
 *  Returns the note's path relative to `base`. */
async function nest(base: string, depth: number, name: string): Promise<string> {
  const parts = Array.from({ length: depth }, (_v, i) => `d${i + 1}`);
  const dir = join(base, ...parts);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `# ${name}\n`, 'utf8');
  return [...parts, name].join(sep);
}

async function withFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-notes-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('walkNotes reaches notes nested deeper than the old depth-8 wall', async () => {
  await withFixture(async (dir) => {
    const deep = await nest(dir, 12, 'deep.md'); // codex exports really do nest 13 dirs down
    await writeFile(join(dir, 'top.md'), '# top\n', 'utf8');

    const { files, truncated } = await walkNotes({ id: 'fixture', label: 'Fixture', path: dir });
    const rel = files.map((f) => f.slice(dir.length + 1));

    assert.ok(rel.includes(deep), `deep note missing from walk: ${JSON.stringify(rel)}`);
    assert.ok(rel.includes('top.md'));
    // nothing was left on the floor, so the root must not claim to be incomplete
    assert.equal(truncated, false);
  });
});

test('walkNotes prunes hidden dirs and non-note files', async () => {
  await withFixture(async (dir) => {
    await mkdir(join(dir, '.obsidian'), { recursive: true });
    await writeFile(join(dir, '.obsidian', 'workspace.md'), 'x\n', 'utf8');
    await writeFile(join(dir, 'note.md'), 'x\n', 'utf8');
    await writeFile(join(dir, 'plain.txt'), 'x\n', 'utf8');
    await writeFile(join(dir, 'shot.png'), 'x\n', 'utf8');

    const { files } = await walkNotes({ id: 'fixture', label: 'Fixture', path: dir });
    const rel = files.map((f) => f.slice(dir.length + 1)).sort();

    assert.deepEqual(rel, ['note.md', 'plain.txt']);
  });
});

test('walkNotes flags truncation when a subtree sits below the depth wall', async () => {
  await withFixture(async (dir) => {
    await nest(dir, 25, 'too-deep.md'); // past MAX_DEPTH on purpose
    await writeFile(join(dir, 'top.md'), '# top\n', 'utf8');

    const { files, truncated } = await walkNotes({ id: 'fixture', label: 'Fixture', path: dir });
    const rel = files.map((f) => f.slice(dir.length + 1));

    assert.ok(rel.includes('top.md')); // the reachable part still comes back
    assert.ok(!rel.some((p) => p.endsWith('too-deep.md')));
    // the point: an incomplete list must say it is incomplete
    assert.equal(truncated, true);
  });
});

test('selectNewest keeps the newest notes, not the ones the directory order yielded first', () => {
  const entries = [
    { path: 'old-first-in-dir-order.md', mtimeMs: 1_000 },
    { path: 'middle.md', mtimeMs: 5_000 },
    { path: 'newest.md', mtimeMs: 9_000 },
  ];

  assert.deepEqual(
    selectNewest(entries, 2).map((e) => e.path),
    ['newest.md', 'middle.md'],
  );
  // under the budget everything survives, still newest-first for the global order
  assert.deepEqual(
    selectNewest(entries, 10).map((e) => e.path),
    ['newest.md', 'middle.md', 'old-first-in-dir-order.md'],
  );
  assert.deepEqual(selectNewest(entries, 0), []);
  assert.deepEqual(entries[0], { path: 'old-first-in-dir-order.md', mtimeMs: 1_000 }); // input untouched
});
