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

# Imported at module scope, NOT inside a test. test_run_continuation.py replaces
# sys.modules["indexer.bibs"] with a stub when pytest COLLECTS it, so an import
# inside a test body here resolves to that stub and fails on names it lacks. Bound
# at import time, these stay the real thing. See conftest.py on collection order.
from indexer.bibs import (
    DEFAULT_MIN_DIGITS,
    MAX_DIGITS,
    BibHit,
    BibReader,
    _prefer_prefixed,
    bib_pattern,
    normalize_bib,
    parse_prefixes,
)


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


# --- letter prefixes ----------------------------------------------------------


def test_a_letter_bib_is_rejected_when_the_event_declares_no_prefixes():
    """The default, and every event that predates the setting.

    "F-0092" is read by RapidOCR as ONE token at confidence 1.00 — verified
    against the engine, not assumed — and dropped here, because a bib must be
    digits all the way through unless the race says otherwise. This is why the
    admin control's digit options cannot answer "what about F-0092": the answer is
    the prefix list, not a digit count.
    """
    for min_digits in (2, 3, 4, 5):
        pat = bib_pattern(min_digits)          # no prefixes
        for printed in ("F-0092", "F0092", "A12", "M-0092"):
            assert not pat.match(printed), f"{printed} at min {min_digits}"


def test_a_declared_prefix_is_accepted_in_every_printed_form():
    """Tight, hyphenated or spaced — the same bib either way."""
    pat = bib_pattern(3, ("F", "M"))
    for printed in ("F-0092", "F0092", "F 0092", "M-0092", "0092"):
        assert pat.match(printed), printed


def test_an_undeclared_prefix_stays_rejected():
    """The whitelist is the whole defence against kit text and signage.

    Without it, "XL-500" (a shirt size) and any sponsor's letter-number pairing
    become candidate bibs.
    """
    pat = bib_pattern(3, ("F", "M"))
    for printed in ("K-0092", "XL-500", "0092F", "42Km", "FM-0092"):
        assert not pat.match(printed), printed


def test_prefixes_do_not_relax_the_digit_rules():
    """A prefix buys a letter, not a different number shape."""
    pat = bib_pattern(3, ("F",))
    assert not pat.match("F-92"), "two digits, below this event's floor"
    assert not pat.match("F-123456"), "past the five-digit ceiling"
    assert pat.match("F-0092")


def test_the_bare_and_prefixed_forms_are_different_bibs():
    """The reason the prefix is stored rather than stripped: at a mixed race 0001
    is a marathon runner and F-0001 is a 10k woman."""
    assert normalize_bib("0001") != normalize_bib("F-0001")
    assert normalize_bib("F-0001") != normalize_bib("M-0001")


def test_rejoining_a_split_bib_does_not_leave_the_bare_number_behind():
    """_prefer_prefixed, and why it is not merely tidying.

    A bib that prints its category letter in a separate box yields two OCR
    tokens, so rejoining produces BOTH 'F-0092' and the bare '0092' it was built
    from, at identical confidence. Keeping both files a 10k woman's photo under
    the marathon runner who owns 0092 — and read_torso's max-by-confidence would
    pick between them arbitrarily. The prefixed reading wins because the letter
    was printed right beside those digits.
    """
    kept = _prefer_prefixed([
        BibHit(bib="F-92", conf=1.0, raw="F-0092"),
        BibHit(bib="92", conf=1.0, raw="0092"),
    ])
    assert [h.bib for h in kept] == ["F-92"]

    # A DIFFERENT number elsewhere in the frame is untouched: it is another
    # runner, not the same bib read twice.
    kept2 = _prefer_prefixed([
        BibHit(bib="F-92", conf=1.0, raw="F-0092"),
        BibHit(bib="7", conf=0.9, raw="0007"),
    ])
    assert sorted(h.bib for h in kept2) == ["7", "F-92"]

    # Nothing prefixed in the crop: bare numbers pass through as they always did.
    kept3 = _prefer_prefixed([BibHit(bib="92", conf=1.0, raw="0092")])
    assert [h.bib for h in kept3] == ["92"]


# --- the two-runtime contract -------------------------------------------------
#
# normalize_bib decides what goes INTO bibs.bib; normalizeBib in
# apps/api/src/bib.ts decides what a runner's typing resolves to. If the two ever
# disagree, nothing throws — bib search just returns nothing for an album whose
# bibs are sitting in the table. These cases are duplicated verbatim in
# apps/api/test/bib.test.ts, which is what makes them a contract rather than two
# independent opinions.


