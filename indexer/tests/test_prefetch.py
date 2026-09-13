"""The overlapping downloader: does it overlap, stay in order, and stay bounded.

Order is the one that can corrupt something. row_idx is taken from
len(embeddings) as each face is appended, so the order photos are handed to the
processing loop decides the shard's byte layout. A downloader that returns
photos as they happen to arrive would quietly reorder the index.

No network: `download` is a plain callable, which is the reason it is a
parameter rather than a DriveClient.
"""
from __future__ import annotations

import threading
import time

import pytest

from indexer.prefetch import Prefetcher


def test_order_is_exactly_the_order_given_even_when_downloads_finish_out_of_order():
    # The first photo is the slowest, so a downloader that yielded by completion
    # would put it last. It must still come first.
    delays = {"a": 0.06, "b": 0.01, "c": 0.01}

    def download(img):
        time.sleep(delays[img])
        return f"/tmp/{img}"

    got = list(Prefetcher(download, depth=3).stream(["a", "b", "c"]))
    assert [img for img, _ in got] == ["a", "b", "c"]
    assert [path for _, path in got] == ["/tmp/a", "/tmp/b", "/tmp/c"]


def test_downloading_actually_overlaps_the_consumer():
    """The entire point. Six photos, 20ms to fetch and 20ms to process each.

    Serialised that is ~240ms; overlapped it is ~140ms (the consumer's 120ms
    plus the first download). The assertion is deliberately loose — this runs on
    a shared CI runner — but 200ms still cannot be reached without real overlap.
    """
    def download(img):
        time.sleep(0.02)
        return f"/tmp/{img}"

    t0 = time.perf_counter()
    for _ in Prefetcher(download, depth=3).stream(list("abcdef")):
        time.sleep(0.02)
    assert time.perf_counter() - t0 < 0.20


def test_never_holds_more_than_depth_files_ahead():
    """Disk is what caps a batch — a runner has ~14 GB and a full-size photo is
    ~21 MB — so the read-ahead has to be bounded rather than racing to the end."""
    live = 0
    peak = 0
    lock = threading.Lock()

    def download(img):
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        return f"/tmp/{img}"

    for _ in Prefetcher(download, depth=2).stream(list("abcdefgh")):
        with lock:
            live -= 1        # the consumer "uses up" one file
        time.sleep(0.01)
    # depth in the queue, plus the one the worker is handing over.
    assert peak <= 3, f"read ahead by {peak}, expected at most depth+1"


def test_a_download_failure_reaches_the_consumer_rather_than_vanishing():
    def download(img):
        if img == "b":
            raise RuntimeError("drive said no")
        return f"/tmp/{img}"

    stream = Prefetcher(download, depth=1).stream(["a", "b", "c"])
    assert next(stream)[0] == "a"
    with pytest.raises(RuntimeError, match="drive said no"):
        next(stream)


def test_stopping_early_does_not_leave_the_downloader_wedged():
    """A quota hit or a stop request abandons the stream mid-album. The worker
    is then blocked putting into a full queue, and must still be able to exit."""
    def download(img):
        return f"/tmp/{img}"

    before = threading.active_count()
    stream = Prefetcher(download, depth=2).stream(list("abcdefghij"))
    assert next(stream)[0] == "a"
    stream.close()                       # consumer walks away
    deadline = time.time() + 2.0
    while threading.active_count() > before and time.time() < deadline:
        time.sleep(0.02)
    assert threading.active_count() <= before, "prefetch thread outlived its consumer"
