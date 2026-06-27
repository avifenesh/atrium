import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { ItchRunInfo } from '../../../shared/types.js';

const IDEA_RE = /^#{1,3}\s+[A-Za-z]*\d+\.\s*(.+?)\s*$/;
const RESURFACE_RE = /^[↻⟳]\s*/;

type Paths = Pick<Config['paths'], 'itchConfig' | 'itchRuns'>;

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function ideaTitles(markdown: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(IDEA_RE);
    if (!m) continue;
    const title = m[1].trim().replace(RESURFACE_RE, '').trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

async function loadLedger(paths: Paths): Promise<Record<string, any>> {
  const raw = await readJson<Record<string, any>>(join(paths.itchConfig, 'decisions.json'));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function runInfo(stem: string, markdown: string, meta: any, ledger: Record<string, any>): ItchRunInfo {
  const titles = ideaTitles(markdown);
  const flags = meta?.flags && typeof meta.flags === 'object' ? meta.flags : {};
  const collisionTemp = asNumber(flags.collision_temp) ?? asNumber(meta?.collision_temp);
  const sampledDomains = asStringArray(meta?.sampled_domains);
  const baselineFor = typeof meta?.baseline_for === 'string' ? meta.baseline_for : null;
  const isCollide = Boolean(meta?.collide) || collisionTemp !== null || titles.some((t) => /^\[collide\]/i.test(t));
  const nRated = titles.filter((t) => {
    const ent = ledger[t.toLowerCase()];
    return ent && ent.rating !== null && ent.rating !== undefined;
  }).length;
  return { stem, nIdeas: titles.length, nRated, isCollide, collisionTemp, sampledDomains, baselineFor };
}

/** Load the itch run journal directly from ~/.config/itch.
 *
 * This is the first migrated slice of itch core inside Atrium: the dashboard no
 * longer needs to ask the Python itch API for immutable run-list state. The
 * long-running research process is still delegated during the transition.
 */
export async function loadItchRuns(paths: Paths): Promise<ItchRunInfo[]> {
  const ledger = await loadLedger(paths);
  let entries: string[] = [];
  try {
    entries = await readdir(paths.itchRuns);
  } catch {
    return [];
  }
  const stems = entries
    .filter((f) => /^\d{8}-\d{6}(?:-\d{3})?\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort()
    .reverse();

  const out: ItchRunInfo[] = [];
  for (const stem of stems) {
    const mdPath = join(paths.itchRuns, `${stem}.md`);
    const [markdown, meta] = await Promise.all([
      readFile(mdPath, 'utf8').catch(() => ''),
      readJson<any>(join(paths.itchRuns, `${stem}.meta.json`)),
    ]);
    out.push(runInfo(stem, markdown, meta ?? {}, ledger));
  }
  return out;
}

export async function loadItchRatedTotal(paths: Paths): Promise<number | null> {
  const ledger = await loadLedger(paths);
  return Object.keys(ledger).length;
}

export async function loadItchJournal(paths: Paths): Promise<{ runs: ItchRunInfo[]; ratedTotal: number | null }> {
  const [runs, ratedTotal] = await Promise.all([loadItchRuns(paths), loadItchRatedTotal(paths)]);
  return { runs, ratedTotal };
}


type ResourceName = 'interests' | 'rules' | 'work';

function resourcePath(paths: Paths, name: ResourceName): string {
  if (name === 'interests') return join(paths.itchConfig, 'interests.md');
  if (name === 'rules') return join(paths.itchConfig, 'rules.md');
  return join(paths.itchConfig, 'work.txt');
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export async function loadItchApiRuns(paths: Paths): Promise<any[]> {
  return (await loadItchRuns(paths)).map((r) => ({
    stem: r.stem,
    n_ideas: r.nIdeas,
    n_rated: r.nRated,
    is_collide: r.isCollide,
    collision_temp: r.collisionTemp,
    sampled_domains: r.sampledDomains,
    baseline_for: r.baselineFor,
    has_meta: true,
    metadata: {},
  }));
}

export async function loadItchDecisions(paths: Paths): Promise<any[]> {
  const ledger = await loadLedger(paths);
  const stems = (await loadItchRuns(paths)).map((r) => r.stem);
  const idx = new Map(stems.map((stem, i) => [stem, i]));
  return Object.values(ledger)
    .filter((d: any) => d && typeof d === 'object')
    .map((d: any) => ({
      title: typeof d.title === 'string' ? d.title : '',
      rating: asNumber(d.rating) ?? null,
      note: typeof d.note === 'string' ? d.note : null,
      as_of: typeof d.as_of === 'string' ? d.as_of : '',
      age: idx.get(typeof d.as_of === 'string' ? d.as_of : '') ?? 999,
      outcome: typeof d.outcome === 'string' ? d.outcome : null,
      outcome_note: typeof d.outcome_note === 'string' ? d.outcome_note : null,
      metadata: {},
    }))
    .filter((d) => d.title)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.title.localeCompare(b.title));
}

export async function saveItchRating(paths: Paths, payload: any): Promise<void> {
  const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
  if (!title) throw new Error('missing title');
  const ledger = await loadLedger(paths);
  const newest = (await loadItchRuns(paths))[0]?.stem ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const key = title.toLowerCase();
  const ent = ledger[key] && typeof ledger[key] === 'object'
    ? { ...ledger[key] }
    : { title, rating: null, note: null, as_of: newest };
  ent.title = title;
  if ('rating' in payload) ent.rating = payload.rating === null ? null : asNumber(payload.rating);
  if ('note' in payload) ent.note = typeof payload.note === 'string' && payload.note ? payload.note : null;
  if ('outcome' in payload) ent.outcome = typeof payload.outcome === 'string' && payload.outcome ? payload.outcome : null;
  if ('outcome_note' in payload) ent.outcome_note = typeof payload.outcome_note === 'string' && payload.outcome_note ? payload.outcome_note : null;
  ent.as_of = newest;
  if (ent.rating === null && !ent.note && !ent.outcome && !ent.outcome_note) delete ledger[key];
  else ledger[key] = ent;
  await atomicWrite(join(paths.itchConfig, 'decisions.json'), JSON.stringify(ledger, null, 2));
}

export async function loadItchResource(paths: Paths, name: ResourceName): Promise<string> {
  try {
    return await readFile(resourcePath(paths, name), 'utf8');
  } catch {
    return '';
  }
}

export async function saveItchResource(paths: Paths, name: ResourceName, text: string): Promise<void> {
  await atomicWrite(resourcePath(paths, name), text);
}

export function isItchResourceName(v: string): v is ResourceName {
  return v === 'interests' || v === 'rules' || v === 'work';
}

const STEM_RE = /^\d{8}-\d{6}(?:-\d{3})?$/;

function parseRunIdeas(markdown: string, ledger: Record<string, any>) {
  const lines = markdown.split(/\r?\n/);
  const preamble: string[] = [];
  const ideas: any[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(IDEA_RE);
    if (m) {
      if (current) ideas.push(current);
      current = { title: m[1].trim().replace(RESURFACE_RE, '').trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) ideas.push(current);
  return {
    preamble: preamble.join('\n').trim(),
    ideas: ideas.map((it, i) => {
      const ent = ledger[it.title.toLowerCase()] ?? {};
      return {
        idx: i,
        title: it.title,
        body: it.body.join('\n').trim(),
        metadata: { source_urls: Array.from(new Set((it.body.join('\n').match(/https?:\/\/[^\s)\]]+/g) ?? []))) },
        rating: asNumber(ent.rating) ?? null,
        note: typeof ent.note === 'string' ? ent.note : null,
        outcome: typeof ent.outcome === 'string' ? ent.outcome : null,
        outcome_note: typeof ent.outcome_note === 'string' ? ent.outcome_note : null,
      };
    }),
  };
}

export async function loadItchRunDetail(paths: Paths, stem: string): Promise<any | null> {
  if (!STEM_RE.test(stem)) return null;
  let markdown: string;
  try {
    markdown = await readFile(join(paths.itchRuns, `${stem}.md`), 'utf8');
  } catch {
    return null;
  }
  const ledger = await loadLedger(paths);
  const parsed = parseRunIdeas(markdown, ledger);
  const structured = await readJson<any>(join(paths.itchRuns, `${stem}.ideas.json`));
  return {
    stem,
    preamble: parsed.preamble,
    footer: '',
    ideas: parsed.ideas,
    structured: structured && typeof structured === 'object' ? structured : null,
  };
}

// ---------- idea buckets (decisions by rank + the unrated "undecided" pile) ----------
// the decisions ledger only holds RATED ideas (and only title/rating/note/as_of) —
// to show a scrollable, full-context page per rank AND a page of everything still
// undecided, we aggregate the run files themselves: every idea, deduped by title
// (newest run wins, runs are newest-first), carrying its body + structured sidecar
// row + run stem so the same IdeaCard the feed renders works on a bucket page.

export type IdeaBucketKey = '5' | '4' | '3' | '2' | '1' | 'undecided';
const IDEA_BUCKETS: IdeaBucketKey[] = ['5', '4', '3', '2', '1', 'undecided'];

export function isIdeaBucketKey(v: string): v is IdeaBucketKey {
  return (IDEA_BUCKETS as string[]).includes(v);
}

// mirror the web util's structuredFor: exact title, then resurface-marker-stripped
function structuredForTitle(structured: any, title: string): any {
  const ideas = structured?.ideas;
  if (!Array.isArray(ideas) || ideas.length === 0) return null;
  const exact = ideas.find((i: any) => i?.title === title);
  if (exact) return exact;
  const stripped = title.trim().replace(RESURFACE_RE, '').trim();
  return ideas.find((i: any) => i?.title === stripped) ?? null;
}

async function aggregateIdeaBuckets(paths: Paths): Promise<Record<IdeaBucketKey, any[]>> {
  const runs = await loadItchRuns(paths); // newest first
  const buckets: Record<IdeaBucketKey, any[]> = { '5': [], '4': [], '3': [], '2': [], '1': [], undecided: [] };
  const seen = new Set<string>();
  for (const run of runs) {
    const detail = await loadItchRunDetail(paths, run.stem);
    if (!detail) continue;
    for (const idea of detail.ideas) {
      const key = idea.title.toLowerCase();
      if (seen.has(key)) continue; // an idea resurfaces across runs — keep the newest instance
      seen.add(key);
      const r = idea.rating;
      const bucket: IdeaBucketKey =
        r === 5 || r === 4 || r === 3 || r === 2 || r === 1 ? (String(r) as IdeaBucketKey) : 'undecided';
      buckets[bucket].push({
        stem: run.stem,
        idx: idea.idx,
        title: idea.title,
        body: idea.body,
        metadata: idea.metadata,
        rating: idea.rating,
        note: idea.note,
        outcome: idea.outcome,
        outcome_note: idea.outcome_note,
        structured: structuredForTitle(detail.structured, idea.title),
      });
    }
  }
  return buckets;
}

export async function loadItchIdeaBucketCounts(paths: Paths): Promise<Record<IdeaBucketKey, number>> {
  const b = await aggregateIdeaBuckets(paths);
  return { '5': b['5'].length, '4': b['4'].length, '3': b['3'].length, '2': b['2'].length, '1': b['1'].length, undecided: b.undecided.length };
}

export async function loadItchIdeaBucket(paths: Paths, bucket: string): Promise<{ bucket: IdeaBucketKey; entries: any[] } | null> {
  if (!isIdeaBucketKey(bucket)) return null;
  const b = await aggregateIdeaBuckets(paths);
  return { bucket, entries: b[bucket] };
}

function snippetFor(text: string, q: string): string {
  const lower = text.toLowerCase();
  const i = lower.indexOf(q.toLowerCase());
  if (i < 0) return text.trim().slice(0, 180);
  const start = Math.max(0, i - 60);
  return text.slice(start, start + 220).trim();
}

export async function searchItchIdeas(paths: Paths, query: string): Promise<any[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const runs = await loadItchRuns(paths);
  const ledger = await loadLedger(paths);
  const out: any[] = [];
  for (const run of runs) {
    const detail = await loadItchRunDetail(paths, run.stem);
    if (!detail) continue;
    for (const idea of detail.ideas) {
      const hay = `${idea.title}\n${idea.body}`;
      if (!hay.toLowerCase().includes(q)) continue;
      const ent = ledger[idea.title.toLowerCase()] ?? {};
      out.push({
        stem: run.stem,
        idx: idea.idx,
        title: idea.title,
        snippet: snippetFor(hay, q),
        rating: idea.rating,
        note: idea.note,
        as_of: typeof ent.as_of === 'string' ? ent.as_of : null,
        metadata: idea.metadata,
      });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

function renderRunMarkdown(preamble: string, ideas: { title: string; body: string }[], footer = ''): string {
  const chunks: string[] = [];
  if (preamble.trim()) chunks.push(preamble.trim());
  ideas.forEach((idea, i) => {
    chunks.push(`## ${i + 1}. ${idea.title.trim()}\n\n${idea.body.trim()}`.trimEnd());
  });
  if (footer.trim()) chunks.push(footer.trim());
  return chunks.join('\n\n') + '\n';
}

async function readRunForMutation(paths: Paths, stem: string): Promise<{ preamble: string; ideas: { title: string; body: string }[] } | null> {
  if (!STEM_RE.test(stem)) return null;
  let markdown: string;
  try {
    markdown = await readFile(join(paths.itchRuns, `${stem}.md`), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseRunIdeas(markdown, {});
  return {
    preamble: parsed.preamble,
    ideas: parsed.ideas.map((it: any) => ({ title: it.title, body: it.body })),
  };
}

export async function addItchIdea(paths: Paths, stem: string, title: string, body = ''): Promise<any | null> {
  const run = await readRunForMutation(paths, stem);
  if (!run) return null;
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error('missing title');
  run.ideas.push({ title: cleanTitle, body });
  await atomicWrite(join(paths.itchRuns, `${stem}.md`), renderRunMarkdown(run.preamble, run.ideas));
  return loadItchRunDetail(paths, stem);
}

export async function deleteItchIdea(paths: Paths, stem: string, idx: number): Promise<any | null> {
  const run = await readRunForMutation(paths, stem);
  if (!run) return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= run.ideas.length) throw new Error('bad idea idx');
  run.ideas.splice(idx, 1);
  await atomicWrite(join(paths.itchRuns, `${stem}.md`), renderRunMarkdown(run.preamble, run.ideas));
  return loadItchRunDetail(paths, stem);
}

export async function deleteItchRun(paths: Paths, stem: string): Promise<boolean> {
  if (!STEM_RE.test(stem)) return false;
  let deleted = false;
  for (const suffix of ['.md', '.meta.json', '.ideas.json']) {
    try {
      await unlink(join(paths.itchRuns, `${stem}${suffix}`));
      deleted = true;
    } catch {
      // absent sidecars are fine
    }
  }
  return deleted;
}

const MODELS = [
  { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Bedrock)' },
  { id: 'us.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8 (Bedrock)' },
  { id: 'global.anthropic.claude-fable-5', label: 'Claude Fable 5 (Bedrock)' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (Bedrock)' },
  { id: 'openai.gpt-5.5', label: 'GPT 5.5 (Codex · Bedrock)' },
  { id: 'eigen:llama/aviary-local-qwen', label: 'Local — Qwen (Eigen · llama.cpp)' },
  { id: 'eigen:llama/aviary-local-qwen-trained', label: 'Local — Qwen trained (Eigen · llama.cpp)' },
];
const DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6';

async function loadPrefs(paths: Paths): Promise<Record<string, any>> {
  return (await readJson<Record<string, any>>(join(paths.itchConfig, 'prefs.json'))) ?? {};
}

export async function loadItchModels(paths: Paths): Promise<{ models: typeof MODELS; default: string; selected: string }> {
  const prefs = await loadPrefs(paths);
  const selected = typeof prefs.model === 'string' && MODELS.some((m) => m.id === prefs.model) ? prefs.model : DEFAULT_MODEL;
  return { models: MODELS, default: DEFAULT_MODEL, selected };
}

export async function saveItchModel(paths: Paths, model: string): Promise<string> {
  if (!MODELS.some((m) => m.id === model) && !model.startsWith('eigen:') && !model.startsWith('pi:')) {
    throw new Error('unknown model');
  }
  const prefs = await loadPrefs(paths);
  prefs.model = model;
  await atomicWrite(join(paths.itchConfig, 'prefs.json'), JSON.stringify(prefs, null, 2));
  return model;
}

export async function loadItchFilters(paths: Paths): Promise<Record<string, unknown>> {
  const data = await readJson<Record<string, unknown>>(join(paths.itchConfig, 'filters.json'));
  return {
    interpretation: typeof data?.interpretation === 'string' ? data.interpretation : '',
    hide_titles: Array.isArray(data?.hide_titles) ? data.hide_titles.filter((x) => typeof x === 'string') : [],
    hide_terms: Array.isArray(data?.hide_terms) ? data.hide_terms.filter((x) => typeof x === 'string') : [],
    boost_terms: Array.isArray(data?.boost_terms) ? data.boost_terms.filter((x) => typeof x === 'string') : [],
    rule_text: typeof data?.rule_text === 'string' ? data.rule_text : '',
    explanation: typeof data?.explanation === 'string' ? data.explanation : '',
    ts: typeof data?.ts === 'string' ? data.ts : '',
  };
}

export async function clearItchFilters(paths: Paths): Promise<void> {
  try { await unlink(join(paths.itchConfig, 'filters.json')); } catch { /* absent is ok */ }
}

const SCOPE_FILE_RE = /^[A-Za-z0-9._-]+\.md$/;

function scopeTitle(content: string, fallback: string): string {
  const first = content.split(/\r?\n/).find((line) => line.startsWith('# '));
  return first ? first.slice(2).trim() : fallback.replace(/\.md$/, '').replace(/^\d{8}-\d{6}(?:-\d{3})?--/, '').replace(/-/g, ' ');
}

export async function listItchScopes(paths: Paths): Promise<{ scopes: any[] }> {
  const dir = join(paths.itchConfig, 'scopes');
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return { scopes: [] }; }
  const scopes = [];
  for (const file of files.filter((f) => SCOPE_FILE_RE.test(f))) {
    const content = await readFile(join(dir, file), 'utf8').catch(() => '');
    const stem = file.match(/^(\d{8}-\d{6}(?:-\d{3})?)--/)?.[1] ?? '';
    scopes.push({ file, stem, title: scopeTitle(content, file), mtime: '' });
  }
  scopes.sort((a, b) => b.file.localeCompare(a.file));
  return { scopes };
}

export async function loadItchScope(paths: Paths, file: string): Promise<any | null> {
  if (!SCOPE_FILE_RE.test(file) || file.includes('..') || file.includes('/')) return null;
  const content = await readFile(join(paths.itchConfig, 'scopes', file), 'utf8').catch(() => null);
  if (content === null) return null;
  return { file, title: scopeTitle(content, file), content };
}

export async function saveItchFilters(paths: Paths, payload: Record<string, unknown>): Promise<void> {
  await atomicWrite(join(paths.itchConfig, 'filters.json'), JSON.stringify(payload, null, 2));
}

function slugTitle(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'idea';
}

export async function saveItchScope(paths: Paths, stem: string, title: string, markdown: string): Promise<string> {
  const dir = join(paths.itchConfig, 'scopes');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const file = `${stem}--${slugTitle(title)}.md`;
  const path = join(dir, file);
  await atomicWrite(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return path;
}
