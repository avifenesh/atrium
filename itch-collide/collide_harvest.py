#!/usr/bin/env python3
"""collide_harvest -- gather a WIDE corpus of REAL domains/concepts to use as
collision seeds for itch. Every seed is a real published field/topic/tag, never
fabricated: that is what keeps collide "chaos, not noise".

Sources (each independent -- one failing never blocks the others):
  arxiv     arXiv subject taxonomy (~176 fields)          GitHub raw, no key
  openalex  OpenAlex topics (~4.5k research topics)       api.openalex.org, CC0, polite pool
  hf        Hugging Face: dataset task-category tags +    huggingface.co/api, no key
            trending model pipeline/library tags
  gh        GitHub topics (curated featured topics)       api.github.com, gh CLI auth
  wiki      Wikipedia Vital Articles L3 (~1000)           en.wikipedia.org API

Output: append-only ~/.config/itch/collide/manifest.jsonl, one record/line:
  {"title": str, "embed_text": str, "source": str}
Re-running is idempotent per source: existing (source,title) pairs are skipped,
so you can add a source later and only the new rows append. The background
embedder (collide_embed.py) then picks up whatever rows lack vectors.

Pure stdlib (urllib/json/re/pathlib). Usage:
  python3 collide_harvest.py                 # all sources
  python3 collide_harvest.py arxiv hf        # only these
  python3 collide_harvest.py --list          # show source counts in manifest
"""
from __future__ import annotations

import gzip
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CDIR = pathlib.Path(os.path.expanduser("~/.config/itch/collide"))
RAW = CDIR / "raw"
MANIFEST = CDIR / "manifest.jsonl"
UA = "itch-collide/1.0 (personal idea-finder; +https://github.com/avifenesh)"
# arXiv junk that is not a real domain
STOP = frozenset({"Invalid Category", "Other", "General", "Miscellaneous", ""})


def _get(url: str, timeout: int = 30, headers: dict | None = None) -> bytes:
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    delay = 2.0
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 4:
                time.sleep(delay); delay *= 2; continue
            raise
    raise RuntimeError("retries exhausted: " + url)


def _load_existing() -> set[tuple[str, str]]:
    """(source,title) pairs already in the manifest -- for idempotent re-runs."""
    seen: set[tuple[str, str]] = set()
    if MANIFEST.exists():
        for line in MANIFEST.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                seen.add((r.get("source", ""), r.get("title", "")))
            except json.JSONDecodeError:
                continue
    return seen


def _append(rows: list[dict]) -> int:
    """Append rows (deduped vs manifest) to manifest.jsonl. Returns count added."""
    seen = _load_existing()
    added = 0
    with MANIFEST.open("a", encoding="utf-8") as f:
        for r in rows:
            title = (r.get("title") or "").strip()
            src = r.get("source", "")
            if not title or title in STOP or (src, title) in seen:
                continue
            seen.add((src, title))
            f.write(json.dumps({"title": title,
                                "embed_text": (r.get("embed_text") or title).strip(),
                                "source": src}) + "\n")
            added += 1
    return added


# --------------------------------------------------------------------------- #
# sources
# --------------------------------------------------------------------------- #
def harvest_arxiv() -> list[dict]:
    url = "https://raw.githubusercontent.com/arXiv/arxiv-base/develop/arxiv/taxonomy/definitions.py"
    src = _get(url).decode("utf-8", "replace")
    (RAW / "arxiv_definitions.py").write_text(src, encoding="utf-8")
    names = re.findall(r'full_name=["\']([^"\']+)["\']', src)
    return [{"title": n.strip(), "embed_text": n.strip(), "source": "arxiv"} for n in names]


def harvest_openalex(limit: int = 5000) -> list[dict]:
    """OpenAlex topics: ~4.5k research topics, each with a description.
    Cursor-paged, CC0. embed_text = 'Topic — description' for richer vectors."""
    rows: list[dict] = []
    cursor = "*"
    base = "https://api.openalex.org/topics"
    while len(rows) < limit:
        qs = urllib.parse.urlencode({
            "per-page": 200, "cursor": cursor,
            "select": "display_name,description,keywords",
            "mailto": "itch-collide@localhost",
        })
        data = json.loads(_get(f"{base}?{qs}"))
        results = data.get("results", [])
        if not results:
            break
        for t in results:
            name = (t.get("display_name") or "").strip()
            if not name:
                continue
            desc = (t.get("description") or "").strip()
            # OpenAlex keywords are plain strings, not objects
            kws = ", ".join(str(k) for k in (t.get("keywords") or [])[:5])
            et = name + (f" — {desc}" if desc else "") + (f" (keywords: {kws})" if kws else "")
            rows.append({"title": name, "embed_text": et, "source": "openalex"})
        cursor = data.get("meta", {}).get("next_cursor")
        if not cursor:
            break
        time.sleep(0.2)
    return rows


