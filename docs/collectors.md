# Writing a collector

A **collector** is the only extension point you need. It polls something on your machine
on an interval and writes the result into the in-memory store; the daemon schedules it,
isolates its failures, and streams its output to the web UI and MCP clients.

## The contract

Each collector is one module that default-exports an object:

```ts
export interface Collector {
  name: string;        // unique; also the snapshot section key
  intervalMs: number;  // poll cadence
  core?: boolean;      // true = typed core section; omit/false = plugin (extra lane)
  run(): Promise<void>;// one poll cycle — writes into the store, never returns data
}
```

`run()` writes results into the store directly. It should never throw for an expected
failure (a down service, a missing file) — catch those and record them as section error
state or a flag. The registry wraps `run()` with a watchdog and a try/catch, so a thrown
error is logged and isolated, but handling it yourself produces a better UI.

## Core vs plugin collectors

- **Core collectors** (`core: true`) own a strongly-typed field on the `Snapshot`
  (`github`, `system`, …) and usually a bespoke React panel. They write with
  `store.setSection(name, data)`. Adding a new core collector means editing
  `shared/types.ts` and adding a panel — more work, full type safety, custom UI.

- **Plugin collectors** (the default — omit `core`) write the generic `extra` lane with
  `store.setExtra(name, section)` and render in the generic `ExtraPanel` with **no React
  code at all**. This is the path for anything you bolt on.

## Worked example

A complete, dependency-free plugin collector that surfaces disk usage and pages you when a
mount crosses 90% lives at [`examples/collectors/disk-usage.ts`](../examples/collectors/disk-usage.ts).
It demonstrates every piece of the contract: polling a subprocess, building `ExtraRow`s
with tone, writing the `extra` lane, and raising a flag.

The `ExtraSection` shape it writes:

```ts
store.setExtra('disk', {
  title: 'disk',                       // panel header + nav label
  updatedAt: new Date().toISOString(),
  up: true,                            // false renders a "down" badge
  rows: [                              // label/value rows the generic panel renders
    { label: '/', value: '63% of 500G', tone: 'ok' },   // ok=jade warn=amber err=coral
    { label: '/data', value: '91% of 2T', tone: 'err', href: 'https://...' },
  ],
  error: null,
  data: undefined,                     // optional raw payload for MCP/consumers, UI ignores it
});
```

## Registering it

1. Copy your collector into `server/src/collectors/`.
2. Import it and add it to the `register()` loop in `server/src/index.ts`:

   ```ts
   import diskCollector from './collectors/disk-usage.js';
   // …
   for (const c of [ /* …existing… */, diskCollector ]) register(c);
   ```
3. Rebuild (`npm run build`). It appears as a new view in the rail automatically.

## Flags

Any collector can raise flags with `store.setFlags(name, flags)`. Each collector owns its
flag namespace and replaces its own flags wholesale each cycle. A flag with
`severity: 'crit'` pages you through the configured `notify.sendCmd` backend (subject to
throttling). Use `info`/`warn`/`crit` deliberately — only `crit` reaches the phone by
default (`notify.minSeverity`).

## Turning collectors off

Any collector can be disabled without touching code via
`~/.config/atrium/config.json`:

```jsonc
{ "collectors": { "disabled": ["itch", "revuto", "surreal", "agents:hermes"] } }
```

Names match the collector `name`; bespoke agent sub-sources use the `agents:<id>` form.
This is how a fork that doesn't run the author's bespoke tooling gets a clean core
dashboard. See [config.md](config.md).

## Business surfaces live in the CRM

Until 2026-09-16 atrium also carried the tiyuvta business cluster: the mention radar, the
Hugging Face demand radar, the lead queue, the ops console with its actions, endpoint
TTFT probes, the serving alert fold, real-user API metrics, site analytics, the usage
mix, OpenRouter and Vast watches, and a CRM with its own public host. All of it moved to
the tiyuvta CRM (crm.tiyuvta.ai, darklanes `workers/crm`), which runs a job for each:
`mentions`, `demand-*`, `hf-radar`, `endpoint-probes`, the serving fold over the
sentinel ledger, `ae-webtraffic`, `ae-apimetrics`, `ae-apiusage`, `usage-mirror`,
`openrouter`, `vast`. Atrium is the life dashboard again: a business question is
answered in the CRM, not here.

