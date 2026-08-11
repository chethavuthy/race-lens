"""Make `import indexer.main` work without the heavy CV stack.

CI installs numpy, Pillow and requests only — onnxruntime, insightface, opencv and
rapidocr together are several minutes of install for code the tests never execute.
But `indexer.main` imports `.bibs` (which imports cv2) and `.upload` (which imports
boto3) at module scope, so the import fails long before any test body runs.

This lives in conftest.py rather than inside a test module because pytest imports
conftest before collecting anything, which makes the stubs unconditional. They used
to be installed at module scope in test_run_continuation.py, so every other test
file silently depended on that one being COLLECTED FIRST — true only by alphabetical
accident. `pytest indexer/tests/test_thumbnail_dims.py` on its own died with
ModuleNotFoundError: cv2 while the full suite passed.

setdefault throughout, so a real installation always wins.
"""
from __future__ import annotations

import sys
import types


def _stub(name: str, **attrs: object) -> None:
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules.setdefault(name, mod)


def pytest_configure() -> None:
    # cv2: reached through indexer.bibs. Only resize/INTER_AREA are ever called,
    # and only on paths these tests do not take.
    _stub("cv2", resize=lambda img, size, interpolation=None: img, INTER_AREA=3)

    # boto3/botocore: indexer.upload builds an S3 client at construction time.
    # Every test either replaces Uploader wholesale or never constructs one.
    _stub("boto3", client=lambda *a, **k: None)
    _stub("botocore")
    _stub("botocore.config", Config=lambda **k: None)
