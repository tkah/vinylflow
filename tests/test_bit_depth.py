"""Plan 06 slice 2: output bit depth (parser, settings, upload probe, export)."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient
from mutagen.aiff import AIFF
from mutagen.flac import FLAC

from audio_processor import (
    AudioProcessor,
    Track,
    build_export_filters,
    parse_source_bit_depth,
    run_ffmpeg,
    target_bit_depth,
)
from backend import api
from config import Config


# --- parser -----------------------------------------------------------------

def _line(codec_and_rest):
    return f"  Stream #0:0: Audio: {codec_and_rest}\n"


@pytest.mark.parametrize(
    "stream,expected",
    [
        ("pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, stereo, s16, 1411 kb/s", 16),
        ("pcm_s24le ([1][0][0][0] / 0x0001), 48000 Hz, stereo, s32, 2304 kb/s", 24),
        ("pcm_s32le ([1][0][0][0] / 0x0001), 96000 Hz, stereo, s32, 6144 kb/s", 24),
        ("pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, stereo, flt, 3072 kb/s", 24),
        ("pcm_s16be, 44100 Hz, stereo, s16, 1411 kb/s", 16),
        ("pcm_s24be, 44100 Hz, stereo, s32, 2116 kb/s", 24),
        ("flac, 44100 Hz, stereo, s32 (24 bit)", 24),
        ("flac, 44100 Hz, stereo, s16", 16),
        ("pcm_u8 ([1][0][0][0] / 0x0001), 8000 Hz, mono, u8", 16),
        ("somethingweird, 44100 Hz, stereo", None),
        ("flac, 96000 Hz, stereo, s32 (24 bit)", 24),
        ("aac (LC), 44100 Hz, stereo, fltp, 256 kb/s", 24),
    ],
)
def test_parse_source_bit_depth(stream, expected):
    assert parse_source_bit_depth(_line(stream)) == expected


def test_parse_unknown_or_empty():
    # Unknown -> None, which export treats as 24 so nothing is ever truncated.
    assert parse_source_bit_depth("") is None
    assert parse_source_bit_depth(None) is None
    assert parse_source_bit_depth("Duration: 00:00:03.00, no streams") is None


def test_target_bit_depth():
    assert target_bit_depth("source", 16) == 16
    assert target_bit_depth("source", 24) == 24
    assert target_bit_depth("source", None) == 24
    assert target_bit_depth("24", 16) == 24


def test_dither_only_with_processing():
    assert build_export_filters(False, "off", None, dither_to_16=True) is None
    chain = build_export_filters(True, "light", None, dither_to_16=True)
    assert chain.endswith("aresample=osf=s16:dither_method=triangular")
    assert "dither" not in build_export_filters(True, "light", None)
    # declick alone or rumble alone also counts as processing
    assert "dither" in build_export_filters(False, "strong", None, dither_to_16=True)
    assert "dither" in build_export_filters(True, "off", None, dither_to_16=True)


# --- settings ---------------------------------------------------------------

client = TestClient(api.app)


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    cfg = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    monkeypatch.setattr(api, "config", cfg)
    return cfg


def test_bit_depth_default_persist_validate(tmp_config, tmp_path):
    assert client.get("/api/config").json()["bit_depth"] == "source"
    r = client.put("/api/config", json={"bit_depth": "24"})
    assert r.status_code == 200 and r.json()["bit_depth"] == "24"
    assert json.loads((tmp_path / "settings.json").read_text())["BIT_DEPTH"] == "24"
    reloaded = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    assert reloaded.bit_depth == "24"
    assert client.put("/api/config", json={"bit_depth": "16"}).status_code == 400
    assert client.get("/api/config").json()["bit_depth"] == "24"


def test_invalid_stored_value_falls_back(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({"BIT_DEPTH": "32"}))
    cfg = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    assert cfg.bit_depth == "source"


# --- real ffmpeg ------------------------------------------------------------

def make_audio(path, sample_fmt_codec, seconds=4):
    codec = sample_fmt_codec
    r = run_ffmpeg(
        ["-f", "lavfi", "-i", f"anoisesrc=d={seconds}:c=pink:r=44100:a=0.3:seed=7",
         "-ac", "2", "-c:a", codec, "-y", str(path)],
        capture_output=True,
    )
    assert r.returncode == 0, r.stderr
    return path


def pcm_md5(path, start=None, dur=None, codec="pcm_s32le"):
    """md5 of decoded PCM (s32 container so 16/24-bit compare losslessly)."""
    args = []
    if start is not None:
        args += ["-ss", str(start), "-t", str(dur)]
    args += ["-i", str(path), "-f", "md5", "-c:a", codec, "-"]
    r = run_ffmpeg(args, capture_output=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def export(src, out, fmt, src_depth, setting="source", restore=False, gain=None):
    ap = AudioProcessor()
    track = Track(number=1, start=1.0, end=3.0)
    ok = ap.extract_track(
        src, track, out, fmt,
        rumble=restore,
        declick="light" if restore else "off",
        gain_db=gain,
        bit_depth=target_bit_depth(setting, src_depth),
    )
    assert ok
    return out


def depth_of(path):
    if path.suffix == ".flac":
        return FLAC(str(path)).info.bits_per_sample
    return AIFF(str(path)).info.bits_per_sample


@pytest.fixture
def wav16(tmp_path):
    return make_audio(tmp_path / "s16.wav", "pcm_s16le")


@pytest.fixture
def wav24(tmp_path):
    return make_audio(tmp_path / "s24.wav", "pcm_s24le")


def test_probe_audio(wav16, wav24, tmp_path):
    ap = AudioProcessor()
    d16, b16 = ap.probe_audio(wav16)
    d24, b24 = ap.probe_audio(wav24)
    aif = make_audio(tmp_path / "s24.aiff", "pcm_s24be")
    assert (b16, b24, ap.probe_audio(aif)[1]) == (16, 24, 24)
    assert abs(d16 - 4.0) < 0.1 and abs(d24 - 4.0) < 0.1


def test_16_none_source_is_16_and_bit_exact(wav16, tmp_path):
    out = export(wav16, tmp_path / "o.flac", "flac", 16)
    assert depth_of(out) == 16
    assert pcm_md5(out) == pcm_md5(wav16, 1.0, 2.0)


def test_16_restore_source_is_16(wav16, tmp_path):
    out = export(wav16, tmp_path / "o.flac", "flac", 16, restore=True)
    assert depth_of(out) == 16


def test_16_restore_24_setting_is_24(wav16, tmp_path):
    out = export(wav16, tmp_path / "o.flac", "flac", 16, setting="24", restore=True)
    assert depth_of(out) == 24


def test_24_none_source_is_24(wav24, tmp_path):
    out = export(wav24, tmp_path / "o.flac", "flac", 24)
    assert depth_of(out) == 24
    assert pcm_md5(out) == pcm_md5(wav24, 1.0, 2.0)


def test_24_to_aiff_source_is_24(wav24, tmp_path):
    out = export(wav24, tmp_path / "o.aiff", "aiff", 24)
    assert depth_of(out) == 24
    assert pcm_md5(out) == pcm_md5(wav24, 1.0, 2.0)


def test_16_to_aiff_album_gain_is_16(wav16, tmp_path):
    out = export(wav16, tmp_path / "o.aiff", "aiff", 16, gain=-3.0)
    assert depth_of(out) == 16


def test_16_to_aiff_unprocessed_bit_exact(wav16, tmp_path):
    out = export(wav16, tmp_path / "o.aiff", "aiff", 16)
    assert pcm_md5(out) == pcm_md5(wav16, 1.0, 2.0)


def test_24_src_24bit_flac_with_gain_still_24(wav24, tmp_path):
    out = export(wav24, tmp_path / "o.flac", "flac", 24, gain=-2.0)
    assert depth_of(out) == 24


# --- upload probe -----------------------------------------------------------

def test_upload_records_source_bit_depth(wav24, wav16, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "up")
    monkeypatch.setattr(api, "start_envelope", lambda *a, **k: None)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(api, "preconvert_to_mp3", _noop)
    for path, expected in ((wav24, 24), (wav16, 16)):
        with open(path, "rb") as fh:
            r = client.post("/api/upload", files={"files": (path.name, fh, "audio/wav")})
        assert r.status_code == 200, r.text
        fid = r.json()["files"][0]["id"]
        assert api.session_store.get(fid).source_bit_depth == expected


@pytest.mark.parametrize('requested, expected', [('24', '24'), ('source', 'source'), (None, 'source')])
def test_recovered_export_uses_its_saved_depth(tmp_config, tmp_path, monkeypatch, requested, expected):
    """A recovered workspace can differ from today's server default without changing that default."""
    import asyncio
    from backend.sessions import SessionStore

    store = SessionStore()
    monkeypatch.setattr(api, 'session_store', store)
    source = tmp_path / 'recovered.wav'
    source.write_bytes(b'fake audio; the pipeline is stubbed')
    store.create('depth-recovery', source, source.name, 120, source.stat().st_size)
    specs = []

    def capture_spec(session, spec, *args):
        """Capture the export contract without invoking FFmpeg or Discogs."""
        specs.append(spec)

    monkeypatch.setattr(api.pipeline, 'run', capture_spec)
    request = api.ProcessRequest(file_id='depth-recovery', release_id=7, track_mapping=[], bit_depth=requested)
    asyncio.run(api.process_file_background(request))
    assert specs[0].bit_depth == expected
    assert api.config.bit_depth == 'source'
    invalid = client.post('/api/process', json={
        'file_id': 'depth-recovery', 'release_id': 7, 'track_mapping': [], 'bit_depth': '16'})
    assert invalid.status_code == 400
