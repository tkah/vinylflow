"""Custom (user-added) tracks and renamed Discogs titles: request validation, the per-job release
copy, numbering/totals, the pipeline hand-off and album jobs. Offline; Discogs is faked."""
import copy
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import api
from backend.sessions import OutputSpec, SessionStore, pipeline
from metadata_handler import DiscogsRelease, DiscogsTrack, MetadataHandler, with_custom_tracks
from tests.test_pipeline import FakeAudio, FakeBoundary, FakeMetadata, FakeRelease
from tests.test_tagging import FakeFlacAudio
from tests.test_unfold_index import FakeTrack, WORK, symphony

SEQ = "sequential_disc_per_lp"
HANDLER = MetadataHandler(discogs_token="", user_agent="")


def album():
    """A/B sides with a gap at B5, a credited track and an index track on side C."""
    release = DiscogsRelease(SimpleNamespace(
        id=7, title="Album", year=1999, artists=[SimpleNamespace(
            name="The Band", data={"name": "The Band"}, join="", anv="")],
        labels=[], formats=[], images=[], genres=[], credits=[], data={}, tracklist=[]))
    release.tracks = [DiscogsTrack(p, t, d, artist="Solo") for p, t, d in [
        ("A1", "One", "3:00"), ("A2", "Two", "4:00"), ("B1", "Three", "2:30"),
        ("B4", "Four", "5:00"), ("B6", "Six", "1:00")]]
    return release


def tag(release, position, job):
    return HANDLER._build_tag_set(FakeTrack(position), release, None, SEQ, job)


def test_rename_keeps_duration_credits_and_artist_and_leaves_the_cache_alone():
    release = album()
    release.tracks[1].credits = ["credit"]
    before = copy.deepcopy(vars(release.tracks[1]))
    job = with_custom_tracks(release, [("A2", "Deux")])
    renamed = job.tracks[1]
    assert (renamed.title, renamed.duration_str, renamed.duration_seconds) == ("Deux", "4:00", 240)
    assert renamed.credits == ["credit"] and renamed.artist == "Solo" and renamed.position == "A2"
    assert release.tracks[1].title == "Two" and vars(release.tracks[1]) == before
    assert job is not release and job.tracks is not release.tracks and job.title == "Album"


def test_new_track_is_inserted_in_order_for_the_release_artist():
    release = album()
    job = with_custom_tracks(release, [("B5", "Hidden"), ("C1", "Bonus"), ("A3", "Extra")])
    assert [t.position for t in job.tracks] == ["A1", "A2", "A3", "B1", "B4", "B5", "B6", "C1"]
    new = {t.position: t for t in job.tracks}["B5"]
    assert (new.title, new.artist, new.duration_str, new.parts) == ("Hidden", "The Band", "", [])
    assert [t.position for t in release.tracks] == ["A1", "A2", "B1", "B4", "B6"]  # cache untouched


def test_numbering_and_totals_include_the_new_track():
    release = album()
    job = with_custom_tracks(release, [("B5", "Hidden")])
    exported = ["B4", "B5", "B6"]
    assert [tag(job, p, exported).track_number for p in exported] == ["4", "5", "6"]
    assert tag(job, "B5", exported).title == "Hidden"
    assert tag(job, "B5", exported).track_total == "6"
    assert tag(release, "B6", ["B6"]).track_number == "5"  # without it B6 was track 5 of 5
    filename = HANDLER.create_track_filename(FakeTrack("B5"), job, "flac", exported)
    assert "B5" in filename and "Hidden" in filename


def test_rename_of_an_index_part_and_the_flac_tag():
    release = symphony()
    job = with_custom_tracks(release, [("B1", "Scherzo, renamed")])
    parts = job.tracks[0].parts
    assert [p["title"] for p in parts][2] == "Scherzo, renamed" and parts[0]["title"].startswith("I.")
    assert release.tracks[0].parts[2]["title"] == "III. Scherzo"
    exported = ["A1", "A2", "B1", "B2"]
    assert tag(job, "B1", exported).title == f"{WORK}: Scherzo, renamed"
    out = FakeFlacAudio()
    HANDLER._apply_vorbis(out, tag(with_custom_tracks(album(), [("B5", "Hidden")]), "B5", ["B5"]))
    assert out.values["TITLE"] == "Hidden"


# ---- the request ----

