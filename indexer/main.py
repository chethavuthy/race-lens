"""Race Lens indexer.

    python -m indexer.main --event-id E --source-id S --folder-id F --job-id J

Runs on a GitHub Actions runner. Downloads a Drive folder in batches, produces
thumbnails, face embeddings and bib numbers, and streams the results to R2 and
the Worker.

The batch loop is not an optimization — it is a hard requirement. A runner has
roughly 14 GB of disk, so ~3,500 full-size photos fills it and kills the job
mid-run. Each batch is also a natural progress checkpoint.
"""
from __future__ import annotations

import argparse
import io
import logging
import os
import shutil
import sys
import traceback
import uuid

import numpy as np
from PIL import Image, ImageOps

from .bibs import BibReader
from .config import Config
from .drive import DriveClient, DriveImage, QuotaExceeded
from .faces import FaceEngine, quantize
from .upload import Uploader

log = logging.getLogger("indexer")

# Pillow refuses very large images by default as a decompression-bomb guard.
# Race photos from a DSLR routinely exceed it, so raise rather than remove it.
Image.MAX_IMAGE_PIXELS = 300_000_000


def make_thumbnail(path: str, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    with Image.open(path) as im:
        # EXIF rotation must be applied before anything else: an unrotated
        # portrait frame makes the detector miss every face in it.
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=quality, method=4)
        return buf.getvalue(), im.width, im.height


def load_bgr(path: str) -> np.ndarray | None:
    """Decode to the BGR uint8 array insightface and PaddleOCR both expect."""
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            return np.asarray(im)[:, :, ::-1].copy()
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not decode %s: %s", path, exc)
        return None


