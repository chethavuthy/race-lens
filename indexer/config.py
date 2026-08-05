"""Environment plumbing shared by every indexer module."""
from __future__ import annotations

import os


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


class Config:
    def __init__(self) -> None:
        self.google_api_key = _require("GOOGLE_API_KEY")
        self.api_base_url = _require("API_BASE_URL").rstrip("/")
        self.ingest_secret = _require("INGEST_SECRET")
        self.r2_account_id = _require("R2_ACCOUNT_ID")
        self.r2_access_key_id = _require("R2_ACCESS_KEY_ID")
        self.r2_secret_access_key = _require("R2_SECRET_ACCESS_KEY")
        self.r2_bucket = _require("R2_BUCKET")

        # Tunables — safe defaults, overridable from the workflow.
        # 25, not 200. Two reasons, both learned from a real run:
        #  * progress is reported per batch, so a 151-photo album with a batch of
        #    200 sat at 0% for its entire duration, then jumped to 100%.
        #  * peak disk is batch_size * photo size. At 21.6 MB/photo (ordinary for
        #    a DSLR) a 200-batch holds 4.3 GB; 25 holds 540 MB.
        self.batch_size = int(os.environ.get("BATCH_SIZE", "25"))
        self.thumb_max_edge = int(os.environ.get("THUMB_MAX_EDGE", "1000"))
        self.thumb_quality = int(os.environ.get("THUMB_QUALITY", "80"))
        # 1280, not 640. Measured on a real race photo, faces found by detector size:
        #   640 -> 4    1024 -> 5    1280 -> 6    1600 -> 7
        # Race photos put runners at a distance, so the default was leaving
        # people undetectable by face search. 1280 is the knee: 1600 costs more
        # CPU per photo for one extra face.
        self.det_size = int(os.environ.get("DET_SIZE", "1280"))
        self.work_dir = os.environ.get("WORK_DIR", "/tmp/work")

    @property
    def r2_endpoint(self) -> str:
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


# Vector format contract — mirrored in apps/api/src/search.ts and
# apps/web/src/lib/face.ts. Changing any of these three requires changing all.
EMBED_DIM = 512
QUANT_SCALE = 127
