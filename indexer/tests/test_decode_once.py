"""decode_once must equal make_thumbnail + load_bgr, byte for byte.

Those two opened the SAME file and did the SAME three things to it — open,
EXIF-transpose, convert to RGB — one after the other, in two separate loops.
Merging them removes a whole JPEG decode per photo. It is only safe if the
merged version is indistinguishable from the pair, and there is one ordering
that makes it unsafe: thumbnail() shrinks the image IN PLACE, so taking the
array afterwards would hand the detector a 1000px frame while photos.width/height
still described the full one. Every face box would then be measured in a space
the client does not divide by, and the "cropped to you" tile would land
somewhere else entirely — which is a bug that looks fine in every log.

EXIF orientation is exercised because it is the case where width and height
swap, and where getting the order wrong is least obvious.
"""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image


MAX_EDGE, QUALITY = 1000, 80


def _fns():
    """Imported inside the tests, not at module scope.

    indexer.main binds FaceEngine with `from .faces import FaceEngine`, so the
    fake that test_run_continuation installs only reaches it if indexer.main is
    first imported AFTER that module is collected. This file sorts earlier, so a
    top-level import here locks the real class in and breaks 20 tests in a file
    that never mentions this one.
    """
    from indexer.main import decode_once, load_bgr, make_thumbnail

    return decode_once, load_bgr, make_thumbnail


def _write(path, w, h, orientation=None):
    """A deterministic, non-uniform image — a flat colour would hide a transpose."""
    rng = np.random.RandomState(7)
    arr = rng.randint(0, 255, (h, w, 3), dtype=np.uint8)
    im = Image.fromarray(arr)
    kw = {}
    if orientation is not None:
        exif = im.getexif()
        exif[0x0112] = orientation
        kw["exif"] = exif
    im.save(path, format="JPEG", quality=95, **kw)
    return path


@pytest.mark.parametrize("orientation", [None, 1, 6, 8])
def test_decode_once_matches_the_two_functions_it_replaces(tmp_path, orientation):
    p = _write(tmp_path / "f.jpg", 1400, 900, orientation)

    decode_once, load_bgr, make_thumbnail = _fns()
    thumb_a, w_a, h_a = make_thumbnail(str(p), MAX_EDGE, QUALITY)
    bgr_a = load_bgr(str(p))

    thumb_b, w_b, h_b, bgr_b = decode_once(str(p), MAX_EDGE, QUALITY)

    assert (w_b, h_b) == (w_a, h_a), "reported frame size diverged"
    assert thumb_b == thumb_a, "thumbnail bytes diverged"
    assert np.array_equal(bgr_b, bgr_a), "decoded frame diverged"


def test_the_frame_is_full_size_not_the_thumbnail(tmp_path):
    """The ordering trap, asserted directly.

    faces.bbox is measured in the returned frame's pixels and photos.width/height
    record that same frame. If the array were taken after thumbnail(), these
    would disagree and every crop would be wrong while nothing errored.
    """
    decode_once = _fns()[0]
    p = _write(tmp_path / "big.jpg", 2400, 1600)
    _, w, h, bgr = decode_once(str(p), MAX_EDGE, QUALITY)
    assert (w, h) == (2400, 1600)
    assert bgr.shape[:2] == (h, w), "frame and reported dimensions must be one space"


def test_a_rotated_portrait_reports_the_rotated_size(tmp_path):
    """Orientation 6 turns a 1400x900 upload into a 900x1400 frame. The detector
    only finds faces in the rotated frame, so the rotated size is the true one."""
    decode_once = _fns()[0]
    p = _write(tmp_path / "rot.jpg", 1400, 900, orientation=6)
    _, w, h, bgr = decode_once(str(p), MAX_EDGE, QUALITY)
    assert (w, h) == (900, 1400)
    assert bgr.shape[:2] == (1400, 900)
