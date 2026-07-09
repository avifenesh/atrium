import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

type PileItem = {
  id: string;
  url: string;
  kind: string;
  source: string;
  title: string;
  abstract?: string | null;
  thumb?: string | null;
  author?: string | null;
  points?: number | null;
  score?: number | null;
  theme?: number | null;
  theme_label?: string | null;
  why?: string | null;
};

type PileRow = { title: string; theme?: number; items: PileItem[] };
type PileTheme = { cid: number; label: string; count: number; slug?: string };
type PileFeed = { hero: PileItem | null; rows: PileRow[]; themes: PileTheme[] };

const SOURCE_LABEL: Record<string, string> = {
  hn: 'Hacker News',
  arxiv: 'arXiv',
  devto: 'DEV',
  youtube: 'YouTube',
  x: 'X',
  rss: 'RSS',
};

const SOURCE_COLOR: Record<string, string> = {
  hn: '#a76c42',
  arxiv: '#98665f',
  devto: '#667c9e',
  youtube: '#9c615f',
  x: '#66869c',
  rss: '#9a8056',
};

function pileEvent(itemId: string, event: string, value?: number): void {
  void fetch('/api/streampile/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item_id: itemId, event, value: value ?? null }),
  }).catch(() => {});
}

function itemBackdrop(item: PileItem): CSSProperties {
  if (item.thumb) return { backgroundImage: `url(${JSON.stringify(item.thumb)})` };
  const color = SOURCE_COLOR[item.source] ?? '#596475';
  return { background: `linear-gradient(145deg, ${color}, #111821 78%)` };
}

function PileCard({ item, onOpen }: { item: PileItem; onOpen: (item: PileItem) => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          pileEvent(item.id, 'impression');
          observer.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [item.id]);

  return (
    <button ref={ref} type="button" className="pile-card group" onClick={() => onOpen(item)}>
      <span className="pile-card-image" style={itemBackdrop(item)} aria-hidden="true" />
      <span className="pile-card-wash" aria-hidden="true" />
      <span className="pile-card-content">
        <span className="pile-source">{SOURCE_LABEL[item.source] ?? item.source}</span>
        <span className="pile-card-title">{item.title}</span>
        <span className="pile-card-meta">
          {item.points != null && <span>{item.points} points</span>}
          {item.author && <span>{item.author}</span>}
          <span>{item.kind}</span>
        </span>
        {item.why && <span className="pile-card-why">{item.why}</span>}
      </span>
    </button>
  );
}

