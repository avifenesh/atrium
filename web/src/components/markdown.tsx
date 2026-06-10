import type { ReactNode } from 'react';

// Tiny markdown renderer — no deps, no dangerouslySetInnerHTML (React escapes
// everything, so untrusted github comment bodies can't inject html). Covers the
// common subset: h1-h4, bold, italic, inline code, fenced code, lists,
// blockquotes, links, wikilinks, hr. Single source: both the github item-detail
// reader and the notes panel import renderMarkdown/Markdown from here.

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

/** Render markdown text to React nodes. Caller wraps in a scroll/overflow container. */
export function renderMarkdown(content: string): ReactNode[] {
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

/** Convenience wrapper: render markdown inside a div. */
export function Markdown({ content, className = '' }: { content: string; className?: string }) {
  return <div className={`break-words ${className}`}>{renderMarkdown(content)}</div>;
}
