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

# Shortest number that counts as a bib, AS PRINTED. Per event, not global —
# events.bib_min_digits, passed to BibReader.
#
# 3 was hard-coded here, for a reason that holds at the album it was tuned on:
# Angkor bibs are 3-4 digits and zero-padded ("0056"), so a 1-2 digit token is by
# definition a PARTIAL read of a longer number, indistinguishable from a genuine
# short bib and poison to every suffix comparison.
#
# It is wrong wherever the printed bib is shorter than that, and wrong silently.
# Measured over 40 SheRuns originals / 199 faces: a floor of 3 accepted 0 bibs —
# not fewer, none — because every bib at that race is two digits. The album's bib
# search was empty and nothing in the pipeline said why.
#
# There is a ceiling per event too — events.bib_max_digits — because a floor alone
# cannot exclude numbers LONGER than the bibs. SheRuns prints two digits, and its
# first pass stored 2025, 2024, 2026 off banners and 100 off a distance marker;
# max_digits=2 excludes all of them at once. MAX_DIGITS below is the absolute
# ceiling any event may ask for, and the default: no race here prints longer, and
# it is what keeps timestamps and phone numbers out.
DEFAULT_MIN_DIGITS = 3
MAX_DIGITS = 5

# CANONICAL BIB FORM — mirrored in apps/api/src/bib.ts. Changing one requires
# changing the other, like the vector contract in config.py.
#
#   printed        stored (bibs.bib)   bib_raw
#   "0056"         "56"                "0056"
#   "F-0001"       "F-1"               "F-0001"
#   "f 0001"       "F-1"               "f 0001"
#   "M0001"        "M-1"               "M0001"
#
# Leading zeros come off the digits, as they always have, so "0056" and "56"
# resolve to one row. The PREFIX DOES NOT: at a race where 0001 is a marathon
# runner and F-0001 is a 10k woman, dropping the letter merges two people, which
# is the precise failure the strict digits-only rule used to prevent by refusing
# such bibs outright. One canonical separator ("-") so the same runner scanned
# from two photos, printed with a hyphen or a space, lands on one row.
PREFIX_SEP = "-"


def normalize_bib(printed: str) -> str:
    """Printed bib -> the form stored in bibs.bib. '' if it is not a bib at all.

    Deliberately permissive about what it ACCEPTS as input (case, separator,
    padding) and exact about what it EMITS, because it is called on operator
    typing as well as OCR output.
    """
    token = (printed or "").strip().upper().replace(" ", "").replace(PREFIX_SEP, "")
    m = re.match(r"^([A-Z]{1,2})?([0-9]{1,%d})$" % MAX_DIGITS, token)
    if not m:
        return ""
    prefix, digits = m.group(1), m.group(2).lstrip("0") or "0"
    return f"{prefix}{PREFIX_SEP}{digits}" if prefix else digits


