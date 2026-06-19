/**
 * Collide-vs-baseline comparison, ported faithfully from itch_ui.py:
 * _run_is_collide / _run_brief / _find_baseline_for / _baseline_candidates /
 * _compare_titles / _compare_payload, plus compare_key matching from itch_core.
 * Pure read-only over ~/.config/itch/runs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { normalizeRunMetadata } from './itch-engine.js';

type Paths = typeof config.paths;

const STEM_RE = /^\d{8}-\d{6}(?:-\d{3})?$/;
const IDEA_RE = /^#{1,3}\s+[A-Za-z]*\d+\.\s*(.+?)\s*$/;
const RESURFACE_RE = /^[↻⟳]\s*/;
const COLLIDE_TITLE_RE = /^\s*\[collide\]\s*/i;
const TITLE_WORD_RE = /[a-z0-9]+/g;
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'over', 'under', 'this', 'that', 'tool', 'tools', 'system', 'systems', 'app', 'local']);

function paths(): Paths { return config.paths; }

async function readJson<T = any>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

async function runStems(): Promise<string[]> {
  let files: string[] = [];
  try { files = await readdir(paths().itchRuns); } catch { return []; }
  return files.filter((f) => /^\d{8}-\d{6}(?:-\d{3})?\.md$/.test(f)).map((f) => f.slice(0, -3)).sort().reverse();
}

function mdPath(stem: string): string { return join(paths().itchRuns, `${stem}.md`); }
function metaPath(stem: string): string { return join(paths().itchRuns, `${stem}.meta.json`); }

async function readMeta(stem: string): Promise<Record<string, any>> {
  return (await readJson<Record<string, any>>(metaPath(stem))) ?? {};
}

async function readRunIdeaTitles(stem: string): Promise<string[]> {
  const text = await readFile(mdPath(stem), 'utf8').catch(() => '');
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const ln of text.split('\n')) {
    const m = ln.match(IDEA_RE);
    if (!m) continue;
    const t = m[1].trim().replace(RESURFACE_RE, '').trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); titles.push(t); }
  }
  return titles;
}

async function isCollide(stem: string, meta?: Record<string, any>): Promise<boolean> {
  const m = meta ?? (await readMeta(stem));
  const flags = m.flags && typeof m.flags === 'object' ? m.flags : {};
  if (typeof flags.collision_temp === 'number' && flags.collision_temp > 0) return true;
  const collideMeta = m.collide;
  if (collideMeta && typeof collideMeta === 'object') { if (collideMeta.enabled) return true; }
  else if (collideMeta) return true;
  const titles = await readRunIdeaTitles(stem);
  return titles.some((t) => COLLIDE_TITLE_RE.test(t));
}

async function runBrief(stem: string): Promise<any> {
  const meta = await readMeta(stem);
  const normalized = normalizeRunMetadata(meta);
  const titles = await readRunIdeaTitles(stem);
  const flags = meta.flags && typeof meta.flags === 'object' ? meta.flags : {};
  const normalizedTemp = normalized.collide.temperature;
  const temp = typeof flags.collision_temp === 'number' ? flags.collision_temp : normalizedTemp;
  return {
    stem,
    n_ideas: titles.length,
    is_collide: await isCollide(stem, meta),
    collision_temp: typeof temp === 'number' && Number.isFinite(temp) ? temp : null,
    model: meta.model ?? null,
    baseline_for: meta.baseline_for ?? null,
    has_meta: Object.keys(meta).length > 0,
    compare_key: meta.compare_key ?? null,
    sampled_domains: normalized.collide.sampled_domains,
    metadata: normalized,
  };
}

function titleKey(title: string): string {
  let t = title.replace(COLLIDE_TITLE_RE, '').toLowerCase();
  t = t.replace(RESURFACE_RE, '');
  const words = t.match(TITLE_WORD_RE) ?? [];
  return words.filter((w) => !TITLE_STOP.has(w)).join(' ');
}

function titleTokens(title: string): Set<string> {
  return new Set(titleKey(title).split(' ').filter((w) => w.length > 2));
}

