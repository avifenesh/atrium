# atrium

A zero-dependency life dashboard for one machine and one human. A small Node daemon
polls the things already running on your box — GitHub, local AI agents, system health,
email/calendar, subscriptions, cron, backups — into a single in-memory snapshot, serves
it over REST + SSE to a web UI, and exposes it to LLMs through an MCP server. One global
idea throughout: anything noisy can be muted, either visually (`ui`) or for real
(`enforced` — the source itself is paused).

It is **self-hosted and loopback-only by design** — there is no auth layer, no cloud, no
account. It runs as a systemd user service, binds `127.0.0.1`, and refuses to start on any
non-loopback host. Your data never leaves the machine.

![atrium now view](docs/img/now-view.png)

*The `now` view: act-now GitHub tasks, who's waiting on you, agents working, and live
system health — one screen, calm by default. (Some labels redacted for the screenshot.)*

> **Heads up — this started as one person's dashboard.** The *core* collectors
> (github, system, schedule, comms, subs, notes, cloud, backup, repos) are general and
> driven entirely by config. A second set in `server/src/collectors/` (eigen, hermes,
> revuto, itch, …) integrate the author's bespoke local tooling — leave them on if you run
> those tools, or switch them off with one config line
> (`collectors.disabled`, see [docs/config.md](docs/config.md)). To add your own, copy a
> ready-made template from [`examples/collectors/`](examples/collectors/) — a plugin
> collector renders in the dashboard with no UI code. See [docs/collectors.md](docs/collectors.md).

## Architecture

```
 core collectors (github · system · schedule · comms · subs · notes · cloud · backup · repos)
 plugin collectors (your own — see examples/collectors/)
     │  poll on intervals, failure-isolated
     ▼
   store ── in-memory Snapshot + flags + mutes
     │
     ├── REST  /api/* (see Routes)
     └── SSE   /api/stream (full snapshot, then per-section deltas)
            │
   ┌────────┴─────────┐
   ▼                  ▼
 web UI            mcp (stdio, atrium_* tools)
 (glass               │
  observatory)        ▼
                    your MCP host (auto-runs readonly tools)
```

The web UI is a set of views behind a keyboard layer: number keys switch views, `/` or
`cmd+k` open the fuzzy command palette, `q` toggles the quiet drawer, `esc` closes the
topmost overlay. Views deep-link via URL hash (`#system`, `#tasks`), so a desktop launcher
can open straight into one. Core views ship typed; plugin collectors render in a generic
panel keyed by their section name.

The daemon also serves the built web UI: `index.html` is sent `no-cache` (so a rebuild
lands on the next load), content-hashed `assets/` are cached immutable for a year.

## Quick start

Requires **Node ≥ 24** and a **Linux user systemd session**.

```sh
./scripts/install.sh        # npm install + build + generates the systemd user unit, enabled + started
# open http://127.0.0.1:5599
```

`install.sh` renders `scripts/atrium.service.in` with the current `node` path and repo
location, so an nvm upgrade just needs a re-run.

To register the MCP server with an MCP host (the bundled script targets `~/.eigen`; adapt
the path for Claude Code, Cursor, etc. — it just writes an `mcp.json` entry):

```sh
node scripts/register-eigen.mjs
```

## First-run configuration

Out of the box atrium runs the **core** collectors. Most need to know *who you are* —
your GitHub login, which orgs count as "yours", which systemd units to watch. None of that
lives in the repo: it all comes from `~/.config/atrium/config.json`, which is deep-merged
over the defaults in `server/src/config.ts`.

A minimal config to make it yours:

```jsonc
{
  "github": {
    "login": "your-gh-username",
    "ownOrgs": ["your-org"],       // repos here count as "your repos"
    "noiseOrgs": []                // orgs excluded from authored-issue noise
  },
  "watchedUnits": [                // systemd --user units to surface in the system view
    "my-service.service"
  ],
  "notify": {
    "enabled": true,
    "sendCmd": ["ntfy", "publish", "my-topic"]   // argv array; the message is appended as the last arg
  }
}
```

`sendCmd` is any program that takes a message as its final argument (ntfy, a webhook curl,
a custom script) — see [examples/notify](examples/notify/). If `sendCmd` is empty, push
notifications are simply off; the flag still shows in the dashboard.

## Routes

