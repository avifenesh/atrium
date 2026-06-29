import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';
import {
  addItchIdea,
  clearItchFilters,
  deleteItchIdea,
  deleteItchRun,
  isItchResourceName,
  loadItchApiRuns,
  loadItchDecisions,
  loadItchIdeaBucket,
  loadItchIdeaBucketCounts,
  listItchScopes,
  loadItchFilters,
  loadItchModels,
  loadItchResource,
  loadItchRunDetail,
  loadItchScope,
  saveItchRating,
  searchItchIdeas,
  saveItchModel,
  saveItchResource,
} from './core/itch.js';
import { itchResearchStatus, startItchResearch, stopItchResearch, resumeItchResearch } from './core/itch-research.js';
import { baselineLaunchFlags, comparePayload } from './core/itch-compare.js';
import { loadSxcGroundingState, saveSxcGroundingFeedback } from './core/itch-engine.js';
import { handleItchAi } from './core/itch-ai.js';

const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const RETRIEVERS = ['bm25', 'splade', 'colbert', 'hybrid'] as const;
type Retriever = (typeof RETRIEVERS)[number];

/** Read the sxc retriever override (config/serve.json). null = no override, so
 *  itch-intent mining uses the skill's own ColBERT choice. Missing/garbled file
 *  reads as null — the toggle is purely additive. */
async function getForceRetriever(): Promise<Retriever | null> {
  try {
    const raw = await readFile(config.itch.sxcServeConfig, 'utf8');
    const cfg = JSON.parse(raw);
    const fr = cfg?.force_retriever;
    return (RETRIEVERS as readonly string[]).includes(fr) ? (fr as Retriever) : null;
  } catch {
    return null;
  }
}

/** Write/clear the sxc override atomically. A valid name forces that retriever;
 *  null clears it. Mirrors sxc.serve.api.set_force_retriever's file format so
 *  the Python side reads it without coordination. */
async function setForceRetriever(name: Retriever | null): Promise<void> {
  const path = config.itch.sxcServeConfig;
  await mkdir(dirname(path), { recursive: true });
  const payload = name ? JSON.stringify({ force_retriever: name }) : '{}';
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, path);
}

/** Handle the migrated local slice of the itch API. Returns false for paths that
 * still need the transitional Python itch server.
 */
