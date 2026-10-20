"""Plan 07 slice 3: the "Removed" render (original - clean-up chain), real ffmpeg, offline."""

import shutil
import subprocess
import uuid
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient
from mutagen.flac import FLAC

import backend.api as api
from backend.api import app, session_store

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

client = TestClient(app)
SR = 44100
START, END = 1.0, 9.0
CLICKS_L = [3.0, 5.0, 7.0]   # absolute seconds; clicks only in the left channel


@pytest.fixture
def sid(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    n = SR * 12
    t = np.arange(n) / SR
    left = 0.25 * np.sin(2 * np.pi * 440 * t) + 0.15 * np.sin(2 * np.pi * 8 * t)
    right = 0.25 * np.sin(2 * np.pi * 660 * t) + 0.15 * np.sin(2 * np.pi * 8 * t)
    for c in CLICKS_L:
        i = int(c * SR)
        left[i:i + 3] += 0.7
    pcm = (np.clip(np.stack([left, right], 1), -1, 1) * 32767).astype("<i2")
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    file_id = str(uuid.uuid4())
    session_store.create(
        session_id=file_id, source_audio=source, source_filename="t.wav",
        source_duration=12.0, source_size=source.stat().st_size,
    )
    api.get_session_path(file_id).mkdir(parents=True, exist_ok=True)
    yield file_id
    session_store.remove(file_id)


def _post(file_id, **kw):
    body = {"file_id": file_id, "start": START, "end": END, "rumble": False,
            "declick": "light", "album_gain": False}
    body.update(kw)
    r = client.post("/api/restoration-test", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _decode(body_key_url, tmp_path, name):
    path = tmp_path / name
    path.write_bytes(client.get(body_key_url).content)
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s32le", "-ac", "2", "pipe:1"],
        capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<i4").reshape(-1, 2).astype(np.float64) / 2**31, path


def _rms(x):
    return float(np.sqrt(np.mean(x ** 2)))


def test_residual_is_sparse_and_in_the_right_channel(sid, tmp_path):
    body = _post(sid)
    res, path = _decode(body["removed_url"], tmp_path, "d.flac")
    orig, _ = _decode(body["original_url"], tmp_path, "o.flac")
    music = _rms(orig)
    mask = np.ones(len(res), bool)
    for c in CLICKS_L:
        i = int((c - START) * SR)
        mask[max(0, i - 400):i + 400] = False
    away = _rms(res[mask])
    head = _rms(res[:4410])
    print(f"first 0.1 s residual RMS {head:.6f} (was ~0.05 before padding)")
    assert head < 0.005
    print(f"\nresidual RMS away from clicks {away:.6f} vs music RMS {music:.4f} ({away / music:.5f}x)")
    assert away < music * 0.02
    for c in CLICKS_L:
        i = int((c - START) * SR)
        seg = res[i - 8:i + 24]
        el, er = float(np.sum(seg[:, 0] ** 2)), float(np.sum(seg[:, 1] ** 2))
        print(f"click @{c}s energy L={el:.4f} R={er:.2e}")
        assert el > 0.05 and er < el * 1e-3
    assert res.shape[1] == 2
    assert body["removed_peak_dbfs"] is not None and body["removed_peak_dbfs"] > -12
    assert FLAC(str(path)).info.channels == 2


def test_residual_ignores_album_gain(sid, tmp_path):
    off = _post(sid)
    on = _post(sid, album_gain=True)
    assert on["gain_db"] is not None and abs(on["gain_db"]) > 1.0
    assert on["removed_url"] == off["removed_url"]         # cached under the clean-up chain only
    r_off, _ = _decode(off["removed_url"], tmp_path, "a.flac")
    r_on, _ = _decode(on["removed_url"], tmp_path, "b.flac")
    print(f"\nresidual RMS gain off {_rms(r_off):.6f}, gain on ({on['gain_db']:+.2f} dB) {_rms(r_on):.6f}")
    assert _rms(r_off) == _rms(r_on)
    assert on["processed_url"] != off["processed_url"]


def test_rumble_only_residual_is_low_frequency(sid, tmp_path):
    body = _post(sid, rumble=True, declick="off")
    res, _ = _decode(body["removed_url"], tmp_path, "r.flac")
    spec = np.abs(np.fft.rfft(res[:, 0] * np.hanning(len(res)))) ** 2
    freqs = np.fft.rfftfreq(len(res), 1 / SR)
    low = spec[freqs < 20].sum()
    rest = spec[freqs >= 20].sum()
    print(f"\nrumble residual energy <20 Hz / >=20 Hz = {low / rest:.1f}")
    assert low > rest * 5


def test_null_when_no_cleanup_filters(sid):
    body = _post(sid, rumble=False, declick="off", album_gain=True)
    assert body["removed_url"] is None
    assert body["removed_lufs"] is None and body["removed_peak_dbfs"] is None
    assert body["processed_url"]


def test_cache_no_second_render(sid, monkeypatch):
    first = _post(sid)
    assert first["cached"] is False
    calls = []
    real = api.run_ffmpeg
    monkeypatch.setattr(api, "run_ffmpeg", lambda *a, **k: calls.append(a) or real(*a, **k))
    monkeypatch.setattr(api.audio_processor, "measure_file", lambda *a, **k: calls.append(a))
    second = _post(sid)
    assert calls == [] and second["cached"] is True
    assert second["removed_url"] == first["removed_url"]
    assert second["removed_lufs"] == first["removed_lufs"]
    assert second["removed_peak_dbfs"] == first["removed_peak_dbfs"]


def test_output_is_24_bit(sid, tmp_path):
    body = _post(sid)
    _, path = _decode(body["removed_url"], tmp_path, "bits.flac")
    assert FLAC(str(path)).info.bits_per_sample == 24
    orig, opath = _decode(body["original_url"], tmp_path, "o16.flac")
    assert FLAC(str(opath)).info.bits_per_sample == 16


def test_name_validator(sid):
    good = "rtdiff_0123456789ab.flac"
    assert api._RT_NAME_RE.fullmatch(good)
    for bad in ("rtother_0123456789ab.flac", "rtdiff_0123456789ab.wav", "../rtdiff_0123456789ab.flac",
                "rtdiff_0123456789a.flac", "rtdiff_0123456789ab.flac.loud.json", "rtdiffrtproc_0123456789ab.flac"):
        assert not api._RT_NAME_RE.fullmatch(bad), bad
    assert client.get(f"/api/restoration-test/{sid}/rtother_0123456789ab.flac").status_code == 400
    assert client.get(f"/api/restoration-test/{sid}/..%2Frtdiff_0123456789ab.flac").status_code in (400, 404)
    assert client.get(f"/api/restoration-test/{sid}/{good}").status_code == 404
