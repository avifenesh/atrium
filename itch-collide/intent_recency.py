#!/usr/bin/env python3
"""intent_recency -- deterministic recency/cadence weighting for itch's DRAWN TO.

The problem this fixes (two faces of one bug):

  1. STANDING MANDATE != CHOSEN FOCUS. ~/hermes-papers/ and ~/learning/ are
     produced by a standing daily research instruction ("research LLM/inference
     topics"). The intent-miner used to treat each paper's topic as a fresh
     "I'm drawn to this" vote, so 24 mandate papers in 14 days drowned out
     genuine curiosity. A mandate is detected by CADENCE (near-daily, clustered)
     + SINGLE-CORPUS origin (only papers/learning, no transcript/project
     corroboration) and is collapsed to ONE low-weight entry.

  2. THE ECHO CHAIN. pick an itch idea -> work on it -> it floods transcripts as
     "current work" -> itch mines it as DRAWN TO -> proposes more of the same.
     Fix: recent work RESTS. A topic touched in the last ~2 weeks is heavily
     DOWN-WEIGHTED in the positive signal (NOT avoided, NOT excluded -- just
     stops boosting the orbit), then ramps back up. Genuine interest is what
     RETURNS across months, not what's hot this week.

This is deterministic selection logic, intentionally NOT left to LLM prose: the
itch-intent skill consumes this table as the authoritative recency spine, then
layers means-vs-ends reading on top.

Sources scanned (all carry real timestamps):
  ~/hermes-papers/research-YYYY-MM-DD-<slug>.md   (date from filename)
  ~/learning/guides/YYYY-MM-DD-<slug>.md           (date from filename)
  ~/learning/agent-knowledge/<slug>.md             (date from mtime)
  ~/projects/*/                                     (README mtime + dir name)

Output:
  stdout                              human-readable weighted table (markdown)
  ~/.config/itch/intent_recency.json  machine-readable {clusters:[...], curve}

Pure stdlib. Usage:
  python3 intent_recency.py            # scan + print + write json
  python3 intent_recency.py --json     # json only to stdout
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import pathlib
import re
import sys
from collections import defaultdict

HOME = pathlib.Path.home()
PAPERS = HOME / "hermes-papers"
GUIDES = HOME / "learning" / "guides"
KNOW = HOME / "learning" / "agent-knowledge"
PROJECTS = HOME / "projects"
OUT_JSON = HOME / ".config" / "itch" / "intent_recency.json"

TODAY = dt.date.today()

# tokens that are noise for topic clustering / labeling
STOP = frozenset("""
a an the of for to and or in on at by with from into vs versus is are be as
research late next new using via your you my our it its this that these those
2026 2025 md notable subject topic system systems work design state law stack
""".split())

# employer ecosystem -- never a DRAWN TO topic regardless of recency
OFF_LIMITS = ("valkey", "valkey-glide", "valkey-io")


# ----------------------------- weight curve -------------------------------- #
# The canonical curve. The skill references THESE numbers for transcripts too,
# so the whole system applies one consistent recency policy.
REST_DAYS = 14          # 0..REST_DAYS  -> resting (heavy down-weight)
RAMP_DAYS = 28          # REST..RAMP    -> ramping back
MATURE_DAYS = 90        # RAMP..MATURE  -> linear climb to full weight
REST_W = 0.10           # weight while resting (down-weighted, NOT zero/avoided)
RAMP_W = 0.40           # weight at the start of ramp
MANDATE_CAP = 0.20      # max weight for a detected standing mandate
MANDATE_CADENCE = 0.40  # items/day threshold (~>=1 every 2.5 days) = mandate
RETURN_SPAN = 60        # a cluster spanning > this many days that recurs ...
RETURN_WEEKS = 3        # ... across >= this many distinct weeks = real interest


def recency_weight(last_seen_days: int) -> float:
    if last_seen_days <= REST_DAYS:
        return REST_W
    if last_seen_days <= RAMP_DAYS:
        return RAMP_W
    if last_seen_days >= MATURE_DAYS:
        return 1.0
    # linear climb RAMP_W -> 1.0 across (RAMP_DAYS, MATURE_DAYS)
    frac = (last_seen_days - RAMP_DAYS) / (MATURE_DAYS - RAMP_DAYS)
    return round(RAMP_W + (1.0 - RAMP_W) * frac, 3)


# --------------------------- source scanning ------------------------------- #
def _date_from_name(name: str) -> dt.date | None:
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", name)
    if not m:
        return None
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def _slug_tokens(slug: str) -> list[str]:
    slug = re.sub(r"\.md$", "", slug)
    slug = re.sub(r"^research-", "", slug)
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", slug)
    toks = re.split(r"[-_\s]+", slug.lower())
    return [t for t in toks if t and t not in STOP and len(t) > 2]


def _collect() -> list[dict]:
    """Return per-item records: {topic_tokens, date, source, label}."""
    items: list[dict] = []

    # hermes-papers: date + slug in filename
    for p in glob.glob(str(PAPERS / "*.md")):
        name = os.path.basename(p)
        d = _date_from_name(name) or dt.date.fromtimestamp(os.path.getmtime(p))
        toks = _slug_tokens(name)
        if toks:
            items.append({"toks": toks, "date": d, "source": "papers", "label": name})

    # learning/guides: date + slug in filename
    for p in glob.glob(str(GUIDES / "*.md")):
        name = os.path.basename(p)
        d = _date_from_name(name) or dt.date.fromtimestamp(os.path.getmtime(p))
        toks = _slug_tokens(name)
        if toks:
            items.append({"toks": toks, "date": d, "source": "learning", "label": name})

    # learning/agent-knowledge: slug only, date from mtime
    for p in glob.glob(str(KNOW / "*.md")):
        name = os.path.basename(p)
        d = dt.date.fromtimestamp(os.path.getmtime(p))
        toks = _slug_tokens(name)
        if toks:
            items.append({"toks": toks, "date": d, "source": "learning", "label": name})

    # projects: dir name, date from README mtime (recently active only)
    for d_ in glob.glob(str(PROJECTS / "*")):
        if not os.path.isdir(d_):
            continue
        readme = os.path.join(d_, "README.md")
        mtime_src = readme if os.path.exists(readme) else d_
        d = dt.date.fromtimestamp(os.path.getmtime(mtime_src))
        if (TODAY - d).days > 180:
            continue
        toks = _slug_tokens(os.path.basename(d_))
        if toks:
            items.append({"toks": toks, "date": d, "source": "projects",
                          "label": os.path.basename(d_)})
    return items


# ----------------------------- clustering ---------------------------------- #
def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# Coarse domain taxonomy. A topic's tokens are matched against these keyword
# sets; first match wins (order = priority). This is what collapses a standing
# research STREAM into one cluster. Tuned to the builder's actual streams; add
# rows as new standing mandates emerge. Keep specific domains ABOVE generic ones.
DOMAINS: list[tuple[str, frozenset]] = [
    ("inference-serving", frozenset("""
        inference kv cache caching serving disaggregated decode decoding
        speculative spec attention paged vllm llama llama.cpp lmcache sglang
        throughput batching prefill moe wide ep expert tcgen05 tmem blackwell
        kernel cuda tile gpu serving-stack mtp eagle3 specforge tabbyapi exl3
        quantization quant gguf gptq awq nvfp4 fp4 fp8 squeeze""".split())),
    ("retrieval", frozenset("""
        retrieval colbert splade bm25 late-interaction interaction rerank
        embedding rag graphrag index recall ndcg""".split())),
    ("robotics-control", frozenset("""
        robotics kinematics jacobians jacobian dynamics rigid body inertial
        kinematic mpc ilqr ddp pid predictive control ekf estimation filter
        kalman imu measurement motion planning chomp manipulation grasping
        contact factor graph drake isaac mujoco trajectory derivation forward
        inverse""".split())),
    ("agent-systems", frozenset("""
        agent agents agentic harness harnesses orchestrator worker mas
        multi-agent context horizon long-horizon memory reward swe coding
        autonomous""".split())),
    ("distributed-systems", frozenset("""
        replication consensus raft paxos rcu read-copy-update distributed
        coherence consistency""".split())),
    ("ml-modal", frozenset("""
        diffusion imitation modal omni multimodal temporal alignment vision
        domain-randomization""".split())),
]


def _domain(toks: list[str]) -> str | None:
    ts = set(toks)
    for name, kws in DOMAINS:
        if ts & kws:
            return name
    return None


def _cluster(items: list[dict], thresh: float = 0.34) -> list[list[dict]]:
    """Cluster items so a standing research STREAM (e.g. all
    inference/kv-cache/serving papers) groups into ONE cluster, not dozens of
    singletons. Two-tier:

      1. Coarse DOMAIN tag from a keyword map (deterministic, no deps). Items
         sharing a domain are pre-grouped -- this is what lets the mandate
         detector see 'inference x24' as one cluster instead of 24 ones.
      2. Within an 'unmapped' bucket, fall back to slug-token Jaccard
         single-link so novel topics still cluster by shared words.

    Embeddings would be marginally better but bge-small isn't worth a torch
    import on this hot path; the domain map captures the streams that matter
    (they're the recurring ones, by definition)."""
    items = sorted(items, key=lambda x: x["label"])
    by_domain: dict[str, list[dict]] = defaultdict(list)
    unmapped: list[dict] = []
    for it in items:
        dom = _domain(it["toks"])
        if dom:
            by_domain[dom].append(it)
        else:
            unmapped.append(it)

    clusters: list[list[dict]] = [v for v in by_domain.values()]

    # Jaccard single-link for the leftovers
    sets: list[set] = []
    jac: list[list[dict]] = []
    for it in unmapped:
        ts = set(it["toks"])
        best, bi = 0.0, -1
        for i, cs in enumerate(sets):
            j = _jaccard(ts, cs)
            if j > best:
                best, bi = j, i
        if best >= thresh:
            jac[bi].append(it)
            sets[bi] |= ts
        else:
            jac.append([it])
            sets.append(set(ts))
    clusters.extend(jac)
    return clusters


def _label(cluster: list[dict]) -> str:
    # If this is a domain-tagged stream, the domain name IS the label (all
    # items share one domain). Otherwise derive from most-common slug tokens.
    doms = {_domain(it["toks"]) for it in cluster}
    doms.discard(None)
    if len(doms) == 1 and len(cluster) > 1:
        only = next(iter(doms))
        if only:
            return only
    cnt: dict[str, int] = defaultdict(int)
    for it in cluster:
        for t in set(it["toks"]):
            cnt[t] += 1
    top = sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return " ".join(t for t, _ in top)


# ------------------------------- scoring ----------------------------------- #
def analyze() -> dict:
    items = _collect()
    clusters = _cluster(items)
    rows = []
    for cl in clusters:
        dates = sorted(it["date"] for it in cl)
        first, last = dates[0], dates[-1]
        span = (last - first).days
        last_seen = (TODAY - last).days
        n = len(cl)
        cadence = n / max(span, 1)
        sources = sorted({it["source"] for it in cl})
        weeks = {d.isocalendar()[:2] for d in dates}
        label = _label(cl)

        # off-limits = the TOPIC itself is employer ecosystem. Match the cluster
        # label only -- NOT individual items, so one 'valkey-llm-caching' paper
        # can't poison the whole 'inference-serving' stream (inference is a
        # genuine interest; only valkey-as-a-topic is off-limits).
        off = any(o in label for o in OFF_LIMITS)

        # base recency weight
        w = recency_weight(last_seen)

        # genuine returning interest: long span + many distinct weeks -> full
        returning = span >= RETURN_SPAN and len(weeks) >= RETURN_WEEKS
        if returning:
            w = 1.0

        # standing mandate: near-daily cadence, only papers/learning, NOT a
        # transcript/project-corroborated return -> collapse + cap.
        mandate = (cadence >= MANDATE_CADENCE and n >= 4
                   and set(sources) <= {"papers", "learning"} and not returning)
        if mandate:
            w = min(w, MANDATE_CAP)

        if off:
            w = 0.0

        cls = ("off-limits" if off else
               "mandate" if mandate else
               "returning-interest" if returning else
               "resting" if last_seen <= REST_DAYS else
               "ramping" if last_seen <= RAMP_DAYS else
               "mature")

        rows.append({
            "topic": label,
            "weight": round(w, 3),
            "class": cls,
            "n_items": n,
            "sources": sources,
            "first_seen": first.isoformat(),
            "last_seen": last.isoformat(),
            "last_seen_days": last_seen,
            "span_days": span,
            "distinct_weeks": len(weeks),
            "cadence_per_day": round(cadence, 2),
            "examples": [it["label"] for it in cl][:4],
        })
    rows.sort(key=lambda r: (-r["weight"], -r["n_items"]))
    return {
        "generated": TODAY.isoformat(),
        "curve": {
            "rest_days": REST_DAYS, "ramp_days": RAMP_DAYS, "mature_days": MATURE_DAYS,
            "rest_weight": REST_W, "ramp_weight": RAMP_W, "mandate_cap": MANDATE_CAP,
            "mandate_cadence_per_day": MANDATE_CADENCE,
            "return_span_days": RETURN_SPAN, "return_weeks": RETURN_WEEKS,
        },
        "clusters": rows,
    }


def _print_table(data: dict) -> None:
    print(f"# itch intent recency  ({data['generated']})\n")
    c = data["curve"]
    print(f"curve: rest≤{c['rest_days']}d→{c['rest_weight']}  "
          f"ramp≤{c['ramp_days']}d→{c['ramp_weight']}  "
          f"mature≥{c['mature_days']}d→1.0  "
          f"mandate cap {c['mandate_cap']} (cadence≥{c['mandate_cadence_per_day']}/d)  "
          f"returning≥{c['return_span_days']}d&{c['return_weeks']}wk→1.0\n")
    print(f"{'w':>5}  {'class':<18} {'n':>3} {'last':>5} {'cad':>5}  "
          f"{'sources':<22} topic")
    print("-" * 92)
    for r in data["clusters"]:
        print(f"{r['weight']:>5.2f}  {r['class']:<18} {r['n_items']:>3} "
              f"{r['last_seen_days']:>4}d {r['cadence_per_day']:>5.2f}  "
              f"{','.join(r['sources']):<22} {r['topic']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="json to stdout only")
    A = ap.parse_args()
    data = analyze()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, indent=1))
    if A.json:
        print(json.dumps(data, indent=1))
    else:
        _print_table(data)
        print(f"\nwrote {OUT_JSON}", file=sys.stderr)


if __name__ == "__main__":
    main()
