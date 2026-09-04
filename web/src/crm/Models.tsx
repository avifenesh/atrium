// Models — one screen per question: which model is earning its box.
//
// Every served model gets a summary row (real requests 24h and 7d, error rate,
// real latency, probe verdict) and its 24h detail charts — the charts that used
// to crowd the health tab, which is now free to answer only "is anything on
// fire". The 7d daily chart makes traffic-per-model legible at a glance instead
// of a mental sum over hourly bars.

import type { CrmOverview } from '../../../shared/types';
import { TrendChart } from './charts';

const JADE = 'var(--color-jade)';
const CORAL = 'var(--color-coral)';
const SLATE = 'var(--color-slate-glow)';
const MIST = 'var(--color-mist)';

const short = (model: string) => model.split('/').pop() ?? model;


// The traffic-shape table (owner, 2026-09-04). The counters above say HOW MUCH; these say
// WHAT KIND: prompt tokens per completion token, and how much of the prompt the prefix cache
// served. Those two decide which price line earns, so they belong on the same screen as
// "is this model earning its box". Source: darklanes' request archive (ops/analytics/usage.py),
// ingested read-only by the usagemix collector — no tenant id ever crosses that seam.
const CLASS_LABEL: Record<string, string> = {
  customer: 'customers',
  owner: 'our tenants',
  internal: 'watchdogs',
};

const num = (v: number) => v.toLocaleString('en-US');
const pctOf = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

