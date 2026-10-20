"""End-to-end loudness pipeline with real ffmpeg + Mutagen and a seeded
release cache.  No network: the Discogs client is never called because
``get_release_by_id`` is served from the release cache and the release
has no cover."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import re
import pytest
from mutagen.flac import FLAC
from mutagen.mp3 import MP3

import audio_processor
from audio_processor import AudioProcessor, run_ffmpeg
from backend.sessions import OutputSpec, ProgressEvent, SessionStore, pipeline
from metadata_handler import MetadataHandler

# (start, end) of three tones at descending levels, separated by silence.
RANGES = [(0.0, 8.0), (10.0, 18.0), (20.0, 28.0)]
LEVELS_DB = [0, -8, -16]


class FakeTrackEntry:
    def __init__(self, position, title):
        self.position = position
        self.title = title


@dataclass
class SeedRelease:
    id: int = 99
    artist: str = "Test Artist"
    title: str = "Loud Album"
    year: int = 1990
    label: str = "Lbl"
    cover_url: Optional[str] = None
    various_artists: bool = False

    def __post_init__(self):
        self.tracks = [
            FakeTrackEntry("A1", "One"), FakeTrackEntry("A2", "Two"), FakeTrackEntry("A3", "Three"),
        ]


@dataclass
class B:
    number: int
    start: float
    end: float


@pytest.fixture(scope="module")
def source_wav(tmp_path_factory):
    d = tmp_path_factory.mktemp("src")
    out = d / "source.wav"
    inputs, parts = [], []
    n = 0
    for i, ((a, b), lvl) in enumerate(zip(RANGES, LEVELS_DB)):
        inputs += ["-f", "lavfi", "-i", f"sine=f={220 * (i + 1)}:d={b - a}:r=44100,volume={lvl}dB"]
        parts.append(f"[{n}:a]")
        n += 1
        if i < 2:
            inputs += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2"]
            parts.append(f"[{n}:a]")
            n += 1
    graph = "".join(parts) + f"concat=n={n}:v=0:a=1[o]"
    r = run_ffmpeg(
        [*inputs, "-filter_complex", graph, "-map", "[o]", "-c:a", "pcm_s16le", "-y", str(out)],
        capture_output=True,
    )
    assert r.returncode == 0, r.stderr
    return out


def run_pipeline(tmp_path, source_wav, fmt, album_gain, replaygain, rumble=False, declick="off"):
    handler = MetadataHandler(discogs_token="", user_agent="")
    handler._release_cache[99] = SeedRelease()  # seeded: never hits Discogs
    session = SessionStore().create(
        session_id="s", source_audio=source_wav, source_filename="source.wav",
        source_duration=28.0, source_size=source_wav.stat().st_size,
        source_bit_depth=16,  # generated WAV is 16-bit
    )
    session.set_boundaries([B(i + 1, a, b) for i, (a, b) in enumerate(RANGES)])
    session.set_mappings({1: "A1", 2: "A2", 3: "A3"})
    spec = OutputSpec(
        output_format=fmt, output_dir=tmp_path / "out",
        rumble_filter=rumble, declick=declick,
        album_gain=album_gain, replaygain=replaygain,
    )
    events: list[ProgressEvent] = []
    pipeline.run(session, spec, 99, AudioProcessor(), handler, events.append)
    folder = session.last_run.output_folder
    return [folder / f for f in session.last_run.output_files], events


@pytest.fixture
def ffmpeg_spy(monkeypatch):
    calls = []
    real = audio_processor.run_ffmpeg

    def spy(args, **kw):
        calls.append(list(args))
        return real(args, **kw)

    monkeypatch.setattr(audio_processor, "run_ffmpeg", spy)
    return calls


_TRIM_RE = re.compile(r"atrim=start_sample=\d+:end_sample=\d+,asetpts=PTS-STARTPTS,?")


def af_of(call):
    """The -af chain with the sample-exact pad trim removed (padding is covered
    in tests/test_filter_padding.py), so chain-content assertions stay readable."""
    if "-af" not in call:
        return ""
    return _TRIM_RE.sub("", call[call.index("-af") + 1]).rstrip(",")


def rg(path):
    t = FLAC(path)
    return {k.upper(): v for k, v in t.tags if k.upper().startswith("REPLAYGAIN")}


def gain_of(s):
    return float(s.split()[0])


def test_album_gain_and_replaygain_flac(tmp_path, source_wav, ffmpeg_spy):
    files, events = run_pipeline(tmp_path, source_wav, "flac", album_gain=True, replaygain=True)
    assert len(files) == 3

    # One identical volume filter on every extraction
    extract_afs = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c]
    assert len(extract_afs) == 3
    assert len(set(extract_afs)) == 1 and extract_afs[0].startswith("volume=")
    # 16-bit source + "source" setting: processed audio is dithered down.
    assert extract_afs[0].endswith(",aresample=osf=s16:dither_method=triangular")
    extract_afs = [af.split(",aresample=")[0] for af in extract_afs]
    assert all("loudnorm" not in c for c in map(" ".join, ffmpeg_spy))
    applied = float(extract_afs[0][len("volume="):-2])

    msgs = [e.message for e in events]
    assert any(m.startswith("Album gain ") for m in msgs)
    assert any("ReplayGain tags written" in m for m in msgs)
    assert events[-1].phase == "complete"
    fractions = [e.fraction for e in events]
    assert fractions == sorted(fractions)

    # Output album loudness lands on -14 LUFS (peak cap is not binding here)
    ap = AudioProcessor()
    album = ap.measure_files(files)
    print("applied gain", applied, "output album", album)
    assert album.integrated == pytest.approx(-14.0, abs=0.7)
    assert album.true_peak <= -1.0 + 0.2

    # Per-track relative differences preserved (source steps are 8 dB)
    lufs = [ap.measure_file(f).integrated for f in files]
    assert lufs[0] - lufs[1] == pytest.approx(8.0, abs=0.5)
    assert lufs[1] - lufs[2] == pytest.approx(8.0, abs=0.5)

    tags = [rg(f) for f in files]
    print("replaygain", tags)
    for t in tags:
        assert set(t) == {
            "REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_PEAK",
            "REPLAYGAIN_ALBUM_GAIN", "REPLAYGAIN_ALBUM_PEAK",
        }
    track_gains = [gain_of(t["REPLAYGAIN_TRACK_GAIN"]) for t in tags]
    assert track_gains[0] < track_gains[1] < track_gains[2]  # quieter -> larger gain
    assert len({t["REPLAYGAIN_ALBUM_GAIN"] for t in tags}) == 1
    assert len({t["REPLAYGAIN_ALBUM_PEAK"] for t in tags}) == 1
    # Album gain is the -18 LUFS reference for the album as measured
    assert gain_of(tags[0]["REPLAYGAIN_ALBUM_GAIN"]) == pytest.approx(-18.0 - album.integrated, abs=0.1)
    assert 0 < float(tags[0]["REPLAYGAIN_ALBUM_PEAK"]) < 1.0


def test_album_gain_off_replaygain_off(tmp_path, source_wav, ffmpeg_spy):
    files, events = run_pipeline(tmp_path, source_wav, "flac", album_gain=False, replaygain=False)
    assert len(files) == 3
    assert not any("volume" in " ".join(c) for c in ffmpeg_spy)
    assert not any("ebur128" in " ".join(c) for c in ffmpeg_spy)
    assert all(rg(f) == {} for f in files)
    assert {e.phase for e in events} == {"fetching_release", "downloading_cover", "extracting", "complete"}


def test_restore_without_album_gain_has_no_volume_filter(tmp_path, source_wav, ffmpeg_spy):
    run_pipeline(tmp_path, source_wav, "flac", album_gain=False, replaygain=False,
                 rumble=True, declick="light")
    extract_afs = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c]
    assert extract_afs == [
        "highpass=f=15,adeclick=t=2.5:b=3:w=30,aresample=osf=s16:dither_method=triangular"
    ] * 3


def test_replaygain_only_mp3(tmp_path, source_wav):
    files, _ = run_pipeline(tmp_path, source_wav, "mp3", album_gain=False, replaygain=True)
    t = MP3(files[0]).tags
    assert "TXXX:REPLAYGAIN_TRACK_GAIN" in t and "TXXX:REPLAYGAIN_ALBUM_PEAK" in t


def test_measurement_failure_does_not_fail_job(tmp_path, source_wav, monkeypatch):
    monkeypatch.setattr(AudioProcessor, "measure_ranges", lambda *a, **k: None)
    monkeypatch.setattr(AudioProcessor, "measure_file", lambda *a, **k: None)
    monkeypatch.setattr(AudioProcessor, "measure_files", lambda *a, **k: None)
    files, events = run_pipeline(tmp_path, source_wav, "flac", album_gain=True, replaygain=True)
    assert len(files) == 3
    msgs = [e.message for e in events]
    assert any("album gain skipped" in m for m in msgs)
    assert any(m.startswith("Warning: ReplayGain") for m in msgs)
    assert events[-1].phase == "complete"
    assert all(rg(f) == {} for f in files)


@pytest.mark.parametrize("declick", ["medium", "strong"])
def test_pipeline_uses_new_rumble_declick_fields(tmp_path, source_wav, ffmpeg_spy, declick):
    from audio_processor import DECLICK_PRESETS
    run_pipeline(tmp_path, source_wav, "flac", album_gain=False, replaygain=False,
                 rumble=True, declick=declick)
    extract_afs = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c]
    assert extract_afs == [
        f"highpass=f=15,{DECLICK_PRESETS[declick]},aresample=osf=s16:dither_method=triangular"
    ] * 3


def test_pipeline_declick_only_and_album_gain_measure_uses_same_chain(tmp_path, source_wav, ffmpeg_spy):
    run_pipeline(tmp_path, source_wav, "flac", album_gain=True, replaygain=False,
                 rumble=False, declick="light")
    # With a filter chain the measurement filters each range on its own (padded,
    # trimmed, concatenated), never across an aselect junction.
    measure = [c[c.index("-filter_complex") + 1] for c in ffmpeg_spy if "ebur128" in " ".join(c)]
    assert measure and "adeclick=t=2.5:b=3:w=30" in measure[0] and "highpass" not in measure[0]
    assert "aselect" not in measure[0] and measure[0].count("atrim=") == 3
    extract_afs = [af_of(c) for c in ffmpeg_spy if "-ss" in c and "-filter_complex" not in c]
    assert all(a.startswith("adeclick=t=2.5:b=3:w=30,volume=") for a in extract_afs)
