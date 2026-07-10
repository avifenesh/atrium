# Atrium design language v5 — nocturne instrument

Atrium is a local operator workspace for one person and one machine. It should feel like a precise instrument: quiet when the machine is quiet, immediate when something needs attention, and fast to scan without becoming sterile.

The visual thesis is warm type and fine instrumentation over a nearly black field. One sulfur-amber accent marks attention and active position. Everything else earns its color through meaning.

## Product language

- Write from the operator's side of the screen. Say “Needs action,” not “act-now lane.”
- Workspace headings orient: what this area contains and why it matters.
- Buttons name the result: “Start research,” “Save changes,” “Open,” “Quiet.”
- Empty states explain the state in a full sentence and, when useful, the next action.
- Keep product-specific terms such as Quiet, Itch, Collide, and Revuto only where they carry real domain meaning. Explain them at the control boundary.
- Use sentence case. Reserve uppercase mono labels for small structural metadata such as navigation groups and source types.

## Tokens

Tokens live in `web/src/styles.css`; components should not introduce one-off hex values.

- `ink` `#07090d`: page field.
- `ink-2` `#0d1118`: controls and raised regions.
- `mist` `#f3f0e8`: warm primary text.
- `mist-dim` / `mist-faint`: secondary and tertiary text.
- `amber` `#e8c76a`: the sole interaction and attention accent.
- `jade`: healthy or completed work. `coral`: failure or critical state. `slate-glow`: links and information.

Hanken Grotesk carries product language. Spline Sans Mono carries time, counts, identifiers, paths, and telemetry. Instrument Serif italic is reserved for the Atrium wordmark and the Now workspace's hero numerals.

## Information hierarchy

Every workspace follows the same reading order:

1. Workspace group, name, and a one-line orientation.
2. Active signals that cross workspace boundaries.
3. Primary work or decision surface.
4. Supporting context and telemetry.

Do not give all four levels the same container treatment. Workspace headers are open. Signals use a compact horizontal lane. Panels contain distinct working contexts. Rows remain continuous inside a panel rather than becoming nested cards.

## Navigation

- Desktop navigation is grouped by the operator's mental model: Today, Work, Machine, Explore, Library, and Plugins.
- The active workspace uses one amber position mark, not a filled accent button.
- Counts keep their semantic tone: amber for attention, jade for active work, coral for failures, neutral otherwise.
- On phones, Now, Tasks, Agents, and Itch remain one tap away. Every other workspace is under More.
- Keyboard behavior is first-class: number keys switch views, `/` or `cmd+k` opens Find, `q` opens the Quiet archive, and `esc` closes only the topmost overlay.

## Surfaces and density

- `.panel-surface` is the standard working region. It uses a fine upper edge and a short amber registration mark.
- `.glass` and `.glass-raised` are controls and overlays, not the default wrapper for every section.
- `.surface-row` is the standard list row: full-row activation, subtle separators, no nested card chrome.
- Use whitespace and alignment before borders. Do not put decorative gradients behind routine data.
- Use the wide viewport: the shell caps at 1920px, the rail stays narrow, and panels stretch to their grid track.
- At mobile widths, actions remain visible, tap targets are at least 36–44px where space allows, and horizontal overflow is clipped at the workspace boundary.

## Status and color

Amber means “look here” or “this is active.” It does not mean generic warmth. Jade means healthy, running, or completed. Coral means error, stopped unexpectedly, or critical. Informational text stays neutral or slate.

Active signals sit above the workspace in severity order. Quieting a signal removes it from that lane and moves it to the Quiet archive. Muted rows never linger as low-opacity clutter.

## Interaction

- Anything that names a thing should open, copy, select, or expand it.
- Secondary actions appear on hover and keyboard focus on desktop; touch layouts keep them visible.
- Destructive actions require an inline second confirmation. Never use `window.confirm`.
- Async actions report busy, success, and failure in place.
- Motion is restrained: one staggered workspace entrance, the live signal pulse, and short overlay transitions. All motion respects reduced-motion preferences.
- Focus is always visible with a two-pixel amber outline and offset.

## Self-serve recovery

When Atrium can repair a problem, put the repair beside the problem. Authentication, reconnect, retry, refresh, resume, and stop controls belong in the relevant workspace. Error copy states what failed and the next available recovery action.

## Quality bar

- Validate at 390px, 1280px, 1366px, 1600px, and 1920px when a layout changes materially.
- Truncate unstable external strings and keep the full value in a title or detail view.
- Keep numeric columns tabular and units visually secondary.
- Loading uses a quiet pulse or streaming cursor; no ornamental spinners.
- No emoji chrome, purple gradients, dashboard-card mosaics, or generic component-library styling.
- The UI must remain useful with shadows removed. Hierarchy comes from type, spacing, alignment, and contrast.
