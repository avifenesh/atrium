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
