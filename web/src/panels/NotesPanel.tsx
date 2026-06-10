import { useState } from 'react';
import type { Snapshot } from '../../../shared/types';
import { Panel, RelTime, EmptyState } from '../components/ui';

export default function NotesPanel({ snapshot }: { snapshot: Snapshot }) {
  const { vaultPath, recent, error, updatedAt } = snapshot.notes;
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (path: string) => {
    const abs = path.startsWith('/') ? path : vaultPath ? `${vaultPath}/${path}` : path;
    try {
      await navigator.clipboard.writeText(abs);
      setCopied(path);
      window.setTimeout(() => setCopied((c) => (c === path ? null : c)), 1500);
    } catch {
      // clipboard unavailable (non-secure context) — stay quiet
    }
  };

  return (
    <Panel
      title="notes"
      riseIndex={0}
      right={vaultPath ? <span className="font-mono">{vaultPath}</span> : <RelTime iso={updatedAt} />}
    >
      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}
      {recent.length === 0 ? (
        <EmptyState>no recent notes</EmptyState>
      ) : (
        <ul className="max-h-[34rem] overflow-y-auto">
          {recent.map((n) => (
            <li key={n.path}>
              <button
                onClick={() => void copy(n.path)}
                title="copy path"
                className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-mist">{n.title}</span>
                  <span className="block truncate font-mono text-xs text-mist-faint">{n.path}</span>
                </span>
                {copied === n.path ? (
                  <span className="shrink-0 font-mono text-xs text-jade">copied</span>
                ) : (
                  <RelTime iso={n.modifiedAt} />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
