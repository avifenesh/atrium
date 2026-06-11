# atrium

Personal life-management dashboard for one machine and one human. A zero-dependency Node daemon polls the things that already run here — GitHub, local AI agents, system health, email/calendar, subscriptions, cron — into a single in-memory snapshot, serves it over REST + SSE to a web UI, and exposes it to LLMs through an MCP server registered with eigen. One global idea throughout: anything noisy can be muted, either visually (`ui`) or for real (`enforced` — the source itself is paused).

## Architecture

```
 collectors (github · agents · system · schedule · comms · subs · notes · surreal · revuto)
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
                    eigen (auto-runs readonly tools; atrium-ops skill)
```

The web UI is nine views (now · tasks · agents · revuto · system · comms · subs · schedule · notes) behind a keyboard layer: `1-9` switch views, `/` or `cmd+k` open the fuzzy command palette, `q` toggles the quiet drawer, `esc` closes the topmost overlay. Views deep-link via URL hash (`#revuto`), so desktop launchers can open straight into one.

## Quick start

Requires Node ≥ 24 and a Linux user systemd session.

```sh
./scripts/install.sh        # npm install + build + generates the systemd user unit, enabled + started
# open http://127.0.0.1:5599
node scripts/register-eigen.mjs   # add MCP server + atrium-ops skill to ~/.eigen
```

`install.sh` renders `scripts/atrium.service.in` with the current `node` path and repo location, so an nvm upgrade just needs a re-run.

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

## Integrations

| source | hook |
| --- | --- |
| github | `gh` / GitHub API as `avifenesh` — review requests, assigned issues, my PRs, mentions, org queue (external PRs/issues on owned repos, ranked first), team queue, notifications, repo counts |
| revuto | full watch view proxied from the local dashboard (`http://127.0.0.1:5180/api/snapshot`, self-healed via systemd when down) + revuto CLI (pause/resume reviewers) |
| hermes | `~/.hermes/gateway_state.json`, `~/.hermes/cron/jobs.json` + hermes CLI |
| eigen | `~/.eigen/sessions*`, `~/.eigen/observe/events.jsonl`, daemon socket |
| claude code | `~/.claude/projects` session files |
| codex | `~/.codex/session_index.jsonl` |
| itch | `~/.config/itch/runs` |
| any-mission | `~/projects/any-mission/.any-mission` |
| training (idle-watcher) | `~/.local/state/idle-watcher/` state + log |
| system | `/proc`, `nvidia-smi`, `df`, `ss`, `systemctl --user`; utilization history persisted server-side so sparklines have depth on open |
| schedule | `crontab -l`, hermes cron jobs, systemd user/system timers |
| email / calendar | atrium-owned Google OAuth (in-app connect, loopback callback); hermes token as fallback |
| spotify | in-app PKCE connect (paste a client id once in the subs card) |
| subscriptions | `~/.claude/.credentials.json`, `~/.codex`, cursor-agent local JWT, copilot, z.ai — plan names and usage bars only, no secrets enter the snapshot |
| grok | live credit usage by speaking JSON-RPC to the grok CLI's own `agent stdio` channel (`_x.ai/billing`) — atrium never reads the token itself |
| notes | Obsidian registry `~/.config/obsidian/obsidian.json`; in-app reader + editor |
| surreal | SurrealDB at `http://127.0.0.1:8000` |

## Security model

There is deliberately **no auth layer**; safety comes from never being reachable:

- binds `127.0.0.1` only, and refuses to start on any non-loopback host — `/api/eigen/dispatch` spawns an agent with the user's credentials, so LAN exposure is never acceptable
- strict `Host` allowlist on every request (DNS-rebinding defense) and same-origin-or-absent `Origin` on every state-changing method (CSRF defense — `text/plain` POSTs need no preflight)
- secrets never enter the snapshot, SSE stream, logs, or error responses; token files are written `0600` with atomic unique-tmp renames; process command lines are redacted (`--token`, `KEY=`, `Bearer …`) before entering the snapshot
- all subprocess calls are argv-array `execFile`/`spawn` (no shell), with allowlist/regex validation on every user-reachable argument

## Data on disk

Everything the daemon writes lives in `~/.config/atrium/`: `mutes.json`, `metric-history.json`, `google_token.json` / `spotify_token.json` / `spotify_client.json` (0600), and `eigen-runs/` (dispatch records + 0600 run logs). Config overrides in `config.json` (see below). Nothing is written inside the repo at runtime.

## Config

Defaults live in `server/src/config.ts`. Override any subset via `~/.config/atrium/config.json` — it is deep-merged over the defaults (port, paths, poll intervals, known ports, watched units). The `host` key is validated: non-loopback values are refused at startup.

## Eigen registration

`node scripts/register-eigen.mjs` is idempotent: it adds/updates the `atrium` entry in `~/.eigen/mcp.json` (existing servers untouched, no tools allowlist = all tools) and installs the `atrium-ops` skill at `~/.eigen/skills/atrium-ops/SKILL.md`. Query tools carry `readOnlyHint` so eigen can auto-run them in gated mode; mute/unmute/agent-action do not.