def run(args: argparse.Namespace) -> int:
    cfg = Config()
    up = Uploader(cfg)
    drive = DriveClient(cfg.google_api_key)

    up.progress(args.job_id, status="running", done=0, total=0)

    images: list[DriveImage] = drive.walk(args.folder_id)
    discovered = len(images)

    # Single-photo mode: re-process exactly one file. Used by the admin's
    # per-photo Re-index button, so a photo the detector fumbled can be redone
    # in seconds instead of re-running the whole folder.
    if args.only_file:
        images = [i for i in images if i.id == args.only_file]
        if not images:
            up.progress(args.job_id, status="failed",
                        error=f"{args.only_file} is not in this folder")
            return 1
        log.info("Single-photo mode: %s", args.only_file)
    journal: list[dict] = []

    def note(level: str, code: str, message: str, drive_file_id: str | None = None) -> None:
        journal.append({
            "job_id": args.job_id, "source_id": args.source_id,
            "level": level, "code": code, "message": message,
            "drive_file_id": drive_file_id,
        })

    up.set_discovered(args.source_id, discovered)
    note("info", "walk", f"Found {discovered} images in this folder")

    # Resume. Drive throttles sustained bulk downloading, so a big album often
    # needs more than one run; without this every run re-fetches the same prefix
    # and stalls at exactly the same place.
    if args.bibs_only:
        args.no_resume = True
    if args.only_file:
        pass          # never skip the photo we were explicitly asked to redo
    elif not args.no_resume:
        # --rebuild resumes on "has faces" so a wiped index refills without
        # re-processing photos an earlier pass already rebuilt.
        have = up.already_indexed(args.event_id, complete_only=args.rebuild)
        if have:
            images = [i for i in images if i.id not in have]
            log.info(
                "Resume: %d of %d already indexed, %d to do",
                len(have), discovered, len(images),
            )
            if not images:
                log.info("Nothing left to index")
                up.progress(args.job_id, status="done", done=discovered, total=discovered)
                up.finalize(args.event_id, "ready")
                return 0

    total = len(images)
    up.progress(args.job_id, total=total)
    if not total:
        up.progress(args.job_id, status="failed", error="No images found in that folder")
        return 1

    engine = FaceEngine(det_size=cfg.det_size)
    reader = BibReader()

    embeddings: list[np.ndarray] = []
    face_rows: list[dict] = []
    processed = 0
    downloaded = 0
    skipped = 0
    quota_hit = False

    work = cfg.work_dir
    for batch_no, batch in enumerate(
        [images[i : i + cfg.batch_size] for i in range(0, total, cfg.batch_size)]
    ):
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work, exist_ok=True)

        local: list[tuple[DriveImage, str]] = []
        for img in batch:
            dest = os.path.join(work, img.id)
            try:
                if args.image_source == "thumb":
                    drive.download_thumb(img.id, dest)
                else:
                    drive.download(img.id, dest)
                local.append((img, dest))
                downloaded += 1
                # Downloading dominates wall time on full-size originals, so
                # report inside the loop; per-batch reporting alone leaves the
                # admin bar frozen for minutes at a stretch.
                if downloaded % 5 == 0:
                    up.progress(args.job_id, done=processed + len(local), total=total)
            except QuotaExceeded:
                # Popular albums hit downloadQuotaExceeded. Keep everything
                # already fetched and finish as `partial` rather than losing
                # a run that may already be 90% complete.
                log.error("Download quota exceeded — finishing as partial")
                note("warn", "quota",
                     "Google Drive stopped serving downloads (rate limit). "
                     "Remaining photos will be picked up automatically.", img.id)
                quota_hit = True
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("Skipping %s (%s): %s", img.name, img.id, exc)
                note("error", "download_failed", f"{img.name}: {str(exc)[:180]}", img.id)
                skipped += 1

        photo_payload: list[dict] = []
        decoded: dict[str, np.ndarray] = {}

        for img, path in local:
            try:
                thumb, tw, th = make_thumbnail(path, cfg.thumb_max_edge, cfg.thumb_quality)
            except Exception as exc:  # noqa: BLE001
                log.warning("Thumbnail failed for %s: %s", img.name, exc)
                note("error", "thumbnail_failed", f"{img.name}: {str(exc)[:180]}", img.id)
                continue

            thumb_key = f"thumbs/{args.event_id}/{img.id}.webp"
            up.put_bytes(thumb_key, thumb, "image/webp")
            photo_payload.append(
                {
                    "drive_file_id": img.id,
                    "thumb_key": thumb_key,
                    "width": img.width or tw,
                    "height": img.height or th,
                    "taken_at": img.taken_at,
                }
            )
            bgr = load_bgr(path)
            if bgr is not None:
                decoded[img.id] = bgr

        photo_ids = up.put_photos(args.event_id, args.source_id, photo_payload) if photo_payload else {}

        bib_payload: list[dict] = []
        for drive_file_id, bgr in decoded.items():
            photo_id = photo_ids.get(drive_file_id)
            if not photo_id:
                continue

            faces = engine.detect(bgr)
            for face in faces:
                hit = reader.read_torso(bgr, face.bbox)
                if hit:
                    face.bib = hit.bib
                    bib_payload.append({"photo_id": photo_id, "bib": hit.bib, "bib_raw": hit.raw, "conf": hit.conf})

                # In bibs-only mode the vector index is already built and
                # verified; re-emitting faces would duplicate every row.
                if args.bibs_only:
                    continue
                face_rows.append(
                    {
                        "photo_id": photo_id,
                        "row_idx": len(embeddings),
                        "bbox": [round(v, 2) for v in face.bbox],
                        "bib": face.bib,
                    }
                )
                embeddings.append(quantize(face.embedding))

            # Tiled whole-frame pass on EVERY photo, not just face-less ones.
            #
            # Torso crops can only find a bib belonging to a detected face, so a
            # detection miss costs a bib as well. Measured union over 12 photos:
            # 21 -> 27 distinct bibs. Tiling alone is a regression, so it runs
            # alongside the torso pass rather than instead of it.
            for hit in reader.read_tiles(bgr):
                bib_payload.append({"photo_id": photo_id, "bib": hit.bib,
                                    "bib_raw": hit.raw, "conf": hit.conf})

        # Every photo in this batch is authoritative for its own bibs, including
        # ones that produced none.
        if photo_ids:
            up.put_bibs(args.event_id, bib_payload, replace_photos=list(photo_ids.values()))

        processed += len(local)
        up.progress(args.job_id, done=processed, total=total)
        log.info(
            "Batch %d: %d photos, %d faces so far, %d/%d done",
            batch_no + 1, len(local), len(embeddings), processed, total,
        )

        # Flush vectors per batch.
        #
        # These used to accumulate in memory and be written once, at the very
        # end. Three runs were cancelled mid-pass — GitHub reclaims runners —
        # and every embedding they had computed was discarded while their photos
        # and bibs, which ARE written per batch, survived. That left 51 photos
        # permanently faceless: present in the album, invisible to face search,
        # and indistinguishable from photos that genuinely contain no one.
        if embeddings:
            shard_key = f"index/{args.event_id}/{args.source_id}-{args.run_id}-b{batch_no}.bin"
            row_base = up.reserve_rows(args.event_id, shard_key, len(embeddings))
            buf = np.stack(embeddings).astype(np.int8)
            up.put_bytes(shard_key, buf.tobytes(order="C"), "application/octet-stream")
            for row in face_rows:
                row["row_idx"] += row_base
            up.put_faces(args.event_id, shard_key, row_base, face_rows)
            embeddings, face_rows = [], []

        if journal:
            up.log(args.event_id, journal)
            journal = []

        shutil.rmtree(work, ignore_errors=True)
        if quota_hit:
            break

    # Whatever the last batch left unflushed.
    #
    # One shard per BATCH, not per run.
    #
    # Per-source was correct only while a source was always indexed in a single
    # pass. With resume, a second run carries only the photos the first one
    # missed — writing those to the source's existing shard key would replace
    # the file with a shorter one and, because put_faces sends replace=True,
    # delete the earlier run's face rows outright. The photos would survive and
    # silently stop being findable by face.
    #
    # Distinct keys make every run purely additive; search already concatenates
    # all of an event's shards by row_base.
    shard_key = f"index/{args.event_id}/{args.source_id}-{args.run_id}-final.bin"
    if embeddings:
        row_base = up.reserve_rows(args.event_id, shard_key, len(embeddings))
        buffer = np.stack(embeddings).astype(np.int8)
        up.put_bytes(shard_key, buffer.tobytes(order="C"), "application/octet-stream")

        for row in face_rows:
            row["row_idx"] += row_base
        up.put_faces(args.event_id, shard_key, row_base, face_rows)

    # Any photo we could not fetch means the album is not fully represented.
    # Reporting "done" there is a lie the organizer cannot see through.
    incomplete = quota_hit or skipped > 0
    status = "partial" if incomplete else "done"

    # A run stopped by Drive's throttle has more to do and will succeed later —
    # ask for a continuation rather than making the organizer press the button
    # again. Only when the run actually hit the limit AND left work behind;
    # a run that merely skipped a few unreadable files must not loop.
    remaining = discovered - len(up.already_indexed(args.event_id))
    if quota_hit and remaining > 0 and not args.bibs_only:
        if up.request_continue(args.job_id):
            log.info(
                "Drive rate limit with %d photos left — continuation dispatched",
                remaining,
            )
            up.finalize(args.event_id, "partial")
            return 0
        log.warning("Continuation was not dispatched; finishing as partial")
    note("info", "summary",
         f"Pass finished: {downloaded} downloaded, {skipped} could not be fetched, "
         f"{len(embeddings)} faces indexed" + (" — Drive rate limit hit" if quota_hit else ""))
    up.log(args.event_id, journal)

    up.progress(
        args.job_id, status=status, done=processed, total=total,
        error=(f"{skipped} of {total} photos could not be downloaded from Drive"
               if skipped else None),
    )
    counts = up.finalize(args.event_id, "partial" if incomplete else "ready")

    log.info(
        "Finished: %s — %d downloaded, %d skipped, %d faces; event now %s photos / %s faces",
        status, downloaded, skipped, len(embeddings),
        counts.get("photo_count"), counts.get("face_count"),
    )
    return 0


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    p = argparse.ArgumentParser()
    p.add_argument("--event-id", required=True)
    p.add_argument("--source-id", required=True)
    p.add_argument("--folder-id", required=True)
    p.add_argument("--job-id", required=True)
    p.add_argument(
        "--run-id", default=uuid.uuid4().hex[:10],
        help="Unique per invocation; scopes this run's shard so runs never "
             "overwrite each other's vectors.",
    )
    p.add_argument(
        "--bibs-only", action="store_true",
        help="Re-read bib numbers for photos already indexed and write only the "
             "bibs table. Leaves photos, faces and shards untouched — use after "
             "changing OCR tuning. Implies --no-resume.",
    )
    p.add_argument(
        "--only-file", default="",
        help="Re-process a single drive_file_id and nothing else.",
    )
    p.add_argument(
        "--image-source", choices=("original", "thumb"), default="original",
        help="'thumb' uses Drive's resized copy: ~12x smaller, so ~12x more "
             "photos before Drive's download quota stops the pass.",
    )
    p.add_argument(
        "--rebuild", action="store_true",
        help="Resume on photos that already have faces, not merely photos that "
             "exist. Use after wiping faces/bibs for a clean re-index.",
    )
    p.add_argument(
        "--no-resume", action="store_true",
        help="Re-process photos already indexed for this event (default is to skip them).",
    )
    args = p.parse_args()

    try:
        return run(args)
    except Exception:
        detail = traceback.format_exc()
        log.error("Indexing failed:\n%s", detail)
        # Best-effort: the admin UI must not hang on "running" forever.
        try:
            Uploader(Config()).progress(args.job_id, status="failed", error=detail[-800:])
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
