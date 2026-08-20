// OpenRouter competitor watch — a plugin collector.
//
// Every strong X lead this week was some flavor of "the only OpenRouter
// provider for this model is slow/expensive". That complaint is the outreach
// wedge, and it has a timestamp: it matters while it is true. This collector
// polls OpenRouter's public endpoints API for each family we serve and keeps
// the comparison current — their provider count, cheapest prices, and worst
// uptime, against our own list price from service.json (the ONE price source).
//
// An opportunity (few providers, weak uptime, or a big price gap) raises a
// warn flag — visible on every flag strip, deliberately below the phone-page
// threshold: a competitor stumbling is a reason to send outreach today, not an
// alarm at 3am.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Flag } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const SERVICE_JSON = join(homedir(), 'projects', 'darklanes', 'site-inference', 'src', 'data', 'service.json');
const API = 'https://openrouter.ai/api/v1';

export interface CompetitorModel {
  model: string;
  providers: number;
  /** $/M tokens, cheapest across providers */
  cheapestInUsd: number | null;
  cheapestOutUsd: number | null;
  /** worst provider uptime over their last 30m window */
  minUptimePct: number | null;
  oursInUsd: number | null;
  oursOutUsd: number | null;
}

interface OrEndpoint {
  provider_name?: string;
  pricing?: { prompt?: string; completion?: string };
  uptime_last_30m?: number;
  status?: number;
}

async function ourPrices(): Promise<Map<string, { input: number; output: number }>> {
  const out = new Map<string, { input: number; output: number }>();
  try {
    const service = JSON.parse(await readFile(SERVICE_JSON, 'utf8')) as {
      models?: Array<{ id?: string; pricing?: { input?: number; output?: number } }>;
    };
    for (const m of service.models ?? []) {
      if (m.id && m.pricing?.input != null && m.pricing.output != null) {
        out.set(m.id, { input: m.pricing.input, output: m.pricing.output });
      }
    }
  } catch {
    /* no service.json = comparison still works, ours column empty */
  }
  return out;
}

function servedModels(): string[] {
  const extra = store.get().extra['tiyuvta'];
  const api = (extra?.data as { api?: { models?: string[] } } | undefined)?.api;
  return api?.models ?? [];
}

/** Our model ids match OpenRouter slugs for qwen/gemma; step needs the org. */
function orSlug(model: string): string {
  return model === 'stepfun/step-3.7-flash' || model.includes('step-3.7') ? 'stepfun/step-3.7-flash' : model;
}

const perM = (perToken: string | undefined): number | null => {
  const n = Number(perToken);
  return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1000) / 1000 : null;
};

const collector: Collector = {
  name: 'openrouter',
  intervalMs: 60 * 60_000,

  async run() {
    const models = servedModels();
    if (models.length === 0) {
      // startup race: this collector's first run beats the tiyuvta surface scan.
      // Don't blank an existing comparison for an hour — retry shortly instead.
      if (!store.get().extra['openrouter']) {
        store.setExtra('openrouter', { title: 'openrouter watch', updatedAt: iso(), data: { models: [] } });
      }
      setTimeout(() => void collector.run().catch(() => {}), 60_000).unref();
      return;
    }
    const ours = await ourPrices();
    const rows: CompetitorModel[] = [];
    const flags: Flag[] = [];
    const failures: string[] = [];

    for (const model of models) {
      const slug = orSlug(model);
      let endpoints: OrEndpoint[] = [];
      try {
        const response = await fetch(`${API}/models/${slug}/endpoints`, {
          headers: { accept: 'application/json', 'user-agent': 'atrium-openrouter-watch' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`${response.status}`);
        const payload = (await response.json()) as { data?: { endpoints?: OrEndpoint[] } };
        endpoints = (payload.data?.endpoints ?? []).filter((e) => e.status === 0);
      } catch (error) {
        failures.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const inPrices = endpoints.map((e) => perM(e.pricing?.prompt)).filter((n): n is number => n != null);
      const outPrices = endpoints.map((e) => perM(e.pricing?.completion)).filter((n): n is number => n != null);
      const uptimes = endpoints.map((e) => e.uptime_last_30m).filter((n): n is number => typeof n === 'number');
      const row: CompetitorModel = {
        model,
        providers: endpoints.length,
        cheapestInUsd: inPrices.length ? Math.min(...inPrices) : null,
        cheapestOutUsd: outPrices.length ? Math.min(...outPrices) : null,
        minUptimePct: uptimes.length ? Math.round(Math.min(...uptimes) * 10) / 10 : null,
        oursInUsd: ours.get(model)?.input ?? null,
        oursOutUsd: ours.get(model)?.output ?? null,
      };
      rows.push(row);

      // the outreach windows, in the order the X leads showed them
      const reasons: string[] = [];
      if (row.providers === 0) reasons.push('no OpenRouter provider at all');
      else if (row.providers === 1) reasons.push('single OpenRouter provider');
      if (row.minUptimePct != null && row.minUptimePct < 95) reasons.push(`a provider at ${row.minUptimePct}% uptime`);
      if (row.oursOutUsd != null && row.cheapestOutUsd != null && row.cheapestOutUsd > row.oursOutUsd * 1.5) {
        reasons.push(`their cheapest output $${row.cheapestOutUsd}/M vs our $${row.oursOutUsd}/M`);
      }
      if (reasons.length) {
        flags.push({
          id: `openrouter:window:${model}`,
          severity: 'warn',
          title: `outreach window: ${model.split('/').pop()} on OpenRouter`,
          detail: reasons.join(' · '),
          source: 'openrouter',
          raisedAt: iso(),
        });
      }
    }

    store.setExtra('openrouter', {
      title: 'openrouter watch',
      updatedAt: iso(),
      up: failures.length === 0,
      error: failures.length ? failures.join(' | ') : null,
      rows: rows.map((r) => ({
        label: r.model.split('/').pop() ?? r.model,
        value: `${r.providers} providers · cheapest $${r.cheapestInUsd ?? '?'}/$${r.cheapestOutUsd ?? '?'} vs ours $${r.oursInUsd ?? '?'}/$${r.oursOutUsd ?? '?'} · min uptime ${r.minUptimePct ?? '?'}%`,
      })),
      data: { models: rows },
    });
    store.setFlags('openrouter', flags);
  },
};

export default collector;
