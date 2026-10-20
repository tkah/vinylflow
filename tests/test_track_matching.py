"""Pure title normalization / tracklist matching for borrowed lengths."""

from __future__ import annotations

from track_matching import coverage, match_tracklists, normalize_title


class T:
    def __init__(self, title, duration=""):
        self.title = title
        self.duration_str = duration


def test_normalize_basic_and_punctuation():
    assert normalize_title("  Don't Stop!  ") == "don t stop"
    assert normalize_title("Rock & Roll") == "rock and roll"


def test_normalize_diacritics():
    assert normalize_title("Café del Mar") == normalize_title("Cafe Del Mar")
    assert normalize_title("Björk") == "bjork"


def test_normalize_trailing_parentheticals():
    assert normalize_title("Heroes (Remastered 2011)") == "heroes"
    assert normalize_title("Heroes [Live]") == "heroes"
    assert normalize_title("Heroes (Album Version) [Remastered]") == "heroes"
    assert normalize_title("Heroes (Part 1) (Remastered)") == "heroes"


def test_normalize_keeps_inner_parenthetical_and_all_paren_titles():
    assert normalize_title("(I Can't Get No) Satisfaction") == "i can t get no satisfaction"
    assert normalize_title("(Untitled)") == "untitled"


def test_normalize_feat():
    assert normalize_title("Song (feat. Someone)") == "song"
    assert normalize_title("Song ft. Someone Else") == "song"
    assert normalize_title("Song featuring X & Y") == "song"
    assert normalize_title(None) == ""


def test_match_exact_with_lengths():
    m = match_tracklists(["One", "Two"], [T("One", "3:00"), T("Two", "4:05")])
    assert [(x.target_index, x.donor_index, x.length) for x in m] == [(0, 0, "3:00"), (1, 1, "4:05")]
    assert coverage(m) == 2


def test_match_remaster_and_feat_suffixes():
    m = match_tracklists(["Heroes", "Fame"], [T("Heroes (Remastered 2017)", "6:07"), T("Fame feat. X", "3:30")])
    assert len(m) == 2 and coverage(m) == 2


def test_match_diacritics_and_small_typos():
    m = match_tracklists(["Cafe del Mar", "Colour Me Bad"], [T("Café del Mar", "7:00"), T("Color Me Bad", "2:00")])
    assert len(m) == 2


def test_match_extra_donor_bonus_tracks():
    donor = [T("One", "1:00"), T("Bonus", "9:00"), T("Two", "2:00"), T("Bonus 2", "3:00")]
    m = match_tracklists(["One", "Two"], donor)
    assert [(x.target_index, x.donor_index) for x in m] == [(0, 0), (1, 2)]


def test_match_swapped_order():
    m = match_tracklists(["One", "Two", "Three"], [T("Two", "2:00"), T("One", "1:00"), T("Three", "3:00")])
    got = {x.target_index: x.length for x in m}
    assert got == {0: "1:00", 1: "2:00", 2: "3:00"}


def test_match_no_match():
    assert match_tracklists(["Alpha"], [T("Completely Different", "1:00")]) == []
    assert match_tracklists([], [T("A", "1:00")]) == []
    assert match_tracklists(["Alpha"], []) == []


def test_match_is_one_to_one_and_prefers_nearest_on_ties():
    donor = [T("Intro", "0:30"), T("Mid", "3:00"), T("Intro", "0:45")]
    m = match_tracklists(["Mid", "Intro", "Intro"], donor)
    by_t = {x.target_index: x for x in m}
    assert by_t[1].donor_index == 0  # tie between 0 and 2: nearest to index 1 (both 1 away) -> lower
    assert by_t[2].donor_index == 2
    assert len({x.donor_index for x in m}) == len(m)


def test_partial_lengths_only_counted_when_parseable():
    donor = [T("One", "3:00"), T("Two", ""), T("Three", "n/a")]
    m = match_tracklists(["One", "Two", "Three"], donor)
    assert len(m) == 3
    assert coverage(m) == 1
    assert [x.length for x in m] == ["3:00", None, None]


def test_accepts_dicts_and_normalizes_length():
    m = match_tracklists(["One"], [{"title": "One", "duration": "03:05"}])
    assert m[0].length == "3:05"
