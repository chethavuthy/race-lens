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

    def event_config(self, _event_id):
        return {"bibs_enabled": self.bibs_enabled}

    def progress(self, job_id, **fields):
        self.progress_calls.append(fields)

    def already_indexed(self, _event_id, complete_only=False):
        return set(self._indexed)

    def set_discovered(self, _source_id, _count):
        pass

    def put_photos(self, _event_id, _source_id, photos):
        ids = {}
        for p in photos:
            ids[p["drive_file_id"]] = f"photo-{p['drive_file_id']}"
            self._indexed.add(p["drive_file_id"])
        return ids

    def put_bytes(self, *_a, **_k):
        pass

    def put_shard(self, key, data):
        # Shards go to the private bucket via the Worker, not S3, so this is a
        # separate call from put_bytes. Recorded so a test can assert that face
        # embeddings never travel the public-bucket path.
        self.shard_writes.append((key, len(data)))

    def put_bibs(self, *_a, **_k):
        self.bib_writes += 1

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
