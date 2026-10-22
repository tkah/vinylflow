"""Index-track (umbrella) parts: serialized for the UI and taggable per part position."""
import json
from pathlib import Path
from types import SimpleNamespace

import discogs_client

from backend.api import _serialize_release
from metadata_handler import DiscogsRelease, MetadataHandler, TagSet
from tests.test_tagging import FakeFlacAudio, FakeId3Audio

SEQ = "sequential_disc_per_lp"
WORK = "Symphony No. 9 In E Minor, Op. 95 'From The New World'"


class FakeTrack:
    def __init__(self, vinyl_number):
        self.vinyl_number = vinyl_number


def raw(position, title, duration="", type_="track", sub_tracks=None, artists=()):
    data = {"position": position, "type_": type_, "title": title, "duration": duration}
    if sub_tracks is not None:
        data["sub_tracks"] = sub_tracks
    return SimpleNamespace(data=data, position=position, title=title, duration=duration,
                           artists=list(artists), credits=[])


def symphony(genres=("Classical",)):
    movements = [("A1", "I. Adagio - Allegro Molto", "9:30"), ("A2", "II. Largo", "11:40"),
                 ("B1", "III. Scherzo", "8:10"), ("B2", "IV. Allegro Con Fuoco", "11:20")]
    index = raw("", WORK, "", "index", [
        {"position": p, "type_": "track", "title": t, "duration": d} for p, t, d in movements])
    return DiscogsRelease(SimpleNamespace(
        id=424244, title="Dvorak: New World", year=1960, artists=[SimpleNamespace(
            name="Antonín Dvořák", data={"name": "Antonín Dvořák"}, join="", anv="")],
        labels=[], formats=[], images=[], genres=list(genres), credits=[], data={},
        tracklist=[index]))


def tenCC():
    data = json.loads((Path(__file__).parent / "fixtures" / "discogs_release_848848.json").read_text())
    rel = discogs_client.Release(discogs_client.Client("VinylFlow-tests"), data)
    rel.refresh = lambda *_: (_ for _ in ()).throw(AssertionError("must not fetch"))
    return DiscogsRelease(rel)


def tags(release, position, job, numbering=SEQ):
    return MetadataHandler(discogs_token="", user_agent="")._build_tag_set(
        FakeTrack(position), release, None, numbering, job)


def test_serialize_adds_parts_for_umbrella_only():
    out = _serialize_release(tenCC())["tracks"]
    assert "parts" not in out[0]
    assert [p["position"] for p in out[-1]["parts"]] == ["B4", "B5", "B6"]
    assert out[-1]["parts"][0] == {"position": "B4", "title": "Reminisce And Speculation", "duration": out[-1]["parts"][0]["duration"]}


def test_part_position_resolves_to_work_movement_title():
    rel = tenCC()
    t = tags(rel, "B5", ["B4", "B5", "B6"])
    assert t.title == "Feel The Benefit: A Latin Break" and t.work == "Feel The Benefit"
    assert t.vinyl_position == "B5"
    # a part that already starts with the work's title keeps its own title
    assert tags(rel, "B6", ["B4", "B5", "B6"]).title == "Feel The Benefit"


def test_unfolded_numbering_is_sequential_and_folded_is_unchanged():
    rel = tenCC()
    job = ["B4", "B5", "B6"]
    assert [tags(rel, p, job).track_number for p in job] == ["9", "10", "11"]
    assert tags(rel, "B6", job).track_total == "11"  # 8 before the suite + 3 parts
    folded = tags(rel, "B4", ["B4"])
    assert folded.track_number == "9" and folded.track_total == "9" and folded.work is None
    assert folded.title == "Feel The Benefit"


def test_synthetic_classical_parts_span_a_side_change():
    rel = symphony()
    job = ["A1", "A2", "B1", "B2"]
    got = [tags(rel, p, job) for p in job]
    assert [t.track_number for t in got] == ["1", "2", "3", "4"]
    assert got[2].title == f"{WORK}: III. Scherzo" and got[2].work == WORK
    assert all(t.artist == "Antonín Dvořák" for t in got)
    assert got[0].composers == ("Antonín Dvořák",)


def test_part_tags_in_flac_and_id3():
    t = TagSet(artist="A", album="B", title="W: P", track_number="1", year=1960, label=None,
               release_id=1, work="W")
    flac, id3 = FakeFlacAudio(), FakeId3Audio()
    h = MetadataHandler(discogs_token="", user_agent="")
    h._apply_vorbis(flac, t)
    h._apply_id3(id3, t)
    assert flac.values["WORK"] == "W"
    assert str(id3.tags["TIT1"]) == "W"


def test_first_part_sharing_the_work_position_is_tagged_and_named_as_the_part():
    """The umbrella sits at its first part's position (A1 / B4): once split, that position is
    movement I, not the whole work — for the title, the work tag and the file name."""
    rel, handler = symphony(), MetadataHandler(discogs_token="", user_agent="")
    job = ["A1", "A2", "B1", "B2"]
    first = tags(rel, "A1", job)
    assert first.title == f"{WORK}: I. Adagio - Allegro Molto" and first.work == WORK
    assert handler.create_track_filename(FakeTrack("A1"), rel, "flac", job).startswith("A1-") and \
        "I. Adagio" in handler.create_track_filename(FakeTrack("A1"), rel, "flac", job)
    assert tags(tenCC(), "B4", ["B4", "B5", "B6"]).title == "Feel The Benefit: Reminisce And Speculation"
    # Folded (only the work's own position exported): still the whole work
    folded = tags(rel, "A1", ["A1"])
    assert folded.title == WORK and folded.work is None
    assert handler.create_track_filename(FakeTrack("A1"), rel, "flac", ["A1"]) == \
        handler.create_track_filename(FakeTrack("A1"), rel, "flac")
