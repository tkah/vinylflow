"""Zero-phase rumble high-pass for the A/B "Removed" render (real ffmpeg, offline).

A plain high-pass's phase shift leaks a ghost of the music into original - processed.  The
forward + reverse form squares the magnitude, so its pass is a 2-pole high-pass at 7.5 Hz,
Q 0.515 whose squared response matches ``highpass=f=15``.  Export keeps the normal filter.
"""

import os
import shutil
import subprocess
import sys
import wave

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))

import audio_processor as ap_mod  # noqa: E402
from audio_processor import (  # noqa: E402
    RUMBLE_FILTER, RUMBLE_FILTER_ZERO_PHASE, AudioProcessor, build_export_filters, removed_graph,
)
from declick_measure import run_chain  # noqa: E402
from hum_measure import _band_amp  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
SR = 44100
SECONDS = 12
BASS = (60.0, 120.0, 90.0, 1000.0, 2500.0)


def _music_and_rumble():
    t = np.arange(SR * SECONDS) / SR
    music = sum(a * np.sin(2 * np.pi * f * t + i) for i, (f, a) in enumerate(
        zip(BASS, (0.15, 0.1, 0.08, 0.05, 0.03))))
    rumble = 0.12 * np.sin(2 * np.pi * 8 * t)
    return music, rumble


@pytest.fixture(scope="module")
def wav(tmp_path_factory):
    music, rumble = _music_and_rumble()
    p = tmp_path_factory.mktemp("rz") / "m.wav"
    pcm = (np.stack([music + rumble] * 2, 1) * 32767).astype("<i2")
    with wave.open(str(p), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return p


def _decode(path):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<f4").reshape(-1, 2).astype(np.float64)


def _one_pass(wav, chain, start, end, out):
    seek_s, read_dur, t0, t1 = ap_mod.padded_window(start, end, SECONDS, SR, 3.0)
    ap_mod.run_ffmpeg(
        ["-y", *ap_mod.seek_args(seek_s, read_dur), "-i", str(wav), "-filter_complex",
         removed_graph(chain, 2, (t0, t1)), "-map", "[out]", "-c:a", "flac", "-sample_fmt", "s32",
         "-bits_per_raw_sample", "24", str(out)], check=True, capture_output=True)
    return _decode(out)


def _gain_db(chain, f):
    t = np.arange(SR * 20) / SR
    x = (0.3 * np.sin(2 * np.pi * f * t)).astype(np.float32)
    y = run_chain(x, chain)
    a, b = len(x) // 4, 3 * len(x) // 4           # clear of both ends' settling
    return 20 * np.log10(_band_amp(y[a:b], f, SR, 1.0) / _band_amp(x[a:b], f, SR, 1.0))


def test_export_and_processed_keep_the_normal_filter():
    assert build_export_filters(True) == RUMBLE_FILTER
    assert "areverse" not in build_export_filters(True, "light", 1.0, hum=60)
    assert build_export_filters(True, zero_phase_rumble=True) == RUMBLE_FILTER_ZERO_PHASE
    assert RUMBLE_FILTER_ZERO_PHASE.count("areverse") == 2


def test_zero_phase_magnitude_matches_export_filter_5_to_200_hz():
    worst = 0.0
    for f in (5, 6, 7, 8, 10, 12, 15, 18, 22, 30, 50, 80, 120, 200):
        d = _gain_db(RUMBLE_FILTER_ZERO_PHASE, f) - _gain_db(RUMBLE_FILTER, f)
        worst = max(worst, abs(d))
    print(f"\nmax |zero-phase - export| magnitude difference 5-200 Hz: {worst:.2f} dB")
    assert worst < 1.1


def test_rumble_ghost_of_the_music_drops_and_rumble_is_kept(wav, tmp_path):
    start, end = 2.0, 10.0
    plain = _one_pass(wav, RUMBLE_FILTER, start, end, tmp_path / "p.flac")
    zp = _one_pass(wav, RUMBLE_FILTER_ZERO_PHASE, start, end, tmp_path / "z.flac")
    orig = _decode(wav)[round(start * SR):round(end * SR)]

    def share(res, f):
        return _band_amp(res[:, 0], f, SR) / _band_amp(orig[:, 0], f, SR)

    before, after = share(plain, 60), share(zp, 60)
    print(f"\n60 Hz music ghost in Removed: plain {before:.1%} -> zero-phase {after:.1%}")
    assert before > 0.15 and after < 0.03
    for res in (plain, zp):                                    # the 8 Hz rumble is what remains
        low = np.abs(np.fft.rfft(res[:, 0] * np.hanning(len(res)))) ** 2
        fr = np.fft.rfftfreq(len(res), 1 / SR)
        assert low[fr < 20].sum() > 5 * low[fr >= 20].sum()
    r8 = _band_amp(zp[:, 0], 8, SR, 1.0) / _band_amp(orig[:, 0], 8, SR, 1.0)
    assert 0.65 < r8 < 0.78               # 1 - |H(8 Hz)| = 0.73 of the rumble is removed


def test_chunked_equals_one_pass_with_exact_length(wav, tmp_path):
    start, end = 1.3, 10.7
    chain = build_export_filters(True, zero_phase_rumble=True)
    ref = _one_pass(wav, chain, start, end, tmp_path / "ref.flac")
    out = tmp_path / "chunked.flac"
    AudioProcessor().render_removed_flac(wav, start, end, chain, 2, out, chunk_s=3.0, context_s=2.0)
    got = _decode(out)
    assert got.shape == ref.shape and len(got) == round(end * SR) - round(start * SR)
    err, peak = float(np.max(np.abs(got - ref))), float(np.max(np.abs(ref)))
    print(f"\nchunked vs one-pass: max diff {err:.2e} (peak {peak:.2e})")
    assert err < 0.02 * peak


def test_api_removed_uses_chunked_zero_phase_for_rumble(monkeypatch, tmp_path, wav):
    import uuid
    import backend.api as api
    from fastapi.testclient import TestClient
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    sid = str(uuid.uuid4())
    api.session_store.create(session_id=sid, source_audio=wav, source_filename="t.wav",
                             source_duration=float(SECONDS), source_size=wav.stat().st_size)
    api.get_session_path(sid).mkdir(parents=True, exist_ok=True)
    calls = []
    real = api.audio_processor.render_removed_flac
    monkeypatch.setattr(api.audio_processor, "render_removed_flac",
                        lambda *a, **k: calls.append(a) or real(*a, **k))
    try:
        r = TestClient(api.app).post("/api/restoration-test", json={
            "file_id": sid, "start": 2.0, "end": 8.0, "rumble": True, "declick": "off",
            "album_gain": False})
        assert r.status_code == 200, r.text
        assert len(calls) == 1 and "areverse" in calls[0][3]
        assert "areverse" not in r.json()["chain"]             # processed render: normal filter
    finally:
        api.session_store.remove(sid)
