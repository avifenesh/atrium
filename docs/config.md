# Configuration reference

All configuration is optional. Defaults live in `server/src/config.ts`; override any
subset by writing `~/.config/atrium/config.json`, which is **deep-merged** over the
defaults — you only specify what you change. Restart the daemon
(`systemctl --user restart atrium`) after editing.

## A typical config

```jsonc
{
  "github": {
    "login": "your-gh-username",
    "ownOrgs": ["your-org"],
    "noiseOrgs": ["some-noisy-org"],
    "reviewBotNoiseLogins": ["gemini-code-assist", "coderabbitai"]
  },
  "notify": {
    "enabled": true,
    "minSeverity": "crit",
    "sendCmd": ["ntfy", "publish", "my-secret-topic"]
  },
  "watchedUnits": ["my-service.service"],
  "collectors": {
    "disabled": ["itch", "revuto", "surreal", "agents:hermes", "agents:eigen"]
  }
}
```

## Keys

### Top level

| key | default | meaning |
| --- | --- | --- |
| `port` | `5599` | HTTP port (loopback only) |
| `host` | `127.0.0.1` | bind address; **non-loopback values are refused at startup** (no auth layer exists) |
| `configDir` | `~/.config/atrium` | where the daemon writes mutes, tokens, metric history |

### `github`

Drives the tasks view. **`login` is empty by default** — until you set it, the github
collector stays idle (it can't search without a login).

| key | default | meaning |
| --- | --- | --- |
| `login` | `''` | your GitHub username — required to enable the collector |
| `ownOrgs` | `[]` | orgs whose repos count as "your repos" (org queue + own-repos counts) |
| `noiseOrgs` | `[]` | orgs excluded from the attention lanes |
| `noiseRepos` | `[]` | repos excluded from every GitHub lane (`owner/name`) |
| `reviewBotNoiseLogins` | `[]` | PR review bots collapsed into a notification digest |
| `pollMs` | `60000` | poll cadence |
| `ownReposPollMs` | `600000` | slower cadence for own-repo counts |
| `failThreshold` | `3` | consecutive failed polls before the crit flag pages you |
| `agingDays` | `14` | attention items untouched this long leave the hero for the aging shelf |

### `agents`

| key | default | meaning |
| --- | --- | --- |
| `activityTtlHours` | `24` | activity-ticker events older than this are dropped — a dead provider's last session never renders as "live activity" |

### `notes`

The vault (Obsidian registry, or `~/revuto` fallback) is always scanned as root
`vault`. Extra note piles that live elsewhere are added here:

```jsonc
{ "notes": { "roots": [
  { "id": "codex", "label": "Codex", "path": "~/Documents/Codex" },
  { "id": "learning", "label": "Learning", "path": "~/learning" }
] } }
```

Each root is walked for `.md`/`.txt`, hidden dirs skipped, 20 dirs deep (agent-export
trees really do nest 13 down), and the newest 2000 notes per root are kept — a pile over
the budget loses its oldest notes, never today's. A root that hit either bound is marked
truncated in the Notes view instead of passing as complete. The Notes view searches and
filters across all roots, and `/api/notes/read|write` take a `root` alongside the
relative path.

### `notify`

Flag push notifications. The backend is any program that takes the message as its final
argument — see [examples/notify/](../examples/notify/).

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `minSeverity` | `'crit'` | minimum flag severity that pings (`info`/`warn`/`crit`) |
| `throttleMs` | `21600000` | one ping per flag id per window (6h) even if it flaps |
| `notifyClear` | `true` | send a one-line clear notice when a pinged flag resolves |
| `sendCmd` | `[]` | argv array; message appended as last arg. **Empty = push off** |

### `collectors`

| key | default | meaning |
| --- | --- | --- |
| `disabled` | `[]` | collector names to skip at registration. Agent sub-sources use `agents:<id>` |

Disable-able collector names: `github`, `agents`, `system`, `schedule`, `comms`, `subs`,
`notes`, `surreal`, `revuto`, `itch`, `backup`, `repos`, `shipped`, `exposure`, `distribution`, plus any plugin you add.
Agent sub-sources: `agents:revuto`, `agents:hermes`, `agents:itch`, `agents:any-mission`,
`agents:eigen`, `agents:claude`, `agents:grok`, `agents:codex`, `agents:training`.

### `watchedUnits` and `knownPorts`

`watchedUnits` is a list of systemd `--user` unit names surfaced in the system view.
`knownPorts` maps expected listening ports to labels; anything else listening beyond
loopback gets flagged, with a bind scope (`loopback` / `tailnet` / `wg` / `lan`).
The system view can teach a port into this map or stop an unexpected listener.
Both default to the author's machine — override them for yours.

### `paths`

Absolute paths to the files/dirs collectors read (hermes, eigen, claude, codex, obsidian,
restic, …). All default under `$HOME`. Override individually if your tools live elsewhere;
disable the collector entirely (above) if you don't run that tool at all.

### `surreal`, `revuto`, `itch`

Endpoints/paths for the bespoke plugin collectors. Irrelevant unless you run those tools —
disable them in `collectors.disabled` otherwise. `surreal.user`/`surreal.pass` default to
SurrealDB's stock local-dev credentials; real credentials belong here, never in the repo.

### `streampile`, `wiki`

The workspace adapters use `streampile.base` (default `http://127.0.0.1:8077`) and
`wiki.viewerPath` (default `~/projects/llm-wiki/tools/viewer.html`). They do not move those
systems into Atrium: Streampile still owns `/feed` and `/event`, and LLM Wiki still owns
generation of the viewer artifact.

### `exposure`

A personal counter for your open-source projects: the numbers GitHub, Hugging Face and
crates.io keep for you and let expire, written down once a day so a series exists.

| key | default | meaning |
| --- | --- | --- |
| `portfolio.repos` | `[]` | GitHub repos as `owner/name` (stars, 14-day views and clones, top referrers; traffic needs a `gh` token with repo access) |
| `portfolio.hfModels` | `[]` | Hugging Face model ids, or `org/*` for every card under an account (30-day downloads, likes) |
| `portfolio.crates` | `[]` | crates.io crate names (total and recent downloads) |
| `githubTokenEnvPath` | `''` | env file with `GITHUB_TOKEN` or `GH_TOKEN` for the traffic endpoints, read in place. Empty = `GITHUB_TOKEN`, then `gh auth token` |
| `snapshotDir` | `~/.local/share/atrium/exposure` | where the daily `<UTC-date>.json` files live |
| `command` | `[]` | legacy: argv of an external writer, run only when the portfolio is empty |

### `shipped`

The day's receipt: commits you authored across every repo under `paths.projectsDir` (and
`helper.nestedRepoRoots`) since the local day start, plus the PRs `gh` says you merged or
opened. Read-only, raises no flags.

| key | default | meaning |
| --- | --- | --- |
| `dayStartHour` | `4` | hour the day rolls over; a 01:30 commit still counts for the evening it belongs to. `0` is calendar midnight |
| `authors` | `[]` | `git --author` substrings, matched literally, any match counts. Empty = `git config user.email` and `user.name` |

### `poll`

Per-collector poll intervals in milliseconds. Tune if a collector is too chatty or too
sleepy for your machine. `shippedMs` (default `300000`) is the one to raise if the repo
walk shows up in your CPU graph.