def bib_pattern(min_digits: int, prefixes: "tuple[str, ...] | None" = None,
                max_digits: "int | None" = None) -> re.Pattern[str]:
    """What counts as a bib token on a photo, for THIS event.

    Both bounds are clamped rather than trusted: they arrive from D1 via the
    Worker, and a 0 would compile to a pattern accepting every integer on the
    frame — jersey numbers, lap counts, sponsor phone numbers.

    The ceiling matters as much as the floor at a race with short bibs. SheRuns
    prints two digits, so every longer number its first pass stored was junk:
    2025, 2024 and 2026 off banners, 100 off a distance marker. A floor cannot
    exclude those; max_digits=2 excludes all of them.

    An inverted pair (min above max) is corrected rather than allowed to compile
    to a pattern that matches nothing — an empty bib search with no error is the
    failure mode this whole area keeps producing.

    `prefixes` is a whitelist. Empty means digits only, which is every event that
    predates the setting. A bare number stays acceptable even when prefixes are
    configured, because a mixed race has both ("0001" marathon, "F-0001" 10k).
    """
    high = min(max(int(max_digits or MAX_DIGITS), 1), MAX_DIGITS)
    low = min(max(int(min_digits or DEFAULT_MIN_DIGITS), 1), high)
    # [0-9] rather than \d, which in Python also matches Unicode decimal digits —
    # "١٢" satisfied ^\d{2,5}$. The Worker normalizes a search with JavaScript's
    # \D, which is ASCII-only, so such a token would be stored as a bib that no
    # runner could ever match: junk in the index and a photo attached to nobody.
    digits = rf"[0-9]{{{low},{high}}}"
    clean = [p for p in (prefixes or ()) if re.fullmatch(r"[A-Za-z]{1,2}", p)]
    if not clean:
        return re.compile(rf"^{digits}$")
    # Anchored with the prefix FIRST and the separator optional, so "F-0001",
    # "F 0001" and "F0001" all match while "42Km" and "0092F" do not: a trailing
    # letter is kit text or a unit, never a category.
    alt = "|".join(sorted({p.upper() for p in clean}, key=lambda p: (-len(p), p)))
    return re.compile(rf"^(?:(?:{alt})[-\s]?)?{digits}$", re.IGNORECASE)


def parse_prefixes(raw: "str | None") -> tuple[str, ...]:
    """'F, m' -> ('F', 'M'). Anything that is not 1-2 letters is dropped rather
    than raised on: this comes from an operator's text field via D1, and a typo
    must not stop a pass."""
    out = []
    for part in (raw or "").replace(";", ",").split(","):
        p = part.strip().upper()
        if re.fullmatch(r"[A-Z]{1,2}", p) and p not in out:
            out.append(p)
    return tuple(out)


# Kept for callers that have no event context — benchmark.py, and any ad-hoc use.
BIB_RE = bib_pattern(DEFAULT_MIN_DIGITS)
# 0.6 admitted reads the engine itself was unsure of. Every correct bib observed
# on real photos scored 0.88-1.00, so this costs nothing and drops guesses.
MIN_CONF = 0.7

# Minimum width of a detected text region, as a fraction of the FULL image
# width, for it to be accepted as a bib.
#
# Confidence alone does not work. RapidOCR's score answers "am I reading these
# glyphs correctly", not "is this a bib" — on a 22x17px smudge it returned
# "420" at 0.91. Measured on a real frame (6000px wide):
#   real bibs    140-190px   2.3-3.2% of width
#   0703         76-84px     1.3-1.4%   (genuine, distant, digit misread)
#   420 (noise)  22-43px     0.4-0.7%
# 1.0% sits between the smallest genuine bib and the largest piece of noise.
#
# An invented bib is worse than a missing one: it puts a stranger's photo in a
# runner's results and neither of them can tell.
MIN_BIB_WIDTH_FRAC = 0.010

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
TORSO_BOTTOM = 6.5   # y + 6.5h
#
# Re-swept over 20 real photos AFTER fragments were rejected (3-5 digits,
# conf >= 0.7). The earlier 4.4h peak was measured while 1-2 digit tokens still
# counted, which made taller windows look like they were adding noise:
#   4.4h -> 47 faces-with-bib   5.5h -> 50   6.0h -> 51   6.5h -> 52   7.0h -> 50
#
# The geometry is the point: a distant runner has a small face box, so a
# multiple of face-height is a short distance, and 4.4h stopped just ABOVE the
# bib. A clearly legible 0804 was being missed for exactly that reason.
TORSO_LEFT = -0.75   # x - 0.75w
TORSO_RIGHT = 1.75   # x + 1.75w


@dataclass
class BibHit:
    bib: str        # normalized for matching: leading zeros stripped
    conf: float
    raw: str = ""   # exactly as printed on the bib, e.g. "0056"


