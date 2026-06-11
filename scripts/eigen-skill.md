---
name: atrium-ops
description: Manage avifenesh's life dashboard (GitHub tasks, agents, system health, email/calendar, subscriptions, revuto/itch watch, quiet/mute) via atrium_* MCP tools. Use when asked about tasks, what needs attention, system status, muting noise, or pausing agents.
---

# atrium-ops

For "what needs my attention" or any open-ended status ask, call `atrium_overview` first — it gives act-now count, email/calendar, agent fleet, flags, and mutes in one shot. Drill down only where it points.

## Task lanes (`atrium_tasks`)

- `actNow` — direct review requests + issues assigned to me. The lane to work first.
- `myPRs` — my open PRs with draft/review/CI state.
- `mentions` — issues/PRs that mention me.
- `teamQueue` — team review requests minus direct minus bots. Secondary.
- `notifications` — raw GitHub notification feed.

## Mute semantics (`atrium_mute`)

- Default (`ui` mode): the item is hidden/dimmed in the dashboard only — the source keeps running.
- `enforce: true`: actually pauses the real source where supported — revuto repo reviewers, hermes cron jobs, systemd units. revuto's guard timer would normally restart paused things; the server handles that caveat itself, do not work around it.
- `until` omitted means forever. Reverse with `atrium_unmute({id})` (id is returned on mute and listed in the snapshot).

## Agent actions (`atrium_agent_action`)

Actions: `pause`, `resume`, `stop`, `start`, `trigger`, `kill` — availability varies per agent; check `controls` in `atrium_agents` first. `target` selects a sub-resource (repo for revuto pause, job id for hermes). `kill` is destructive — confirm intent.

## App watch (`atrium_revuto`, `atrium_itch`)

- `atrium_revuto` — revuto PR-reviewer state: services, per-repo reviewers, model probes, recent jobs, counts, schedules/limits.
- `atrium_itch` — itch idea-scout state: research run status, rated-ideas total, recent runs with collide temp and sampled domains.
- Both are read-only and keep last-good data when the app is down (output flags unreachability and staleness). The daemon auto-heals both apps — don't restart them by hand. To act on revuto (pause/resume a repo, trigger, stop/start the daemon), go through `atrium_agent_action`. itch has no controls — the daemon only watches and auto-starts it.

## Daemon down

If tools reply "atrium daemon not running": `systemctl --user start atrium`, or directly `node /home/avifenesh/projects/atrium/server/dist/server/src/index.js`. Health check: `curl http://127.0.0.1:5599/api/health`.
