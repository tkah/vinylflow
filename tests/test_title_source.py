"""Title source (plan 14): movements borrowed from another Discogs release.

Offline: the two fixtures are real Discogs payloads loaded without any fetch.
16440030 is the primary (LP, Gaite Parisienne as two big parts + Gayne), 9326206 the
donor (SACD, Gaite Parisienne in 23 movements with lengths).
"""
import copy
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import discogs_client
import pytest
from fastapi.testclient import TestClient

from backend import api
from backend.sessions import OutputSpec, SessionStore, pipeline
from backend.sessions.events import TitleSourceSpec
from metadata_handler import DiscogsRelease, DiscogsTrack, MetadataHandler, with_borrowed_work, with_custom_tracks
from tests.test_pipeline import FakeAudio, FakeBoundary, FakeMetadata
from tests.test_unfold_index import FakeTrack

SEQ = "sequential_disc_per_lp"
FIXTURES = Path(__file__).parent / "fixtures"
HANDLER = MetadataHandler(discogs_token="", user_agent="")


def load(release_id):
    data = json.loads((FIXTURES / f"discogs_release_{release_id}.json").read_text())
    release = discogs_client.Release(discogs_client.Client("VinylFlow-tests"), data)
    release.refresh = lambda *_: (_ for _ in ()).throw(AssertionError("must not fetch"))
    return DiscogsRelease(release)


def gaite_assignments():
    """Side A <- movements 1.1-1.12, B1.1-B1.11 <- 1.13-1.23 (the plan's example split)."""
    return ([(f"A{n}", f"1.{n}") for n in range(1, 13)]
            + [(f"B1.{n}", f"1.{n + 12}") for n in range(1, 12)])


def source(assignments=None, replace="A1", donor="A1", release_id=9326206):
    return TitleSourceSpec(release_id, replace, donor, tuple(assignments or gaite_assignments()))


def merged():
    return with_borrowed_work(load(16440030), load(9326206), source())


def tags(release, position, prefix=True, job=None):
    """Tags as an export of ``job`` positions would write them (an umbrella shares its first
    part's position, so A1 is the first movement only when another part is exported too)."""
    return HANDLER._build_tag_set(FakeTrack(position), release, None, SEQ, job, prefix)


# ---- the per-job copy ----

def test_fixtures_parse_as_documented():
    primary, donor = load(16440030), load(9326206)
    assert [t.position for t in primary.tracks] == ["A1", "B2"]
    assert [p["position"] for p in primary.tracks[0].parts] == ["A", "B1"]
    assert len(donor.tracks) == 1 and len(donor.tracks[0].parts) == 23


def test_umbrella_replaces_the_work_and_gayne_is_untouched():
    result = merged()
    assert [t.position for t in result.tracks] == ["A1", "B2"]
    umbrella, gayne = result.tracks
    assert umbrella.title == "Gaîté Parisienne" and umbrella.raw_position == "A1"
    assert [p["position"] for p in umbrella.parts] == [f"A{n}" for n in range(1, 13)] + [f"B1.{n}" for n in range(1, 12)]
    assert umbrella.parts[0]["title"] == "Allegro" and umbrella.parts[0]["duration"] == "2:05"
    assert gayne.title == "Gayne Ballet Suite"
    assert [p["position"] for p in gayne.parts] == ["B2a", "B2b", "B2c", "B2d"]
    donor_parts = load(9326206).tracks[0].parts
    seconds = sum(DiscogsTrack("x", "x", p["duration"]).duration_seconds for p in donor_parts)
    assert umbrella.duration_seconds == seconds == 36 * 60 + 9


def test_release_level_fields_come_from_the_primary_and_inputs_are_unmodified():
    primary, donor = load(16440030), load(9326206)
    primary_before, donor_before = copy.deepcopy(primary.__dict__), copy.deepcopy(donor.__dict__)
    result = with_borrowed_work(primary, donor, source())
    assert (result.id, result.title, result.label, result.year, result.genres, result.artist) == (
        16440030, primary.title, "RCA Victor Red Seal", 1959, ["Classical"], primary.artist)
    assert result is not primary and result.tracks is not primary.tracks
    assert [t.title for t in primary.tracks] == [t.title for t in primary_before["tracks"]]
    assert [p["position"] for p in primary.tracks[0].parts] == ["A", "B1"]
    assert len(donor.tracks[0].parts) == 23
    assert primary.__dict__.keys() == primary_before.keys() and donor.__dict__.keys() == donor_before.keys()


