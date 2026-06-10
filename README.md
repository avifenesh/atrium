# atrium

Personal life-management dashboard for one machine and one human. A zero-dependency Node daemon polls the things that already run here — GitHub, local AI agents, system health, email/calendar, subscriptions, cron — into a single in-memory snapshot, serves it over REST + SSE to a web UI, and exposes it to LLMs through an MCP server registered with eigen. One global idea throughout: anything noisy can be muted, either visually (`ui`) or for real (`enforced` — the source itself is paused).

## Architecture

```
 collectors (github · agents · system · schedule · comms · subs · notes · surreal)
     │  poll on intervals, failure-isolated
     ▼
   store ── in-memory Snapshot + flags + mutes
     │
     ├── REST  /api/snapshot /api/mutes /api/agents/:id/:action /api/refresh/:s
     └── SSE   /api/stream (full snapshot, then per-section deltas)
            │
   ┌────────┴─────────┐
   ▼                  ▼
 web UI            mcp (stdio, atrium_* tools)
 (glass               │
  observatory)        ▼
                    eigen (auto-runs readonly tools; atrium-ops skill)
```

## Quick start

```sh
./scripts/install.sh        # npm install + build + systemd user unit, enabled + started
# open http://127.0.0.1:5599
node scripts/register-eigen.mjs   # add MCP server + atrium-ops skill to ~/.eigen
```

## Integrations

| source | hook |
| --- | --- |
| github | `gh` / GitHub API as `avifenesh` — review requests, assigned issues, my PRs, mentions, team queue, notifications, repo counts |
| revuto | dashboard snapshot `http://127.0.0.1:5180/api/snapshot` + revuto CLI (pause/resume reviewers) |
| hermes | `~/.hermes/gateway_state.json`, `~/.hermes/cron/jobs.json` + hermes CLI |
| eigen | `~/.eigen/sessions*`, `~/.eigen/observe/events.jsonl`, daemon socket |
| claude code | `~/.claude/projects` session files |
| codex | `~/.codex/session_index.jsonl` |
| itch | `~/.config/itch/runs` |
| any-mission | `~/projects/any-mission/.any-mission` |
| training (idle-watcher) | `~/.local/state/idle-watcher/` state + log |
| system | `/proc`, `nvidia-smi`, `df`, `ss`, `systemctl --user` |
| schedule | `crontab -l`, hermes cron jobs, systemd user/system timers |
| email / calendar | Google token at `~/.hermes/google_token.json` (Gmail + Calendar) |
| subscriptions | `~/.claude/.credentials.json`, `~/.grok/auth.json`, `~/.codex`, cursor-agent — plan names and status only, no secrets enter the snapshot |
| notes | Obsidian registry `~/.config/obsidian/obsidian.json` |
| surreal | SurrealDB at `http://127.0.0.1:8000` |

## Config

Defaults live in `server/src/config.ts`. Override any subset via `~/.config/atrium/config.json` — it is deep-merged over the defaults (port, paths, poll intervals, known ports, watched units).

## Eigen registration

`node scripts/register-eigen.mjs` is idempotent: it adds/updates the `atrium` entry in `~/.eigen/mcp.json` (existing servers untouched, no tools allowlist = all tools) and installs the `atrium-ops` skill at `~/.eigen/skills/atrium-ops/SKILL.md`. Query tools carry `readOnlyHint` so eigen can auto-run them in gated mode; mute/unmute/agent-action do not.
