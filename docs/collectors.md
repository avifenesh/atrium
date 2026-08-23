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

## signals — one surface for outside attention

Three feeders publish typed `SignalItem`s into the `signals` section through
`server/src/signals.ts` instead of writing unrelated shapes into the plugin lane:

- **mentions** — public mentions of your projects (HN, GitHub, web/blogs, dev.to,
  reddit, YouTube), collected hourly by `scripts/mention-radar.py` and read from its
  `hits.jsonl`.
- **radar** (`server/src/collectors/radar.ts`) — a hand-picked list of Hugging Face
  model families: whether a new checkpoint just landed, and whether anyone is publicly
  asking for a format you could ship (open threads whose titles match your keywords,
  ranked by reactions). A fresh checkpoint still raises `crit` (≤6h) / `warn` flags —
  that is the one time-critical event here. Demand threads are signal rows with a NEW
  marker, not flags: as info flags they buried the strip until the source got muted.
- **exposure** — the counters other services keep for us badly (GitHub 14-day traffic,
  HF rolling 30-day downloads, crates totals), snapshotted daily by the native writer
  in `core/exposure-snapshot.ts` (merge-never-clobber, one JSON per UTC date, same
  format as the retired darklanes script) and reported with day-over-day deltas plus a
  30-day spark series. The portfolio (repos, HF models, crates) lives in the signals
  watch file with everything else; a legacy `exposure.command` still runs for forks
  that kept an external writer.

The watch lists live in `~/.config/atrium/signals.json` and are edited from the
Signals view (PUT `/api/signals/watch`) — mention terms, the radar family list, the
demand keywords, and the exposure portfolio (repos / HF models / crates) all change
at runtime, no code, no restart; `mention-radar.py` reads the same file. `config.json`'s
`radar.watch` seeds the file on first run. Each item gets a persistent first-seen
stamp; everything first seen after the last `POST /api/signals/reviewed` renders as
new, which is what the view's `new` filter and the rail badge count.

Mentions and demand threads are LEADS — places to go comment and win a user. Each
row takes one decision (`POST /api/signals/lead`): **engaged** (commented/answered)
or **skip**; untouched leads queue on the **Business** view, which fronts the whole
cluster — tiyuvta money/ops numbers, the lead queue, site behaviour from webtraffic,
counter trends, and the live API surface probe. Signals/tiyuvta/webtraffic stay as
its detail views.

Radar is still worth reading if you are writing a collector against a public HTTP
API: zero dependencies, one unauthenticated request per watched item, per-item
failures degraded into `error` rather than thrown, and flag/item ids keyed on the
specific release or thread so a mute silences that one and still fires for the next.
`match` scopes "newest release" to the family: without it, a large org's newest
anything wins, and for `google` that was a JAX tabular model — true and useless.
`mirrors` are the repos whose discussion tabs carry the demand, which is usually the
popular mirror rather than the original, because that is where people ask.

## Collectors that drive something (actions)

A plugin collector renders rows and nothing else. When a view needs BUTTONS, the shape
is: a client module under `server/src/core/`, an allowlisted `POST /api/<name>/:action`
route in `server/src/index.ts`, and a small bespoke panel that posts to it. The
`tiyuvta` collector is the worked example.

Two rules that fell out of building it and are worth copying:

- **Allowlist the action names; never proxy a path.** This daemon accepts loopback
  POSTs, so a passthrough route turns into "call any endpoint on the upstream API with
  the owner's credentials".
- **Do not copy the upstream secret into `config.json`.** Point at the file that
  already owns it (`tokenEnvPath`) so there is one copy on the machine and rotating it
  needs no change here.

If a section has its own panel, exclude it from the generic `ExtraPanel` render in
`web/src/App.tsx` — otherwise every row appears twice.

## Ingesting another process's alerts (the `serving` collector)

`serving` reads an append-only alert ledger written by an external watchdog (darklanes'
`ops/serving/sentinel.py`, a 60s systemd timer) and turns it into flags, so its crits ride the
existing `notify` pipe to the phone. Four rules generalise to any collector fed by another
process:

- **Let the writer write a file; do not give it a route.** The watchdog must not depend on this
  daemon being up to do its own job, and a POST would silently discard every alert raised
  during an atrium restart. A file is durable, ingested as a backlog on return, and readable by
  hand when atrium is down. Cost: one collector interval of latency.
- **Group on a stable key the writer declares, never on the message text.** An escalating
  alarm re-sends the same condition with a changing message (a streak, an age). Keying on text
  turns one incident into N flags and N pages, which is how an operator learns to ignore pages.
- **Ingest the events, not the writer's whole state.** The sentinel's `state.json` also carries
  ssh endpoints and provider hostnames; those must not reach a surface that leaves the machine,
  so they are never read rather than read-and-filtered.
- **Treat the writer's own liveness as a signal.** A file-fed pager is equally silent when
  nothing is wrong and when the writer has died, so the writer's heartbeat (here, `state.json`'s
  mtime) gets its own crit flag.

## Reusable bespoke collectors

Most of the author's plugin collectors integrate private tooling, but one is published and
reusable on its own:

- **revuto** — [github.com/avifenesh/revuto](https://github.com/avifenesh/revuto), a local,
  supplier-agnostic autonomous PR reviewer. Clone and run it, then point
  `config.revuto.snapshotUrl` at its local snapshot endpoint and the `revuto` collector
  surfaces its state in atrium.

The rest (itch, surreal, eigen, hermes, …) assume tooling specific to the author's machine;
leave them in `collectors.disabled` unless you are adapting their source.
