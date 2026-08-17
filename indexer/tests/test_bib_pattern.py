"""The digit floor that decides whether an album's bib search works at all.

This one line hard-coded 3, which is correct at Angkor (3-4 digit zero-padded
bibs) and silently wrong at SheRuns, whose bibs are two digits: measured over 40
originals / 199 faces, a floor of 3 accepted ZERO bibs. Nothing in the pipeline
reported a problem — bib search was simply empty.

So the pattern is worth testing directly, in both directions: that a lowered
floor admits the short bibs it is for, and that it still rejects the fragments
and noise the original floor existed to keep out.

cv2 is stubbed by conftest, which is what lets the real bibs module import here.
"""
from __future__ import annotations

import pytest

from indexer.bibs import DEFAULT_MIN_DIGITS, MAX_DIGITS, bib_pattern


def test_the_default_is_what_was_hard_coded():
    """Angkor and every event that predates the setting must not shift."""
    assert DEFAULT_MIN_DIGITS == 3
    pat = bib_pattern(DEFAULT_MIN_DIGITS)
    assert pat.match("0056") and pat.match("123") and pat.match("12345")
    assert not pat.match("46"), "the floor that emptied SheRuns, kept for Angkor"


def test_a_two_digit_race_reads_its_own_bibs():
    """The bibs actually printed at SheRuns — verified against the photos."""
    pat = bib_pattern(2)
    for bib in ("46", "69", "85", "18", "51", "30", "07"):
        assert pat.match(bib), bib


def test_lowering_the_floor_still_rejects_single_digits():
    """A lone digit is a partial read of almost anything, at any race."""
    for min_digits in (2, 3):
        assert not bib_pattern(min_digits).match("5")


def test_nothing_longer_than_a_bib_gets_in():
    """The upper bound is what keeps timestamps and phone numbers out, and it
    does not move with the floor."""
    for min_digits in (2, 3, 5):
        pat = bib_pattern(min_digits)
        assert not pat.match("123456")
        assert not pat.match("20260816")


def test_non_numeric_tokens_never_match():
    """Torso crops are covered in text — 'PAC', 'PHNOMPENH', 'ATHLETICSCLUB'
    were the three most common tokens in the SheRuns sample."""
    pat = bib_pattern(2)
    for token in ("PAC", "42Km", "4-2", "", " ", "1O", "١٢"):
        assert not pat.match(token), token


@pytest.mark.parametrize("bad", [0, -1, None, 99])
def test_a_nonsense_setting_cannot_open_the_floodgates(bad):
    """The value arrives from D1 via the Worker, so it is not trusted.

    A 0 or negative would compile to a pattern accepting every integer on the
    frame — lap counters, sponsor phone numbers, jersey numbers. Clamped rather
    than raised: this runs inside a pass that must not die over a bad setting.
    """
    pat = bib_pattern(bad)
    assert not pat.match(""), bad
    assert not pat.match("123456"), bad
    # Whatever it clamped to, it is a usable bib rule: 5 digits always match,
    # because the floor can never exceed the ceiling.
    assert pat.match("12345"), bad


def test_the_floor_can_never_exceed_the_ceiling():
    """min_digits above MAX_DIGITS would compile to a pattern matching nothing,
    which is the failure mode this whole change exists to remove."""
    pat = bib_pattern(MAX_DIGITS + 3)
    assert pat.match("12345")
