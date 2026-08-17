import { useState } from 'react';
import type { ExtraRow, ExtraSection } from '../../../shared/types';
import { RelTime } from '../components/ui';

// Operator panel for the hosted inference product. The rows come from the tiyuvta
// collector; the buttons are the reason this is a bespoke panel instead of the generic
// one — the console's admin PAGES were retired, so this is where the periodic jobs are
// run from.
//
// The destructive-ish ones (suspend) and the per-account ones are deliberately not
// here: they need a tenant id, and a button that suspends whichever account is typed
// into a box is a worse surface than a documented curl. Account-scoped actions stay in
// the API. What lives here are the global jobs, all idempotent by design and safe to
// press twice.

const TONE: Record<NonNullable<ExtraRow['tone']>, string> = {
  ok: 'text-jade',
  warn: 'text-amber',
  err: 'text-coral',
};

const JOBS: Array<{ action: string; label: string; hint: string }> = [
  { action: 'accounting', label: 'accounting pass', hint: 'restates the books against the engine' },
  { action: 'enrolments', label: 'repair enrolments', hint: 'enrols accounts the engine never accepted, and grants their trial credit' },
  { action: 'auto-topups', label: 'auto top-ups', hint: 'charges accounts under their threshold' },
  { action: 'training-rebates', label: 'training rebates', hint: 'pays 5% on closed consented days' },
  { action: 'alert-test', label: 'test alert', hint: 'proves owner alerts still deliver' },
];

export default function TiyuvtaPanel({ section }: { section: ExtraSection }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ action: string; ok: boolean; text: string } | null>(null);
  const rows = section.rows ?? [];

  async function run(action: string) {
    setBusy(action);
    setResult(null);
    try {
      const response = await fetch(`/api/tiyuvta/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const payload = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
      setResult({
        action,
        ok: response.ok,
        // The console answers with its own counts (credited, skipped, …). Showing them
        // verbatim beats a green tick that hides "skipped: 11".
        text: response.ok ? JSON.stringify(payload.result ?? {}).slice(0, 300) : payload.error ?? `HTTP ${response.status}`,
      });
    } catch (error) {
      setResult({ action, ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold lowercase tracking-wide text-mist">
          {section.title ?? 'tiyuvta'}
        </h2>
        <span className="font-mono text-[11px] text-mist-faint">
          {section.up === false ? 'down' : <RelTime iso={section.updatedAt} />}
        </span>
      </div>

      {section.error && (
        <div className="panel-surface rounded-lg p-4 text-sm text-coral">{section.error}</div>
      )}

      {rows.length > 0 && (
        <div className="panel-surface rounded-lg p-4">
          <ul className="space-y-1.5">
            {rows.map((row, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-mist-dim">{row.label}</span>
                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className={`font-mono text-right ${row.tone ? TONE[row.tone] : 'text-mist'} hover:underline`}
                  >
                    {row.value}
                  </a>
                ) : (
                  <span className={`font-mono text-right ${row.tone ? TONE[row.tone] : 'text-mist'}`}>
                    {row.value}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel-surface rounded-lg p-4">
        <div className="mb-3 text-[11px] uppercase tracking-wider text-mist-faint">jobs</div>
        <div className="flex flex-wrap gap-2">
          {JOBS.map((job) => (
            <button
              key={job.action}
              type="button"
              title={job.hint}
              disabled={busy !== null}
              onClick={() => void run(job.action)}
              className="rounded border border-white/10 px-3 py-1.5 text-xs text-mist hover:border-white/25 disabled:opacity-40"
            >
              {busy === job.action ? `${job.label}…` : job.label}
            </button>
          ))}
        </div>
        {result && (
          <pre
            className={`mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] ${
              result.ok ? 'text-jade' : 'text-coral'
            }`}
          >
            {result.action}: {result.text}
          </pre>
        )}
        <p className="mt-3 text-[11px] text-mist-faint">
          All of these are idempotent — pressing one twice does not double-charge,
          double-credit or double-enrol. Account-scoped actions (enroll, suspend,
          restore) stay in the API on purpose.
        </p>
      </div>
    </div>
  );
}
