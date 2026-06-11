// itch — the idea scout, folded into the dashboard. everything below talks to the
// local itch ui server through the atrium proxy at /api/itch/* (same origin; the
// proxy injects the csrf header and strips browser origin/referer server-side).

// ---------- upstream shapes (proxied 1:1 from the itch server) ----------

export interface IdeaMeta {
  collide?: boolean;
  sampled_domain?: string;
  bridge?: string;
  source_urls?: string[];
}

export interface RunIdea {
  idx: number;
  title: string;
  body: string;
  metadata: IdeaMeta;
  rating: number | null;
  note: string | null;
  outcome: string | null;
  outcome_note: string | null;
}

export interface RunDetail {
  stem: string;
  preamble: string;
  footer: string;
  ideas: RunIdea[];
}

export interface Decision {
  title: string;
  rating: number;
  note: string | null;
  as_of: string;
  age: number;
  metadata: IdeaMeta;
}

export interface SearchHit {
  stem: string;
  idx: number;
  title: string;
  snippet: string;
  rating: number | null;
  note: string | null;
  as_of: string;
}

export interface ResearchStatus {
  running: boolean;
  started: string | null;
  log: string[];
  log_offset: number;
  log_truncated: boolean;
  partial: string;
  lines: number;
  exit_code: number | null;
  saved_stem: string | null;
  killed_reason: string | null;
}

// ---------- tiny typed fetch helpers ----------

const BASE = '/api/itch';

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `itch ${res.status}`);
  // an aborted body read on an OK response resolves null — re-raise it as the abort
  // it is, so callers' abort guards swallow it instead of rendering null data
  if (body === null) throw new DOMException('aborted', 'AbortError');
  return body as T;
}

