"""make_thumbnail must report the DECODED FRAME's size, not the thumbnail's.

photos.width/height are the denominator the browser divides faces.bbox by to crop
a result tile to the runner who matched (the result tile's crop). So the two must
share one coordinate space, and that space is whatever array the detector saw —
i.e. the file on disk, decoded, after EXIF rotation.

Both ways of getting that wrong shipped at once:

  * Drive's imageMediaMetadata was preferred, and it describes the ORIGINAL upload
    pre-rotation. A portrait frame came back 6000x4000, so the tile reserved a
    landscape box and object-fit: cover cropped the runner's head off.
  * With image_source='thumb' the bytes on disk are Drive's w3200 copy, so Drive's
    6000px numbers were ~1.9x too large and the crop window landed at roughly 4% of
    the frame, in the wrong place, for essentially every face.

The falling-back-to-the-thumbnail's-own-size variant is just as wrong, in the other
direction, which is what the first test pins.
"""
from __future__ import annotations

from PIL import Image

from indexer.main import make_thumbnail

EXIF_ORIENTATION = 274


def test_reports_the_full_frame_not_the_downscaled_thumbnail(tmp_path):
    src = tmp_path / "big.jpg"
    Image.new("RGB", (2000, 1000), "red").save(src, "JPEG")

    thumb, w, h = make_thumbnail(str(src), max_edge=500, quality=80)

    # The dimensions describe the frame detection runs on, not the 500px preview.
    assert (w, h) == (2000, 1000)
    # ...and the bytes really were downscaled, so these are not just echoing input.
    with Image.open(__import__("io").BytesIO(thumb)) as out:
        assert max(out.size) == 500


def test_reports_post_exif_rotation_dimensions(tmp_path):
    """Orientation 6 means "rotate 90 deg CW to display", so 100x50 displays 50x100.

    load_bgr() applies the same exif_transpose, so bboxes land in the ROTATED
    space. Reporting the stored 100x50 inverts the aspect ratio and the masonry
    column-height prediction along with it.

    Note this one does NOT reproduce the original defect — make_thumbnail already
    transposed before measuring, and the rotation half of the bug was in main.py
    preferring Drive's pre-rotation metadata (guarded by
    test_photo_dimensions_come_from_the_decoded_frame_not_drive). It guards against
    a future change that drops exif_transpose or measures before it.
    """
    src = tmp_path / "portrait.jpg"
    im = Image.new("RGB", (100, 50), "blue")
    exif = im.getexif()
    exif[EXIF_ORIENTATION] = 6
    im.save(src, "JPEG", exif=exif.tobytes())

    _thumb, w, h = make_thumbnail(str(src), max_edge=1000, quality=80)

    assert (w, h) == (50, 100), "dimensions must be post-exif_transpose"


def test_agrees_with_what_load_bgr_hands_the_detector(tmp_path):
    """The invariant, stated directly: make_thumbnail's dims == load_bgr's shape.

    This is the one that matters. Any future change that reads dimensions from a
    different source than the decoded array breaks the crop, and this fails.
    """
    from indexer.main import load_bgr

    src = tmp_path / "rotated.jpg"
    im = Image.new("RGB", (120, 60), "green")
    exif = im.getexif()
    exif[EXIF_ORIENTATION] = 6
    im.save(src, "JPEG", exif=exif.tobytes())

    _thumb, w, h = make_thumbnail(str(src), max_edge=1000, quality=80)
    bgr = load_bgr(str(src))

    assert bgr is not None
    assert (h, w) == bgr.shape[:2], "photos.width/height must match the detector's array"
