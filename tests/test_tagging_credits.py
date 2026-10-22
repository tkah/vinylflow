"""Richer tags: totals, compilations, album artist, artist names, classical credits.

Releases are built through the real ``DiscogsRelease`` parser from fakes that
mimic discogs_client objects: ``Artist`` keeps its raw payload in ``.data``
(``name``, ``anv``, ``join``, ``role``, ``tracks``), ``Track.artists`` /
``Track.credits`` (``extraartists``) are lists of those, ``Release.credits`` is
``extraartists``.  No Discogs calls anywhere.
"""

import shutil
import subprocess

import pytest
from mutagen.aiff import AIFF
from mutagen.flac import FLAC
from mutagen.mp3 import MP3

from audio_processor import OUTPUT_FORMATS
from config import DEFAULT_TRACK_NUMBERING
from metadata_handler import DiscogsRelease, MetadataHandler
from backend.sessions.events import OutputSpec

SEQ = "sequential_disc_per_lp"


class FakeArtist:
    def __init__(self, name, join="", role="", tracks=""):
        self.name = name
        self.data = {"id": 1, "name": name, "anv": "", "join": join, "role": role, "tracks": tracks}


class FakeTrackObj:
    def __init__(self, position, title, artists=(), credits=()):
        self.position, self.title, self.duration = position, title, "3:00"
        self.artists, self.credits = list(artists), list(credits)


class FakeLabel:
    name = "Test Label"


class FakeReleaseObj:
    def __init__(self, artists, tracklist, genres=("Rock",), credits=(), year=1985):
        self.id, self.title, self.year = 7, "Test Album", year
        self.artists, self.tracklist, self.genres = list(artists), list(tracklist), list(genres)
        self.credits = list(credits)
        self.labels, self.formats, self.images = [FakeLabel()], [{"name": "Vinyl"}], []


class FakeTrack:
    def __init__(self, vinyl_number):
        self.vinyl_number = vinyl_number


def handler():
    return MetadataHandler(discogs_token="", user_agent="")


def tags_for(release, position, numbering=SEQ, job_positions=None):
    return handler()._build_tag_set(
        FakeTrack(position), release, None, numbering, job_positions,
    )


def two_lp_release():
    return DiscogsRelease(FakeReleaseObj(
        [FakeArtist("Nirvana (2)")],
        [FakeTrackObj(p, f"T {p}") for p in ("A1", "A2", "B1", "C1", "C2", "D1")],
    ))


def test_sequential_is_the_default():
    assert DEFAULT_TRACK_NUMBERING == SEQ
    assert OutputSpec(output_format="flac", output_dir=".").track_numbering == SEQ


def test_totals_track_per_disc_and_discs_in_release():
    release = two_lp_release()
    first, last = tags_for(release, "B1"), tags_for(release, "D1")
    assert (first.disc_number, first.track_number, first.track_total, first.disc_total) == ("1", "3", "3", "2")
    assert (last.disc_number, last.track_number, last.track_total, last.disc_total) == ("2", "3", "3", "2")


def test_vinyl_numbering_has_no_totals_or_disc():
    tags = tags_for(two_lp_release(), "A1", numbering="vinyl")
    assert (tags.track_number, tags.track_total, tags.disc_number, tags.disc_total) == ("A1", None, None, None)


def test_numbering_follows_the_record_not_the_export():
    """One file per side: side B continues after side A even when exported on its own."""
    release = two_lp_release()
    side_b = tags_for(release, "B1", job_positions=["A1", "A2", "B1"])
    assert (side_b.track_number, side_b.track_total) == ("3", "3")
    alone = tags_for(release, "B1", job_positions=["B1"])
    assert (alone.track_number, alone.track_total) == ("3", "3")


def test_job_positions_sorted_numerically():
    release = DiscogsRelease(FakeReleaseObj(
        [FakeArtist("X")], [FakeTrackObj(f"A{n}", f"T{n}") for n in (1, 2, 3, 10)],
    ))
    tags = tags_for(release, "A10", job_positions=["A10", "A2", "A1", "A3"])
    assert tags.track_number == "4"


def test_artist_names_join_strings_and_disambiguation():
    release = DiscogsRelease(FakeReleaseObj(
        [FakeArtist("Simon (3)", "&"), FakeArtist("Garfunkel (2)", ","), FakeArtist("Third")],
        [FakeTrackObj("A1", "One")],
    ))
    assert release.artist == "Simon & Garfunkel, Third"
    assert tags_for(release, "A1").album_artist == "Simon & Garfunkel, Third"
    assert handler().create_album_folder_name(release) == "Simon & Garfunkel, Third - Test Album"


