# atrium design language v2 — "glass observatory", professional pass

Dark glass control room. Calm by default; exactly one warm accent pulls the eye to what needs action.
v2 incorporates owner feedback: serif headers were noisy, layout too narrow, rows not interactive enough,
muted items must disappear (archive), the app must feel like a finished product.

## Tokens (defined in `web/src/styles.css` — never raw hex in components)

- Base: `ink` #0a0e14; panels `.glass` / `.glass-raised`
- Text: `mist` / `mist-dim` / `mist-faint`
- Accent: `amber` ONLY for act-now/attention/active-work. `jade` ok, `coral` error, `slate-glow` info/links.
- Type: `font-sans` Hanken Grotesk for EVERYTHING including headers; `font-mono` Spline Sans Mono for data
  (counts, times, ids, metrics, paths); `font-display` Instrument Serif italic is RESERVED for exactly two
  places: the wordmark and hero numerals on the now view. Nowhere else. (v1 used it on every header — noisy.)

## Typography hierarchy (replaces v1 serif headers)

- View title: `text-sm font-semibold tracking-wide lowercase text-mist` — quiet, not decorative.
- Panel title: `font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint`.
- Row primary text: `text-sm text-mist`; secondary `text-xs text-mist-dim`; data `font-mono text-xs`.
- Hero numerals (now view only): `font-display` italic, large.

## Layout — fluid, wide, responsive (v1 was squeezed)

- Shell: full-width fluid, `px-5 lg:px-8`, content cap `max-w-[1920px] mx-auto`. NO narrow max-widths.
- Nav: slim left rail (w-36) on lg+; on smaller widths it becomes a top bar — the app must be usable at 1280
  and gorgeous at 1920.
- Grids: CSS grid with explicit col-spans per breakpoint; every grid child gets `min-w-0`; lists truncate
  (`truncate` + title attr), never overflow. Panels stretch to fill — no orphan gutters.
- Test mentally at 1366, 1600, 1920. Two-column views collapse to one below lg.

## Interactivity — everything that names a thing is clickable

- Rows are buttons/links: `cursor-pointer hover:bg-white/[0.04] rounded-lg transition-colors` on the row,
  whole row clickable, not just the title.
  - github items → open url (new tab)  - sessions → copy dir / open transcript path (copy w/ feedback)
  - notes → copy absolute path        - schedule hermes rows → run-now action where supported
  - agents → expand card details      - ports/processes → copy, flags → relevant view
- Secondary actions live in a hover-revealed cluster, right-aligned: `quiet`, `→ eigen`, `clear`, ordered
  consistently. Always also reachable via focus (keyboard): `focus-within:visible`.
- Every async action gives feedback in place (busy → ok/fail), never silent, never an alert().

## Quiet = archive (v1 dimmed; owner wants gone)

- Muted/quieted items DISAPPEAR from all lists immediately.
- Each panel header shows a quiet counter chip (`n quieted`, font-mono, mist-faint) when its list has hidden
  items; clicking it opens the mutes drawer — that drawer IS the archive, where unquiet lives.
- FlagStrip: muted flags gone; counter chip appears at strip end.

## "send to eigen"

- Task rows (act now, my PRs, mentions, notifications) get `→ eigen` in the hover cluster: dispatches the
  item, shows transient `sent` state, row gets a small jade `eigen` chip while a dispatch for its sourceId
  is running (match snapshot.agents.dispatches by sourceId).
- Dispatches list renders in the agents view under the eigen card (status dot, title, RelTime, log path).

## Self-serve recovery

- Anything broken that atrium can fix gets its fix UI inside atrium. Google auth-error → prominent
  `connect google` button (calls connectGoogle()) right in the comms panel + a hint line. Never tell the
  user to go run a command in another tool when a button can do it.

## Polish bar (what "professional" means here)

- Aligned baselines, consistent paddings (panel p-4/p-5, rows py-2 px-2.5), one corner radius family.
- Empty states: one quiet mist-faint line. Loading: subtle pulse, no spinners.
- Tabular numbers for metric columns (`tabular-nums`), units in mist-faint.
- Transitions 120–180ms ease; no bouncy easings. Scrollbars styled (already in styles.css).
- No emoji in UI chrome. No purple gradients. No shadcn defaults look.

## v3/v4 addendum (post-v2 rounds, kept brief — code is the reference)

- **Keyboard layer**: `1-9` and `0` view switch (`0` = itch, the tenth), `/` or `cmd+k` fuzzy command palette (views, github items,
  agents), `q` quiet drawer, `esc` closes the TOPMOST overlay only (centralized in App.tsx — never
  per-overlay window listeners). Views sync to the URL hash (`#revuto`) for desktop-launcher deep links.
- **Living rail**: clock + date, per-view count badges (amber only when act-now/org-review nonempty;
  system badge follows max unmuted flag severity; revuto badge coral on failures).
- **Sparklines**: zero-dep SVG (Spark.tsx) over server-persisted utilization history
  (metric-history.json) — graphs have depth on first frame and survive daemon restarts.
- **Hero numerals**: Instrument Serif has no tnum — tween inside a fixed ch-width slot to stop reflow wobble.
- **GitHub slide-over** (ItemDetail.tsx): read + comment without leaving atrium; "open on github" stays
  one click. Markdown rendered React-elements-only, scheme-whitelisted links.
- **Revuto view**: ninth view, the standalone revuto-watch dashboard embedded — service-backed scheduler
  controls (two-click stop), external dependency status, model probes, reviewers with enforced pause, jobs timeline where
  zero-result polls read as quiet texture (only reviewed>0 earns jade), journal logs, config strip.
- **Tone discipline refinements**: upstream "warn"-level log noise never gets amber (two-tone feeds:
  coral for errors, dim otherwise); jade strictly means did-work/ok.
