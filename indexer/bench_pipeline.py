"""Speed + equivalence harness for the per-photo indexing pipeline.

    python -m indexer.bench_pipeline --folder-id F --sample 40 --label baseline

WHAT THIS IS FOR
The indexing pass costs ~7.85 s/photo, which is ~4.1 h for a 1,881-photo album
against a 5.5 h runner timeout. The optimisations that close that gap all
reorder or parallelise work, and the product they must not damage is bib recall.
So every change is measured twice: how much faster, and whether a single face,
bib or embedding moved. This harness produces both numbers in one run.

WHY IT IS NOT indexer/benchmark.py
That one answers a different question — whether Drive's resized copy reads the
same bibs as the full original. It writes its verdict to the API. This one
answers "where does the time go, and did the answers change", writes NOTHING
anywhere, and needs only GOOGLE_API_KEY. Deliberately: a harness that can write
to production is a harness nobody dares run often.

WHY IT MIRRORS main.py's LOOP STRUCTURE RATHER THAN CALLING IT
main.py's run() is welded to D1, R2 and the job lifecycle, and cannot execute
without writing to all three. The per-photo core below is a transcription of it
— same order, same calls, same arguments. That transcription is the harness's
one real liability: if main.py's loop changes and this does not, the harness
measures a pipeline that no longer exists. Anything moved in main.py must be
moved here in the same commit.

DETERMINISM
The CPU pipeline is deterministic, so a comparison between two runs is an EXACT
diff and any difference is a bug rather than noise. That only holds on identical
hardware — onnxruntime on arm64 macOS does not produce x86 Linux's bits — so
this is meant to run on the same ubuntu-latest runner the real pass uses.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import platform
import sys
import time

import numpy as np

from .bibs import BibReader
from .drive import DriveClient, QuotaExceeded
from .faces import FaceEngine, quantize
from .main import load_bgr, make_thumbnail
from .timing import Stages

log = logging.getLogger("bench")


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def pick_sample(images: list, sample: int) -> list:
    """A fixed, reproducible subset of the folder.

    Sorted by (name, id) before spreading so the selection does not depend on
    Drive's listing order, which is not contractual. Spread across the album
    rather than taken from the front: the opening frames are usually the start
    line, where everyone is bunched and close to the camera, and that is not the
    mid-race photo the detector finds hard.
    """
    ordered = sorted(images, key=lambda i: (i.name or "", i.id))
    if sample <= 0 or sample >= len(ordered):
        return ordered
    step = max(1, len(ordered) // sample)
    return ordered[::step][:sample]


def fetch(drive: DriveClient, images: list, cache: str, image_source: str,
          stages: Stages) -> list:
    """Download into a cache that survives between runs.

    Re-downloading on every run would spend Drive quota that a live indexing
    pass is competing for, and would put network variance into a measurement
    that is trying to isolate CPU work. The cache is keyed by file id and image
    source, so a cached run reports download_s ~= 0 — which is correct, and the
    reason download timing is measured separately rather than folded into the
    total.
    """
    os.makedirs(cache, exist_ok=True)
    out = []
    for img in images:
        dest = os.path.join(cache, f"{img.id}.{image_source}")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            out.append((img, dest))
            continue
        try:
            with stages.timed("download_s"):
                if image_source == "thumb":
                    drive.download_thumb(img.id, dest)
                else:
                    drive.download(img.id, dest)
            out.append((img, dest))
        except QuotaExceeded:
            log.error("Drive quota exceeded after %d photos — benchmarking what we have", len(out))
            break
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping %s (%s): %s", img.name, img.id, exc)
    return out


# One engine set per worker process, built once in the initializer rather than
# per photo. Module-level globals because that is the only thing a Pool worker
# can carry between tasks.
_ENGINE: "FaceEngine | None" = None
_READER: "BibReader | None" = None


def _init_worker(det_size: int) -> None:
    global _ENGINE, _READER
    _ENGINE = FaceEngine(det_size=det_size)
    _READER = BibReader()


def _work_photo(task: tuple) -> dict:
    """The per-photo half of pass 2, with NO shared state.

    Everything this returns is plain data. In particular it returns the
    QUANTIZED embedding bytes rather than a row index: the worker has no idea
    where its faces will land in the shard, and must not — assigning row_idx is
    the parent's job precisely because that is the ordering that must not move.
    """
    drive_file_id, name, path = task
    st = Stages()
    with st.timed("decode_s"):
        bgr = load_bgr(path)
    if bgr is None:
        return {"drive_file_id": drive_file_id, "decoded": False, "stages": st.as_dict()}

    with st.timed("detect_s"):
        faces = _ENGINE.detect(bgr)

    out_faces = []
    torso_bibs = []
    for face in faces:
        with st.timed("torso_ocr_s"):
            hit = _READER.read_torso(bgr, face.bbox)
        bib = None
        if hit:
            bib = hit.bib
            torso_bibs.append({"bib": hit.bib, "raw": hit.raw, "conf": round(hit.conf, 6)})
        q = quantize(face.embedding)
        out_faces.append({
            "bbox": [round(float(v), 2) for v in face.bbox],
            "det_score": round(float(face.det_score), 6),
            "q": q.tobytes(order="C"),
            "bib": bib,
        })

    with st.timed("tile_ocr_s"):
        tiles = _READER.read_tiles(bgr)
    del bgr
    return {
        "drive_file_id": drive_file_id,
        "decoded": True,
        "faces": out_faces,
        "torso_bibs": torso_bibs,
        "tile_bibs": [{"bib": h.bib, "raw": h.raw, "conf": round(h.conf, 6)} for h in tiles],
        "stages": st.as_dict(),
    }


def process_batch(local: list, engine: FaceEngine, reader: BibReader,
                  cfg_thumb_edge: int, cfg_thumb_quality: int,
                  embeddings: list, stages: Stages, pool=None) -> list:
    """One batch, in main.py's exact order.

    Two passes over the batch, and they decode the same files twice — that is
    the real pipeline's shape, not an oversight here. main.py separates them
    because put_photos must return photo_ids before faces can be attributed to
    anything. Collapsing them is optimisation #2, and it has to be measured
    against this.
    """
    # PASS 1 — thumbnail. Decodes every file once.
    thumbs: dict = {}
    for img, path in local:
        try:
            with stages.timed("thumbnail_s"):
                thumb, full_w, full_h = make_thumbnail(path, cfg_thumb_edge, cfg_thumb_quality)
        except Exception as exc:  # noqa: BLE001
            log.warning("Thumbnail failed for %s: %s", img.name, exc)
            continue
        thumbs[img.id] = (_sha1(thumb), full_w, full_h)

    # PASS 2 — decode again, detect, read. This is where row_idx is assigned.
    if pool is not None:
        return _pass2_parallel(local, thumbs, embeddings, stages, pool)

    rows = []
    for img, path in local:
        if img.id not in thumbs:
            continue
        thumb_sha, full_w, full_h = thumbs[img.id]

        with stages.timed("decode_s"):
            bgr = load_bgr(path)
        if bgr is None:
            continue

        with stages.timed("detect_s"):
            faces = engine.detect(bgr)

        face_out = []
        torso_bibs = []
        for face in faces:
            with stages.timed("torso_ocr_s"):
                hit = reader.read_torso(bgr, face.bbox)
            bib = None
            if hit:
                bib = hit.bib
                torso_bibs.append({"bib": hit.bib, "raw": hit.raw, "conf": round(hit.conf, 6)})

            # The lockstep that must survive parallelisation.
            #
            # row_idx is a POSITION in the shard written to R2, and it is taken
            # from len(embeddings) at the instant the embedding is appended. If
            # the two ever disagree nothing crashes and nothing logs: faces
            # simply point at other people's vectors and face search returns
            # strangers. Recording row_idx alongside the embedding's own hash is
            # what lets the diff tool prove, per run, that they still agree.
            q = quantize(face.embedding)
            face_out.append({
                "bbox": [round(float(v), 2) for v in face.bbox],
                "det_score": round(float(face.det_score), 6),
                "emb_sha1": _sha1(q.tobytes(order="C")),
                "row_idx": len(embeddings),
                "bib": bib,
            })
            embeddings.append(q)

        with stages.timed("tile_ocr_s"):
            tiles = reader.read_tiles(bgr)
        tile_bibs = [{"bib": h.bib, "raw": h.raw, "conf": round(h.conf, 6)} for h in tiles]

        rows.append({
            "drive_file_id": img.id,
            "name": img.name,
            "width": full_w,
            "height": full_h,
            "thumb_sha1": thumb_sha,
            "faces": face_out,
            "torso_bibs": torso_bibs,
            "tile_bibs": tile_bibs,
        })
        del bgr
    return rows


def _pass2_parallel(local: list, thumbs: dict, embeddings: list,
                    stages: Stages, pool) -> list:
    """Pass 2 across worker processes, assembled back into ONE order.

    imap, not imap_unordered, and the appends below happen in submission order.
    That is the whole safety argument: row_idx is taken from len(embeddings) at
    the instant the embedding is appended, so as long as the PARENT appends in
    the batch's original order, the shard it builds is not merely equivalent to
    the sequential one — it is identical, byte for byte, and row_idx means the
    same thing it always did.

    The workers never see row_idx. They cannot: a worker holds one photo and has
    no idea how many faces the photos before it produced. Handing them the
    counter is the version of this change that corrupts the index silently.
    """
    tasks = [(img.id, img.name, path) for img, path in local if img.id in thumbs]
    by_id = {img.id: img for img, _ in local}
    rows = []
    for res in pool.imap(_work_photo, tasks):
        # Worker CPU time, summed across processes. Deliberately kept in the
        # same accumulator: the per-stage RANKING stays meaningful, while wall
        # time is measured separately and is the only thing that shows the win.
        stages.merge(res["stages"])
        if not res["decoded"]:
            continue
        drive_file_id = res["drive_file_id"]
        thumb_sha, full_w, full_h = thumbs[drive_file_id]

        face_out = []
        for face in res["faces"]:
            q = np.frombuffer(face["q"], dtype=np.int8)
            face_out.append({
                "bbox": face["bbox"],
                "det_score": face["det_score"],
                "emb_sha1": _sha1(face["q"]),
                "row_idx": len(embeddings),
                "bib": face["bib"],
            })
            embeddings.append(q)

        rows.append({
            "drive_file_id": drive_file_id,
            "name": by_id[drive_file_id].name,
            "width": full_w,
            "height": full_h,
            "thumb_sha1": thumb_sha,
            "faces": face_out,
            "torso_bibs": res["torso_bibs"],
            "tile_bibs": res["tile_bibs"],
        })
    return rows


def run(args: argparse.Namespace) -> int:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise SystemExit("Missing required environment variable: GOOGLE_API_KEY")

    drive = DriveClient(api_key)
    stages = Stages()

    log.info("walking folder %s", args.folder_id)
    images = drive.walk(args.folder_id)
    if not images:
        raise SystemExit("No images in that folder")
    sample = pick_sample(images, args.sample)
    log.info("folder has %d images; benchmarking %d", len(images), len(sample))

    local = fetch(drive, sample, args.cache, args.image_source, stages)
    if not local:
        raise SystemExit("Nothing downloaded")

    # Engines built BEFORE the clock starts. Model load is ~100 MB off disk and
    # a one-off per pass; including it would tax a 40-photo benchmark with a
    # cost the real 1,881-photo pass amortises to nothing.
    #
    # And built in the PARENT only when there are no workers. Pass 1 needs
    # neither engine — it only makes thumbnails — so the parallel path never
    # forks a process that is already holding onnxruntime sessions, which is the
    # classic way a forked worker deadlocks on a lock its parent's threads left
    # held.
    pool = None
    engine = reader = None
    if args.workers > 1:
        import multiprocessing as mp

        pool = mp.Pool(args.workers, initializer=_init_worker, initargs=(args.det_size,))
        log.info("%d worker processes", args.workers)
    else:
        engine = FaceEngine(det_size=args.det_size)
        reader = BibReader()

    embeddings: list = []
    photos: list = []
    wall0 = time.perf_counter()
    try:
        for i in range(0, len(local), args.batch_size):
            batch = local[i : i + args.batch_size]
            photos.extend(process_batch(batch, engine, reader, args.thumb_max_edge,
                                        args.thumb_quality, embeddings, stages, pool))
            log.info("batch %d done (%d photos) | %s",
                     i // args.batch_size, len(batch), stages.summary())
    finally:
        if pool is not None:
            pool.close()
            pool.join()
    wall = time.perf_counter() - wall0

    try:
        import onnxruntime
        ort_version = onnxruntime.__version__
    except Exception:  # noqa: BLE001
        ort_version = "?"

    report = {
        "meta": {
            "commit": os.environ.get("GITHUB_SHA", "")[:12] or "local",
            "label": args.label,
            "det_size": args.det_size,
            "sample": len(local),
            "workers": args.workers,
            "batch_size": args.batch_size,
            "image_source": args.image_source,
            "python": platform.python_version(),
            "onnxruntime": ort_version,
            "cpu_count": os.cpu_count(),
            # Recorded because onnxruntime's thread count is a plausible reason
            # for two runs to disagree at the last bits, and a parallel run must
            # pin it to 1 to avoid oversubscribing 4 vCPUs. If results ever move,
            # this is the first column to check against the sequential baseline.
            "omp_num_threads": os.environ.get("OMP_NUM_THREADS", "unset"),
            "machine": platform.machine(),
        },
        "totals": {
            "photos": len(photos),
            # Wall time is measured, never summed from the stages: once workers
            # run in parallel the stages total CPU time across processes and
            # would overstate the pass by the worker count.
            "wall_s": round(wall, 3),
            "stages": stages.as_dict(),
        },
        "shard": [_sha1(e.tobytes(order="C")) for e in embeddings],
        "photos": photos,
    }

    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=1, sort_keys=True)

    faces = sum(len(p["faces"]) for p in photos)
    log.info("wrote %s", args.out)
    log.info("%d photos, %d faces, %.1fs wall (%.2f s/photo)",
             len(photos), faces, wall, wall / max(len(photos), 1))
    log.info("stages: %s", stages.summary())
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--folder-id", required=True)
    p.add_argument("--sample", type=int, default=40)
    p.add_argument("--label", default="run")
    p.add_argument("--out", default="bench.json")
    p.add_argument("--cache", default="/tmp/bench-cache")
    p.add_argument("--image-source", choices=["thumb", "original"], default="thumb")
    p.add_argument("--det-size", type=int, default=int(os.environ.get("DET_SIZE", "2048")))
    p.add_argument("--batch-size", type=int, default=int(os.environ.get("BATCH_SIZE", "25")))
    p.add_argument("--thumb-max-edge", type=int, default=1000)
    p.add_argument("--thumb-quality", type=int, default=80)
    # Accepted now, honoured by optimisation #1. Recorded in the report from the
    # start so a baseline and a parallel run are labelled distinguishably.
    p.add_argument("--workers", type=int, default=1)
    return run(p.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