@dataclass
class _Token:
    """One OCR region: text, confidence, and where it sat.

    The box is kept because a category prefix is often its own region — see
    _rejoin_prefixes — and rejoining needs geometry, not just text. None when the
    engine gave no usable box (the PaddleOCR fallback), which disables rejoining
    for that token rather than guessing at its position.
    """
    text: str
    conf: float
    box: "tuple[float, float, float, float] | None" = None   # x1, y1, x2, y2

    @property
    def width(self) -> float:
        return (self.box[2] - self.box[0]) if self.box else 0.0


def _tokens_from_rapidocr(result) -> list[_Token]:
    """RapidOCR returns [[box, text, score], ...] or None.

    No width filtering here, deliberately. It used to happen at this step, which
    cannot work once a lone prefix letter is a token worth keeping: "F" beside a
    150px bib is ~40px, well under MIN_BIB_WIDTH_FRAC of a 6000px frame, so it was
    discarded before anything could join it to its digits. The filter now runs in
    _read, after rejoining, against the MERGED box — same outcome for a
    digits-only event, where rejoining is a no-op.
    """
    out: list[_Token] = []
    for item in (result or []):
        if len(item) < 3:
            continue
        try:
            xs = [p[0] for p in item[0]]
            ys = [p[1] for p in item[0]]
            box = (min(xs), min(ys), max(xs), max(ys))
        except (TypeError, ValueError, IndexError):
            box = None  # unparseable box: keep the read, forgo rejoining it
        out.append(_Token(str(item[1]), float(item[2]), box))
    return out


def _rejoin_prefixes(tokens: list[_Token], prefixes: tuple[str, ...]) -> list[_Token]:
    """Glue a lone category letter onto the digits it belongs to.

    "F-0001" comes back as ONE token when printed tight, which needs nothing from
    this. But a bib that prints the letter in its own box, or larger, or in a
    different colour, yields "F" and "0001" separately — verified: rendering
    "F 0001" splits, "F-0001" does not. Without this, such a bib either reads as a
    bare "0001" (merging a 10k woman with the marathon runner who owns that
    number) or not at all.

    Adjacency is judged on the boxes rather than list order, which is not reliably
    left-to-right. Three conditions, all measured relative to the letter's own size
    so they hold at any bib scale:

      * the letter starts before the digits and does not run past their end;
      * they are horizontally close — and note the boxes routinely OVERLAP, since
        RapidOCR pads each region. A real "F 0001" measured (24..188) for the F
        against (142..484) for the digits: a 46px overlap, not a gap. An earlier
        version allowed only 0.2x the letter height of overlap and silently
        refused every split bib because of it;
      * they share most of their height, which is what rules out text on another
        line of the same crop.

    Anything looser starts inventing prefixes from unrelated text elsewhere on the
    torso, which is what the whitelist and these bounds exist to prevent.

    The original tokens are kept alongside the merged one: a bare number is still
    valid at a mixed race, and dropping it would lose the marathon bibs.
    """
    letters = [t for t in tokens
               if t.box and t.text.strip().upper().rstrip(PREFIX_SEP) in prefixes]
    if not letters:
        return tokens
    digits = [t for t in tokens if t.box and t.text.strip().isdigit()]
    merged: list[_Token] = []
    for lead in letters:
        lx1, ly1, lx2, ly2 = lead.box
        lh = max(ly2 - ly1, 1.0)
        lw = max(lx2 - lx1, 1.0)
        for num in digits:
            nx1, ny1, nx2, ny2 = num.box
            if not (lx1 < nx1 and lx2 < nx2):
                continue                       # letter must lead, not straddle
            gap = nx1 - lx2                    # negative means the boxes overlap
            if not (-0.8 * lw <= gap <= 1.5 * max(lw, lh)):
                continue
            if (min(ly2, ny2) - max(ly1, ny1)) < 0.5 * min(lh, max(ny2 - ny1, 1.0)):
                continue
            merged.append(_Token(
                f"{lead.text.strip().upper().rstrip(PREFIX_SEP)}{PREFIX_SEP}{num.text.strip()}",
                # The weaker of the two: a merged bib is only as trustworthy as
                # its least certain half, and the letter decides WHOSE bib it is.
                min(lead.conf, num.conf),
                (min(lx1, nx1), min(ly1, ny1), max(lx2, nx2), max(ly2, ny2)),
            ))
    return tokens + merged