def harvest_hf() -> list[dict]:
    """Hugging Face: dataset task-category tags + trending models' pipeline tags.
    Real ML-domain vocabulary, no key needed."""
    rows: list[dict] = []
    # dataset task categories via the tag-counts-ish listing: sample many datasets,
    # collect their task_categories tags.
    try:
        data = json.loads(_get("https://huggingface.co/api/datasets?limit=1000&full=false"))
        tags: set[str] = set()
        for d in data:
            for t in d.get("tags", []) or []:
                if isinstance(t, str) and t.startswith("task_categories:"):
                    tags.add(t.split(":", 1)[1].replace("-", " ").strip())
        for t in sorted(tags):
            rows.append({"title": t, "embed_text": f"{t} (machine learning task)", "source": "hf"})
    except Exception as e:
        print(f"  hf datasets: {e}", file=sys.stderr)
    # popular models -> pipeline_tag (modality/task vocabulary)
    try:
        data = json.loads(_get("https://huggingface.co/api/models?limit=1000&sort=downloads&full=false"))
        pt: set[str] = set()
        for m in data:
            p = m.get("pipeline_tag")
            if p:
                pt.add(p.replace("-", " ").strip())
        for t in sorted(pt):
            rows.append({"title": t, "embed_text": f"{t} (ML pipeline / modality)", "source": "hf"})
    except Exception as e:
        print(f"  hf models: {e}", file=sys.stderr)
    return rows


