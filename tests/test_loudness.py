"""Pure tests for the export filter chain, ebur128 parsing, album gain and
ReplayGain math.  Sample stderr below was captured from ffmpeg 7.1 with
``-af ebur128=peak=true:framelog=quiet -f null -``."""

import pytest

from audio_processor import (
    Loudness,
    album_gain_db,
    build_export_filters,
    format_replaygain_gain,
    format_replaygain_peak,
    parse_ebur128_summary,
    replaygain_gain_db,
)

TONE_STDERR = """\
Input #0, wav, from 'a.wav':
  Duration: 00:00:03.00, bitrate: 705 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, mono, s16, 705 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))
[Parsed_ebur128_0 @ 0xffff98003b50] t: 2.999977   TARGET:-23 LUFS    M: -41.8 S: -41.8     I: -41.8 LUFS       LRA:  20.0 LU  FTPK: -38.1 dBFS  TPK: -38.1 dBFS
[Parsed_ebur128_0 @ 0xffff98003b50] Summary:

  Integrated loudness:
    I:         -41.8 LUFS
    Threshold: -51.8 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -61.8 LUFS
    LRA low:   -61.8 LUFS
    LRA high:  -41.8 LUFS

  True peak:
    Peak:      -38.1 dBFS
[out#0/null @ 0xaaaad612a3a0] video:0KiB audio:258KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
"""

SILENCE_STDERR = """\
[Parsed_ebur128_0 @ 0xffff94003ac0] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
[out#0/null @ 0xaaaafa02eec0] video:0KiB audio:517KiB
"""


# --- filter chain ---------------------------------------------------------

def test_filters_none_when_empty():
    assert build_export_filters(False, "off", None) is None


def test_filters_rumble_and_light_declick():
    assert build_export_filters(True, "light", None) == "highpass=f=15,adeclick=t=2.5:b=3:w=30"


def test_filters_gain_only():
    assert build_export_filters(False, "off", 3.2) == "volume=3.200dB"
    assert build_export_filters(False, "off", -4.5) == "volume=-4.500dB"


def test_filters_restore_then_gain():
    assert build_export_filters(True, "light", 3.2) == "highpass=f=15,adeclick=t=2.5:b=3:w=30,volume=3.200dB"


def test_filters_zero_gain_still_emitted_and_no_loudnorm():
    assert "volume=0.000dB" in build_export_filters(True, "light", 0.0)
    for rumble in (True, False):
        for declick in ("off", "light", "medium", "strong"):
            for gain in (None, 2.0):
                assert "loudnorm" not in (build_export_filters(rumble, declick, gain) or "")


# --- ebur128 parsing --------------------------------------------------------

def test_parse_tone_summary():
    assert parse_ebur128_summary(TONE_STDERR) == Loudness(-41.8, -38.1)


def test_parse_ignores_frame_lines_before_summary():
    # The per-frame line has "I: -41.8 LUFS" too; a summary with different
    # numbers must win.
    text = TONE_STDERR.replace("-41.8 LUFS\n    Threshold", "-20.5 LUFS\n    Threshold")
    assert parse_ebur128_summary(text).integrated == -20.5


def test_parse_silence_returns_none():
    assert parse_ebur128_summary(SILENCE_STDERR) is None


def test_parse_minus_inf_integrated_returns_none():
    text = TONE_STDERR.replace("-41.8 LUFS\n    Threshold", "-inf LUFS\n    Threshold")
    assert parse_ebur128_summary(text) is None


@pytest.mark.parametrize("text", ["", None, "no summary here", "Summary:\n garbage"])
def test_parse_garbage_returns_none(text):
    assert parse_ebur128_summary(text) is None


# --- album gain ---------------------------------------------------------------

def test_album_gain_target_binds():
    # quiet album: -24 LUFS, peak -20 dBTP -> +10 dB to reach -14 (cap would allow +19)
    assert album_gain_db(Loudness(-24.0, -20.0)) == pytest.approx(10.0)


def test_album_gain_peak_cap_binds():
    # -24 LUFS but peak already -3 dBTP: target wants +10, ceiling allows +2
    assert album_gain_db(Loudness(-24.0, -3.0)) == pytest.approx(2.0)


def test_album_gain_negative_for_loud_album():
    assert album_gain_db(Loudness(-8.0, -0.5)) == pytest.approx(-6.0)


def test_album_gain_negative_when_peak_over_ceiling():
    # target says +1 but true peak is above the ceiling -> cut
    assert album_gain_db(Loudness(-15.0, 0.5)) == pytest.approx(-1.5)


def test_album_gain_none_passthrough():
    assert album_gain_db(None) is None


# --- ReplayGain formatting ----------------------------------------------------

def test_replaygain_gain_math_and_format():
    assert format_replaygain_gain(replaygain_gain_db(Loudness(-23.0, -5.0))) == "+5.00 dB"
    assert format_replaygain_gain(replaygain_gain_db(Loudness(-12.5, -1.0))) == "-5.50 dB"
    assert format_replaygain_gain(0.0) == "+0.00 dB"


def test_replaygain_peak_format():
    assert format_replaygain_peak(0.0) == "1.000000"
    assert format_replaygain_peak(-6.0206) == "0.500000"
    assert format_replaygain_peak(-38.1) == "0.012445"
