import { useEffect, useMemo, useRef, useState } from 'react';
import { isMuted, useSnapshot } from './api';
import { recordSystemSample, useNow } from './hooks';
import NowView from './panels/NowView';
import TasksPanel from './panels/TasksPanel';
import AgentsPanel from './panels/AgentsPanel';
import RevutoPanel from './panels/RevutoPanel';
import SystemPanel from './panels/SystemPanel';
import CommsPanel from './panels/CommsPanel';
import SubsPanel from './panels/SubsPanel';
import SchedulePanel from './panels/SchedulePanel';
import NotesPanel from './panels/NotesPanel';
import ItchPanel from './panels/ItchPanel';
import StreampilePanel from './panels/StreampilePanel';
import WikiPanel from './panels/WikiPanel';
import ExtraPanel, { extraKeys } from './panels/ExtraPanel';
import MutesDrawer from './components/MutesDrawer';
import FlagStrip from './components/FlagStrip';
import ItemDetail from './components/ItemDetail';
import CommandPalette from './components/CommandPalette';
import { isSheetOpen } from './panels/itch/Sheet';

// labels lowercase sans — DESIGN v2 typography.
// `collector` names the backing collector; a view is hidden when that collector is
// disabled in config (absent from snapshot.collectors). Views without one (now, comms,
// subs) are always shown — they don't map to a single toggleable collector.
const VIEWS = [
  { id: 'now', label: 'now' },
  { id: 'tasks', label: 'tasks', collector: 'github' },
  { id: 'agents', label: 'agents', collector: 'agents' },
  { id: 'revuto', label: 'revuto', collector: 'revuto' },
  { id: 'system', label: 'system', collector: 'system' },
  { id: 'comms', label: 'comms' },
  { id: 'subs', label: 'subs' },
  { id: 'schedule', label: 'schedule', collector: 'schedule' },
  { id: 'notes', label: 'notes', collector: 'notes' },
  { id: 'itch', label: 'itch', collector: 'itch' },
  { id: 'streampile', label: 'streampile' },
  { id: 'knowledge', label: 'knowledge' },
] as const;

// extra (plugin) sections register as dynamic views; ids are not known at compile time
type ViewId = string;

function isCoreViewId(v: string): boolean {
  return VIEWS.some((x) => x.id === v);
}

