"""Plan 07 slice 4: silent-stretch analysis -- hum detector + noise profile.

The pure parts run on synthetic spectra / envelopes; the file tests build a record side
(lead-in, music, gap, music, run-out) with real ffmpeg decoding of just the silent stretches.
"""

import os
import shutil
import sys
import wave

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))

import silence_analysis as sa  # noqa: E402
from audio_processor import AudioProcessor, ENVELOPE_FRAME_S, NoiseProfile  # noqa: E402
from hiss_measure import make_hiss  # noqa: E402
from hum_measure import make_hum  # noqa: E402
from side_synth import LAYOUT, SR, make_side  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _env(*parts, frame_s=ENVELOPE_FRAME_S):
    """Envelope from (seconds, dB) parts."""
    return np.concatenate([np.full(int(round(s / frame_s)), db, dtype=np.float32) for s, db in parts])


# --- silent_ranges (pure) ----------------------------------------------------------

def test_silent_ranges_are_inside_the_gaps_and_clear_of_music():
    db = _env((3, -55), (6, -20), (3, -55), (6, -20), (3, -55))
    ranges = sa.silent_ranges(db, ENVELOPE_FRAME_S)
    assert ranges == sorted(ranges) and len(ranges) == 3
    spans = [(0, 3), (9, 12), (18, 21)]
    for (a, b), (g0, g1) in zip(ranges, spans):
        assert g0 + sa.EDGE_MARGIN_S - 1e-6 <= a < b <= g1 - sa.EDGE_MARGIN_S + 1e-6


def test_silent_ranges_total_is_capped_at_30_seconds():
    parts = []
    for _ in range(60):
        parts += [(4, -55), (20, -20)]
    ranges = sa.silent_ranges(_env(*parts), ENVELOPE_FRAME_S)
    assert sum(b - a for a, b in ranges) <= 30.0 + 1e-6
    assert all(b - a <= sa.MAX_RANGE_S + 1e-6 for a, b in ranges)
    assert ranges == sorted(ranges)


def test_silent_ranges_prefers_the_longest_stretches():
    db = _env((2.3, -55), (10, -20), (9, -55), (10, -20), (2.3, -55))
    ranges = sa.silent_ranges(db, ENVELOPE_FRAME_S, max_total_s=8.0)
    assert len(ranges) == 1 and ranges[0][0] > 12.0 and ranges[0][1] < 21.5      # the 9 s gap


def test_silent_ranges_follow_a_loud_hum_floor():
    """Hum at -33 dB puts the gaps above the usual -40 dB silence threshold; the floor-relative
    threshold still finds them."""
    db = _env((3, -33), (6, -10), (3, -33), (6, -10), (3, -33))
    assert len(sa.silent_ranges(db, ENVELOPE_FRAME_S)) == 3


def test_silent_ranges_ignore_music_only_and_digital_silence():
    assert sa.silent_ranges(_env((30, -20)), ENVELOPE_FRAME_S) == []
    assert sa.silent_ranges(_env((30, -120)), ENVELOPE_FRAME_S) == []
    assert sa.silent_ranges(np.zeros(0, dtype=np.float32), ENVELOPE_FRAME_S) == []
    assert sa.silent_ranges(_env((1.0, -55), (20, -20), (1.0, -55)), ENVELOPE_FRAME_S) == []   # too short


# --- hum detector (pure, on spectra) -----------------------------------------------

def _analyse(x, sr=SR):
    return sa.analyze_pcm([x], sr)


def _noise_hum(f0, hum_db, secs=14, kind="vinyl", seed=1, hiss=-58.0, levels=None):
    x = make_hiss(SR * secs, hiss, kind, seed=seed)
    if f0:
        kw = {"levels": levels} if levels else {}
        x = x + make_hum(f0, seconds=secs, seed=seed, **kw) * 10 ** (hum_db / 20)
    return x