export async function handleLocalItch(req: IncomingMessage, res: ServerResponse, rest: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  try {
    if (method === 'POST' && /^(ask|roadmap|validate|contrib|agent|run\/[^/]+\/(howto|scope))$/.test(rest)) {
      const ai = await handleItchAi(rest, await readBody(req));
      if (ai) { json(res, ai.status, ai.body); return true; }
    }
    if (method === 'GET' && rest === 'retriever') {
      const forced = await getForceRetriever();
      json(res, 200, { forced, fallback_bm25: forced === 'bm25', options: [...RETRIEVERS] });
      return true;
    }
    if (method === 'GET' && rest === 'grounding') {
      json(res, 200, await loadSxcGroundingState());
      return true;
    }
    if (method === 'POST' && rest === 'grounding/feedback') {
      const body = await readBody(req);
      const id = typeof body?.id === 'string' ? body.id : '';
      const feedback = body?.feedback;
      if (!id || (feedback !== 'up' && feedback !== 'down')) {
        json(res, 400, { error: "expected id and feedback ('up' or 'down')" }); return true;
      }
      json(res, 200, { ok: true, grounding: await saveSxcGroundingFeedback(id, feedback) });
      return true;
    }
    if (method === 'POST' && rest === 'retriever') {
      const body = await readBody(req);
      let name: Retriever | null;
      if ('forced' in body) {
        const f = body.forced;
        if (f !== null && f !== '' && !(RETRIEVERS as readonly string[]).includes(f)) {
          json(res, 400, { error: "invalid 'forced' retriever" }); return true;
        }
        name = f || null;
      } else if ('fallback_bm25' in body) {
        name = body.fallback_bm25 ? 'bm25' : null;
      } else {
        json(res, 400, { error: "expected 'fallback_bm25' or 'forced'" }); return true;
      }
      await setForceRetriever(name);
      json(res, 200, { ok: true, forced: name, fallback_bm25: name === 'bm25' });
      return true;
    }
    if (method === 'GET' && rest === 'filters') {
      json(res, 200, await loadItchFilters(config.paths));
      return true;
    }
    if (method === 'POST' && rest === 'filters/clear') {
      await clearItchFilters(config.paths);
      json(res, 200, { ok: true });
      return true;
    }
    if (method === 'GET' && rest === 'scopes') {
      json(res, 200, await listItchScopes(config.paths));
      return true;
    }
    const scope = rest.match(/^scopes\/([^/]+)$/);
    if (method === 'GET' && scope) {
      const payload = await loadItchScope(config.paths, decodeURIComponent(scope[1]));
      json(res, payload ? 200 : 404, payload ?? { error: 'not found' });
      return true;
    }
    if (method === 'GET' && rest === 'models') {
      json(res, 200, await loadItchModels(config.paths));
      return true;
    }
    if (method === 'POST' && rest === 'model') {
      const body = await readBody(req);
      const model = await saveItchModel(config.paths, String(body?.model ?? ''));
      json(res, 200, { ok: true, model });
      return true;
    }
    if (method === 'GET' && rest === 'research/status') {
      const since = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('since');
      json(res, 200, itchResearchStatus(since === null ? undefined : Number(since)));
      return true;
    }
    if (method === 'POST' && rest === 'research/start') {
      const body = await readBody(req);
      const result = await startItchResearch(body?.flags && typeof body.flags === 'object' ? body.flags : {});
      json(res, result.ok ? 200 : 409, result.ok ? result : { error: result.error });
      return true;
    }
    if (method === 'POST' && rest === 'research/resume') {
      const result = await resumeItchResearch();
      json(res, result.ok ? 200 : 409, result.ok ? result : { error: result.error });
      return true;
    }
    if (method === 'POST' && rest === 'research/stop') {
      json(res, 200, stopItchResearch());
      return true;
    }
    if (method === 'GET' && rest === 'runs') {
      json(res, 200, await loadItchApiRuns(config.paths));
      return true;
    }
    if (method === 'GET' && rest === 'decisions') {
      json(res, 200, await loadItchDecisions(config.paths));
      return true;
    }
    if (method === 'GET' && rest === 'ideas') {
      json(res, 200, await loadItchIdeaBucketCounts(config.paths));
      return true;
    }
    const bucket = rest.match(/^ideas\/([^/]+)$/);
    if (method === 'GET' && bucket) {
      const payload = await loadItchIdeaBucket(config.paths, decodeURIComponent(bucket[1]));
      json(res, payload ? 200 : 404, payload ?? { error: 'unknown bucket' });
      return true;
    }
    const compare = rest.match(/^run\/([^/]+)\/compare$/);
    if (method === 'GET' && compare) {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const baseline = u.searchParams.get('baseline') || undefined;
      json(res, 200, await comparePayload(decodeURIComponent(compare[1]), baseline));
      return true;
    }
    const baseline = rest.match(/^run\/([^/]+)\/baseline$/);
    if (method === 'POST' && baseline) {
      const stem = decodeURIComponent(baseline[1]);
      const plan = await baselineLaunchFlags(stem);
      if (!plan.ok) { json(res, 400, { error: plan.error }); return true; }
      if (plan.existing) { json(res, 200, { ok: true, already_exists: true, baseline_stem: plan.existing }); return true; }
      const result = await startItchResearch(plan.flags ?? {});
      if (!result.ok) { json(res, 409, { error: result.error }); return true; }
      json(res, 200, { ok: true, started: result.started });
      return true;
    }
    const run = rest.match(/^run\/([^/]+)$/);
    if (run) {
      const stem = decodeURIComponent(run[1]);
      if (method === 'GET') {
        const detail = await loadItchRunDetail(config.paths, stem);
        json(res, detail ? 200 : 404, detail ?? { error: 'not found' });
        return true;
      }
      if (method === 'DELETE') {
        const ok = await deleteItchRun(config.paths, stem);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
        return true;
      }
    }
    const idea = rest.match(/^run\/([^/]+)\/idea(?:\/(\d+))?$/);
    if (idea) {
      const stem = decodeURIComponent(idea[1]);
      if (method === 'POST' && idea[2] === undefined) {
        const body = await readBody(req);
        const detail = await addItchIdea(config.paths, stem, String(body?.title ?? ''), typeof body?.body === 'string' ? body.body : '');
        json(res, detail ? 200 : 404, detail ?? { error: 'not found' });
        return true;
      }
      if (method === 'DELETE' && idea[2] !== undefined) {
        const detail = await deleteItchIdea(config.paths, stem, Number(idea[2]));
        json(res, detail ? 200 : 404, detail ?? { error: 'not found' });
        return true;
      }
    }
    if (method === 'GET' && rest === 'search') {
      const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('q') ?? '';
      json(res, 200, await searchItchIdeas(config.paths, q));
      return true;
    }
    const resource = rest.match(/^(?:resource\/([^/]+)|rules)$/);
    if (resource) {
      const name = rest === 'rules' ? 'rules' : (resource[1] ?? '');
      if (!isItchResourceName(name)) { json(res, 404, { error: 'unknown resource' }); return true; }
      if (method === 'GET') { json(res, 200, { text: await loadItchResource(config.paths, name) }); return true; }
      if (method === 'PUT') {
        const body = await readBody(req);
        if (typeof body?.text !== 'string') { json(res, 400, { error: 'missing text' }); return true; }
        await saveItchResource(config.paths, name, body.text);
        json(res, 200, { ok: true });
        return true;
      }
      json(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (method === 'PUT' && rest === 'rating') {
      await saveItchRating(config.paths, await readBody(req));
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (err) {
    json(res, err instanceof Error && err.message === 'body too large' ? 413 : 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
