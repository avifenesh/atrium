import { useState, type CSSProperties, type ReactNode } from 'react';
import { isMuted, refreshSection, stopPort, teachPort } from '../api';
import Spark from '../components/Spark';
import { CopyText, Dot, EmptyState, MuteButton, Panel, RelTime, Row } from '../components/ui';
import { getSeries, pctTone } from '../hooks';
import type { PortScope, Snapshot } from '../../../shared/types';

const GiB = 1024 ** 3;

function gb(bytes: number): string {
  const v = bytes / GiB;
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

function scopeLabel(scope: PortScope): string {
  if (scope === 'lan') return 'LAN — every local interface';
  if (scope === 'tailnet') return 'tailnet only';
  if (scope === 'wg') return 'wg-trace';
  return 'loopback';
}

function ScopePip({ scope }: { scope: PortScope }) {
  return <span className={`scope-pip scope-pip-${scope} shrink-0`} title={scopeLabel(scope)} />;
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
    <div className="panel-surface rise min-w-0 p-4" style={{ '--rise-i': riseIndex } as CSSProperties}>
      <div className="text-xs font-medium text-mist-dim">{label}</div>
      {children}
    </div>
  );
}

/** Large numeral — mono per v2 (font-display is reserved for the wordmark + now view). */
function BigPct({ pct, className = 'text-mist' }: { pct: number; className?: string }) {
  return (
    <div className={`font-mono text-3xl leading-tight tabular-nums ${className}`}>
      {Math.round(pct)}
      <span className="text-base text-mist-dim">%</span>
    </div>
  );
}

function PortRow({ port: p }: { port: Snapshot['system']['ports'][number] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (kind: 'teach' | 'stop') => {
    setBusy(kind);
    try {
      if (kind === 'teach') {
        const res = await teachPort(p.port, p.label ?? (p.proc || undefined));
        setNote(`taught as ${res.label}`);
      } else {
        const res = await stopPort(p.port);
        setNote(`sent SIGTERM to ${res.pid}`);
      }
      await refreshSection('system');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setArmed(false);
      window.setTimeout(() => setNote(null), 4000);
    }
  };
  return (
    <Row id={`port-${p.port}`} className="group">
      <div className="flex w-full min-w-0 items-center gap-2">
        <CopyText text={String(p.port)}>
          <span
            className={`w-14 shrink-0 text-left font-mono text-sm tabular-nums ${p.known ? 'text-mist' : 'text-amber'}`}
          >
            {p.port}
          </span>
        </CopyText>
        <div className="min-w-0 flex-1 overflow-hidden">
          <CopyText text={p.proc}>
            <span className="block truncate text-left text-sm text-mist-dim" title={p.proc}>
              {p.proc}
            </span>
          </CopyText>
        </div>
        <ScopePip scope={p.scope} />
        <span className={`shrink-0 font-mono text-xs ${p.known ? 'text-mist-faint' : 'text-amber'}`}>
          {p.label ?? 'unknown'}
        </span>
        {!p.known && (
          <span className="row-actions mobile-row-actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('teach')}
              className="hover-cluster shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-jade disabled:opacity-40"
            >
              {busy === 'teach' ? '…' : 'teach'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  window.setTimeout(() => setArmed(false), 4000);
                  return;
                }
                void run('stop');
              }}
              className={`hover-cluster shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-40 ${
                armed ? 'text-coral' : 'text-mist-faint hover:text-coral'
              }`}
            >
              {busy === 'stop' ? '…' : armed ? 'sure?' : 'stop'}
            </button>
            <MuteButton kind="flag" target={`system:port:${p.port}`} />
          </span>
        )}
        {note && <span className="shrink-0 font-mono text-[10px] text-mist-faint">{note}</span>}
      </div>
    </Row>
  );
}