def test_unknown_length_makes_the_umbrella_length_unknown():
    donor = load(9326206)
    donor.tracks[0].parts[3] = {**donor.tracks[0].parts[3], "duration": ""}
    result = with_borrowed_work(load(16440030), donor, source())
    assert result.tracks[0].duration_str == "" and result.tracks[0].duration_seconds is None


def test_works_with_custom_tracks_applied_afterwards():
    result = with_custom_tracks(merged(), [("B1.2", "Renamed")])
    assert [p["title"] for p in result.tracks[0].parts if p["position"] == "B1.2"] == ["Renamed"]
    assert result.tracks[0].credits_resolved
    assert result.fallback_credits is not None


# ---- tags ----

def test_borrowed_part_tags_use_the_title_source_credits():
    release = merged()
    job = [position for position, _ in gaite_assignments()]
    first = tags(release, "A1", job=job)
    assert first.title == "Gaîté Parisienne: Allegro"
    assert first.work == "Gaîté Parisienne"
    assert first.composers == ("Jacques Offenbach",)
    assert first.conductors == ("Arthur Fiedler",)
    assert first.ensembles == ("Boston Pops Orchestra",)
    assert first.artist == "Boston Pops Orchestra, Arthur Fiedler"
    assert tags(release, "A1", prefix=False, job=job).title == "Allegro"
    last = tags(release, "B1.11", job=job)
    assert last.title.startswith("Gaîté Parisienne: ") and last.composers == ("Jacques Offenbach",)
    assert last.album == load(16440030).title


def test_unborrowed_work_is_filled_with_conductor_and_ensemble_but_never_composer():
    tag_set = tags(merged(), "B2a")
    assert tag_set.composers == ("Aram Khachaturian",)
    assert tag_set.conductors == ("Arthur Fiedler",)
    assert tag_set.ensembles == ("Boston Pops Orchestra",)
    assert tag_set.artist == "Boston Pops Orchestra, Arthur Fiedler"


def test_release_without_a_title_source_is_unchanged():
    plain = tags(load(16440030), "B2a")
    assert plain.conductors == () and plain.ensembles == ()


# ---- synthetic cases ----

def person(name, role, tracks=""):
    return SimpleNamespace(name=name, data={"name": name, "role": role, "tracks": tracks, "join": "", "anv": ""})


def raw(position, title, duration="", type_="track", sub_tracks=None, credits=()):
    data = {"position": position, "type_": type_, "title": title, "duration": duration}
    if sub_tracks is not None:
        data["sub_tracks"] = sub_tracks
    return SimpleNamespace(data=data, position=position, title=title, duration=duration, artists=[], credits=list(credits))


def synthetic(rel_id, title, tracklist, credits=(), artist="Composer", genres=("Classical",)):
    return DiscogsRelease(SimpleNamespace(
        id=rel_id, title=title, year=2000, artists=[SimpleNamespace(name=artist, data={"name": artist}, join="", anv="")],
        labels=[], formats=[], images=[], genres=list(genres), credits=list(credits), data={}, tracklist=tracklist))


def test_primary_release_credits_do_not_apply_to_borrowed_tracks():
    primary = synthetic(1, "Primary", [raw("A1", "Old"), raw("A2", "Keep")],
                        credits=[person("Primary Conductor", "Conductor"), person("Primary Choir", "Choir")])
    donor = synthetic(2, "Donor", [raw("", "Work", "", "index", [
        {"position": "1", "type_": "track", "title": "I", "duration": "1:00"},
        {"position": "2", "type_": "track", "title": "II", "duration": "2:00"}])],
        credits=[person("Donor Conductor", "Conductor"), person("Donor Orchestra", "Orchestra")])
    result = with_borrowed_work(primary, donor, TitleSourceSpec(
        2, "A1", donor.tracks[0].position, (("A1", "1"), ("A1.1", "2"))))
    borrowed = tags(result, "A1.1")
    assert borrowed.conductors == ("Donor Conductor",) and borrowed.ensembles == ("Donor Orchestra",)
    # The primary's own, untouched track keeps its release credits.
    assert tags(result, "A2").conductors == ("Primary Conductor",)


def test_track_with_its_own_conductor_and_ensemble_keeps_them():
    primary = synthetic(1, "Primary", [raw("A1", "Old"), raw("A2", "Own", credits=[person("Own Conductor", "Conductor")])])
    donor = synthetic(2, "Donor", [raw("1", "New", "3:00")],
                      credits=[person("Donor Conductor", "Conductor"), person("Donor Orchestra", "Orchestra"),
                               person("Ranged Choir", "Choir", "1"), person("Donor Composer", "Composed By")])
    result = with_borrowed_work(primary, donor, TitleSourceSpec(2, "A1", None, (("A1", donor.tracks[0].position),)))
    own = tags(result, "A2")
    assert own.conductors == ("Own Conductor",)
    assert own.ensembles == ("Donor Orchestra",)  # roles are filled independently
    assert own.composers == ("Composer",)  # composers are never filled
    assert "Ranged Choir" not in own.ensembles  # only release-wide credits fill


