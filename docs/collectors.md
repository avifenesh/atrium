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

## radar — a worked config-driven collector

`server/src/collectors/radar.ts` watches a hand-picked list of Hugging Face model
families and reports two things per family: whether a new checkpoint just landed, and
whether anyone is publicly asking for a format you could ship (open discussion threads
whose titles match your keywords, ranked by reactions). It raises `crit` for a
checkpoint younger than six hours, `warn` inside the fresh window, and `info` for a
popular request thread.

It is worth reading if you are writing your own collector against a public HTTP API:
zero dependencies, one unauthenticated request per watched item, per-item failures
degraded into `error` rather than thrown, and flag ids keyed on the specific release or
thread so a mute silences that one and still fires for the next.

It polls nothing until you configure it. The watchlist is deliberately explicit —
watching every release on the Hub produces a wall of things you cannot act on — and it
lives in `~/.config/atrium/config.json`, not in this repo:

```jsonc
{
  "radar": {
    "watch": [
      { "family": "Qwen3.8 27B", "org": "Qwen", "match": "Qwen3.8",
        "status": "supported",
        "baseModel": "Qwen/Qwen3.8-27B",
        "mirrors": ["unsloth/Qwen3.8-27B-NVFP4", "unsloth/Qwen3.8-27B-GGUF"] }
    ]
  }
}
```

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

## Reusable bespoke collectors

Most of the author's plugin collectors integrate private tooling, but one is published and
reusable on its own:

- **revuto** — [github.com/avifenesh/revuto](https://github.com/avifenesh/revuto), a local,
  supplier-agnostic autonomous PR reviewer. Clone and run it, then point
  `config.revuto.snapshotUrl` at its local snapshot endpoint and the `revuto` collector
  surfaces its state in atrium.

The rest (itch, surreal, eigen, hermes, …) assume tooling specific to the author's machine;
leave them in `collectors.disabled` unless you are adapting their source.
