# Workspace composition

Atrium is the single browser surface at `http://127.0.0.1:5599`. The workspace adds
Streampile and LLM Wiki as first-class views without merging their domain logic into the
Atrium daemon.

## Ownership boundaries

| surface | UI owner | backend owner | Atrium adapter |
| --- | --- | --- | --- |
| Atrium views | `atrium/web` | `atrium/server` collectors and store | none |
| Streampile | `atrium/web/src/panels/StreampilePanel.tsx` | `streampile` FastAPI, recommender, and SurrealDB | allowlisted same-origin proxy under `/api/streampile/*` |
| LLM Wiki | Atrium page frame plus the generated viewer UI | `llm-wiki/tools/build-graph.mjs` and wiki files | serves the latest `viewer.html` at `/workspace/wiki` |

The adapters are intentionally narrow. Atrium does not rank content, write taste vectors,
parse wiki markdown, or rebuild the knowledge graph. Those operations stay in the system
that already owns them.

## Routes

- `#streampile` — editorial feed, theme filters, local search, reader, and feedback events.
- `#knowledge` — interactive knowledge canvas with its own search and domain filters.
- `/api/streampile/feed[?theme=N]` — forwards to Streampile `GET /feed`.
- `/api/streampile/event` — forwards the existing interaction contract.
- `/workspace/wiki` — latest generated LLM Wiki viewer, lightly themed for the shared shell.

## Running it

The normal Atrium build includes both workspace pages:

```sh
npm run build
systemctl --user restart atrium.service
```

Streampile remains a separate loopback service on port 8077. LLM Wiki remains file-backed;
run its existing graph build whenever the wiki changes:

```sh
cd ~/projects/llm-wiki
node tools/build-graph.mjs
```

Override either location in `~/.config/atrium/config.json`:

```jsonc
{
  "streampile": { "base": "http://127.0.0.1:8077" },
  "wiki": { "viewerPath": "/home/me/projects/llm-wiki/tools/viewer.html" }
}
```
