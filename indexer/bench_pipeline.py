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
import shutil
import sys
import tempfile
import time

import numpy as np

from .bibs import BibReader
from .drive import DriveClient, QuotaExceeded
from .faces import FaceEngine
from .main import decode_once, make_thumbnail
from .photo_work import init_worker, process_frame, process_one, work_photo
from .prefetch import Prefetcher
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


def _assemble(results, thumbs: dict, names: dict, embeddings: list,
              stages: Stages) -> list:
    """Turn per-photo results into rows, assigning every shard position here.

    This is the ONLY place row_idx is produced, and both the sequential and the
    parallel path feed it the same kind of result in the same order — so the two
    paths cannot build different shards, only take different amounts of time to
    build the same one.

    row_idx comes from len(embeddings) at the moment the embedding is appended,
    exactly as the real pass does it. Keeping those two statements adjacent, in
    one place, under one caller, is the whole defence: split them across workers
    and faces start pointing at other people's vectors with nothing raised and
    nothing logged.
    """
    rows = []
    # A heartbeat, because a Pool that loses a worker during init does not raise
    # — imap simply never yields again, and the run sits there looking like slow
    # work until the job timeout kills it 90 minutes later. A per-photo line is
    # the difference between "it is slow" and "it is stuck", and the two want
    # opposite responses.
    t0 = time.perf_counter()
    for n, res in enumerate(results, 1):
        # Worker CPU time, summed across processes. The per-stage RANKING stays
        # meaningful; wall time is measured separately and is the only thing
        # that shows the win.
        stages.merge(res["stages"])
        log.info("photo %d/%d  %s  %.1fs elapsed  (%d faces)",
                 n, len(thumbs), res["drive_file_id"][:12],
                 time.perf_counter() - t0, len(res.get("faces") or []))
        drive_file_id = res["drive_file_id"]
        if not res["decoded"] or drive_file_id not in thumbs:
            continue
        thumb_sha, full_w, full_h = thumbs[drive_file_id]

        face_out = []
        for face in res["faces"]:
            q = face["q"]
            face_out.append({
                "bbox": [round(float(v), 2) for v in face["bbox"]],
                "det_score": round(float(face["det_score"]), 6),
                "emb_sha1": _sha1(q.tobytes(order="C")),
                "row_idx": len(embeddings),
                "bib": face["bib"],
            })
            embeddings.append(q)

        rows.append({
            "drive_file_id": drive_file_id,
            "name": names.get(drive_file_id, ""),
            "width": full_w,
            "height": full_h,
            "thumb_sha1": thumb_sha,
            "faces": face_out,
            "torso_bibs": [{"bib": h["bib"], "raw": h["raw"], "conf": round(h["conf"], 6)}
                           for h in res["torso_bibs"]],
            "tile_bibs": [{"bib": h["bib"], "raw": h["raw"], "conf": round(h["conf"], 6)}
                          for h in res["tile_bibs"]],
        })
    return rows


def process_batch(local: list, engine, reader,
                  cfg_thumb_edge: int, cfg_thumb_quality: int,
                  embeddings: list, stages: Stages, pool=None,
                  single_decode: bool = False) -> list:
    """One batch, in main.py's exact order.

    Two passes over the batch, and they decode the same files twice — that is
    the real pipeline's shape, not an oversight here. main.py separates them
    because put_photos must return photo_ids before faces can be attributed to
    anything. Merging them was queued as optimisation #2; the measured cost of
    the second decode is what decides whether that is worth doing.
    """
    if single_decode:
        # ONE decode per photo: the thumbnail and the detector's frame come out
        # of the same one. This is the variant under test — run it against the
        # two-pass path below, in the same job on the same machine, and the
        # difference is the cost of the second decode and nothing else.
        thumbs: dict = {}
        names: dict = {}
        results = []
        for img, path in local:
            names[img.id] = img.name
            try:
                with stages.timed("thumbnail_s"):
                    thumb, full_w, full_h, bgr = decode_once(
                        path, cfg_thumb_edge, cfg_thumb_quality)
            except Exception as exc:  # noqa: BLE001
                log.warning("Decode failed for %s: %s", img.name, exc)
                continue
            thumbs[img.id] = (_sha1(thumb), full_w, full_h)
            # A FRESH Stages, not the shared one. process_frame returns
            # st.as_dict(), and _assemble merges that into the accumulator — so
            # handing it the accumulator makes every photo re-merge the running
            # totals into themselves. It compounds, and the first run of this
            # path reported 1499s of thumbnail work inside a 310s benchmark.
            results.append(process_frame(engine, reader, img.id, bgr))
            del bgr
        return _assemble(results, thumbs, names, embeddings, stages)

    # PASS 1 — thumbnail. Decodes every file once. Sequential in both modes:
    # this is the pass optimisation #4 is about, and mixing it into #1 would
    # leave neither measurable on its own.
    thumbs: dict = {}
    names: dict = {}
    for img, path in local:
        names[img.id] = img.name
        try:
            with stages.timed("thumbnail_s"):
                thumb, full_w, full_h = make_thumbnail(path, cfg_thumb_edge, cfg_thumb_quality)
        except Exception as exc:  # noqa: BLE001
            log.warning("Thumbnail failed for %s: %s", img.name, exc)
            continue
        thumbs[img.id] = (_sha1(thumb), full_w, full_h)

    # PASS 2 — decode again, detect, read.
    tasks = [(img.id, path) for img, path in local if img.id in thumbs]
    if pool is not None:
        # imap, not imap_unordered: results arrive in submission order, so the
        # shard the parent builds is identical to the sequential one rather than
        # merely equivalent to it. chunksize stays at its default of 1, which
        # matters more than it looks — face counts per photo are severely skewed
        # (median 2, with crowd shots over 100), so handing out tasks one at a
        # time is the difference between load balancing and one worker drawing
        # the long straw for a whole pre-assigned chunk.
        results = pool.imap(work_photo, tasks)
    else:
        results = (process_one(engine, reader, fid, path) for fid, path in tasks)
    return _assemble(results, thumbs, names, embeddings, stages)


