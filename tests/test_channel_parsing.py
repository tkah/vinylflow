"""Mono detection must not depend on how the installed ffmpeg words the channel layout.

ffmpeg 7 prints a mono WAV without a channel mask as ``mono``; ffmpeg 6.1 (Ubuntu 24.04)
prints ``1 channels``. Both mean mono: analysing or rendering it as stereo up-mixes it and
lowers its level by 3 dB. The header lines below are real ffmpeg output; run_ffmpeg is
faked so these cases run on any installed ffmpeg version.
"""
import subprocess

import pytest

import backend.api as api
import silence_analysis as sa

HEADER = "  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, {layout}, s16, 705 kb/s\n"

CASES = [
    ("mono", 1),          # ffmpeg 7.x
    ("1 channels", 1),    # ffmpeg 6.1, no channel mask in the file
    ("stereo", 2),
    ("2 channels", 2),
    ("5.1(side)", 2),     # anything wider is folded to stereo
    ("6 channels", 2),
]


def _fake_ffmpeg(layout):
    def run(args, **kwargs):
        return subprocess.CompletedProcess(args, 1, stdout="", stderr=HEADER.format(layout=layout))
    return run


@pytest.mark.parametrize("layout,expected", CASES)
def test_silence_analysis_reads_mono_from_any_ffmpeg(monkeypatch, layout, expected):
    monkeypatch.setattr(sa, "run_ffmpeg", _fake_ffmpeg(layout))
    assert sa.source_channels("x.wav") == expected


@pytest.mark.parametrize("layout,expected", CASES)
def test_ab_render_reads_mono_from_any_ffmpeg(monkeypatch, layout, expected):
    monkeypatch.setattr(api, "run_ffmpeg", _fake_ffmpeg(layout))
    assert api._rt_channels("x.wav") == expected


def test_a_header_without_an_audio_stream_counts_as_stereo(monkeypatch):
    no_audio = "Input #0, wav, from 'x.wav':\n  Duration: N/A, bitrate: N/A\n"
    fake = lambda args, **kwargs: subprocess.CompletedProcess(args, 1, stdout="", stderr=no_audio)
    monkeypatch.setattr(sa, "run_ffmpeg", fake)
    monkeypatch.setattr(api, "run_ffmpeg", fake)
    assert sa.source_channels("x.wav") == 2
    assert api._rt_channels("x.wav") == 2


def test_unreadable_header_falls_back_to_stereo(monkeypatch):
    def broken(args, **kwargs):
        raise OSError("ffmpeg missing")
    monkeypatch.setattr(sa, "run_ffmpeg", broken)
    monkeypatch.setattr(api, "run_ffmpeg", broken)
    assert sa.source_channels("x.wav") == 2
    assert api._rt_channels("x.wav") == 2
