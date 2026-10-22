"""Plan 07 slice 4: hum removal + hiss reduction wired through chain, settings, API, pipeline,
the A/B test ("Removed" includes them) and GET /api/hum.  Real ffmpeg, offline."""

import asyncio
import itertools
import json
import os
import shutil
import subprocess
import sys
import uuid
import wave

import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

import backend.api as api  # noqa: E402
import silence_analysis as sa  # noqa: E402
from audio_processor import (  # noqa: E402
    DECLICK_LEVELS, DECLICK_PRESETS, DITHER_TO_16, HISS_LEVELS, HISS_PRESETS, HUM_FREQS,
    AudioProcessor, NoiseProfile, build_export_filters, hiss_filter, hum_filter,
    split_export_filters,
)
from backend.api import app, session_store  # noqa: E402
from backend.sessions import OutputSpec, SessionStore, pipeline  # noqa: E402
from config import Config  # noqa: E402
from hum_measure import _band_amp  # noqa: E402
from side_synth import SR, make_side  # noqa: E402
from track_boundaries import Track  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
client = TestClient(app)

PROFILE = NoiseProfile(-58.0, tuple(-58.0 - i for i in range(15)))
RUMBLE = "highpass=f=15"


# --- chain builder (pure) -----------------------------------------------------------------

def _marker_positions(chain, noise):
    pos = {}
    for name, text in (("rumble", RUMBLE), ("hum", "bandreject="), ("declick", "adeclick="),
                       ("hiss", "afftdn="), ("volume", "volume="), ("dither", DITHER_TO_16)):
        i = chain.find(text)
        if i >= 0:
            pos[name] = i
    return pos


# Representative toggle combinations (the full cross-product, 384 cases, only multiplied the same
# code path): all off, every toggle on alone (each hum frequency, declick and hiss level), every
# pair of toggles (chain order is a property of each pair), and the full chain with each hum
# frequency, with and without the trailing dither.
_TOGGLES = dict(rumble=True, hum=60, declick="medium", hiss="medium", gain=-2.5)
_OFF = dict(rumble=False, hum=0, declick="off", hiss="off", gain=None)


def _combo(**on):
    return {**_OFF, **on}


COMBOS = (
    [_combo()]
    + [_combo(rumble=True), _combo(hum=50), _combo(hum=60), _combo(gain=-2.5)]
    + [_combo(declick=lv) for lv in DECLICK_LEVELS if lv != "off"]
    + [_combo(hiss=lv) for lv in HISS_LEVELS if lv != "off"]
    + [_combo(**{a: _TOGGLES[a], b: _TOGGLES[b]}) for a, b in itertools.combinations(_TOGGLES, 2)]
    + [_combo(**{**_TOGGLES, "hum": h}) for h in HUM_FREQS]
)


@pytest.mark.parametrize("dither", (False, True))
@pytest.mark.parametrize("combo", COMBOS, ids=lambda c: "+".join(
    k if k in ("rumble", "gain") else f"{k}={v}" for k, v in c.items() if v not in (False, 0, "off", None)) or "off")
def test_toggle_combinations_keep_the_chain_order(combo, dither):
    rumble, hum, declick, hiss, gain = (combo[k] for k in ("rumble", "hum", "declick", "hiss", "gain"))
    chain = build_export_filters(rumble, declick, gain, dither, hum=hum, hiss=hiss, noise=PROFILE)
    on = [n for n, f in (("rumble", rumble), ("hum", hum), ("declick", declick != "off"),
                         ("hiss", hiss != "off"), ("volume", gain is not None)) if f]
    if not on:
        assert chain is None                  # a dither alone is never a chain
        return
    pos = _marker_positions(chain, PROFILE)
    expected = on + (["dither"] if dither else [])
    assert [n for n, _ in sorted(pos.items(), key=lambda kv: kv[1])] == expected
    if hum:
        assert chain.count("bandreject=") == 6 and f"bandreject=f={hum}:" in chain
    if hiss != "off":
        assert f"afftdn=nr={HISS_PRESETS[hiss]}:" in chain
    if declick != "off":
        assert DECLICK_PRESETS[declick] in chain


def test_declick_runs_before_denoise_and_hum_before_declick():
    chain = build_export_filters(True, "medium", None, False, hum=60, hiss="light", noise=PROFILE)
    assert chain.index("highpass") < chain.index("bandreject") < chain.index("adeclick") < chain.index("afftdn")


def test_split_keeps_dither_apart_from_the_main_chain():
    main, dither = split_export_filters(False, "off", None, True, hum=60, hiss="medium", noise=PROFILE)
    assert dither == DITHER_TO_16 and DITHER_TO_16 not in main


def test_hum_filter_notches():
    for f0 in HUM_FREQS:
        chain = hum_filter(f0)
        freqs = [float(p.split("f=")[1].split(":")[0]) for p in chain.split(",") if p.startswith("bandreject")]
        assert freqs == [f0 * k for k in range(1, 7)]
        assert chain.count("width_type=q:w=20") == 6
        assert chain.startswith("aformat=sample_fmts=dblp,")         # double precision for 16-bit sources
        assert "areverse" not in chain
        zp = hum_filter(f0, zero_phase=True)                         # forward + backward, for the Removed render
        assert zp.count("bandreject=") == 12 and zp.count("areverse") == 2
        assert zp.startswith(chain) and zp.endswith("areverse")
    for bad in (0, 55, 100):
        with pytest.raises(ValueError):
            hum_filter(bad)
    with pytest.raises(ValueError):
        build_export_filters(False, "off", None, False, hiss="max")
    with pytest.raises(ValueError):
        build_export_filters(False, "off", None, False, hum=55)


