"""expand() — rebuilding the post a mirrored photo came from.

The link is reconstructed from the Drive FILENAME, because that is the only
per-photo identifier that survives the trip from the origin into Drive. Getting
it wrong is silent: a template that resolves to the wrong post sends a runner to
a stranger's photo, and one that resolves to the same post for every photo looks
like a working link until someone clicks two of them.
"""
from indexer.source_url import expand, unpad


class TestUnpad:
    def test_strips_the_padding_drive_needs_but_the_origin_does_not(self):
        # Drive sorts 016616 correctly; t.me/grkpp/016616 is not a post.
        assert unpad("016616") == "16616"

    def test_a_number_that_is_all_zeros_keeps_one(self):
        # str(int()) rather than lstrip('0'), which would leave '' here and
        # build a url ending in a bare slash.
        assert unpad("000") == "0"

    def test_a_name_that_is_not_a_number_is_left_alone(self):
        # Truncating a non-numeric id would resolve to the WRONG post, which is
        # worse than offering no link at all.
        assert unpad("abc") == "abc"
        assert unpad("img_01") == "img_01"

    def test_an_unpadded_number_is_unchanged(self):
        assert unpad("16616") == "16616"


class TestExpand:
    def test_the_telegram_case(self):
        assert expand("https://t.me/grkpp/{n}", "016616.jpg") == "https://t.me/grkpp/16616"

    def test_stem_keeps_the_padding(self):
        assert expand("https://x/{stem}", "016616.jpg") == "https://x/016616"

    def test_name_is_the_whole_filename(self):
        assert expand("https://x/{name}", "016616.jpg") == "https://x/016616.jpg"

    def test_no_template_means_no_link(self):
        # The state of every ordinary Drive album, which is most of them.
        assert expand(None, "016616.jpg") is None
        assert expand("", "016616.jpg") is None

    def test_a_template_with_no_placeholder_is_refused(self):
        # It would give every photo in the album the SAME url, which reads as a
        # per-photo link in the UI but is not one.
        assert expand("https://t.me/grkpp", "016616.jpg") is None

    def test_a_missing_filename_yields_nothing(self):
        assert expand("https://x/{n}", "") is None

    def test_a_name_with_dots_keeps_all_but_the_extension(self):
        assert expand("https://x/{stem}", "2026.09.20-016616.jpg") == "https://x/2026.09.20-016616"

    def test_a_name_with_no_extension_still_resolves(self):
        assert expand("https://x/{n}", "016616") == "https://x/16616"
