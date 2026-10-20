"""Filter edge effects at cut boundaries: filtered cuts are decoded with pre/post-roll
and trimmed sample-exactly afterwards.  Real ffmpeg, offline."""

import shutil
import subprocess
import wave

import numpy as np
import pytest

from audio_processor import (
    AudioProcessor, build_export_filters, padded_window, run_ffmpeg, trim_filter,
)
from track_boundaries import Track

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# --- padded_window (pure) ----------------------------------------------------------

@pytest.mark.parametrize("sr", [44100, 96000])
def test_window_middle_exact_samples(sr):
    seek, dur, t0, t1 = padded_window(10.0, 20.0, 100.0, sr)
    assert seek == pytest.approx(9.0) and dur == pytest.approx(12.0)
    assert t0 == sr and t1 - t0 == round(20.0 * sr) - round(10.0 * sr)


@pytest.mark.parametrize("sr", [44100, 96000])
def test_window_odd_times_keep_exact_length(sr):
    start, end = 12.3456789, 77.7654321
    seek, dur, t0, t1 = padded_window(start, end, 100.0, sr)
    assert t1 - t0 == round(end * sr) - round(start * sr)
    assert round(seek * sr) + t0 == round(start * sr)   # read start is a whole sample


def test_window_at_zero():
    seek, dur, t0, t1 = padded_window(0.0, 5.0, 60.0, 44100)
    assert seek == 0.0 and t0 == 0 and t1 == 5 * 44100 and dur == pytest.approx(6.0)
    seek, dur, t0, t1 = padded_window(0.4, 5.0, 60.0, 44100)
    assert seek == 0.0 and t0 == round(0.4 * 44100)


def test_window_at_eof():
    seek, dur, t0, t1 = padded_window(50.0, 60.0, 60.0, 44100)
    assert seek == pytest.approx(49.0) and dur == pytest.approx(11.0)
    assert t1 - t0 == 10 * 44100 and t1 == round(dur * 44100)   # nothing to trim after


def test_window_short_file():
    seek, dur, t0, t1 = padded_window(0.0, 0.5, 0.5, 48000)
    assert (seek, t0, t1) == (0.0, 0, 24000) and dur == pytest.approx(0.5)


def test_trim_filter_text():
    assert trim_filter(5, 9) == "atrim=start_sample=5:end_sample=9,asetpts=PTS-STARTPTS"


# --- real ffmpeg -------------------------------------------------------------------

SR = 44100


def _write(path, x, sr=SR, width=2):
    pcm = (np.clip(x, -1, 1) * (2 ** (8 * width - 1) - 1)).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(x.shape[1]); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())


@pytest.fixture(scope="module")
def tones(tmp_path_factory):
    """12 s stereo: tones + hiss, no clicks."""
    rng = np.random.default_rng(3)
    n = SR * 12
    t = np.arange(n) / SR
    base = 0.2 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.sin(2 * np.pi * 1320 * t)
    x = np.stack([base + rng.standard_normal(n) * 0.003,
                  0.8 * base + rng.standard_normal(n) * 0.003], 1)
    p = tmp_path_factory.mktemp("pad") / "tones.wav"
    _write(p, x)
    return p


def _decode(path, ch=2):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s32le", "-ac", str(ch), "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<i4").reshape(-1, ch).astype(np.float64) / 2**31


def _export(src, out, start, end, **kw):
    kw.setdefault("output_format", "flac")
    assert AudioProcessor().extract_track(src, Track(1, start, end), out, **kw)
    return _decode(out)