def test_missing_join_falls_back_to_comma():
    release = DiscogsRelease(FakeReleaseObj([FakeArtist("A"), FakeArtist("B")], [FakeTrackObj("A1", "x")]))
    assert release.artist == "A, B"


def compilation():
    return DiscogsRelease(FakeReleaseObj(
        [FakeArtist("Various")],
        [FakeTrackObj("A1", "Song", artists=[FakeArtist("Blur (2)", " / "), FakeArtist("Pulp")]),
         FakeTrackObj("A2", "No artist")],
    ))


def test_compilation_uses_track_artists_and_album_artist():
    release = compilation()
    first, second = tags_for(release, "A1"), tags_for(release, "A2")
    assert first.artist == "Blur / Pulp"
    assert first.album_artist == "Various Artists" and first.compilation
    assert second.artist == "Various"  # no track artist: falls back to the release artist


def test_regular_album_is_not_a_compilation():
    tags = tags_for(two_lp_release(), "A1")
    assert tags.compilation is False and tags.album_artist == "Nirvana"


def classical(release_credits=(), tracks=None, artist="Beethoven"):
    return DiscogsRelease(FakeReleaseObj(
        [FakeArtist(artist)],
        tracks or [FakeTrackObj(p, f"Mvt {p}") for p in ("A1", "A2", "B1", "B2")],
        genres=["Classical"], credits=release_credits,
    ))


def test_classical_composer_falls_back_to_release_artist():
    tags = tags_for(classical(), "A1")
    assert tags.composers == ("Beethoven",)
    assert tags.artist == "Beethoven" and tags.album_artist == "Beethoven"


def test_classical_credits_and_track_ranges():
    release = classical([
        FakeArtist("Ludwig van Beethoven", role="Composed By"),
        FakeArtist("Herbert von Karajan", role="Conductor, Liner Notes"),
        FakeArtist("Berliner Philharmoniker", role="Orchestra"),
        FakeArtist("Maria Callas", role="Soprano Vocals"),  # unknown phrasing: not tagged
        FakeArtist("Wilhelm Kempff", role="Piano [Solo]", tracks="A1 to A2"),
        FakeArtist("Pierre Fournier", role="Cello", tracks="B1, B2"),
        FakeArtist("Some Producer", role="Producer"),
        FakeArtist("Some Engineer", role="Recorded By", tracks="A1"),
    ])
    a1, b2 = tags_for(release, "A1"), tags_for(release, "B2")
    assert a1.composers == ("Ludwig van Beethoven",)
    assert a1.conductors == ("Herbert von Karajan",)
    assert a1.ensembles == ("Berliner Philharmoniker",)
    assert a1.performers == (("Wilhelm Kempff", "Piano"),)  # ensembles are not soloists
    assert a1.artist == "Wilhelm Kempff, Berliner Philharmoniker, Herbert von Karajan"
    assert all(name not in {"Some Producer", "Some Engineer", "Maria Callas"}
               for name, _ in a1.performers)
    assert ("Pierre Fournier", "Cello") in b2.performers
    assert ("Pierre Fournier", "Cello") not in a1.performers
    assert ("Wilhelm Kempff", "Piano") not in b2.performers
    assert b2.album_artist == "Beethoven"


def test_classical_track_level_credits_and_artist_order():
    release = classical(
        [FakeArtist("Karajan", role="Conductor")],
        tracks=[FakeTrackObj("A1", "One", credits=[FakeArtist("Gould", role="Piano")]),
                FakeTrackObj("A2", "Two")],
    )
    assert tags_for(release, "A1").artist == "Gould, Karajan"
    assert tags_for(release, "A2").artist == "Karajan"  # conductor only: better than the composer


def test_classical_numeric_positions_in_credit_ranges():
    release = classical(
        [FakeArtist("Solo Violin", role="Violin", tracks="2 - 3")],
        tracks=[FakeTrackObj(str(n), f"M{n}") for n in range(1, 5)],
    )
    # Numeric Discogs positions become A1.. on export; ranges still resolve via the raw position.
    assert ("Solo Violin", "Violin") in tags_for(release, "A2").performers
    assert tags_for(release, "A1").performers == ()


