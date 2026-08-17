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
import time
import traceback
import uuid

import numpy as np
from PIL import Image, ImageOps

from .bibs import DEFAULT_MIN_DIGITS, MAX_DIGITS, BibReader, parse_prefixes
from .config import Config
from .drive import DriveClient, DriveImage, QuotaExceeded
from .faces import FaceEngine, quantize
from .resume import pending
from .upload import Uploader

log = logging.getLogger("indexer")

# Pillow refuses very large images by default as a decompression-bomb guard.
# Race photos from a DSLR routinely exceed it, so raise rather than remove it.
Image.MAX_IMAGE_PIXELS = 300_000_000


def make_thumbnail(path: str, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    """Returns (webp bytes, full width, full height) POST-EXIF-ROTATION.

    The dimensions are the DECODED FRAME's — not the thumbnail's, and not Drive's.

    They have to be, because faces.bbox is measured in pixels of the array
    load_bgr() produces from this same file, and the client divides one by the
    other to crop a tile to the matched face. Drive's imageMediaMetadata cannot
    play that role twice over: it describes the ORIGINAL upload, so it is
    pre-rotation, and with image_source='thumb' it describes a 6000px file while
    the bytes on disk are Drive's w3200 copy. Either way the two spaces diverge and
    the crop lands somewhere else entirely.
    """
    with Image.open(path) as im:
        # EXIF rotation must be applied before anything else: an unrotated
        # portrait frame makes the detector miss every face in it.
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        # Captured before thumbnail() shrinks it in place.
        full_w, full_h = im.size
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=quality, method=4)
        return buf.getvalue(), full_w, full_h


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
    # Started before the Drive walk, not before the batch loop: walking a
    # 31,000-file folder is itself minutes of the budget, and the deadline is
    # measured against the runner's timeout, which starts here.
    started = time.monotonic()
    cfg = Config()
    up = Uploader(cfg)
    drive = DriveClient(cfg.google_api_key)

    # Before the Drive walk, which is minutes of work on a large folder and would
    # be thrown away. A job stopped while it was still queued has already been
    # marked 'stopped' by the API; this ping sets it back to 'running', so the
    # runner has to put it right on its way out rather than leaving the row
    # claiming a pass that is no longer happening.
    if up.progress(args.job_id, status="running", done=0, total=0):
        log.info("Stop requested before this pass began — exiting without indexing")
        up.progress(args.job_id, status="stopped", done=0, total=0,
                    error="Stopped before it started. Press Continue to run it.")
        return 0

    images: list[DriveImage] = drive.walk(args.folder_id)
    discovered = len(images)
    # Snapshot before the resume filter rewrites `images`. The continuation
    # check at the end needs "how many files in THIS folder are still missing",
    # and every other count available there is either event-wide or
    # already-filtered.
    folder_ids = {i.id for i in images}

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

    # Some events hand out no bibs at all — fun runs, community runs. Reading
    # them is then pure cost: OCR is the most expensive stage per photo, and the
    # only thing it can produce is false positives off race signage and kit
    # numbers. Skipping it also avoids loading the OCR model entirely.
    event_cfg = up.event_config(args.event_id)
    read_bibs = bool(event_cfg.get("bibs_enabled", True))
    # Shortest number that counts as a bib at this race. BibReader clamps it, so
    # a missing or nonsense value degrades to the default rather than to a
    # pattern that matches every number in the frame.
    bib_min_digits = event_cfg.get("bib_min_digits") or DEFAULT_MIN_DIGITS
    # Category letters this race prints, 'F,M'. Empty means digits only, which is
    # every event that predates the setting.
    bib_prefixes = parse_prefixes(event_cfg.get("bib_prefixes"))
    bib_max_digits = event_cfg.get("bib_max_digits") or MAX_DIGITS
    if args.bibs_only and not read_bibs:
        # A bibs-only pass over an event with no bibs would download and decode
        # every photo to write nothing at all.
        up.progress(args.job_id, status="failed",
                    error="This event is marked as having no bib numbers, so there "
                          "is nothing for a bibs-only pass to read.")
        return 1
    if not read_bibs:
        log.info("Bib detection is off for this event — face search only")
        note("info", "no_bibs",
             "This event is marked as having no bib numbers, so bib detection "
             "was skipped. Face search is unaffected.")

    engine = FaceEngine(det_size=cfg.det_size)
    reader = (BibReader(min_digits=bib_min_digits, prefixes=bib_prefixes,
                        max_digits=bib_max_digits)
              if read_bibs else None)
    if reader:
        # Logged and journalled: this single number decides whether an album's bib
        # search works at all, and when it is wrong the pipeline's only symptom is
        # an empty result nobody can explain. SheRuns read 0 bibs across 199 faces
        # for exactly this reason.
        shape = (f"{reader.min_digits} digits" if reader.min_digits == reader.max_digits
                 else f"{reader.min_digits} to {reader.max_digits} digits")
        if reader.prefixes:
            shape += ", with or without " + "/".join(reader.prefixes)
        log.info("Bib numbers: %s", shape)
        note("info", "bib_digits",
             f"Reading bib numbers of {shape}. Anything else is ignored — change "
             "this on the event if the bibs at this race look different."
             + ("" if reader.prefixes else
                " A bib with a letter in it, like F-0092, needs that letter listed"
                " as a category prefix on the event."))

    embeddings: list[np.ndarray] = []
    face_rows: list[dict] = []
    processed = 0
    downloaded = 0
    skipped = 0
    faces_indexed = 0
    quota_hit = False
    deadline_hit = False
    stop_hit = False
    deadline_s = cfg.deadline_min * 60

    work = cfg.work_dir
    for batch_no, batch in enumerate(
        [images[i : i + cfg.batch_size] for i in range(0, total, cfg.batch_size)]
    ):
        # Stop on our own terms, between batches, while there is still time to
        # ask for a continuation.
        #
        # This is the second way a pass ends early, and until now the only one
        # that could not resume. A quota hit is raised, caught and carried to the
        # continuation request below; the runner's own timeout is a kill, so the
        # request was never made and a 31k-photo album needed a manual press
        # every 5h30m. Checked between batches because that is the point where
        # nothing is in flight: vectors, bibs and faces_done for every batch so
        # far have already landed.
        #
        # Never on the first batch: a pass that starts already past the deadline
        # would index nothing, and a pass that indexes nothing ends the chain.
        if batch_no and time.monotonic() - started > deadline_s:
            log.info("Deadline reached after %d batches — stopping to continue later", batch_no)
            note("warn", "deadline",
                 f"This pass ran for {cfg.deadline_min} minutes, the limit for a "
                 "single CI run. The remaining photos are picked up automatically.")
            deadline_hit = True
            break

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
        # Paths, not decoded arrays.
        #
        # This used to hold one decoded uint8 H*W*3 frame per photo for the whole
        # batch, because the loop below needs photo_ids and those only exist after
        # put_photos. At the 6000x4000 the config note cites that is ~72 MB a frame,
        # so the default batch of 25 sat on ~1.8 GB next to the insightface and
        # RapidOCR sessions — and load_bgr's .copy() briefly doubles whichever frame
        # is being added. config.py sizes BATCH_SIZE against DISK ("25 holds
        # 540 MB"), understating RAM by ~3.5x, so raising it on that reasoning OOMs.
        # An OOM lands mid-batch, which is exactly the interruption that strands
        # photos with no faces. The files are still on disk until the rmtree below,
        # so nothing required holding them decoded.
        paths: dict[str, tuple[str, str]] = {}   # drive_file_id -> (name, local path)

        for img, path in local:
            thumb_key = f"thumbs/{args.event_id}/{img.id}.webp"

            # A bibs-only pass re-reads NUMBERS; the thumbnail is already in R2 and
            # would come back byte-identical. Regenerating it costs a LANCZOS resize
            # and a billed class-A PutObject per photo to write bytes that already
            # exist — 8,523 of each on the largest album — and the flag's own
            # docstring promises it "leaves photos, faces and shards untouched".
            #
            # width/height/taken_at are omitted rather than sent as None: the
            # upsert in internal.ts COALESCEs them, so whatever is stored survives.
            if args.bibs_only:
                paths[img.id] = (img.name, path)
                photo_payload.append({"drive_file_id": img.id, "thumb_key": thumb_key})
                continue

            try:
                thumb, full_w, full_h = make_thumbnail(path, cfg.thumb_max_edge, cfg.thumb_quality)
            except Exception as exc:  # noqa: BLE001
                log.warning("Thumbnail failed for %s: %s", img.name, exc)
                note("error", "thumbnail_failed", f"{img.name}: {str(exc)[:180]}", img.id)
                continue

            up.put_bytes(thumb_key, thumb, "image/webp")
            photo_payload.append(
                {
                    "drive_file_id": img.id,
                    "thumb_key": thumb_key,
                    # The decoded frame's size, NOT Drive's imageMediaMetadata.
                    #
                    # These are the denominator the client divides faces.bbox by to
                    # crop a tile to the matched runner, so they must be in the
                    # bbox's own coordinate space. Drive's numbers are not: they
                    # describe the original upload pre-EXIF-rotation, and on a
                    # 'thumb' source they describe a 6000px file while detection ran
                    # on Drive's w3200 copy. That put the crop window at ~4% of the
                    # frame, in the wrong place, on every face — while the caption
                    # still said "cropped to you".
                    "width": full_w,
                    "height": full_h,
                    "taken_at": img.taken_at,
                }
            )
            paths[img.id] = (img.name, path)

        photo_ids = (
            up.put_photos(args.event_id, args.source_id, photo_payload,
                          faces_pending=not args.bibs_only)
            if photo_payload else {}
        )

        bib_payload: list[dict] = []
        # Photos this pass actually decoded and read, which is NOT the same set as
        # photo_ids — see the put_bibs call below.
        read_ids: list[str] = []
        for drive_file_id, (img_name, path) in paths.items():
            photo_id = photo_ids.get(drive_file_id)
            if not photo_id:
                continue

            # Decoded here, one frame resident at a time, and released at the end of
            # the iteration.
            bgr = load_bgr(path)
            if bgr is None:
                # Journalled, not just logged. A decode failure means no faces and no
                # bibs for a photo that nonetheless has a thumbnail and appears in the
                # album — the organizer needs a reason for that, and log.warning goes
                # only to CI output they cannot reach.
                note("error", "decode_failed",
                     f"{img_name}: could not be decoded, so no faces or bibs were "
                     "read from it", drive_file_id)
                continue
            read_ids.append(photo_id)

            faces = engine.detect(bgr)
            for face in faces:
                hit = reader.read_torso(bgr, face.bbox) if reader else None
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
            if reader:
                for hit in reader.read_tiles(bgr):
                    bib_payload.append({"photo_id": photo_id, "bib": hit.bib,
                                        "bib_raw": hit.raw, "conf": hit.conf})

            # Release before the next iteration rather than at the end of the batch.
            del bgr

        # Flush vectors per batch.
        #
        # These used to accumulate in memory and be written once, at the very
        # end. Three runs were cancelled mid-pass — GitHub reclaims runners —
        # and every embedding they had computed was discarded while their photos
        # and bibs, which ARE written per batch, survived. That left 51 photos
        # permanently faceless: present in the album, invisible to face search,
        # and indistinguishable from photos that genuinely contain no one.
        #
        # Flushing per batch shrank that window from a whole run to one batch; it
        # did not close it, because the photo rows are still committed at the top
        # of the batch. What closes it is the ordering below: vectors, then bibs,
        # then mark_photos_complete. faces_done stays 0 until every one of those
        # has succeeded, and the resume key reads faces_done — so an interruption
        # anywhere in the batch means the next pass simply redoes it.
        if embeddings:
            shard_key = f"index/{args.event_id}/{args.source_id}-{args.run_id}-b{batch_no}.bin"
            row_base = up.reserve_rows(args.event_id, shard_key, len(embeddings))
            buf = np.stack(embeddings).astype(np.int8)
            # Private bucket, via the Worker: these are biometric vectors and
            # the public bucket is served straight off a custom domain.
            up.put_shard(shard_key, buf.tobytes(order="C"))
            for row in face_rows:
                row["row_idx"] += row_base
            up.put_faces(args.event_id, shard_key, row_base, face_rows)
            # Count before the reset — the summary used to report len(embeddings)
            # after this loop, which is necessarily 0, so every pass in the log
            # claimed "0 faces indexed" while the event accumulated thousands.
            faces_indexed += len(embeddings)
            embeddings, face_rows = [], []

        # Bibs AFTER the vectors, and only for photos this pass actually READ.
        #
        # replace_photos was every id in photo_ids, which includes photos whose
        # thumbnail succeeded and whose decode then failed. Those never reach the OCR
        # loop, so listing them deleted bibs an earlier pass had read correctly and
        # wrote nothing back in their place: a silent, permanent loss triggered by a
        # transient decode failure.
        #
        # Skipped entirely when the event has no bibs: the call would clear rows
        # without writing any, destroying bibs read before the organizer turned the
        # flag off — and those must survive so turning it back on does not require a
        # re-index.
        if read_ids and read_bibs:
            up.put_bibs(args.event_id, bib_payload, replace_photos=read_ids)

        # LAST, and only now: everything this batch could lose has been written.
        #
        # Every photo the pass processed, including ones the detector found nobody
        # in — they are just as finished, and leaving them unmarked would re-download
        # them on every later pass forever. Skipped under --bibs-only, which never
        # touched faces and so has no claim to make about them.
        if read_ids and not args.bibs_only:
            up.mark_photos_complete(args.event_id, read_ids)

        processed += len(local)
        # The same ping that reports this batch answers whether to start the next
        # one. Acted on HERE, between batches, for the reason the deadline check
        # above gives: vectors, bibs and faces_done for everything so far have
        # landed, so a stop at this point costs nothing and resumes cleanly.
        #
        # Not acted on at the mid-batch pings inside the download loop, though
        # they carry the same flag: stopping there would throw away photos
        # already fetched from a quota that is measured in bytes.
        stop_hit = up.progress(args.job_id, done=processed, total=total)
        log.info(
            "Batch %d: %d photos, %d faces so far, %d/%d done",
            batch_no + 1, len(local), faces_indexed, processed, total,
        )

        if journal:
            up.log(args.event_id, journal)
            journal = []

        shutil.rmtree(work, ignore_errors=True)
        if stop_hit:
            log.info("Stop requested — ending after batch %d", batch_no + 1)
            note("info", "stopped",
                 "Stopped at your request. Everything indexed so far is live; "
                 "press Continue to carry on from here.")
            break
        if quota_hit:
            break

    # There is deliberately no trailing flush here. The batch loop flushes at the
    # end of every iteration, including the one that breaks on a quota hit, so
    # `embeddings` is always empty by this point. The block that used to sit here
    # was unreachable, and reading it as a real safety net hid the fact that the
    # per-batch flush is the only thing keeping vectors durable.

    # Any photo we could not fetch means the album is not fully represented.
    # Reporting "done" there is a lie the organizer cannot see through.
    incomplete = quota_hit or deadline_hit or stop_hit or skipped > 0
    # 'stopped' rather than 'partial' when the organizer asked for it. Both mean
    # "there is more to do", but only one of them is something they did — and a
    # pass that reports 'partial' next to the button they just pressed reads as a
    # failure they now have to diagnose.
    status = "stopped" if stop_hit else "partial" if incomplete else "done"

    # A run stopped by Drive's throttle or by its own clock has more to do and
    # will succeed later — ask for a continuation rather than making the
    # organizer press the button again. Only when the run actually stopped early
    # AND left work behind; a run that merely skipped a few unreadable files
    # must not loop.
    # Scoped to this folder's own files, NOT `discovered - event_total`.
    #
    # already_indexed is event-wide, so subtracting it from one source's
    # discovered count goes negative the moment the event's other sources push
    # the total past it. On a two-link event whose first link had finished
    # (601 of 601) that made the second link's remaining -341, so `remaining > 0`
    # was false forever and the continuation was never requested — the chain
    # died silently while 260 photos were still missing.
    # `not stop_hit`: a stop that only ended this run would be undone seconds
    # later by the continuation it requested on the way out. The API refuses the
    # request too — belt and braces, because the runner is the half that knows
    # it stopped deliberately and the API is the half that survives the runner
    # being killed outright.
    remaining = len(pending(folder_ids, up.already_indexed(args.event_id)))
    if (quota_hit or deadline_hit) and not stop_hit and remaining > 0 and not args.bibs_only:
        # The reason travels with the request so the job's own error line — the
        # one the organizer reads while they wait — says which wall this pass hit.
        reason = "quota" if quota_hit else "time"
        if up.request_continue(args.job_id, reason):
            log.info(
                "Stopped early (%s) with %d photos left — continuation dispatched",
                reason, remaining,
            )
            up.finalize(args.event_id, "partial")
            return 0
        log.warning("Continuation was not dispatched; finishing as partial")
    stopped = (" — stopped at your request" if stop_hit else
               " — Drive rate limit hit" if quota_hit else
               " — stopped at this run's time limit" if deadline_hit else "")
    note("info", "summary",
         f"Pass finished: {downloaded} downloaded, {skipped} could not be fetched, "
         f"{faces_indexed} faces indexed" + stopped)
    up.log(args.event_id, journal)

    up.progress(
        args.job_id, status=status, done=processed, total=total,
        # The stop message wins over the skipped count: it is the answer to
        # "what happened", and the skipped photos are picked up by the next pass
        # exactly as they would have been anyway.
        error=("Stopped. Everything indexed so far is live — press Continue "
               "to carry on." if stop_hit else
               f"{skipped} of {total} photos could not be downloaded from Drive"
               if skipped else None),
    )
    counts = up.finalize(args.event_id, "partial" if incomplete else "ready")

    log.info(
        "Finished: %s — %d downloaded, %d skipped, %d faces; event now %s photos / %s faces",
        status, downloaded, skipped, faces_indexed,
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
