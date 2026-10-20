"""Plan 07 slice 2: per-track click-removal override (pipeline, album-gain measurement, API)."""

import shutil
import sys
import os
import uuid
from dataclasses import dataclass
from typing import Optional

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

import backend.api as api  # noqa: E402
from audio_processor import DECLICK_PRESETS, AudioProcessor, build_export_filters  # noqa: E402
from backend.api import TrackBoundary, app, session_store  # noqa: E402
from backend.sessions import OutputSpec, SessionStore, pipeline  # noqa: E402
from metadata_handler import MetadataHandler  # noqa: E402
from click_synth import make_clicky, write_wav  # noqa: E402
from test_pipeline_loudness import RANGES, SeedRelease, af_of, ffmpeg_spy, source_wav  # noqa: E402,F401

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

client = TestClient(app)


@dataclass
class BO:
    number: int
    start: float
    end: float
    declick: Optional[str] = None


def run_with_overrides(tmp_path, source_wav, overrides, panel="light", album_gain=False):
    handler = MetadataHandler(discogs_token="", user_agent="")
    handler._release_cache[99] = SeedRelease()
    session = SessionStore().create(
        session_id="s", source_audio=source_wav, source_filename="source.wav",
        source_duration=28.0, source_size=source_wav.stat().st_size, source_bit_depth=16,
    )
    session.set_boundaries([BO(i + 1, a, b, overrides[i]) for i, (a, b) in enumerate(RANGES)])
    session.set_mappings({1: "A1", 2: "A2", 3: "A3"})
    spec = OutputSpec(output_format="flac", output_dir=tmp_path / "out", rumble_filter=False,
                      declick=panel, album_gain=album_gain, replaygain=False)
    pipeline.run(session, spec, 99, AudioProcessor(), handler, lambda e: None)


def test_per_track_override_gives_different_af_chains(tmp_path, source_wav, ffmpeg_spy):
    run_with_overrides(tmp_path, source_wav, [None, "strong", "off"], panel="light")
    afs = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c]
    dither = "aresample=osf=s16:dither_method=triangular"
    assert afs == [
        f"{DECLICK_PRESETS['light']},{dither}",    # absent -> panel setting
        f"{DECLICK_PRESETS['strong']},{dither}",   # override
        "",                                         # explicit off: no filters at all
    ]


def test_override_absent_everywhere_matches_panel(tmp_path, source_wav, ffmpeg_spy):
    run_with_overrides(tmp_path, source_wav, [None, None, None], panel="medium")
    afs = {af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c}
    assert len(afs) == 1 and DECLICK_PRESETS["medium"] in afs.pop()


def test_album_gain_measurement_uses_per_track_chains(tmp_path, source_wav, ffmpeg_spy):
    run_with_overrides(tmp_path, source_wav, [None, "strong", "off"], panel="light", album_gain=True)
    measure = [c for c in ffmpeg_spy if "ebur128" in " ".join(c)]
    assert len(measure) == 1
    graph = measure[0][measure[0].index("-filter_complex") + 1]
    assert DECLICK_PRESETS["light"] in graph and DECLICK_PRESETS["strong"] in graph
    assert "[2:a]anull[s2]" in graph and "concat=n=3" in graph
    assert measure[0].count("-ss") == 3                       # one seeked input per track
    # and the exports got the same per-track chains plus the single album gain
    extract = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "ebur128" not in " ".join(c)]
    assert DECLICK_PRESETS["light"] in extract[0] and DECLICK_PRESETS["strong"] in extract[1]
    assert all("volume=" in a for a in extract)


def test_uniform_override_filters_each_range_separately(tmp_path, source_wav, ffmpeg_spy):
    run_with_overrides(tmp_path, source_wav, ["strong", "strong", "strong"], panel="light", album_gain=True)
    measure = [c[c.index("-filter_complex") + 1] for c in ffmpeg_spy if "ebur128" in " ".join(c)]
    assert measure and "aselect" not in measure[0] and "concat=n=3" in measure[0]
    assert DECLICK_PRESETS["strong"] in measure[0] and DECLICK_PRESETS["light"] not in measure[0]


