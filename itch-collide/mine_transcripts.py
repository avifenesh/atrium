"""Transcript corroboration miner for itch — ranked retrieval over the sxc index.

Atrium's native itch engine reasons from the builder profile + web search, but
it never *grounded* a seed against the builder's own past transcripts/notes.
This helper closes that gap: for each seed term it pulls the top ranked context
slabs from the `colbert-2` (sxc) index and emits a compact JSON the
engine folds into the prompt as a CORROBORATION block (so the model can see
"this is a genuine recurring interest, here's where it showed up" vs noise).

Runs in the sxc venv (it has torch + colbert + pyarrow). CPU by default: a
ColBERT query is ~32ms once the index is loaded, and the one-time index load
(~40s on CPU) amortises across the whole seed batch in a single background run,
so no GPU is needed and this never contends with anything on the box. Set
ITCH_MINE_DEVICE=cuda to use the GPU if a run is ever latency-bound.

Degrades gracefully: any failure (missing index, import error, empty result)
prints a bare object and exits 0, so the engine falls back to the ungrounded
baseline exactly as it does for the collide sampler.

Usage (sxc venv):
    python mine_transcripts.py --seeds-file seeds.txt --k 4
    echo '["agent permission model","speculative decoding"]' | \
        python mine_transcripts.py --k 4
Output (stdout, JSON):
    {"retriever": "colbert", "seeds": [
        {"seed": "...", "hits": [
            {"source": "claude", "project": "eigen", "session_id": "...",
             "ts": 1719300000.0, "score": 22.6, "quote": "..."}, ...]}, ...]}
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Force CPU unless explicitly told otherwise. Set BEFORE importing torch so
# colbert never tries to JIT-build its CUDA extensions (which also dodges the
# sm_120/nvcc-version toolchain issue on this box). CPU query latency is fine
# for itch's handful-of-seeds-per-run workload.
_DEVICE = os.environ.get("ITCH_MINE_DEVICE", "cpu").strip().lower()
if _DEVICE != "cuda":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""

SXC_ROOT = os.environ.get(
    "ITCH_SXC_ROOT", os.path.expanduser("~/projects/colbert-2")
)
# Valid sxc retrievers, cheapest->best. "colbert" is the paraphrase-aware
# primary; "bm25" is the instant lexical fallback when the ColBERT index is
# missing/stale. Overridable via ITCH_MINE_RETRIEVER.
_DEFAULT_RETRIEVER = os.environ.get("ITCH_MINE_RETRIEVER", "colbert").strip().lower()
_QUOTE_CHARS = 360


_REAL_STDOUT_FD = os.dup(1)  # preserve the real stdout; colbert spams fd 1


def _silence_stdout_to_stderr() -> None:
    """colbert-ai prints progress to stdout, which would corrupt our JSON
    contract. Redirect fd 1 -> fd 2 so all that noise goes to stderr; we still
    hold the real stdout in _REAL_STDOUT_FD for the final emit."""
    sys.stdout.flush()
    os.dup2(2, 1)


def _emit(obj: object) -> None:
    payload = json.dumps(obj, ensure_ascii=False)
    sys.stdout.flush()
    os.write(_REAL_STDOUT_FD, payload.encode("utf-8"))


def _read_seeds(args: argparse.Namespace) -> list[str]:
    raw = ""
    if args.seeds_file:
        try:
            with open(args.seeds_file, encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            return []
    else:
        raw = sys.stdin.read()
    raw = raw.strip()
    if not raw:
        return []
    seeds: list[str] = []
    # Accept either a JSON array or newline-delimited terms.
    if raw[0] in "[{":
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                seeds = [str(x).strip() for x in data]
        except ValueError:
            seeds = []
    if not seeds:
        seeds = [ln.strip() for ln in raw.splitlines()]
    # De-dup (case-insensitive), drop empties, cap the batch.
    out: list[str] = []
    seen: set[str] = set()
    for s in seeds:
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out[: args.max_seeds]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mine_transcripts")
    ap.add_argument("--seeds-file", default=None)
    ap.add_argument("--k", type=int, default=4, help="top-k context slabs per seed")
    ap.add_argument("--max-seeds", type=int, default=24)
    ap.add_argument("--retriever", default=_DEFAULT_RETRIEVER)
    args = ap.parse_args(argv)

    seeds = _read_seeds(args)
    if not seeds:
        _emit({"retriever": args.retriever, "seeds": []})
        return 0

    _silence_stdout_to_stderr()
    if SXC_ROOT not in sys.path:
        sys.path.insert(0, SXC_ROOT)

    try:
        from sxc.serve import get_context
        try:
            from sxc.serve.api import get_force_retriever
        except Exception:
            get_force_retriever = None
    except Exception as e:
        _emit({"error": f"{type(e).__name__}: {e}", "retriever": args.retriever, "seeds": []})
        return 0

    valid_retrievers = ("bm25", "splade", "colbert", "hybrid")
    retriever = args.retriever if args.retriever in valid_retrievers else "colbert"
    forced_env = os.environ.get("SXC_FORCE_RETRIEVER")
    forced_file = get_force_retriever() if get_force_retriever is not None else None
    effective_retriever = (
        forced_env if forced_env in valid_retrievers
        else forced_file if forced_file in valid_retrievers
        else retriever
    )

    out_seeds: list[dict[str, object]] = []
    for seed in seeds:
        try:
            ctxs = get_context(seed, top_k=args.k, retriever=effective_retriever)
        except Exception as e:
            # On the very first seed a hard failure (e.g. ColBERT index missing)
            # means no seed will work: degrade the whole call to baseline.
            if not out_seeds:
                _emit(
                    {"error": f"{type(e).__name__}: {e}", "retriever": effective_retriever, "seeds": []}
                )
                return 0
            continue
        hits = [
            {
                "chunk_id": c.chunk_id,
                "source": c.source,
                "project": c.project,
                "session_id": c.session_id,
                "ts": c.ts,
                # `confidence` is the raw sxc score exposed to Atrium's review
                # gate. `score` may be locally reweighted later by explicit
                # thumbs feedback, but confidence remains the retriever signal.
                "score": round(float(c.score), 4),
                "confidence": round(float(c.score), 4),
                "quote": (c.quote or "")[:_QUOTE_CHARS],
            }
            for c in ctxs
        ]
        out_seeds.append({"seed": seed, "hits": hits})

    _emit({"retriever": effective_retriever, "seeds": out_seeds})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
