import type { Snapshot } from '../../../shared/types';
import { Panel, RelTime, EmptyState, Row, CopyText } from '../components/ui';

export default function NotesPanel({ snapshot }: { snapshot: Snapshot }) {
  const { vaultPath, recent, error, updatedAt } = snapshot.notes;

  const absPath = (path: string): string =>
    path.startsWith('/') ? path : vaultPath ? `${vaultPath}/${path}` : path;

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
        <div className="max-h-[34rem] overflow-y-auto">
          {recent.map((n) => {
            const abs = absPath(n.path);
            return (
              <Row key={n.path} className="group">
                <div className="flex w-full min-w-0 items-baseline gap-3">
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <CopyText text={abs}>
                      <span className="block min-w-0 text-left" title={`copy ${abs}`}>
                        <span className="block truncate text-sm text-mist">{n.title}</span>
                        <span className="block truncate font-mono text-xs text-mist-faint">{n.path}</span>
                      </span>
                    </CopyText>
                  </div>
                  <a
                    href={`obsidian://open?path=${encodeURIComponent(abs)}`}
                    onClick={(e) => e.stopPropagation()}
                    title="open in obsidian"
                    className="invisible shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors group-hover:visible group-focus-within:visible hover:text-slate-glow"
                  >
                    obsidian
                  </a>
                  <RelTime iso={n.modifiedAt} />
                </div>
              </Row>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
