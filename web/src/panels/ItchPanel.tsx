import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshSection } from '../api';
import { Dot, EmptyState, Panel, RelTime } from '../components/ui';
import { ComparePanel } from './itch/Compare';
import { DecisionsPanel } from './itch/Decisions';
import { Feed, type ScrollTarget } from './itch/Feed';
import { ResearchStrip } from './itch/ResearchStrip';
import { ScopesPanel } from './itch/Scopes';
import { SearchStrip } from './itch/SearchStrip';
import { ToolsPanel } from './itch/Tools';
import type { ItchState, Snapshot } from '../../../shared/types';

// itch view shell — section ordering plus the state that crosses sections
// (selected run, jump target, decisions/filters/scopes versions). the pieces
// live in ./itch/*: api.ts (proxy fetchers + upstream shapes), util.ts (display
// helpers), and one file per rise: research 0, search 1, feed 2, compare 3,
// decisions 4, scopes 5, tools 6 (rare-use, last).

// ---------- panel root ----------

function ItchBody({ it }: { it: ItchState }) {
  const runs = it.runs;
  const [selectedStem, setSelectedStem] = useState<string | null>(runs[0]?.stem ?? null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const [decisionsVersion, setDecisionsVersion] = useState(0);
  const [filtersVersion, setFiltersVersion] = useState(0);
  const [scopesVersion, setScopesVersion] = useState(0);
  // a save the snapshot hasn't confirmed yet — see the runs effect below
  const pendingSelect = useRef<string | null>(null);
  // a delete the snapshot hasn't dropped yet — the adopt effect must not resurrect it
  const deletedStem = useRef<string | null>(null);

  // adopt the newest run once the first snapshot with runs arrives — skipping a
  // just-deleted stem: refreshSection is a silent no-op while the collector is
  // mid-poll, so after deleting the LAST run a stale snapshot can still list it
  useEffect(() => {
    if (selectedStem !== null || runs.length === 0) return;
    const next = runs.find((r) => r.stem !== deletedStem.current);
    if (next) setSelectedStem(next.stem);
  }, [runs, selectedStem]);

  // once a snapshot arrives without the deleted stem, drop the guard
  useEffect(() => {
    if (deletedStem.current && !runs.some((r) => r.stem === deletedStem.current)) {
      deletedStem.current = null;
    }
  }, [runs]);

  // apply a pending post-save selection once the saved run shows up in a snapshot.
  // refreshSection can be a silent no-op while the collector is mid-poll, so the
  // snapshot may lag the save by a poll cycle or more — hence ref + effect rather
  // than selecting in onSaved. a baseline twin (baselineFor set) must NOT steal
  // the selection: the user is watching the collide run's ComparePanel, and its
  // refetch picks the new baseline up in place.
  useEffect(() => {
    const stem = pendingSelect.current;
    if (!stem) return;
    const run = runs.find((r) => r.stem === stem);
    if (!run) return; // snapshot hasn't caught up yet — keep waiting
    pendingSelect.current = null;
    if (run.baselineFor === null) setSelectedStem(stem);
  }, [runs]);

  const jumpTo = useCallback((stem: string, idx?: number, title?: string) => {
    setSelectedStem(stem);
    setScrollTarget({ stem, idx, title });
  }, []);

  // decisions re-fetch after any rating/note change
  const onRated = useCallback(() => setDecisionsVersion((v) => v + 1), []);

  // scopes re-list after a scope oneshot persists a file
  const onScoped = useCallback(() => setScopesVersion((v) => v + 1), []);

  // tools applied/cleared a feed filter — the feed refetches GET /filters on bump
  const onFiltersChanged = useCallback(() => setFiltersVersion((v) => v + 1), []);

  // research saved a run: stash the stem for the runs effect above and ask atrium
  // to re-poll the itch section (the effect decides whether to select it)
  const onSaved = useCallback((stem: string) => {
    pendingSelect.current = stem;
    setScrollTarget(null);
    void refreshSection('itch');
  }, []);

  // the feed consumed a jump (scrolled or noticed) — a kept target would re-fire
  // on the next detail swap and yank the viewport to a renumbered card
  const onScrollTargetConsumed = useCallback(() => setScrollTarget(null), []);

  const onRunDeleted = useCallback((stem: string) => {
    deletedStem.current = stem;
  }, []);

  return (
    <div>
      {!it.up && (
        // upstream unreachable — surface staleness, keep last-known data below
        <div className="fade-in mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="shrink-0 text-coral">itch server unreachable</span>
          {it.error && (
            <span className="min-w-0 truncate text-mist-faint" title={it.error}>
              {it.error}
            </span>
          )}
          <span className="shrink-0 text-mist-faint">— atrium restarts it</span>
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-[11px] text-mist-faint">
            last data <RelTime iso={it.updatedAt} />
          </span>
        </div>
      )}
      {it.up && it.error && (
        <div className="fade-in mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="min-w-0 truncate text-coral" title={it.error}>
            {it.error}
          </span>
        </div>
      )}

      <ResearchStrip research={it.research} onSaved={onSaved} />
      <SearchStrip onJump={(stem, idx) => jumpTo(stem, idx)} />
      <Feed
        runs={runs}
        selectedStem={selectedStem}
        onSelect={(s) => {
          setSelectedStem(s);
          setScrollTarget(null);
        }}
        scrollTarget={scrollTarget}
        onScrollTargetConsumed={onScrollTargetConsumed}
        onRated={onRated}
        onScoped={onScoped}
        onRunDeleted={onRunDeleted}
        filtersVersion={filtersVersion}
        onFiltersChanged={onFiltersChanged}
      />
      <ComparePanel
        stem={selectedStem}
        isCollide={runs.find((r) => r.stem === selectedStem)?.isCollide ?? false}
        riseIndex={3}
      />
      <DecisionsPanel
        runs={runs}
        version={decisionsVersion}
        onJump={(stem, title) => jumpTo(stem, undefined, title)}
      />
      <ScopesPanel riseIndex={5} version={scopesVersion} />
      <ToolsPanel riseIndex={6} filtersVersion={filtersVersion} onFiltersChanged={onFiltersChanged} />
    </div>
  );
}

export default function ItchPanel({ snapshot }: { snapshot: Snapshot }) {
  const it = snapshot.itch;
  // rollout skew: a web bundle ahead of a not-yet-restarted server has no itch section
  if (!it) {
    return (
      <Panel title="itch">
        <EmptyState>server snapshot has no itch section — restart the atrium daemon</EmptyState>
      </Panel>
    );
  }
  // never polled yet (failure paths always set error)
  if (!it.up && it.updatedAt === null && it.error === null) {
    return (
      <Panel title="itch">
        <EmptyState>waiting for first snapshot</EmptyState>
      </Panel>
    );
  }
  return <ItchBody it={it} />;
}
