// Endpoint health — TTFT and uptime for the public inference API.
//
// Every 5 minutes, one streamed 1-token chat completion per served model against
// api.tiyuvta.ai, measuring time-to-first-byte of the stream (the TTFT a real
// customer feels, through the router and the serving box). A 24h rolling window
// persisted at ~/.config/atrium/endpoint-health.json gives uptime% and p50 that
// survive atrium restarts.
//
// THIS IS THE CUSTOMER-FELT NUMBER, NOT THE ENGINE'S. It is measured from wherever atrium runs, so
// it carries the distance to the serving box. Measured 2026-08-25: 196-259ms observed from Israel
// against the DE box, while the same completion on that box's own loopback returns in 65-136ms —
// about 130ms of the reading is transit, and Cloudflare terminates TLS at a nearby edge (cf-ray
// ...-TLV) so a handshake timing cannot separate the two. For the serving stack's own cost see
// in_region_ttft_ms in darklanes ops/serving/sentinel.py, which probes on the box itself.
// Do not compare the two numbers as if they measured the same thing.
//
// This is the LIGHT measurement the darklanes .env key exists for (see
// prod-serving-boxes-untouchable) — one token per model per 5 minutes, never a
// bench. The key's tenant must stay marked internal in the console so probes
// never pollute customer usage numbers.
//
// The model list comes from the tiyuvta collector's surface scan (store extra),
// so a newly served model gets probed without a config change.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { store } from '../state.js';
import { config } from '../config.js';
import { iso, readJson } from '../util.js';
import type { Flag } from '../../../shared/types.js';
import type { Collector } from './registry.js';

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, path);
}

const HISTORY_FILE = join(config.configDir, 'endpoint-health.json');
const ENV_FILE = join(homedir(), 'projects', 'darklanes', '.env');
const WINDOW_MS = 24 * 3_600_000;

interface Probe {
  at: string;
  model: string;
  ok: boolean;
  ttftMs: number | null;
  /** The endpoint rejected our KEY (401/402/403), which says nothing about whether
   *  it is serving. On 2026-08-28 memra v0.117 made unenrolled tenants fail closed
   *  (they used to be unmetered); the probe key's tenant lost its free pass and all
   *  four models read DOWN for ~10h while customers were served normally the whole
   *  time. A monitor that cannot tell "my credential died" from "the product died"
   *  is worse than no monitor. */
  authFault?: boolean;
}

export interface EndpointModelHealth {
  model: string;
  ok: boolean;
  ttftMs: number | null;
  checkedAt: string;
  uptimePct: number;
  p50TtftMs: number | null;
  probes: number;
  /** Last probe was rejected on credentials — unknown health, NOT down. */
  authFault: boolean;
}

let history: Probe[] = [];
/** probes fired per UTC day — the ledger counts probe requests as (internal)
 *  usage, so the CRM overview subtracts these to show real internal traffic.
 *  Kept beyond the 24h probe window because the usage stats cover 7 days. */
let dayCounts: Record<string, number> = {};
let historyLoaded = false;

function pruneDayCounts(): void {
  const cutoff = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString().slice(0, 10);
  for (const day of Object.keys(dayCounts)) {
    if (day < cutoff) delete dayCounts[day];
  }
}

async function creds(): Promise<{ base: string; key: string } | null> {
  try {
    const text = await readFile(ENV_FILE, 'utf8');
    const get = (name: string) =>
      text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/gu, '') ?? null;
    const key = get('TIYUVTA_API_KEY');
    const base = get('TIYUVTA_API_BASE') ?? 'https://api.tiyuvta.ai/v1';
    return key ? { base, key } : null;
  } catch {
    return null;
  }
}

function servedModels(): string[] {
  const extra = store.get().extra['tiyuvta'];
  const api = (extra?.data as { api?: { models?: string[] } } | undefined)?.api;
  return api?.models ?? [];
}

