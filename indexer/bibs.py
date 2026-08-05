"""Bib-number OCR.

Two modes:
  * face-anchored torso crops — the default. Faster than full-image OCR and it
    hands us the face<->bib association for free.
  * full-image — only for photos where the detector found no faces at all,
    so a back-of-pack photo still turns up in a bib search.

Cropping to torsos is also the main defence against reading race numbers off
bystanders in the background.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

BIB_RE = re.compile(r"^\d{1,5}$")
MIN_CONF = 0.6

# Torso box relative to the face box, per the plan.
TORSO_TOP = 1.2      # y + 1.2h
TORSO_BOTTOM = 3.2   # y + 3.2h
TORSO_LEFT = -0.75   # x - 0.75w
TORSO_RIGHT = 1.75   # x + 1.75w


def _iter_tokens(result) -> "list[tuple[str, float]]":
    """Yield (text, confidence) from either PaddleOCR result shape.

    3.x returns dict-like pages with parallel `rec_texts` / `rec_scores` lists.
    2.x returns [[[box, (text, score)], ...], ...].
    """
    out: list[tuple[str, float]] = []
    for page in result or []:
        if page is None:
            continue
        texts = None
        if isinstance(page, dict):
            texts = page.get("rec_texts")
            scores = page.get("rec_scores")
        elif hasattr(page, "get"):  # 3.x returns a Result object supporting .get
            texts, scores = page.get("rec_texts"), page.get("rec_scores")
        if texts is not None:
            for t, c in zip(texts, scores or []):
                out.append((str(t), float(c)))
            continue
        for line in page or []:
            try:
                out.append((str(line[1][0]), float(line[1][1])))
            except (IndexError, TypeError, ValueError):
                continue
    return out


@dataclass
class BibHit:
    bib: str
    conf: float


class BibReader:
    """Wraps PaddleOCR across two incompatible major versions.

    PaddleOCR 3.x renamed `use_angle_cls` to `use_textline_orientation`, dropped
    `show_log` entirely, and changed the result shape. Pinning to 2.x would work
    today but rots the moment the pin is bumped, and the failure is a crash at
    runner start-up, 40 minutes into someone's race day. So probe instead.
    """

    def __init__(self) -> None:
        from paddleocr import PaddleOCR

        # Angle classification stays off: bibs are upright, and the classifier
        # roughly doubles per-crop latency for no measurable recall gain here.
        attempts = [
            {"use_textline_orientation": False, "lang": "en"},   # 3.x
            {"use_angle_cls": False, "lang": "en", "show_log": False},  # 2.x
            {"lang": "en"},                                      # last resort
        ]
        last: Exception | None = None
        for kwargs in attempts:
            try:
                self.ocr = PaddleOCR(**kwargs)
                log.info("PaddleOCR initialised with %s", sorted(kwargs))
                return
            except (TypeError, ValueError) as exc:
                last = exc
        raise RuntimeError(f"Could not initialise PaddleOCR: {last}")

    def _read(self, image: np.ndarray) -> list[BibHit]:
        if image.size == 0 or min(image.shape[:2]) < 12:
            return []
        try:
            try:
                result = self.ocr.predict(image)          # 3.x
            except AttributeError:
                result = self.ocr.ocr(image, cls=False)   # 2.x
        except Exception as exc:  # noqa: BLE001 - a bad crop must not kill the run
            log.warning("OCR failed on a crop: %s", exc)
            return []

        hits: list[BibHit] = []
        for token, conf in _iter_tokens(result):
            token = token.strip().replace(" ", "")
            if conf >= MIN_CONF and BIB_RE.match(token):
                # Store leading zeros stripped. The Worker normalizes the query
                # the same way, so "0123" and "123" both land here.
                hits.append(BibHit(bib=token.lstrip("0") or "0", conf=conf))
        return hits

    def read_torso(self, bgr: np.ndarray, face_bbox: tuple[float, float, float, float]) -> BibHit | None:
        h_img, w_img = bgr.shape[:2]
        x, y, w, h = face_bbox
        x1 = int(max(0, x + TORSO_LEFT * w))
        x2 = int(min(w_img, x + TORSO_RIGHT * w))
        y1 = int(max(0, y + TORSO_TOP * h))
        y2 = int(min(h_img, y + TORSO_BOTTOM * h))
        if x2 <= x1 or y2 <= y1:
            return None

        hits = self._read(bgr[y1:y2, x1:x2])
        return max(hits, key=lambda hit: hit.conf) if hits else None

    def read_full(self, bgr: np.ndarray) -> list[BibHit]:
        # Dedupe to the best confidence per number — one bib read twice in a
        # photo is one bib.
        best: dict[str, BibHit] = {}
        for hit in self._read(bgr):
            if hit.bib not in best or hit.conf > best[hit.bib].conf:
                best[hit.bib] = hit
        return list(best.values())
