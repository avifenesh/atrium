import { useEffect, useMemo, useRef, useState } from 'react';
import { isMuted, useSnapshot } from './api';
import { recordSystemSample, useNow, useScrollLock } from './hooks';
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
  { id: 'now', label: 'Now', group: 'Today', description: 'Attention, activity, and the next useful move.' },
  { id: 'tasks', label: 'Tasks', group: 'Work', description: 'Reviews, pull requests, mentions, and local changes.', collector: 'github' },
  { id: 'agents', label: 'Agents', group: 'Work', description: 'Active sessions, dispatches, and recent agent output.', collector: 'agents' },
  { id: 'revuto', label: 'Revuto', group: 'Work', description: 'Reviewer health, jobs, models, and recent outcomes.', collector: 'revuto' },
  { id: 'system', label: 'System', group: 'Machine', description: 'Capacity, listeners, processes, and service health.', collector: 'system' },
  { id: 'comms', label: 'Comms', group: 'Today', description: 'Unread mail and the calendar ahead.' },
  { id: 'subs', label: 'Subscriptions', group: 'Machine', description: 'Services, cloud resources, and recurring costs.' },
  { id: 'schedule', label: 'Schedule', group: 'Machine', description: 'Timers, cron jobs, and their latest runs.', collector: 'schedule' },
  { id: 'notes', label: 'Notes', group: 'Library', description: 'Find, read, and edit the notes on this machine.', collector: 'notes' },
  { id: 'itch', label: 'Itch', group: 'Explore', description: 'Research new ideas, compare them, and decide what is worth building.', collector: 'itch' },
  { id: 'streampile', label: 'Streampile', group: 'Explore', description: 'A taste-ranked reading queue with room for surprise.' },
  { id: 'knowledge', label: 'Knowledge', group: 'Library', description: 'Projects, techniques, sources, and the links between them.' },
] as const;

const NAV_GROUPS = ['Today', 'Work', 'Machine', 'Explore', 'Library', 'Plugins'] as const;

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
      title="Open the quiet archive"
      className={`quiet-button cursor-pointer text-left text-sm text-mist-dim transition-colors hover:text-mist ${className}`}
    >
      Quiet archive
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
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreSheetRef = useRef<HTMLDivElement>(null);
  useScrollLock(moreOpen);
  useEffect(() => {
    if (!moreOpen) return;
    moreSheetRef.current?.focus({ preventScroll: true });
    return () => moreButtonRef.current?.focus({ preventScroll: true });
  }, [moreOpen]);
  useEffect(() => {
    const desktop = matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMoreOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
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
        else if (moreOpen) setMoreOpen(false);
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
  }, [paletteOpen, item, mutesOpen, moreOpen]);

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
  const extraViews = extraKeys(snapshot).map((k) => ({
    id: k,
    label: snapshot.extra[k]?.title ?? k,
    group: 'Plugins' as const,
    description: 'A collector-provided workspace.',
  }));
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
  const activeViewMeta = allViews.find((candidate) => candidate.id === activeView) ?? allViews[0];
  const groupedViews = NAV_GROUPS.map((group) => ({
    group,
    views: allViews.filter((candidate) => candidate.group === group),
  })).filter((section) => section.views.length > 0);

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
    <div className="app-shell mx-auto min-h-dvh w-full max-w-[1920px] px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] pt-[max(0.75rem,env(safe-area-inset-top,0px))] sm:px-5 sm:py-4 lg:px-7 lg:pb-6 lg:pt-6">
      {/* mobile top — wordmark + quiet; views live in bottom nav */}
      <header className="mb-3 flex items-center justify-between gap-3 lg:hidden">
        <Wordmark connected={connected} className="shrink-0 text-2xl" />
        <QuietButton count={activeMutes.length} onClick={openQuiet} className="shrink-0 px-3 py-2" />
      </header>

      <div className="flex gap-6 lg:gap-10">
        {/* left rail — lg+ */}
        <nav className="side-rail sticky top-6 hidden h-[calc(100vh-3rem)] w-44 shrink-0 flex-col self-start lg:flex">
          <div className="mb-8 px-2">
            <Wordmark connected={connected} className="text-[1.85rem]" />
            <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.22em] text-mist-faint">local workspace</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {groupedViews.map((section) => (
              <div key={section.group} className="mb-5">
                <div className="mb-1.5 px-3 font-mono text-[9px] uppercase tracking-[0.18em] text-mist-faint">
                  {section.group}
                </div>
                <ul className="space-y-px">
                  {section.views.map((v) => {
                    const b = badgeFor(v.id);
                    return (
                      <li key={v.id}>
                        <button
                          onClick={() => navigate(v.id)}
                          className={`rail-nav-button flex w-full cursor-pointer items-baseline justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            activeView === v.id ? 'is-active text-mist' : 'text-mist-dim hover:text-mist'
                          }`}
                        >
                          {v.label}
                          {b && <span className={`font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-auto">
            <RailClock />
            <QuietButton count={activeMutes.length} onClick={openQuiet} className="w-full px-3 py-2" />
          </div>
        </nav>

        {/* main */}
        <main className="min-w-0 flex-1">
          <header className="workspace-header mb-5 flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
            <div className="min-w-0">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber">{activeViewMeta.group}</div>
              <h1 className="text-[clamp(1.55rem,2.2vw,2.15rem)] font-semibold leading-none tracking-[-0.035em] text-mist">
                {activeViewMeta.label}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist-dim">{activeViewMeta.description}</p>
            </div>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="command-trigger hidden cursor-pointer items-center gap-3 px-3 py-2 text-xs text-mist-dim transition-colors hover:text-mist sm:flex"
              title="Open command palette"
            >
              <span>Find or switch</span>
              <span className="kbd">⌘K</span>
            </button>
          </header>
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
                <span className="font-mono text-[12px] leading-none">{v.label}</span>
                {b && <span className={`font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
              </button>
            );
          })}
          <button
            ref={moreButtonRef}
            type="button"
            aria-controls="mobile-more-sheet"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] transition-colors ${
              moreOpen || !primaryActive ? 'text-mist' : 'text-mist-faint'
            }`}
          >
            <span className="font-mono text-[12px] leading-none">More</span>
            {!primaryActive && (
              <span className="max-w-full truncate font-mono text-[10px] text-mist-dim">{activeView}</span>
            )}
          </button>
        </div>
      </nav>

      {moreOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-ink/60 backdrop-fade lg:hidden"
            aria-hidden="true"
            onClick={() => setMoreOpen(false)}
          />
          <div
            id="mobile-more-sheet"
            ref={moreSheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="more views"
            className="glass-raised fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-y-auto overscroll-contain rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none lg:hidden"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-mist">More workspaces</h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="min-h-11 cursor-pointer rounded px-3 py-2 font-mono text-[11px] text-mist-faint"
              >
                Close
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
                <span>Quiet archive</span>
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
