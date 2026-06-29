# Contributing

Atrium is a single-machine, loopback-only dashboard. Contributions that keep it that way —
zero-dependency, self-hosted, no auth-by-design — are welcome.

## Layout

```
server/   the Node daemon: collectors → store → REST/SSE     (server/src/collectors/)
web/      the React UI (Vite + Tailwind)                       (web/src/panels/)
mcp/      the stdio MCP server exposing atrium_* tools
shared/   types shared across all three
examples/ reference collectors + notify backends (copy-and-edit)
docs/     collector contract + config reference
```

## Build and run

```sh
npm install
npm run build                 # builds all three workspaces
npm run dev:server            # daemon with reload
npm run dev:web               # vite dev server (proxies /api to the daemon)
```

Typecheck a single workspace: `npx tsc --noEmit -p server` (or `web` / `mcp`).

## The main extension point: collectors

Almost everything you'd want to add is a collector. The full contract, the core-vs-plugin
distinction, and a complete worked example are in **[docs/collectors.md](docs/collectors.md)**.
The short version: a plugin collector is one file that writes the generic `extra` lane and
renders automatically — no React required.

## Bespoke vs general code

The core collectors (`github`, `system`, `schedule`, `comms`, `subs`, `notes`, `cloud`,
`backup`, `repos`) are meant to work on any Linux box and are driven entirely by config.
A second set in `server/src/collectors/` (`itch`, `revuto`, `surreal`, and several agent
sub-sources) integrate the author's own local tooling — they are not examples, just
machine-specific code you can switch off with `config.collectors.disabled`. Standalone
templates for building your own live separately in [`examples/`](examples/). When
contributing, prefer extending the general path; keep machine-specific assumptions in
config, not in code.

## Ground rules

- **Loopback only.** No feature may make atrium safe to expose on a LAN — there is no auth
  layer by design. Don't add one as a workaround; the threat model is "never reachable".
- **No secrets in the snapshot.** Tokens, credentials, and raw command lines must never
  enter the snapshot, SSE stream, logs, or error responses. Redact at the source.
- **No shell.** All subprocess calls go through argv-array `execFile`/`spawn` with
  validation on every user-reachable argument. Never interpolate into a shell string.
- **Match the UI bar.** New views should clear the design bar in [DESIGN.md](DESIGN.md).

## Before you open a PR

Run `npm run build` (all three workspaces must compile) and exercise your change in the
running app.
