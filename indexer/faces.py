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


class FaceEngine:
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
        log.info("insightface ready (buffalo_s, CPU, det_size=%d)", det_size)

    def detect(self, bgr: np.ndarray) -> list[Face]:
        out: list[Face] = []
        for f in self.app.get(bgr):
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