function PileRowTrack({ row, onOpen }: { row: PileRow; onOpen: (item: PileItem) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const shift = (direction: number) => {
    const el = trackRef.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.78, behavior: 'smooth' });
  };

  return (
    <section className="pile-row">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold tracking-wide text-mist">{row.title}</h2>
        <div className="hidden items-center gap-1 sm:flex">
          <button type="button" className="pile-shift" onClick={() => shift(-1)} aria-label={`Previous ${row.title}`}>
            ←
          </button>
          <button type="button" className="pile-shift" onClick={() => shift(1)} aria-label={`Next ${row.title}`}>
            →
          </button>
        </div>
      </div>
      <div ref={trackRef} className="pile-track">
        {row.items.map((item) => (
          <PileCard key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function PileReader({ item, onClose }: { item: PileItem; onClose: () => void }) {
  const openedAt = useRef(Date.now());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    pileEvent(item.id, 'open');
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const seconds = Math.round((Date.now() - openedAt.current) / 1000);
      if (seconds > 1) pileEvent(item.id, 'dwell', seconds);
    };
  }, [item.id, onClose]);

  return (
    <div className="fixed inset-0 z-40 bg-ink/75 backdrop-fade" onClick={onClose}>
      <aside className="pile-reader slide-in-right" onClick={(event) => event.stopPropagation()} aria-label={item.title}>
        <button type="button" className="pile-reader-close" onClick={onClose} aria-label="Close reader">
          close
        </button>
        <div className="pile-reader-image" style={itemBackdrop(item)} aria-hidden="true" />
        <div className="pile-reader-body">
          <div className="pile-reader-kicker">
            {SOURCE_LABEL[item.source] ?? item.source} · {item.kind}
            {item.theme_label ? ` · ${item.theme_label}` : ''}
          </div>
          <h1 className="mt-3 text-2xl font-semibold leading-tight text-mist sm:text-3xl">{item.title}</h1>
          {item.why && <p className="mt-3 text-sm text-jade">Included because {item.why}.</p>}
          {item.abstract && <p className="mt-6 whitespace-pre-wrap text-base leading-7 text-mist-dim">{item.abstract}</p>}
          <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-5 hairline">
            <a
              className="rounded-lg bg-mist px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-white"
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => pileEvent(item.id, 'complete')}
            >
              Open original ↗
            </a>
            <button
              type="button"
              className="glass glass-hover rounded-lg px-4 py-2 text-sm text-mist-dim hover:text-mist"
              onClick={() => {
                pileEvent(item.id, 'save');
                setSaved(true);
              }}
            >
              {saved ? 'Saved' : 'Save for later'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function StreampilePanel() {
  const [feed, setFeed] = useState<PileFeed | null>(null);
  const [theme, setTheme] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<PileItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const suffix = theme == null ? '' : `?theme=${theme}`;
    fetch(`/api/streampile/feed${suffix}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`feed returned ${response.status}`);
        return (await response.json()) as PileFeed;
      })
      .then(setFeed)
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [theme, requestVersion]);

  const visible = useMemo(() => {
    if (!feed || !query.trim()) return feed;
    const needle = query.trim().toLowerCase();
    const matches = (item: PileItem) =>
      item.title.toLowerCase().includes(needle) ||
      (item.abstract ?? '').toLowerCase().includes(needle) ||
      (item.theme_label ?? '').toLowerCase().includes(needle) ||
      (item.author ?? '').toLowerCase().includes(needle);
    return {
      ...feed,
      rows: feed.rows
        .map((row) => ({ ...row, items: row.items.filter(matches) }))
        .filter((row) => row.items.length > 0),
    };
  }, [feed, query]);

  return (
    <div className="min-w-0 pb-10">
      <header className="mb-5 flex flex-col gap-4 border-b pb-5 hairline sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">reading queue</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-mist">Streampile</h1>
          <p className="mt-1 text-sm text-mist-dim">Taste-ranked, then diversified so one rabbit hole does not take over.</p>
        </div>
        <label className="glass field-glow flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 sm:w-80">
          <span className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">find</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-mist outline-none placeholder:text-mist-faint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, theme, author"
            type="search"
          />
        </label>
      </header>

      {feed?.themes && feed.themes.length > 0 && (
        <div className="pile-themes" aria-label="Themes">
          <button type="button" className={`pile-theme ${theme == null ? 'active' : ''}`} onClick={() => setTheme(null)}>
            All
          </button>
          {feed.themes.map((item) => (
            <button
              type="button"
              key={item.cid}
              className={`pile-theme ${theme === item.cid ? 'active' : ''}`}
              onClick={() => setTheme(theme === item.cid ? null : item.cid)}
            >
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="glass my-8 flex items-center justify-between gap-4 p-4 text-sm text-mist-dim">
          <span>Streampile is not responding. {error}</span>
          <button type="button" className="text-slate-glow hover:text-mist" onClick={() => setRequestVersion((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {!feed && !error && <div className="py-24 text-center text-sm text-mist-faint">Loading the current pile…</div>}

      {visible?.hero && !query.trim() && (
        <section className="pile-hero rise" style={{ '--rise-i': 0 } as CSSProperties}>
          <div className="pile-hero-image" style={itemBackdrop(visible.hero)} aria-hidden="true" />
          <div className="pile-hero-wash" aria-hidden="true" />
          <div className="pile-hero-copy">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-dim">first in the pile</div>
            <h2 className="mt-3 max-w-3xl text-3xl font-semibold leading-[1.05] tracking-tight text-mist sm:text-5xl">
              {visible.hero.title}
            </h2>
            {visible.hero.abstract && <p className="mt-4 max-w-2xl text-sm leading-6 text-mist-dim sm:text-base">{visible.hero.abstract.slice(0, 260)}</p>}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button type="button" className="rounded-lg bg-mist px-4 py-2 text-sm font-semibold text-ink" onClick={() => setActive(visible.hero)}>
                Read summary
              </button>
              {visible.hero.why && <span className="text-sm text-jade">{visible.hero.why}</span>}
            </div>
          </div>
        </section>
      )}

      {visible?.rows.map((row) => (
        <PileRowTrack key={row.title} row={row} onOpen={setActive} />
      ))}

      {visible && visible.rows.length === 0 && !error && (
        <div className="py-20 text-center text-sm text-mist-faint">
          {query.trim() ? `Nothing in this pile matches “${query.trim()}”.` : 'This pile is empty.'}
        </div>
      )}

      {active && <PileReader item={active} onClose={() => setActive(null)} />}
    </div>
  );
}
