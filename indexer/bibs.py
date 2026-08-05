"""Bib-number OCR.

Two modes:
  * face-anchored torso crops — the default. Faster than full-image OCR and it
    hands us the face<->bib association for free.
  * full-image — only for photos where the detector found no faces at all,
    so a back-of-pack photo still turns up in a bib search.

Cropping to torsos is also the main defence against reading race numbers off
bystanders in the background.

ENGINE CHOICE
-------------
RapidOCR (onnxruntime) rather than PaddleOCR. Same underlying PP-OCR models,
but it runs on the ONNX runtime this project already ships for insightface,
instead of pulling in the paddlepaddle native runtime.

That is not a preference, it is scar tissue. PaddleOCR broke two consecutive
production runs:
  1. 3.x removed `show_log` and renamed `use_angle_cls` -> crash at start-up.
  2. paddlepaddle 3.x then failed on every single crop with
     "ConvertPirAttribute2RuntimeAttribute not support" out of its oneDNN/PIR
     path — silently reading zero bibs while burning ~2 s per face.

PaddleOCR is kept as a fallback for environments that already have it, but it
is no longer the dependency we rely on.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

# At least 3 digits AS PRINTED. Real bibs at this race are 3-4 digits, usually
# zero-padded ("0056"). Accepting 1-2 digit tokens let partial reads of a longer
# number ("5", "56", "60") into the index, where they are indistinguishable from
# a genuine short bib and pollute every suffix comparison.
BIB_RE = re.compile(r"^\d{3,5}$")
# 0.6 admitted reads the engine itself was unsure of. Every correct bib observed
# on real photos scored 0.88-1.00, so this costs nothing and drops guesses.
MIN_CONF = 0.7

# Torso box relative to the face box.
#
# The plan specified a 1.2h-3.2h window. Measured against real bibs from the
# Angkor album that is too short: it lands on the bib's HEADER ("11 ANGKOR
# EMPIRE MARATHON", "42Km") and stops just above the digits. On one photo it
# read the event name at 0.99 confidence and the number not at all.
#
# Swept over 8 photos / 23 faces, counting faces that yielded a usable number:
#   3.2h ->  5    3.8h -> 13    4.4h -> 19    5.0h -> 17    5.6h -> 19 + noise
# 4.4h is the peak. Beyond it the crop starts swallowing the runner behind and
# short fragments ("29") appear, which is the precision problem face-anchored
# cropping exists to avoid.
TORSO_TOP = 1.2      # y + 1.2h
TORSO_BOTTOM = 4.4   # y + 4.4h
TORSO_LEFT = -0.75   # x - 0.75w
TORSO_RIGHT = 1.75   # x + 1.75w


@dataclass
class BibHit:
    bib: str        # normalized for matching: leading zeros stripped
    conf: float
    raw: str = ""   # exactly as printed on the bib, e.g. "0056"


def _tokens_from_rapidocr(result) -> list[tuple[str, float]]:
    """RapidOCR returns [[box, text, score], ...] or None."""
    return [(str(item[1]), float(item[2])) for item in (result or []) if len(item) >= 3]


def _tokens_from_paddle(result) -> list[tuple[str, float]]:
    """PaddleOCR 3.x pages carry rec_texts/rec_scores; 2.x is [[box,(text,score)]]."""
    out: list[tuple[str, float]] = []
    for page in result or []:
        if page is None:
            continue
        texts = scores = None
        if isinstance(page, dict) or hasattr(page, "get"):
            try:
                texts, scores = page.get("rec_texts"), page.get("rec_scores")
            except Exception:  # noqa: BLE001
                texts = None
        if texts is not None:
            out.extend((str(t), float(c)) for t, c in zip(texts, scores or []))
            continue
        for line in page or []:
            try:
                out.append((str(line[1][0]), float(line[1][1])))
            except (IndexError, TypeError, ValueError):
                continue
    return out


class BibReader:
    def __init__(self) -> None:
        self.engine = None
        self.kind = None

        try:
            from rapidocr_onnxruntime import RapidOCR

            self.engine = RapidOCR()
            self.kind = "rapidocr"
            log.info("OCR engine: RapidOCR (onnxruntime)")
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("RapidOCR unavailable (%s), falling back to PaddleOCR", exc)

        from paddleocr import PaddleOCR

        # Angle classification stays off: bibs are upright, and the classifier
        # roughly doubles per-crop latency for no measurable recall gain here.
        for kwargs in (
            {"use_textline_orientation": False, "lang": "en"},           # 3.x
            {"use_angle_cls": False, "lang": "en", "show_log": False},   # 2.x
            {"lang": "en"},
        ):
            try:
                self.engine = PaddleOCR(**kwargs)
                self.kind = "paddleocr"
                log.info("OCR engine: PaddleOCR %s", sorted(kwargs))
                return
            except (TypeError, ValueError):
                continue
        raise RuntimeError("No usable OCR engine (tried RapidOCR and PaddleOCR)")

    def _read(self, image: np.ndarray) -> list[BibHit]:
        if image.size == 0 or min(image.shape[:2]) < 12:
            return []
        try:
            if self.kind == "rapidocr":
                result, _ = self.engine(image)
                pairs = _tokens_from_rapidocr(result)
            else:
                try:
                    result = self.engine.predict(image)
                except AttributeError:
                    result = self.engine.ocr(image, cls=False)
                pairs = _tokens_from_paddle(result)
        except Exception as exc:  # noqa: BLE001 - a bad crop must not kill the run
            log.warning("OCR failed on a crop: %s", exc)
            return []

        hits: list[BibHit] = []
        for text, conf in pairs:
            token = text.strip().replace(" ", "")
            if conf >= MIN_CONF and BIB_RE.match(token):
                # Store leading zeros stripped. The Worker normalizes the query
                # the same way, so "0123" and "123" both land here.
                hits.append(BibHit(bib=token.lstrip("0") or "0", conf=conf, raw=token))
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