def _tokens_from_paddle(result) -> list[_Token]:
    """PaddleOCR 3.x pages carry rec_texts/rec_scores; 2.x is [[box,(text,score)]].

    Boxes are not extracted here: this is the fallback engine, kept only for
    environments that already have PaddleOCR, and its two result shapes disagree
    about where the box lives. Tokens therefore carry no geometry, so prefix
    rejoining does not apply on this path — a tightly printed "F-0001" still
    reads, a split one does not.
    """
    out: list[_Token] = []
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
            out.extend(_Token(str(t), float(c)) for t, c in zip(texts, scores or []))
            continue
        for line in page or []:
            try:
                out.append(_Token(str(line[1][0]), float(line[1][1])))
            except (IndexError, TypeError, ValueError):
                continue
    return out


def _prefer_prefixed(hits: list[BibHit]) -> list[BibHit]:
    """Drop a bare number when the same digits were also read WITH a prefix.

    Rejoining a split "F 0001" yields both 'F-0001' and the bare '0001' it was
    built from, at identical confidence. Keeping both is not a harmless extra
    guess: at a race where 0001 is a marathon runner and F-0001 is a 10k woman,
    it files her photo under his number, and read_torso's max-by-confidence would
    pick between them arbitrarily.

    The prefixed reading wins because it is strictly more informed — the letter
    was printed right beside those digits in the same crop. A bare number
    elsewhere in the frame keeps its own hit, since its digits differ.
    """
    prefixed_digits = {h.bib.split(PREFIX_SEP, 1)[1] for h in hits if PREFIX_SEP in h.bib}
    if not prefixed_digits:
        return hits
    return [h for h in hits
            if PREFIX_SEP in h.bib or h.bib not in prefixed_digits]


