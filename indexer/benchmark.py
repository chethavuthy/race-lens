"""Compare Drive thumbnails against full-size originals for one folder.

    python -m indexer.benchmark --benchmark-id B --folder-id F [--sample 6]

Run on demand from the admin UI, never automatically — it costs a CI run.

The question it answers is narrow and worth being precise about: for THIS
photographer's folder, does the resized copy Drive serves find the same faces
and read the same bibs as the 20 MB original? On the album this was built
against the answer was yes, identically, for a twelfth of the bytes. That will
not hold for every folder — a race shot wider, or with runners further away,
may lose small faces at 3200px. Hence measuring per folder rather than assuming.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import time
import traceback

import cv2

from .bibs import BibReader
from .config import Config
from .drive import DriveClient, QuotaExceeded
from .faces import FaceEngine
from .main import load_bgr
from .upload import Uploader

log = logging.getLogger("benchmark")


def analyse(engine: FaceEngine, reader: BibReader, path: str) -> tuple[int, set[str], float]:
    bgr = load_bgr(path)
    if bgr is None:
        return 0, set(), 0.0
    t0 = time.time()
    faces = engine.detect(bgr)
    bibs: set[str] = set()
    for f in faces:
        hit = reader.read_torso(bgr, f.bbox)
        if hit:
            bibs.add(hit.raw)
    for hit in reader.read_tiles(bgr):
        bibs.add(hit.raw)
    return len(faces), bibs, time.time() - t0


def run(args: argparse.Namespace) -> int:
    cfg = Config()
    up = Uploader(cfg)
    drive = DriveClient(cfg.google_api_key)
    up.benchmark(args.benchmark_id, status="running")

    images = drive.walk(args.folder_id)
    if not images:
        up.benchmark(args.benchmark_id, status="failed", error="No images in that folder")
        return 1

    # Spread the sample across the album rather than taking the first N: the
    # opening frames of a race album are often the start line, which is not
    # representative of the mid-race shots where detection is hardest.
    step = max(1, len(images) // args.sample)
    sample = images[::step][: args.sample]

    engine = FaceEngine(det_size=cfg.det_size)
    reader = BibReader()
    work = "/tmp/bench"
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    rows = []
    for img in sample:
        row: dict = {"drive_file_id": img.id, "name": img.name}
        for mode in ("thumb", "original"):
            dest = os.path.join(work, f"{img.id}.{mode}")
            try:
                if mode == "thumb":
                    drive.download_thumb(img.id, dest)
                else:
                    drive.download(img.id, dest)
            except (QuotaExceeded, Exception) as exc:  # noqa: BLE001
                row[mode] = {"error": str(exc)[:160]}
                continue
            faces, bibs, secs = analyse(engine, reader, dest)
            size = os.path.getsize(dest)
            im = cv2.imread(dest)
            row[mode] = {
                "bytes": size,
                "dimensions": f"{im.shape[1]}x{im.shape[0]}" if im is not None else "?",
                "faces": faces,
                "bibs": sorted(bibs),
                "seconds": round(secs, 2),
            }
            os.remove(dest)
        rows.append(row)
        log.info("benchmarked %s", img.name)

    shutil.rmtree(work, ignore_errors=True)

    def total(mode: str, key: str) -> int:
        return sum(r.get(mode, {}).get(key, 0) or 0 for r in rows)

    thumb_bibs = {b for r in rows for b in r.get("thumb", {}).get("bibs", [])}
    orig_bibs = {b for r in rows for b in r.get("original", {}).get("bibs", [])}

    summary = {
        "sampled": len(rows),
        "folder_images": len(images),
        "thumb": {
            "bytes": total("thumb", "bytes"),
            "faces": total("thumb", "faces"),
            "bibs": len(thumb_bibs),
        },
        "original": {
            "bytes": total("original", "bytes"),
            "faces": total("original", "faces"),
            "bibs": len(orig_bibs),
        },
        # What the organizer actually needs to decide: what does thumb LOSE?
        "bibs_only_in_original": sorted(orig_bibs - thumb_bibs),
        "bibs_only_in_thumb": sorted(thumb_bibs - orig_bibs),
        "rows": rows,
    }
    o = summary["original"]["bytes"] or 1
    summary["size_ratio"] = round(o / max(summary["thumb"]["bytes"], 1), 1)
    # Drive's quota is what caps a pass; smaller files mean more photos per pass.
    summary["est_photos_per_pass"] = {
        "thumb": int(1_000_000_000 / max(summary["thumb"]["bytes"] / max(len(rows), 1), 1)),
        "original": int(1_000_000_000 / max(o / max(len(rows), 1), 1)),
    }

    up.benchmark(args.benchmark_id, status="done", result=json.dumps(summary))
    log.info("done: %s", json.dumps(summary["thumb"]))
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        stream=sys.stdout)
    p = argparse.ArgumentParser()
    p.add_argument("--benchmark-id", required=True)
    p.add_argument("--folder-id", required=True)
    p.add_argument("--sample", type=int, default=6)
    args = p.parse_args()
    try:
        return run(args)
    except Exception:
        detail = traceback.format_exc()
        log.error("benchmark failed:\n%s", detail)
        try:
            Uploader(Config()).benchmark(args.benchmark_id, status="failed", error=detail[-500:])
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
