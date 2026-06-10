import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Snapshot } from '../../../shared/types';
import { fetchNote, type NoteContent } from '../api';
import { Panel, RelTime, EmptyState, Row, CopyText } from '../components/ui';

// ---------- tiny markdown renderer (module-local, no deps) ----------
// Builds React elements from text — React escapes everything, no raw html ever
// (no dangerouslySetInnerHTML). Covers the obsidian-note subset: h1-h4, bold,
// italic, inline code, fenced code, lists, blockquotes, links, wikilinks, hr.

const LINK_SCHEME_RE = /^(https?|obsidian):/i;
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[\[[^\]]+\]\])|(\[[^\]]*\]\([^)\s]*\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}.${k++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded bg-white/5 px-1 font-mono text-xs">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={key} className="font-semibold text-mist">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else if (m[4]) {
      // [[wikilink]] / [[target|alias]] — slate-glow text, non-navigating
      const inner = tok.slice(2, -2);
      const label = inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner;
      out.push(
        <span key={key} className="text-slate-glow">
          {label}
        </span>,
      );
    } else {
      const lm = tok.match(/^\[([^\]]*)\]\(([^)\s]*)\)$/);
      const label = lm?.[1] ?? '';
      const url = lm?.[2] ?? '';
      if (lm && LINK_SCHEME_RE.test(url)) {
        out.push(
          <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="text-slate-glow hover:underline">
            {label}
          </a>,
        );
      } else {
        out.push(tok); // unknown scheme (javascript:, data:, relative): plain text
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mb-2 mt-5 text-lg font-semibold text-mist first:mt-0',
  2: 'mb-2 mt-4 text-base font-semibold text-mist first:mt-0',
  3: 'mb-1.5 mt-4 text-sm font-semibold text-mist first:mt-0',
  4: 'mb-1.5 mt-3 text-sm font-medium text-mist-dim first:mt-0',
};

const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^\s*[-*]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const QUOTE_RE = /^>\s?/;

function isBlockStart(line: string): boolean {
  return (
    /^#{1,4}\s/.test(line) ||
    line.startsWith('```') ||
    QUOTE_RE.test(line) ||
    HR_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line)
  );
}

function renderMarkdown(content: string): ReactNode[] {
  const lines = content.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(
        <pre
          key={key++}
          className="glass my-3 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-mist-dim"
        >
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      const k = key++;
      out.push(
        <Tag key={k} className={HEADING_CLASS[level]}>
          {renderInline(h[2], `h${k}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(<hr key={key++} className="my-4 hairline" />);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE_RE, ''));
        i++;
      }
      const k = key++;
      out.push(
        <blockquote key={k} className="hairline my-2 border-l-2 pl-3 text-sm leading-relaxed text-mist-dim">
          {buf.map((b, j) => (
            <div key={j}>{renderInline(b, `q${k}.${j}`)}</div>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].replace(re, ''));
        i++;
      }
      const k = key++;
      const lis = items.map((it, j) => (
        <li key={j} className="text-sm leading-relaxed text-mist">
          {renderInline(it, `l${k}.${j}`)}
        </li>
      ));
      out.push(
        ordered ? (
          <ol key={k} className="my-2 list-decimal space-y-1 pl-5 marker:text-mist-faint">
            {lis}
          </ol>
        ) : (
          <ul key={k} className="my-2 list-disc space-y-1 pl-5 marker:text-mist-faint">
            {lis}
          </ul>
        ),
      );
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph: consume until blank line or the start of another block
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    const k = key++;
    const parts: ReactNode[] = [];
    buf.forEach((b, j) => {
      if (j > 0) parts.push(<br key={`br${j}`} />);
      parts.push(...renderInline(b, `p${k}.${j}`));
    });
    out.push(
      <p key={k} className="my-2 text-sm leading-relaxed text-mist first:mt-0">
        {parts}
      </p>,
    );
  }
  return out;
}

// ---------- panel ----------

export default function NotesPanel({ snapshot }: { snapshot: Snapshot }) {
  const { vaultPath, recent, error, updatedAt } = snapshot.notes;

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [note, setNote] = useState<NoteContent | null>(null);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const absPath = (path: string): string =>
    path.startsWith('/') ? path : vaultPath ? `${vaultPath}/${path}` : path;

  useEffect(() => {
    if (!openPath) return;
    let stale = false;
    setLoading(true);
    setNote(null);
    setNoteErr(null);
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

  useEffect(() => {
    if (!openPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPath(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPath]);

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
                onClick={() => setOpenPath(n.path)}
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
            onClick={() => setOpenPath(null)}
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
          <RelTime iso={modifiedAt} />
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
            onClick={() => setOpenPath(null)}
            title="close (esc)"
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
          >
            close
          </button>
        </header>

        {loading && <div className="animate-pulse px-1 py-6 text-sm text-mist-faint">loading…</div>}
        {noteErr && (
          <div className="rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{noteErr}</div>
        )}
        {body && <div className="max-h-[70vh] overflow-y-auto break-words pr-1">{body}</div>}
      </section>
    </div>
  );
}