def harvest_gh() -> list[dict]:
    """GitHub curated topics (github/explore repo). Each topic has an index.md
    with a real description — we use that as embed_text so a topic like
    'board-game' embeds as its actual domain ('a tabletop game with pieces on a
    board…'), far from systems work, instead of the bare 2-word tag which the
    embedder can't place. Bare-name fallback if a description fetch fails."""
    rows: list[dict] = []
    try:
        out = subprocess.run(
            ["gh", "api", "repos/github/explore/contents/topics", "--jq", ".[].name"],
            capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            print(f"  gh: list failed: {out.stderr[:120]}", file=sys.stderr)
            return rows
        names = [n.strip() for n in out.stdout.split() if n.strip()]
        for slug in names:
            disp = slug.replace("-", " ")
            embed = f"{disp} (software/technology topic)"  # fallback
            try:
                # index.md frontmatter has short_description; body has a real definition
                r = subprocess.run(
                    ["gh", "api", f"repos/github/explore/contents/topics/{slug}/index.md",
                     "--jq", ".content"],
                    capture_output=True, text=True, timeout=20)
                if r.returncode == 0 and r.stdout.strip():
                    import base64
                    md = base64.b64decode(r.stdout.strip()).decode("utf-8", "replace")
                    short = ""
                    ms = re.search(r"short_description:\s*(.+)", md)
                    if ms:
                        short = ms.group(1).strip()
                    # body = everything after the closing frontmatter '---'
                    body = ""
                    parts = md.split("---", 2)
                    if len(parts) == 3:
                        body = " ".join(parts[2].split())[:300]
                    desc = (short + ". " + body).strip(". ") if (short or body) else ""
                    if desc:
                        embed = f"{disp}: {desc}"
            except Exception:
                # Keep the bare topic-name fallback when an individual topic
                # description cannot be fetched or decoded.
                pass
            rows.append({"title": disp, "embed_text": embed, "source": "gh"})
    except Exception as e:
        print(f"  gh: {e}", file=sys.stderr)
    return rows


def harvest_wiki(max_articles: int = 6000) -> list[dict]:
    """Wikipedia breadth — the non-academic surprise source ('marry ancient and
    kv cache'). The old VA/Level/3 subpage-wikitext crawl broke: those subpages
    are now redirects / heavy transclusions with no raw [[wikilinks]].

    Robust path: the tracking category 'All Wikipedia vital articles' tags every
    vital article via its TALK page (ns1). We page through it (cmcontinue),
    strip the 'Talk:' prefix to recover the article title, then batch-fetch each
    article's short description (prop=description) for a richer embed_text.
    ~10k broadly-important topics across all human knowledge."""
    rows: list[dict] = []
    titles: list[str] = []
    cmcontinue = None
    api = "https://en.wikipedia.org/w/api.php"
    while len(titles) < max_articles:
        params = {
            "action": "query", "list": "categorymembers",
            "cmtitle": "Category:All Wikipedia vital articles",
            "cmnamespace": "1", "cmlimit": "500",
            "format": "json", "formatversion": "2",
        }
        if cmcontinue:
            params["cmcontinue"] = cmcontinue
        try:
            data = json.loads(_get(f"{api}?{urllib.parse.urlencode(params)}"))
        except Exception as e:
            print(f"  wiki categorymembers: {e}", file=sys.stderr)
            break
        for m in data.get("query", {}).get("categorymembers", []):
            t = m.get("title", "")
            if t.startswith("Talk:"):
                t = t[len("Talk:"):]
            t = t.strip()
            # skip disambiguation/list/meta-ish noise
            if not t or t in STOP or t.startswith(("List of", "Index of", "Outline of")):
                continue
            titles.append(t)
        cmcontinue = data.get("continue", {}).get("cmcontinue")
        if not cmcontinue:
            break
        time.sleep(0.2)

    # enrich with short descriptions (prop=description), 50 titles/request
    desc: dict[str, str] = {}
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        params = {
            "action": "query", "prop": "description",
            "titles": "|".join(batch), "format": "json", "formatversion": "2",
        }
        try:
            data = json.loads(_get(f"{api}?{urllib.parse.urlencode(params)}"))
            for p in data.get("query", {}).get("pages", []):
                dsc = (p.get("description") or "").strip()
                if p.get("title") and dsc:
                    desc[p["title"]] = dsc
        except Exception:
            pass  # descriptions are a bonus; bare title still embeds usably
        time.sleep(0.15)

    for t in titles:
        d = desc.get(t, "")
        et = f"{t}: {d}" if d else f"{t} (notable subject)"
        rows.append({"title": t, "embed_text": et, "source": "wiki"})
    return rows


def harvest_crates(pages: int = 20, per_page: int = 100) -> list[dict]:
    """crates.io — most-downloaded Rust crates. Real systems/tooling vocabulary
    with one-line descriptions. embed_text = 'name: description' so a crate like
    'tokio' embeds as its domain ('async runtime…'), not the bare token.
    Keyless; crates.io requires a descriptive User-Agent."""
    rows: list[dict] = []
    seen: set[str] = set()
    hdr = {"User-Agent": UA}
    for page in range(1, pages + 1):
        qs = urllib.parse.urlencode({"sort": "downloads", "per_page": per_page, "page": page})
        try:
            data = json.loads(_get(f"https://crates.io/api/v1/crates?{qs}", headers=hdr))
        except Exception as e:
            print(f"  crates p{page}: {e}", file=sys.stderr)
            break
        crates = data.get("crates", [])
        if not crates:
            break
        for c in crates:
            name = (c.get("name") or "").strip()
            desc = (c.get("description") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            et = f"{name}: {desc}" if desc else f"{name} (Rust crate)"
            rows.append({"title": name, "embed_text": et, "source": "crates"})
        time.sleep(0.3)  # polite
    return rows


def harvest_npm(per_term: int = 100) -> list[dict]:
    """npm registry — packages across many domains via keyword queries. Real JS
    ecosystem vocabulary with descriptions. Keyless registry search endpoint."""
    rows: list[dict] = []
    seen: set[str] = set()
    # spread queries across disjoint domains so it's not all 'cli/util'
    terms = ["cli", "framework", "game", "audio", "graphics", "machine-learning",
             "crypto", "database", "robotics", "visualization", "parser", "physics",
             "music", "math", "geo", "blockchain", "compiler", "stream"]
    for term in terms:
        qs = urllib.parse.urlencode({"text": f"keywords:{term}", "size": per_term})
        try:
            data = json.loads(_get(f"https://registry.npmjs.org/-/v1/search?{qs}"))
        except Exception as e:
            print(f"  npm {term}: {e}", file=sys.stderr)
            continue
        for o in data.get("objects", []):
            p = o.get("package", {})
            name = (p.get("name") or "").strip()
            desc = (p.get("description") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            et = f"{name}: {desc}" if desc else f"{name} (npm package)"
            rows.append({"title": name, "embed_text": et, "source": "npm"})
        time.sleep(0.2)
    return rows


def harvest_stackoverflow(pages: int = 10, pagesize: int = 100) -> list[dict]:
    """StackOverflow popular tags + their wiki excerpts. Real developer-domain
    vocabulary. Keyless (capped at 300 req/day/IP); responses are gzipped."""
    rows: list[dict] = []
    seen: set[str] = set()
    site = "stackoverflow"
    # 1) collect popular tag names
    tag_names: list[str] = []
    for page in range(1, pages + 1):
        qs = urllib.parse.urlencode({"order": "desc", "sort": "popular", "site": site,
                                     "pagesize": pagesize, "page": page})
        try:
            raw = _get(f"https://api.stackexchange.com/2.3/tags?{qs}",
                       headers={"Accept-Encoding": "gzip"})
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass
            data = json.loads(raw)
        except Exception as e:
            print(f"  so tags p{page}: {e}", file=sys.stderr)
            break
        for t in data.get("items", []):
            n = (t.get("name") or "").strip()
            if n and n not in seen:
                seen.add(n)
                tag_names.append(n)
        if not data.get("has_more"):
            break
        time.sleep(0.3)
    # 2) enrich with tag wiki excerpts in batches (richer embed_text)
    excerpt: dict[str, str] = {}
    for i in range(0, len(tag_names), 20):
        batch = tag_names[i:i + 20]
        key = ";".join(urllib.parse.quote(b, safe="") for b in batch)
        qs = urllib.parse.urlencode({"site": site})
        try:
            raw = _get(f"https://api.stackexchange.com/2.3/tags/{key}/wikis?{qs}",
                       headers={"Accept-Encoding": "gzip"})
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass
            data = json.loads(raw)
            for w in data.get("items", []):
                ex = (w.get("excerpt") or "").strip()
                if w.get("tag_name") and ex:
                    excerpt[w["tag_name"]] = ex[:240]
        except Exception:
            pass  # excerpts are a bonus; bare tag still useful
        time.sleep(0.3)
    for n in tag_names:
        disp = n.replace("-", " ")
        ex = excerpt.get(n, "")
        et = f"{disp}: {ex}" if ex else f"{disp} (programming topic)"
        rows.append({"title": disp, "embed_text": et, "source": "stackoverflow"})
    return rows


def harvest_gh_repos() -> list[dict]:
    """Interesting GitHub REPOS (not just topic tags): high-star repos across a
    spread of domains, each with its real description. This is the 'find more
    repos with interesting ideas' source — concrete projects, not abstract tags.
    Uses gh CLI search (authed)."""
    rows: list[dict] = []
    seen: set[str] = set()
    # disjoint domains so the repo set spans far beyond ML/systems
    queries = [
        "topic:simulation", "topic:game-engine", "topic:music", "topic:visualization",
        "topic:robotics", "topic:bioinformatics", "topic:graphics", "topic:compiler",
        "topic:physics", "topic:art", "topic:hardware", "topic:astronomy",
        "topic:finance", "topic:nlp", "topic:cryptography", "topic:database",
        "topic:operating-system", "topic:emulator", "topic:geospatial", "topic:audio",
        "topic:machine-learning", "topic:security", "topic:math", "topic:embedded",
    ]
    for q in queries:
        try:
            out = subprocess.run(
                ["gh", "search", "repos", q, "--sort", "stars", "--limit", "30",
                 "--json", "fullName,description"],
                capture_output=True, text=True, timeout=40)
            if out.returncode != 0:
                print(f"  gh_repos {q}: {out.stderr[:100]}", file=sys.stderr)
                continue
            for r in json.loads(out.stdout or "[]"):
                full = (r.get("fullName") or "").strip()
                desc = (r.get("description") or "").strip()
                if not full or full in seen or not desc:
                    continue
                seen.add(full)
                name = full.split("/", 1)[-1].replace("-", " ")
                rows.append({"title": name, "embed_text": f"{name}: {desc}",
                             "source": "gh_repos"})
        except Exception as e:
            print(f"  gh_repos {q}: {e}", file=sys.stderr)
        time.sleep(0.5)
    return rows


SOURCES = (
    ("arxiv", harvest_arxiv),
    ("openalex", harvest_openalex),
    ("hf", harvest_hf),
    ("gh", harvest_gh),
    ("wiki", harvest_wiki),
    ("crates", harvest_crates),
    ("npm", harvest_npm),
    ("stackoverflow", harvest_stackoverflow),
    ("gh_repos", harvest_gh_repos),
)


def _list() -> None:
    if not MANIFEST.exists():
        print("manifest empty (no harvest yet)"); return
    by: dict[str, int] = {}
    for line in MANIFEST.read_text().splitlines():
        if line.strip():
            try:
                source = json.loads(line).get("source", "?")
            except json.JSONDecodeError:
                continue
            by[source] = by.get(source, 0) + 1
    total = sum(by.values())
    for s, n in sorted(by.items()):
        print(f"  {s:10s} {n}")
    print(f"  {'TOTAL':10s} {total}")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--list" in sys.argv:
        _list(); return
    RAW.mkdir(parents=True, exist_ok=True)
    source_map = dict(SOURCES)
    which = args or [name for name, _fn in SOURCES]
    grand = 0
    for name in which:
        fn = source_map.get(name)
        if not fn:
            print(f"unknown source: {name} (have: {', '.join(source_map)})", file=sys.stderr)
            continue
        t0 = time.time()
        try:
            rows = fn()
            added = _append(rows)
            grand += added
            print(f"{name:10s} fetched {len(rows):5d}  added {added:5d}  ({time.time()-t0:.1f}s)")
        except Exception as e:
            print(f"{name:10s} FAILED: {e}", file=sys.stderr)
    print(f"--- harvest done: +{grand} new rows -> {MANIFEST}")
    print("    next: run collide_embed.py (sxc venv) to vectorize new rows")


if __name__ == "__main__":
    main()
