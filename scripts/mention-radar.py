#!/usr/bin/env python3
"""mention-radar — hourly watch for public mentions of avifenesh's projects.

Sources: Hacker News (Algolia API), GitHub issues/PRs search, dev.to tag API,
YouTube + Marginalia (personal blogs) + general web + Reddit via the local
SearXNG (127.0.0.1:8888 — direct reddit JSON is bot-blocked from this IP).
Dedups against a state file; first run is a silent
baseline (marks the current web as seen so you don't get a flood of old hits).
New hits are appended to hits.jsonl, mirrored into latest.md, and pinged via
notify-send when available.

No third-party deps. State lives in ~/.local/share/mention-radar/.
"""

import json
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path.home() / ".local" / "share" / "mention-radar"
STATE_FILE = STATE_DIR / "seen.json"
HITS_FILE = STATE_DIR / "hits.jsonl"
DIGEST_FILE = STATE_DIR / "latest.md"
UA = "mention-radar/1.0 (+https://github.com/avifenesh; local watch)"
HTTP_TIMEOUT = 20
FETCH_FAILURES: list[str] = []


def record_fetch_failure(label: str, error: object) -> None:
    detail = str(error).replace("\n", " ").strip()
    FETCH_FAILURES.append(f"{label}: {detail[:180]}")

# Distinctive terms only — generic names (atrium, eigen, floe, tools) would
# drown the radar in false positives; "avifenesh" catches those co-mentions.
# Each entry: (term, deny regex, anchor regex). deny drops entity collisions;
# anchor REQUIRES ecosystem co-mention for weak-identity terms (the crypto
# company "Revuto", the band/coaching/robotics "AGNIX" — none of them appear
# next to github/linter/PR-reviewer words).
TERMS: list[tuple[str, str | None, str | None]] = [
    ("agnix", r"robot|tracxn|private limited|seo agency|web development|agnix\.co\.in|agnix\.online|mht.?cet|pyq|\bjee\b|\bneet\b|exam|marathon|lecture",
     r"github|agent[-_]?sh|avifenesh|linter|\blsp\b|coding agent|claude\.md|\bmcp\b|agentic|ai coding"),
    ("revuto", r"crypto|cardano|\btoken|dapp|vedran|blockchain|web3|defi|\bnft|subscription",
     r"github|avifenesh|pull request|\bpr\b|reviewer|agent[-_]?sh|maintainer|repository"),
    ("memra", None,
     r"github|avifenesh|memory|\bllm\b|agent|\bmcp\b"),
    ("bw24", None,
     r"github|avifenesh|cuda|inference|sm_120|rust"),
    ("agentsys", None,
     r"github|agent[-_]?sh|avifenesh|slash|claude"),
    ("ferrings", None,
     r"github|avifenesh|io_uring|napi|node\.js|\bnode\b"),
    ("glide-mq", None, None),
    ("glidemq", None, None),
    ("computer-use-linux", None, None),
    ("agent-workspace-linux", None, None),
    ("valkey-skills", None, None),
    ("ocaml-valkey", None, None),
    ("agent-sh", None, None),
    ("avifenesh", None, None),
]

# The list of ACTIVE terms is runtime-editable from atrium (Signals view) via
# ~/.config/atrium/signals.json — watch.terms controls which terms run; the
# deny/anchor regexes above stay here as the per-term spam filters and apply
# whenever the term matches one. Unknown terms run unfiltered. Missing or
# malformed file = the builtin list above, unchanged behavior.
SIGNALS_WATCH_FILE = Path.home() / ".config" / "atrium" / "signals.json"


def effective_terms() -> list[tuple[str, str | None, str | None]]:
    try:
        watch = json.loads(SIGNALS_WATCH_FILE.read_text())["watch"]
        terms = watch["terms"]
        if not isinstance(terms, list) or not all(isinstance(t, str) for t in terms):
            raise ValueError("watch.terms must be a list of strings")
    except Exception:
        return TERMS
    known = {t[0]: t for t in TERMS}
    return [known.get(t.strip(), (t.strip(), None, None)) for t in terms if t.strip()]


TERMS = effective_terms()


def http_get_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:  # network hiccup → skip source this round
        record_fetch_failure(url[:120], e)
        print(f"warn: fetch failed {url[:80]}: {e}", file=sys.stderr)
        return None


def fetch_hn(term: str) -> list[dict]:
    q = urllib.parse.quote(term)
    data = http_get_json(f"https://hn.algolia.com/api/v1/search_by_date?query={q}&tags=(story,comment)&hitsPerPage=30")
    out = []
    for h in (data or {}).get("hits", []):
        title = h.get("title") or (h.get("comment_text") or "")[:140]
        url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('story_id') or h.get('objectID')}"
        out.append({"id": f"hn:{h['objectID']}", "source": "hn", "term": term,
                    "title": title.strip(), "url": url, "date": h.get("created_at", "")})
    return out


SEARXNG = "http://127.0.0.1:8888/search"


