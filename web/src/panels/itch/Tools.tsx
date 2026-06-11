import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown';
import { Panel, SectionLabel } from '../../components/ui';
import {
  agentFilter,
  clearFilters,
  contribute,
  getFilters,
  getResource,
  putResource,
  validateIdea,
  type AgentFilterPlan,
  type ResourceName,
} from './api';
import { Sheet } from './Sheet';

// ---------- side tools (rise 5, last — rare-use) ----------
// validate / contribute are synchronous upstream oneshots (120-600s): the button
// holds '…' for the whole call and 409 renders as a quiet state, never coral.

const BUSY_409 = 'another ai action is already running';

const FIELD =
  'glass field-glow w-full min-w-0 px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint';
const BTN =
  'shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-mist-dim press glass glass-hover hover:text-mist disabled:opacity-50';

type Note = { text: string; isError: boolean } | null;

function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <div
      className={`fade-in truncate font-mono text-xs ${note.isError ? 'text-coral' : 'text-mist-faint'}`}
      title={note.text}
    >
      {note.text}
    </div>
  );
}

// ---------- resources (interests.md / rules.md / work.txt) ----------

const RESOURCE_DEFS: { name: ResourceName; file: string }[] = [
  { name: 'interests', file: 'interests.md' },
  { name: 'rules', file: 'rules.md' },
  { name: 'work', file: 'work.txt' },
];

interface ResEditor {
  loaded: boolean;
  loading: boolean;
  text: string;
  saveState: 'idle' | 'busy' | 'ok' | 'fail';
  loadError: string | null;
}

const EMPTY_EDITOR: ResEditor = { loaded: false, loading: false, text: '', saveState: 'idle', loadError: null };

function planActive(p: AgentFilterPlan | null): boolean {
  if (!p) return false;
  return Boolean(
    (p.hide_titles?.length ?? 0) > 0 ||
      (p.hide_terms?.length ?? 0) > 0 ||
      (p.boost_terms?.length ?? 0) > 0 ||
      p.interpretation,
  );
}

function planCounts(p: AgentFilterPlan): string {
  const parts: string[] = [];
  if (p.hide_titles?.length) parts.push(`${p.hide_titles.length} titles hidden`);
  if (p.hide_terms?.length) parts.push(`${p.hide_terms.length} terms hidden`);
  if (p.boost_terms?.length) parts.push(`${p.boost_terms.length} boosted`);
  return parts.join(' · ');
}

