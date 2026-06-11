import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { clearAllNotifications, refreshSection } from '../api';
import { useScrollLock } from '../hooks';
import { runLabel } from '../panels/itch/util';
import type { SectionName, Snapshot } from '../../../shared/types';

/** Case-insensitive subsequence score — higher wins, -1 = no match.
 *  Bonuses: label prefix, word starts (after space / # / slash / dash / dot),
 *  consecutive runs; tiny shortness tiebreak so tighter labels rank first. */
function score(query: string, label: string): number {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  let qi = 0;
  let s = 0;
  let prev = -2;
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] !== q[qi]) continue;
    s += 1;
    if (i === 0) s += 3;
    else if (' /#-_.'.includes(l[i - 1])) s += 2;
    if (prev === i - 1) s += 1;
    prev = i;
    qi += 1;
  }
  return qi === q.length ? s - l.length / 1000 : -1;
}

interface Cmd {
  key: string;
  label: string;
  tag: string;
  /** github html url — cmd/ctrl+enter opens this in a new tab instead */
  url?: string;
  /** shown when the query is empty (views + quiet drawer only) */
  pinned?: boolean;
  /** two-step: first enter arms ("sure?"), second fires — mirrors panel buttons */
  arm?: boolean;
  run: () => void;
}

const MAX_RESULTS = 12;

// every collector behind POST /api/refresh/:section — mirrors SectionName
const SECTIONS: SectionName[] = [
  'github',
  'agents',
  'system',
  'schedule',
  'comms',
  'subs',
  'notes',
  'surreal',
  'revuto',
  'itch',
  'cloud',
  'repos',
];
// snapshot lists can grow unbounded — keep the index bounded, scorer surfaces the rest
const MAX_NOTES = 50;
const MAX_RUNS = 40;
const MAX_SCHED = 60;
const MAX_REVIEWERS = 40;