def searxng(query: str, source: str, term: str, skip_hosts: tuple = (),
            engines: str | None = None, time_range: str = "month") -> list[dict]:
    params = {"q": query, "format": "json", "time_range": time_range}
    if engines:
        params["engines"] = engines
        params.pop("time_range")  # media engines don't support it
    q = urllib.parse.urlencode(params)
    data = http_get_json(f"{SEARXNG}?{q}")
    out = []
    for r in (data or {}).get("results", []):
        url = r.get("url", "")
        if not url or any(h in url for h in skip_hosts):
            continue
        out.append({"id": f"{source}:{url}", "source": source, "term": term,
                    "title": (r.get("title") or "").strip(), "url": url,
                    "date": r.get("publishedDate") or ""})
    return out


def fetch_web(term: str) -> list[dict]:
    # general web/blogs; skip hosts already covered by dedicated sources
    return searxng(f'"{term}"', "web", term,
                   skip_hosts=("github.com", "news.ycombinator.com", "reddit.com",
                               "youtube.com", "youtu.be"),
                   time_range="year")


def fetch_reddit(term: str) -> list[dict]:
    return searxng(f'site:reddit.com "{term}"', "reddit", term)


def fetch_youtube(term: str) -> list[dict]:
    return searxng(f'"{term}"', "youtube", term, engines="youtube")


def fetch_blogs(term: str) -> list[dict]:
    # marginalia indexes the small/personal-blog web better than the big engines
    return searxng(f'"{term}"', "blog", term, engines="marginalia",
                   skip_hosts=("github.com",))


def fetch_devto(term: str) -> list[dict]:
    # dev.to full-text is not crawlable, but its tag API is public and precise
    tag = re.sub(r"[^a-z0-9]", "", term.lower())
    if not tag:
        return []
    data = http_get_json(f"https://dev.to/api/articles?per_page=30&tag={tag}")
    if not isinstance(data, list):
        return []
    return [{"id": f"devto:{a['id']}", "source": "dev.to", "term": term,
             "title": (a.get("title") or "").strip(), "url": a.get("url", ""),
             "date": a.get("published_at", "")} for a in data]


GH = shutil.which("gh") or "/usr/bin/gh"


def fetch_gh_code(term: str) -> list[dict]:
    """Awesome-list READMEs and vendored docs are file *content*, not issues —
    only GitHub code search (via the authed gh CLI) sees them. Requests
    text-match fragments and keeps them in hit['frag'] so the client-side
    word-boundary filter can verify: server substring matching alone fires on
    'ibw24', SHAs containing 'bw24', and similar junk."""
    try:
        p = subprocess.run(
            [GH, "api", "-H", "Accept: application/vnd.github.text-match+json",
             f"search/code?q={urllib.parse.quote(term)}+in:file+filename:README&per_page=30"],
            capture_output=True, text=True, timeout=30)
        if p.returncode != 0:
            record_fetch_failure(f"gh code search ({term})", p.stderr.strip()[:180])
            print(f"warn: gh code search failed for {term}: {p.stderr.strip()[:140]}", file=sys.stderr)
            return []
        data = json.loads(p.stdout or "{}")
    except Exception as e:
        record_fetch_failure(f"gh code search ({term})", e)
        print(f"warn: gh code search error for {term}: {e}", file=sys.stderr)
        return []
    time.sleep(7)  # code search is rate-limited to 10 req/min
    out = []
    for it in data.get("items", []):
        repo = (it.get("repository") or {}).get("full_name", "")
        if repo.startswith(("avifenesh/", "agent-sh/")):
            continue  # own repos are not "mentions"
        path = it.get("path", "")
        frag = " ".join(m.get("fragment", "") for m in it.get("text_matches", []))
        out.append({"id": f"ghcode:{repo}:{path}", "source": "gh-code", "term": term,
                    "title": f"{repo} — {path}", "url": it.get("html_url", ""),
                    "date": "", "frag": frag})
    return out


def fetch_reddit(term: str) -> list[dict]:
    return searxng(f'site:reddit.com "{term}"', "reddit", term)


def fetch_github(term: str) -> list[dict]:
    q = urllib.parse.quote(f'"{term}" in:title,body')
    data = http_get_json(f"https://api.github.com/search/issues?q={q}&sort=created&order=desc&per_page=20")
    out = []
    for it in (data or {}).get("items", []):
        # own repos are not "mentions" — revuto/atrium already track that traffic
        if "/avifenesh/" in it.get("repository_url", "") or "/agent-sh/" in it.get("repository_url", ""):
            continue
        kind = "pr" if "pull_request" in it else "issue"
        out.append({"id": f"gh:{it['id']}", "source": f"github-{kind}", "term": term,
                    "title": it.get("title", "").strip(), "url": it.get("html_url", ""),
                    "date": it.get("created_at", "")})
    return out


