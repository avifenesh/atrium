import type { CSSProperties, ReactNode } from 'react';
import { Dot, EmptyState, MuteButton, Mutable, Panel } from '../components/ui';
import type { Snapshot } from '../../../shared/types';

const GiB = 1024 ** 3;

function gb(bytes: number): string {
  const v = bytes / GiB;
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

function StatTile({
  label,
  riseIndex,
  children,
}: {
  label: string;
  riseIndex: number;
  children: ReactNode;
}) {
  return (
    <div className="glass rise p-4" style={{ '--rise-i': riseIndex } as CSSProperties}>
      <div className="font-mono text-[11px] uppercase tracking-widest text-mist-faint">{label}</div>
      {children}
    </div>
  );
}

function BigPct({ pct, className = 'text-mist' }: { pct: number; className?: string }) {
  return (
    <div className={`font-display text-4xl italic leading-tight ${className}`}>
      {Math.round(pct)}
      <span className="text-lg text-mist-dim">%</span>
    </div>
  );
}

export default function SystemPanel({ snapshot }: { snapshot: Snapshot }) {
  const sys = snapshot.system;
  const memUsedB = sys.mem.totalB - sys.mem.availableB;
  const swapUsedB = sys.swap.totalB - sys.swap.freeB;
  const swapClass =
    sys.swap.usedPct > 90 ? 'text-coral' : sys.swap.usedPct > 75 ? 'text-amber' : 'text-mist';

  return (
    <div>
      {sys.error && <div className="mb-3 font-mono text-xs text-coral">{sys.error}</div>}

      <div className="grid grid-cols-2 items-start gap-4 md:grid-cols-4">
        <StatTile label="cpu" riseIndex={0}>
          <BigPct pct={sys.cpu.pct} />
          <div className="mt-1 font-mono text-xs text-mist-dim">
            {sys.cpu.load1.toFixed(2)} / {sys.cpu.load5.toFixed(2)} / {sys.cpu.load15.toFixed(2)} · {sys.cpu.cores}c
          </div>
        </StatTile>

        <StatTile label="mem" riseIndex={1}>
          <BigPct pct={sys.mem.usedPct} />
          <div className="mt-1 font-mono text-xs text-mist-dim">
            {gb(memUsedB)}/{gb(sys.mem.totalB)} GB
          </div>
        </StatTile>

        <StatTile label="swap" riseIndex={2}>
          <BigPct pct={sys.swap.usedPct} className={swapClass} />
          <div className="mt-1 font-mono text-xs text-mist-dim">
            {gb(swapUsedB)}/{gb(sys.swap.totalB)} GB
          </div>
        </StatTile>

        <StatTile label="gpu" riseIndex={3}>
          {sys.gpu ? (
            <>
              <BigPct pct={sys.gpu.utilPct} />
              <div className="mt-1 font-mono text-xs text-mist-dim">
                {sys.gpu.memUsedMiB}/{sys.gpu.memTotalMiB} MiB · {sys.gpu.tempC}°C
              </div>
              <div className="font-mono text-[11px] text-mist-faint">
                {sys.gpu.name} · {sys.gpu.powerW}W
              </div>
              {sys.gpu.procs.length > 0 && (
                <div className="mt-2 max-h-24 overflow-y-auto border-t pt-1.5 hairline">
                  {sys.gpu.procs.map((p) => (
                    <div key={p.pid} className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
                      <span className="text-mist-faint">{p.pid}</span>
                      <span className="min-w-0 truncate text-mist-dim">{p.name}</span>
                      <span className="ml-auto shrink-0 text-mist-faint">{p.memMiB} MiB</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="mt-2 text-sm text-mist-faint">no gpu</div>
          )}
        </StatTile>
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
        <Panel title="disks" riseIndex={4}>
          {sys.disks.length === 0 ? (
            <EmptyState>no disks</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sys.disks.map((d) => (
                <div key={d.mount} className="py-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-mist">{d.mount}</span>
                    <span className="shrink-0 font-mono text-xs text-mist-dim">
                      {gb(d.usedB)}/{gb(d.sizeB)} GB
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-white/10">
                    <div
                      className={`h-1 rounded-full ${d.usedPct > 85 ? 'bg-coral' : 'bg-jade'}`}
                      style={{ width: `${Math.min(100, d.usedPct)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="ports" riseIndex={5}>
          {sys.ports.length === 0 ? (
            <EmptyState>no listeners</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sys.ports.map((p) => (
                <Mutable key={p.port} snapshot={snapshot} kind="flag" target={`system:port:${p.port}`}>
                  <div className="group flex items-center gap-2 py-1 text-sm">
                    <span className={`w-14 shrink-0 font-mono ${p.known ? 'text-mist' : 'text-amber'}`}>
                      {p.port}
                    </span>
                    <span className="min-w-0 truncate text-mist-dim">{p.proc}</span>
                    <span className="flex-1" />
                    <span className={`shrink-0 font-mono text-xs ${p.known ? 'text-mist-faint' : 'text-amber'}`}>
                      {p.label ?? 'unknown'}
                    </span>
                    {!p.known && <MuteButton kind="flag" target={`system:port:${p.port}`} />}
                  </div>
                </Mutable>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="processes" riseIndex={6}>
          {sys.processes.length === 0 ? (
            <EmptyState>nothing notable</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <div className="grid grid-cols-[3.5rem_1fr_3.5rem_3.5rem] gap-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-mist-faint">
                <span>pid</span>
                <span />
                <span className="text-right">cpu%</span>
                <span className="text-right">mem%</span>
              </div>
              {sys.processes.map((p) => (
                <div key={p.pid} className="grid grid-cols-[3.5rem_1fr_3.5rem_3.5rem] items-baseline gap-2 py-1 text-sm">
                  <span className="font-mono text-xs text-mist-faint">{p.pid}</span>
                  <span className={`min-w-0 truncate ${p.label ? 'text-mist' : 'text-mist-dim'}`} title={p.cmd}>
                    {p.label ?? p.cmd}
                  </span>
                  <span className="text-right font-mono text-xs text-mist-dim">{p.cpuPct.toFixed(1)}</span>
                  <span className="text-right font-mono text-xs text-mist-dim">{p.memPct.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="services" riseIndex={7}>
          {sys.services.length === 0 ? (
            <EmptyState>no services watched</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sys.services.map((s) => (
                <Mutable key={s.unit} snapshot={snapshot} kind="service" target={s.unit}>
                  <div className="group flex items-center gap-2 py-1.5">
                    <Dot status={s.active === 'active' && s.sub === 'running' ? 'running' : 'error'} />
                    <span className="shrink-0 font-mono text-sm text-mist">{s.unit}</span>
                    <span className="min-w-0 truncate text-xs text-mist-dim">{s.description}</span>
                    <span className="flex-1" />
                    {/* enforce really stops the unit — destructive coral, important to beat base button colors */}
                    <MuteButton kind="service" target={s.unit} enforce className="text-coral! hover:text-coral!" />
                  </div>
                </Mutable>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
