#!/usr/bin/env python3
"""collide_sample -- pick k REAL collision seeds at a tuned semantic distance
from the builder's interests, for a given chaos TEMPERATURE.

This is the entropy injector that makes itch produce "chaos, not noise":
  - seeds are REAL (harvested taxonomy: arXiv/OpenAlex/GitHub/HF), never fabricated
  - temperature in [0,1] = how FAR from the builder's interests to sample
      ~0.0  near a stated interest      (familiar, easy bridge)
      ~1.0  far from all interests       (wild, sparse bridge)
  - WITHIN the temperature band the pick is RANDOM -> different real seeds each run

Math (folds in the design-workflow fixes):
  1. similarity = MAX over interest bullets (near = near ANY interest, not the
     bland mean centroid -- avoids the bimodal-interest void).
  2. RANK-TRANSFORM cosine distance -> uniform [0,1]. bge-small space is
     anisotropic (distances cluster); ranking makes the temperature slider
     linear and meaningful regardless of the raw distance distribution.
  3. N-ADAPTIVE band width so a small corpus never starves at the extremes.
  4. random pick of k within the band; a single near-dup redraw guard (cheap MMR).

Runs in the sxc venv (torch + sentence-transformers). Reads a PARTIAL vector
index safely (only chunks up to the checkpoint), so it works while the
background embedder is still appending.

stdout = JSON list of seed titles (what itch parses).
Also writes last-sample.json (audit: distances, ranks, per-bullet cos).

Usage (sxc venv):
  .venv/bin/python collide_sample.py --temp 0.5 --k 2
  .venv/bin/python collide_sample.py --temp 0.5 --k 10 --debug   # calibration
"""
from __future__ import annotations
import argparse, json, os, pathlib, random, re, sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np  # noqa: E402

CDIR = pathlib.Path(os.path.expanduser("~/.config/itch/collide"))
VECS = CDIR / "vecs"
TITLES = CDIR / "titles.json"
CKPT = CDIR / "embedded.json"
INTERESTS = pathlib.Path(os.path.expanduser("~/.config/itch/interests.md"))
BGE_ROOT = pathlib.Path(os.path.expanduser(
    "~/ai-ml/hf-models/models--BAAI--bge-small-en-v1.5/snapshots"))


def _bge_path() -> str:
    if BGE_ROOT.is_dir():
        snaps = sorted(p for p in BGE_ROOT.iterdir() if p.is_dir())
        if snaps:
            return str(snaps[-1])
    return "BAAI/bge-small-en-v1.5"


def _device() -> str:
    if os.environ.get("COLLIDE_DEVICE"):
        return os.environ["COLLIDE_DEVICE"]
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _load_partial_index() -> tuple[np.ndarray, list[dict]]:
    """Load embedded vectors + aligned titles, capped at the checkpoint count so
    a concurrently-running embedder's half-written tail is never read."""
    done = 0
    if CKPT.exists():
        try:
            done = int(json.loads(CKPT.read_text()).get("embedded", 0))
        except Exception:
            done = 0
    chunks = sorted(VECS.glob("chunk-*.npy"))
    if not chunks:
        raise SystemExit("no embedded vectors yet -- run collide_embed.py first")
    mats = []
    for c in chunks:
        try:
            mats.append(np.load(c))
        except Exception:
            break  # stop at first unreadable (mid-write) chunk
    seeds = np.concatenate(mats, axis=0) if mats else np.empty((0, 384), "float32")
    titles = json.loads(TITLES.read_text())
    n = min(seeds.shape[0], len(titles), done or seeds.shape[0])
    return seeds[:n], titles[:n]


def _interest_bullets() -> tuple[list[str], str]:
    """Bullets from the 'What I'm drawn to' positive block of interests.md."""
    txt = INTERESTS.read_text(encoding="utf-8")
    start = txt.find("## What I'm drawn to")
    end = txt.find("## What I am NOT")
    if start != -1 and end != -1:
        block, src = txt[start:end], "positive-block"
    elif end != -1:
        block, src = txt[:end], "fallback-before-anti"
    else:
        block, src = txt, "whole-file"
    bullets = []
    for line in block.splitlines():
        s = line.strip()
        if s.startswith(("-", "*")):
            bullets.append(re.sub(r"^[-*]\s*", "", s).strip())
    return [b for b in bullets if b], src


