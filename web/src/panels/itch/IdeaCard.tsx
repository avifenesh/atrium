import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown';
import { CopyText } from '../../components/ui';
import { askIdea, deleteIdea, howtoIdea, putRating, roadmapIdea, scopeIdea, type RunDetail, type RunIdea } from './api';
import { Sheet } from './Sheet';
import { COLLIDE_PREFIX_RE, RATING_LABEL, displayTitle } from './util';

// ---------- idea cards (the feed, rise 2) ----------

// lifecycle segments — 'none' clears. upstream PRESERVES absent fields (verified
// against the live ledger), so a clear must send outcome AND outcome_note as null
const OUTCOMES = ['none', 'dropped', 'finished', 'maintaining'] as const;

// side oneshots — synchronous upstream (120-600s); the proxy holds the line open,
// so the await below IS the busy state
const ACTIONS = [
  { kind: 'ask', label: 'ask', hint: 'ask a question about this idea' },
  { kind: 'roadmap', label: 'roadmap', hint: 'draft a build roadmap' },
  { kind: 'howto', label: 'how-to', hint: 'write a how-to spec' },
  // rating-5 cards only — filtered at the cluster
  // (UI affordance only: upstream /scope doesn't enforce the rating)
  { kind: 'scope', label: 'scope', hint: 'scope iteration 1 — mvp cut, first milestone' },
] as const;
type ActionKind = (typeof ACTIONS)[number]['kind'];

function RatingButtons({
  rating,
  pending,
  locked,
  onRate,
}: {
  rating: number | null;
  pending: number | null; // the button whose PUT is in flight — all five disable
  locked: boolean; // outcome/note PUTs share the single-flight guard
  onRate: (n: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={RATING_LABEL[n]}
          disabled={pending !== null || locked}
          onClick={() => onRate(n)}
          className={`press h-6 w-6 cursor-pointer rounded text-center font-mono text-[11px] tabular-nums disabled:cursor-default ${
            rating === n ? 'glass-raised text-mist' : 'text-mist-faint hover:text-mist'
          }`}
        >
          {pending === n ? '…' : n}
        </button>
      ))}
    </span>
  );
}