def test_zero_phase_flag_only_changes_the_hum_part():
    kw = dict(rumble=True, declick="light", gain_db=None, hum=60, hiss="light", noise=PROFILE)
    plain = build_export_filters(**kw)
    zp = build_export_filters(**kw, zero_phase_hum=True)
    assert plain != zp and zp.count("areverse") == 2 and "areverse" not in plain
    assert plain.replace(hum_filter(60), "@") == zp.replace(hum_filter(60, True), "@")
    assert build_export_filters(False, hum=0, zero_phase_hum=True) is None


def test_noise_profile_changes_the_chain_string_so_caches_follow_it():
    other = NoiseProfile(-48.0, PROFILE.bands_dbfs)
    a = build_export_filters(False, hiss="medium", noise=PROFILE)
    b = build_export_filters(False, hiss="medium", noise=other)
    c = build_export_filters(False, hiss="medium", noise=None)
    assert len({a, b, c}) == 3
    assert api.hiss_filter_key("medium", PROFILE) != api.hiss_filter_key("medium", other)
    assert api.hiss_filter_key("off", PROFILE) == ""


def test_afftdn_band_offsets_are_clamped():
    extreme = NoiseProfile(-60.0, tuple([-120.0] * 7 + [10.0] * 8))
    bn = hiss_filter("light", extreme).split("bn=")[1].split("|")
    assert len(bn) == 15 and min(map(float, bn)) == -24.0 and max(map(float, bn)) == 24.0
    quiet = NoiseProfile(-120.0, tuple([-120.0] * 15))
    assert "nf=-80.0" in hiss_filter("light", quiet)


# --- config ---------------------------------------------------------------------------------

@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    cfg = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    monkeypatch.setattr(api, "config", cfg)
    return cfg


def _reload(tmp_path):
    return Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")


def test_defaults_are_off_60hz_light_strength(tmp_config):
    assert (tmp_config.hum_filter, tmp_config.hum_freq) == (False, 60)
    assert (tmp_config.hiss_reduction, tmp_config.hiss_strength) == ("off", "light")
    body = client.get("/api/config").json()
    assert body["hum_filter"] is False and body["hum_freq"] == 60
    assert body["hiss_reduction"] == "off" and body["hiss_strength"] == "light"


def test_put_persists_and_reloads(tmp_config, tmp_path):
    body = client.put("/api/config", json={"hum_filter": True, "hum_freq": 50, "hiss_reduction": "strong"}).json()
    assert (body["hum_filter"], body["hum_freq"], body["hiss_reduction"], body["hiss_strength"]) == (
        True, 50, "strong", "strong")
    saved = json.loads((tmp_path / "settings.json").read_text())
    assert saved["HUM_FILTER"] is True and saved["HUM_FREQ"] == 50
    assert saved["HISS_REDUCTION"] == "strong" and saved["HISS_STRENGTH"] == "strong"
    re = _reload(tmp_path)
    assert (re.hum_filter, re.hum_freq, re.hiss_reduction, re.hiss_strength) == (True, 50, "strong", "strong")


def test_hiss_strength_is_remembered_across_off_and_on(tmp_config, tmp_path):
    client.put("/api/config", json={"hiss_reduction": "medium"})
    body = client.put("/api/config", json={"hiss_reduction": "off"}).json()
    assert body["hiss_reduction"] == "off" and body["hiss_strength"] == "medium"
    re = _reload(tmp_path)
    assert (re.hiss_reduction, re.hiss_strength) == ("off", "medium")
    body = client.put("/api/config", json={"hiss_reduction": "medium"}).json()
    assert body["hiss_reduction"] == "medium"
    # picking a strength while the feature is off remembers it without switching it on
    client.put("/api/config", json={"hiss_reduction": "off"})
    body = client.put("/api/config", json={"hiss_strength": "strong"}).json()
    assert (body["hiss_reduction"], body["hiss_strength"]) == ("off", "strong")


@pytest.mark.parametrize("bad", [
    {"hum_freq": 55}, {"hum_freq": 0}, {"hiss_reduction": "extreme"}, {"hiss_reduction": ""},
    {"hiss_strength": "off"}, {"hiss_strength": "max"},
])
def test_invalid_values_are_400_and_apply_nothing(tmp_config, bad):
    r = client.put("/api/config", json={"hum_filter": True, "output_format": "mp3", **bad})
    assert r.status_code == 400, r.text
    assert tmp_config.hum_filter is False and tmp_config.output_format == "flac"


def test_non_bool_hum_filter_is_422(tmp_config):
    assert client.put("/api/config", json={"hum_filter": "maybe"}).status_code == 422