class UploadProbe:
    """Prices the R2 thumbnail PUT, without publishing a single photograph.

    Optimisation 4 overlaps the thumbnail upload with the next photo's work. Its
    prize is therefore exactly the upload time, and this harness has never
    measured that: it takes only GOOGLE_API_KEY, by design, so `upload_s` in
    every report so far is not a small number but an absent one.

    What is actually being timed is "how long does it take to PUT N bytes to
    R2", and that does not need the bytes to be a real thumbnail. So the probe
    sends RANDOM bytes of the same length as the thumbnail that was just made,
    under a bench/ prefix, and deletes them afterwards. Same request, same
    payload size, same round trip — and no race photo is written to a new
    public URL to find it out.

    Off unless asked for. A harness that writes to production by default is a
    harness nobody dares run while a pass is in flight.
    """

    def __init__(self, uploader, prefix: str) -> None:
        self.up = uploader
        self.prefix = prefix
        self.keys: list = []

    def put_like(self, thumb: bytes, drive_file_id: str, stages: Stages) -> None:
        key = f"{self.prefix}/{drive_file_id}.bin"
        payload = os.urandom(len(thumb))
        with stages.timed("upload_s"):
            self.up.put_bytes(key, payload, "application/octet-stream")
        self.keys.append(key)

    def cleanup(self) -> int:
        removed = 0
        for key in self.keys:
            try:
                self.up.s3.delete_object(Bucket=self.up.cfg.r2_bucket, Key=key)
                removed += 1
            except Exception as exc:  # noqa: BLE001
                # Reported rather than raised: a leftover object under bench/ is
                # inert, and losing the measurement to a failed tidy-up would be
                # the worse outcome.
                log.warning("Could not delete probe object %s: %s", key, exc)
        return removed