/** mutations return the status so callers can treat 409 as a state, not a failure. */
export async function mutate(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------- per-endpoint helpers (thin typed wrappers over the proxy routes) ----------

export function getRunDetail(stem: string, signal?: AbortSignal): Promise<RunDetail> {
  return getJson<RunDetail>(`/run/${encodeURIComponent(stem)}`, signal);
}

export function searchIdeas(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  return getJson<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`, signal);
}

export function getDecisions(signal?: AbortSignal): Promise<Decision[]> {
  return getJson<Decision[]>('/decisions', signal);
}

export function getResearchStatus(since: number, signal?: AbortSignal): Promise<ResearchStatus> {
  return getJson<ResearchStatus>(`/research/status?since=${since}`, signal);
}

export function startResearch(flags: Record<string, boolean | number | string>) {
  return mutate('POST', '/research/start', { flags });
}

export function stopResearch() {
  return mutate('POST', '/research/stop');
}

/** rating/note/outcome upsert is title-keyed — callers MUST send the ORIGINAL exact title.
 *  outcome: 'dropped' | 'finished' | 'maintaining' | null (null clears outcome + outcome_note). */
export function putRating(payload: {
  title: string;
  rating?: number | null;
  note?: string | null;
  outcome?: string | null;
  outcome_note?: string | null;
}) {
  return mutate('PUT', '/rating', payload);
}

// ---------- side tools (oneshots are synchronous upstream, 120-600s — callers show busy
// states and treat 409 'another AI action is already running' as a quiet state) ----------

export function askIdea(payload: { title: string; body?: string; question: string; model?: string }) {
  return mutate('POST', '/ask', payload) as Promise<{ status: number; body: { answer?: string; error?: string } | null }>;
}

export function roadmapIdea(payload: { title: string; body?: string; model?: string }) {
  return mutate('POST', '/roadmap', payload) as Promise<{ status: number; body: { roadmap?: string; error?: string } | null }>;
}

export function howtoIdea(stem: string, payload: { idx: number; model?: string }) {
  return mutate('POST', `/run/${encodeURIComponent(stem)}/howto`, payload) as Promise<{
    status: number;
    body: { spec?: string; title?: string; error?: string } | null;
  }>;
}

/** scope iteration 1 of a rating-5 idea — title-keyed within the run, send the ORIGINAL
 *  exact title; `saved` is the absolute path of the persisted scope file. */
export function scopeIdea(stem: string, title: string) {
  return mutate('POST', `/run/${encodeURIComponent(stem)}/scope`, { title }) as Promise<{
    status: number;
    body: { scope?: string; saved?: string; error?: string } | null;
  }>;
}

export function validateIdea(payload: { title: string; description?: string; model?: string }) {
  return mutate('POST', '/validate', payload) as Promise<{ status: number; body: { markdown?: string; error?: string } | null }>;
}

export function contribute(payload: { interests?: string; model?: string }) {
  return mutate('POST', '/contrib', payload) as Promise<{ status: number; body: { markdown?: string; error?: string } | null }>;
}

// ---------- agent feed filter (plan computed + persisted upstream; hide/boost is applied client-side) ----------

export interface AgentFilterPlan {
  interpretation?: string;
  hide_titles?: string[];
  hide_terms?: string[];
  boost_terms?: string[];
  rule_text?: string;
  explanation?: string;
  ts?: string;
}

export function agentFilter(payload: { instruction: string; model?: string }) {
  return mutate('POST', '/agent', payload) as Promise<{ status: number; body: (AgentFilterPlan & { error?: string }) | null }>;
}

export function getFilters(signal?: AbortSignal): Promise<AgentFilterPlan> {
  return getJson<AgentFilterPlan>('/filters', signal);
}

export function clearFilters() {
  return mutate('POST', '/filters/clear');
}

// ---------- model selection (global upstream pref; research start also passes it explicitly) ----------

export interface ModelsInfo {
  models: { id: string; label?: string }[];
  default: string;
  selected: string;
}

export function getModels(signal?: AbortSignal): Promise<ModelsInfo> {
  return getJson<ModelsInfo>('/models', signal);
}

export function setModel(model: string) {
  return mutate('POST', '/model', { model });
}

// ---------- run / idea mutation ----------

/** append a manual idea; returns the FULL renumbered run payload. */
export function addIdea(stem: string, payload: { title: string; body?: string }) {
  return mutate('POST', `/run/${encodeURIComponent(stem)}/idea`, payload) as Promise<{
    status: number;
    body: (RunDetail & { error?: string }) | null;
  }>;
}

/** delete one idea; returns the updated run payload (ratings ledger untouched). */
export function deleteIdea(stem: string, idx: number) {
  return mutate('DELETE', `/run/${encodeURIComponent(stem)}/idea/${idx}`) as Promise<{
    status: number;
    body: (RunDetail & { error?: string }) | null;
  }>;
}

/** delete a run's .md + sidecars; the ratings ledger is deliberately preserved upstream. */
export function deleteRun(stem: string) {
  return mutate('DELETE', `/run/${encodeURIComponent(stem)}`);
}

// ---------- collide compare (collide run vs exact-baseline run) ----------

/** source/baseline/candidates are run-info OBJECTS upstream, not stem strings;
 *  unique/overlap entries carry {idx, title} refs (verified against the live payload). */
export interface CompareRunRef {
  stem: string;
  n_ideas: number;
  is_collide: boolean;
  collision_temp: number | null;
  model: string | null;
  baseline_for: string | null;
  has_meta: boolean;
}

export interface CompareIdeaRef {
  idx: number;
  title: string;
}

export interface ComparePayload {
  status: 'ready' | 'missing_baseline' | 'not_collide';
  source?: CompareRunRef;
  baseline?: CompareRunRef | null;
  summary?: {
    source_count: number;
    baseline_count: number;
    overlap_count: number;
    source_unique_count?: number;
    baseline_unique_count?: number;
    overlap_ratio: number;
  };
  overlap?: { source: CompareIdeaRef | string; baseline: CompareIdeaRef | string; score?: number }[];
  source_unique?: (CompareIdeaRef | string)[];
  baseline_unique?: (CompareIdeaRef | string)[];
  candidates?: CompareRunRef[];
  can_launch_baseline?: boolean;
  launch_blocked_reason?: string | null;
}

export function getCompare(stem: string, baseline?: string, signal?: AbortSignal): Promise<ComparePayload> {
  const q = baseline ? `?baseline=${encodeURIComponent(baseline)}` : '';
  return getJson<ComparePayload>(`/run/${encodeURIComponent(stem)}/compare${q}`, signal);
}

/** launch the matched non-collide baseline (shares the single research slot — 409 when busy). */
export function launchBaseline(stem: string) {
  return mutate('POST', `/run/${encodeURIComponent(stem)}/baseline`) as Promise<{
    status: number;
    body: { ok?: boolean; already_exists?: boolean; baseline_stem?: string; started?: string; error?: string } | null;
  }>;
}

// ---------- resources (interests.md / rules.md / work.txt — prompt-steering files) ----------

export type ResourceName = 'interests' | 'rules' | 'work';

export function getResource(name: ResourceName, signal?: AbortSignal): Promise<{ text: string }> {
  return getJson<{ text: string }>(`/resource/${name}`, signal);
}

export function putResource(name: ResourceName, text: string) {
  return mutate('PUT', `/resource/${name}`, { text });
}