def collide_sample(V: np.ndarray, seeds: np.ndarray, temperature: float, k: int,
                   rng: random.Random, titles: list[dict] | None = None,
                   diversity: float = 1.0, source_penalty: float = 0.15):
    """V:(B,384) interest-bullet unit vecs. seeds:(N,384) unit. -> (idx, dist, rank, bsim).

    Selection model (the fix for 'k picks are always the same type'):
      * temperature still sets WHERE on the interest-distance axis to sample
        (the chaos dial: low=near interests, high=far). This picks the BAND.
      * within the band we now choose k seeds by GREEDY FARTHEST-POINT (max-min)
        in the full 384-D space, so the k picks are far from EACH OTHER, not just
        far from the builder. This is what breaks the 'three near-synonyms' feel.
      * a SOFT source penalty nudges picks toward distinct sources, but never
        forces it -- a thin source can't be force-fed (that would just reintroduce
        the same monoculture from a smaller pool). Set source_penalty=0 to disable.
      * near-duplicates fall out for free: a seed almost identical to an already
        picked one has tiny min-distance and loses the max-min, so cos>~0.9
        twins are never co-selected.
    """
    N = seeds.shape[0]
    bsim = seeds @ V.T                       # (N,B) cosine to each interest bullet
    sim = bsim.max(axis=1)                    # near ANY interest
    dist = 1.0 - sim
    # anisotropy fix: rank-transform distance to uniform [0,1]
    order = np.argsort(dist)                  # nearest -> farthest
    rank = np.empty(N)
    rank[order] = np.linspace(0.0, 1.0, N)
    # Map temperature -> rank CENTER through a power curve (see note below).
    center = temperature ** 2
    # Wider oversample so farthest-point has real room to spread the picks.
    oversample = 12
    band_w = max(0.04, (k * oversample) / float(max(N, 1)))
    lo = float(np.clip(center - band_w, 0.0, 1.0))
    hi = float(np.clip(center + band_w, 0.0, 0.985))  # drop incoherent tail
    band = np.where((rank >= lo) & (rank <= hi))[0]
    if len(band) < k:                          # fallback: k nearest-by-rank to center
        band = np.argsort(np.abs(rank - center))[:max(k * oversample, k)]
    # candidate pool: sample a generous slice of the band to run max-min over
    pool = rng.sample(list(map(int, band)), min(len(band), max(k * oversample, k)))
    pool = np.array(pool, dtype=int)

    srcs = [titles[i].get("source", "") if titles else "" for i in pool]

    # ---- greedy farthest-point (max-min cosine distance) selection ----------
    # seed 1: random from the pool (entropy -> different runs differ)
    first = int(rng.randrange(len(pool)))
    picked_local = [first]
    # min cosine distance of every pool item to the picked set (start: vs first)
    # distance = 1 - cos; seeds are unit, so cos = dot.
    mindist = 1.0 - (seeds[pool] @ seeds[pool[first]])
    while len(picked_local) < min(k, len(pool)):
        score = diversity * mindist.copy()
        if source_penalty > 0:
            picked_srcs = {srcs[p] for p in picked_local}
            # subtract penalty from candidates whose source is already represented
            same = np.array([1.0 if srcs[j] in picked_srcs else 0.0
                             for j in range(len(pool))])
            score = score - source_penalty * same
        # never re-pick
        for p in picked_local:
            score[p] = -1e9
        nxt = int(np.argmax(score))
        picked_local.append(nxt)
        # update running min-distance to the picked set
        d_new = 1.0 - (seeds[pool] @ seeds[pool[nxt]])
        mindist = np.minimum(mindist, d_new)

    idx = pool[np.array(picked_local[:k], dtype=int)]
    return idx, dist[idx], rank[idx], bsim


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--temp", type=float, required=True, help="0..1 chaos temperature")
    ap.add_argument("--k", type=int, default=2)
    ap.add_argument("--debug", action="store_true", help="print ranks/dists to stderr")
    A = ap.parse_args()
    temp = max(0.0, min(1.0, A.temp))

    seeds, titles = _load_partial_index()
    bullets, csrc = _interest_bullets()
    if not bullets:
        raise SystemExit("no interest bullets parsed from interests.md")

    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(_bge_path(), device=_device())
    V = model.encode(bullets, normalize_embeddings=True).astype("float32")

    rng = random.Random(int.from_bytes(os.urandom(4), "little"))  # sole entropy
    idx, dist, rank, bsim = collide_sample(V, seeds, temp, A.k, rng, titles=titles)
    picked = [titles[i] for i in idx]

    # stdout = the contract itch reads
    print(json.dumps([p["title"] for p in picked]))

    audit = {
        "temperature": temp, "k": A.k, "corpus_size": int(seeds.shape[0]),
        "centroid_source": csrc, "n_bullets": len(bullets),
        "seeds": [{
            "title": picked[j]["title"], "source": picked[j].get("source", ""),
            "cos_dist": float(dist[j]), "rank": float(rank[j]),
        } for j in range(len(idx))],
    }
    (CDIR / "last-sample.json").write_text(json.dumps(audit, indent=1))

    if A.debug:
        print(f"corpus={seeds.shape[0]} bullets={len(bullets)} src={csrc} "
              f"temp={temp}", file=sys.stderr)
        for j in range(len(idx)):
            print(f"  [{picked[j].get('source',''):8s}] rank={rank[j]:.3f} "
                  f"dist={dist[j]:.3f}  {picked[j]['title']}", file=sys.stderr)


if __name__ == "__main__":
    main()