def test_plain_donor_tracks_become_plain_tracks_with_resolved_credits():
    primary = synthetic(1, "Primary", [raw("A1", "Old"), raw("B1", "Keep")])
    donor = synthetic(2, "Donor", [raw("1", "First", "1:30"), raw("2", "Second", "2:00"), raw("3", "Third")],
                      credits=[person("Donor Conductor", "Conductor"), person("Soloist", "Cello", "2")])
    donor_first, donor_second = donor.tracks[0].position, donor.tracks[1].position
    result = with_borrowed_work(primary, donor, TitleSourceSpec(
        2, "A1", None, (("A1", donor_second), ("A2", donor_first))))
    assert [(t.position, t.title, t.duration_str) for t in result.tracks] == [
        ("A1", "Second", "2:00"), ("A2", "First", "1:30"), ("B1", "Keep", "")]
    assert all(not t.parts for t in result.tracks)
    second = tags(result, "A1")
    assert second.work is None and second.title == "Second"
    assert second.performers == (("Soloist", "Cello"),)
    assert tags(result, "A2").performers == ()  # the cello credit covers donor track 2 only
    assert tags(result, "A2").conductors == ("Donor Conductor",)


# ---- validation errors ----

@pytest.mark.parametrize("change, message", [
    ({"replace": "Z9"}, "replace"),
    ({"donor": "A9"}, "umbrella"),
    ({"assignments": [("A1", "1.99")]}, "1.99"),
    ({"assignments": [("A1", "1.1"), ("A1", "1.2")]}, "Duplicate"),
    ({"assignments": [("B2", "1.1")]}, "collides"),
    ({"assignments": [("B2a", "1.1")]}, "collides"),
])
def test_value_errors_are_clear(change, message):
    spec = source(change.get("assignments"), replace=change.get("replace", "A1"), donor=change.get("donor", "A1"))
    with pytest.raises(ValueError, match=message):
        with_borrowed_work(load(16440030), load(9326206), spec)


def test_donor_position_must_be_an_umbrella():
    donor = synthetic(2, "Donor", [raw("1", "Plain")])
    with pytest.raises(ValueError, match="umbrella"):
        with_borrowed_work(load(16440030), donor, TitleSourceSpec(2, "A1", donor.tracks[0].position, (("A1", "1"),)))


# ---- request validation ----

def process_body(**extra):
    return {"file_id": "nope", "release_id": 1, "track_mapping": [{"detected": 1, "discogs": "A1"}], **extra}


def title_source_body(**change):
    return {"release_id": 9326206, "replace_position": "A1", "donor_position": "A1",
            "assignments": [{"position": "A1", "source": "1.1"}, {"position": "B1.1", "source": "1.2"}], **change}


@pytest.mark.parametrize("bad", [
    title_source_body(release_id=0),
    title_source_body(replace_position=""),
    title_source_body(donor_position=""),
    title_source_body(assignments=[]),
    title_source_body(assignments=[{"position": "a1", "source": "1.1"}]),
    title_source_body(assignments=[{"position": "A1", "source": ""}]),
    title_source_body(assignments=[{"position": "A1", "source": "x" * 33}]),
    title_source_body(assignments=[{"position": "A1x", "source": "1"}]),
    title_source_body(assignments=[{"position": f"A{n}", "source": "1"} for n in range(1, 202)]),
])
def test_bad_title_source_is_422(bad):
    assert TestClient(api.app).post("/api/process", json=process_body(title_source=bad)).status_code == 422


def test_valid_title_source_passes_validation_and_reaches_the_spec():
    body = process_body(title_source=title_source_body())
    assert TestClient(api.app).post("/api/process", json=body).status_code == 404  # unknown recording
    spec = api._output_spec(api.ProcessRequest(**body))
    assert spec.title_source == TitleSourceSpec(9326206, "A1", "A1", (("A1", "1.1"), ("B1.1", "1.2")))
    assert api._output_spec(api.ProcessRequest(**process_body())).title_source is None
    plain = api._output_spec(api.ProcessRequest(**process_body(title_source=title_source_body(donor_position=None))))
    assert plain.title_source.donor_position is None


# ---- pipeline ----

