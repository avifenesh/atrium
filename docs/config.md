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

Each root is walked for `.md`/`.txt` (hidden dirs skipped, 2000 files per root);
the Notes view searches and filters across all of them, and `/api/notes/read|write`
take a `root` alongside the relative path.

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
`notes`, `surreal`, `revuto`, `itch`, `cloud`, `backup`, `repos`, plus any plugin you add.
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

### `poll`

Per-collector poll intervals in milliseconds. Tune if a collector is too chatty or too
sleepy for your machine.
