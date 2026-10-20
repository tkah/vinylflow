"""Plan 06 slice 1: POST /api/restoration-test (real ffmpeg, offline)."""

import json
import shutil
import subprocess
import uuid

import pytest
from fastapi.testclient import TestClient

import backend.api as api
from audio_processor import build_export_filters, album_gain_db
from backend.api import app, session_store

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

client = TestClient(app)


@pytest.fixture
def sid(tmp_path, monkeypatch):
    """A 12 s quiet 440 Hz tone with a few full-scale clicks, as a session."""
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    source = tmp_path / "source.wav"
    expr = "0.1*sin(2*PI*440*t)+if(lt(mod(t,1.5),0.0003),0.9,0)"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"aevalsrc='{expr}':s=44100:d=12", "-c:a", "pcm_s16le", str(source)],
        check=True,
    )
    file_id = str(uuid.uuid4())
    session_store.create(
        session_id=file_id, source_audio=source, source_filename="t.wav",
        source_duration=12.0, source_size=source.stat().st_size,
    )
    api.get_session_path(file_id).mkdir(parents=True, exist_ok=True)
    yield file_id
    session_store.remove(file_id)


def _post(file_id, **kw):
    body = {"file_id": file_id, "start": 1.0, "end": 9.0, "rumble": True, "declick": "light", "album_gain": False}
    body.update(kw)
    return client.post("/api/restoration-test", json=body)


def _is_flac(data: bytes) -> bool:
    return data[:4] == b"fLaC"


def test_renders_both_flac_and_chain_matches_export(sid):
    r = _post(sid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["chain"] == build_export_filters(True, "light", None)
    assert body["gain_db"] is None
    for key in ("original_url", "processed_url"):
        got = client.get(body[key])
        assert got.status_code == 200
        assert _is_flac(got.content)
    assert body["original_lufs"] is not None and body["processed_lufs"] is not None
    # Range requests are honoured (FileResponse)
    part = client.get(body["original_url"], headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100


def test_second_call_is_cache_hit(sid, monkeypatch):
    first = _post(sid)
    assert first.status_code == 200 and first.json()["cached"] is False
    renders, measures = [], []
    real_render, real_measure = api.run_ffmpeg, api.audio_processor.measure_file
    monkeypatch.setattr(api, "run_ffmpeg", lambda *a, **k: renders.append(a) or real_render(*a, **k))
    monkeypatch.setattr(api.audio_processor, "measure_file",
                        lambda *a, **k: measures.append(a) or real_measure(*a, **k))
    second = _post(sid)
    assert second.status_code == 200
    assert renders == [] and measures == []
    assert second.json()["cached"] is True
    assert second.json()["processed_url"] == first.json()["processed_url"]
    # A different chain re-renders only the processed side.
    third = _post(sid, rumble=False, declick="off", album_gain=True)
    assert third.status_code == 200
    assert len(renders) == 1
    assert third.json()["original_url"] == first.json()["original_url"]


def test_album_gain_uses_measure_ranges_and_reports_gain(sid, monkeypatch):
    calls = []
    real = api.audio_processor.measure_ranges
    monkeypatch.setattr(
        api.audio_processor, "measure_ranges",
        lambda src, ranges, rumble, declick: calls.append((list(ranges), rumble, declick))
        or real(src, ranges, rumble, declick),
    )
    ranges = [[1.0, 9.0], [10.0, 11.5]]
    r = _post(sid, album_gain=True, album_ranges=ranges)
    assert r.status_code == 200, r.text
    body = r.json()
    assert calls == [([(1.0, 9.0), (10.0, 11.5)], True, "light")]
    assert body["gain_db"] is not None
    assert body["chain"] == build_export_filters(True, "light", body["gain_db"])
    # Processed render is louder/quieter by roughly the gain
    assert body["processed_lufs"] - body["original_lufs"] == pytest.approx(body["gain_db"], abs=1.5)
    # Album measurement cached: same ranges/settings -> no second measurement
    r2 = _post(sid, album_gain=True, album_ranges=ranges)
    assert r2.status_code == 200 and len(calls) == 1
    # ...but different rumble/declick settings measure again
    _post(sid, rumble=False, declick="off", album_gain=True, album_ranges=ranges)
    assert len(calls) == 2 and calls[1][1:] == (False, "off")
    _post(sid, declick="strong", album_gain=True, album_ranges=ranges)
    assert len(calls) == 3 and calls[2][1:] == (True, "strong")


def test_gain_matches_album_gain_math(sid):
    body = _post(sid, rumble=False, declick="off", album_gain=True, album_ranges=[[1.0, 9.0]]).json()
    loud = api.audio_processor.measure_ranges(api.session_store.get(sid).source_audio, [(1.0, 9.0)], False, "off")
    assert body["gain_db"] == pytest.approx(album_gain_db(loud))


def test_400_when_both_off(sid):
    assert _post(sid, rumble=False, declick="off", album_gain=False).status_code == 400


def test_each_declick_strength_renders_its_own_chain(sid):
    chains = {}
    for level in ("light", "medium", "strong"):
        r = _post(sid, rumble=False, declick=level)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["declick"] == level and body["rumble"] is False
        assert body["chain"] == build_export_filters(False, level, None)
        chains[level] = body["processed_url"]
    assert len(set(chains.values())) == 3  # distinct cache keys per strength


def test_declick_only_and_rumble_only_are_valid(sid):
    assert _post(sid, rumble=False, declick="medium").status_code == 200
    r = _post(sid, rumble=True, declick="off")
    assert r.status_code == 200 and r.json()["chain"] == "highpass=f=15"


def test_invalid_declick_is_400(sid):
    assert _post(sid, rumble=False, declick="brutal").status_code == 400


def test_legacy_restore_bool_maps_to_rumble_plus_light(sid):
    body = {"file_id": sid, "start": 1.0, "end": 9.0, "restore": True, "album_gain": False}
    r = client.post("/api/restoration-test", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["chain"] == build_export_filters(True, "light", None)
    assert r.json()["rumble"] is True and r.json()["declick"] == "light"
    off = client.post("/api/restoration-test", json={**body, "restore": False})
    assert off.status_code == 400


@pytest.mark.parametrize("start,end", [(5.0, 5.0), (6.0, 2.0), (-1.0, 4.0)])
def test_400_invalid_range(sid, start, end):
    assert _post(sid, start=start, end=end).status_code == 400


def test_404_unknown_session():
    assert _post(str(uuid.uuid4())).status_code == 404


@pytest.mark.parametrize("name", [
    "..%2F..%2Fsource.wav", "rtorig_0123456789ab.wav", "rtorig_xyz.flac",
    "rtproc_0123456789ab.flac.loud.json", "source.wav", "rtorig_0123456789abc.flac",
])
def test_name_validator_rejects(sid, name):
    assert client.get(f"/api/restoration-test/{sid}/{name}").status_code in (400, 404)
    assert not api._RT_NAME_RE.fullmatch(name.replace("%2F", "/"))


def test_name_validator_accepts_generated(sid):
    body = _post(sid).json()
    for key in ("original_url", "processed_url"):
        assert api._RT_NAME_RE.fullmatch(body[key].rsplit("/", 1)[1])
    assert client.get(f"/api/restoration-test/{sid}/rtorig_000000000000.flac").status_code == 404