def matches_term(h: dict, term: str, deny: str | None = None,
                 anchor: str | None = None) -> bool:
    """Exact token match — Algolia/SearXNG/code-search fuzzy-match ('glidemq'
    vs 'glider', 'bw24' vs 'ibw24'), so filter client-side. Hyphens are
    optional ('glide-mq' == 'glidemq'). deny drops same-name different-entity
    hits; anchor requires ecosystem co-mention for weak-identity terms."""
    pat = r"\b" + re.sub(r"[-_]", r"[-_]?", re.escape(term)) + r"\b"
    text = f"{h['title']} {h['url']} {h.get('frag', '')}"
    if re.search(pat, text, re.IGNORECASE) is None:
        return False
    if deny and re.search(deny, text, re.IGNORECASE):
        return False
    if anchor and re.search(anchor, text, re.IGNORECASE) is None:
        return False
    return True


def load_seen() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_seen(seen: dict) -> None:
    # prune entries older than 45 days so the state file stays small
    cutoff = time.time() - 45 * 86400
    pruned = {k: v for k, v in seen.items() if v > cutoff}
    STATE_FILE.write_text(json.dumps(pruned, indent=0))


def notify(summary: str, body: str) -> None:
    try:
        subprocess.run(["notify-send", "-a", "mention-radar", summary, body],
                       check=False, timeout=5, capture_output=True)
    except Exception:
        pass


def main() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    seen = load_seen()
    baseline = not STATE_FILE.exists()

    hits: list[dict] = []
    deny_of = {t: d for t, d, _a in TERMS}
    anchor_of = {t: a for t, _d, a in TERMS}
    for term, _deny, _anchor in TERMS:
        for fetcher in (fetch_hn, fetch_github, fetch_web, fetch_reddit,
                        fetch_youtube, fetch_blogs, fetch_devto, fetch_gh_code):
            try:
                hits.extend(fetcher(term))
            except Exception as e:
                record_fetch_failure(f"{fetcher.__name__}({term})", e)
                print(f"warn: {fetcher.__name__}({term}) failed: {e}", file=sys.stderr)
            time.sleep(1)  # stay polite across terms x sources
    hits = [h for h in hits
            if matches_term(h, h["term"], deny_of.get(h["term"]), anchor_of.get(h["term"]))]
    for h in hits:
        h.pop("frag", None)  # fragments are filter input, not archive content

    degraded = bool(FETCH_FAILURES)
    if degraded:
        print(
            f"warn: {len(FETCH_FAILURES)} source fetches failed; results may be incomplete",
            file=sys.stderr,
        )
        # Never establish a silent baseline or archive a partial backfill.
        if baseline or "--backfill" in sys.argv:
            return 1

    now = time.time()

    # --backfill: archive everything currently visible into hits.jsonl (marked
    # backfill:true) so the dashboard shows the existing landscape; ids go into
    # seen.json too, so none of it ever re-fires as a "new" alert.
    if "--backfill" in sys.argv:
        existing: set = set()
        if HITS_FILE.exists():
            for line in HITS_FILE.read_text().splitlines():
                try:
                    existing.add(json.loads(line).get("id"))
                except Exception:
                    pass
        out: list[dict] = []
        run_seen_bf: set = set()
        for h in hits:
            if not h["id"] or h["id"] in existing or h["id"] in run_seen_bf:
                continue
            run_seen_bf.add(h["id"])
            h["backfill"] = True
            out.append(h)
        with HITS_FILE.open("a") as f:
            for h in out:
                f.write(json.dumps(h) + "\n")
        for h in hits:
            seen.setdefault(h["id"], now)
        save_seen(seen)
        print(f"backfill: archived {len(out)} mentions ({len(hits) - len(out)} already known)")
        return 0

    new_hits = []
    run_seen: set = set()
    for h in hits:
        if not h["id"] or h["id"] in seen or h["id"] in run_seen:
            continue
        run_seen.add(h["id"])
        new_hits.append(h)
    for h in new_hits:
        seen[h["id"]] = now
    # also record currently-visible old hits during baseline so they never re-fire
    if baseline:
        for h in hits:
            seen.setdefault(h["id"], now)
    save_seen(seen)

    if baseline:
        print(f"baseline: recorded {len(hits)} existing mentions across {len(TERMS)} terms; staying quiet")
        return 0

    if not new_hits:
        suffix = f" ({len(FETCH_FAILURES)} source fetches failed)" if degraded else ""
        print(f"no new mentions{suffix}")
        return 1 if degraded else 0

    with HITS_FILE.open("a") as f:
        for h in new_hits:
            f.write(json.dumps(h) + "\n")

    lines = [f"# mention-radar — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"]
    for h in new_hits:
        lines.append(f"- [{h['source']}] ({h['term']}) [{h['title'][:110]}]({h['url']})")
    DIGEST_FILE.write_text("\n".join(lines) + "\n")

    top = new_hits[0]
    notify(f"{len(new_hits)} new project mention{'s' if len(new_hits) > 1 else ''}",
           f"[{top['source']}] {top['title'][:120]}\n→ http://127.0.0.1:5599/#mentions")
    print(f"{len(new_hits)} new mentions:")
    for h in new_hits:
        print(f"  [{h['source']}] ({h['term']}) {h['title'][:100]} — {h['url']}")
    return 1 if degraded else 0


if __name__ == "__main__":
    sys.exit(main())