function UsageMix({ mix }: { mix: NonNullable<CrmOverview['usageMix']> }) {
  const windows = mix.windows?.length ? mix.windows : ['24h', '7d', '30d', 'all'];
  const order = ['customer', 'owner', 'internal'];
  const rows = [...mix.models].sort(
    (a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.model.localeCompare(b.model),
  );
  return (
    <div className="rounded-xl border border-white/8">
      <div className="flex items-baseline justify-between px-3 py-2 text-[12px]">
        <span className="text-mist">traffic shape — in / out / cache, per model</span>
        <span className="text-mist-faint">
          {mix.archive
            ? `${num(mix.archive.requests)} archived · ${mix.archive.from} → ${mix.archive.to}`
            : 'archive empty'}
          {mix.staleHours ? ` · rollup ${mix.staleHours}h old` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-mist-faint">no requests archived yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[12px]">
            <thead>
              <tr className="border-b border-white/8 text-left text-mist-faint">
                <th className="px-3 py-2 font-normal">model</th>
                <th className="px-3 py-2 font-normal">who</th>
                <th className="px-3 py-2 font-normal">window</th>
                <th className="px-3 py-2 text-right font-normal">served</th>
                <th className="px-3 py-2 text-right font-normal">in:out</th>
                <th className="px-3 py-2 text-right font-normal">cached</th>
                <th className="px-3 py-2 text-right font-normal">prompt p50/p90</th>
                <th className="px-3 py-2 text-right font-normal">out p50/p90</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => {
                const live = windows.filter((w) => (row.windows[w]?.requests ?? 0) > 0);
                return live.map((w, i) => {
                  const d = row.windows[w];
                  return (
                    <tr
                      key={`${row.model}:${row.cls}:${w}`}
                      className={i === live.length - 1 ? 'border-b border-white/8 last:border-0' : ''}
                    >
                      <td className="px-3 py-2 text-mist" title={row.model}>
                        {i === 0 ? short(row.model) : ''}
                      </td>
                      <td className={`px-3 py-2 ${row.cls === 'customer' ? 'text-jade' : 'text-mist-faint'}`}>
                        {i === 0 ? (CLASS_LABEL[row.cls] ?? row.cls) : ''}
                      </td>
                      <td className="px-3 py-2 text-mist-dim">{w}</td>
                      <td className="px-3 py-2 text-right text-mist">
                        {num(d.served)}
                        {d.requests !== d.served ? (
                          <span className="text-mist-faint"> /{num(d.requests)}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-mist">{d.inOut === null ? '—' : `${d.inOut}:1`}</td>
                      <td className="px-3 py-2 text-right text-mist-dim">{pctOf(d.cachedShare)}</td>
                      <td className="px-3 py-2 text-right text-mist-faint">
                        {num(d.promptP50)} / {num(d.promptP90)}
                      </td>
                      <td className="px-3 py-2 text-right text-mist-faint">
                        {num(d.completionP50)} / {num(d.completionP90)}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ModelsTab({ data }: { data: CrmOverview }) {
  const { endpoint, realUsage, realUsageHourly, realUsageDaily, usageMix } = data;
  const hourly = realUsageHourly ?? [];
  const daily = realUsageDaily ?? [];
  const probeSeries = endpoint?.series ?? [];
  const probes = endpoint?.models ?? [];

  // The model universe: anything the probes watch or real traffic touched.
  const models = [
    ...new Set([...probes.map((m) => m.model), ...(realUsage ?? []).map((m) => m.model), ...daily.map((d) => d.model)]),
  ].sort();

  const usageByModel = new Map((realUsage ?? []).map((m) => [m.model, m]));
  const probeByModel = new Map(probes.map((m) => [m.model, m]));
  const req7d = new Map<string, number>();
  const err7d = new Map<string, number>();
  for (const d of daily) {
    req7d.set(d.model, (req7d.get(d.model) ?? 0) + d.requests);
    err7d.set(d.model, (err7d.get(d.model) ?? 0) + d.errors);
  }

  // The router logs the model string the CALLER sent, including 404s on names we
  // do not serve. Those rows are two different things — demand for a model we
  // could serve, and scanner noise — and neither belongs in the serving table.
  // Served = probed. The rest goes to its own strip below, still counted,
  // because "someone asked for gemma twice" is a signal worth reading.
  const servedSet = new Set(probes.map((m) => m.model));
  const served = models.filter((m) => servedSet.has(m));
  const unserved = models.filter((m) => !servedSet.has(m));
  const totalReq7d = served.reduce((a, m) => a + (req7d.get(m) ?? 0), 0);

  // shared 7d day axis, oldest first
  const days = [...new Set(daily.map((d) => d.day))].sort();
  const byModelDay = new Map(daily.map((d) => [`${d.model}|${d.day}`, d] as const));

  const hourTick = (iso: string) => `${iso.slice(11, 13)}:00`;

  if (models.length === 0) {
    return (
      <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
        no model traffic or probes yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {usageMix ? <UsageMix mix={usageMix} /> : null}
      {/* the summary table — counted requests to each model, sortable by eye */}
      <div className="overflow-x-auto rounded-xl border border-white/8">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-white/8 text-left text-mist-faint">
              <th className="px-3 py-2 font-normal">model</th>
              <th className="px-3 py-2 text-right font-normal">req 24h</th>
              <th className="px-3 py-2 text-right font-normal">req 7d</th>
              <th className="px-3 py-2 text-right font-normal">share 7d</th>
              <th className="px-3 py-2 text-right font-normal">err 24h</th><th className="px-3 py-2 text-right font-normal">shed 24h</th>
              <th className="px-3 py-2 text-right font-normal">latency</th>
              <th className="px-3 py-2 text-right font-normal">probe</th>
            </tr>
          </thead>
          <tbody>
            {[...served]
              .sort((a, b) => (req7d.get(b) ?? 0) - (req7d.get(a) ?? 0))
              .map((model) => {
                const u = usageByModel.get(model);
                const p = probeByModel.get(model);
                const r7 = req7d.get(model) ?? 0;
                const share = totalReq7d > 0 ? (r7 / totalReq7d) * 100 : 0;
                return (
                  <tr key={model} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 text-mist" title={model}>
                      {short(model)}
                    </td>
                    <td className="px-3 py-2 text-right text-mist-dim">{u ? u.requests24h : 0}</td>
                    <td className="px-3 py-2 text-right text-mist">{r7}</td>
                    <td className="px-3 py-2 text-right text-mist-faint">{share.toFixed(0)}%</td>
                    <td className={`px-3 py-2 text-right ${u && u.errorPct > 1 ? 'text-coral' : 'text-mist-faint'}`}>
                      {u ? `${u.errorPct}%` : '—'}
                    </td>
                    {/* A shed is the batch-class contract (harvest yields, retryable 429) —
                        amber worth a look, never the coral of a fault we own. */}
                    <td className={`px-3 py-2 text-right ${u && u.shedPct > 0 ? 'text-amber' : 'text-mist-faint'}`}>
                      {u ? `${u.shedPct}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-mist-dim">{u?.avgMs != null ? `${u.avgMs}ms` : '—'}</td>
                    <td className={`px-3 py-2 text-right ${p ? (p.ok ? 'text-jade' : 'text-coral') : 'text-mist-faint'}`}>
                      {p ? (p.ok ? `up · ${p.uptimePct}%` : 'DOWN') : 'unprobed'}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* asked for, not served — the router's 404s by requested model string.
          Real model names here are demand (or a quickstart mistake, when it is
          our own model's display name instead of its API id); gibberish is
          scanners. Either way it is not a serving row. */}
      {unserved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="py-1 font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            asked for, not served · 7d
          </span>
          {[...unserved]
            .sort((a, b) => (req7d.get(b) ?? 0) - (req7d.get(a) ?? 0))
            .map((model) => (
              <span
                key={model}
                title={model}
                className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-mist-dim"
              >
                {short(model)} × {req7d.get(model) ?? 0}
              </span>
            ))}
        </div>
      )}

      {/* 7d requests/day, one chart per model with real traffic — the counted view */}
      {days.length > 0 && (
        <div className="grid gap-2 lg:grid-cols-2">
          {[...served]
            .filter((m) => (req7d.get(m) ?? 0) > 0)
            .sort((a, b) => (req7d.get(b) ?? 0) - (req7d.get(a) ?? 0))
            .map((model) => (
              <TrendChart
                key={model}
                title={`${short(model)} · requests/day · ${req7d.get(model) ?? 0} req 7d · ${err7d.get(model) ?? 0} err`}
                labels={days.map((d) => d.slice(5))}
                series={[
                  {
                    name: 'requests',
                    color: SLATE,
                    kind: 'bar',
                    values: days.map((d) => byModelDay.get(`${model}|${d}`)?.requests ?? 0),
                  },
                  {
                    name: 'errors',
                    color: CORAL,
                    kind: 'line',
                    values: days.map((d) => byModelDay.get(`${model}|${d}`)?.errors ?? 0),
                  },
                ]}
                format={(v) => String(Math.round(v))}
              />
            ))}
        </div>
      )}

      {/* per-model 24h detail — moved here from health, where four charts per model
          drowned the one question health exists to answer */}
      {probes.map((m) => {
        const modelHours = hourly.filter((h) => h.model === m.model);
        const modelProbes = probeSeries.filter((p) => p.model === m.model);
        const hourKeys = [
          ...new Set([...modelHours.map((h) => h.hour.slice(0, 13)), ...modelProbes.map((p) => p.at.slice(0, 13))]),
        ].sort();
        if (hourKeys.length === 0) return null;
        const byHour = new Map(modelHours.map((h) => [h.hour.slice(0, 13), h]));
        const upByHour = hourKeys.map((k) => {
          // authFault probes measured our key, not the box — they leave the ratio
          const hp = modelProbes.filter((p) => p.at.slice(0, 13) === k && !p.authFault);
          return hp.length ? Math.round((hp.filter((p) => p.ok).length / hp.length) * 100) : null;
        });
        const labels = hourKeys.map((k) => hourTick(`${k}:00`));
        return (
          <div key={m.model}>
            <div className="mb-1 font-mono text-[11px] text-mist-dim">{short(m.model)} · last 24h</div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <TrendChart
                title="traffic, req/hr (real)"
                height={110}
                labels={labels}
                series={[
                  { name: 'requests', color: SLATE, kind: 'bar', values: hourKeys.map((k) => byHour.get(k)?.requests ?? 0) },
                  { name: 'errors', color: CORAL, kind: 'line', values: hourKeys.map((k) => byHour.get(k)?.errors ?? 0) },
                ]}
                format={(v) => String(Math.round(v))}
              />
              <TrendChart
                title="latency, ms to headers (real)"
                height={110}
                labels={labels}
                series={[{ name: 'avg ms', color: SLATE, kind: 'line', values: hourKeys.map((k) => byHour.get(k)?.avgMs ?? null) }]}
                format={(v) => `${Math.round(v)}ms`}
              />
              <TrendChart
                title="ttft, ms (probe, 5 min)"
                height={110}
                labels={modelProbes.map((p) => p.at.slice(11, 16))}
                series={[{ name: 'ttft', color: MIST, kind: 'line', values: modelProbes.map((p) => p.ttftMs) }]}
                format={(v) => `${Math.round(v)}ms`}
              />
              <TrendChart
                title="uptime, %/hr (probe)"
                height={110}
                labels={labels}
                series={[{ name: 'up %', color: JADE, kind: 'bar', values: upByHour }]}
                format={(v) => `${Math.round(v)}%`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