export function IdeaCard({
  idea,
  stem,
  onRated,
  onRunUpdated,
  flash = false,
}: {
  idea: RunIdea;
  stem: string;
  onRated: () => void;
  /** add/delete return the FULL renumbered run payload — the feed swaps its detail state */
  onRunUpdated: (detail: RunDetail) => void;
  /** a search/decisions jump just landed here — one decaying mist glow, then gone */
  flash?: boolean;
}) {
  const [rating, setRating] = useState(idea.rating);
  const [note, setNote] = useState(idea.note ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showBridge, setShowBridge] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<number | null>(null); // in-flight rating PUT
  const [collapsible, setCollapsible] = useState(false);
  // outcome lifecycle (rated cards only)
  const [outcome, setOutcome] = useState(idea.outcome);
  const [outcomeNote, setOutcomeNote] = useState(idea.outcome_note ?? '');
  const [outcomePending, setOutcomePending] = useState<string | null>(null); // in-flight outcome PUT
  const [notePending, setNotePending] = useState<'note' | 'onote' | null>(null); // in-flight note/outcome_note PUT
  const [savedFlash, setSavedFlash] = useState<'note' | 'onote' | null>(null); // transient jade 'saved'
  const [editingONote, setEditingONote] = useState(false);
  const [draftONote, setDraftONote] = useState('');
  // side oneshots
  const [action, setAction] = useState<ActionKind | null>(null); // in-flight oneshot
  const [asking, setAsking] = useState(false); // ask input revealed
  const [question, setQuestion] = useState('');
  const [sheet, setSheet] = useState<{ kicker: string; title: string; markdown: string } | null>(null);
  // a oneshot that resolved while the user was typing — stashed, never auto-opened
  const [ready, setReady] = useState<{ kicker: string; title: string; markdown: string } | null>(null);
  const [quiet, setQuiet] = useState<string | null>(null); // transient 409 note — a state, not an error
  // delete (two-click arm)
  const [delArmed, setDelArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRef = useRef(false); // escape pressed — blur must not save
  const cancelONoteRef = useRef(false);
  const aliveRef = useRef(true); // oneshots outlive cards — guard setState after unmount
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (failTimer.current) clearTimeout(failTimer.current);
      if (quietTimer.current) clearTimeout(quietTimer.current);
      if (armTimer.current) clearTimeout(armTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  // collapsible = the RENDERED body overflows the 144px (max-h-36) clamp — raw-text
  // heuristics mismatch rendered height. Compare against the fixed cap so the check
  // holds whether or not the clamp is currently applied; ResizeObserver re-checks
  // because layout is fluid. +1 forgives sub-pixel rounding.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setCollapsible(el.scrollHeight > 144 + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [idea.body]);

  const flashFail = () => {
    setFailed(true);
    if (failTimer.current) clearTimeout(failTimer.current);
    failTimer.current = setTimeout(() => setFailed(false), 2500);
  };

  const flashQuiet = (msg: string) => {
    setQuiet(msg);
    if (quietTimer.current) clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(() => setQuiet(null), 4000);
  };

  const flashSaved = (which: 'note' | 'onote') => {
    setSavedFlash(which);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedFlash(null), 1500);
  };

  // rating + outcome + note PUTs share one single-flight guard — concurrent
  // title-keyed upserts have no defined order (an in-flight note save landing
  // after a clear would re-create the orphaned outcome_note)
  const putBusy = pending !== null || outcomePending !== null || notePending !== null;

  // title-keyed upsert — MUST send the ORIGINAL exact title (with any '[collide] ' prefix)
  const rate = async (n: number) => {
    if (putBusy) return;
    const prev = rating;
    const next = rating === n ? null : n; // clicking the current rating clears it
    setPending(n);
    setRating(next); // optimistic
    try {
      const { body } = await putRating({ title: idea.title, rating: next });
      if (!body?.ok) throw new Error(body?.error ?? 'rating failed');
      onRated();
    } catch {
      setRating(prev);
      flashFail();
    } finally {
      setPending(null);
    }
  };

  const saveNote = async () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditing(false);
      return;
    }
    const next = draft.trim();
    if (next === note) {
      setEditing(false);
      return;
    }
    // single-flight with rating/outcome PUTs — keep the editor (and draft) open
    // instead of dropping the text; blurring again retries once the flight lands
    if (putBusy) return;
    setEditing(false);
    const prev = note;
    setNote(next); // optimistic
    setNotePending('note');
    try {
      const { body } = await putRating({
        title: idea.title,
        note: next === '' ? null : next,
      });
      if (!body?.ok) throw new Error(body?.error ?? 'note failed');
      flashSaved('note');
      onRated();
    } catch {
      setNote(prev);
      flashFail();
    } finally {
      setNotePending(null);
    }
  };

  // lifecycle segment click — optimistic. upstream preserves absent fields, so a
  // clear must send outcome: null AND outcome_note: null in ONE PUT — a stale note
  // left in the ledger resurrects later and keeps steering the research engine
  const setOutcomeValue = async (v: (typeof OUTCOMES)[number]) => {
    if (putBusy) return;
    const next = v === 'none' ? null : v;
    if (next === outcome) return;
    const prevOutcome = outcome;
    const prevONote = outcomeNote;
    setOutcomePending(v);
    setOutcome(next); // optimistic
    if (next === null) setOutcomeNote('');
    try {
      const { body } = await putRating(
        next === null
          ? { title: idea.title, outcome: null, outcome_note: null }
          : { title: idea.title, outcome: next },
      );
      if (!body?.ok) throw new Error(body?.error ?? 'outcome failed');
      onRated();
    } catch {
      // restore BOTH — the clear was a single PUT over both fields
      setOutcome(prevOutcome);
      setOutcomeNote(prevONote);
      flashFail();
    } finally {
      setOutcomePending(null);
    }
  };

  const saveOutcomeNote = async () => {
    if (cancelONoteRef.current) {
      cancelONoteRef.current = false;
      setEditingONote(false);
      return;
    }
    const next = draftONote.trim();
    if (next === outcomeNote) {
      setEditingONote(false);
      return;
    }
    // single-flight with rating/outcome PUTs — an outcome_note landing after a
    // 'none' clear would re-create the orphan; keep the editor open, blur retries
    if (putBusy) return;
    setEditingONote(false);
    const prev = outcomeNote;
    setOutcomeNote(next); // optimistic
    setNotePending('onote');
    try {
      const { body } = await putRating({
        title: idea.title,
        outcome_note: next === '' ? null : next,
      });
      if (!body?.ok) throw new Error(body?.error ?? 'outcome note failed');
      flashSaved('onote');
      onRated();
    } catch {
      setOutcomeNote(prev);
      flashFail();
    } finally {
      setNotePending(null);
    }
  };

  // ---- side oneshots (ask / roadmap / how-to) ----
  // the call runs minutes; on unmount the work continues server-side — we only
  // stop touching state. 409 = the single ai slot is taken: quiet, never coral.
  const runAction = async (kind: ActionKind, call: () => Promise<{ status: number; text: string | null }>) => {
    if (action !== null) return;
    setAction(kind);
    try {
      const { status, text } = await call();
      if (!aliveRef.current) return;
      if (status === 409) {
        flashQuiet('another ai action is running');
        return;
      }
      if (typeof text !== 'string') throw new Error('oneshot failed');
      const label = ACTIONS.find((a) => a.kind === kind)?.label ?? kind;
      const result = { kicker: label, title: displayTitle(idea.title), markdown: text };
      // a oneshot resolving minutes later must not auto-open over active typing —
      // the Sheet's mount focus would blur a half-typed note straight into a PUT.
      // stash it; a quiet jade affordance in the title row opens it on click
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        setReady(result);
      } else {
        setSheet(result);
      }
    } catch {
      if (aliveRef.current) flashFail(); // network/timeout — coral
    } finally {
      if (aliveRef.current) setAction(null);
    }
  };

  const runAsk = (q: string) =>
    runAction('ask', async () => {
      const { status, body } = await askIdea({ title: idea.title, body: idea.body, question: q });
      return { status, text: body?.answer ?? null };
    });

  const runRoadmap = () =>
    runAction('roadmap', async () => {
      const { status, body } = await roadmapIdea({ title: idea.title, body: idea.body });
      return { status, text: body?.roadmap ?? null };
    });

  const runHowto = () =>
    runAction('howto', async () => {
      // how-to is run-addressed (stem + idx) and answers in `spec`, not a markdown key
      const { status, body } = await howtoIdea(stem, { idx: idea.idx });
      return { status, text: body?.spec ?? null };
    });

  const runScope = () =>
    runAction('scope', async () => {
      // run-addressed + title-keyed; upstream also persists the scope file and
      // names it in `saved` — appended so the sheet says where it landed
      const { status, body } = await scopeIdea(stem, idea.title);
      if (typeof body?.scope !== 'string') return { status, text: null };
      return { status, text: body.saved ? `${body.scope}\n\nsaved to ${body.saved}` : body.scope };
    });

  const onAction = (kind: ActionKind) => {
    if (action !== null) return;
    if (kind === 'ask') {
      setAsking((v) => !v); // reveal the question input — enter submits, esc cancels
      return;
    }
    if (kind === 'roadmap') void runRoadmap();
    else if (kind === 'howto') void runHowto();
    // explicit, not a bare else — scope persists a file upstream, so an
    // unmatched future kind must not fall through into it
    else if (kind === 'scope') void runScope();
  };

  // ---- delete idea (two-click arm) ----
  const delIdea = async () => {
    if (deleting) return;
    if (!delArmed) {
      setDelArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setDelArmed(false), 4000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setDelArmed(false);
    setDeleting(true);
    try {
      // upstream removes the idea from the run file and renumbers the rest; the
      // ratings ledger is deliberately untouched — the decision survives the card
      const { status, body } = await deleteIdea(stem, idea.idx);
      if (!aliveRef.current) return;
      if (status >= 400 || !body || !Array.isArray(body.ideas)) throw new Error(body?.error ?? 'delete failed');
      onRunUpdated(body); // full renumbered run payload
      if (aliveRef.current) setDeleting(false);
    } catch {
      if (aliveRef.current) {
        setDeleting(false);
        flashFail();
      }
    }
  };

  const meta = idea.metadata ?? {};
  const collide = meta.collide || COLLIDE_PREFIX_RE.test(idea.title);

  return (
    // card-level group — zero-information rows (finding: rhythm) hover-reveal
    // against the whole card, not a sliver of row
    <section data-idx={idea.idx} className={`group glass p-4${flash ? ' jump-glow' : ''}`}>
      {/* wrapping title row — the controls travel as ONE ml-auto unit and drop to
          a second line when tight; min-w-48 keeps the title readable, never a
          one-word-per-line sliver at half-screen widths */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <div className="min-w-48 flex-1">
          <CopyText text={idea.title}>
            <span className="text-sm font-semibold text-mist">{displayTitle(idea.title)}</span>
          </CopyText>
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {ready && (
            <button
              type="button"
              title={`${ready.kicker} finished while you were typing — open it`}
              onClick={() => {
                setSheet(ready);
                setReady(null);
              }}
              className="unfold shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-jade/10 px-2 py-0.5 font-mono text-[11px] text-jade transition-colors hover:bg-jade/20"
            >
              {ready.kicker} ready — view
            </button>
          )}
          {/* hover cluster — side oneshots + delete; the in-flight one stays visible,
              label kept beside the ellipsis so minutes-long flights read as something */}
          <span className="flex shrink-0 items-center gap-1">
            {/* scope only earns a slot at rating 5; an in-flight one stays visible
                even if the rating changes mid-flight */}
            {ACTIONS.filter((a) => a.kind !== 'scope' || rating === 5 || action === 'scope').map((a) => (
              <button
                key={a.kind}
                type="button"
                title={a.hint}
                disabled={action !== null}
                onClick={() => onAction(a.kind)}
                className={`${
                  action === a.kind || (a.kind === 'ask' && asking) ? '' : 'hover-cluster'
                } shrink-0 cursor-pointer whitespace-nowrap rounded px-1 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist disabled:cursor-default disabled:opacity-40`}
              >
                {action === a.kind ? `${a.label}…` : a.label}
              </button>
            ))}
            <button
              type="button"
              title="remove this idea from the run — the ratings ledger keeps its decision"
              disabled={deleting}
              onClick={() => void delIdea()}
              className={`${
                delArmed || deleting ? '' : 'hover-cluster'
              } shrink-0 cursor-pointer whitespace-nowrap rounded px-1 py-0.5 font-mono text-[11px] transition-colors ${
                delArmed ? 'text-coral hover:text-coral' : 'text-mist-faint hover:text-mist'
              }`}
            >
              {deleting ? '…' : delArmed ? 'sure?' : 'delete'}
            </button>
          </span>
          {collide && (
            <span
              className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim"
              title="from a collide pass — two distant interests fused"
            >
              collide
            </span>
          )}
          {meta.sampled_domain && (
            <span
              className="max-w-36 shrink-0 truncate rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim"
              title={`sampled domain: ${meta.sampled_domain}`}
            >
              {meta.sampled_domain}
            </span>
          )}
          {failed && <span className="fade-in shrink-0 font-mono text-[11px] text-coral">failed</span>}
          <RatingButtons rating={rating} pending={pending} locked={putBusy && pending === null} onRate={(n) => void rate(n)} />
        </span>
      </div>

      {asking && (
        <input
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAsking(false);
              setQuestion('');
            } else if (e.key === 'Enter') {
              const q = question.trim();
              if (q === '') return;
              setAsking(false);
              setQuestion('');
              void runAsk(q);
            }
          }}
          placeholder="question…"
          className="glass field-glow unfold mt-2 w-full px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
        />
      )}
      {quiet && <div className="fade-in mt-1 font-mono text-[11px] text-mist-faint">{quiet}</div>}

      {/* collapsed to ~6 lines — cards are long, the feed must scan; the bottom fade
          says "there's more" so the cut reads intentional, not broken */}
      <div
        ref={bodyRef}
        className={`mt-1 ${
          collapsible && !expanded
            ? 'max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]'
            : ''
        }`}
      >
        <Markdown content={idea.body} className="text-sm [&_p]:text-mist-dim [&_li]:text-mist-dim" />
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}

      {/* notes become avoid-flavor steers in the engine — only on rated cards */}
      {rating !== null && (
        <div className="mt-2">
          {editing ? (
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void saveNote()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  cancelRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              placeholder="note — becomes a steer for future runs"
              className="glass field-glow unfold w-full resize-y px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
            />
          ) : (
            <div className="flex min-w-0 items-baseline gap-2">
              {note ? (
                <span className="min-w-0 truncate text-xs text-mist-dim" title={note}>
                  {note}
                </span>
              ) : (
                // zero information — hover-reveal against the card-level group
                // (visibility, not display: space stays reserved, no reflow)
                <span className="hover-cluster text-xs text-mist-faint">no note</span>
              )}
              {notePending === 'note' ? (
                <span className="shrink-0 font-mono text-[11px] text-mist-faint">…</span>
              ) : (
                savedFlash === 'note' && <span className="fade-in shrink-0 font-mono text-[11px] text-jade">saved</span>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(note);
                  cancelRef.current = false;
                  setEditing(true);
                }}
                className="hover-cluster shrink-0 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
              >
                edit
              </button>
            </div>
          )}

          {/* lifecycle — where a pursued idea actually ended up. with no outcome the
              row is zero information: hover-reveal it against the card-level group
              (space reserved, no reflow); once an outcome exists — or a PUT is in
              flight — it is permanently visible */}
          <div
            className={`${
              outcome === null && outcomePending === null ? 'hover-cluster ' : ''
            }mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1`}
          >
            <span className="flex shrink-0 items-center gap-1">
              {OUTCOMES.map((o) => {
                const selected = (outcome ?? 'none') === o;
                return (
                  <button
                    key={o}
                    type="button"
                    disabled={putBusy}
                    onClick={() => void setOutcomeValue(o)}
                    className={`press cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] disabled:cursor-default ${
                      // only a REAL outcome earns the raised treatment — 'none' is an
                      // empty state, not a result, and must not glow on every rated card
                      selected && o !== 'none' ? 'glass-raised text-mist' : 'text-mist-faint hover:text-mist'
                    }`}
                  >
                    {outcomePending === o ? '…' : o}
                  </button>
                );
              })}
            </span>
            {outcome !== null && !editingONote && (
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                {outcomeNote ? (
                  <span className="min-w-0 truncate text-xs text-mist-dim" title={outcomeNote}>
                    {outcomeNote}
                  </span>
                ) : (
                  // zero information — same card-level hover-reveal as 'no note'
                  <span className="hover-cluster text-xs text-mist-faint">no outcome note</span>
                )}
                {notePending === 'onote' ? (
                  <span className="shrink-0 font-mono text-[11px] text-mist-faint">…</span>
                ) : (
                  savedFlash === 'onote' && (
                    <span className="fade-in shrink-0 font-mono text-[11px] text-jade">saved</span>
                  )
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDraftONote(outcomeNote);
                    cancelONoteRef.current = false;
                    setEditingONote(true);
                  }}
                  className="hover-cluster shrink-0 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
                >
                  edit
                </button>
              </div>
            )}
          </div>
          {outcome !== null && editingONote && (
            <textarea
              autoFocus
              rows={2}
              value={draftONote}
              onChange={(e) => setDraftONote(e.target.value)}
              onBlur={() => void saveOutcomeNote()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  cancelONoteRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              placeholder="outcome note — what happened"
              className="glass field-glow unfold mt-1 w-full resize-y px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
            />
          )}
        </div>
      )}

      {meta.bridge && (
        <div className="mt-2">
          <button
            type="button"
            title="how this idea connects back to your interests"
            onClick={() => setShowBridge((v) => !v)}
            className="cursor-pointer font-mono text-xs text-mist-faint transition-colors hover:text-mist"
          >
            {showBridge ? '▾ bridge' : '▸ bridge'}
          </button>
          {showBridge && (
            <div className="unfold mt-1 font-mono text-xs leading-relaxed text-mist-faint">
              <div className="whitespace-pre-wrap break-words">{meta.bridge}</div>
              {(meta.source_urls?.length ?? 0) > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {meta.source_urls?.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-slate-glow hover:underline"
                    >
                      {u.replace(/^https?:\/\//, '')}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {sheet && (
        <Sheet kicker={sheet.kicker} title={sheet.title} onClose={() => setSheet(null)}>
          <Markdown content={sheet.markdown} className="text-sm" />
        </Sheet>
      )}
    </section>
  );
}
