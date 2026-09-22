"""Turn a Drive filename into the post the photo was mirrored from.

An album that came from somewhere public — a Telegram channel, a photographer's
gallery — has a better "see the original" than our Drive copy: the page the
photographer published, with their caption and their credit. The only per-photo
identifier that survives the trip into Drive is the FILENAME, so the link is
rebuilt from that plus a template the organizer sets once on the source.

    expand("https://t.me/grkpp/{n}", "016616.jpg")
    -> "https://t.me/grkpp/16616"

Placeholders:

    {name}  the filename as stored          016616.jpg
    {stem}  filename without its extension  016616
    {n}     {stem} with leading zeros cut   16616

{n} is separate from {stem} because the two differ exactly where it matters: a
zero-padded name sorts correctly in a Drive listing, but t.me/grkpp/016616 is
not a post — the origin numbers its own items without padding.
"""
from __future__ import annotations

import posixpath

PLACEHOLDERS = ("{name}", "{stem}", "{n}")


def unpad(stem: str) -> str:
    """'016616' -> '16616', but '000' -> '0' and 'abc' -> 'abc'.

    Only digits are unpadded. A name that is not a number is passed through
    untouched rather than mangled, because a template pointing at a non-numeric
    origin id is a legitimate use and silently truncating it would produce a
    link that resolves to the wrong post — worse than no link at all.
    """
    if not stem.isdigit():
        return stem
    return str(int(stem))


def expand(template: str | None, filename: str) -> str | None:
    """Resolve one photo's origin link, or None when there is nothing to build.

    Returns None for a missing template and for a template that contains no
    placeholder at all: the latter would otherwise give every photo in the album
    the SAME url, which reads as a per-photo link in the UI but is not one.
    """
    if not template or not filename:
        return None
    if not any(ph in template for ph in PLACEHOLDERS):
        return None
    stem = posixpath.splitext(filename)[0]
    return (template
            .replace("{name}", filename)
            .replace("{stem}", stem)
            .replace("{n}", unpad(stem)))
