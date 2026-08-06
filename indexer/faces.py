"""insightface wrapper — the reference implementation of the vector contract.

apps/web/src/lib/face.ts must reproduce this exactly. tools/golden proves it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from .config import EMBED_DIM, QUANT_SCALE

log = logging.getLogger(__name__)


@dataclass
class Face:
    bbox: tuple[float, float, float, float]  # x, y, w, h in source pixels
    embedding: np.ndarray                    # float32[512], L2-normalized
    det_score: float
    bib: str | None = None


def quantize(vec: np.ndarray) -> np.ndarray:
    """float32[512] (L2-normalized) -> int8[512].

    Ranking uses the raw int8 dot product, so the constant scale never needs to
    be undone; the Worker only divides by 127*127 to recover a cosine.
    """
    return np.clip(np.round(vec * QUANT_SCALE), -QUANT_SCALE, QUANT_SCALE).astype(np.int8)


def _iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    ar = (a[2] - a[0]) * (a[3] - a[1])
    br = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(ar + br - inter, 1e-6)


class FaceEngine:
    """Multi-scale face detection.

    SCRFD letterboxes the whole frame to det_size before looking, so det_size
    picks which face SIZES are findable — and it is a trade, not a dial:

      det 640  finds a large close-up, misses runners down the road
      det 2048 finds distant runners, MISSES the close-up entirely

    Measured on a real portrait: 640 -> 1 face, 1280 -> 1, 2048 -> 0. Raising
    det_size to reach distant runners silently broke the easiest photos in the
    album, which is the opposite of what it looked like it was doing.

    So run both and merge. Distant pass first, then the close-up pass adds only
    boxes it did not already cover (IoU > 0.4). Measured 0.19s for the pair —
    the same as 2048 alone, because the 640 pass is nearly free.
    """

    def __init__(self, det_size: int = 640) -> None:
        from insightface.app import FaceAnalysis

        # buffalo_s: det_500m.onnx (SCRFD) + w600k_mbf.onnx (MobileFaceNet, 512-d).
        # Chosen because the recognizer is ~13 MB and therefore browser-viable.
        self.app = FaceAnalysis(
            name="buffalo_s",
            allowed_modules=["detection", "recognition"],
            providers=["CPUExecutionProvider"],
        )
        self.app.prepare(ctx_id=-1, det_size=(det_size, det_size))

        # Second pass for close-ups. Only when the primary size is large enough
        # that it would miss them.
        self.second_size = 640 if det_size > 1024 else 0
        if self.second_size:
            self.app2 = FaceAnalysis(
                name="buffalo_s",
                allowed_modules=["detection", "recognition"],
                providers=["CPUExecutionProvider"],
            )
            self.app2.prepare(ctx_id=-1, det_size=(self.second_size, self.second_size))
        else:
            self.app2 = None

        log.info("insightface ready (buffalo_s, CPU, det_size=%d%s)", det_size,
                 f" + {self.second_size} for close-ups" if self.second_size else "")

    def detect(self, bgr: np.ndarray) -> list[Face]:
        found = list(self.app.get(bgr))
        if self.app2 is not None:
            boxes = [tuple(f.bbox) for f in found]
            for f in self.app2.get(bgr):
                bb = tuple(f.bbox)
                if not any(_iou(bb, b) > 0.4 for b in boxes):
                    found.append(f)
                    boxes.append(bb)

        out: list[Face] = []
        for f in found:
            emb = f.normed_embedding.astype(np.float32)
            if emb.shape[0] != EMBED_DIM:
                raise RuntimeError(f"Expected {EMBED_DIM}-d embedding, got {emb.shape[0]}")
            x1, y1, x2, y2 = (float(v) for v in f.bbox)
            out.append(
                Face(
                    bbox=(x1, y1, x2 - x1, y2 - y1),
                    embedding=emb,
                    det_score=float(f.det_score),
                )
            )
        return out


def embed_file(engine: FaceEngine, path: str) -> np.ndarray | None:
    """Embed the largest face in an image file. Used by the golden harness."""
    import cv2

    bgr = cv2.imread(path)
    if bgr is None:
        raise FileNotFoundError(path)
    faces = engine.detect(bgr)
    if not faces:
        return None
    largest = max(faces, key=lambda f: f.bbox[2] * f.bbox[3])
    return largest.embedding