export default function SystemPanel({
  snapshot,
  onOpenQuiet: openQuiet,
}: {
  snapshot: Snapshot;
  onOpenQuiet: () => void;
}) {
  const sys = snapshot.system;
  const memUsedB = sys.mem.totalB - sys.mem.availableB;
  const swapUsedB = sys.swap.totalB - sys.swap.freeB;
  const swapClass =
    sys.swap.usedPct > 90 ? 'text-coral' : sys.swap.usedPct > 75 ? 'text-amber' : 'text-mist';

  // muted ports/services disappear — counts surface on the panel header chips
  const visiblePorts = sys.ports.filter((p) => !isMuted(snapshot, 'flag', `system:port:${p.port}`));
  const quietPorts = sys.ports.length - visiblePorts.length;
  const visibleServices = sys.services.filter((s) => !isMuted(snapshot, 'service', s.unit));
  const quietServices = sys.services.length - visibleServices.length;

  return (
    <div>
      {(sys.error || sys.updatedAt) && (
        <div className="mb-3 flex items-baseline gap-2">
          {sys.error && <span className="min-w-0 truncate font-mono text-xs text-coral">{sys.error}</span>}
          {sys.updatedAt && (
            <span className="ml-auto flex shrink-0 items-baseline gap-1.5 font-mono text-[11px] text-mist-faint">
              updated <RelTime iso={sys.updatedAt} />
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="cpu" riseIndex={0}>
          <div className="flex min-w-0 items-end justify-between gap-2">
            <BigPct pct={sys.cpu.pct} />
            <Spark series={getSeries('cpu')} className={`mb-1 shrink-0 ${pctTone(sys.cpu.pct)}`} />
          </div>
          <div className="mt-1 font-mono text-xs tabular-nums text-mist-dim">
            {sys.cpu.load1.toFixed(2)} / {sys.cpu.load5.toFixed(2)} / {sys.cpu.load15.toFixed(2)} · {sys.cpu.cores}c
          </div>
        </StatTile>

        <StatTile label="mem" riseIndex={1}>
          <div className="flex min-w-0 items-end justify-between gap-2">
            <BigPct pct={sys.mem.usedPct} />
            <Spark series={getSeries('mem')} className={`mb-1 shrink-0 ${pctTone(sys.mem.usedPct)}`} />
          </div>
          <div className="mt-1 font-mono text-xs tabular-nums text-mist-dim">
            {gb(memUsedB)}/{gb(sys.mem.totalB)} <span className="text-mist-faint">GB</span>
          </div>
        </StatTile>

        <StatTile label="swap" riseIndex={2}>
          <div className="flex min-w-0 items-end justify-between gap-2">
            <BigPct pct={sys.swap.usedPct} className={swapClass} />
            <Spark series={getSeries('swap')} className={`mb-1 shrink-0 ${pctTone(sys.swap.usedPct)}`} />
          </div>
          <div className="mt-1 font-mono text-xs tabular-nums text-mist-dim">
            {gb(swapUsedB)}/{gb(sys.swap.totalB)} <span className="text-mist-faint">GB</span>
          </div>
        </StatTile>

        <StatTile label="gpu" riseIndex={3}>
          {sys.gpu ? (
            <>
              <div className="flex min-w-0 items-end justify-between gap-2">
                <BigPct pct={sys.gpu.utilPct} />
                <Spark series={getSeries('gpu')} className={`mb-1 shrink-0 ${pctTone(sys.gpu.utilPct)}`} />
              </div>
              <div className="mt-1 font-mono text-xs tabular-nums text-mist-dim">
                {sys.gpu.memUsedMiB}/{sys.gpu.memTotalMiB} <span className="text-mist-faint">MiB</span> · {sys.gpu.tempC}°C
              </div>
              <div className="truncate font-mono text-[11px] tabular-nums text-mist-faint">
                {sys.gpu.name} · {sys.gpu.powerW}W
              </div>
              {sys.gpu.procs.length > 0 && (
                <div className="mt-2 max-h-24 overflow-y-auto border-t pt-1.5 hairline">
                  {sys.gpu.procs.map((p) => (
                    <div key={p.pid} className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
                      <span className="tabular-nums text-mist-faint">{p.pid}</span>
                      <span className="min-w-0 truncate text-mist-dim">{p.name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-mist-faint">{p.memMiB} MiB</span>
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
        <Panel title="Storage" riseIndex={4}>
          {sys.disks.length === 0 ? (
            <EmptyState>No disks were reported.</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sys.disks.map((d) => (
                <div key={d.mount} id={`disk-${d.mount}`} className="py-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-mist">{d.mount}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-mist-dim">
                      {gb(d.usedB)}/{gb(d.sizeB)} <span className="text-mist-faint">GB</span>
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

        <Panel
          title="Listening ports"
          riseIndex={5}
          quietCount={quietPorts || undefined}
          onQuietClick={openQuiet}
        >
          {visiblePorts.length === 0 ? (
            <EmptyState>No listening ports were reported.</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {visiblePorts.map((p) => (
                <PortRow key={p.port} port={p} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Notable processes" riseIndex={6}>
          {sys.processes.length === 0 ? (
            <EmptyState>No notable processes.</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <div className="flex items-baseline gap-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-mist-faint">
                <span className="w-14 shrink-0">pid</span>
                <span className="min-w-0 flex-1" />
                <span className="w-14 shrink-0 text-right">cpu%</span>
                <span className="w-14 shrink-0 text-right">mem%</span>
              </div>
              {sys.processes.map((p) => (
                <Row key={p.pid} className="group">
                  <div className="flex w-full min-w-0 items-baseline gap-2">
                    <CopyText text={String(p.pid)}>
                      <span className="w-14 shrink-0 text-left font-mono text-xs tabular-nums text-mist-faint">
                        {p.pid}
                      </span>
                    </CopyText>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <CopyText text={p.cmd}>
                        <span
                          className={`block truncate text-left text-sm ${p.label ? 'text-mist' : 'text-mist-dim'}`}
                          title={p.cmd}
                        >
                          {p.label ?? p.cmd}
                        </span>
                      </CopyText>
                    </div>
                    <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-mist-dim">
                      {p.cpuPct.toFixed(1)}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-mist-dim">
                      {p.memPct.toFixed(1)}
                    </span>
                  </div>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Watched services"
          riseIndex={7}
          quietCount={quietServices || undefined}
          onQuietClick={openQuiet}
        >
          {visibleServices.length === 0 ? (
            <EmptyState>
              No services are being watched. Add unit names under{' '}
              <span className="font-mono text-mist-dim">watchedUnits</span> in{' '}
              <span className="font-mono text-mist-dim">~/.config/atrium/config.json</span>, then restart atrium.
            </EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {visibleServices.map((s) => (
                <Row key={s.unit} id={`unit-${s.unit}`} className="group">
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <Dot status={s.active === 'active' && s.sub === 'running' ? 'running' : 'error'} />
                    <div className="min-w-0 overflow-hidden">
                      <CopyText text={s.unit}>
                        <span className="block truncate text-left font-mono text-sm text-mist" title={s.unit}>
                          {s.unit}
                        </span>
                      </CopyText>
                    </div>
                    <span className="min-w-0 flex-1 truncate text-xs text-mist-dim" title={s.description}>
                      {s.description}
                    </span>
                    {/* enforce really stops the unit — two-click arm; coral to beat base button colors */}
                    <MuteButton kind="service" target={s.unit} enforce className="text-coral! hover:text-coral!" />
                  </div>
                </Row>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