// Faithful port of Python difflib.SequenceMatcher(None, a, b).ratio() over
// CHARACTERS. autojunk does not apply (it only triggers for len(b) >= 200; titles
// are short), and isjunk is None — matching the itch_ui.py call exactly.
// Verbatim port of CPython difflib.SequenceMatcher (isjunk=None, autojunk off
// since titles are short) — find_longest_match + get_matching_blocks + ratio.
class SequenceMatcher {
  private a: string;
  private b: string;
  private b2j = new Map<string, number[]>();
  constructor(a: string, b: string) {
    this.a = a; this.b = b;
    for (let i = 0; i < b.length; i++) {
      const arr = this.b2j.get(b[i]);
      if (arr) arr.push(i); else this.b2j.set(b[i], [i]);
    }
  }
  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
      }
      j2len = newj2len;
    }
    // No isjunk: difflib still tries to extend the match with equal elements on
    // both sides. With autojunk off and isjunk None, both while-loops run; they
    // never cross the [alo,ahi)/[blo,bhi) bounds, so blocks cannot overlap.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) { bestsize++; }
    return [besti, bestj, bestsize];
  }
  matchingBlocksTotal(): number {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
    let matched = 0;
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k > 0) {
        matched += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return matched;
  }
  ratio(): number {
    const total = this.a.length + this.b.length;
    if (!total) return 1;
    return (2 * this.matchingBlocksTotal()) / total;
  }
}

function seqRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}

export function titleSimilarity(a: string, b: string): number {
  const ak = titleKey(a); const bk = titleKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;
  const seq = seqRatio(ak, bk);
  const at = titleTokens(a); const bt = titleTokens(b);
  const uni = new Set([...at, ...bt]);
  let interCount = 0;
  for (const x of at) if (bt.has(x)) interCount++;
  const jacc = uni.size ? interCount / uni.size : 0;
  return Math.max(seq, jacc);
}

async function findBaselineFor(sourceStem: string, sourceMeta: Record<string, any>): Promise<string | null> {
  const sourceKey = sourceMeta.compare_key;
  for (const stem of await runStems()) {
    if (stem === sourceStem) continue;
    const meta = await readMeta(stem);
    if (meta.baseline_for === sourceStem && !(await isCollide(stem, meta))) return stem;
  }
  if (sourceKey) {
    for (const stem of await runStems()) {
      if (stem === sourceStem) continue;
      const meta = await readMeta(stem);
      if (meta.compare_key === sourceKey && !(await isCollide(stem, meta))) return stem;
    }
  }
  return null;
}

async function baselineCandidates(sourceStem: string, sourceMeta: Record<string, any>): Promise<any[]> {
  const sourceKey = sourceMeta.compare_key;
  const out: any[] = [];
  for (const stem of await runStems()) {
    if (stem === sourceStem) continue;
    const meta = await readMeta(stem);
    if (await isCollide(stem, meta)) continue;
    const matched = !!(sourceKey && meta.compare_key === sourceKey);
    if (sourceKey && !matched) continue;
    const brief = await runBrief(stem); brief.matched = matched; out.push(brief);
    if (out.length >= 12) break;
  }
  if (out.length || sourceKey) return out;
  for (const stem of await runStems()) {
    if (stem === sourceStem) continue;
    const meta = await readMeta(stem);
    if (await isCollide(stem, meta)) continue;
    const brief = await runBrief(stem); brief.matched = false; out.push(brief);
    if (out.length >= 12) break;
  }
  return out;
}

