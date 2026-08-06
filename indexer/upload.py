"""R2 uploads (direct, via the S3 API) and Worker callbacks.

Bulk bytes go straight to R2 with boto3 — routing thousands of thumbnails
through the Worker would burn request quota for no benefit. Only small JSON
metadata calls hit the Worker.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Iterable, TypeVar

import boto3
import requests
from botocore.config import Config as BotoConfig

from .config import Config

log = logging.getLogger(__name__)

T = TypeVar("T")


def chunked(items: list[T], size: int) -> Iterable[list[T]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


class Uploader:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.s3 = boto3.client(
            "s3",
            endpoint_url=cfg.r2_endpoint,
            aws_access_key_id=cfg.r2_access_key_id,
            aws_secret_access_key=cfg.r2_secret_access_key,
            region_name="auto",
            config=BotoConfig(retries={"max_attempts": 5, "mode": "standard"}),
        )
        self.session = requests.Session()
        self.session.headers["X-Ingest-Secret"] = cfg.ingest_secret

    # --- R2 ---------------------------------------------------------------

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.s3.put_object(
            Bucket=self.cfg.r2_bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )

    # --- Worker callbacks --------------------------------------------------

    def _post(self, path: str, payload: dict[str, Any]) -> dict:
        url = f"{self.cfg.api_base_url}{path}"
        delay = 1.0
        for attempt in range(5):
            try:
                res = self.session.post(url, json=payload, timeout=120)
                if res.status_code < 400:
                    return res.json() if res.content else {}
                # 4xx other than 429 will not fix themselves; fail loudly.
                if res.status_code < 500 and res.status_code != 429:
                    raise RuntimeError(f"POST {path} -> {res.status_code}: {res.text[:400]}")
                log.warning("POST %s -> %s, retry %d", path, res.status_code, attempt + 1)
            except requests.RequestException as exc:
                log.warning("POST %s failed (%s), retry %d", path, exc, attempt + 1)
            time.sleep(delay)
            delay = min(delay * 2, 30)
        raise RuntimeError(f"POST {path} failed after retries")

    def progress(self, job_id: str, **fields: Any) -> None:
        # Progress is advisory: never let a failed status ping kill a run that
        # is otherwise making progress.
        try:
            self._post(f"/api/internal/jobs/{job_id}/progress", fields)
        except Exception as exc:  # noqa: BLE001
            log.warning("progress update failed: %s", exc)

    def put_photos(self, event_id: str, source_id: str, photos: list[dict]) -> dict[str, str]:
        ids: dict[str, str] = {}
        for part in chunked(photos, 100):
            res = self._post(
                f"/api/internal/events/{event_id}/photos",
                {"source_id": source_id, "photos": part},
            )
            ids.update(res.get("photo_ids", {}))
        return ids

    def already_indexed(self, event_id: str, complete_only: bool = False) -> set[str]:
        """drive_file_ids this event already has, so a re-run can skip them.

        `complete_only` counts a photo as done when it HAS FACES, which is what
        a rebuild needs: after wiping faces the photo rows still exist, so the
        default key would skip everything.
        """
        try:
            res = self.session.get(
                f"{self.cfg.api_base_url}/api/internal/events/{event_id}/indexed"
                + ("?complete=1" if complete_only else ""), timeout=60
            )
            res.raise_for_status()
            return set(res.json().get("drive_file_ids", []))
        except Exception as exc:  # noqa: BLE001 - resume is an optimisation
            log.warning("Could not fetch indexed ids (%s); processing everything", exc)
            return set()

    def put_bibs(self, event_id: str, bibs: list[dict],
                 replace_photos: list[str] | None = None) -> None:
        """Write bibs. `replace_photos` clears those photos' existing bibs first,
        so a re-read replaces rather than accumulates."""
        first = True
        for part in chunked(bibs, 150):
            payload = {"bibs": part}
            # Only the first chunk clears, or later chunks would delete what
            # their predecessors just wrote.
            if first and replace_photos:
                payload["replace_photos"] = replace_photos
                first = False
            self._post(f"/api/internal/events/{event_id}/bibs", payload)
        # Photos that yielded no bib at all still need their stale rows cleared.
        if first and replace_photos:
            self._post(f"/api/internal/events/{event_id}/bibs",
                       {"bibs": [], "replace_photos": replace_photos})

    def reserve_rows(self, event_id: str, shard_key: str, count: int) -> int:
        """Ask the Worker for this shard's global row offset.

        Allocating locally would let two concurrently-indexed sources choose the
        same base and overwrite each other's rows.
        """
        res = self._post(
            f"/api/internal/events/{event_id}/reserve-rows",
            {"shard_key": shard_key, "count": count},
        )
        return int(res["row_base"])

    def put_faces(self, event_id: str, shard_key: str, row_base: int, rows: list[dict]) -> None:
        # Only the first chunk may clear the existing row range — otherwise each
        # subsequent chunk would delete the rows the previous one just wrote.
        for i, part in enumerate(chunked(rows, 120)):
            self._post(
                f"/api/internal/events/{event_id}/faces",
                {
                    "shard_key": shard_key,
                    "row_base": row_base,
                    "row_count": len(rows),
                    "replace": i == 0,
                    "rows": part,
                },
            )

    def request_continue(self, job_id: str) -> bool:
        """Ask the Worker to re-dispatch this job after a Drive rate limit.

        The runner cannot re-dispatch itself: GH_DISPATCH_TOKEN lives only in
        the Worker, deliberately, so a CI runner never holds a token that can
        trigger workflows.
        """
        try:
            res = self._post(f"/api/internal/jobs/{job_id}/continue", {})
            return bool(res.get("dispatched"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not request continuation: %s", exc)
            return False

    def log(self, event_id: str, entries: list[dict]) -> None:
        """Append ingest journal entries. Advisory — never fail a run over it."""
        if not entries:
            return
        try:
            for part in chunked(entries, 100):
                self._post(f"/api/internal/events/{event_id}/log", {"entries": part})
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not write ingest log: %s", exc)

    def set_discovered(self, source_id: str, count: int) -> None:
        try:
            self._post(f"/api/internal/sources/{source_id}/discovered", {"count": count})
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not record discovered count: %s", exc)

    def benchmark(self, benchmark_id: str, **fields: Any) -> None:
        try:
            self._post(f"/api/internal/benchmarks/{benchmark_id}", fields)
        except Exception as exc:  # noqa: BLE001
            log.warning("benchmark update failed: %s", exc)

    def finalize(self, event_id: str, status: str) -> dict:
        return self._post(f"/api/internal/events/{event_id}/finalize", {"status": status})
