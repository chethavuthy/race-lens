"""The background thumbnail uploader.

The property that matters is not speed — it is that a failure still fails the
pass. photos rows name a thumb_key, so an upload that is quietly dropped leaves
the album showing a broken image, permanently, because the photo is already
marked done and indexing resumes past it.
"""
from __future__ import annotations

import threading
import time

import pytest

from indexer.uploads import BackgroundUploader


def test_uploads_overlap_the_caller():
    """Eight 20ms uploads across four threads: ~40ms overlapped, 160ms serial."""
    def put(key, data, content_type):
        time.sleep(0.02)

    t0 = time.perf_counter()
    with BackgroundUploader(put, workers=4) as up:
        for i in range(8):
            up.put(f"k{i}", b"x")
        up.join()
    assert time.perf_counter() - t0 < 0.12


def test_join_waits_for_every_upload():
    done = []
    lock = threading.Lock()

    def put(key, data, content_type):
        time.sleep(0.01)
        with lock:
            done.append(key)

    with BackgroundUploader(put, workers=3) as up:
        for i in range(9):
            up.put(f"k{i}", b"x")
        up.join()
        assert len(done) == 9, "join returned with uploads still in flight"


def test_a_failed_upload_fails_the_pass_rather_than_vanishing():
    def put(key, data, content_type):
        if key == "k3":
            raise RuntimeError("r2 said no")

    with BackgroundUploader(put, workers=2) as up:
        for i in range(6):
            up.put(f"k{i}", b"x")
        with pytest.raises(RuntimeError, match="r2 said no"):
            up.join()


def test_every_upload_is_awaited_even_when_one_fails():
    """A straggler that lands after the pass has given up would write an object
    nothing points at, and on a retry would be written twice."""
    finished = []
    lock = threading.Lock()

    def put(key, data, content_type):
        if key == "k0":
            raise RuntimeError("first one fails")
        time.sleep(0.03)
        with lock:
            finished.append(key)

    with BackgroundUploader(put, workers=4) as up:
        for i in range(4):
            up.put(f"k{i}", b"x")
        with pytest.raises(RuntimeError):
            up.join()
    assert sorted(finished) == ["k1", "k2", "k3"]


def test_the_uploader_can_be_reused_for_the_next_batch():
    seen = []

    def put(key, data, content_type):
        seen.append(key)

    with BackgroundUploader(put, workers=2) as up:
        up.put("a", b"x")
        up.join()
        up.put("b", b"x")
        up.join()
    assert sorted(seen) == ["a", "b"]