async function compareTitles(sourceStem: string, baselineStem: string): Promise<any> {
  const sourceTitles = await readRunIdeaTitles(sourceStem);
  const baselineTitles = await readRunIdeaTitles(baselineStem);
  const pairs: [number, number, number][] = [];
  for (let si = 0; si < sourceTitles.length; si++) {
    for (let bi = 0; bi < baselineTitles.length; bi++) {
      const score = titleSimilarity(sourceTitles[si], baselineTitles[bi]);
      if (score >= 0.72) pairs.push([score, si, bi]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const usedS = new Set<number>(); const usedB = new Set<number>();
  const overlap: any[] = [];
  for (const [score, si, bi] of pairs) {
    if (usedS.has(si) || usedB.has(bi)) continue;
    usedS.add(si); usedB.add(bi);
    overlap.push({ source_idx: si, source_title: sourceTitles[si], baseline_idx: bi, baseline_title: baselineTitles[bi], score: Math.round(score * 1000) / 1000 });
  }
  const sourceUnique = sourceTitles.map((t, i) => ({ idx: i, title: t })).filter((x) => !usedS.has(x.idx));
  const baselineUnique = baselineTitles.map((t, i) => ({ idx: i, title: t })).filter((x) => !usedB.has(x.idx));
  const denom = Math.max(sourceTitles.length, baselineTitles.length, 1);
  return {
    summary: {
      source_count: sourceTitles.length,
      baseline_count: baselineTitles.length,
      overlap_count: overlap.length,
      source_unique_count: sourceUnique.length,
      baseline_unique_count: baselineUnique.length,
      overlap_ratio: Math.round((overlap.length / denom) * 1000) / 1000,
    },
    overlap,
    source_unique: sourceUnique,
    baseline_unique: baselineUnique,
  };
}

export async function comparePayload(sourceStem: string, baselineStem?: string | null): Promise<any> {
  if (!STEM_RE.test(sourceStem)) return { status: 'not_collide', source: null, error: 'bad stem' };
  const sourceMeta = await readMeta(sourceStem);
  const source = await runBrief(sourceStem);
  if (!source.is_collide) {
    return { status: 'not_collide', source, baseline: null, can_launch_baseline: false, launch_blocked_reason: 'selected run does not look like a collide run', candidates: [], summary: null, overlap: [], source_unique: [], baseline_unique: [] };
  }
  let baseline: string | null;
  if (baselineStem && STEM_RE.test(baselineStem) && baselineStem !== sourceStem) baseline = baselineStem;
  else baseline = await findBaselineFor(sourceStem, sourceMeta);
  const candidates = await baselineCandidates(sourceStem, sourceMeta);
  const sourceFlags = sourceMeta.flags && typeof sourceMeta.flags === 'object' ? sourceMeta.flags : {};
  const canLaunch = !!sourceMeta.compare_key && !sourceFlags.no_history;
  let launchBlocked: string | null = null;
  if (!Object.keys(sourceMeta).length) launchBlocked = 'run was saved before compare metadata existed; choose a baseline manually';
  else if (sourceFlags.no_history) launchBlocked = 'source run used no-history, so an auto-launched baseline would not be saved';
  if (!baseline) {
    return { status: 'missing_baseline', source, baseline: null, can_launch_baseline: canLaunch, launch_blocked_reason: launchBlocked, candidates, summary: null, overlap: [], source_unique: [], baseline_unique: [] };
  }
  const diff = await compareTitles(sourceStem, baseline);
  return { status: 'ready', source, baseline: await runBrief(baseline), can_launch_baseline: false, launch_blocked_reason: null, candidates, ...diff };
}

/** Build the flags for an exact-baseline run of a collide source (collision_temp
 * omitted, orbit carried through, history pinned before the source). */
export async function baselineLaunchFlags(sourceStem: string): Promise<{ ok: boolean; flags?: Record<string, unknown>; error?: string; existing?: string }> {
  if (!STEM_RE.test(sourceStem)) return { ok: false, error: 'bad stem' };
  const meta = await readMeta(sourceStem);
  if (!(await isCollide(sourceStem, meta))) return { ok: false, error: 'selected run does not look like a collide run' };
  const existing = await findBaselineFor(sourceStem, meta);
  if (existing) return { ok: true, existing };
  const flags = meta.flags && typeof meta.flags === 'object' ? meta.flags : {};
  if (flags.no_history) return { ok: false, error: 'source run used no-history, so a baseline would not be saved' };
  return {
    ok: true,
    flags: {
      no_gh: !!flags.no_gh,
      no_local: !!flags.no_local,
      no_history: !!flags.no_history,
      fresh: !!flags.fresh,
      market: !!flags.market,
      model: meta.model,
      orbit: flags.orbit ?? null,           // baseline of an orbit run focuses the SAME center
      owners: Array.isArray(meta.owners) ? meta.owners : undefined,
      work: Array.isArray(meta.work) ? meta.work : undefined,
      projects_dir: meta.projects_dir,
      history_before: sourceStem,            // do not let the collide run leak into history
      baseline_for: sourceStem,
      // collision_temp intentionally omitted -> exact baseline path
    },
  };
}
