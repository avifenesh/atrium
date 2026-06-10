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

// labels lowercase — DESIGN rule 8
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

export default function App() {
  const { snapshot, connected } = useSnapshot();
  const [view, setView] = useState<ViewId>('now');
  const [mutesOpen, setMutesOpen] = useState(false);

  if (!snapshot) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="font-display text-3xl italic text-mist-dim animate-pulse">atrium</div>
      </div>
    );
  }

  const activeMutes = snapshot.mutes.filter((m) => !m.until || new Date(m.until).getTime() > Date.now());

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px] gap-6 px-6 py-5">
      {/* left rail */}
      <nav className="sticky top-5 flex h-[calc(100vh-2.5rem)] w-44 shrink-0 flex-col">
        <div className="mb-8 px-3">
          <span className="font-display text-[1.7rem] italic leading-none">atrium</span>
          <span
            className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${connected ? 'bg-jade' : 'bg-coral'}`}
            title={connected ? 'live' : 'reconnecting'}
          />
        </div>
        <ul className="space-y-0.5">
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => setView(v.id)}
                className={`w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                  view === v.id ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
                }`}
              >
                {v.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto">
          <button
            onClick={() => setMutesOpen(true)}
            className="glass w-full rounded-lg px-3 py-2 text-left text-sm text-mist-dim hover:text-mist"
          >
            quiet
            {activeMutes.length > 0 && <span className="ml-2 font-mono text-xs text-amber">{activeMutes.length}</span>}
          </button>
        </div>
      </nav>

      {/* main */}
      <main className="min-w-0 flex-1">
        <FlagStrip snapshot={snapshot} />
        {view === 'now' && <NowView snapshot={snapshot} onNavigate={(v) => setView(v as ViewId)} />}
        {view === 'tasks' && <TasksPanel snapshot={snapshot} />}
        {view === 'agents' && <AgentsPanel snapshot={snapshot} />}
        {view === 'system' && <SystemPanel snapshot={snapshot} />}
        {view === 'comms' && <CommsPanel snapshot={snapshot} />}
        {view === 'subs' && <SubsPanel snapshot={snapshot} />}
        {view === 'schedule' && <SchedulePanel snapshot={snapshot} />}
        {view === 'notes' && <NotesPanel snapshot={snapshot} />}
      </main>

      {mutesOpen && <MutesDrawer snapshot={snapshot} onClose={() => setMutesOpen(false)} />}
    </div>
  );
}