# --- measure_ranges --------------------------------------------------------------

@pytest.fixture(scope="module")
def clicky_wav(tmp_path_factory):
    noisy, _, _ = make_clicky(seconds=30, n_clicks=24, section_s=10.0)
    p = tmp_path_factory.mktemp("m") / "m.wav"
    write_wav(p, noisy)
    return p


RNG = [(2.0, 7.0), (12.0, 17.0), (22.0, 27.0)]   # short: strong declick is ~5x slower than light


def test_measure_ranges_concat_equals_uniform_chain(clicky_wav):
    ap = AudioProcessor()
    for d in ("off", "medium"):
        uniform = ap.measure_ranges(clicky_wav, RNG, False, d)
        three = ap.measure_ranges(clicky_wav, [(a, b, d) for a, b in RNG], False, "light")
        forced = ap._measure_ranges_concat(clicky_wav, [(a, b, d) for a, b in RNG], False)
        assert three.integrated == pytest.approx(uniform.integrated, abs=1e-6)  # same single-pass path
        assert forced.integrated == pytest.approx(uniform.integrated, abs=0.15)  # concat path agrees
        assert forced.true_peak == pytest.approx(uniform.true_peak, abs=0.3)


def test_measure_ranges_mixed_is_bracketed_by_uniform_extremes(clicky_wav):
    ap = AudioProcessor()
    off = ap.measure_ranges(clicky_wav, RNG, False, "off")
    strong = ap.measure_ranges(clicky_wav, RNG, False, "strong")
    mixed = ap.measure_ranges(clicky_wav, [(*RNG[0], "off"), (*RNG[1], "strong"), (*RNG[2], None)], False, "strong")
    lo, hi = sorted((off.integrated, strong.integrated))
    assert lo - 0.05 <= mixed.integrated <= hi + 0.05
    assert ap.measure_ranges(clicky_wav, [], False, "off") is None


# --- API --------------------------------------------------------------------------

def test_track_boundary_model_carries_optional_declick():
    assert TrackBoundary(number=1, start=0, end=1, duration=1).declick is None
    assert TrackBoundary(number=1, start=0, end=1, duration=1, declick="strong").declick == "strong"


def test_process_rejects_bad_per_track_declick(tmp_path):
    src = tmp_path / "s.wav"
    src.write_bytes(b"x")
    sid = str(uuid.uuid4())
    session_store.create(session_id=sid, source_audio=src, source_filename="s.wav",
                         source_duration=60.0, source_size=1)
    try:
        r = client.post("/api/process", json={
            "file_id": sid, "release_id": 1, "track_mapping": [],
            "track_boundaries": [{"number": 1, "start": 0, "end": 30, "duration": 30, "declick": "nuclear"}],
        })
        assert r.status_code == 400
    finally:
        session_store.remove(sid)


def test_restoration_test_album_ranges_accept_per_track_strength(tmp_path, monkeypatch, clicky_wav):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    sid = str(uuid.uuid4())
    session_store.create(session_id=sid, source_audio=clicky_wav, source_filename="t.wav",
                         source_duration=30.0, source_size=clicky_wav.stat().st_size)
    api.get_session_path(sid).mkdir(parents=True, exist_ok=True)
    try:
        body = {"file_id": sid, "start": 2.0, "end": 8.0, "rumble": False, "declick": "strong",
                "album_gain": True,
                "album_ranges": [[2.0, 8.0, "strong"], [14.0, 20.0, "off"], [22.0, 28.0, None]]}
        r = client.post("/api/restoration-test", json=body)
        assert r.status_code == 200, r.text
        assert r.json()["chain"].startswith(build_export_filters(False, "strong", None))
        assert r.json()["gain_db"] is not None
        bad = dict(body, album_ranges=[[2.0, 8.0, "nope"]])
        assert client.post("/api/restoration-test", json=bad).status_code == 400
        bad = dict(body, album_ranges=[[2.0]])
        assert client.post("/api/restoration-test", json=bad).status_code == 400
    finally:
        session_store.remove(sid)
