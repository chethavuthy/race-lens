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
                quota_hit = True
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("Skipping %s (%s): %s", img.name, img.id, exc)

        photo_payload: list[dict] = []
        decoded: dict[str, np.ndarray] = {}

        for img, path in local:
            try:
                thumb, tw, th = make_thumbnail(path, cfg.thumb_max_edge, cfg.thumb_quality)
            except Exception as exc:  # noqa: BLE001
                log.warning("Thumbnail failed for %s: %s", img.name, exc)
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
                    bib_payload.append({"photo_id": photo_id, "bib": hit.bib, "conf": hit.conf})

                face_rows.append(
                    {
                        "photo_id": photo_id,
                        "row_idx": len(embeddings),
                        "bbox": [round(v, 2) for v in face.bbox],
                        "bib": face.bib,
                    }
                )
                embeddings.append(quantize(face.embedding))

            if not faces:
                # No face to anchor a torso crop to — fall back to a full-image
                # pass so back-of-pack and finish-line-clock shots still index.
                for hit in reader.read_full(bgr):
                    bib_payload.append({"photo_id": photo_id, "bib": hit.bib, "conf": hit.conf})

        if bib_payload:
            up.put_bibs(args.event_id, bib_payload)

        processed += len(local)
        up.progress(args.job_id, done=processed, total=total)
        log.info(
            "Batch %d: %d photos, %d faces so far, %d/%d done",
            batch_no + 1, len(local), len(embeddings), processed, total,
        )

        shutil.rmtree(work, ignore_errors=True)
        if quota_hit:
            break

    # One shard per source: binding a second Drive folder to an existing event
    # adds a shard rather than rewriting anything already there.
    shard_key = f"index/{args.event_id}/{args.source_id}.bin"
    if embeddings:
        row_base = up.reserve_rows(args.event_id, shard_key, len(embeddings))
        buffer = np.stack(embeddings).astype(np.int8)
        up.put_bytes(shard_key, buffer.tobytes(order="C"), "application/octet-stream")

        for row in face_rows:
            row["row_idx"] += row_base
        up.put_faces(args.event_id, shard_key, row_base, face_rows)

    status = "partial" if quota_hit else "done"
    up.progress(args.job_id, status=status, done=processed, total=total)
    counts = up.finalize(args.event_id, "partial" if quota_hit else "ready")

    log.info(
        "Finished: %s — %d photos downloaded, %d faces, event now %s photos / %s faces",
        status, downloaded, len(embeddings), counts.get("photo_count"), counts.get("face_count"),
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
