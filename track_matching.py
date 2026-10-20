"""VinylFlow — Track matching across pressings (pure functions).

Used by "borrow track lengths from another pressing": a target release's
track titles are matched against another pressing's tracklist so the donor's
durations can be copied over.  No I/O, no Discogs types -- donor tracks are
any objects (or dicts) with a ``title`` and a ``duration_str``/``duration``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import List, Optional, Sequence

MATCH_THRESHOLD = 0.85

_FEAT_RE = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\b.*$", re.IGNORECASE)
_TRAILING_BRACKET_RE = re.compile(r"\s*(?:\([^()\[\]]*\)|\[[^()\[\]]*\])\s*$")


def normalize_title(title: Optional[str]) -> str:
    """Comparable form of a track title.

    Lowercase; diacritics and punctuation stripped; trailing parentheticals /
    brackets ("(Remastered 2011)", "[Live]", "(Album Version)") and
    "feat./ft./featuring ..." removed.  If stripping would leave nothing
    (a title that is *only* a parenthetical), the unstripped text is used.
    """
    text = (title or "").strip()
    stripped = _FEAT_RE.sub("", text)
    while True:
        new = _TRAILING_BRACKET_RE.sub("", stripped)
        if new == stripped:
            break
        stripped = new
    for candidate in (stripped, text):
        s = unicodedata.normalize("NFKD", candidate)
        s = "".join(c for c in s if not unicodedata.combining(c))
        s = s.lower().replace("&", " and ")
        s = re.sub(r"[^a-z0-9]+", " ", s).strip()
        if s:
            return s
    return ""


def parse_duration(value) -> Optional[int]:
    """"m:ss" / "h:mm:ss" -> whole seconds, or None when unparseable/zero."""
    if not value or not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
        return None
    nums = [int(p) for p in parts]
    seconds = nums[-1] + nums[-2] * 60 + (nums[0] * 3600 if len(nums) == 3 else 0)
    return seconds or None


def format_duration(seconds: int) -> str:
    """Whole seconds -> "m:ss" (minutes may exceed 59)."""
    return f"{seconds // 60}:{seconds % 60:02d}"


def _field(track, *names):
    for n in names:
        v = track.get(n) if isinstance(track, dict) else getattr(track, n, None)
        if v is not None:
            return v
    return None


@dataclass(frozen=True)
class TrackMatch:
    target_index: int
    donor_index: int
    ratio: float
    length: Optional[str]  # normalized "m:ss"; None when the donor track has no parseable length


def match_tracklists(target_titles: Sequence[str], donor_tracks: Sequence) -> List[TrackMatch]:
    """One-to-one fuzzy match of target titles to donor tracks.

    Each target, in order, takes the best-scoring unclaimed donor track whose
    normalized-title ratio is >= MATCH_THRESHOLD; equal scores prefer the donor
    index nearest the target's own index.  Extra donor tracks (bonus tracks)
    and small order differences are tolerated.  Targets without a match are
    simply absent from the result.
    """
    donor_norm = [normalize_title(_field(t, "title") or "") for t in donor_tracks]
    claimed = set()
    matches: List[TrackMatch] = []
    for i, title in enumerate(target_titles):
        tn = normalize_title(title)
        if not tn:
            continue
        best = None  # (ratio, -distance, -j)
        for j, dn in enumerate(donor_norm):
            if j in claimed or not dn:
                continue
            r = 1.0 if tn == dn else SequenceMatcher(None, tn, dn).ratio()
            if r < MATCH_THRESHOLD:
                continue
            key = (round(r, 9), -abs(j - i), -j)
            if best is None or key > best[0]:
                best = (key, j, r)
        if best is None:
            continue
        _, j, r = best
        claimed.add(j)
        secs = parse_duration(_field(donor_tracks[j], "duration_str", "duration"))
        matches.append(TrackMatch(i, j, r, format_duration(secs) if secs else None))
    return matches


def coverage(matches: Sequence[TrackMatch]) -> int:
    """Number of matches that carry a parseable length."""
    return sum(1 for m in matches if m.length)
