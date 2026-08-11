"""End-to-end run() coverage for the continuation decision.

This drives the real run() — the resume filter, the batch loop, the quota
break, the remaining count and the request_continue call — against fake Drive
and Worker clients. It is the only test that exercises those pieces together,
which is where the bug lived: every part was individually correct and the
composition was not.

faces/bibs are stubbed at import time so the test does not need onnxruntime,
insightface or opencv. numpy and Pillow are real, because run() genuinely uses
them and stubbing them would test a different program.
"""
from __future__ import annotations

import os
import sys
import types
from argparse import Namespace

import numpy as np
import pytest


# --- stub the CV modules before indexer.main imports them -------------------

def _install_cv_stubs() -> None:
    # boto3 is imported by upload.py at module scope purely to build an S3
    # client. run()'s Uploader is replaced wholesale by a fake, so the real
    # dependency is never exercised — stub it rather than install 15 MB of AWS
    # SDK into CI for a client that is never called.
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *a, **k: None
    sys.modules.setdefault("boto3", boto3)
    botocore = types.ModuleType("botocore")
    botocore_config = types.ModuleType("botocore.config")
    botocore_config.Config = lambda **k: None
    sys.modules.setdefault("botocore", botocore)
    sys.modules.setdefault("botocore.config", botocore_config)

    faces = types.ModuleType("indexer.faces")

    class _Face:
        def __init__(self):
            self.bbox = [0.0, 0.0, 10.0, 10.0]
            self.embedding = np.zeros(512, dtype=np.float32)
            self.bib = None

    class FaceEngine:
        def __init__(self, det_size=0):
            pass

        def detect(self, _bgr):
            return [_Face()]

    faces.FaceEngine = FaceEngine
    faces.quantize = lambda v: np.zeros(512, dtype=np.int8)
    sys.modules["indexer.faces"] = faces

    bibs = types.ModuleType("indexer.bibs")

    class BibReader:
        def read_torso(self, _bgr, _bbox):
            return None

        def read_tiles(self, _bgr):
            return []

    bibs.BibReader = BibReader
    sys.modules["indexer.bibs"] = bibs


_install_cv_stubs()

from indexer import main as run_mod  # noqa: E402
from indexer.drive import DriveImage, QuotaExceeded  # noqa: E402


# --- fakes ------------------------------------------------------------------


class FakeDrive:
    """Serves `quota_after` photos, then refuses like a throttled Drive."""

    def __init__(self, images, quota_after):
        self._images = images
        self._quota_after = quota_after
        self.served = 0

    def walk(self, _folder_id, max_folders=500):
        return list(self._images)

    def download_thumb(self, file_id, dest):
        if self.served >= self._quota_after:
            raise QuotaExceeded(f"throttled at {self.served}")
        self.served += 1
        # A real 1x1 JPEG, so Pillow's thumbnail/EXIF path runs for real.
        from PIL import Image
        Image.new("RGB", (8, 8), (120, 120, 120)).save(dest, format="JPEG")

    def download(self, file_id, dest):  # pragma: no cover - thumb path only
        raise AssertionError("this scenario indexes with image_source=thumb")


class FakeUploader:
    def __init__(self, indexed_event_wide, bibs_enabled=True):
        self._indexed = set(indexed_event_wide)
        self.continue_requested = False
        self.finalized = []
        self.progress_calls = []
        self.bibs_enabled = bibs_enabled
        self.bib_writes = 0
        self.shard_writes: list[tuple[str, int]] = []
        self.photo_payloads: list[dict] = []
        self.bytes_writes: list[str] = []
        self.bib_replace_photos: list[list[str]] = []
        self.completed: list[str] = []
        self.faces_pending_seen: list[bool] = []

    def event_config(self, _event_id):
        return {"bibs_enabled": self.bibs_enabled}

    def progress(self, job_id, **fields):
        self.progress_calls.append(fields)

    def already_indexed(self, _event_id, complete_only=False):
        return set(self._indexed)

    def set_discovered(self, _source_id, _count):
        pass

    def put_photos(self, _event_id, _source_id, photos, faces_pending=True):
        self.faces_pending_seen.append(faces_pending)
        ids = {}
        for p in photos:
            self.photo_payloads.append(dict(p))
            ids[p["drive_file_id"]] = f"photo-{p['drive_file_id']}"
            self._indexed.add(p["drive_file_id"])
        return ids

    def put_bytes(self, key, _data, _content_type):
        self.bytes_writes.append(key)

    def put_shard(self, key, data):
        # Shards go to the private bucket via the Worker, not S3, so this is a
        # separate call from put_bytes. Recorded so a test can assert that face
        # embeddings never travel the public-bucket path.
        self.shard_writes.append((key, len(data)))

    def mark_photos_complete(self, _event_id, photo_ids):
        self.completed.extend(photo_ids)

    def put_bibs(self, _event_id, _bibs, replace_photos=None):
        self.bib_writes += 1
        self.bib_replace_photos.append(list(replace_photos or []))

    def reserve_rows(self, _event_id, _shard_key, _count):
        return 0

    def put_faces(self, *_a, **_k):
        pass

    def log(self, _event_id, _entries):
        pass

    def request_continue(self, _job_id):
        self.continue_requested = True
        return True

    def finalize(self, _event_id, status):
        self.finalized.append(status)
        return {"photo_count": len(self._indexed), "face_count": 0}