class BibReader:
    def __init__(self, min_digits: int = DEFAULT_MIN_DIGITS,
                 prefixes: "str | tuple[str, ...] | None" = None,
                 max_digits: "int | None" = None) -> None:
        self.engine = None
        self.kind = None
        # Compiled once per run rather than consulted per token: _read runs on
        # every torso crop and every tile of every photo.
        self.min_digits = min_digits
        # Accepts the raw 'F,M' string as stored, or an already-parsed tuple, so
        # callers do not each reimplement the parsing.
        self.prefixes = (parse_prefixes(prefixes) if isinstance(prefixes, str)
                         else tuple(prefixes or ()))
        self.max_digits = min(max(int(max_digits or MAX_DIGITS), 1), MAX_DIGITS)
        self.min_digits = min(self.min_digits, self.max_digits)
        self.bib_re = bib_pattern(min_digits, self.prefixes, self.max_digits)

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

    def _read(self, image: np.ndarray, ref_width: int | None = None) -> list[BibHit]:
        """OCR a region. `ref_width` is the FULL image width, used to reject
        text far too small to be a bib."""
        if image.size == 0 or min(image.shape[:2]) < 12:
            return []
        min_w = (ref_width or image.shape[1]) * MIN_BIB_WIDTH_FRAC
        try:
            if self.kind == "rapidocr":
                result, _ = self.engine(image)
                tokens = _tokens_from_rapidocr(result)
            else:
                try:
                    result = self.engine.predict(image)
                except AttributeError:
                    result = self.engine.ocr(image, cls=False)
                tokens = _tokens_from_paddle(result)
        except Exception as exc:  # noqa: BLE001 - a bad crop must not kill the run
            log.warning("OCR failed on a crop: %s", exc)
            return []

        # Rejoin BEFORE the width gate, because a lone prefix letter is narrower
        # than any bib and would be gone by the time we looked for it. A no-op
        # when the event configures no prefixes.
        if self.prefixes:
            tokens = _rejoin_prefixes(tokens, self.prefixes)

        hits: list[BibHit] = []
        for t in tokens:
            # A merged token's width is its combined box; an unparseable box keeps
            # the read rather than silently dropping it, as before.
            if t.box and t.width < min_w:
                continue
            token = t.text.strip().replace(" ", "")
            if t.conf < MIN_CONF or not self.bib_re.match(token):
                continue
            # normalize_bib is the stored form: digits lose leading zeros, the
            # prefix does NOT — it is which runner this is. Mirrored in bib.ts so
            # the Worker's search resolves to the same string.
            norm = normalize_bib(token)
            if norm:
                hits.append(BibHit(bib=norm, conf=t.conf, raw=token))
        return _prefer_prefixed(hits)

    def read_torso(self, bgr: np.ndarray, face_bbox: tuple[float, float, float, float]) -> BibHit | None:
        h_img, w_img = bgr.shape[:2]
        x, y, w, h = face_bbox
        x1 = int(max(0, x + TORSO_LEFT * w))
        x2 = int(min(w_img, x + TORSO_RIGHT * w))
        y1 = int(max(0, y + TORSO_TOP * h))
        y2 = int(min(h_img, y + TORSO_BOTTOM * h))
        if x2 <= x1 or y2 <= y1:
            return None

        hits = self._read(bgr[y1:y2, x1:x2], ref_width=w_img)
        return max(hits, key=lambda hit: hit.conf) if hits else None

    def read_tiles(self, bgr: np.ndarray, cols: int = 2, rows: int = 2,
                   overlap: float = 0.15) -> list[BibHit]:
        """Whole-frame OCR over overlapping tiles, independent of face detection.

        The torso path can only read a bib belonging to a face the detector
        found. Tiling breaks that dependency, which matters because a single
        detection miss otherwise silently costs a bib too.

        Measured over 12 photos, union with the torso pass: 21 -> 27 distinct
        bibs. Tiling ALONE is a regression (it loses 3 of the torso pass's 21),
        so this supplements rather than replaces. 2x2 beats 3x2 and 4x3 — finer
        grids cut through bibs at tile seams.

        ON TILE RESOLUTION — asked and answered, do not re-litigate without new data.
        The read_full path this replaced downscaled to 2400px first, having measured
        "at native 6000px the text detector finds nothing usable, at 2400px it reads
        bibs reliably". This path is handed the full-resolution frame, so a 2x2 grid
        over a 6000px photo yields ~3450px tiles, which sits between those two
        figures and looked like it might be costing recall.

        Measured against production on 2026-08-11, the Angkor album (26,672 photos,
        bibs enabled): 99.2% have a detected face and 91.2% have a bib. Only 8.0%
        have a face and no bib, and that population is dominated by runners shot from
        behind, occluded, or too distant to read at any resolution. Whatever the tile
        size is doing, it is not the bottleneck — so downscaling here would spend CPU
        on every photo to chase at most a fraction of 8%.
        """
        h, w = bgr.shape[:2]
        tw, th = w // cols, h // rows
        best: dict[str, BibHit] = {}
        for r in range(rows):
            for c in range(cols):
                x1 = max(0, int(c * tw - tw * overlap))
                x2 = min(w, int((c + 1) * tw + tw * overlap))
                y1 = max(0, int(r * th - th * overlap))
                y2 = min(h, int((r + 1) * th + th * overlap))
                if x2 <= x1 or y2 <= y1:
                    continue
                for hit in self._read(bgr[y1:y2, x1:x2], ref_width=w):
                    if hit.bib not in best or hit.conf > best[hit.bib].conf:
                        best[hit.bib] = hit
        return list(best.values())