# every noise kind at the loud and the faint end, plus the mid levels on white noise only
@pytest.mark.parametrize("f0", [50, 60])
@pytest.mark.parametrize("kind,gain", [(k, g) for k in ("white", "pink", "vinyl") for g in (0, -25)]
                         + [("white", -10), ("white", -20)])
def test_detects_the_right_mains_frequency(f0, kind, gain):
    r = _analyse(_noise_hum(f0, gain, kind=kind))["hum"]
    assert r["detected"] == f0, r
    assert len(r["harmonics"]) >= 3 and f0 in r["harmonics"]
    assert r["prominence_db"] > sa.HUM_PROMINENCE_DB
    # total hum RMS: harmonics at -45/-40/-42/-50/-48/-55/-55 dB peak -> -39.5 dBFS RMS at 0 dB gain
    assert r["level_dbfs"] == pytest.approx(-39.5 + gain, abs=2.5)


@pytest.mark.parametrize("kind", ["white", "pink", "vinyl"])
@pytest.mark.parametrize("seed", range(5))
def test_no_false_positive_on_noise_alone(kind, seed):
    r = _analyse(_noise_hum(None, 0, kind=kind, seed=seed))["hum"]
    assert r == {"detected": None, "level_dbfs": None, "prominence_db": None, "harmonics": []}


def test_no_false_positive_on_rumble_and_sub_bass_noise():
    """Strong 1/f^2 low-frequency rumble (steep slope under 100 Hz) must not look like hum."""
    rng = np.random.default_rng(4)
    n = SR * 14
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    rumble = np.fft.irfft(spec / f, n)
    rumble = rumble / np.std(rumble) * 10 ** (-45 / 20)
    x = rumble + make_hiss(n, -60, "vinyl")
    assert _analyse(x.astype(np.float32))["hum"]["detected"] is None


def test_weak_fundamental_is_found_through_its_harmonics():
    lv = (-120, -42, -44, -50, -50, -60, -60)        # rectifier-style: fundamental almost absent
    r = _analyse(_noise_hum(60, 0, levels=lv))["hum"]
    assert r["detected"] == 60 and 60 not in r["harmonics"] and 120 in r["harmonics"]


def _flat_spectrum(lines, floor=1e-8, nfft=32768):
    freqs = np.fft.rfftfreq(nfft, 1 / SR)
    power = np.full(len(freqs), floor)
    for f, factor in lines:
        k = int(round(f / (freqs[1] - freqs[0])))
        power[k] *= factor
        power[k - 1] *= factor / 3
        power[k + 1] *= factor / 3
    return freqs, power


def test_lone_marginal_line_is_not_enough_but_a_lone_strong_one_is():
    assert sa.detect_hum(*_flat_spectrum([(60.0, 8)]))["detected"] is None       # ~9 dB: no suggestion
    assert sa.detect_hum(*_flat_spectrum([(60.0, 40)]))["detected"] == 60        # ~16 dB: enough
    two = sa.detect_hum(*_flat_spectrum([(60.0, 8), (120.0, 8)]))                # two marginal lines agree
    assert two["detected"] == 60 and two["harmonics"] == [60, 120]
    assert sa.detect_hum(*_flat_spectrum([(60.0, 2), (120.0, 2)]))["detected"] is None     # in the noise


def test_hum_below_the_audible_floor_is_ignored():
    r = _analyse(_noise_hum(60, -45, hiss=-90.0))["hum"]          # total ~ -85 dBFS
    assert r["detected"] is None


