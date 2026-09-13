"""The row_idx <-> embedding lockstep, pinned before parallelism can break it.

faces.row_idx is a POSITION in the int8 shard written to R2. It is taken from
len(embeddings) at the instant the embedding is appended, and the two are
maintained by two adjacent statements. Break that ordering and nothing raises
and nothing logs: face rows simply point at other people's vectors, and face
search starts returning strangers to whoever searches.

That is the failure mode parallelising the per-photo loop invites, so the
assembler is built to make it structurally impossible — workers hand back plain
data and never see the counter, and one assembler serves both the sequential and
the parallel path. These tests are what hold that property in place.

No models needed: what is under test is the bookkeeping, not the detector.
"""
from __future__ import annotations

import hashlib

import numpy as np

from indexer.timing import Stages


def _assemble():
    """Imported inside the test, not at module scope, and that is load-bearing.

    indexer.main binds FaceEngine with `from .faces import FaceEngine`, so the
    fake that test_run_continuation installs only reaches it if indexer.main is
    first imported AFTER that module has been collected. Importing it up here —
    this file sorts earlier alphabetically — locks the real class in and breaks
    22 tests in a file that never mentions this one.

    That fragility is not new and is not this module's to fix (conftest's own
    docstring describes the same trap for cv2). Sidestepping it is: nothing here
    needs indexer.main at collection time.
    """
    from indexer.bench_pipeline import _assemble as fn

    return fn


def _face(seed: int, bib=None) -> dict:
    """A face whose embedding is a recognisable constant, so a row pointing at
    the wrong one is visible by inspection rather than only by hash."""
    return {"bbox": (1.0, 2.0, 3.0, 4.0), "det_score": 0.5,
            "q": np.full(512, seed, dtype=np.int8), "bib": bib}


def _result(fid: str, seeds: list, decoded: bool = True) -> dict:
    return {"drive_file_id": fid, "decoded": decoded,
            "faces": [_face(s) for s in seeds],
            "torso_bibs": [], "tile_bibs": [], "stages": Stages().as_dict()}


def _fixture(order=("a", "b", "c")):
    thumbs = {k: (f"sha-{k}", 100, 50) for k in ("a", "b", "c")}
    names = {k: f"{k}.jpg" for k in ("a", "b", "c")}
    # 2 faces, then 0, then 1 — the zero-face photo matters: it must consume no
    # row at all, and an off-by-one there shifts every row after it.
    made = {"a": _result("a", [11, 22]), "b": _result("b", []), "c": _result("c", [33])}
    return [made[k] for k in order], thumbs, names


def _assert_self_consistent(rows, embeddings):
    """The invariant the whole design exists to protect."""
    claimed = []
    for row in rows:
        for face in row["faces"]:
            idx = face["row_idx"]
            assert 0 <= idx < len(embeddings), f"row_idx {idx} out of range"
            claimed.append(idx)
            # The embedding sitting at this face's row must be this face's own.
            assert face["emb_sha1"] == hashlib.sha1(
                embeddings[idx].tobytes(order="C")).hexdigest()
    assert sorted(claimed) == list(range(len(embeddings))), \
        "every shard row must be claimed by exactly one face"


def test_row_idx_matches_the_sequential_order_exactly():
    results, thumbs, names = _fixture()
    embeddings: list = []
    rows = _assemble()(results, thumbs, names, embeddings, Stages())

    assert [r["drive_file_id"] for r in rows] == ["a", "b", "c"]
    # Not merely self-consistent — IDENTICAL to what the sequential loop builds.
    # a's two faces take rows 0 and 1, b contributes none, c takes row 2.
    assert [f["row_idx"] for r in rows for f in r["faces"]] == [0, 1, 2]
    assert len(embeddings) == 3
    assert embeddings[0][0] == 11 and embeddings[1][0] == 22 and embeddings[2][0] == 33
    _assert_self_consistent(rows, embeddings)


def test_a_photo_with_no_faces_consumes_no_row():
    results, thumbs, names = _fixture()
    embeddings: list = []
    rows = _assemble()(results, thumbs, names, embeddings, Stages())
    assert rows[1]["drive_file_id"] == "b" and rows[1]["faces"] == []
    # c's face must still land on row 2, not row 3.
    assert rows[2]["faces"][0]["row_idx"] == 2


def test_an_undecodable_photo_is_dropped_without_shifting_rows():
    results, thumbs, names = _fixture()
    results[1] = _result("b", [], decoded=False)
    embeddings: list = []
    rows = _assemble()(results, thumbs, names, embeddings, Stages())
    assert [r["drive_file_id"] for r in rows] == ["a", "c"]
    assert [f["row_idx"] for r in rows for f in r["faces"]] == [0, 1, 2]
    _assert_self_consistent(rows, embeddings)


def test_out_of_order_completion_stays_self_consistent_but_moves_the_shard():
    """Why imap and not imap_unordered.

    Results arriving in a different order do NOT corrupt anything — the parent
    still appends the embedding and its row_idx together, so every face points
    at its own vector. What changes is which row each face lands on, and so the
    byte layout of the shard.

    That is survivable, and it is precisely why the equivalence check compares
    per-photo SETS rather than raw row order. imap is used anyway, because a
    shard identical to the sequential one is a far cheaper thing to prove correct
    than one that is merely equivalent to it.
    """
    results, thumbs, names = _fixture(order=("c", "a", "b"))
    embeddings: list = []
    rows = _assemble()(results, thumbs, names, embeddings, Stages())
    _assert_self_consistent(rows, embeddings)
    # c went first, so it took row 0 — the sequential build put it on row 2.
    assert {r["drive_file_id"]: [f["row_idx"] for f in r["faces"]]
            for r in rows} == {"c": [0], "a": [1, 2], "b": []}
