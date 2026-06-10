import { useState } from 'react';
import { useSnapshot } from './api';
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
        className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${connected ? 'bg-jade' : 'bg-coral'}`}
        title={connected ? 'live' : 'reconnecting'}
      />
    </span>
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
      {count > 0 && <span className="ml-2 font-mono text-xs tabular-nums text-amber">{count}</span>}
    </button>
  );
}

export default function App() {
  const { snapshot, connected } = useSnapshot();
  const [view, setView] = useState<ViewId>('now');
  const [mutesOpen, setMutesOpen] = useState(false);

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

  const navButton = (v: (typeof VIEWS)[number]) => (
    <button
      key={v.id}
      onClick={() => setView(v.id)}
      className={`cursor-pointer whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
        view === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
      }`}
    >
      {v.label}
    </button>
  );

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
            {VIEWS.map((v) => (
              <li key={v.id}>
                <button
                  onClick={() => setView(v.id)}
                  className={`w-full cursor-pointer rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                    view === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
                  }`}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-auto">
            <QuietButton count={activeMutes.length} onClick={openQuiet} className="w-full px-3 py-2" />
          </div>
        </nav>

        {/* main */}
        <main className="min-w-0 flex-1">
          <FlagStrip snapshot={snapshot} onNavigate={navigate} onOpenQuiet={openQuiet} />
          {view === 'now' && <NowView snapshot={snapshot} onNavigate={navigate} onOpenQuiet={openQuiet} />}
          {view === 'tasks' && <TasksPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'agents' && <AgentsPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'system' && <SystemPanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'comms' && <CommsPanel snapshot={snapshot} />}
          {view === 'subs' && <SubsPanel snapshot={snapshot} />}
          {view === 'schedule' && <SchedulePanel snapshot={snapshot} onOpenQuiet={openQuiet} />}
          {view === 'notes' && <NotesPanel snapshot={snapshot} />}
        </main>
      </div>

      {mutesOpen && <MutesDrawer snapshot={snapshot} onClose={() => setMutesOpen(false)} />}
    </div>
  );
}