export function ToolsPanel({
  riseIndex,
  filtersVersion,
  onFiltersChanged,
}: {
  riseIndex: number;
  /** bumped by the shell whenever filters change elsewhere (e.g. Feed's clear) — triggers a plan refetch */
  filtersVersion: number;
  onFiltersChanged: () => void;
}) {
  const [sheet, setSheet] = useState<{ kicker: string; title?: string; markdown: string } | null>(null);

  // ---- validate ----
  const [vTitle, setVTitle] = useState('');
  const [vDesc, setVDesc] = useState('');
  const [vBusy, setVBusy] = useState(false);
  const [vNote, setVNote] = useState<Note>(null);

  const runValidate = async () => {
    const title = vTitle.trim();
    if (!title || vBusy) return;
    setVBusy(true);
    setVNote(null);
    try {
      const desc = vDesc.trim();
      const { status, body } = await validateIdea({ title, ...(desc ? { description: desc } : {}) });
      if (status === 409) setVNote({ text: BUSY_409, isError: false });
      else if (body?.markdown) setSheet({ kicker: 'validate', title, markdown: body.markdown });
      else setVNote({ text: body?.error ?? `validate failed (${status})`, isError: true });
    } catch (e) {
      setVNote({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setVBusy(false);
    }
  };

  // ---- contribute ----
  const [cInterests, setCInterests] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cNote, setCNote] = useState<Note>(null);

  const runContribute = async () => {
    if (cBusy) return;
    setCBusy(true);
    setCNote(null);
    try {
      const interests = cInterests.trim();
      const { status, body } = await contribute(interests ? { interests } : {});
      if (status === 409) setCNote({ text: BUSY_409, isError: false });
      else if (body?.markdown) setSheet({ kicker: 'contribute', markdown: body.markdown });
      else setCNote({ text: body?.error ?? `contribute failed (${status})`, isError: true });
    } catch (e) {
      setCNote({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setCBusy(false);
    }
  };

  // ---- resources — explicit save only: these are prompt-steering files, an
  // accidental blur-save would silently steer the model ----
  const [editors, setEditors] = useState<Record<ResourceName, ResEditor>>({
    interests: EMPTY_EDITOR,
    rules: EMPTY_EDITOR,
    work: EMPTY_EDITOR,
  });
  const [openRes, setOpenRes] = useState<ResourceName | null>(null);
  const flashTimers = useRef<Partial<Record<ResourceName, ReturnType<typeof setTimeout>>>>({});
  const resRowRefs = useRef<Partial<Record<ResourceName, HTMLDivElement | null>>>({});

  useEffect(
    () => () => {
      for (const t of Object.values(flashTimers.current)) if (t) clearTimeout(t);
    },
    [],
  );

  const patchEditor = (name: ResourceName, p: Partial<ResEditor>) =>
    setEditors((e) => ({ ...e, [name]: { ...e[name], ...p } }));

  const loadResource = async (name: ResourceName) => {
    patchEditor(name, { loading: true, loadError: null });
    try {
      const { text } = await getResource(name);
      patchEditor(name, { loading: false, loaded: true, text });
    } catch (e) {
      patchEditor(name, { loading: false, loadError: e instanceof Error ? e.message : String(e) });
    }
  };

  const toggleResource = (name: ResourceName) => {
    if (openRes === name) {
      setOpenRes(null);
      return;
    }
    setOpenRes(name); // one expanded at a time
    // an open editor above collapsing yanks the click point — keep the new row in view
    requestAnimationFrame(() => resRowRefs.current[name]?.scrollIntoView({ block: 'nearest' }));
    const ed = editors[name];
    if (!ed.loaded && !ed.loading) void loadResource(name);
  };

  const saveResource = async (name: ResourceName) => {
    const ed = editors[name];
    if (ed.saveState === 'busy') return;
    patchEditor(name, { saveState: 'busy' });
    try {
      const { status, body } = await putResource(name, ed.text);
      if (status < 200 || status >= 300 || body?.error) throw new Error(body?.error ?? `save failed (${status})`);
      patchEditor(name, { saveState: 'ok' });
    } catch {
      patchEditor(name, { saveState: 'fail' });
    }
    const prev = flashTimers.current[name];
    if (prev) clearTimeout(prev);
    flashTimers.current[name] = setTimeout(() => patchEditor(name, { saveState: 'idle' }), 2500);
  };

  // ---- feed filter ----
  const [instruction, setInstruction] = useState('');
  const [fBusy, setFBusy] = useState(false);
  const [fNote, setFNote] = useState<Note>(null);
  const [plan, setPlan] = useState<AgentFilterPlan | null>(null);

  // refetch on filtersVersion so a clear from the Feed's chip reflects here too
  useEffect(() => {
    const ac = new AbortController();
    getFilters(ac.signal)
      .then((p) => setPlan(planActive(p) ? p : null))
      .catch(() => {}); // the feed shows its own filter chip — quiet here
    return () => ac.abort();
  }, [filtersVersion]);

  const applyFilter = async () => {
    const ins = instruction.trim();
    if (!ins || fBusy) return;
    setFBusy(true);
    setFNote(null);
    try {
      const { status, body } = await agentFilter({ instruction: ins });
      if (status === 409) setFNote({ text: BUSY_409, isError: false });
      else if (status >= 200 && status < 300 && body && !body.error) {
        setPlan(planActive(body) ? body : null);
        setInstruction('');
        onFiltersChanged();
      } else setFNote({ text: body?.error ?? `filter failed (${status})`, isError: true });
    } catch (e) {
      setFNote({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setFBusy(false);
    }
  };

  const clearPlan = async () => {
    setFNote(null);
    try {
      const { status, body } = await clearFilters();
      if (status < 200 || status >= 300) throw new Error(body?.error ?? `clear failed (${status})`);
      setPlan(null);
      onFiltersChanged();
    } catch (e) {
      setFNote({ text: e instanceof Error ? e.message : String(e), isError: true });
    }
  };

  return (
    <Panel title="tools" riseIndex={riseIndex} className="mt-4">
      {/* validate */}
      <SectionLabel>validate</SectionLabel>
      <div className="space-y-2 px-0.5">
        <div className="flex items-center gap-2">
          <input
            value={vTitle}
            onChange={(e) => setVTitle(e.target.value)}
            placeholder="idea title"
            className={FIELD}
          />
          <button type="button" disabled={vBusy || vTitle.trim() === ''} onClick={() => void runValidate()} className={BTN}>
            {vBusy ? '…' : 'validate'}
          </button>
        </div>
        <textarea
          rows={2}
          value={vDesc}
          onChange={(e) => setVDesc(e.target.value)}
          placeholder="optional description"
          className={`${FIELD} resize-y`}
        />
        {vBusy && <div className="fade-in font-mono text-xs text-mist-faint">validating — takes a few minutes…</div>}
        <NoteLine note={vNote} />
      </div>

      {/* contribute */}
      <SectionLabel>contribute</SectionLabel>
      <div className="space-y-2 px-0.5">
        <div className="flex items-center gap-2">
          <textarea
            rows={2}
            value={cInterests}
            onChange={(e) => setCInterests(e.target.value)}
            placeholder="defaults to interests.md"
            className={`${FIELD} resize-y`}
          />
          <button type="button" disabled={cBusy} onClick={() => void runContribute()} className={BTN}>
            {cBusy ? '…' : 'find contributions'}
          </button>
        </div>
        {cBusy && <div className="fade-in font-mono text-xs text-mist-faint">searching — takes a few minutes…</div>}
        <NoteLine note={cNote} />
      </div>

      {/* resources */}
      <SectionLabel>resources</SectionLabel>
      <div className="space-y-1 px-0.5">
        {RESOURCE_DEFS.map(({ name, file }) => {
          const ed = editors[name];
          const open = openRes === name;
          return (
            <div
              key={name}
              ref={(el) => {
                resRowRefs.current[name] = el;
              }}
            >
              <div className="flex min-w-0 items-center gap-2 py-1">
                <span className="text-sm text-mist">{name}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-mist-faint" title={file}>
                  {file}
                </span>
                <button
                  type="button"
                  onClick={() => toggleResource(name)}
                  className="ml-auto shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
                >
                  {open ? 'close' : 'edit'}
                </button>
              </div>
              {open && (
                <div className="unfold space-y-2 pb-2">
                  {ed.loading ? (
                    <div className="font-mono text-xs text-mist-faint">loading…</div>
                  ) : ed.loadError ? (
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span className="min-w-0 truncate text-coral" title={ed.loadError}>
                        {ed.loadError}
                      </span>
                      <button
                        type="button"
                        onClick={() => void loadResource(name)}
                        className="shrink-0 cursor-pointer text-mist-faint transition-colors hover:text-mist"
                      >
                        retry
                      </button>
                    </div>
                  ) : ed.loaded ? (
                    <>
                      <textarea
                        value={ed.text}
                        onChange={(e) => patchEditor(name, { text: e.target.value })}
                        className={`${FIELD} min-h-40 resize-y leading-relaxed`}
                      />
                      <button
                        type="button"
                        disabled={ed.saveState === 'busy'}
                        onClick={() => void saveResource(name)}
                        className={`shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] press glass glass-hover ${
                          ed.saveState === 'ok'
                            ? 'text-jade'
                            : ed.saveState === 'fail'
                              ? 'text-coral'
                              : 'text-mist-dim hover:text-mist'
                        }`}
                      >
                        {ed.saveState === 'busy'
                          ? '…'
                          : ed.saveState === 'ok'
                            ? 'saved'
                            : ed.saveState === 'fail'
                              ? 'failed'
                              : 'save'}
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* feed filter */}
      <SectionLabel>feed filter</SectionLabel>
      <div className="space-y-2 px-0.5">
        <div className="flex items-center gap-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void applyFilter();
            }}
            placeholder="e.g. hide kubernetes ideas, boost rust…"
            className={FIELD}
          />
          <button type="button" disabled={fBusy || instruction.trim() === ''} onClick={() => void applyFilter()} className={BTN}>
            {fBusy ? '…' : 'apply'}
          </button>
        </div>
        {fBusy && <div className="fade-in font-mono text-xs text-mist-faint">interpreting — takes a couple of minutes…</div>}
        <NoteLine note={fNote} />
        {plan && (
          <div className="fade-in flex min-w-0 items-center gap-2 rounded-lg border hairline bg-white/[0.03] px-2 py-1 font-mono text-xs">
            <span className="min-w-0 truncate text-mist-dim" title={plan.interpretation ?? 'filter active'}>
              {plan.interpretation ?? 'filter active'}
            </span>
            {planCounts(plan) !== '' && (
              <span className="shrink-0 tabular-nums text-mist-faint">{planCounts(plan)}</span>
            )}
            <button
              type="button"
              onClick={() => void clearPlan()}
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
            >
              clear
            </button>
          </div>
        )}
        <div className="text-xs text-mist-faint">
          also appends a durable rule to rules.md when the instruction implies one
        </div>
      </div>

      {sheet && (
        <Sheet kicker={sheet.kicker} title={sheet.title} onClose={() => setSheet(null)}>
          <Markdown content={sheet.markdown} className="text-sm" />
        </Sheet>
      )}
    </Panel>
  );
}
