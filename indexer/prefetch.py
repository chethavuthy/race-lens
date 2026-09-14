"""Download the next photos while the current one is being worked on.

Downloading is ~1.09 s/photo against ~7.8 s/photo of CPU work, and today the
two take turns: a batch downloads, then the batch is processed, then the next
batch downloads. Nothing about that is required. The download is waiting on
Drive and the network; the processing is waiting on the CPU. Overlapping them
costs the pass nothing and saves the whole download time — ~12% of the album
on `thumb`, and far more on `original`, where the files are ~12x larger.

ON NOT MAKING THIS A PARALLEL DOWNLOADER
The obvious version fires 3-4 requests at once. This deliberately does not, and
the distinction matters more than the extra few percent: Drive answers a popular
album with downloadQuotaExceeded, and a quota hit ends the pass as `partial`.
ONE worker thread issuing ONE request at a time leaves Drive seeing exactly the
request rate it sees today — the same number of requests, in the same order, no
closer together than the CPU allows. The win here comes from overlap with the
CPU, not from concurrency against Drive, so the risk that got this idea ranked
last does not have to be taken to collect it.

`depth` bounds how many files sit on disk ahead of the consumer, because disk is
what caps a batch: a runner holds ~14 GB and a full-size photo is ~21 MB.
"""
from __future__ import annotations

import logging
import queue
import threading
from typing import Callable, Iterable, Iterator

log = logging.getLogger(__name__)

# Sentinels. A private object rather than None, so that a legitimately falsy
# item can never be mistaken for the end of the stream.
_DONE = object()


class Prefetcher:
    """Runs `download` on a background thread, one file at a time.

    download(image) -> path, or raises. Exceptions are carried back to the
    consumer rather than killing the thread silently: a downloader that dies
    quietly leaves the consumer blocked on a queue that will never fill again,
    which is the same hang as a lost Pool worker and just as hard to read.
    """

    def __init__(self, download: Callable, depth: int = 2) -> None:
        if depth < 1:
            raise ValueError("depth must be at least 1")
        self.download = download
        self.depth = depth

    def stream(self, images: Iterable) -> Iterator[tuple]:
        """Yield (image, path) in the SAME ORDER as `images`.

        Order is not an implementation detail here. Downstream, row_idx is taken
        from len(embeddings) as each face is appended, so the order photos are
        handed over in decides the shard's byte layout. One worker and a FIFO
        queue keep that identical to the sequential version.
        """
        items = list(images)
        q: queue.Queue = queue.Queue(maxsize=self.depth)

        def worker() -> None:
            try:
                for img in items:
                    try:
                        path = self.download(img)
                    except Exception as exc:  # noqa: BLE001
                        # Carried, not raised here: this thread has no caller to
                        # raise to, and the consumer is the half that knows
                        # whether this photo is worth stopping the pass for.
                        q.put((img, None, exc))
                        continue
                    q.put((img, path, None))
            finally:
                # In a finally, so an unexpected failure anywhere above still
                # releases the consumer instead of hanging the pass.
                q.put(_DONE)

        thread = threading.Thread(target=worker, name="prefetch", daemon=True)
        thread.start()
        try:
            while True:
                item = q.get()
                if item is _DONE:
                    return
                img, path, exc = item
                if exc is not None:
                    raise exc
                yield img, path
        finally:
            # A consumer that stops early (a quota hit, a stop request) leaves
            # the worker blocked on a full queue. Drain it so the thread can
            # reach _DONE and exit rather than surviving as a daemon holding a
            # Drive connection open.
            while thread.is_alive():
                try:
                    q.get_nowait()
                except queue.Empty:
                    thread.join(timeout=0.1)