def _args(**over):
    base = dict(
        event_id="qh1VYQ3HGN6I", source_id="0NDnUwvlckbM",
        folder_id="folder-b", job_id="job-1", run_id="run-1",
        bibs_only=False, only_file="", image_source="thumb",
        rebuild=False, no_resume=False,
    )
    base.update(over)
    return Namespace(**base)


def _images(prefix, n):
    return [
        DriveImage(id=f"{prefix}-{i}", name=f"{prefix}-{i}.jpg", mime_type="image/jpeg",
                   size=1_600_000, taken_at=None, width=4000, height=3000)
        for i in range(n)
    ]


@pytest.fixture
def wired(monkeypatch, tmp_path):
    """Patch run()'s collaborators, keeping numpy/Pillow real."""
    def _build(folder_images, indexed_event_wide, quota_after, bibs_enabled=True):
        drive = FakeDrive(folder_images, quota_after)
        up = FakeUploader(indexed_event_wide, bibs_enabled=bibs_enabled)

        cfg = types.SimpleNamespace(
            google_api_key="k", batch_size=25, thumb_max_edge=1000,
            thumb_quality=80, det_size=640, work_dir=str(tmp_path / "work"),
        )
        monkeypatch.setattr(run_mod, "Config", lambda: cfg)
        monkeypatch.setattr(run_mod, "Uploader", lambda _cfg: up)
        monkeypatch.setattr(run_mod, "DriveClient", lambda _key: drive)
        return drive, up

    return _build


def test_continuation_fires_on_a_multi_source_event(wired):
    """The regression, end to end.

    Link B holds 510 photos, 250 already indexed. The event also holds link A's
    601, so already_indexed returns 851. Drive throttles partway through this
    pass. The old code computed 510 - 851 = -341, decided nothing was left and
    never asked to continue, stranding 260 photos.
    """
    folder_b = _images("src2", 510)
    indexed = {f"src1-{i}" for i in range(601)} | {f"src2-{i}" for i in range(250)}

    drive, up = wired(folder_b, indexed, quota_after=60)
    assert run_mod.run(_args()) == 0

    assert up.continue_requested, "a throttled pass with work left must continue"
    assert up.finalized == ["partial"]
    assert drive.served == 60


def test_no_continuation_once_the_folder_is_complete(wired):
    """The guard the scoping fix must not break: a finished folder stops."""
    folder_b = _images("src2", 510)
    indexed = {f"src1-{i}" for i in range(601)} | {f"src2-{i}" for i in range(510)}

    _, up = wired(folder_b, indexed, quota_after=0)
    assert run_mod.run(_args()) == 0

    assert not up.continue_requested
    assert up.finalized == ["ready"]


def test_a_clean_pass_finishes_without_continuing(wired):
    folder_b = _images("src2", 40)
    _, up = wired(folder_b, set(), quota_after=1000)

    assert run_mod.run(_args()) == 0

    assert not up.continue_requested
    assert up.finalized == ["ready"]


def test_summary_reports_the_faces_it_actually_indexed(wired):
    """The counter that always read 0 because the flush had already reset it."""
    logged: list[dict] = []
    folder_b = _images("src2", 30)
    _, up = wired(folder_b, set(), quota_after=1000)
    up.log = lambda _e, entries: logged.extend(entries)

    run_mod.run(_args())

    summary = [e for e in logged if e["code"] == "summary"]
    assert summary, "a finished pass must log a summary"
    # One stubbed face per photo, 30 photos. Matched with a leading space so
    # this does not accidentally pass on the "0 faces" it is guarding against —
    # "30 faces indexed" contains "0 faces indexed".
    assert " 30 faces indexed" in summary[0]["message"]
    assert " 0 faces indexed" not in summary[0]["message"]


