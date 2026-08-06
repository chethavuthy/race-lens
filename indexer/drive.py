"""Google Drive listing and download via a plain API key.

Public link-shared folders are readable with a key alone — no OAuth, no service
account. Quota is charged to our key.
"""
from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Iterator

import requests

log = logging.getLogger(__name__)

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
IMAGE_MIMES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif",
}

FIELDS = (
    "nextPageToken,files(id,name,mimeType,size,"
    "imageMediaMetadata/time,imageMediaMetadata/width,imageMediaMetadata/height,"
    "shortcutDetails)"
)


class QuotaExceeded(Exception):
    """Drive is refusing downloads for this file/folder right now."""


@dataclass
class DriveImage:
    id: str
    name: str
    mime_type: str
    size: int | None
    taken_at: str | None
    width: int | None
    height: int | None


class DriveClient:
    def __init__(self, api_key: str, session: requests.Session | None = None) -> None:
        self.api_key = api_key
        self.session = session or requests.Session()

    def _get(self, url: str, params: dict, *, stream: bool = False) -> requests.Response:
        """GET with exponential backoff on the transient failure classes."""
        delay = 1.0
        last: requests.Response | None = None
        for attempt in range(8):
            res = self.session.get(url, params=params, stream=stream, timeout=120)
            if res.status_code < 400:
                return res
            last = res

            # Always read the body on an error, even for stream=True. Drive
            # error responses are small JSON, and skipping them here was a real
            # bug: every download 403 (stream=True) fell through unclassified,
            # so quota and rate-limit backoff never fired and 101 photos of a
            # 151-photo album were dropped while the job still reported "done".
            body = res.text[:500]
            if res.status_code == 403 and "downloadQuotaExceeded" in body:
                raise QuotaExceeded(f"downloadQuotaExceeded on {url}")
            # Drive also returns a bare 403 for per-user rate limits, sometimes
            # with no machine-readable reason at all. Treat every 403 that is not
            # an explicit permission failure as retryable.
            retryable_403 = res.status_code == 403 and not (
                "insufficientFilePermissions" in body or "notFound" in body
            )
            if res.status_code in (429, 500, 502, 503, 504) or retryable_403:
                sleep = delay + random.uniform(0, 0.5)
                log.warning("Drive %s, retrying in %.1fs (attempt %d/8)", res.status_code, sleep, attempt + 1)
                time.sleep(sleep)
                delay = min(delay * 2, 120)
                continue
            res.raise_for_status()

        assert last is not None
        # Out of retries. Surfaced as QuotaExceeded so the caller finishes the
        # run as `partial` and keeps what it already has, rather than dropping
        # the file and calling the job complete.
        raise QuotaExceeded(f"Drive kept failing with {last.status_code} after 8 attempts")

    def list_folder(self, folder_id: str) -> Iterator[dict]:
        page_token: str | None = None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed=false",
                "fields": FIELDS,
                "pageSize": 1000,
                # Both flags are mandatory. A Shared Drive returns an empty list
                # without them, which is indistinguishable from an empty folder.
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
                "key": self.api_key,
            }
            if page_token:
                params["pageToken"] = page_token
            data = self._get("https://www.googleapis.com/drive/v3/files", params).json()
            yield from data.get("files", [])
            page_token = data.get("nextPageToken")
            if not page_token:
                return

    def walk(self, root_id: str, max_folders: int = 500) -> list[DriveImage]:
        """Recursive image listing. Race albums are nearly always nested."""
        images: list[DriveImage] = []
        seen = {root_id}
        queue = [root_id]

        while queue:
            current = queue.pop(0)
            for raw in self.list_folder(current):
                mime = raw["mimeType"]
                file_id = raw["id"]

                if mime == SHORTCUT_MIME and raw.get("shortcutDetails"):
                    file_id = raw["shortcutDetails"]["targetId"]
                    mime = raw["shortcutDetails"].get("targetMimeType", "")

                if mime == FOLDER_MIME:
                    if file_id not in seen and len(seen) < max_folders:
                        seen.add(file_id)
                        queue.append(file_id)
                elif mime in IMAGE_MIMES:
                    meta = raw.get("imageMediaMetadata") or {}
                    images.append(
                        DriveImage(
                            id=file_id,
                            name=raw.get("name", file_id),
                            mime_type=mime,
                            size=int(raw["size"]) if raw.get("size") else None,
                            taken_at=meta.get("time"),
                            width=meta.get("width"),
                            height=meta.get("height"),
                        )
                    )

        log.info("Walked %d folders, found %d images", len(seen), len(images))
        return images

    # Drive's resized-image endpoint. Measured on a real 6000x4000 race photo:
    #   original  20.4 MB   8 faces, 4 bibs
    #   w3200      1.6 MB   8 faces, 4 bibs  (identical)
    # Same result for a twelfth of the bytes, and Drive's download quota is what
    # caps a pass at ~50 photos — so this is ~12x more photos per pass.
    THUMB_URL = "https://drive.google.com/thumbnail"
    THUMB_WIDTH = 3200

    def download_thumb(self, file_id: str, dest: str) -> None:
        """Fetch Drive's resized copy. Not the API, so no key and no API quota."""
        res = self.session.get(
            self.THUMB_URL,
            params={"id": file_id, "sz": f"w{self.THUMB_WIDTH}"},
            stream=True, timeout=120, allow_redirects=True,
        )
        if res.status_code >= 400:
            raise QuotaExceeded(f"thumbnail {res.status_code} for {file_id}")
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
        # A Drive error page is small and HTML; a real photo is neither.
        import os
        if os.path.getsize(dest) < 20_000:
            raise QuotaExceeded(f"thumbnail for {file_id} came back too small")

    def download(self, file_id: str, dest: str) -> None:
        res = self._get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}",
            {"alt": "media", "key": self.api_key, "supportsAllDrives": "true"},
            stream=True,
        )
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