@pytest.mark.parametrize("printed,stored", [
    ("56", "56"),
    ("0056", "56"),
    ("0000", "0"),
    (" 56 ", "56"),
    ("12345", "12345"),
    ("123456", ""),
    ("", ""),
    ("PAC", ""),
    # The prefix is identity — if any of these yield a bare number, one runner's
    # photos land under another's bib.
    ("F-0001", "F-1"),
    ("f-0001", "F-1"),
    ("F 0001", "F-1"),
    ("F0001", "F-1"),
    ("F-1", "F-1"),
    ("MW-0001", "MW-1"),
    ("M-0001", "M-1"),
    # Must never become bibs.
    ("0092F", ""),
    ("42Km", ""),
    ("XLL-500", ""),
    ("F92F", ""),
])
def test_canonical_form_matches_the_worker(printed, stored):
    assert normalize_bib(printed) == stored


def test_a_bare_number_is_never_the_prefixed_one():
    """The whole point, stated as its own case so it cannot be refactored away."""
    assert normalize_bib("0001") != normalize_bib("F-0001")
    assert normalize_bib("F-0001") != normalize_bib("M-0001")


@pytest.mark.parametrize("raw,expected", [
    ("F, m , f", ("F", "M")),
    ("F,42,M,", ("F", "M")),
    ("F,XLL", ("F",)),
    ("F;M", ("F", "M")),
    ("", ()),
    (None, ()),
])
def test_prefix_parsing_matches_the_worker(raw, expected):
    assert parse_prefixes(raw) == expected


# --- "every bib has a letter" -------------------------------------------------


def test_requiring_a_prefix_rejects_the_bare_number():
    """The whole point: at a race with no plain bibs, a read that lost the letter
    must be dropped rather than filed under whoever owns those digits."""
    pat = bib_pattern(4, ("F", "M"), 4, prefix_required=True)
    assert pat.match("F-0001") and pat.match("M0001") and pat.match("F 0001")
    assert not pat.match("0001"), "a bare number is not a bib at this race"


def test_not_requiring_a_prefix_keeps_the_mixed_race_working():
    """0001 marathon / F-0001 10k — both are real, so both must read."""
    pat = bib_pattern(4, ("F", "M"), 4, prefix_required=False)
    assert pat.match("0001") and pat.match("F-0001")


def test_requiring_a_prefix_without_listing_any_is_ignored():
    """Otherwise the pattern matches nothing and the album reads no bibs at all —
    with no error anywhere, which is the failure this area keeps producing.

    The flag is a refinement of the whitelist, so it cannot mean anything without
    one. Degrades to plain digits rather than to silence.
    """
    pat = bib_pattern(4, (), 4, prefix_required=True)
    assert pat.match("0001"), "no letters listed -> behave exactly as digits-only"


def test_requiring_a_prefix_still_rejects_undeclared_letters():
    pat = bib_pattern(4, ("F",), 4, prefix_required=True)
    assert pat.match("F-0001")
    assert not pat.match("K-0001")
    assert not pat.match("0001F")


def test_the_reader_ignores_the_flag_when_it_has_no_prefixes(monkeypatch):
    """The same guard one layer up, where main.py actually passes the setting.

    BibReader is constructed for real — with a stub OCR engine, since neither
    RapidOCR nor PaddleOCR is installed in the test env — because the guard lives
    in __init__ and asserting it on bib_pattern alone would not cover the wiring.
    """
    import sys
    import types

    stub = types.ModuleType("rapidocr_onnxruntime")
    stub.RapidOCR = lambda *a, **k: (lambda img: ([], None))
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", stub)

    # Letters listed: the flag applies.
    with_letters = BibReader(min_digits=4, prefixes="F,M", max_digits=4,
                             prefix_required=True)
    assert with_letters.prefix_required is True
    assert not with_letters.bib_re.match("0001")
    assert with_letters.bib_re.match("F-0001")

    # No letters listed: the flag is dropped rather than left to match nothing.
    without = BibReader(min_digits=4, prefixes="", max_digits=4, prefix_required=True)
    assert without.prefix_required is False
    assert without.bib_re.match("0001")