def _old_export(src, out, start, end, rumble=False, declick="off", gain_db=None, dither=True):
    """The pre-fix behaviour: filters see the bare cut."""
    chain = build_export_filters(rumble, declick, gain_db, dither)
    run_ffmpeg(["-y", "-ss", str(start), "-t", str(end - start), "-i", str(src), "-af", chain,
                "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(out)], capture_output=True, check=True)
    return _decode(out)


def test_declick_edges_match_unfiltered(tones, tmp_path):
    start, end = 3.0, 9.0
    raw = _export(tones, tmp_path / "raw.flac", start, end, bit_depth=24)
    new = _export(tones, tmp_path / "new.flac", start, end, declick="medium", bit_depth=24)
    old = _old_export(tones, tmp_path / "old.flac", start, end, declick="medium", dither=False)
    k = int(0.2 * SR)

    def dev(a, sl):
        return float(np.sqrt(np.mean((a[sl] - raw[sl]) ** 2)))
    head, tail = slice(0, k), slice(-k, None)
    print(f"\nedge RMS deviation vs unfiltered: old start {dev(old, head):.5f} end {dev(old, tail):.5f}; "
          f"new start {dev(new, head):.5f} end {dev(new, tail):.5f}")
    assert len(new) == len(raw)
    mid = slice(len(raw) // 2, len(raw) // 2 + k)
    floor = dev(new, mid)    # adeclick's own steady-state deviation on hiss
    print(f"steady-state (mid-track) deviation {floor:.5f}")
    assert dev(new, head) < 1.5 * floor and dev(new, tail) < 1.5 * floor
    assert dev(old, head) > 10 * floor


_FULL = dict(rumble=True, declick="strong", gain_db=2.5)
_MID = (4.123456, 8.654321)
# Not the 48-case cross-product: each format once with the full chain, the file head / tail cuts
# (clamped padding), and each single option set once.
LENGTH_CASES = (
    [(fmt, bits, _FULL, _MID) for fmt, bits in (("flac", 16), ("flac", 24), ("aiff", 16), ("aiff", 24))]
    + [("flac", 24, _FULL, (0.0, 4.0)), ("flac", 24, _FULL, (8.0, 12.0))]
    + [("flac", 24, o, _MID) for o in (dict(rumble=True), dict(declick="light"), dict(gain_db=-3.0))]
)


@pytest.mark.parametrize("fmt,bits,opts,span", LENGTH_CASES)
def test_exact_length(tones, tmp_path, fmt, bits, opts, span):
    start, end = span
    out = tmp_path / f"o.{fmt}"
    got = _export(tones, out, start, end, output_format=fmt, bit_depth=bits, **opts)
    assert len(got) == round(end * SR) - round(start * SR)


def test_rumble_alignment_of_transient(tmp_path):
    n = SR * 8
    x = np.zeros((n, 2))
    x[:, 0] = 0.1 * np.sin(2 * np.pi * 330 * np.arange(n) / SR)
    x[:, 1] = x[:, 0]
    mark = int(4.5 * SR) + 7
    x[mark:mark + 3] += 0.6
    src = tmp_path / "t.wav"
    _write(src, x)
    raw = _export(src, tmp_path / "r.flac", 3.0, 6.0)
    for bits in (16, 24):
        rum = _export(src, tmp_path / f"u{bits}.flac", 3.0, 6.0, rumble=True, bit_depth=bits)
        assert int(np.argmax(np.abs(rum[:, 0]))) == int(np.argmax(np.abs(raw[:, 0])))
        assert mark - 3 * SR <= int(np.argmax(np.abs(rum[:, 0]))) < mark - 3 * SR + 3


def test_album_gain_measurement_matches_old_junction_path(tmp_path):
    """Per-range padded filtering agrees with the old aselect-then-filter path
    to within 0.2 LU on a clean-ish signal (the old path filtered across junctions)."""
    from audio_processor import _aselect_ranges_filter
    from tests.click_synth import make_clicky, write_wav
    noisy, _, _ = make_clicky(seconds=40, n_clicks=30, section_s=10.0)
    p = tmp_path / "m.wav"
    write_wav(p, noisy)
    ap = AudioProcessor()
    ranges = [(2.0, 12.0), (14.0, 24.0), (26.0, 38.0)]
    for rumble, decl in [(False, "light"), (True, "medium"), (True, "off")]:
        chain = _aselect_ranges_filter(ranges) + "," + build_export_filters(rumble, decl, None)
        old = ap._measure(["-hide_banner", "-nostats", "-i", str(p), "-af",
                           chain + ",ebur128=peak=true:framelog=quiet"])
        new = ap.measure_ranges(p, ranges, rumble, decl)
        assert new.integrated == pytest.approx(old.integrated, abs=0.2)
        assert new.true_peak == pytest.approx(old.true_peak, abs=0.3)
