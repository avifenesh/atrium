# atrium design language — "glass observatory"

Dark glass control room. Calm by default; exactly one warm accent pulls the eye to what needs action.

## Tokens (defined in `web/src/styles.css`, use them — never raw hex in components)

- Base: `ink` #0a0e14, panels are translucent white-on-dark (`.glass`, `.glass-raised`)
- Text: `mist` (primary) / `mist-dim` (secondary) / `mist-faint` (tertiary)
- Accent: `amber` #f0b35e — ONLY for act-now items, attention counts, active work. Never decorative.
- Status: `jade` ok/running, `coral` error/crit, `slate-glow` info/links
- Type: `font-display` Instrument Serif italic (wordmark, big numerals, section headers),
  `font-sans` Hanken Grotesk (UI), `font-mono` Spline Sans Mono (data: counts, times, ids, metrics)

## Rules

1. Panels use `.glass` (or `.glass-raised` for emphasis/hover). No solid cards.
2. Background atmosphere + grain come from `body` css — components never add their own backgrounds beyond glass.
3. Staggered entrance: top-level panels get `className="rise"` + `style={{ '--rise-i': i }}`.
4. Status everywhere via `.dot dot-<status>` — no text-only status.
5. Muted things DIM (`.muted-dim`), they don't disappear. Quiet ≠ gone.
6. Numbers/timestamps/ids in `font-mono`; relative times ("4m ago") over absolute where space is tight.
7. Density: generous padding on panels (p-4/p-5), tight rows inside (py-1.5/py-2). Lists scroll inside panels (`max-h-* overflow-y-auto`), page itself stays one viewport when possible.
8. Headers: lowercase, `font-display` italic for view titles (e.g. *tasks*), small mono uppercase labels (`text-[11px] tracking-widest uppercase text-mist-faint font-mono`) for sub-sections.
9. Every list item that maps to a mutable resource gets a hover-revealed mute button (🔕 / "quiet") wired to `addMute`.
10. Empty states: one quiet line in `text-mist-faint`, never a giant illustration.
11. No purple gradients, no Inter, no shadcn look, no emoji noise. Tasteful, sharp, calm.