def test_300_hz_alone_does_not_pick_a_family():
    only300 = _noise_hum(50, 0, levels=(-120, -120, -41, -120, -120, -120, -120))   # 150? no: set below
    # a line at exactly 300 Hz (3rd of 100? it is 6th of 50 and 5th of 60): shared -> no vote
    n = SR * 14
    t = np.arange(n) / SR
    x = make_hiss(n, -58, "white") + (0.01 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
    assert _analyse(x)["hum"]["detected"] is None
    del only300


def test_both_families_present_picks_the_stronger():
    x = _noise_hum(60, 0) + make_hum(50, seconds=14, seed=9) * 10 ** (-15 / 20)
    assert _analyse(x.astype(np.float32))["hum"]["detected"] == 60


@pytest.mark.parametrize("sr", [44100, 48000, 96000])
def test_other_sample_rates(sr):
    secs = 12
    x = make_hiss(sr * secs, -58, "white") + make_hum(60, seconds=secs, sr=sr, seed=2) * 10 ** (-10 / 20)
    r = sa.analyze_pcm([x.astype(np.float32)], sr)
    assert r["hum"]["detected"] == 60
    assert r["noise"]["floor_dbfs"] == pytest.approx(-58, abs=1.5)


def test_stereo_segments_and_short_input():
    seg = np.stack([_noise_hum(60, -10, secs=6, seed=1), _noise_hum(60, -10, secs=6, seed=2)], 1)
    assert sa.analyze_pcm([seg], SR)["hum"]["detected"] == 60
    too_short = sa.analyze_pcm([np.zeros(1000, dtype=np.float32)], SR)
    assert too_short["hum"]["detected"] is None and too_short["noise"] is None


# --- noise profile -------------------------------------------------------------------

@pytest.mark.parametrize("level", [-70, -58, -46])
def test_white_noise_profile_is_flat_and_calibrated(level):
    r = _analyse(make_hiss(SR * 12, level, "white"))["noise"]
    assert r["floor_dbfs"] == pytest.approx(level, abs=0.7)
    assert all(abs(b - level) < 1.5 for b in r["band_dbfs"]), r["band_dbfs"]
    assert len(r["band_dbfs"]) == sa.NOISE_BANDS


def test_pink_noise_profile_falls_with_frequency():
    b = _analyse(make_hiss(SR * 12, -55, "pink"))["noise"]["band_dbfs"]
    assert all(b[i] > b[i + 1] for i in range(1, len(b) - 1))      # band 0 is rolled off below ~60 Hz
    assert b[1] - b[13] == pytest.approx(10 * np.log10(16500 / 110), abs=2.0)      # ~1/f between band centres


def test_hum_lines_do_not_inflate_the_noise_profile():
    plain = _analyse(make_hiss(SR * 12, -58, "white"))["noise"]
    humming = _analyse(_noise_hum(60, 0, kind="white"))["noise"]
    assert max(abs(a - b) for a, b in zip(plain["band_dbfs"], humming["band_dbfs"])) < 2.0


def test_noise_profile_round_trips_into_a_NoiseProfile():
    prof = NoiseProfile.from_analysis(_analyse(make_hiss(SR * 12, -58, "vinyl"))["noise"])
    assert prof is not None and len(prof.bands_dbfs) == 15
    assert NoiseProfile.from_analysis(None) is None
    assert NoiseProfile.from_analysis({"floor_dbfs": -50, "band_dbfs": [1, 2]}) is None
    assert NoiseProfile.from_analysis({"floor_dbfs": "x", "band_dbfs": [0] * 15}) is None


# --- real files: only the silent stretches are looked at ------------------------------

def _write_side(path, x):
    pcm = (np.clip(np.stack([x, x * 0.9], 1), -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def _analyze_file(path):
    ap = AudioProcessor()
    db = ap.compute_envelope(path)
    return sa.analyze_source(path, db, ENVELOPE_FRAME_S, SR)


@needs_ffmpeg
@pytest.mark.parametrize("f0", [50, 60])
def test_file_with_hum_in_the_gaps_is_detected(tmp_path, f0):
    p = tmp_path / "side.wav"
    _write_side(p, make_side(hum=f0, hum_gain_db=-12, hiss_kind="white"))
    res = _analyze_file(p)
    assert res["hum"]["detected"] == f0, res
    assert 0 < res["analyzed_s"] <= 30
    assert res["noise"]["floor_dbfs"] == pytest.approx(-58, abs=3.0)
    assert res["version"] == sa.ANALYSIS_VERSION


@needs_ffmpeg
@pytest.mark.parametrize("bass", [50.0, 60.0, 120.0, 100.0])
def test_bass_note_in_the_music_is_not_hum(tmp_path, bass):
    """A loud 50/60 Hz (or harmonic) bass note played in the music, absent from the gaps."""
    p = tmp_path / "side.wav"
    _write_side(p, make_side(hum=None, bass_hz=bass))
    res = _analyze_file(p)
    assert res["hum"]["detected"] is None, res
    assert res["analyzed_s"] > 0       # it did look at the gaps


@needs_ffmpeg
def test_file_without_hum_and_without_bass(tmp_path):
    p = tmp_path / "side.wav"
    _write_side(p, make_side())
    assert _analyze_file(p)["hum"]["detected"] is None


@needs_ffmpeg
def test_loud_hum_that_defeats_the_fixed_silence_threshold_is_still_analysed(tmp_path):
    p = tmp_path / "side.wav"
    _write_side(p, make_side(hum=60, hum_gain_db=+6))          # ~ -33 dBFS RMS hum in the gaps
    res = _analyze_file(p)
    assert res["hum"]["detected"] == 60 and res["hum"]["level_dbfs"] > -40


@needs_ffmpeg
def test_decode_is_limited_to_the_silent_ranges(tmp_path, monkeypatch):
    p = tmp_path / "side.wav"
    _write_side(p, make_side(hum=60, hum_gain_db=-12))
    seen = []
    real = sa.decode_ranges
    monkeypatch.setattr(sa, "decode_ranges", lambda src, ranges, sr: seen.append(list(ranges)) or real(src, ranges, sr))
    _analyze_file(p)
    assert len(seen) == 1 and 1 <= len(seen[0]) <= 3
    pos, spans = 0.0, []
    for kind, dur in LAYOUT:
        if kind == "silence":
            spans.append((pos, pos + dur))
        pos += dur
    for a, b in seen[0]:
        assert any(g0 <= a and b <= g1 for g0, g1 in spans), (a, b)
    assert sum(b - a for a, b in seen[0]) <= 30.0


@needs_ffmpeg
def test_file_with_no_silence_returns_no_detection_and_no_profile(tmp_path):
    n = SR * 20
    t = np.arange(n) / SR
    p = tmp_path / "loud.wav"
    _write_side(p, (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32))
    res = _analyze_file(p)
    assert res["hum"]["detected"] is None and res["noise"] is None and res["analyzed_s"] == 0


# --- cache ---------------------------------------------------------------------------

def test_cache_round_trip_and_staleness(tmp_path):
    path = sa.cache_path(tmp_path)
    payload = {"version": sa.ANALYSIS_VERSION, "hum": {"detected": 60}, "noise": None, "analyzed_s": 3.0}
    assert sa.read_cache(path) is None
    assert sa.write_cache(path, payload)
    assert sa.read_cache(path) == payload
    path.write_text('{"version": -1, "hum": {}}')
    assert sa.read_cache(path) is None
    path.write_text("not json")
    assert sa.read_cache(path) is None
    assert sa.write_cache(tmp_path / "gone" / "x.json", payload) is False


@needs_ffmpeg
def test_mono_sources_keep_their_true_noise_level(tmp_path):
    """Up-mixing a mono file to stereo would lower the level by 3 dB (and with it the hiss
    reduction's noise floor); mono is analysed as mono."""
    x = make_side(hum=None, hiss_kind="white", hiss_dbfs=-58.0)
    p = tmp_path / "mono.wav"
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    assert sa.source_channels(p) == 1
    res = _analyze_file(p)
    assert res["noise"]["floor_dbfs"] == pytest.approx(-58.0, abs=1.0), res["noise"]["floor_dbfs"]
    st = tmp_path / "stereo.wav"
    _write_side(st, x)
    assert sa.source_channels(st) == 2
    res2 = _analyze_file(st)           # left = x, right = 0.9 x -> mean power -0.4 dB
    assert res2["noise"]["floor_dbfs"] == pytest.approx(-58.4, abs=1.0)
