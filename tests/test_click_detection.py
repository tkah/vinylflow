"""Plan 07 slice 2: click detection (pure functions, real-ffmpeg accuracy, API flow)."""

import os
import shutil
import sys
import time
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

import backend.api as api  # noqa: E402
import click_detection as cd  # noqa: E402
from audio_processor import DECLICK_PRESETS, run_ffmpeg  # noqa: E402
from backend.api import app, session_store  # noqa: E402
from click_synth import SR, make_clicky, match, write_wav  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# --- pure: click_events_from_residual ------------------------------------------

def test_events_peak_time_and_merge():
    r = np.zeros(SR)
    r[1000] = 0.2
    r[1002] = -0.5          # same click (2 samples apart): reported once, at the larger peak
    r[20000] = 0.3
    ev = cd.click_events_from_residual(r, SR, 0.1)
    assert ev == pytest.approx([1002 / SR, 20000 / SR])


def test_events_merge_window_is_respected():
    r = np.zeros(SR)
    r[1000] = 0.5
    r[1000 + int(0.004 * SR)] = 0.5   # 4 ms later -> merged at 5 ms
    r[1000 + int(0.020 * SR)] = 0.5   # 20 ms later -> separate
    assert len(cd.click_events_from_residual(r, SR, 0.1, merge_ms=5)) == 2
    assert len(cd.click_events_from_residual(r, SR, 0.1, merge_ms=30)) == 1


def test_events_threshold_scalar_and_per_sample():
    r = np.zeros(SR)
    r[100] = 0.2
    r[30000] = 0.2
    assert len(cd.click_events_from_residual(r, SR, 0.1)) == 2
    assert len(cd.click_events_from_residual(r, SR, 0.3)) == 0
    thr = np.full(SR, 0.1)
    thr[25000:] = 0.5                 # loud passage raises the bar
    assert cd.click_events_from_residual(r, SR, thr) == pytest.approx([100 / SR])
    assert cd.click_events_from_residual(np.zeros(0), SR, 0.1) == []


# --- pure: chunk planning & dedupe ---------------------------------------------

def test_plan_chunks_partition_and_overlap():
    chunks = cd.plan_chunks(10.0, 190.0, chunk_s=60.0, margin_s=0.5, total=200.0)
    assert [(c.own_start, c.own_end) for c in chunks] == [(10, 70), (70, 130), (130, 190)]
    for a, b in zip(chunks, chunks[1:]):
        assert a.own_end == b.own_start                       # ownership partitions the range
        a_end = a.decode_start + a.decode_dur
        assert a_end - b.decode_start == pytest.approx(1.0)   # ~1 s decode overlap
    assert chunks[0].decode_start == 9.5 and chunks[-1].decode_start + chunks[-1].decode_dur == 190.5


def test_plan_chunks_clamps_to_file_and_handles_short_or_empty():
    c = cd.plan_chunks(0.0, 30.0, total=30.0)
    assert len(c) == 1 and c[0].decode_start == 0.0 and c[0].decode_dur == 30.0
    assert cd.plan_chunks(5.0, 5.0) == [] and cd.plan_chunks(9.0, 3.0) == []
    last = cd.plan_chunks(0.0, 120.0, total=120.2)[-1]
    assert last.decode_start + last.decode_dur <= 120.2 + 1e-9


def test_dedupe_events_drops_overlap_duplicates():
    assert cd.dedupe_events([3.0, 1.0, 1.001, 1.002, 5.0, 5.2]) == [1.0, 3.0, 5.0, 5.2]
    assert cd.dedupe_events([]) == []


def test_local_threshold_floor_loud_and_pop_robust():
    rng = np.random.default_rng(1)
    quiet = rng.standard_normal(SR) * 0.0005
    thr = cd.local_threshold(quiet, SR)
    assert thr.min() >= 10 ** (cd.FLOOR_DB / 20) - 1e-12
    loud = np.sin(2 * np.pi * 200 * np.arange(SR) / SR) * 0.5
    assert cd.local_threshold(loud, SR).mean() == pytest.approx(0.0354, rel=0.05)  # -20 dB below its 0.354 RMS
    popped = quiet.copy()
    popped[::4000] += 0.9                                   # a few pops must not inflate roughness
    assert np.median(cd.local_roughness(popped, SR)) == pytest.approx(
        np.median(cd.local_roughness(quiet, SR)), rel=0.05
    )


# --- pure: cache -----------------------------------------------------------------