def test_an_event_with_no_bibs_skips_bib_work_entirely(wired, monkeypatch):
    """No OCR reader is built and no bib row is written or cleared.

    put_bibs must not be called at all: it sends replace_photos, so calling it
    with an empty payload would delete bibs read before the organizer turned the
    flag off — and those have to survive so turning it back on does not require
    a full re-index.
    """
    built = []
    monkeypatch.setattr(run_mod, "BibReader", lambda: built.append(1))

    _, up = wired(_images("src2", 10), set(), quota_after=1000, bibs_enabled=False)
    assert run_mod.run(_args()) == 0

    assert built == [], "the OCR model must not be loaded when bibs are off"
    assert up.bib_writes == 0, "no bib row may be written or cleared"
    assert up.finalized == ["ready"]


def test_an_event_with_bibs_still_writes_them(wired):
    """The control: the same path with the flag on behaves as before."""
    _, up = wired(_images("src2", 10), set(), quota_after=1000, bibs_enabled=True)
    assert run_mod.run(_args()) == 0

    assert up.bib_writes > 0


def test_bibs_only_pass_refuses_an_event_with_no_bibs(wired):
    _, up = wired(_images("src2", 10), set(), quota_after=1000, bibs_enabled=False)

    assert run_mod.run(_args(bibs_only=True)) == 1
    assert up.finalized == []


def test_config_failure_leaves_bib_reading_on(wired):
    """Fail safe: losing the config call must not silently drop bib data."""
    _, up = wired(_images("src2", 5), set(), quota_after=1000, bibs_enabled=True)
    up.event_config = lambda _e: {}          # as returned when the fetch fails

    assert run_mod.run(_args()) == 0
    assert up.bib_writes > 0


def test_photo_dimensions_come_from_the_decoded_frame_not_drive(wired):
    """photos.width/height must match the array the detector saw.

    The fixtures already encode the exact production divergence: _images() reports
    Drive's imageMediaMetadata as 4000x3000 (the ORIGINAL upload), while
    FakeDrive.download_thumb writes the 8x8 file that actually lands on disk — the
    same relationship as image_source='thumb', where Drive describes a 6000px
    original and the bytes are its w3200 copy.

    faces.bbox is measured on the decoded frame, and PhotoGrid's cropStyle divides
    the two, so storing Drive's numbers put the crop window at a small fraction of
    the frame, in the wrong place, for essentially every face — while the tile
    caption still read "cropped to you". Nothing failed; the crops were just wrong.
    """
    _, up = wired(_images("src2", 3), set(), quota_after=1000)

    assert run_mod.run(_args(image_source="thumb")) == 0
    assert up.photo_payloads, "no photos were sent"

    for p in up.photo_payloads:
        assert (p["width"], p["height"]) == (8, 8), (
            f"{p['drive_file_id']} stored {p['width']}x{p['height']}; expected the "
            "decoded 8x8 frame, not Drive's 4000x3000 metadata"
        )


def test_a_decode_failure_does_not_wipe_that_photos_bibs(wired, monkeypatch):
    """A photo that cannot be decoded must not be claimed as authoritative.

    replace_photos told the Worker "delete every OCR bib on these photos, here are
    the replacements". It was built from photo_ids — every photo whose THUMBNAIL
    succeeded — while the OCR loop only ever visits photos that also DECODED. So a
    photo that thumbnailed and then failed to decode had its existing bibs deleted
    and nothing written back: a silent, permanent loss caused by a transient failure,
    on the data the whole product is a search over.
    """
    _, up = wired(_images("src2", 3), set(), quota_after=1000)

    real_load = run_mod.load_bgr
    victim = "src2-1"

    def flaky(path):
        # dest is os.path.join(work_dir, drive_file_id), so the basename is the id.
        if os.path.basename(path) == victim:
            return None
        return real_load(path)

    monkeypatch.setattr(run_mod, "load_bgr", flaky)

    assert run_mod.run(_args()) == 0

    claimed = [pid for call in up.bib_replace_photos for pid in call]
    assert claimed, "no bibs were written at all"
    assert f"photo-{victim}" not in claimed, (
        "the undecodable photo was claimed as authoritative, so its existing bibs "
        "were deleted with no replacement"
    )
    # The photos that DID decode must still be replaced, or a re-read could never
    # retract a wrong number.
    assert "photo-src2-0" in claimed
    assert "photo-src2-2" in claimed


