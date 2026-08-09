"""download_thumb's retry and error classification.

The distinction under test is load-bearing: QuotaExceeded ends the whole pass
(and, if the job has indexed nothing yet, the continuation chain with it),
while NotAccessible skips one photo and carries on. Collapsing the two meant a
single transient 503 could strand a 1111-photo album.
"""
from __future__ import annotations

import pytest

from indexer.drive import DriveClient, NotAccessible, QuotaExceeded


class FakeResponse:
    def __init__(self, status_code: int, body: bytes = b""):
        self.status_code = status_code
        self._body = body
        self.text = body.decode("utf-8", "replace")

    def iter_content(self, chunk_size: int = 0):
        yield self._body


class FakeSession:
    """Returns each queued response in turn, recording every call."""

    def __init__(self, responses: list[FakeResponse]):
        self._responses = list(responses)
        self.calls = 0

    def get(self, url, params=None, stream=False, timeout=None, allow_redirects=False):
        self.calls += 1
        if not self._responses:
            raise AssertionError("more requests than the test queued")
        return self._responses.pop(0)


# A real photo has to clear download_thumb's 20 KB error-page guard.
PHOTO = b"\xff\xd8\xff" + b"x" * 30_000


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    """Backoff is real; waiting for it in tests is not."""
    monkeypatch.setattr("indexer.drive.time.sleep", lambda _: None)


def client(responses):
    session = FakeSession(responses)
    return DriveClient("test-key", session=session), session


def test_writes_the_photo_on_success(tmp_path):
    drive, session = client([FakeResponse(200, PHOTO)])
    dest = tmp_path / "photo.jpg"

    drive.download_thumb("file-1", str(dest))

    assert dest.read_bytes() == PHOTO
    assert session.calls == 1


def test_retries_a_transient_503_then_succeeds(tmp_path):
    """The exact case that used to end a pass on its first blip."""
    drive, session = client([
        FakeResponse(503),
        FakeResponse(503),
        FakeResponse(200, PHOTO),
    ])
    dest = tmp_path / "photo.jpg"

    drive.download_thumb("file-1", str(dest))

    assert dest.read_bytes() == PHOTO
    assert session.calls == 3


@pytest.mark.parametrize("status", [403, 429, 500, 502, 503, 504])
def test_retryable_statuses_are_retried(tmp_path, status):
    drive, session = client([FakeResponse(status), FakeResponse(200, PHOTO)])

    drive.download_thumb("f", str(tmp_path / "p.jpg"))

    assert session.calls == 2


def test_sustained_throttle_raises_quota_after_eight_attempts(tmp_path):
    drive, session = client([FakeResponse(429) for _ in range(8)])

    with pytest.raises(QuotaExceeded):
        drive.download_thumb("f", str(tmp_path / "p.jpg"))

    assert session.calls == 8


def test_404_is_not_retried_and_is_not_a_quota_error(tmp_path):
    drive, session = client([FakeResponse(404)])

    with pytest.raises(NotAccessible):
        drive.download_thumb("f", str(tmp_path / "p.jpg"))

    assert session.calls == 1


def test_unshared_folder_error_page_is_not_a_quota_error(tmp_path):
    """Drive answers 200 with a small HTML login page when a file isn't shared."""
    drive, _ = client([FakeResponse(200, b"<html>Sign in</html>")])

    with pytest.raises(NotAccessible) as exc:
        drive.download_thumb("f", str(tmp_path / "p.jpg"))

    assert "anyone with the link" in str(exc.value)
    # The message must not assert a cause it cannot actually distinguish.
    assert "transient" in str(exc.value)


def test_unexpected_4xx_is_not_retried(tmp_path):
    drive, session = client([FakeResponse(418)])

    with pytest.raises(NotAccessible):
        drive.download_thumb("f", str(tmp_path / "p.jpg"))

    assert session.calls == 1


def test_quota_and_not_accessible_are_unrelated_types():
    """main.py catches QuotaExceeded first; NotAccessible must fall past it."""
    assert not issubclass(NotAccessible, QuotaExceeded)
    assert not issubclass(QuotaExceeded, NotAccessible)