/** Wordmark — the ONLY serif besides hero numerals (DESIGN v2). */
function Wordmark({ connected, className = '' }: { connected: boolean; className?: string }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <span className="font-display italic leading-none">atrium</span>
      <span
        className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${connected ? 'breathe bg-jade' : 'bg-coral'}`}
        title={connected ? 'live' : 'reconnecting'}
      />
    </span>
  );
}

/** Rail clock — mono, never serif (the serif budget is spent on wordmark + hero). */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function RailClock() {
  const now = useNow(15000);
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return (
    <div className="mb-3 px-3">
      <div className="font-mono text-xl tabular-nums text-mist-dim">
        {hh}:{mm}
      </div>
      <div className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">
        {DAYS[d.getDay()]} · {MONTHS[d.getMonth()]} {d.getDate()}
      </div>
    </div>
  );
}

function QuietButton({
  count,
  onClick,
  className = '',
}: {
  count: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title="open the quiet drawer (archive)"
      className={`glass cursor-pointer rounded-lg text-left text-sm text-mist-dim transition-colors hover:text-mist ${className}`}
    >
      quiet
      {count > 0 && <span className="ml-2 font-mono text-xs tabular-nums text-mist-faint">{count}</span>}
    </button>
  );
}

export default function App() {
  const { snapshot, connected } = useSnapshot();
  // initial view from the url hash — desktop entries deep-link e.g. #revuto or a plugin key.
  // plugin keys aren't known until the snapshot lands, so accept any non-empty hash here
  // and let the render fall back to 'now' if it never resolves to a real view.
  const [view, setView] = useState<ViewId>(() => location.hash.slice(1) || 'now');
  // in-page hash changes (a deep-link landing on an already-open app) must also
  // switch the view — the lazy init above only runs at boot
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      setView(h || 'now');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [mutesOpen, setMutesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** mobile overflow sheet for secondary views (bottom nav holds primaries) */
  const [moreOpen, setMoreOpen] = useState(false);
  // github item slide-over: read + comment without leaving atrium
  const [item, setItem] = useState<{ repo: string; number: number } | null>(null);
  // palette → notes reader: pending open consumed by NotesPanel (itch scrollTarget idiom —
  // open-note state is panel-local, so the jump rides a one-shot signal)
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  // palette → itch run: same one-shot idiom (selected-run state lives in ItchBody)
  const [runTarget, setRunTarget] = useState<string | null>(null);
  // ItemDetail registers its esc step here (composer-absorb logic lives with the composer)
  const itemEscape = useRef<(() => void) | null>(null);

  // rail badge counts — tasks dedupes act-now/org-queue overlap by item id
  const badges = useMemo(() => {
    if (!snapshot)
      return {
        tasks: 0,
        tasksCls: 'text-mist-faint',
        comms: 0,
        agents: 0,
        revuto: 0,
        system: 0,
        systemCls: 'text-mist-faint',
        itch: 0,
      };
    const taskIds = new Set<string>();
    for (const it of [...snapshot.github.actNow, ...snapshot.github.orgQueue]) {
      if (!isMuted(snapshot, 'github-item', it.id)) taskIds.add(it.id);
    }
    // amber is scoped to act-now + org review (mirrors the NowView hero); a queue of
    // triage-only leftovers keeps the count but drops the attention color
    const tasksAttention = [
      ...snapshot.github.actNow,
      ...snapshot.github.orgQueue.filter((it) => it.lane === 'review'),
    ].some((it) => !isMuted(snapshot, 'github-item', it.id));
    // system badge tone follows the highest unmuted flag severity (mirrors FlagStrip:
    // crit coral, warn amber, info stays quiet) — coral is reserved for errors
    const flags = snapshot.flags.filter((f) => !isMuted(snapshot, 'flag', f.id));
    const systemCls = flags.some((f) => f.severity === 'crit')
      ? 'text-coral'
      : flags.some((f) => f.severity === 'warn')
        ? 'text-amber'
        : 'text-mist-faint';
    // optional-chain both: a stale server snapshot may lack revuto during rollout
    const revutoFails = snapshot.revuto?.up ? (snapshot.revuto.counts?.recentFailures ?? 0) : 0;
    return {
      tasks: taskIds.size,
      tasksCls: tasksAttention ? 'text-amber' : 'text-mist-faint',
      comms: snapshot.comms.email.unreadCount,
      agents: snapshot.agents.agents.filter((a) => a.status === 'active' || a.status === 'running').length,
      revuto: revutoFails,
      system: flags.length,
      systemCls,
      // optional-chain: a stale server snapshot may lack itch during rollout
      itch: snapshot.itch?.up && snapshot.itch.research.running ? 1 : 0,
    };
  }, [snapshot]);

  // visible core views: hide any whose backing collector is disabled in config
  // (absent from snapshot.collectors). Views without a `collector` always show; a
  // pre-rollout snapshot lacking the list falls back to showing everything.
  const coreViews = useMemo(() => {
    const registered = snapshot?.collectors;
    return VIEWS.filter(
      (v) => !('collector' in v) || !Array.isArray(registered) || registered.includes(v.collector),
    );
  }, [snapshot?.collectors]);
  // the keydown handler reads this via a ref so it never re-registers on view changes
  const coreViewsRef = useRef(coreViews);
  coreViewsRef.current = coreViews;

  // the tasks badge follows you to other tabs
  useEffect(() => {
    document.title = badges.tasks > 0 ? `atrium · ${badges.tasks}` : 'atrium';
  }, [badges.tasks]);

  // system history accumulates here because App never unmounts
  useEffect(() => {
    if (snapshot) recordSystemSample(snapshot);
  }, [snapshot]);

  // keep the hash in sync — replaceState so view switches never pollute back-button history
  useEffect(() => {
    history.replaceState(null, '', view === 'now' ? location.pathname : '#' + view);
  }, [view]);

  // keyboard layer — esc is centralized here so one press closes ONE overlay,
  // topmost first (per-overlay window listeners all fire on a single esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // itch sheets are panel-local overlays the shell does not track — while one
      // is open it owns the keyboard (its capture-phase listener handles esc), so
      // stand down before the esc cascade AND before plain-key handling: a stray
      // digit/q/slash must not switch views and unmount a 10-minute oneshot result
      if (isSheetOpen()) return;
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (item) (itemEscape.current ?? (() => setItem(null)))();
        else if (mutesOpen) setMutesOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (paletteOpen || item || mutesOpen) return; // overlays own plain keys while open
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'q') {
        setMutesOpen((o) => !o);
      } else if (/^[0-9]$/.test(e.key)) {
        // 1-9 keep their muscle memory; 0 maps to the tenth view. Digit keys index the
        // VISIBLE core views (read via ref) so a disabled collector's slot doesn't
        // mis-fire. Plugin views are reached via palette / hash / click.
        const views = coreViewsRef.current;
        const idx = e.key === '0' ? 9 : Number(e.key) - 1;
        if (idx < views.length) setView(views[idx].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, item, mutesOpen]);

  if (!snapshot) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse font-display text-3xl italic text-mist-dim">atrium</div>
      </div>
    );
  }

  const activeMutes = snapshot.mutes.filter((m) => !m.until || new Date(m.until).getTime() > Date.now());
  // coreViews (visible, collector-filtered) is memoized above; plugin (extra) sections
  // become extra nav entries after the core views
  const extraViews = extraKeys(snapshot).map((k) => ({ id: k, label: snapshot.extra[k]?.title ?? k }));
  const allViews = [...coreViews, ...extraViews];
  const isKnownView = (v: string) => allViews.some((x) => x.id === v);
  // resolve an unknown/stale hash (e.g. a plugin disabled since the link was made) to 'now'
  const activeView = isKnownView(view) ? view : 'now';
  const navigate = (v: string) => {
    if (isKnownView(v)) setView(v);
    setMoreOpen(false);
  };
  const openQuiet = () => {
    setMoreOpen(false);
    setMutesOpen(true);
  };
  const openItem = (repo: string, number: number) => setItem({ repo, number });

  // bottom-nav primaries on phone; everything else lives under "more"
  const MOBILE_PRIMARY = new Set(['now', 'tasks', 'agents', 'itch']);
  const mobilePrimaryViews = allViews.filter((v) => MOBILE_PRIMARY.has(v.id));
  const mobileMoreViews = allViews.filter((v) => !MOBILE_PRIMARY.has(v.id));
  const primaryActive = MOBILE_PRIMARY.has(activeView);

  const badgeFor = (id: ViewId): { n: number; cls: string } | null => {
    const map: Partial<Record<ViewId, { n: number; cls: string }>> = {
      tasks: { n: badges.tasks, cls: badges.tasksCls },
      comms: { n: badges.comms, cls: 'text-mist-faint' },
      agents: { n: badges.agents, cls: 'text-jade' },
      // failures are errors — coral, never amber
      revuto: { n: badges.revuto, cls: 'text-coral' },
      system: { n: badges.system, cls: badges.systemCls },
      // research running is work-in-progress — jade like agents, not amber
      itch: { n: badges.itch, cls: 'text-jade' },
    };
    const b = map[id];
    return b && b.n > 0 ? b : null;
  };

  return (
    <div className="mx-auto min-h-dvh w-full max-w-[1920px] px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] pt-[max(0.75rem,env(safe-area-inset-top,0px))] sm:px-5 sm:py-4 lg:px-8 lg:pb-5 lg:pt-5">
      {/* mobile top — wordmark + quiet; views live in bottom nav */}
      <header className="mb-3 flex items-center justify-between gap-3 lg:hidden">
        <Wordmark connected={connected} className="shrink-0 text-2xl" />
        <QuietButton count={activeMutes.length} onClick={openQuiet} className="shrink-0 px-3 py-2" />
      </header>

      <div className="flex gap-6 lg:gap-7">
        {/* left rail — lg+ */}
        <nav className="sticky top-5 hidden h-[calc(100vh-2.5rem)] w-36 shrink-0 flex-col self-start lg:flex">
          <div className="mb-8 px-3">
            <Wordmark connected={connected} className="text-[1.7rem]" />
          </div>
          <ul className="space-y-0.5">
            {allViews.map((v) => {
              const b = badgeFor(v.id);
              return (
                <li key={v.id}>
                  <button
                    onClick={() => navigate(v.id)}
                    className={`flex w-full cursor-pointer items-baseline justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                      activeView === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
                    }`}
                  >
                    {v.label}
                    {b && <span className={`font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto">
            <RailClock />
            <QuietButton count={activeMutes.length} onClick={openQuiet} className="w-full px-3 py-2" />
          </div>
        </nav>

        {/* main */}
        <main className="min-w-0 flex-1">
          <FlagStrip snapshot={snapshot} onNavigate={navigate} onOpenQuiet={openQuiet} />
          {activeView === 'now' && (
            <NowView snapshot={snapshot} onNavigate={navigate} onOpenQuiet={openQuiet} onOpenItem={openItem} />
          )}
          {activeView === 'tasks' && <TasksPanel snapshot={snapshot} onOpenQuiet={openQuiet} onOpenItem={openItem} />}
          {activeView === 'agents' && <AgentsPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {activeView === 'revuto' && <RevutoPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {activeView === 'system' && <SystemPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {activeView === 'comms' && <CommsPanel snapshot={snapshot} />}
          {activeView === 'subs' && <SubsPanel snapshot={snapshot} />}
          {activeView === 'schedule' && <SchedulePanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {activeView === 'notes' && (
            <NotesPanel
              snapshot={snapshot}
              overlayOpen={paletteOpen || !!item || mutesOpen || moreOpen}
              openTarget={noteTarget}
              onOpenTargetConsumed={() => setNoteTarget(null)}
            />
          )}
          {activeView === 'itch' && (
            <ItchPanel
              snapshot={snapshot}
              openTarget={runTarget}
              onOpenTargetConsumed={() => setRunTarget(null)}
            />
          )}
          {activeView === 'streampile' && <StreampilePanel />}
          {activeView === 'knowledge' && <WikiPanel />}
          {/* plugin (extra-lane) sections render in the generic panel */}
          {snapshot.extra?.[activeView] && (
            <ExtraPanel section={snapshot.extra[activeView]} sectionKey={activeView} />
          )}
        </main>
      </div>

      {/* mobile bottom nav — primary views; overflow under "more" */}
      <nav
        className="mobile-bottom-nav glass-raised fixed inset-x-0 bottom-0 z-30 border-t border-white/10 lg:hidden"
        aria-label="primary"
      >
        <div className="mx-auto flex max-w-[1920px] items-stretch justify-around gap-0.5 px-1 pt-1">
          {mobilePrimaryViews.map((v) => {
            const b = badgeFor(v.id);
            const on = activeView === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => navigate(v.id)}
                className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] transition-colors ${
                  on ? 'text-mist' : 'text-mist-faint'
                }`}
              >
                <span className="font-mono text-[13px] leading-none">{v.label}</span>
                {b && <span className={`font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] transition-colors ${
              moreOpen || !primaryActive ? 'text-mist' : 'text-mist-faint'
            }`}
          >
            <span className="font-mono text-[13px] leading-none">more</span>
            {!primaryActive && (
              <span className="max-w-full truncate font-mono text-[10px] text-mist-dim">{activeView}</span>
            )}
          </button>
        </div>
      </nav>

      {moreOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/60 backdrop-fade lg:hidden" onClick={() => setMoreOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="more views"
            className="glass-raised fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-y-auto rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">more</h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="cursor-pointer rounded px-2 py-1 font-mono text-[11px] text-mist-faint"
              >
                close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {mobileMoreViews.map((v) => {
                const b = badgeFor(v.id);
                const on = activeView === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => navigate(v.id)}
                    className={`flex min-h-12 items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${
                      on ? 'glass-raised text-mist' : 'glass text-mist-dim'
                    }`}
                  >
                    <span>{v.label}</span>
                    {b && <span className={`font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={openQuiet}
                className="glass col-span-2 flex min-h-12 items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-mist-dim"
              >
                <span>quiet / archive</span>
                {activeMutes.length > 0 && (
                  <span className="font-mono text-xs tabular-nums text-mist-faint">{activeMutes.length}</span>
                )}
              </button>
            </div>
          </div>
        </>
      )}

      {mutesOpen && <MutesDrawer snapshot={snapshot} onClose={() => setMutesOpen(false)} />}
      {item && (
        // keyed remount on item switch — clears extra/draft/reviewing/sending so an
        // in-flight comment/review POST for item A can never land in item B's thread
        <ItemDetail
          key={`${item.repo}#${item.number}`}
          repo={item.repo}
          number={item.number}
          onClose={() => setItem(null)}
          escapeRef={itemEscape}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          snapshot={snapshot}
          views={allViews}
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
          onOpenQuiet={openQuiet}
          onOpenItem={openItem}
          onOpenNote={(path) => {
            setNoteTarget(path);
            setView('notes');
          }}
          onOpenRun={(stem) => {
            setRunTarget(stem);
            setView('itch');
          }}
        />
      )}
    </div>
  );
}
