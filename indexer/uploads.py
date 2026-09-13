"""Send thumbnails to R2 while the CPU gets on with the next photo.

A thumbnail upload is a network round trip that the pass currently stands still
for: encode, PUT, wait, then start detecting faces in the next photo. The CPU is
idle for the PUT and the network is idle for the detection, and nothing requires
them to take turns.

Unlike the Drive downloads, there is no quota argument for keeping this to one
request at a time — the bucket is ours. A small pool is used instead.

WHAT MUST NOT BE OVERLAPPED IS THE ORDERING
photos rows are written by put_photos, and a row names a thumb_key. If the row
lands before the object does, the album shows a broken image; if the pass then
dies, it shows one permanently, because indexing is resume-based and that photo
is already marked. So join() is called BEFORE put_photos, every batch. The
overlap being bought here is with the DECODE AND OCR of the following photos,
which is the expensive part, not with the database write.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor

log = logging.getLogger(__name__)


class BackgroundUploader:
    """Fire-and-collect uploads, with every failure surfaced at join().

    Failures are re-raised rather than logged, which keeps the behaviour the
    synchronous version had: a thumbnail that cannot be written fails the pass
    instead of leaving a row pointing at an object that was never created. It
    simply happens at the end of the batch rather than in the middle of it.
    """

    def __init__(self, put_bytes, workers: int = 4) -> None:
        self.put_bytes = put_bytes
        self._pool = ThreadPoolExecutor(max_workers=workers,
                                        thread_name_prefix="thumb-upload")
        self._pending: list = []
        self._lock = threading.Lock()

    def put(self, key: str, data: bytes, content_type: str = "image/webp") -> None:
        fut: Future = self._pool.submit(self.put_bytes, key, data, content_type)
        with self._lock:
            self._pending.append((key, fut))

    def join(self) -> None:
        """Block until every queued upload has finished. Raises the first error.

        Drains `_pending` so the uploader can be reused for the next batch —
        a batch that raised has already ended the pass, so nothing is lost by
        clearing it here.
        """
        with self._lock:
            pending, self._pending = self._pending, []
        first: "BaseException | None" = None
        for key, fut in pending:
            try:
                fut.result()
            except BaseException as exc:  # noqa: BLE001
                # Every future is waited on even after one fails: leaving the
                # rest running would let an upload land after the pass has
                # decided it failed.
                log.error("Thumbnail upload failed for %s: %s", key, exc)
                if first is None:
                    first = exc
        if first is not None:
            raise first

    def close(self) -> None:
        self._pool.shutdown(wait=True)

    def __enter__(self) -> "BackgroundUploader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
