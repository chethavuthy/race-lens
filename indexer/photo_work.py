"""The per-photo core: decode, detect, read bibs. One copy, two callers.

main.py runs this for real and bench_pipeline.py measures it, and until now the
harness held a TRANSCRIPTION of the loop rather than the loop itself. That is a
liability with a short shelf life: the first change to main.py that is not
mirrored here leaves the benchmark measuring a pipeline that no longer exists,
and it would keep reporting confidently while doing it.

The function returns plain data — no photo_id, no row_idx, no shard position.
That is deliberate and it is the safety property the parallel path depends on.
A worker holds one photo and cannot know how many faces the photos before it
produced, so it must not be the thing that decides where its faces land. The
caller assigns every row, in order, and stays the only place that touches the
accumulator.

Both callers use the SAME assembler over these results, so the sequential and
parallel paths cannot drift apart in what they build, only in how fast.
"""
from __future__ import annotations

import logging

from .bibs import BibReader
from .faces import FaceEngine, quantize
from .timing import Stages

log = logging.getLogger(__name__)

# One engine set per worker process, built once in the Pool initializer. Module
# globals because that is the only state a Pool worker carries between tasks.
_ENGINE: "FaceEngine | None" = None
_READER: "BibReader | None" = None


def init_worker(det_size: int, bib_kwargs: "dict | None") -> None:
    """Pool initializer. bib_kwargs None means this event reads no bibs at all,
    in which case no OCR engine is built rather than one being built and skipped."""
    global _ENGINE, _READER
    _ENGINE = FaceEngine(det_size=det_size)
    _READER = BibReader(**bib_kwargs) if bib_kwargs is not None else None


def work_photo(task: tuple) -> dict:
    """Pool entry point — the worker's own engines, from the initializer."""
    drive_file_id, path = task
    return process_one(_ENGINE, _READER, drive_file_id, path)


def process_one(engine: FaceEngine, reader: "BibReader | None",
                drive_file_id: str, path: str) -> dict:
    """Everything one photo needs, with no reference to any shared accumulator.

    Engines are passed in rather than taken from the globals above so that the
    sequential path keeps working exactly as it did — including under the tests,
    which install their own fakes on the modules and would never reach a
    worker's globals.
    """
    # Imported here, not at module scope: main imports THIS module, so a
    # top-level import back into it is a cycle.
    from .main import load_bgr

    st = Stages()
    with st.timed("decode_s"):
        bgr = load_bgr(path)
    if bgr is None:
        return {"drive_file_id": drive_file_id, "decoded": False,
                "faces": [], "torso_bibs": [], "tile_bibs": [], "stages": st.as_dict()}
    return process_frame(engine, reader, drive_file_id, bgr, st)


def process_frame(engine: FaceEngine, reader: "BibReader | None",
                  drive_file_id: str, bgr, st: "Stages | None" = None) -> dict:
    """The same work, on a frame somebody else has already decoded.

    Exists so the caller that made the THUMBNAIL from this frame does not have
    to decode the file a second time to look at it. The two used to be separate
    loops — make_thumbnail opened, EXIF-rotated and converted the file, then
    load_bgr opened, EXIF-rotated and converted the identical file again — and
    they were separate only because put_photos had to return photo_ids before
    faces could be attributed to anything.

    The frame is the caller's to release. It is the only large object here, and
    holding a batch of them is the ~1.8 GB OOM that main.py's batch loop is
    written to avoid.
    """
    st = st if st is not None else Stages()

    with st.timed("detect_s"):
        faces = engine.detect(bgr)

    out_faces: list = []
    torso_bibs: list = []
    for face in faces:
        hit = None
        if reader is not None:
            with st.timed("torso_ocr_s"):
                hit = reader.read_torso(bgr, face.bbox)
        bib = None
        if hit:
            bib = hit.bib
            torso_bibs.append({"bib": hit.bib, "raw": hit.raw, "conf": hit.conf})
        out_faces.append({
            "bbox": tuple(face.bbox),
            "det_score": float(face.det_score),
            # Quantized here, in the worker: it is the form the shard stores, and
            # it is 512 bytes against the 2 KB the float32 vector would cost to
            # send back from another process.
            "q": quantize(face.embedding),
            "bib": bib,
        })

    tile_bibs: list = []
    if reader is not None:
        with st.timed("tile_ocr_s"):
            tiles = reader.read_tiles(bgr)
        tile_bibs = [{"bib": h.bib, "raw": h.raw, "conf": h.conf} for h in tiles]

    # Released here rather than at the end of the batch — the reason main.py
    # stopped holding decoded frames at all (a batch of 25 at 6000x4000 is
    # ~1.8 GB, and the OOM lands mid-batch, which is exactly the interruption
    # that strands photos with no faces).
    del bgr
    return {"drive_file_id": drive_file_id, "decoded": True, "faces": out_faces,
            "torso_bibs": torso_bibs, "tile_bibs": tile_bibs, "stages": st.as_dict()}