def interleaved_batch(batch: list, download, engine, reader, thumb_edge: int,
                      thumb_quality: int, embeddings: list, stages: Stages,
                      prefetch_depth: int, probe=None) -> list:
    """One batch the way the REAL pass runs it: fetch and read, interleaved.

    The rest of this harness downloads everything up front, outside the clock,
    which is right for measuring CPU work and useless for measuring anything
    about downloading. Production does neither: it downloads a batch, reads that
    batch, downloads the next. So optimisation 3 — overlapping the fetch with
    the read — has no effect that the ordinary path could ever show, because
    there is nothing left to overlap by the time it starts.

    prefetch_depth 0 reproduces the turn-taking exactly. Anything higher runs
    the downloader on its own thread, ONE request at a time, feeding this loop
    as it works. Both shapes run in one job on one machine, so the difference
    between them is the overlap and nothing else.
    """
    thumbs: dict = {}
    names: dict = {}
    results = []

    if prefetch_depth > 0:
        arriving = Prefetcher(download, depth=prefetch_depth).stream(batch)
    else:
        arriving = ((img, download(img)) for img in batch)

    for img, path in arriving:
        if path is None:
            continue
        names[img.id] = img.name
        try:
            with stages.timed("thumbnail_s"):
                thumb, full_w, full_h, bgr = decode_once(path, thumb_edge, thumb_quality)
        except Exception as exc:  # noqa: BLE001
            log.warning("Decode failed for %s: %s", img.name, exc)
            continue
        thumbs[img.id] = (_sha1(thumb), full_w, full_h)
        if probe is not None:
            probe.put_like(thumb, img.id, stages)
        results.append(process_frame(engine, reader, img.id, bgr))
        del bgr
    return _assemble(results, thumbs, names, embeddings, stages)


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

    # Interleaved mode downloads inside the clock, per batch, like the real
    # pass. Everything else pre-fetches outside it, which is right for isolating
    # CPU work and blind to anything about the network.
    scratch = None
    local = []
    if not args.interleave:
        local = fetch(drive, sample, args.cache, args.image_source, stages)
        if not local:
            raise SystemExit("Nothing downloaded")
    elif args.no_cache:
        # A FRESH directory per variant. Sharing one would let the second
        # variant find the first variant's files already on disk and report a
        # download cost of zero — which is exactly the number under test.
        scratch = tempfile.mkdtemp(prefix=f"bench-{args.label}-")

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

        pool = mp.Pool(args.workers, initializer=init_worker,
                       initargs=(args.det_size, {}))
        log.info("%d worker processes", args.workers)
    else:
        engine = FaceEngine(det_size=args.det_size)
        reader = BibReader()

    embeddings: list = []
    photos: list = []

    work_dir = scratch or args.cache
    os.makedirs(work_dir, exist_ok=True)

    def download(img):
        dest = os.path.join(work_dir, f"{img.id}.{args.image_source}")
        if not args.no_cache and os.path.exists(dest) and os.path.getsize(dest) > 0:
            return dest
        try:
            with stages.timed("download_s"):
                if args.image_source == "thumb":
                    drive.download_thumb(img.id, dest)
                else:
                    drive.download(img.id, dest)
            return dest
        except QuotaExceeded:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping %s (%s): %s", img.name, img.id, exc)
            return None

    probe = None
    if args.upload_probe:
        # R2 fields only. The full Config also demands INGEST_SECRET and
        # API_BASE_URL, and this job has no business holding the key that writes
        # to D1 just to time a PUT.
        from .upload import Uploader as _Up

        class _R2Only:
            r2_account_id = os.environ.get("R2_ACCOUNT_ID", "")
            r2_access_key_id = os.environ.get("R2_ACCESS_KEY_ID", "")
            r2_secret_access_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
            r2_bucket = os.environ.get("R2_BUCKET", "")
            ingest_secret = ""          # never sent: the probe only PUTs and DELETEs
            api_base_url = ""

            @property
            def r2_endpoint(self) -> str:
                return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

        cfg_r2 = _R2Only()
        if not cfg_r2.r2_bucket:
            raise SystemExit("--upload-probe needs the R2_* environment variables")
        probe = UploadProbe(_Up(cfg_r2), f"bench/{os.environ.get('GITHUB_RUN_ID', 'local')}/{args.label}")
        log.info("upload probe on: writing random payloads to %s/, deleted after", probe.prefix)

    # Started before the first download in interleaved mode: the whole point is
    # that the fetch is part of the pass.
    wall0 = time.perf_counter()
    try:
        if args.interleave:
            for i in range(0, len(sample), args.batch_size):
                batch = sample[i : i + args.batch_size]
                photos.extend(interleaved_batch(
                    batch, download, engine, reader, args.thumb_max_edge,
                    args.thumb_quality, embeddings, stages, args.prefetch, probe))
                log.info("batch %d done (%d photos) | %s",
                         i // args.batch_size, len(batch), stages.summary())
        else:
            for i in range(0, len(local), args.batch_size):
                batch = local[i : i + args.batch_size]
                photos.extend(process_batch(batch, engine, reader, args.thumb_max_edge,
                                            args.thumb_quality, embeddings, stages, pool,
                                            args.single_decode))
                log.info("batch %d done (%d photos) | %s",
                         i // args.batch_size, len(batch), stages.summary())
    finally:
        if pool is not None:
            pool.close()
            pool.join()
    wall = time.perf_counter() - wall0
    if probe is not None:
        log.info("upload probe: deleted %d/%d objects", probe.cleanup(), len(probe.keys))
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)

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
            "single_decode": bool(args.single_decode),
            "interleave": bool(args.interleave),
            "prefetch": args.prefetch,
            "no_cache": bool(args.no_cache),
            "upload_probe": bool(args.upload_probe),
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
    # Optimisation #2, as a switch, so both shapes can run in one job.
    p.add_argument("--single-decode", action="store_true")
    # Optimisation 3. --interleave puts the download inside the pass, the way
    # production runs it; --prefetch 0 keeps the turn-taking, higher overlaps.
    p.add_argument("--interleave", action="store_true")
    p.add_argument("--prefetch", type=int, default=0)
    p.add_argument("--no-cache", action="store_true")
    # Optimisation 4: price the R2 PUT. Needs the R2 credentials, so it is
    # off unless explicitly asked for.
    p.add_argument("--upload-probe", action="store_true")
    return run(p.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
