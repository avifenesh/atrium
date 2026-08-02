#!/usr/bin/env python3
"""collide_embed -- vectorize manifest rows into seed vectors, INCREMENTALLY.

Runs in the sxc venv (has torch + sentence-transformers). Embeds on CPU on
purpose: the GPU is owned by the live memra-server / inference (Qwen), and CPU embedding of
bge-small is fast enough (~thousands/sec batched) that GPU contention isn't worth
it. This is the piece meant to run in the BACKGROUND while you live-test: it
appends vectors chunk by chunk, checkpoints after each, and is safe to kill and
resume (re-run picks up where it stopped).

Design:
  manifest.jsonl  -- N rows (title, embed_text, source), append-only (harvester)
  vecs/chunk-*.npy-- float32 (rows_in_chunk, 384) L2-normalized, one file/chunk
  embedded.json   -- checkpoint: count of manifest rows already embedded
  titles.json     -- [{title, source}] aligned 1:1 with the concatenated vecs

The sampler (collide_sample.py) loads all chunk-*.npy in order + titles.json. A
PARTIAL index (embedder still running) is valid: chunks are written atomically
(temp file + os.replace), and the sampler only reads chunks listed up to the
checkpoint count, so it never sees a half-written vector. That makes "live-test
on the first chunk while the rest embeds" safe.

Usage (sxc venv):
  .venv/bin/python collide_embed.py                 # embed all pending, chunked
  .venv/bin/python collide_embed.py --chunk 512     # chunk size
  .venv/bin/python collide_embed.py --first-only     # just the first chunk, exit
                                                     #   (for the integrate-then-background flow)
"""
from __future__ import annotations
import argparse, json, os, pathlib, sys, time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# Device: GPU if free (Qwen stopped), else CPU. Override with COLLIDE_DEVICE.
# bge-small is tiny; CPU is fine (~thousands/s) when the GPU is busy with an LLM.

import numpy as np  # noqa: E402


def _pick_device() -> str:
    forced = os.environ.get("COLLIDE_DEVICE")
    if forced:
        return forced
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"

CDIR = pathlib.Path(os.path.expanduser("~/.config/itch/collide"))
VECS = CDIR / "vecs"
MANIFEST = CDIR / "manifest.jsonl"
TITLES = CDIR / "titles.json"
CKPT = CDIR / "embedded.json"
# Local bge-small snapshot (verified present). Resolve the snapshot dir robustly.
BGE_ROOT = pathlib.Path(os.path.expanduser(
    "~/ai-ml/hf-models/models--BAAI--bge-small-en-v1.5/snapshots"))


def _bge_path() -> str:
    if BGE_ROOT.is_dir():
        snaps = sorted(p for p in BGE_ROOT.iterdir() if p.is_dir())
        if snaps:
            return str(snaps[-1])
    return "BAAI/bge-small-en-v1.5"  # fall back to hub id (will use cache)


def _load_manifest() -> list[dict]:
    rows = []
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _done() -> int:
    if CKPT.exists():
        try:
            return int(json.loads(CKPT.read_text()).get("embedded", 0))
        except Exception:
            return 0
    return 0


def _atomic_save_npy(path: pathlib.Path, arr: np.ndarray) -> None:
    # np.save() force-appends '.npy', so give it a base WITHOUT that suffix and
    # let it produce <base>.npy, then rename that into place.
    tmp_base = path.with_name(path.stem + ".tmp")   # chunk-000.tmp  -> np.save -> chunk-000.tmp.npy
    np.save(tmp_base, arr)
    os.replace(str(tmp_base) + ".npy", path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=512)
    ap.add_argument("--first-only", action="store_true",
                    help="embed only the next one chunk, then exit (integrate-then-background flow)")
    A = ap.parse_args()

    VECS.mkdir(parents=True, exist_ok=True)
    rows = _load_manifest()
    n = len(rows)
    done = _done()
    if done >= n:
        print(f"up to date: {done}/{n} embedded"); return

    from sentence_transformers import SentenceTransformer
    dev = _pick_device()
    t0 = time.time()
    model = SentenceTransformer(_bge_path(), device=dev)
    print(f"loaded bge-small ({dev}) in {time.time()-t0:.1f}s, dim={model.get_embedding_dimension()}",
          file=sys.stderr)

    # titles.json is rebuilt to stay 1:1 with the manifest order (idempotent)
    titles = [{"title": r["title"], "source": r.get("source", "")} for r in rows]
    TITLES.write_text(json.dumps(titles))

    i = done
    while i < n:
        batch = rows[i:i + A.chunk]
        texts = [r.get("embed_text") or r["title"] for r in batch]
        t = time.time()
        vecs = model.encode(texts, normalize_embeddings=True, batch_size=128,
                            show_progress_bar=False).astype("float32")
        # chunk file named by its start index so order is recoverable + resumable
        chunk_path = VECS / f"chunk-{i:07d}.npy"
        _atomic_save_npy(chunk_path, vecs)
        i += len(batch)
        CKPT.write_text(json.dumps({"embedded": i, "total": n}))
        rate = len(batch) / max(time.time() - t, 1e-6)
        print(f"  embedded {i}/{n}  (+{len(batch)} @ {rate:.0f}/s) -> {chunk_path.name}",
              file=sys.stderr)
        if A.first_only:
            print(f"first chunk done ({i}/{n}); exiting for integrate-then-background flow",
                  file=sys.stderr)
            break

    print(f"embedded {i}/{n} rows -> {VECS}/chunk-*.npy")


if __name__ == "__main__":
    main()