/** Time to the first streamed byte of a 1-token completion — customer-felt TTFT. */
async function probe(base: string, key: string, model: string): Promise<Probe> {
  const at = iso();
  const started = performance.now();
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      // the router skips real-user metrics for marked probes — synthetic pings
      // must not count as customer latency/error data
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-tiyuvta-probe': '1' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      // 401/402/403 are verdicts on OUR key, not on the endpoint: auth and billing
      // admission both run before any model is touched, so a rejection here proves
      // the box answered — it cannot be evidence that the box is down.
      const authFault = response.status === 401 || response.status === 402 || response.status === 403;
      return { at, model, ok: false, ttftMs: null, ...(authFault ? { authFault: true } : {}) };
    }
    const reader = response.body.getReader();
    const first = await reader.read();
    const ttftMs = Math.round(performance.now() - started);
    await reader.cancel().catch(() => {});
    return { at, model, ok: !first.done, ttftMs: first.done ? null : ttftMs };
  } catch {
    return { at, model, ok: false, ttftMs: null };
  }
}

function summarize(now: number, served: string[]): EndpointModelHealth[] {
  // Only models the endpoint currently serves: a sunset model's probe history
  // stays on disk as record, but must not render a DOWN row or page the phone
  // for up to 24h after a deliberate removal (gemma sunset, 2026-08-21).
  const servedSet = new Set(served);
  const byModel = new Map<string, Probe[]>();
  for (const p of history) {
    if (now - Date.parse(p.at) > WINDOW_MS) continue;
    if (!servedSet.has(p.model)) continue;
    const list = byModel.get(p.model) ?? [];
    list.push(p);
    byModel.set(p.model, list);
  }
  const out: EndpointModelHealth[] = [];
  for (const [model, probes] of byModel) {
    const last = probes[probes.length - 1];
    const okTtfts = probes.filter((p) => p.ttftMs != null).map((p) => p.ttftMs as number).sort((a, b) => a - b);
    // Credential-rejected probes measured nothing, so they leave the uptime ratio
    // rather than dragging it down: a dead key must not manufacture a 30% uptime
    // figure for a box that served every real request that hour.
    const measured = probes.filter((p) => !p.authFault);
    out.push({
      model,
      ok: last.ok,
      ttftMs: last.ttftMs,
      checkedAt: last.at,
      uptimePct: measured.length
        ? Math.round((measured.filter((p) => p.ok).length / measured.length) * 1000) / 10
        : 0,
      p50TtftMs: okTtfts.length ? okTtfts[Math.floor(okTtfts.length / 2)] : null,
      probes: measured.length,
      authFault: Boolean(last.authFault),
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/** A model whose LAST probe failed has failed twice in a row (run() retries a
 *  failure in-run before recording it), so a flag here means a real outage, not
 *  a blip. Crit flags ride the normal notify pipe to the phone; the stable id
 *  makes recovery send a matching [clear]. */
export function downFlags(summary: EndpointModelHealth[]): Flag[] {
  // A credential rejection is one fault about one key, not N faults about N models.
  // Raise it once, as a warn, and say what to do — never as N crit "model down"
  // pages, which is what shipped four false DOWN rows on 2026-08-28.
  const authBlocked = summary.filter((m) => m.authFault);
  if (authBlocked.length && authBlocked.length === summary.length) {
    const at = authBlocked[0].checkedAt;
    return [
      {
        id: 'endpoint:probe-credential',
        severity: 'warn' as const,
        title: 'endpoint probe credential rejected — health is UNKNOWN, not down',
        detail:
          `every model rejected the probe key at ${at} (401/402/403). Auth and billing ` +
          'admission run before any model is touched, so the endpoint answered. Check that ' +
          "the probe tenant is enrolled for prepaid billing, then re-probe. Customer traffic " +
          'is unaffected by this flag — read realUsage, not this row, to judge the product.',
        source: 'endpoint',
        raisedAt: at,
      },
    ];
  }
  return summary
    .filter((m) => !m.ok && !m.authFault)
    .map((m) => ({
      id: `endpoint:down:${m.model}`,
      severity: 'crit' as const,
      title: `${m.model} not answering on api.tiyuvta.ai`,
      detail: `probe failed twice in a row at ${m.checkedAt} · ${m.uptimePct}% uptime over 24h`,
      source: 'endpoint',
      raisedAt: m.checkedAt,
    }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const collector: Collector = {
  name: 'endpoint',
  intervalMs: 5 * 60_000,

  async run() {
    if (!historyLoaded) {
      historyLoaded = true;
      const saved = await readJson<{ probes?: Probe[]; dayCounts?: Record<string, number> }>(HISTORY_FILE);
      if (Array.isArray(saved?.probes)) history = saved.probes;
      if (saved?.dayCounts && typeof saved.dayCounts === 'object') dayCounts = saved.dayCounts;
      // the tally is newer than the probe log — rebuild recent days from the log
      // so probes fired before the tally existed still get subtracted upstream
      const rebuilt: Record<string, number> = {};
      for (const p of history) {
        const day = p.at.slice(0, 10);
        rebuilt[day] = (rebuilt[day] ?? 0) + 1;
      }
      for (const [day, n] of Object.entries(rebuilt)) {
        dayCounts[day] = Math.max(dayCounts[day] ?? 0, n);
      }
    }

    const auth = await creds();
    const models = servedModels();
    if (!auth || models.length === 0) {
      store.setExtra('endpoint', {
        title: 'endpoint health',
        updatedAt: iso(),
        up: false,
        error: !auth ? `no TIYUVTA_API_KEY in ${ENV_FILE}` : 'no served models known yet (tiyuvta collector warming)',
        data: { models: [], probesPerDay: dayCounts },
      });
      // startup race with the tiyuvta surface scan — retry shortly rather than
      // leaving a 5-minute hole in the uptime record after every restart
      if (auth) setTimeout(() => void collector.run().catch(() => {}), 60_000).unref();
      return;
    }

    for (const model of models) {
      let result = await probe(auth.base, auth.key, model);
      history.push(result);
      dayCounts[result.at.slice(0, 10)] = (dayCounts[result.at.slice(0, 10)] ?? 0) + 1;
      if (!result.ok) {
        // one in-run retry after a pause: a single dropped stream must not page
        // the phone, a still-dead endpoint must page within this run
        await sleep(15_000);
        result = await probe(auth.base, auth.key, model);
        history.push(result);
        dayCounts[result.at.slice(0, 10)] = (dayCounts[result.at.slice(0, 10)] ?? 0) + 1;
      }
    }
    const now = Date.now();
    history = history.filter((p) => now - Date.parse(p.at) <= WINDOW_MS);
    pruneDayCounts();
    await atomicWriteJson(HISTORY_FILE, { probes: history, dayCounts });

    const summary = summarize(now, models);
    const allOk = summary.every((m) => m.ok);
    // `up` drives the red banner. Unknown-because-our-key-was-rejected is not down:
    // claiming the product is down when we merely cannot authenticate is the same
    // lie the tiyuvta collector already refuses to tell for an ABSENT token.
    const credentialBlocked = summary.length > 0 && summary.every((m) => m.authFault);
    store.setExtra('endpoint', {
      title: 'endpoint health',
      updatedAt: iso(),
      up: allOk || credentialBlocked,
      error: credentialBlocked
        ? 'probe key rejected (401/402/403) — endpoint health unknown, not down'
        : null,
      rows: summary.map((m) => ({
        label: m.model.split('/').pop() ?? m.model,
        value: m.authFault
          ? 'UNKNOWN · probe key rejected — check prepaid enrolment for the probe tenant'
          : `${m.ok ? 'up' : 'DOWN'} · ttft ${m.ttftMs ?? '—'}ms · p50 ${m.p50TtftMs ?? '—'}ms · ${m.uptimePct}% 24h`,
        tone: m.authFault ? ('warn' as const) : m.ok ? ('ok' as const) : ('err' as const),
      })),
      data: {
        models: summary,
        probesPerDay: dayCounts,
        // raw 24h probe series for the CRM health charts (~288 points/model)
        series: history
          .filter((p) => models.includes(p.model))
          .map((p) => ({
            at: p.at,
            model: p.model,
            ok: p.ok,
            ttftMs: p.ttftMs,
            ...(p.authFault ? { authFault: true } : {}),
          })),
      },
    });
    store.setFlags('endpoint', downFlags(summary));
  },
};

export default collector;