Still in this repo, on purpose:

- **`distribution`** (where tiyuvta is and is not listed) is the one business surface
  without a CRM job yet. Phase 2 ports it; until then it renders as a plain plugin section.
- **`exposure`** is a personal counter for the owner's open-source projects (GitHub
  14-day traffic, Hugging Face 30-day downloads, crates totals), not a business surface.
  The portfolio is config (`exposure.portfolio`); the native writer in
  `core/exposure-snapshot.ts` records one JSON per UTC day, merge-never-clobber, so a
  series exists after the upstream windows expire. Summary rows with day-over-day deltas
  go to the plugin lane; the full counter list with 30-day spark series rides in `data`.
- **`scripts/mention-radar.py`** and its timer still write `hits.jsonl` for the CRM's rig
  feed (`POST /ingest/mention-hits`); atrium no longer reads it. Phase 2 moves the script
  into darklanes beside the CRM shipper and removes it from here.

If a section has its own panel, exclude it from the generic `ExtraPanel` render in
`web/src/App.tsx` (`BESPOKE_EXTRAS`), otherwise every row appears twice.

## The day's receipt (the `shipped` collector)

`shipped` answers one question at the end of a day: what actually landed? It runs one
`git log` per repo under `paths.projectsDir` (the same set the `repos` collector walks,
via its exported `listRepoDirs`) for commits you authored since the local day start, and
two `gh search prs` calls for the PRs you merged and opened. It writes the plugin lane
with summary `rows` for MCP and the generic panel, and a full `ShippedReport` in `data`
for its own panel: an hour strip, per-repo bars, the commit list, the PR list.

Choices worth copying if you build a retrospective board of your own:

- **The day is not midnight.** `shipped.dayStartHour` (default 4) is the rollover, so a
  01:30 commit stays with the evening it belongs to instead of opening a new empty day
  under your hands.
- **Refs, not the working tree.** `--branches --remotes` sees commits made in any
  worktree of the repo (they share refs) and commits pushed from another machine,
  while `refs/stash` and tags stay out; `--no-merges` drops "Merge pull request"
  commits and keeps squash merges, which are ordinary commits. `wt-*` directories are
  skipped for cost, and the report deduplicates by sha anyway so a repo cloned twice
  counts once.
- **Committer time, not author time.** A squash merge carries the author date of the
  first draft, sometimes days old; the committer date is when it landed, which is the
  fact this board reports.
- **The search API is fine at this cadence.** The `github` collector bans `gh search`
  because it polls every minute against a shared budget. Two calls every five minutes is
  nothing, and the date filter gets one day of slack because it works on calendar dates
  while the board works on a local day start; the parser trims the rest.
- **Opened means still open.** The opened search carries `--state=open`; a PR opened today
  and closed without a merge is not shipping and does not appear.
- **A failed `git log` is not a quiet repo.** The two are told apart (`null` vs `[]`) and
  failed repos are listed in the report and on the panel, so an undercount is never silent.
- **No flags.** Nothing here needs attention. A board that exists to be looked at should
  never page.

## Reusable bespoke collectors

Most of the author's plugin collectors integrate private tooling, but one is published and
reusable on its own:

- **revuto** — [github.com/avifenesh/revuto](https://github.com/avifenesh/revuto), a local,
  supplier-agnostic autonomous PR reviewer. Clone and run it, then point
  `config.revuto.snapshotUrl` at its local snapshot endpoint and the `revuto` collector
  surfaces its state in atrium.

The rest (itch, surreal, eigen, hermes, …) assume tooling specific to the author's machine;
leave them in `collectors.disabled` unless you are adapting their source.