def test_a_decode_failure_is_journalled_for_the_organizer(wired, monkeypatch):
    """log.warning goes to CI output the organizer cannot reach; note() reaches them."""
    _, up = wired(_images("src2", 2), set(), quota_after=1000)
    entries: list[dict] = []
    up.log = lambda _event_id, es: entries.extend(es)

    monkeypatch.setattr(run_mod, "load_bgr", lambda _p: None)
    assert run_mod.run(_args()) == 0

    codes = [e.get("code") for e in entries]
    assert "decode_failed" in codes, f"decode failures were not journalled: {codes}"


def test_bibs_only_does_not_rewrite_thumbnails(wired):
    """--bibs-only promises it "leaves photos, faces and shards untouched".

    It re-read numbers but still ran a LANCZOS resize and a billed class-A PutObject
    per photo, to upload bytes byte-identical to the ones already in R2 — 8,523 of
    each on the largest album.
    """
    _, up = wired(_images("src2", 4), set(), quota_after=1000)

    assert run_mod.run(_args(bibs_only=True)) == 0

    assert up.bytes_writes == [], (
        f"a bibs-only pass re-uploaded {len(up.bytes_writes)} thumbnails"
    )
    # It must still map ids, or it has nothing to attach bibs to.
    assert up.photo_payloads, "no photos were sent, so no bibs could be written"
    # ...and must not claim dimensions it never measured.
    for payload in up.photo_payloads:
        assert "width" not in payload and "height" not in payload


def test_a_normal_pass_still_writes_thumbnails(wired):
    """Guard against the bibs-only skip leaking into the ordinary path."""
    _, up = wired(_images("src2", 3), set(), quota_after=1000)

    assert run_mod.run(_args()) == 0
    assert len(up.bytes_writes) == 3
    assert all(k.startswith("thumbs/") for k in up.bytes_writes)


# --- faces_done: the resume key means "vectors are durable" ------------------


def test_a_clean_pass_marks_every_processed_photo_complete(wired):
    _, up = wired(_images("src2", 4), set(), quota_after=1000)

    assert run_mod.run(_args()) == 0
    assert sorted(up.completed) == [f"photo-src2-{i}" for i in range(4)]
    # Ordinary pass: it IS going to rewrite these photos' vectors.
    assert up.faces_pending_seen == [True]


def test_a_photo_with_no_faces_is_still_marked_complete(wired, monkeypatch):
    """The trap this flag has to avoid.

    A photo the detector found nobody in produces no face row, so anything keyed on
    "has faces" treats it as unfinished forever and re-downloads it on every pass.
    That population is large enough that the quality report headlines it, and it is
    exactly why --rebuild must stay off the automatic continuation path.
    """
    import indexer.faces as faces_mod
    monkeypatch.setattr(faces_mod.FaceEngine, "detect", lambda self, _bgr: [])

    _, up = wired(_images("src2", 3), set(), quota_after=1000)
    assert run_mod.run(_args()) == 0

    assert up.shard_writes == [], "no faces, so nothing should have been sharded"
    assert sorted(up.completed) == [f"photo-src2-{i}" for i in range(3)], (
        "photos with no detected face were left unfinished and would be "
        "re-downloaded on every subsequent pass"
    )


def test_an_interrupted_batch_leaves_its_photos_unfinished(wired):
    """The bug, stated as a test.

    put_photos commits rows at the top of the batch; the vectors land at the bottom.
    If anything in between dies, those photos must NOT be claimed as done — the old
    resume key ("a row exists") skipped them forever while finalize still reported
    the event ready.
    """
    _, up = wired(_images("src2", 3), set(), quota_after=1000)

    def boom(*_a, **_k):
        raise RuntimeError("runner reclaimed mid-flush")

    up.put_faces = boom

    # run() propagates; main() is what turns this into a failed job. Either way the
    # batch must not have claimed completion.
    with pytest.raises(RuntimeError, match="runner reclaimed"):
        run_mod.run(_args())

    assert up.completed == [], (
        "photos were marked complete despite the vector flush failing, so a later "
        "pass would skip them and they would never get faces"
    )


def test_bibs_only_neither_completes_nor_reopens_photos(wired):
    """--bibs-only touches numbers, never faces.

    Claiming faces_pending would reset faces_done across an already-indexed album
    and send the next resume back to Drive for all of it; claiming completion would
    assert something about vectors this pass never looked at.
    """
    _, up = wired(_images("src2", 4), set(), quota_after=1000)

    assert run_mod.run(_args(bibs_only=True)) == 0
    assert up.faces_pending_seen == [False]
    assert up.completed == []
