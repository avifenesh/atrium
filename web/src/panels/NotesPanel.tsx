import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { NoteEntry, Snapshot } from '../../../shared/types';
import { fetchNote, saveNote, NoteConflictError, type NoteContent } from '../api';
import { Panel, RelTime, EmptyState, Row, CopyText } from '../components/ui';
import { renderMarkdown } from '../components/markdown';

// markdown rendering (h1-h4, bold, italic, inline code, fenced code, lists,
// blockquotes, links, wikilinks, hr) lives in ../components/markdown so the notes
// panel and the github reader share one escaped, no-dangerouslySetInnerHTML renderer.

export interface NoteTarget {
  root: string;
  path: string;
}

const LIST_ROWS = 200; // rendered rows cap — search reaches everything, the DOM doesn't

// ---------- panel ----------

export default function NotesPanel({
  snapshot,
  overlayOpen = false,
  openTarget = null,
  onOpenTargetConsumed,
}: {
  snapshot: Snapshot;
  /** palette / slide-over / quiet drawer open — they own esc, the reader must not also close */
  overlayOpen?: boolean;
  /** pending palette jump — one-shot, consumed on arrival (itch scrollTarget idiom) */
  openTarget?: NoteTarget | null;
  onOpenTargetConsumed?: () => void;
}) {
  const { vaultPath, roots, error, updatedAt } = snapshot.notes;
  // full multi-root list; fall back to the legacy vault slice for an older server
  const allNotes: NoteEntry[] = useMemo(
    () =>
      snapshot.notes.notes?.length
        ? snapshot.notes.notes
        : (snapshot.notes.recent ?? []).map((n) => ({ ...n, root: 'vault' })),
    [snapshot.notes.notes, snapshot.notes.recent],
  );

  const [open, setOpen] = useState<NoteTarget | null>(null);
  const [query, setQuery] = useState('');
  const [rootFilter, setRootFilter] = useState<string | null>(null);
  const [note, setNote] = useState<NoteContent | null>(null);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // edit mode
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false); // changed-on-disk — offer reload/overwrite
  const [saved, setSaved] = useState(false); // transient "saved" flash
  const [discardArm, setDiscardArm] = useState(false); // two-step unsaved-changes guard
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = editing && note !== null && draft !== note.content;

  const rootPath = (rootId: string): string | null =>
    roots?.find((r) => r.id === rootId)?.path ?? (rootId === 'vault' ? vaultPath : null);

  const absPath = (t: NoteTarget): string => {
    if (t.path.startsWith('/')) return t.path;
    const base = rootPath(t.root);
    return base ? `${base}/${t.path}` : t.path;
  };

  // leave edit mode and clear all edit-scoped transient state
  const resetEdit = (): void => {
    setEditing(false);
    setDraft('');
    setSaveErr(null);
    setConflict(false);
    setDiscardArm(false);
  };

  // request to leave the current note (close or switch). If editing with unsaved
  // changes, arm an inline "discard?" instead of dropping the edits silently.
  const requestLeave = (next: NoteTarget | null): void => {
    if (dirty && !discardArm) {
      setDiscardArm(true);
      setTimeout(() => setDiscardArm(false), 4000); // disarm if they don't confirm
      return;
    }
    resetEdit();
    setOpen(next);
  };

  // palette jump — consume the target, then route through requestLeave so a dirty
  // edit arms the discard guard instead of silently dropping the draft (a second
  // palette jump within the arm window completes the leave)
  useEffect(() => {
    if (!openTarget) return;
    onOpenTargetConsumed?.();
    requestLeave(openTarget);
    // requestLeave/onOpenTargetConsumed are render-fresh — fire once per target
  }, [openTarget]);

  const beginEdit = (): void => {
    if (!note) return;
    setDraft(note.content);
    setSaveErr(null);
    setConflict(false);
    setDiscardArm(false);
    setEditing(true);
  };

  // when overwrite=true the conflict guard is dropped (baseModifiedAt omitted)
  const doSave = async (overwrite = false): Promise<void> => {
    if (!note || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const { modifiedAt } = await saveNote(note.path, draft, overwrite ? undefined : note.modifiedAt, note.root);
      setNote({ ...note, content: draft, modifiedAt });
      resetEdit();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      if (err instanceof NoteConflictError) setConflict(true);
      else setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setNote(null);
    setNoteErr(null);
    resetEdit();
    fetchNote(open.path, open.root)
      .then((n) => {
        if (!stale) setNote(n);
      })
      .catch((err: unknown) => {
        if (!stale) setNoteErr(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [open?.root, open?.path]);

  // re-fetch the open note from disk (reload after a conflict, discarding the draft)
  const reloadNote = (): void => {
    if (!open) return;
    setLoading(true);
    setNoteErr(null);
    resetEdit();
    fetchNote(open.path, open.root)
      .then(setNote)
      .catch((err: unknown) => setNoteErr(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  // focus the textarea when entering edit mode
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+S saves while editing (and only then) — let the browser save dialog
      // fire normally when we're just reading
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (editing) {
          e.preventDefault();
          void doSave();
        }
        return;
      }
      // Escape closes the reader; while editing with unsaved changes it arms the
      // inline discard guard first (second Escape confirms), never window.confirm.
      // Overlays (palette / slide-over / drawer) own esc while open — bail.
      if (e.key === 'Escape' && !overlayOpen) requestLeave(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onKey closes over editing/draft/note/discardArm/saving — re-bind when they change
  }, [open, editing, draft, note, discardArm, saving, overlayOpen]);

  const body = useMemo(() => (note ? renderMarkdown(note.content) : null), [note]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      allNotes.filter(
        (n) =>
          (rootFilter === null || n.root === rootFilter) &&
          (q === '' || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)),
      ),
    [allNotes, rootFilter, q],
  );
  const shown = filtered.slice(0, LIST_ROWS);
  const showRoots = (roots?.length ?? 0) > 1;

  const list = (
    <Panel
      title="Notes"
      riseIndex={0}
      right={
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-xs tabular-nums text-mist-faint">
            {q || rootFilter ? `${filtered.length} / ${allNotes.length}` : allNotes.length}
          </span>
          <RelTime iso={updatedAt} />
        </span>
      }
    >
      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}
      <div className="mb-2 flex flex-col gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or path…"
          aria-label="Search notes"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-mist placeholder:text-mist-faint focus:border-amber/50 focus:outline-none"
        />
        {showRoots && (
          <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            <button
              type="button"
              onClick={() => setRootFilter(null)}
              className={`cursor-pointer rounded px-2 py-1 transition-colors ${rootFilter === null ? 'bg-white/10 text-mist' : 'text-mist-faint hover:text-mist'}`}
            >
              all
            </button>
            {roots.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRootFilter((cur) => (cur === r.id ? null : r.id))}
                title={`${r.path}${r.truncated ? ' — list truncated at the walk cap' : ''}`}
                className={`cursor-pointer rounded px-2 py-1 transition-colors ${rootFilter === r.id ? 'bg-white/10 text-mist' : 'text-mist-faint hover:text-mist'}`}
              >
                {r.label} <span className="tabular-nums">{r.count}</span>
                {r.truncated ? '+' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <EmptyState>{q ? 'No notes match that search.' : 'No notes were found.'}</EmptyState>
      ) : (
        <div className="max-h-[34rem] overflow-y-auto">
          {shown.map((n) => {
            const target = { root: n.root, path: n.path };
            const abs = absPath(target);
            const isOpen = open?.root === n.root && open?.path === n.path;
            return (
              <Row
                key={`${n.root}:${n.path}`}
                onClick={() => requestLeave(target)}
                title={`read ${n.title}`}
                className={isOpen ? 'bg-white/[0.05]' : ''}
              >
                <div className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm text-mist">{n.title}</span>
                  <span className="block truncate font-mono text-xs text-mist-faint">
                    {showRoots && n.root !== 'vault' ? `${n.root} · ` : ''}
                    {n.path}
                  </span>
                </div>
                <RelTime iso={n.modifiedAt} />
                <span className="flex shrink-0 items-center gap-1">
                  {n.root === 'vault' && (
                    <a
                      href={`obsidian://open?path=${encodeURIComponent(abs)}`}
                      onClick={(e) => e.stopPropagation()}
                      title="open in obsidian"
                      className="hover-cluster shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
                    >
                      obsidian
                    </a>
                  )}
                  <CopyText text={abs} className="hover-cluster shrink-0 px-1.5 py-0.5 font-mono text-[11px] text-mist-faint">
                    copy
                  </CopyText>
                </span>
              </Row>
            );
          })}
          {filtered.length > LIST_ROWS && (
            <div className="px-2.5 py-2 font-mono text-[11px] text-mist-faint">
              … {filtered.length - LIST_ROWS} more — narrow the search to reach them
            </div>
          )}
        </div>
      )}
    </Panel>
  );

  if (!open) return list;

  const meta = allNotes.find((n) => n.root === open.root && n.path === open.path);
  const title = note?.title ?? meta?.title ?? open.path.split('/').pop()!.replace(/\.(md|txt)$/, '');
  const relPath = note?.path ?? open.path;
  const modifiedAt = note?.modifiedAt ?? meta?.modifiedAt ?? null;
  const abs = absPath(open);

  return (
    <div className="flex min-w-0 items-start gap-4">
      {/* list narrows to a left column; hidden below lg while reading */}
      <div className="hidden min-w-0 lg:block lg:w-72 lg:shrink-0">{list}</div>

      <section className="panel-surface rise min-w-0 flex-1 p-4 xl:p-5" style={{ '--rise-i': 1 } as CSSProperties}>
        <header className="mb-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-baseline sm:gap-3">
          <div className="flex min-w-0 items-baseline gap-3 sm:flex-1">
            <button
              type="button"
              onClick={() => requestLeave(null)}
              title="back to notes"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist lg:hidden"
            >
              ← notes
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-mist" title={title}>
                {title}
              </div>
              <div className="truncate font-mono text-xs text-mist-faint" title={relPath}>
                {showRoots && open.root !== 'vault' ? `${open.root} · ` : ''}
                {relPath}
              </div>
            </div>
            {saved && <span className="shrink-0 font-mono text-[11px] text-jade">saved</span>}
            <RelTime iso={modifiedAt} />
          </div>

          <div className="mobile-actions flex min-w-0 flex-wrap items-center justify-end gap-1 sm:shrink-0">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => void doSave()}
                  disabled={saving || !dirty}
                  title="save (⌘/ctrl+s)"
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-amber transition-colors hover:text-mist disabled:cursor-default disabled:text-mist-faint"
                >
                  {saving ? '…' : 'save'}
                </button>
                <button
                  type="button"
                  onClick={() => requestLeave(open)}
                  title={dirty ? 'discard changes' : 'cancel edit'}
                  className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    discardArm ? 'text-coral hover:text-coral' : 'text-mist-faint hover:text-mist'
                  }`}
                >
                  {discardArm ? 'discard?' : 'cancel'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={beginEdit}
                  disabled={!note}
                  title="edit this note"
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber disabled:cursor-default disabled:opacity-40"
                >
                  edit
                </button>
                {open.root === 'vault' && (
                  <a
                    href={`obsidian://open?path=${encodeURIComponent(abs)}`}
                    title="open in obsidian"
                    className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
                  >
                    obsidian
                  </a>
                )}
                <CopyText text={abs} className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] text-mist-faint">
                  copy path
                </CopyText>
                <button
                  type="button"
                  onClick={() => requestLeave(null)}
                  title="close (esc)"
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
                >
                  close
                </button>
              </>
            )}
          </div>
        </header>

        {/* changed-on-disk: offer reload (drop my edits) or overwrite (force my save) */}
        {conflict && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">
            <span className="min-w-0 flex-1">changed on disk — reload or overwrite</span>
            <button
              type="button"
              onClick={reloadNote}
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
            >
              reload
            </button>
            <button
              type="button"
              onClick={() => void doSave(true)}
              disabled={saving}
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-amber transition-colors hover:text-mist disabled:cursor-default disabled:text-mist-faint"
            >
              {saving ? '…' : 'overwrite'}
            </button>
          </div>
        )}
        {saveErr && (
          <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{saveErr}</div>
        )}

        {loading && <div className="animate-pulse px-1 py-6 text-sm text-mist-faint">loading…</div>}
        {noteErr && (
          <div className="rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{noteErr}</div>
        )}

        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="glass h-[70vh] w-full resize-none break-words rounded-lg p-3 font-mono text-sm leading-relaxed text-mist outline-none focus:ring-1 focus:ring-amber/30"
          />
        ) : (
          body && <div className="max-h-[70vh] overflow-y-auto break-words pr-1">{body}</div>
        )}
      </section>
    </div>
  );
}
