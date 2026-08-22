// Dependency-free SVG charts for the CRM tabs. One component, two mark kinds
// (bars and lines) sharing an x-axis of day labels — enough for every trend the
// overview holds, small enough to keep the public bundle lean.
//
// Palette discipline (dataviz method, validated 2026-08-22 against ink #07090d):
// at most TWO series per chart. slate-glow+amber pass all separation checks;
// jade+coral sit in the CVD floor band, so any chart pairing them MUST also
// separate by mark kind (bars vs line) — which TrendChart makes natural.
// Text wears text tokens, never a series color.

import { useEffect, useRef, useState } from 'react';

export interface TrendSeries {
  name: string;
  /** resolved CSS color, e.g. 'var(--color-jade)' */
  color: string;
  kind: 'bar' | 'line';
  values: Array<number | null>;
}

const PAD_TOP = 16; // room for the y-max label above the top gridline
const PAD_BOTTOM = 18;
const PAD_X = 4;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** '2026-08-22' -> '22', anything else -> last 5 chars */
const dayTick = (label: string) => (/^\d{4}-\d{2}-\d{2}$/.test(label) ? label.slice(8) : label.slice(-5));

export function TrendChart({
  labels,
  series,
  format,
  height = 150,
  title,
}: {
  labels: string[];
  series: TrendSeries[];
  format: (v: number) => string;
  height?: number;
  title: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const n = labels.length;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const rawMax = Math.max(...all, 0);
  const rawMin = Math.min(...all, 0);
  const max = rawMax === 0 && rawMin === 0 ? 1 : rawMax;
  const span = max - rawMin || 1;

  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const plotW = Math.max(0, width - PAD_X * 2);
  const slot = n > 0 ? plotW / n : 0;
  const y = (v: number) => PAD_TOP + plotH - ((v - rawMin) / span) * plotH;
  const xMid = (i: number) => PAD_X + slot * i + slot / 2;
  const zeroY = y(0);

  const bars = series.filter((s) => s.kind === 'bar');
  const lines = series.filter((s) => s.kind === 'line');
  // bars share the slot: 2px surface gap between adjacent bars (mark spec)
  const groupW = Math.min(slot * 0.6, 26);
  const barW = bars.length ? Math.max(2, (groupW - 2 * (bars.length - 1)) / bars.length) : 0;

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current || slot === 0) return;
    const x = e.clientX - ref.current.getBoundingClientRect().left - PAD_X;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{title}</div>
        {/* legend — always present with ≥2 series; a single series is named by the title */}
        {series.length > 1 && (
          <div className="flex gap-3 font-mono text-[10px] text-mist-dim">
            {series.map((s) => (
              <span key={s.name} className="flex items-center gap-1.5">
                {s.kind === 'bar' ? (
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                ) : (
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                )}
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div ref={ref} className="relative mt-1.5" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {width > 0 && n > 0 && (
          <svg width={width} height={height} className="block">
            {/* recessive grid: top, zero */}
            <line x1={PAD_X} x2={width - PAD_X} y1={y(max)} y2={y(max)} stroke="rgba(255,255,255,0.06)" />
            <line x1={PAD_X} x2={width - PAD_X} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.12)" />

            {hover != null && (
              <rect x={PAD_X + slot * hover} y={PAD_TOP} width={slot} height={plotH} fill="rgba(255,255,255,0.05)" />
            )}

            {bars.map((s, si) =>
              s.values.map((v, i) => {
                if (v == null) return null;
                const x0 = xMid(i) - groupW / 2 + si * (barW + 2);
                const top = Math.min(y(v), zeroY);
                const h = Math.max(1.5, Math.abs(y(v) - zeroY));
                return <rect key={`${s.name}-${i}`} x={x0} y={top} width={barW} height={h} rx={Math.min(2, barW / 2)} fill={s.color} />;
              }),
            )}

            {lines.map((s) => {
              const pts = s.values
                .map((v, i) => (v == null ? null : `${xMid(i)},${y(v)}`))
                .filter(Boolean)
                .join(' ');
              return <polyline key={s.name} points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
            })}

            {hover != null &&
              lines.map((s) => {
                const v = s.values[hover];
                if (v == null) return null;
                // 2px surface ring so the marker separates from the line (mark spec)
                return <circle key={s.name} cx={xMid(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--color-ink-2)" strokeWidth={2} />;
              })}

            {/* x ticks: first, middle, last — recessive */}
            {[0, Math.floor((n - 1) / 2), n - 1].filter((i, at, arr) => arr.indexOf(i) === at).map((i) => (
              <text key={i} x={xMid(i)} y={height - 4} textAnchor="middle" fontSize={9} fill="var(--color-mist-faint)" fontFamily="monospace">
                {dayTick(labels[i])}
              </text>
            ))}
            {/* y max label */}
            <text x={PAD_X} y={y(max) - 3} fontSize={9} fill="var(--color-mist-faint)" fontFamily="monospace">
              {format(max)}
            </text>
          </svg>
        )}

        {hover != null && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-lg border border-white/10 bg-ink px-2.5 py-1.5 font-mono text-[10px]"
            style={hover < n / 2 ? { left: Math.min(xMid(hover) + 10, width - 130) } : { right: Math.min(width - xMid(hover) + 10, width - 130) }}
          >
            <div className="text-mist-dim">{labels[hover]}</div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.name} className="flex items-center gap-1.5 text-mist">
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                  {s.name}: {v == null ? '—' : format(v)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal bar list — identity + magnitude for a handful of named rows
 *  (signup channels, top paths). One hue; the label carries identity. */
export function BarList({
  title,
  rows,
  color = 'var(--color-slate-glow)',
  format = String,
}: {
  title: string;
  rows: Array<{ label: string; value: number; hint?: string }>;
  color?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{title}</div>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2" title={r.hint}>
            <span className="w-28 shrink-0 truncate font-mono text-[11px] text-mist-dim sm:w-36">{r.label}</span>
            <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-[3px]">
              <div className="h-full rounded-[3px]" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-[11px] text-mist">{format(r.value)}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="font-mono text-[11px] text-mist-faint">no rows yet</div>}
      </div>
    </div>
  );
}
