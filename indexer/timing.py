"""Per-stage wall-clock accounting for the indexing pipeline.

Exists because the first question about indexing speed — "where does the time
actually go?" — had only an inferred answer. Per photo the pipeline does a
download, a decode, a LANCZOS thumbnail, two detector passes, one torso OCR per
face, and a 2x2 tiled OCR of the whole frame. With ~5 faces a photo that is
~9 OCR invocations, so OCR was ASSUMED to dominate. Assumed, never measured,
and the optimisations that follow are ordered by that assumption.

Deliberately not a profiler: a sampling profiler over onnxruntime attributes
everything to one C call. These are the stages an optimisation can actually
move, named the way the work is decided.

Accumulators merge rather than nest, because the parallel-photo work ahead runs
stages in separate PROCESSES. A worker returns its own Stages, the parent merges
them, and the totals stay meaningful — they become a sum of CPU time across
workers, which is why wall time is recorded separately and never derived from
the sum of stages.
"""
from __future__ import annotations

import time
from collections import defaultdict
from contextlib import contextmanager

# The stages, in pipeline order. Fixed rather than free-form so that two reports
# from different commits always have the same columns to compare.
STAGES = (
    "download_s",
    "decode_s",
    "thumbnail_s",
    "detect_s",
    "torso_ocr_s",
    "tile_ocr_s",
    "upload_s",
    "other_s",
)


class Stages:
    """Additive per-stage second counters."""

    def __init__(self, seed: dict | None = None) -> None:
        self._t: dict = defaultdict(float)
        if seed:
            for k, v in seed.items():
                self._t[k] += float(v)

    @contextmanager
    def timed(self, stage: str):
        # perf_counter, not time(): monotonic and unaffected by a clock step
        # mid-run, which on a 5-hour pass is not hypothetical.
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self._t[stage] += time.perf_counter() - t0

    def add(self, stage: str, seconds: float) -> None:
        self._t[stage] += seconds

    def merge(self, other: "Stages | dict") -> "Stages":
        src = other.as_dict() if isinstance(other, Stages) else other
        for k, v in src.items():
            self._t[k] += float(v)
        return self

    def as_dict(self) -> dict:
        # Every stage present even at zero, so a report never has a missing
        # column that a diff would have to guess the meaning of.
        return {s: round(self._t.get(s, 0.0), 4) for s in STAGES}

    def total(self) -> float:
        return sum(self._t.values())

    def summary(self) -> str:
        """One log line, biggest stage first — the whole point of the module."""
        total = self.total() or 1.0
        parts = sorted(
            ((s, v) for s, v in self.as_dict().items() if v > 0.0),
            key=lambda kv: kv[1],
            reverse=True,
        )
        return "  ".join(
            f"{s[:-2]}={v:.1f}s({100 * v / total:.0f}%)" for s, v in parts
        )
