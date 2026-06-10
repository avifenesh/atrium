import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Snapshot } from '../../../shared/types';
import { fetchNote, saveNote, NoteConflictError, type NoteContent } from '../api';
import { Panel, RelTime, EmptyState, Row, CopyText } from '../components/ui';
import { renderMarkdown } from '../components/markdown';

// markdown rendering (h1-h4, bold, italic, inline code, fenced code, lists,
// blockquotes, links, wikilinks, hr) lives in ../components/markdown so the notes
// panel and the github reader share one escaped, no-dangerouslySetInnerHTML renderer.

// ---------- panel ----------

export default function NotesPanel({ snapshot }: { snapshot: Snapshot }) {
  const { vaultPath, recent, error, updatedAt } = snapshot.notes;

  const [openPath, setOpenPath] = useState<string | null>(null);
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

  const absPath = (path: string): string =>
    path.startsWith('/') ? path : vaultPath ? `${vaultPath}/${path}` : path;

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
  const requestLeave = (next: string | null): void => {
    if (dirty && !discardArm) {
      setDiscardArm(true);
      setTimeout(() => setDiscardArm(false), 4000); // disarm if they don't confirm
      return;
    }
    resetEdit();
    setOpenPath(next);
  };

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
      const { modifiedAt } = await saveNote(note.path, draft, overwrite ? undefined : note.modifiedAt);
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
    if (!openPath) return;
    let stale = false;
    setLoading(true);
    setNote(null);
    setNoteErr(null);
    resetEdit();
    fetchNote(openPath)
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
  }, [openPath]);

  // re-fetch the open note from disk (reload after a conflict, discarding the draft)
  const reloadNote = (): void => {
    if (!openPath) return;
    setLoading(true);
    setNoteErr(null);
    resetEdit();
    fetchNote(openPath)
      .then(setNote)
      .catch((err: unknown) => setNoteErr(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  // focus the textarea when entering edit mode
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!openPath) return;
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
      // inline discard guard first (second Escape confirms), never window.confirm
      if (e.key === 'Escape') requestLeave(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onKey closes over editing/draft/note/discardArm/saving — re-bind when they change
  }, [openPath, editing, draft, note, discardArm, saving]);

  const body = useMemo(() => (note ? renderMarkdown(note.content) : null), [note]);

  const list = (
    <Panel
      title="notes"
      riseIndex={0}
      right={
        openPath || !vaultPath ? <RelTime iso={updatedAt} /> : <span className="font-mono">{vaultPath}</span>
      }
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
              <Row
                key={n.path}
                onClick={() => requestLeave(n.path)}
                title={`read ${n.title}`}
                className={openPath === n.path ? 'bg-white/[0.05]' : ''}
              >
                <div className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm text-mist">{n.title}</span>
                  <span className="block truncate font-mono text-xs text-mist-faint">{n.path}</span>
                </div>
                <CopyText text={abs} className="hover-cluster shrink-0 px-1.5 py-0.5 font-mono text-[11px] text-mist-faint">
                  copy
                </CopyText>
                <a
                  href={`obsidian://open?path=${encodeURIComponent(abs)}`}
                  onClick={(e) => e.stopPropagation()}
                  title="open in obsidian"
                  className="hover-cluster shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
                >
                  obsidian
                </a>
                <RelTime iso={n.modifiedAt} />
              </Row>
            );
          })}
        </div>
      )}
    </Panel>
  );

  if (!openPath) return list;

  const meta = recent.find((n) => n.path === openPath);
  const title = note?.title ?? meta?.title ?? openPath.split('/').pop()!.replace(/\.md$/, '');
  const relPath = note?.path ?? openPath;
  const modifiedAt = note?.modifiedAt ?? meta?.modifiedAt ?? null;
  const abs = absPath(relPath);

  return (
    <div className="flex min-w-0 items-start gap-4">
      {/* list narrows to a left column; hidden below lg while reading */}
      <div className="hidden min-w-0 lg:block lg:w-72 lg:shrink-0">{list}</div>

      <section className="glass rise min-w-0 flex-1 p-4 xl:p-5" style={{ '--rise-i': 1 } as CSSProperties}>
        <header className="mb-3 flex min-w-0 items-baseline gap-3">
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
              {relPath}
            </div>
          </div>

          {saved && <span className="shrink-0 font-mono text-[11px] text-jade">saved</span>}
          <RelTime iso={modifiedAt} />

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
                onClick={() => requestLeave(openPath)}
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
              <CopyText text={abs} className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] text-mist-faint">
                copy path
              </CopyText>
              <a
                href={`obsidian://open?path=${encodeURIComponent(abs)}`}
                title="open in obsidian"
                className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
              >
                obsidian
              </a>
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