export default function CommandPalette({
  snapshot,
  views,
  onClose,
  onNavigate,
  onOpenQuiet,
  onOpenItem,
  onOpenNote,
  onOpenRun,
}: {
  snapshot: Snapshot;
  views: readonly { id: string; label: string }[];
  onClose: () => void;
  onNavigate: (view: string) => void;
  onOpenQuiet: () => void;
  onOpenItem: (repo: string, number: number) => void;
  onOpenNote: (path: string) => void;
  onOpenRun: (stem: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // esc is handled centrally in App (topmost overlay first) — no window listener here
  useScrollLock();

  // opened mid-edit (notes editor, comment composer) the palette steals focus;
  // hand it back on close so the caret survives a cmd+k round-trip
  useEffect(() => {
    const prev = document.activeElement;
    return () => {
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  const all = useMemo<Cmd[]>(() => {
    const cmds: Cmd[] = views.map((v) => ({
      key: `view:${v.id}`,
      label: `go to ${v.label}`,
      tag: 'view',
      pinned: true,
      run: () => {
        onNavigate(v.id);
        onClose();
      },
    }));
    cmds.push({
      key: 'quiet-drawer',
      label: 'open quiet drawer',
      tag: 'quiet',
      pinned: true,
      run: () => {
        onOpenQuiet();
        onClose();
      },
    });
    // same item can sit in several lanes — first lane wins
    const seen = new Set<string>();
    const github = (
      items: { id: string; repo: string; number: number; title: string; url: string }[],
      tag: string,
    ) => {
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        cmds.push({
          key: `gh:${it.id}`,
          label: `${it.repo}#${it.number} ${it.title}`,
          tag,
          url: it.url,
          run: () => {
            onOpenItem(it.repo, it.number);
            onClose();
          },
        });
      }
    };
    github(snapshot.github.actNow, 'task');
    github(snapshot.github.orgQueue, 'waiting');
    github(snapshot.github.myPRs, 'pr');
    github(snapshot.github.mentions, 'mention');
    for (const a of snapshot.agents.agents) {
      cmds.push({
        key: `agent:${a.id}`,
        label: a.name,
        tag: 'agent',
        run: () => {
          onNavigate('agents');
          onClose();
        },
      });
    }
    // snapshot index — none pinned, so they only surface against a query and the
    // shortness tiebreak keeps exact view matches above them
    for (const n of snapshot.notes.recent.slice(0, MAX_NOTES)) {
      cmds.push({
        key: `note:${n.path}`,
        // path in the scored label so "find by folder/filename" works; truncate handles length
        label: `${n.title} — ${n.path}`,
        tag: 'note',
        run: () => {
          onOpenNote(n.path);
          onClose();
        },
      });
    }
    for (const s of snapshot.schedule.entries.slice(0, MAX_SCHED)) {
      cmds.push({
        key: `sched:${s.id}`,
        label: s.name,
        tag: 'schedule',
        run: () => {
          onNavigate('schedule');
          onClose();
        },
      });
    }
    // optional-chain: a stale server snapshot may lack revuto/itch during rollout
    for (const r of (snapshot.revuto?.reviewers ?? []).slice(0, MAX_REVIEWERS)) {
      cmds.push({
        key: `reviewer:${r.repo}`,
        label: r.repo,
        tag: 'reviewer',
        run: () => {
          onNavigate('revuto');
          onClose();
        },
      });
    }
    for (const r of (snapshot.itch?.runs ?? []).slice(0, MAX_RUNS)) {
      cmds.push({
        key: `run:${r.stem}`,
        label: runLabel(r),
        tag: 'run',
        run: () => {
          // entity row opens its entity: land on itch with THIS run selected
          onOpenRun(r.stem);
          onClose();
        },
      });
    }
    // verbs — safe only; destructive actions stay in their panels behind their arms.
    // research start stays with the strip (single-flight 409 + log tail) — jump there
    if (snapshot.itch?.up) {
      cmds.push({
        key: 'verb:itch-research',
        label: snapshot.itch.research.running ? 'itch research — running, view' : 'start itch research',
        tag: 'action',
        run: () => {
          onNavigate('itch');
          onClose();
        },
      });
    }
    cmds.push({
      key: 'verb:clear-notifications',
      label: 'clear all notifications',
      tag: 'action',
      arm: true, // same POST as the tasks panel's armed "clear all"
      run: () => {
        void clearAllNotifications()
          .then(() => refreshSection('github'))
          .catch(() => {});
        onClose();
      },
    });
    for (const s of SECTIONS) {
      cmds.push({
        key: `refresh:${s}`,
        label: `refresh ${s}`,
        tag: 'action',
        run: () => {
          void refreshSection(s).catch(() => {});
          onClose();
        },
      });
    }
    return cmds;
  }, [snapshot, views, onClose, onNavigate, onOpenQuiet, onOpenItem, onOpenNote, onOpenRun]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return all.filter((c) => c.pinned).slice(0, MAX_RESULTS);
    return all
      .map((c) => ({ c, s: score(q, c.label) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((r) => r.c);
  }, [all, query]);

  // selection follows the visible list even when it shrinks under the cursor
  const selIdx = results.length === 0 ? -1 : Math.min(sel, results.length - 1);

  // armed verb (Cmd.key) — disarms after 4s or when the query moves on
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  useEffect(() => {
    setSel(0);
    setArmed(null);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selIdx]);

  const run = (c: Cmd, newTab: boolean) => {
    if (newTab && c.url) {
      window.open(c.url, '_blank', 'noopener,noreferrer');
      onClose();
      return;
    }
    if (c.arm && armed !== c.key) {
      setArmed(c.key);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), 4000);
      return;
    }
    c.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((selIdx + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((selIdx - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[selIdx];
      if (c) run(c, e.metaKey || e.ctrlKey);
    }
  };

  return (
    <div className="fixed inset-0 z-50 px-4" role="dialog" aria-modal="true" aria-label="command palette">
      <div className="backdrop-fade absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="glass-raised rise relative mx-auto mt-[14vh] flex w-full max-w-xl flex-col overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="jump to…"
          className="w-full bg-transparent px-4 py-3 font-sans text-sm text-mist placeholder:text-mist-faint focus:outline-none"
        />
        {results.length === 0 ? (
          <div className="border-t px-4 py-3 text-sm text-mist-faint hairline">nothing matches</div>
        ) : (
          <ul ref={listRef} className="max-h-[50vh] overflow-y-auto border-t p-1.5 hairline">
            {results.map((c, i) => (
              <li key={c.key}>
                <button
                  type="button"
                  data-sel={i === selIdx}
                  onClick={(e) => run(c, e.metaKey || e.ctrlKey)}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    i === selIdx ? 'bg-white/[0.06] text-mist' : 'text-mist-dim'
                  }`}
                >
                  <span className={`min-w-0 flex-1 truncate text-sm ${armed === c.key ? 'text-coral' : ''}`}>
                    {armed === c.key ? `${c.label} — sure?` : c.label}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-mist-faint">{c.tag}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="flex items-center gap-3 border-t px-4 py-2 font-mono text-[10px] text-mist-faint hairline">
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span className="ml-auto">
            <span className="kbd">esc</span> close
          </span>
        </footer>
      </div>
    </div>
  );
}
