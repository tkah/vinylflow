"""Round-trip ``MetadataHandler.write_replaygain`` on tiny real files
generated with ffmpeg, read back with Mutagen."""

import subprocess

import pytest
from mutagen import File
from mutagen.aiff import AIFF
from mutagen.flac import FLAC
from mutagen.mp3 import MP3

from audio_processor import run_ffmpeg
from metadata_handler import MetadataHandler

CODECS = {
    "flac": ["-c:a", "flac"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "128k"],
    "aiff": ["-c:a", "pcm_s16be"],
}


def make_file(tmp_path, fmt):
    path = tmp_path / f"t.{fmt}"
    r = run_ffmpeg(
        ["-f", "lavfi", "-i", "sine=f=440:d=1", *CODECS[fmt], "-y", str(path)],
        capture_output=True,
    )
    assert r.returncode == 0, r.stderr
    return path


def read_tags(path, fmt):
    if fmt == "flac":
        a = FLAC(path)
        return {k.upper(): v for k, v in a.tags}
    a = MP3(path) if fmt == "mp3" else AIFF(path)
    return {k[5:]: str(v.text[0]) for k, v in a.tags.items() if k.startswith("TXXX:")}


@pytest.mark.parametrize("fmt", ["flac", "mp3", "aiff"])
def test_write_replaygain_roundtrip(tmp_path, fmt):
    path = make_file(tmp_path, fmt)
    h = MetadataHandler(discogs_token="", user_agent="")
    assert h.write_replaygain(path, fmt, "+1.50 dB", "0.500000", "-2.00 dB", "0.900000")
    tags = read_tags(path, fmt)
    assert tags["REPLAYGAIN_TRACK_GAIN"] == "+1.50 dB"
    assert tags["REPLAYGAIN_TRACK_PEAK"] == "0.500000"
    assert tags["REPLAYGAIN_ALBUM_GAIN"] == "-2.00 dB"
    assert tags["REPLAYGAIN_ALBUM_PEAK"] == "0.900000"


@pytest.mark.parametrize("fmt", ["flac", "mp3", "aiff"])
def test_write_replaygain_preserves_existing_tags_and_skips_none(tmp_path, fmt):
    path = make_file(tmp_path, fmt)
    h = MetadataHandler(discogs_token="", user_agent="")
    if fmt == "flac":
        a = FLAC(path)
        a["TITLE"] = "Keep me"
        a.save()
    assert h.write_replaygain(path, fmt, "+1.50 dB", "0.500000", None, None)
    tags = read_tags(path, fmt)
    assert "REPLAYGAIN_ALBUM_GAIN" not in tags
    assert tags["REPLAYGAIN_TRACK_GAIN"] == "+1.50 dB"
    if fmt == "flac":
        assert FLAC(path)["TITLE"] == ["Keep me"]


def test_write_replaygain_failure_returns_false(tmp_path):
    h = MetadataHandler(discogs_token="", user_agent="")
    assert h.write_replaygain(tmp_path / "missing.flac", "flac", "+1.00 dB", "1.0", None, None) is False
    assert h.write_replaygain(tmp_path / "x.ogg", "ogg", "+1.00 dB", "1.0", None, None) is False