def test_pipeline_applies_the_title_source_before_custom_tracks(tmp_path):
    primary, donor = load(16440030), load(9326206)
    primary.cover_url = None
    titles = {}

    class Metadata(FakeMetadata):
        def get_release_by_id(self, release_id):
            return {16440030: primary, 9326206: donor}[release_id]

        def create_album_folder_name(self, release):
            return "Album"

        def tag_file(self, file_path, track, release, cover_data, output_format, track_numbering="vinyl",
                     job_positions=None, prefix_part_titles=True):
            titles[track.vinyl_number] = HANDLER._build_tag_set(track, release, None, SEQ, job_positions).title

    store = SessionStore()
    audio_file = tmp_path / "s.wav"
    audio_file.write_bytes(b"x")
    session = store.create(session_id="s", source_audio=audio_file, source_filename="s.wav", source_duration=120.0, source_size=1)
    session.set_boundaries([FakeBoundary(1, 0, 60), FakeBoundary(2, 60, 120)])
    session.set_mappings({1: "A1", 2: "B1.1"})
    spec = OutputSpec(output_format="flac", output_dir=tmp_path / "out", replaygain=False, track_numbering=SEQ,
                      title_source=source(), custom_tracks=(("B1.1", "Renamed"),))
    pipeline.run(session, spec, 16440030, FakeAudio(), Metadata(release=primary), lambda event: None)
    assert titles["A1"] == "Gaîté Parisienne: Allegro"
    assert titles["B1.1"] == "Gaîté Parisienne: Renamed"
    assert [p["position"] for p in primary.tracks[0].parts] == ["A", "B1"]  # cached primary untouched


def test_pipeline_fails_clearly_when_the_donor_cannot_be_fetched_or_applied(tmp_path):
    primary = load(16440030)
    primary.cover_url = None
    events = []

    def run_with(donor, spec_source):
        class Metadata(FakeMetadata):
            def get_release_by_id(self, release_id):
                return primary if release_id == 16440030 else donor

        store = SessionStore()
        audio_file = tmp_path / "s.wav"
        audio_file.write_bytes(b"x")
        session = store.create(session_id=str(uuid.uuid4()), source_audio=audio_file, source_filename="s.wav",
                               source_duration=120.0, source_size=1)
        session.set_boundaries([FakeBoundary(1, 0, 60)])
        session.set_mappings({1: "A1"})
        spec = OutputSpec(output_format="flac", output_dir=tmp_path / "out", replaygain=False, title_source=spec_source)
        return session, lambda: pipeline.run(session, spec, 16440030, FakeAudio(), Metadata(release=primary), events.append)

    _, run = run_with(None, source())
    with pytest.raises(RuntimeError, match="title source"):
        run()
    _, run = run_with(load(9326206), source(replace="Z9"))
    with pytest.raises(ValueError, match="replace"):
        run()
    assert events[-1].phase == "error" and "replace" in events[-1].message


# ---- album job ----

def album_files(tmp_path, monkeypatch, sources):
    store = SessionStore()
    monkeypatch.setattr(api, "session_store", store)
    monkeypatch.setattr(api, "album_jobs", {}, raising=False)
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path)
    for index in range(2):
        path = tmp_path / f"{index}.wav"
        path.write_bytes(b"x")
        store.create(str(index), path, path.name, 60, 1)

    async def idle(job):
        job.status = "processing"
    monkeypatch.setattr(api, "_run_album_job", idle, raising=False)
    files = []
    for index in range(2):
        item = {"file_id": str(index), "release_id": 99, "output_format": "flac", "album_gain": False, "replaygain": True,
                "track_boundaries": [{"number": 1, "start": 0, "end": 60, "duration": 60}],
                "track_mapping": [{"detected": 1, "discogs": ["A1", "B2"][index]}]}
        if sources[index] is not None:
            item["title_source"] = sources[index]
        files.append(item)
    return {"job_id": str(uuid.uuid4()), "files": files}


def test_album_job_shares_one_title_source(tmp_path, monkeypatch):
    shared = title_source_body()
    body = album_files(tmp_path, monkeypatch, [None, shared])
    assert TestClient(api.app).post("/api/process-album", json=body).status_code == 200
    (job,) = api.album_jobs.values()
    expected = TitleSourceSpec(9326206, "A1", "A1", (("A1", "1.1"), ("B1.1", "1.2")))
    assert [m.spec.title_source for m in job.members] == [expected, expected]


def test_album_job_rejects_disagreeing_title_sources(tmp_path, monkeypatch):
    body = album_files(tmp_path, monkeypatch, [title_source_body(), title_source_body(release_id=5)])
    response = TestClient(api.app).post("/api/process-album", json=body)
    assert response.status_code == 400
    assert response.json()["detail"] == "Recordings disagree on the title source."