| group | routes |
| --- | --- |
| snapshot | `GET /api/health` · `GET /api/snapshot` · `GET /api/stream` (SSE) · `POST /api/refresh/:collector` |
| mutes | `POST /api/mutes` · `DELETE /api/mutes/:id` |
| agents | `POST /api/agents/:id/:action` · `POST /api/eigen/dispatch` |
| github | `GET /api/github/item` · `POST /api/github/comment` · `POST /api/notifications/read` |
| notes | `GET /api/notes/read` · `POST /api/notes/write` (optimistic concurrency, 409 on conflict) |
| google | `GET /api/google/status` · `GET /api/google/auth-url` · `GET /api/google/callback` |
| spotify | `POST /api/spotify/client` · `GET /api/spotify/auth-url` · `GET /api/spotify/callback` |

Plugin collectors may register their own routes; the bundled itch plugin proxies
`/api/itch/*` to a local service as one worked example.

## Core integrations

| source | hook |
| --- | --- |
| github | `gh` / GitHub API as your configured login — review requests, assigned issues, your PRs, mentions, org queue (external PRs/issues on owned repos, ranked first), team queue, notifications, repo counts |
| claude code | `~/.claude/projects` session files |
| codex | `~/.codex/session_index.jsonl` |
| system | `/proc`, `nvidia-smi`, `df`, `ss`, `systemctl --user`; utilization history persisted server-side so sparklines have depth on open |
| schedule | `crontab -l`, systemd user/system timers |
| email / calendar | atrium-owned Google OAuth (in-app connect, loopback callback) |
| spotify | in-app PKCE connect (paste a client id once in the subs card) |
| subscriptions | local credential/config files for common AI CLIs — plan names and usage bars only, no secrets enter the snapshot |
| notes | Obsidian registry `~/.config/obsidian/obsidian.json`; in-app reader + editor |
| cloud | AWS via the local CLI/credentials |
| backup | restic repository status |

The author's own plugin collectors (eigen, hermes, revuto, itch, grok, surreal,
any-mission, an idle/training watcher) live in `server/src/collectors/` and integrate
local tooling you almost certainly don't run — switch them off with `collectors.disabled`.
For building your own, `examples/collectors/` holds standalone templates with no personal
dependencies.

Among the built-in bespoke collectors, one is reusable on its own:
**[revuto](https://github.com/avifenesh/revuto)** — a local, supplier-agnostic autonomous
PR reviewer that learns from maintainer feedback. If you run it, clone it and point
`config.revuto.snapshotUrl` at its local snapshot endpoint; the `revuto` collector
(`server/src/collectors/revuto.ts`) then surfaces its state in atrium. Otherwise leave that
collector disabled.

## Security model

There is deliberately **no auth layer**; safety comes from never being reachable:

- binds `127.0.0.1` only, and refuses to start on any non-loopback host — the eigen
  dispatch route spawns an agent with the user's credentials, so LAN exposure is never
  acceptable
- strict `Host` allowlist on every request (DNS-rebinding defense) and same-origin-or-absent
  `Origin` on every state-changing method (CSRF defense — `text/plain` POSTs need no preflight)
- secrets never enter the snapshot, SSE stream, logs, or error responses; token files are
  written `0600` with atomic unique-tmp renames; process command lines are redacted
  (`--token`, `KEY=`, `Bearer …`) before entering the snapshot
- all subprocess calls are argv-array `execFile`/`spawn` (no shell), with allowlist/regex
  validation on every user-reachable argument

## Data on disk

Everything the daemon writes lives in `~/.config/atrium/`: `mutes.json`,
`metric-history.json`, `google_token.json` / `spotify_token.json` / `spotify_client.json`
(0600), and `eigen-runs/` (dispatch records + 0600 run logs). Config overrides in
`config.json`. Nothing is written inside the repo at runtime.

## Config

Defaults live in `server/src/config.ts`. Override any subset via
`~/.config/atrium/config.json` — it is deep-merged over the defaults (port, paths, poll
intervals, known ports, watched units, github identity, notify backend). The `host` key is
validated: non-loopback values are refused at startup.

## Writing your own collector

A collector is one module that default-exports `{ name, intervalMs, run() }` and writes
its result into the store. Core collectors write typed sections; plugin collectors write
into a generic `extra` lane and render in a generic panel. The full contract and a worked
example live in [docs/collectors.md](docs/collectors.md).

## License

MIT — see [LICENSE](LICENSE).
