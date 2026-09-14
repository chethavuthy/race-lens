"""What the folder walk will and will not enter.

The distinction under test cost a real album: NIGHT RUNNERS CLUB linked a folder
that held a shortcut to the photographer's nightclub work, and a second pass
followed it and put 105 photos of a club night — with face vectors — into a
running album. Subfolders must still be entered, or Angkor's 22-folder album
stops working, so "recurse" and "follow a shortcut out of the tree" have to stay
separable.
"""
from __future__ import annotations

from indexer.drive import DriveClient

FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"


def image(i: str, name: str = "p.jpg") -> dict:
    return {"id": i, "name": name, "mimeType": "image/jpeg", "size": "100"}


def client(tree: dict[str, list[dict]]) -> DriveClient:
    """A DriveClient whose listing is `tree`, keyed by folder id."""
    c = DriveClient("key")
    c.list_folder = lambda fid: iter(tree.get(fid, []))  # type: ignore[method-assign]
    return c


def test_enters_real_subfolders():
    walk = client({
        "root": [image("a"), {"id": "sub", "name": "Day 2", "mimeType": FOLDER}],
        "sub": [image("b")],
    }).walk("root")

    assert {i.id for i in walk.images} == {"a", "b"}
    assert walk.folders == 2
    assert walk.skipped_shortcuts == []


def test_does_not_enter_a_shortcut_to_a_folder():
    """The regression. `Hideaway` is reachable, and must not be read."""
    walk = client({
        "root": [
            image("race1"),
            {"id": "sc", "name": "Hideaway_08_Angust", "mimeType": SHORTCUT,
             "shortcutDetails": {"targetId": "club", "targetMimeType": FOLDER}},
        ],
        "club": [image("party1"), image("party2")],
    }).walk("root")

    assert {i.id for i in walk.images} == {"race1"}
    assert walk.skipped_shortcuts == ["Hideaway_08_Angust"]


def test_a_shortcut_to_an_image_is_still_resolved():
    """It points AT a photo rather than out of the tree, so it costs nothing."""
    walk = client({
        "root": [
            {"id": "sc", "name": "hero.jpg", "mimeType": SHORTCUT,
             "shortcutDetails": {"targetId": "real", "targetMimeType": "image/jpeg"}},
        ],
    }).walk("root")

    assert [i.id for i in walk.images] == ["real"]
    assert walk.skipped_shortcuts == []


def test_the_same_shortcut_is_reported_once():
    """A photographer who drops the same link in two subfolders is one problem."""
    sc = {"id": "sc", "name": "Hideaway", "mimeType": SHORTCUT,
          "shortcutDetails": {"targetId": "club", "targetMimeType": FOLDER}}
    walk = client({
        "root": [sc, {"id": "sub", "name": "Day 2", "mimeType": FOLDER}],
        "sub": [sc],
    }).walk("root")

    assert walk.skipped_shortcuts == ["Hideaway"]


def test_a_folder_reached_twice_is_walked_once():
    walk = client({
        "root": [{"id": "sub", "name": "A", "mimeType": FOLDER},
                 {"id": "sub", "name": "A again", "mimeType": FOLDER}],
        "sub": [image("a")],
    }).walk("root")

    assert [i.id for i in walk.images] == ["a"]
    assert walk.folders == 2
