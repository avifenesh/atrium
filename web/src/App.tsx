import { useEffect, useMemo, useRef, useState } from 'react';
import { isMuted, useSnapshot } from './api';
import { recordSystemSample, useNow } from './hooks';
import NowView from './panels/NowView';
import TasksPanel from './panels/TasksPanel';
import AgentsPanel from './panels/AgentsPanel';
import SystemPanel from './panels/SystemPanel';
import CommsPanel from './panels/CommsPanel';
import SubsPanel from './panels/SubsPanel';
import SchedulePanel from './panels/SchedulePanel';
import NotesPanel from './panels/NotesPanel';
import MutesDrawer from './components/MutesDrawer';
import FlagStrip from './components/FlagStrip';
import ItemDetail from './components/ItemDetail';
import CommandPalette from './components/CommandPalette';

// labels lowercase sans — DESIGN v2 typography
const VIEWS = [
  { id: 'now', label: 'now' },
  { id: 'tasks', label: 'tasks' },
  { id: 'agents', label: 'agents' },
  { id: 'system', label: 'system' },
  { id: 'comms', label: 'comms' },
  { id: 'subs', label: 'subs' },
  { id: 'schedule', label: 'schedule' },
  { id: 'notes', label: 'notes' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

function isViewId(v: string): v is ViewId {
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
  const [view, setView] = useState<ViewId>('now');
  const [mutesOpen, setMutesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // github item slide-over: read + comment without leaving atrium
  const [item, setItem] = useState<{ repo: string; number: number } | null>(null);
  // ItemDetail registers its esc step here (composer-absorb logic lives with the composer)
  const itemEscape = useRef<(() => void) | null>(null);

  // rail badge counts — tasks dedupes act-now/org-queue overlap by item id
  const badges = useMemo(() => {
    if (!snapshot)
      return { tasks: 0, tasksCls: 'text-mist-faint', comms: 0, agents: 0, system: 0, systemCls: 'text-mist-faint' };
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
    return {
      tasks: taskIds.size,
      tasksCls: tasksAttention ? 'text-amber' : 'text-mist-faint',
      comms: snapshot.comms.email.unreadCount,
      agents: snapshot.agents.agents.filter((a) => a.status === 'active' || a.status === 'running').length,
      system: flags.length,
      systemCls,
    };
  }, [snapshot]);

  // the tasks badge follows you to other tabs
  useEffect(() => {
    document.title = badges.tasks > 0 ? `atrium · ${badges.tasks}` : 'atrium';
  }, [badges.tasks]);

  // system history accumulates here because App never unmounts
  useEffect(() => {
    if (snapshot) recordSystemSample(snapshot);
  }, [snapshot]);

  // keyboard layer — esc is centralized here so one press closes ONE overlay,
  // topmost first (per-overlay window listeners all fire on a single esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      } else if (/^[1-8]$/.test(e.key)) {
        setView(VIEWS[Number(e.key) - 1].id);
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
  const navigate = (v: string) => {
    if (isViewId(v)) setView(v);
  };
  const openQuiet = () => setMutesOpen(true);
  const openItem = (repo: string, number: number) => setItem({ repo, number });

  const badgeFor = (id: ViewId): { n: number; cls: string } | null => {
    const map: Partial<Record<ViewId, { n: number; cls: string }>> = {
      tasks: { n: badges.tasks, cls: badges.tasksCls },
      comms: { n: badges.comms, cls: 'text-mist-faint' },
      agents: { n: badges.agents, cls: 'text-jade' },
      system: { n: badges.system, cls: badges.systemCls },
    };
    const b = map[id];
    return b && b.n > 0 ? b : null;
  };

  const navButton = (v: (typeof VIEWS)[number]) => {
    const b = badgeFor(v.id);
    return (
      <button
        key={v.id}
        onClick={() => setView(v.id)}
        className={`cursor-pointer whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
          view === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
        }`}
      >
        {v.label}
        {b && <span className={`ml-1 font-mono text-[10px] tabular-nums ${b.cls}`}>{b.n}</span>}
      </button>
    );
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-[1920px] px-5 py-4 lg:px-8 lg:py-5">
      {/* top bar — below lg the rail folds into a horizontal nav */}
      <header className="mb-4 flex items-center gap-3 lg:hidden">
        <Wordmark connected={connected} className="shrink-0 text-2xl" />
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{VIEWS.map(navButton)}</nav>
        <QuietButton count={activeMutes.length} onClick={openQuiet} className="shrink-0 px-3 py-1.5" />
      </header>

      <div className="flex gap-6 lg:gap-7">
        {/* left rail — lg+ */}
        <nav className="sticky top-5 hidden h-[calc(100vh-2.5rem)] w-36 shrink-0 flex-col self-start lg:flex">
          <div className="mb-8 px-3">
            <Wordmark connected={connected} className="text-[1.7rem]" />
          </div>
          <ul className="space-y-0.5">
            {VIEWS.map((v) => {
              const b = badgeFor(v.id);
              return (
                <li key={v.id}>
                  <button
                    onClick={() => setView(v.id)}
                    className={`flex w-full cursor-pointer items-baseline justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                      view === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
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
          {view === 'now' && (
            <NowView snapshot={snapshot} onNavigate={navigate} onOpenQuiet={openQuiet} onOpenItem={openItem} />
          )}
          {view === 'tasks' && <TasksPanel snapshot={snapshot} onOpenQuiet={openQuiet} onOpenItem={openItem} />}
          {view === 'agents' && <AgentsPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'system' && <SystemPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'comms' && <CommsPanel snapshot={snapshot} />}
          {view === 'subs' && <SubsPanel snapshot={snapshot} />}
          {view === 'schedule' && <SchedulePanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'notes' && <NotesPanel snapshot={snapshot} overlayOpen={paletteOpen || !!item || mutesOpen} />}
        </main>
      </div>

      {mutesOpen && <MutesDrawer snapshot={snapshot} onClose={() => setMutesOpen(false)} />}
      {item && (
        <ItemDetail repo={item.repo} number={item.number} onClose={() => setItem(null)} escapeRef={itemEscape} />
      )}
      {paletteOpen && (
        <CommandPalette
          snapshot={snapshot}
          views={VIEWS}
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
          onOpenQuiet={openQuiet}
          onOpenItem={openItem}
        />
      )}
    </div>
  );
}