def test_settings_file_garbage_falls_back_to_defaults(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps(
        {"HUM_FILTER": "yes", "HUM_FREQ": "55", "HISS_REDUCTION": "loud", "HISS_STRENGTH": "off"}))
    cfg = _reload(tmp_path)
    assert (cfg.hum_filter, cfg.hum_freq, cfg.hiss_reduction, cfg.hiss_strength) == (True, 60, "off", "light")
    (tmp_path / "settings.json").write_text(json.dumps({"HUM_FREQ": "fifty"}))
    assert _reload(tmp_path).hum_freq == 60
    (tmp_path / "settings.json").write_text(json.dumps({"HISS_REDUCTION": "medium"}))
    cfg = _reload(tmp_path)
    assert (cfg.hiss_reduction, cfg.hiss_strength) == ("medium", "medium")   # no stored strength: follows the setting


def test_environment_variables(tmp_path, monkeypatch):
    monkeypatch.setenv("HUM_FILTER", "true")
    monkeypatch.setenv("HUM_FREQ", "50")
    monkeypatch.setenv("HISS_REDUCTION", "light")
    cfg = _reload(tmp_path)
    assert (cfg.hum_filter, cfg.hum_freq, cfg.hiss_reduction) == (True, 50, "light")


# --- /api/process request ------------------------------------------------------------------

@pytest.fixture
def captured(monkeypatch):
    seen = []

    async def fake(request):
        seen.append(request)

    # Keep the reservation-release wrapper real; stub only the expensive audio worker.
    monkeypatch.setattr(api, "_process_file_background", fake)
    return seen


@pytest.fixture
def pp_session(tmp_path):
    src = tmp_path / "s.wav"
    src.write_bytes(b"x")
    api.session_store.create(session_id="pp4", source_audio=src, source_filename="s.wav",
                             source_duration=100.0, source_size=1)
    yield "pp4"
    api.session_store.remove("pp4")


def _process(session_id, **kw):
    body = {"file_id": session_id, "release_id": 1, "track_mapping": []}
    body.update(kw)
    req = api.ProcessRequest(**body)

    async def go():
        await api.process_file(req)
        await asyncio.sleep(0)

    asyncio.run(go())
    return req


def test_process_defaults_have_both_off(captured, pp_session):
    req = _process(pp_session)
    assert (req.hum_filter, req.hum_freq, req.hiss_reduction) == (False, 60, "off")


def test_process_accepts_the_new_fields(captured, pp_session):
    req = _process(pp_session, hum_filter=True, hum_freq=50, hiss_reduction="medium")
    assert (req.hum_filter, req.hum_freq, req.hiss_reduction) == (True, 50, "medium")


def test_legacy_hum_freq_field_is_harmless(captured, pp_session):
    """Old clients sent hum_freq (default 50) with no hum_filter: nothing turns on, even for odd values."""
    for legacy in (50, 60, 0, 12345):
        req = _process(pp_session, hum_freq=legacy)
        assert req.hum_filter is False


def test_process_rejects_invalid_values(captured, pp_session):
    for kw in ({"hum_filter": True, "hum_freq": 55}, {"hiss_reduction": "ultra"}):
        with pytest.raises(HTTPException) as e:
            _process(pp_session, **kw)
        assert e.value.status_code == 400


def test_background_job_builds_the_spec(pp_session, monkeypatch, tmp_config):
    specs = []
    monkeypatch.setattr(api.pipeline, "run", lambda session, spec, *a, **k: specs.append(spec))

    async def fake_profile(session):
        return PROFILE

    monkeypatch.setattr(api, "_noise_profile_for", fake_profile)

    def run(**kw):
        body = {"file_id": pp_session, "release_id": 1, "track_mapping": [], **kw}
        asyncio.run(api.process_file_background(api.ProcessRequest(**body)))

    run(hum_filter=True, hum_freq=50, hiss_reduction="strong")
    run(hum_freq=50)                                  # legacy: hum off, frequency ignored
    run()
    on, legacy, off = specs
    assert (on.hum_filter, on.hum_freq, on.hiss_reduction, on.noise_profile) == (True, 50, "strong", PROFILE)
    assert (legacy.hum_filter, legacy.hum_freq, legacy.hiss_reduction, legacy.noise_profile) == (False, 60, "off", None)
    assert off.hiss_reduction == "off" and off.noise_profile is None


# --- pipeline wiring (fake audio) -----------------------------------------------------------

class _Audio:
    def __init__(self):
        self.extract, self.measure = [], []

    def extract_track(self, source, track, output, output_format, **kw):
        output.write_bytes(b"x")
        self.extract.append(kw)

    def measure_ranges(self, source, ranges, rumble, declick, **kw):
        self.measure.append((rumble, declick, kw))
        return None


class _Meta:
    class _Rel:
        id, artist, title, cover_url = 1, "A", "B", None

    def get_release_by_id(self, i):
        return self._Rel()

    def create_album_folder_name(self, r):
        return "A - B"

    def download_cover_art(self, *a):
        return False

    def tag_file(self, *a, **k):
        pass

    def create_track_filename(self, track, release, fmt, job_positions=None):
        return f"{track.vinyl_number}.{fmt}"


class _B:
    def __init__(self, n, a, b):
        self.number, self.start, self.end = n, a, b


def _fake_run(tmp_path, **spec_kw):
    src = tmp_path / "s.wav"
    src.write_bytes(b"x")
    s = SessionStore().create(session_id="fx", source_audio=src, source_filename="s.wav",
                              source_duration=60, source_size=1)
    s.set_boundaries([_B(1, 0, 30), _B(2, 30, 60)])
    s.set_mappings({1: "A1", 2: "A2"})
    audio = _Audio()
    spec = OutputSpec(output_format="flac", output_dir=tmp_path / "out", replaygain=False, **spec_kw)
    pipeline.run(s, spec, 1, audio, _Meta(), lambda e: None)
    return audio


