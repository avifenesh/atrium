import type { ExtraSection, ExtraRow, Snapshot } from '../../../shared/types';
import { RelTime } from '../components/ui';

// Generic panel for plugin collectors that write the snapshot `extra` lane. A plugin
// that doesn't ship its own React panel still gets a clean view: header + status +
// label/value rows. Rich bespoke panels (revuto, itch) keep their own components; this
// is the zero-effort default for third-party collectors.

const TONE: Record<NonNullable<ExtraRow['tone']>, string> = {
  ok: 'text-jade',
  warn: 'text-amber',
  err: 'text-coral',
};

export default function ExtraPanel({ section, sectionKey }: { section: ExtraSection; sectionKey: string }) {
  const rows = section.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold lowercase tracking-wide text-mist">
          {section.title ?? sectionKey}
        </h2>
        <span className="font-mono text-[11px] text-mist-faint">
          {section.up === false ? 'down' : <RelTime iso={section.updatedAt} />}
        </span>
      </div>

      {section.error && (
        <div className="panel-surface rounded-lg p-4 text-sm text-coral">{section.error}</div>
      )}

      {rows.length === 0 && !section.error ? (
        <div className="panel-surface rounded-lg p-4 text-sm text-mist-faint">No data yet.</div>
      ) : (
        <div className="panel-surface rounded-lg p-4">
          <ul className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-mist-dim">{r.label}</span>
                {r.href ? (
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`truncate font-mono text-xs ${r.tone ? TONE[r.tone] : 'text-slate-glow'} hover:underline`}
                    title={r.value}
                  >
                    {r.value}
                  </a>
                ) : (
                  <span className={`truncate font-mono text-xs tabular-nums ${r.tone ? TONE[r.tone] : 'text-mist'}`} title={r.value}>
                    {r.value}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Names of plugin sections present in the snapshot, for dynamic view registration. */
export function extraKeys(snapshot: Snapshot): string[] {
  return Object.keys(snapshot.extra ?? {}).sort();
}