def test_non_classical_release_ignores_credits():
    release = DiscogsRelease(FakeReleaseObj(
        [FakeArtist("Band")], [FakeTrackObj("A1", "x")], credits=[FakeArtist("Pianist", role="Piano")],
    ))
    tags = tags_for(release, "A1")
    assert tags.composers == () and tags.performers == () and tags.artist == "Band"


def test_role_allowlist_rejects_production_roles():
    from release_credits import Credit, classify_credits
    found = classify_credits([
        Credit(n, r) for n, r in [
            ("P", "Producer"), ("E", "Engineer"), ("L", "Liner Notes"), ("D", "Design"),
            ("Ph", "Photography By"), ("M", "Mastered By"), ("C", "Lacquer Cut By"),
            ("R", "Recorded By"), ("G", "Guitar Technician"), ("O", "Orchestra"),
            ("Q", "Electric Guitar"),
        ]
    ])
    assert found.performers == (("Q", "Electric Guitar"),)
    assert found.ensembles == ("O",)


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def silent_file(tmp_path, fmt):
    path = tmp_path / f"t{OUTPUT_FORMATS[fmt]['extension']}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.2", str(path)],
        check=True,
    )
    return path


@needs_ffmpeg
def test_flac_read_back(tmp_path):
    release = classical([FakeArtist("Kempff", role="Piano"), FakeArtist("Karajan", role="Conductor"),
                         FakeArtist("BPO", role="Orchestra")])
    path = silent_file(tmp_path, "flac")
    assert handler().tag_file(path, FakeTrack("B1"), release, None, "flac", SEQ, ["A1", "A2", "B1", "B2"])
    audio = FLAC(path)
    assert audio["TRACKNUMBER"] == ["3"] and audio["TRACKTOTAL"] == ["4"]
    assert audio["DISCNUMBER"] == ["1"] and audio["DISCTOTAL"] == ["1"]
    assert audio["VINYLPOSITION"] == ["B1"]
    assert audio["ALBUMARTIST"] == ["Beethoven"] and audio["COMPOSER"] == ["Beethoven"]
    assert audio["CONDUCTOR"] == ["Karajan"] and audio["ENSEMBLE"] == ["BPO"]
    assert audio["PERFORMER"] == ["Kempff (Piano)"]
    assert "COMPILATION" not in audio


@needs_ffmpeg
def test_flac_without_year_has_no_date_and_compilation_flag(tmp_path):
    release = compilation()
    release.year = ""
    path = silent_file(tmp_path, "flac")
    assert handler().tag_file(path, FakeTrack("A1"), release, None, "flac", SEQ)
    audio = FLAC(path)
    assert "DATE" not in audio
    assert audio["ARTIST"] == ["Blur / Pulp"] and audio["ALBUMARTIST"] == ["Various Artists"]
    assert audio["COMPILATION"] == ["1"]


@needs_ffmpeg
@pytest.mark.parametrize("fmt, opener", [("mp3", MP3), ("aiff", AIFF)])
def test_id3_read_back(tmp_path, fmt, opener):
    release = classical([FakeArtist("Kempff", role="Piano"), FakeArtist("Karajan", role="Conductor"),
                         FakeArtist("BPO", role="Orchestra"), FakeArtist("Beethoven", role="Composed By")])
    path = silent_file(tmp_path, fmt)
    assert handler().tag_file(path, FakeTrack("A2"), release, None, fmt, SEQ, ["A1", "A2", "B1"])
    tags = opener(path).tags
    assert str(tags["TRCK"]) == "2/4" and str(tags["TPOS"]) == "1/1"  # A1 A2 B1 B2 on the record
    assert str(tags["TPE2"]) == "Beethoven" and str(tags["TCOM"]) == "Beethoven"
    assert str(tags["TPE3"]) == "Karajan" and str(tags["TXXX:ENSEMBLE"]) == "BPO"
    assert tags["TMCL"].people == [["Piano", "Kempff"]]
    assert "TCMP" not in tags and "TDRC" in tags


@needs_ffmpeg
def test_compilation_id3_flag(tmp_path):
    path = silent_file(tmp_path, "mp3")
    assert handler().tag_file(path, FakeTrack("A1"), compilation(), None, "mp3", SEQ)
    tags = MP3(path).tags
    assert str(tags["TCMP"]) == "1" and str(tags["TPE1"]) == "Blur / Pulp"
