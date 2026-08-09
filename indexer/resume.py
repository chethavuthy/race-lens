"""What a pass still has left to do.

Deliberately its own module, importing nothing: main.py pulls numpy, Pillow and
insightface at import time, so anything living there cannot be unit-tested
without the full CV stack. The arithmetic here decides whether an interrupted
album ever finishes, which is worth being able to test on its own.
"""
from __future__ import annotations


def pending(folder_ids: set[str], indexed: set[str]) -> set[str]:
    """Ids in THIS folder that the event has not indexed yet.

    Both callers must go through the set difference rather than subtracting
    counts. `indexed` is event-wide while `folder_ids` covers a single source,
    so `len(folder_ids) - len(indexed)` goes negative as soon as the event's
    other sources push the total past this one's size — which read as "nothing
    left to do" and silently killed the continuation chain on a two-link event
    with 260 photos still missing.
    """
    return folder_ids - indexed