def test_cache_roundtrip_atomic_and_stale(tmp_path):
    path = cd.cache_path(tmp_path, "medium")
    payload = cd.make_payload("medium", 1.0, 99.0, [5.0, 2.0, 3.25])
    assert payload["times"] == [2.0, 3.25, 5.0] and payload["count"] == 3
    assert payload["chain"] == DECLICK_PRESETS["medium"]
    assert cd.write_cache(path, payload)
    assert not list(tmp_path.glob("*.part"))
    assert cd.read_cache(path, "medium")["times"] == [2.0, 3.25, 5.0]
    assert cd.read_cache(path, "strong") is None            # different strength
    stale = dict(payload, chain="adeclick=t=9")             # preset retuned since the scan
    cd.write_cache(path, stale)
    assert cd.read_cache(path, "medium") is None
    path.write_text("not json")
    assert cd.read_cache(path, "medium") is None
    assert cd.write_cache(tmp_path / "gone" / "x.json", payload) is False


def test_scan_strength_maps_off_to_medium():
    assert [cd.scan_strength(s) for s in ("off", "light", "medium", "strong")] == [
        "medium", "light", "medium", "strong"]


# --- real ffmpeg -----------------------------------------------------------------

@pytest.fixture(scope="module")
def clicky(tmp_path_factory):
    noisy, truth, amps = make_clicky()               # 150 s: 3 chunks, loud/quiet sections
    path = tmp_path_factory.mktemp("clicky") / "clicky.wav"
    write_wav(path, noisy)
    return path, truth, amps