def process_body(**extra):
    return {"file_id": "nope", "release_id": 1, "track_mapping": [{"detected": 1, "discogs": "A1"}], **extra}


@pytest.fixture
def client():
    return TestClient(api.app)


@pytest.mark.parametrize("bad", [
    {"position": "5", "title": "x"}, {"position": "a1", "title": "x"}, {"position": "A1", "title": "   "},
    {"position": "A1", "title": "x" * 201}, {"position": "A1"}, {"position": "A1 ", "title": "x"}])
def test_bad_custom_track_is_422(client, bad):
    assert client.post("/api/process", json=process_body(custom_tracks=[bad])).status_code == 422


def test_too_many_is_422_and_duplicate_positions_are_400(client):
    many = [{"position": f"A{i}", "title": "t"} for i in range(1, 101)]
    assert client.post("/api/process", json=process_body(custom_tracks=many)).status_code == 422
    twice = [{"position": "B5", "title": "a"}, {"position": "B5", "title": "b"}]
    # The recording lookup comes first over HTTP, so check the shared validator directly.
    with pytest.raises(api.HTTPException) as refused:
        api._validate_process_options(api.ProcessRequest(**process_body(custom_tracks=twice)))
    assert refused.value.status_code == 400


def test_valid_custom_tracks_pass_validation_and_titles_are_trimmed(client):
    body = process_body(custom_tracks=[{"position": "B5", "title": "  Hidden  "}, {"position": "B6.1", "title": "Sub"}])
    # Validation passes; the unknown recording is what is refused.
    assert client.post("/api/process", json=body).status_code == 404
    request = api.ProcessRequest(**body)
    spec = api._output_spec(request)
    assert spec.custom_tracks == (("B5", "Hidden"), ("B6.1", "Sub"))
    assert api._output_spec(api.ProcessRequest(**process_body())).custom_tracks == ()


# ---- pipeline and album jobs ----

def test_pipeline_tags_with_a_per_job_copy(tmp_path):
    release = album()
    release.cover_url = None
    names = {}

    class Metadata(FakeMetadata):
        def create_album_folder_name(self, rel):
            return "Album"

        def tag_file(self, file_path, track, rel, cover_data, output_format, track_numbering="vinyl", job_positions=None):
            names[track.vinyl_number] = HANDLER._build_tag_set(track, rel, None, SEQ, job_positions).title

    store = SessionStore()
    source = tmp_path / "s.wav"
    source.write_bytes(b"x")
    session = store.create(session_id="s", source_audio=source, source_filename="s.wav", source_duration=120.0, source_size=1)
    session.set_boundaries([FakeBoundary(1, 0, 60), FakeBoundary(2, 60, 120)])
    session.set_mappings({1: "B5", 2: "A2"})
    spec = OutputSpec(output_format="flac", output_dir=tmp_path / "out", replaygain=False, track_numbering=SEQ,
                      custom_tracks=(("B5", "Hidden"), ("A2", "Deux")))
    pipeline.run(session, spec, 7, FakeAudio(), Metadata(release=release), lambda event: None)
    assert names == {"B5": "Hidden", "A2": "Deux"}
    assert [t.title for t in release.tracks] == ["One", "Two", "Three", "Four", "Six"]  # cached object untouched


def test_album_job_carries_custom_tracks_to_every_member(tmp_path, monkeypatch):
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
    files = [{"file_id": str(i), "release_id": 99, "output_format": "flac", "album_gain": False, "replaygain": True,
              "track_boundaries": [{"number": 1, "start": 0, "end": 60, "duration": 60}],
              "track_mapping": [{"detected": 1, "discogs": ["A1", "B5"][i]}],
              "custom_tracks": [{"position": "B5", "title": "Hidden"}] if i == 1 else []} for i in range(2)]
    client = TestClient(api.app)
    assert client.post("/api/process-album", json={"job_id": str(uuid.uuid4()), "files": files}).status_code == 200
    (job,) = api.album_jobs.values()
    assert [m.spec.custom_tracks for m in job.members] == [(("B5", "Hidden"),)] * 2

    # Recordings of one release must agree on a title.
    for store_id in ("0", "1"):
        store.get(store_id).export_reserved = False
    files[0]["custom_tracks"] = [{"position": "B5", "title": "Other"}]
    answer = client.post("/api/process-album", json={"job_id": str(uuid.uuid4()), "files": files})
    assert answer.status_code == 400 and "B5" in answer.json()["detail"]
