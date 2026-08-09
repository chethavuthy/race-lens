"""The arithmetic that decides whether an interrupted album ever finishes."""
from __future__ import annotations

from indexer.resume import pending


def test_counts_only_this_folders_files():
    folder = {"a", "b", "c"}
    indexed = {"a"}
    assert pending(folder, indexed) == {"b", "c"}


def test_ignores_other_sources_photos():
    """The regression that killed a real event's continuation chain.

    KAIIA RUPP had two links: 601 photos (fully indexed) and 510 (250 done).
    `already_indexed` is event-wide, so it returned 851. The old code computed
    `discovered - len(indexed)` = 510 - 851 = -341, so `remaining > 0` was
    false and the runner never asked for a continuation — while 260 photos
    were still missing.
    """
    folder = {f"src2-{i}" for i in range(510)}
    indexed = {f"src1-{i}" for i in range(601)} | {f"src2-{i}" for i in range(250)}

    assert len(indexed) == 851
    # The old formula, kept here so the regression is legible.
    assert len(folder) - len(indexed) == -341

    assert len(pending(folder, indexed)) == 260


def test_finished_folder_has_nothing_pending():
    folder = {"a", "b"}
    assert pending(folder, {"a", "b", "elsewhere"}) == set()


def test_a_photo_shared_by_two_sources_counts_as_done():
    """Two links can point at overlapping folders; the intersection is indexed."""
    assert pending({"dup"}, {"dup"}) == set()


def test_empty_folder_is_not_pending():
    assert pending(set(), {"a"}) == set()
