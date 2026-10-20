"""Combined album loudness (B3/B4): mono reads as it does alone; uniform groups skip the native pass.

Real ffmpeg on short synthetic files; no Discogs, no network."""
import pytest

from audio_processor import AudioProcessor, LoudnessSource, run_ffmpeg


def make(path, channels=1, rate=44100, freq=440, db=-20, seconds=12):
    src = f'sine=f={freq}:d={seconds}:r={rate},volume={db}dB'
    args = ['-y', '-f', 'lavfi', '-i', src, '-ac', str(channels), '-c:a', 'pcm_s24le', str(path)]
    assert run_ffmpeg(args, capture_output=True).returncode == 0
    return path


def source(path, seconds=12):
    return LoudnessSource(path, [(1.0, seconds - 1.0)])


def spy_native(audio, monkeypatch):
    calls = []
    real = audio.measure_ranges
    monkeypatch.setattr(audio, 'measure_ranges', lambda *a, **k: calls.append(a) or real(*a, **k))
    return calls


def test_mono_source_matches_its_own_measurement(tmp_path):
    audio = AudioProcessor()
    mono = make(tmp_path / 'm.wav')
    alone = audio.measure_ranges(mono, [(1.0, 11.0)])
    # Failed before the fix by ~3.01 LU (dual-mono upmix); passes with mono kept mono.
    assert audio.measure_sources([source(mono)]).integrated == pytest.approx(alone.integrated, abs=.1)
    group = audio.measure_sources([source(mono), source(make(tmp_path / 'm2.wav', freq=660, db=-26))])
    both = audio.measure_files([mono, tmp_path / 'm2.wav'])
    assert group.integrated == pytest.approx(both.integrated, abs=.3)


def test_uniform_mono_group_peak_is_not_folded_down(tmp_path, monkeypatch):
    # The native pass is skipped, so the combined pass must not fold mono (-3 dB) into stereo.
    audio = AudioProcessor()
    a = make(tmp_path / 'a.wav', db=-6)
    b = make(tmp_path / 'b.wav', freq=660, db=-20)
    calls = spy_native(audio, monkeypatch)
    got = audio.measure_sources([source(a), source(b)])
    assert calls == []
    assert got.true_peak == pytest.approx(audio.measure_ranges(a, [(1.0, 11.0)]).true_peak, abs=.1)


def test_mixed_group_folds_mono_at_equal_loudness(tmp_path):
    audio = AudioProcessor()
    mono = make(tmp_path / 'm.wav', freq=440, db=-18)
    stereo = make(tmp_path / 's.wav', channels=2, freq=660, db=-24)
    # Reference: the same programme built as all-stereo, the mono file folded at -3.01 dB per channel.
    folded = tmp_path / 'folded.wav'
    run_ffmpeg(['-y', '-i', str(mono), '-af', 'pan=stereo|c0=0.70711*c0|c1=0.70711*c0',
                '-c:a', 'pcm_s24le', str(folded)], capture_output=True, check=True)
    ref = audio.measure_files([folded, stereo])
    got = audio.measure_sources([source(mono), source(stereo)])
    assert got.integrated == pytest.approx(ref.integrated, abs=.1)


def test_measure_files_two_mono_equals_mono_concat(tmp_path):
    audio = AudioProcessor()
    a = make(tmp_path / 'a.wav', freq=440, db=-18)
    b = make(tmp_path / 'b.wav', freq=660, db=-27)
    joined = tmp_path / 'ab.wav'
    run_ffmpeg(['-y', '-i', str(a), '-i', str(b), '-filter_complex', 'concat=n=2:v=0:a=1',
                '-c:a', 'pcm_s24le', str(joined)], capture_output=True, check=True)
    assert audio.measure_files([a, b]).integrated == pytest.approx(
        audio.measure_file(joined).integrated, abs=.1)


def test_uniform_group_skips_native_pass(tmp_path, monkeypatch):
    audio = AudioProcessor()
    a = make(tmp_path / 'a.wav', channels=2, db=-18)
    b = make(tmp_path / 'b.wav', channels=2, freq=660, db=-24)
    calls = spy_native(audio, monkeypatch)
    got = audio.measure_sources([source(a), source(b)])
    assert calls == []
    # Peak comes from the combined pass: the louder file's own peak.
    assert got.true_peak == pytest.approx(audio.measure_ranges(a, [(1.0, 11.0)]).true_peak, abs=.1)


@pytest.mark.parametrize('rate_b,channels_b', [(48000, 2), (44100, 1)])
def test_non_uniform_group_runs_native_pass_and_keeps_max_peak(tmp_path, monkeypatch, rate_b, channels_b):
    audio = AudioProcessor()
    loud = make(tmp_path / 'a.wav', channels=2, db=-6)
    quiet = make(tmp_path / 'b.wav', channels=channels_b, rate=rate_b, freq=660, db=-30)
    calls = spy_native(audio, monkeypatch)
    got = audio.measure_sources([source(loud), source(quiet)])
    assert len(calls) == 2
    assert got.true_peak >= audio.measure_ranges(loud, [(1.0, 11.0)]).true_peak - .01