def test_pipeline_passes_hum_hiss_and_profile_to_every_track(tmp_path):
    audio = _fake_run(tmp_path, hum_filter=True, hum_freq=50, hiss_reduction="light", noise_profile=PROFILE)
    assert len(audio.extract) == 2
    for kw in audio.extract:
        assert (kw["hum"], kw["hiss"], kw["noise"]) == (50, "light", PROFILE)


def test_pipeline_defaults_leave_both_off(tmp_path):
    audio = _fake_run(tmp_path)
    for kw in audio.extract:
        assert (kw["hum"], kw["hiss"], kw["noise"]) == (0, "off", None)
    # hum_freq alone (the legacy field) does not switch the notch on
    audio = _fake_run(tmp_path, hum_freq=50)
    assert all(kw["hum"] == 0 for kw in audio.extract)


def test_album_gain_measurement_sees_hum_and_hiss(tmp_path):
    audio = _fake_run(tmp_path, album_gain=True, hum_filter=True, hum_freq=60, hiss_reduction="medium",
                      noise_profile=PROFILE)
    assert audio.measure and audio.measure[0][2] == {"hum": 60, "hiss": "medium", "noise": PROFILE}


# --- real audio: the chain on files ----------------------------------------------------------

def _write_side_wav(path, x, sr=SR):
    pcm = (np.clip(np.stack([x, x * 0.9], 1), -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _decode_mono(path):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<f4").astype(np.float64)


def _decode_stereo(path):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<f4").reshape(-1, 2).astype(np.float64)


@pytest.fixture(scope="module")
def hum_wav(tmp_path_factory):
    p = tmp_path_factory.mktemp("side") / "hum.wav"
    _write_side_wav(p, make_side(hum=60, hum_gain_db=-12, hiss_kind="white"))
    return p


@pytest.fixture(scope="module")
def hum_analysis(hum_wav):
    ap = AudioProcessor()
    return sa.analyze_source(hum_wav, ap.compute_envelope(hum_wav), 0.01, SR)


@needs_ffmpeg
def test_export_removes_the_hum(tmp_path, hum_wav):
    ap = AudioProcessor()
    # a stretch of music (3-9 s), hum runs through it like a real ground loop
    plain, notched = tmp_path / "p.flac", tmp_path / "n.flac"
    assert ap.extract_track(hum_wav, Track(1, 3.5, 8.5), plain, "flac", bit_depth=24)
    assert ap.extract_track(hum_wav, Track(1, 3.5, 8.5), notched, "flac", bit_depth=24, hum=60)
    a, b = _decode_mono(plain), _decode_mono(notched)
    assert len(a) == len(b) == round(8.5 * SR) - round(3.5 * SR)
    for k in (1, 2, 3):
        cut = 20 * np.log10(_band_amp(a, 60 * k, SR) / _band_amp(b, 60 * k, SR))
        assert cut >= 20.0, (k, cut)
    # the 330 Hz music tone survives (it is 8 % from the 360 Hz notch)
    assert abs(20 * np.log10(_band_amp(b, 330, SR) / _band_amp(a, 330, SR))) < 1.0
    assert abs(20 * np.log10(_band_amp(b, 1000, SR) / _band_amp(a, 1000, SR))) < 0.1


@needs_ffmpeg
def test_wrong_frequency_does_not_remove_the_hum(tmp_path, hum_wav):
    ap = AudioProcessor()
    plain, notched = tmp_path / "p.flac", tmp_path / "n.flac"
    ap.extract_track(hum_wav, Track(1, 3.5, 8.5), plain, "flac", bit_depth=24)
    ap.extract_track(hum_wav, Track(1, 3.5, 8.5), notched, "flac", bit_depth=24, hum=50)
    a, b = _decode_mono(plain), _decode_mono(notched)
    assert 20 * np.log10(_band_amp(a, 60, SR) / _band_amp(b, 60, SR)) < 3.0


@needs_ffmpeg
def test_export_reduces_hiss_in_the_silent_stretch(tmp_path, hum_wav, hum_analysis):
    prof = NoiseProfile.from_analysis(hum_analysis["noise"])
    assert prof is not None
    ap = AudioProcessor()
    outs = {}
    for name in ("off", "light", "medium", "strong"):
        out = tmp_path / f"{name}.flac"
        kw = {} if name == "off" else dict(hiss=name, noise=prof)
        assert ap.extract_track(hum_wav, Track(1, 0.5, 2.5), out, "flac", bit_depth=24, **kw)
        x = _decode_mono(out)
        spec = np.abs(np.fft.rfft(x)) ** 2
        f = np.fft.rfftfreq(len(x), 1 / SR)
        outs[name] = 10 * np.log10(spec[(f > 500)].sum())          # hiss band; hum sits below 400 Hz
    red = {k: outs["off"] - v for k, v in outs.items()}
    print("\nexport hiss reduction (dB):", {k: round(v, 1) for k, v in red.items()})
    assert red["light"] == pytest.approx(6, abs=1.5)
    assert red["medium"] == pytest.approx(12, abs=1.5)
    assert red["strong"] == pytest.approx(20, abs=2.0)
    assert red["light"] < red["medium"] < red["strong"]


@pytest.fixture(scope="module")
def tones(tmp_path_factory):
    """12 s stereo, tones far from every notch plus faint white noise."""
    rng = np.random.default_rng(3)
    n = SR * 12
    t = np.arange(n) / SR
    base = 0.2 * np.sin(2 * np.pi * 1000 * t) + 0.1 * np.sin(2 * np.pi * 3000 * t)
    x = np.stack([base + rng.standard_normal(n) * 0.003, 0.8 * base + rng.standard_normal(n) * 0.003], 1)
    p = tmp_path_factory.mktemp("tn") / "tones.wav"
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(p), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return p


OPTS = [
    dict(hum=60), dict(hum=50, rumble=True), dict(hiss="light"), dict(hiss="strong", noise=PROFILE),
    dict(hum=60, hiss="medium", noise=PROFILE, declick="light", rumble=True, gain_db=-2.0),
]


FULL = OPTS[4]
LENGTH_CASES = (
    # each output format once with the full chain (fractional mid-file cut)
    [(fmt, bits, FULL, (4.123456, 8.654321)) for fmt, bits in (("flac", 16), ("flac", 24), ("aiff", 16), ("aiff", 24))]
    # file head / tail cuts clamp the pre/post-roll: a different padding path
    + [("flac", 24, FULL, (0.0, 4.0)), ("flac", 24, FULL, (8.0, 12.0))]
    # each individual option set once
    + [("flac", 24, o, (4.123456, 8.654321)) for o in OPTS[:4]]
)


@needs_ffmpeg
@pytest.mark.parametrize("fmt,bits,opts,span", LENGTH_CASES)
def test_exact_length_with_the_new_filters(tones, tmp_path, fmt, bits, opts, span):
    start, end = span
    out = tmp_path / f"o.{fmt}"
    assert AudioProcessor().extract_track(tones, Track(1, start, end), out, fmt, bit_depth=bits, **opts)
    assert len(_decode_mono(out)) == round(end * SR) - round(start * SR)


@needs_ffmpeg
@pytest.mark.parametrize("opts", OPTS[:4])
def test_alignment_and_edges_match_the_unfiltered_cut(tones, tmp_path, opts):
    """No filter latency (within the 1-2 samples of a notch's phase), and the start-up of the
    notches / denoiser lands in the pre-roll, not in the kept audio."""
    ap = AudioProcessor()
    raw, out = tmp_path / "r.flac", tmp_path / "o.flac"
    ap.extract_track(tones, Track(1, 3.0, 9.0), raw, "flac", bit_depth=24)
    ap.extract_track(tones, Track(1, 3.0, 9.0), out, "flac", bit_depth=24, **opts)
    a, b = _decode_stereo(raw), _decode_stereo(out)
    assert a.shape == b.shape
    lags = {L: float(np.dot(a[1000:-1000, 0], np.roll(b[:, 0], L)[1000:-1000])) for L in range(-6, 7)}
    assert abs(max(lags, key=lags.get)) <= 2
    k = int(0.2 * SR)

    def dev(sl):
        return float(np.sqrt(np.mean((a[sl] - b[sl]) ** 2)))
    mid = slice(len(a) // 2, len(a) // 2 + k)
    floor = max(dev(mid), 2e-4)
    assert dev(slice(0, k)) < 1.5 * floor + 1e-4 and dev(slice(-k, None)) < 1.5 * floor + 1e-4


@needs_ffmpeg
def test_unpadded_notch_would_ring_into_the_kept_audio(tones, tmp_path):
    """Why the filtered cut keeps the 1 s pre-roll: a bare cut through the notch cascade rings."""
    from audio_processor import run_ffmpeg
    chain = build_export_filters(False, hum=60)
    bare = tmp_path / "b.flac"
    run_ffmpeg(["-y", "-ss", "3.0", "-t", "6.0", "-i", str(tones), "-af", chain, "-c:a", "flac",
                "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(bare)], capture_output=True, check=True)
    padded = tmp_path / "p.flac"
    AudioProcessor().extract_track(tones, Track(1, 3.0, 9.0), padded, "flac", bit_depth=24, hum=60)
    raw = tmp_path / "r.flac"
    AudioProcessor().extract_track(tones, Track(1, 3.0, 9.0), raw, "flac", bit_depth=24)
    r, p, b = _decode_stereo(raw), _decode_stereo(padded), _decode_stereo(bare)
    k = int(0.3 * SR)
    dev = lambda x: float(np.sqrt(np.mean((x[:k] - r[:k]) ** 2)))     # noqa: E731
    print(f"\nhead deviation vs raw: bare cut {dev(b):.5f}, padded {dev(p):.5f}")
    assert dev(p) < dev(b) or dev(b) < 2e-4


# --- the A/B test ("Test on one track") and GET /api/hum ------------------------------------

def _make_session(tmp_path, monkeypatch, **side):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    src = tmp_path / "source.wav"
    _write_side_wav(src, make_side(**side))
    sid = str(uuid.uuid4())
    session_store.create(session_id=sid, source_audio=src, source_filename="t.wav",
                         source_duration=21.0, source_size=src.stat().st_size, source_bit_depth=16)
    api.get_session_path(sid).mkdir(parents=True, exist_ok=True)
    return sid


@pytest.fixture
def hum_sid(tmp_path, monkeypatch):
    sid = _make_session(tmp_path, monkeypatch, hum=60, hum_gain_db=-12, hiss_kind="white")
    yield sid
    session_store.remove(sid)


def _ab(sid, **kw):
    body = {"file_id": sid, "start": 0.5, "end": 8.5, "rumble": False, "declick": "off", "album_gain": False}
    body.update(kw)
    return client.post("/api/restoration-test", json=body)


def _fetch(url, tmp_path, name):
    path = tmp_path / name
    path.write_bytes(client.get(url).content)
    return _decode_mono(path)


@needs_ffmpeg
def test_ab_chain_matches_the_export_chain(hum_sid):
    r = _ab(hum_sid, hum_filter=True, hum_freq=60)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["chain"] == build_export_filters(False, "off", None, hum=60)
    assert (body["hum"], body["hiss"]) == (60, "off")
    r = _ab(hum_sid, hum_filter=True, hum_freq=50, hiss_reduction="medium", declick="light", rumble=True)
    body = r.json()
    assert r.status_code == 200, r.text
    assert "afftdn=nr=12:" in body["chain"] and ":nt=c:bn=" in body["chain"]       # profile from this file's gaps
    assert body["chain"].index("bandreject") < body["chain"].index("adeclick") < body["chain"].index("afftdn")
    assert body["hum"] == 50 and body["hiss"] == "medium"


@needs_ffmpeg
def test_ab_without_silence_falls_back_to_the_generic_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    n = SR * 12
    t = np.arange(n) / SR
    src = tmp_path / "nosilence.wav"
    _write_side_wav(src, (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32))
    sid = str(uuid.uuid4())
    session_store.create(session_id=sid, source_audio=src, source_filename="t.wav",
                         source_duration=12.0, source_size=1)
    api.get_session_path(sid).mkdir(parents=True, exist_ok=True)
    try:
        body = _ab(sid, hiss_reduction="strong", start=1.0, end=9.0).json()
        assert "tn=1" in body["chain"] and "nt=c" not in body["chain"]
    finally:
        session_store.remove(sid)


@needs_ffmpeg
def test_ab_validation(hum_sid):
    assert _ab(hum_sid).status_code == 400                                   # nothing on
    assert _ab(hum_sid, hum_filter=True, hum_freq=55).status_code == 400
    assert _ab(hum_sid, hiss_reduction="extreme").status_code == 400
    assert _ab(hum_sid, hum_freq=55).status_code == 400                      # no effect on, still "nothing to test"
    assert _ab(hum_sid, hum_filter=True, hum_freq=60).status_code == 200


@needs_ffmpeg
def test_ab_cache_keys_follow_hum_and_hiss(hum_sid):
    a = _ab(hum_sid, hum_filter=True, hum_freq=60).json()
    again = _ab(hum_sid, hum_filter=True, hum_freq=60).json()
    assert a["cached"] is False and again["cached"] is True
    b = _ab(hum_sid, hum_filter=True, hum_freq=50).json()
    assert b["original_url"] == a["original_url"] and b["processed_url"] != a["processed_url"]
    assert b["removed_url"] != a["removed_url"]
    c = _ab(hum_sid, hum_filter=True, hum_freq=60, hiss_reduction="light").json()
    d = _ab(hum_sid, hum_filter=True, hum_freq=60, hiss_reduction="medium").json()
    assert len({a["processed_url"], c["processed_url"], d["processed_url"]}) == 3
    assert len({a["removed_url"], c["removed_url"], d["removed_url"]}) == 3


@needs_ffmpeg
def test_removed_render_contains_the_hum_when_hum_removal_is_on(hum_sid, tmp_path):
    on = _ab(hum_sid, hum_filter=True, hum_freq=60).json()
    removed = _fetch(on["removed_url"], tmp_path, "removed.flac")
    orig = _fetch(on["original_url"], tmp_path, "orig.flac")
    proc = _fetch(on["processed_url"], tmp_path, "proc.flac")
    # the residual is the hum: its 60 Hz line is as strong as the original's
    expected = _band_amp(orig, 60, SR)
    got = _band_amp(removed, 60, SR)
    print(f"\nremoved@60Hz amplitude {got:.5f} (original {expected:.5f})")
    assert got == pytest.approx(expected, rel=0.15)
    assert 20 * np.log10(_band_amp(orig, 60, SR) / _band_amp(proc, 60, SR)) >= 20.0
    # ...and it is a *residual*, not the song: the 1 kHz music tone is not in it
    assert _band_amp(removed, 1000, SR) < 0.01 * _band_amp(orig, 1000, SR)
    # with hum removal off (rumble only) the residual holds only the 15 Hz high-pass's own
    # (phase) share of the line, a fraction of the hum
    off = _ab(hum_sid, rumble=True).json()
    removed_off = _fetch(off["removed_url"], tmp_path, "removed_off.flac")
    assert _band_amp(removed_off, 60, SR) < 0.5 * got


@needs_ffmpeg
def test_removed_render_contains_the_hiss_that_was_removed(hum_sid, tmp_path):
    body = _ab(hum_sid, hiss_reduction="strong", start=0.5, end=2.9).json()
    removed = _fetch(body["removed_url"], tmp_path, "r.flac")
    orig = _fetch(body["original_url"], tmp_path, "o.flac")
    proc = _fetch(body["processed_url"], tmp_path, "p.flac")

    def band(x):
        s = np.abs(np.fft.rfft(x)) ** 2
        f = np.fft.rfftfreq(len(x), 1 / SR)
        return 10 * np.log10(s[f > 500].sum())
    print(f"\nhiss band: orig {band(orig):.1f}, processed {band(proc):.1f}, removed {band(removed):.1f}")
    assert band(orig) - band(proc) == pytest.approx(20, abs=2.5)
    assert band(removed) == pytest.approx(band(orig), abs=1.0)        # nearly all of the hiss is in the residual
    assert body["removed_peak_dbfs"] is not None


@needs_ffmpeg
def test_ab_album_gain_measures_with_hum_and_hiss(hum_sid, monkeypatch):
    calls = []
    real = api.audio_processor.measure_ranges
    monkeypatch.setattr(api.audio_processor, "measure_ranges",
                        lambda src, ranges, rumble, declick, **kw: calls.append(kw) or real(src, ranges, rumble, declick, **kw))
    body = _ab(hum_sid, hum_filter=True, hum_freq=60, hiss_reduction="light", album_gain=True,
               album_ranges=[[3.5, 8.5], [12.0, 17.0]]).json()
    assert calls and calls[0]["hum"] == 60 and calls[0]["hiss"] == "light" and calls[0]["noise"] is not None
    assert body["gain_db"] is not None
    # same settings: cached; different hum frequency: measured again
    _ab(hum_sid, hum_filter=True, hum_freq=60, hiss_reduction="light", album_gain=True,
        album_ranges=[[3.5, 8.5], [12.0, 17.0]])
    assert len(calls) == 1
    _ab(hum_sid, hum_filter=True, hum_freq=50, hiss_reduction="light", album_gain=True,
        album_ranges=[[3.5, 8.5], [12.0, 17.0]])
    assert len(calls) == 2


@needs_ffmpeg
def test_measure_ranges_with_new_filters_matches_a_single_pass(hum_wav):
    """Per-range padded filtering == one chain over the whole file, cut afterwards (to within the
    start-up of the denoiser / notch, 0.3 LU)."""
    ap = AudioProcessor()
    ranges = [(3.5, 8.5), (12.5, 17.5)]
    for kw in (dict(hum=60), dict(hiss="medium", noise=PROFILE), dict(hum=60, hiss="light", noise=PROFILE)):
        new = ap.measure_ranges(hum_wav, ranges, False, "off", **kw)
        assert new is not None
        chain = build_export_filters(False, "off", None, **kw)
        from audio_processor import _aselect_ranges_filter
        old = ap._measure(["-hide_banner", "-nostats", "-i", str(hum_wav), "-af",
                           chain + "," + _aselect_ranges_filter(ranges) + ",ebur128=peak=true:framelog=quiet"])
        assert new.integrated == pytest.approx(old.integrated, abs=0.3)


# --- GET /api/hum -----------------------------------------------------------------------------

@needs_ffmpeg
def test_hum_endpoint_detects_60hz_in_the_gaps(hum_sid):
    r = client.get(f"/api/hum/{hum_sid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["detected"] == 60 and body["harmonics"][0] == 60
    assert body["level_dbfs"] == pytest.approx(-39.5 - 12, abs=3.0)
    assert body["prominence_db"] > 20 and 0 < body["analyzed_s"] <= 30
    assert body["noise"]["floor_dbfs"] == pytest.approx(-58, abs=3) and len(body["noise"]["band_dbfs"]) == 15
    assert sa.cache_path(api.get_session_path(hum_sid)).exists()


@needs_ffmpeg
def test_hum_endpoint_is_cached(hum_sid, monkeypatch):
    client.get(f"/api/hum/{hum_sid}")
    api._analysis_tasks.pop(hum_sid, None)                 # as after a restart: only the disk cache is left
    monkeypatch.setattr(sa, "decode_ranges", lambda *a, **k: pytest.fail("decoded again"))
    assert client.get(f"/api/hum/{hum_sid}").json()["detected"] == 60


@needs_ffmpeg
@pytest.mark.parametrize("side,expected", [
    (dict(hum=50, hum_gain_db=-12), 50),
    (dict(hum=None), None),
    (dict(hum=None, bass_hz=60.0), None),         # 60 Hz bass in the music, not in the gaps
    (dict(hum=None, bass_hz=50.0), None),
])
def test_hum_endpoint_accuracy(tmp_path, monkeypatch, side, expected):
    sid = _make_session(tmp_path, monkeypatch, **side)
    try:
        body = client.get(f"/api/hum/{sid}").json()
        assert body["detected"] == expected, body
        if expected is None:
            assert body["level_dbfs"] is None and body["harmonics"] == []
    finally:
        session_store.remove(sid)


def test_hum_endpoint_unknown_file_is_404():
    assert client.get("/api/hum/nope").status_code == 404


@needs_ffmpeg
def test_hum_endpoint_error_is_reported(hum_sid, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("decode exploded")
    monkeypatch.setattr(sa, "decode_ranges", boom)
    api._analysis_tasks.pop(hum_sid, None)
    cache = sa.cache_path(api.get_session_path(hum_sid))
    cache.unlink(missing_ok=True)
    r = client.get(f"/api/hum/{hum_sid}")
    assert r.status_code == 500 and "decode exploded" in r.json()["detail"]
    # a failed analysis does not poison later requests, and hiss reduction degrades to the fallback
    body = _ab(hum_sid, hiss_reduction="light").json()
    assert "tn=1" in body["chain"]


# --- the chunked zero-phase "Removed" render -----------------------------------------------------

def test_removed_chunks_tile_the_range_exactly():
    from audio_processor import plan_removed_chunks
    for start, end, sr, chunk in ((0.0, 100.0, 44100, 40.0), (3.123456, 9.87654, 48000, 2.5),
                                  (5.0, 5.5, 44100, 40.0), (0.0, 80.0, 96000, 40.0), (1.0, 41.0, 44100, 40.0)):
        spans = plan_removed_chunks(start, end, sr, chunk)
        edges = [round(a * sr) for a, _ in spans] + [round(spans[-1][1] * sr)]
        assert edges[0] == round(start * sr) and edges[-1] == round(end * sr)
        assert all(round(spans[i][1] * sr) == round(spans[i + 1][0] * sr) for i in range(len(spans) - 1))
        assert all(0 < round(b * sr) - round(a * sr) <= round(chunk * sr) for a, b in spans)
    assert plan_removed_chunks(5.0, 5.0, 44100) == []


@needs_ffmpeg
def test_chunked_render_matches_one_pass_and_keeps_memory_bounded(tmp_path, hum_wav, monkeypatch):
    import audio_processor as ap_mod
    ap = AudioProcessor()
    chain = build_export_filters(False, "off", None, hum=60, zero_phase_hum=True)
    start, end = 3.7, 15.3
    one = tmp_path / "one.flac"
    # reference: the whole range in one go, padded like the chunks (areverse buffers all of it)
    seek_s, read_dur, t0, t1 = ap_mod.padded_window(start, end, 21.0, SR, 3.0)
    args = ["-y", *ap_mod.seek_args(seek_s, read_dur), "-i", str(hum_wav), "-filter_complex",
            ap_mod.removed_graph(chain, 2, (t0, t1)), "-map", "[out]", "-c:a", "flac", "-sample_fmt", "s32",
            "-bits_per_raw_sample", "24", str(one)]
    ap_mod.run_ffmpeg(args, check=True, capture_output=True)
    ref = _decode_stereo(one)

    seen = []
    real = ap_mod.run_ffmpeg
    monkeypatch.setattr(ap_mod, "run_ffmpeg", lambda a, **k: seen.append(list(a)) or real(a, **k))
    out = tmp_path / "chunked.flac"
    ap.render_removed_flac(hum_wav, start, end, chain, 2, out, chunk_s=3.0, context_s=2.0)
    got = _decode_stereo(out)
    assert got.shape == ref.shape and len(got) == round(end * SR) - round(start * SR)
    err = float(np.max(np.abs(got - ref)))
    peak = float(np.max(np.abs(ref)))
    print(f"\nchunked vs one-pass: max abs diff {err:.2e} (residual peak {peak:.2e})")
    assert err < 0.02 * peak
    # every decode reads one chunk + its context only, never the whole range
    reads = [float(a[a.index("-t") + 1]) for a in seen if "-filter_complex" in a]
    assert len(reads) == 4 and max(reads) <= 3.0 + 2 * 2.0 + 1e-6
    assert not list(tmp_path.glob("*.raw"))                       # temp PCM removed


@needs_ffmpeg
def test_chunked_render_failure_leaves_no_files(tmp_path, hum_wav):
    out = tmp_path / "bad.flac"
    with pytest.raises(RuntimeError):
        AudioProcessor().render_removed_flac(hum_wav, 3.0, 6.0, "nosuchfilter=1", 2, out)
    assert list(tmp_path.glob("bad*")) == []


@needs_ffmpeg
def test_ab_removed_for_hum_is_rendered_in_chunks_and_cached(hum_sid, monkeypatch):
    calls = []
    real = api.audio_processor.render_removed_flac
    monkeypatch.setattr(api.audio_processor, "render_removed_flac",
                        lambda *a, **k: calls.append(a) or real(*a, **k))
    first = _ab(hum_sid, hum_filter=True, hum_freq=60).json()
    assert len(calls) == 1 and "areverse" in calls[0][3]
    again = _ab(hum_sid, hum_filter=True, hum_freq=60).json()
    assert len(calls) == 1 and again["cached"] is True and again["removed_url"] == first["removed_url"]
    # without hum or rumble the single-pass graph is used as before
    _ab(hum_sid, declick="light")
    assert len(calls) == 1


@needs_ffmpeg
def test_removed_hum_render_holds_hum_not_music_even_with_other_cleanups(hum_sid, tmp_path):
    body = _ab(hum_sid, hum_filter=True, hum_freq=60, declick="light", hiss_reduction="light",
               start=3.5, end=8.5).json()
    removed = _fetch(body["removed_url"], tmp_path, "r.flac")
    orig = _fetch(body["original_url"], tmp_path, "o.flac")
    mus = _band_amp(orig, 1000, SR)
    assert _band_amp(removed, 60, SR) == pytest.approx(_band_amp(orig, 60, SR), rel=0.2)
    assert _band_amp(removed, 1000, SR) < 0.1 * mus          # a little declick/hiss residue at most