@needs_ffmpeg
def test_residual_sign_and_scale(tmp_path):
    n = SR * 3
    t = np.arange(n) / SR
    x = (0.05 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
    x[SR + 100] += 0.5     # positive click
    x[2 * SR + 100] -= 0.5  # negative click
    path = tmp_path / "s.wav"
    write_wav(path, x)
    chunk = cd.plan_chunks(0, 3, total=3)[0]
    for strength in DECLICK_PRESETS:
        res, orig = cd.decode_chunk(path, chunk, strength)
        assert abs(len(res) - n) < 2000
        # original - declicked: positive click -> positive residual of ~its amplitude
        assert res[SR + 100] == pytest.approx(0.5, abs=0.08), strength
        assert res[2 * SR + 100] == pytest.approx(-0.5, abs=0.08), strength
        assert np.abs(res[int(cd.EDGE_S * SR) + 1:SR - 1000]).max() < 0.01  # clean audio: ~nothing
        assert np.allclose(orig[5000:6000], x[5000:6000], atol=2e-3)  # original channel, unscaled


def _check_accuracy(found, truth, strength, elapsed, span_s):
    recall, precision, dup = match(found, truth, tol=0.03)
    print(f"\n{strength}: {len(found)} found / {len(truth)} true  recall {recall:.3f}  "
          f"precision {precision:.3f}  dup {dup}  {elapsed / (span_s / 60):.2f} s per minute of audio")
    assert recall >= 0.9
    assert precision >= 0.9
    assert dup == 0
    assert np.diff(found).min() >= cd.MERGE_MS / 1000.0   # no duplicate events from overlap regions


@needs_ffmpeg
@pytest.mark.parametrize("strength", ["light", "medium"])
def test_detection_accuracy_across_chunks(clicky, strength):
    path, truth, _ = clicky
    t0 = time.time()
    found = cd.scan_clicks(path, 0.0, 150.0, strength, total=150.0)
    _check_accuracy(found, truth, strength, time.time() - t0, 150.0)
    # clicks sitting in the overlap around the 60 s / 120 s seams are found exactly once
    for seam in (60.0, 120.0):
        near_truth = [t for t in truth if abs(t - seam) < 0.6]
        near_found = [f for f in found if abs(f - seam) < 0.6]
        assert near_truth and len(near_found) == len(near_truth)


@needs_ffmpeg
def test_detection_accuracy_at_strong(clicky):
    """Strong is ~5x slower, and chunk seams do not depend on the strength (covered above), so
    it is scanned over its last minute only."""
    path, truth, _ = clicky
    a, b = 90.0, 150.0
    t0 = time.time()
    found = cd.scan_clicks(path, a, b, "strong", total=150.0)
    _check_accuracy(found, [t for t in truth if a <= t < b], "strong", time.time() - t0, b - a)


@needs_ffmpeg
def test_detection_stays_inside_requested_span(clicky):
    path, truth, _ = clicky
    found = cd.scan_clicks(path, 30.0, 100.0, "medium", total=150.0)
    assert found and min(found) >= 30.0 and max(found) < 100.0
    inside = [t for t in truth if 30.0 <= t < 100.0]
    assert match(found, inside, tol=0.03)[0] >= 0.9


@needs_ffmpeg
def test_scan_progress_and_cancel(clicky):
    path, _, _ = clicky
    seen = []
    cd.scan_clicks(path, 0.0, 150.0, "light", total=150.0, progress=seen.append)
    assert seen == pytest.approx([1 / 3, 2 / 3, 1.0])
    with pytest.raises(RuntimeError):
        cd.scan_clicks(path, 0.0, 150.0, "light", total=150.0, cancelled=lambda: True)


# --- API flow ----------------------------------------------------------------------

@pytest.fixture
def api_session(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    noisy, truth, _ = make_clicky(seconds=24, n_clicks=8, section_s=8.0)
    source = tmp_path / "source.wav"
    write_wav(source, noisy)
    sid = str(uuid.uuid4())
    session_store.create(
        session_id=sid, source_audio=source, source_filename="c.wav",
        source_duration=24.0, source_size=source.stat().st_size,
    )
    api.get_session_path(sid).mkdir(parents=True, exist_ok=True)
    yield sid, truth
    api.cleanup_session(sid)


def _wait_done(c, sid, declick, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        body = c.get(f"/api/clicks/{sid}", params={"declick": declick}).json()
        if body["status"] in ("done", "error"):
            return body
        time.sleep(0.1)
    raise AssertionError("scan did not finish")


@needs_ffmpeg
def test_clicks_endpoint_start_poll_complete_and_cache(api_session, monkeypatch):
    sid, truth = api_session
    calls = []
    real = cd.scan_clicks

    def counting(*a, **k):
        calls.append(a[3])
        return real(*a, **k)

    monkeypatch.setattr(cd, "scan_clicks", counting)
    with TestClient(app) as c:
        assert c.get(f"/api/clicks/{sid}", params={"declick": "off"}).json()["status"] == "none"
        started = c.post(f"/api/clicks/{sid}", json={"declick": "off"}).json()
        assert started["status"] in ("running", "done")
        assert started["strength"] == "medium" and started["requested"] == "off"
        done = _wait_done(c, sid, "off")
        assert done["status"] == "done" and done["progress"] == 1.0
        assert done["strength"] == "medium" and done["count"] == len(done["times"])
        assert match(done["times"], truth, tol=0.03)[0] >= 0.75
        assert (api.get_session_path(sid) / "clicks_medium.json").is_file()
        assert not list(api.get_session_path(sid).glob("clicks_*.part"))

        again = c.post(f"/api/clicks/{sid}", json={"declick": "medium"}).json()   # served from cache
        assert again["status"] == "done" and again["times"] == done["times"]
        assert calls == ["medium"]                                                # no second scan

        # a different strength is its own scan and its own cache file
        c.post(f"/api/clicks/{sid}", json={"declick": "strong"})
        assert _wait_done(c, sid, "strong")["strength"] == "strong"
        assert calls == ["medium", "strong"]

        assert c.post(f"/api/clicks/{sid}", json={"declick": "bogus"}).status_code == 400
        assert c.get(f"/api/clicks/{uuid.uuid4()}").status_code == 404
        assert c.post(f"/api/clicks/{uuid.uuid4()}", json={"declick": "light"}).status_code == 404


@needs_ffmpeg
def test_clicks_websocket_messages(api_session):
    sid, _ = api_session
    with TestClient(app) as c, c.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "connected"
        c.post(f"/api/clicks/{sid}", json={"declick": "light"})
        types = []
        for _ in range(40):
            msg = ws.receive_json()
            types.append(msg["type"])
            if msg["type"] == "click_scan_complete":
                assert msg["file_id"] == sid and msg["strength"] == "light" and msg["count"] >= 1
                break
        assert "click_scan_complete" in types


@needs_ffmpeg
def test_session_removal_cleans_click_tasks(api_session):
    sid, _ = api_session
    with TestClient(app) as c:
        c.post(f"/api/clicks/{sid}", json={"declick": "light"})
        api.cleanup_session(sid)
        assert not [k for k in api._click_tasks if k[0] == sid]
        assert sid not in api._click_cancel and not [k for k in api._click_progress if k[0] == sid]
