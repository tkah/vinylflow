"""Plan 07 slice 1: filter-chain builder, presets, settings migration, API compat."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

import backend.api as api
from audio_processor import (
    DECLICK_LEVELS,
    DECLICK_PRESETS,
    DITHER_TO_16,
    build_export_filters,
)
from config import Config

client = TestClient(api.app)


# --- builder ------------------------------------------------------------------

def test_presets_cover_levels_and_light_is_retuned():
    assert DECLICK_LEVELS == ("off", "light", "medium", "strong")
    assert set(DECLICK_PRESETS) == {"light", "medium", "strong"}
    assert DECLICK_PRESETS["light"] == "adeclick=t=2.5:b=3:w=30"
    assert all(v.startswith("adeclick=") for v in DECLICK_PRESETS.values())
    assert len(set(DECLICK_PRESETS.values())) == 3


# Representative set instead of the 48-case cross-product: nothing on (a dither alone is not a
# chain), each toggle alone (every declick level, gain 0.0 and a real gain), every pair, and the
# full chain with each declick level.
_LV = [lv for lv in DECLICK_LEVELS if lv != "off"]
COMBOS = (
    [(False, "off", None, False), (False, "off", None, True), (True, "off", None, False),
     (False, "off", 0.0, False), (False, "off", -3.5, False)]
    + [(False, lv, None, False) for lv in _LV]
    + [(True, "medium", None, False), (True, "off", -3.5, False), (False, "medium", -3.5, False)]
    + [(True, lv, -3.5, True) for lv in _LV] + [(True, "medium", 0.0, True)]
)


@pytest.mark.parametrize("rumble,declick,gain,dither", COMBOS)
def test_every_combination_orders_rumble_declick_volume_dither(rumble, declick, gain, dither):
    expected = []
    if rumble:
        expected.append("highpass=f=15")
    if declick != "off":
        expected.append(DECLICK_PRESETS[declick])
    if gain is not None:
        expected.append(f"volume={gain:.3f}dB")
    if expected and dither:
        expected.append(DITHER_TO_16)
    assert build_export_filters(rumble, declick, gain, dither_to_16=dither) == (
        ",".join(expected) or None
    )


def test_unknown_declick_rejected():
    with pytest.raises(ValueError):
        build_export_filters(False, "brutal", None)


# --- config migration -----------------------------------------------------------

def _cfg(tmp_path, settings):
    sp = tmp_path / "settings.json"
    sp.write_text(json.dumps(settings))
    return Config(env_path=tmp_path / ".env", settings_path=sp)


def test_defaults_off(tmp_path):
    cfg = _cfg(tmp_path, {})
    assert (cfg.rumble_filter, cfg.declick, cfg.restoration_level) == (False, "off", 0)


def test_legacy_level_1_migrates(tmp_path):
    cfg = _cfg(tmp_path, {"RESTORATION_LEVEL": 1})
    assert (cfg.rumble_filter, cfg.declick) == (True, "light")


def test_legacy_level_0_migrates(tmp_path):
    cfg = _cfg(tmp_path, {"RESTORATION_LEVEL": 0})
    assert (cfg.rumble_filter, cfg.declick) == (False, "off")


def test_new_keys_win_over_legacy(tmp_path):
    cfg = _cfg(tmp_path, {"RESTORATION_LEVEL": 1, "RUMBLE_FILTER": False, "DECLICK": "strong"})
    assert (cfg.rumble_filter, cfg.declick) == (False, "strong")


def test_invalid_declick_in_settings_falls_back(tmp_path):
    assert _cfg(tmp_path, {"DECLICK": "brutal"}).declick == "off"
    assert _cfg(tmp_path, {"DECLICK": "brutal", "RESTORATION_LEVEL": 1}).declick == "light"


# --- /api/config ------------------------------------------------------------------

@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    cfg = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    monkeypatch.setattr(api, "config", cfg)
    return cfg


def test_config_put_new_fields_persist(tmp_config, tmp_path):
    r = client.put("/api/config", json={"rumble_filter": True, "declick": "strong"})
    assert r.status_code == 200
    body = r.json()
    assert body["rumble_filter"] is True and body["declick"] == "strong"
    assert body["restoration_level"] == 1
    saved = json.loads((tmp_path / "settings.json").read_text())
    assert saved["RUMBLE_FILTER"] is True and saved["DECLICK"] == "strong"
    reloaded = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    assert (reloaded.rumble_filter, reloaded.declick) == (True, "strong")


def test_config_put_legacy_restoration_level(tmp_config):
    body = client.put("/api/config", json={"restoration_level": 1}).json()
    assert body["rumble_filter"] is True and body["declick"] == "light"
    body = client.put("/api/config", json={"restoration_level": 0}).json()
    assert body["rumble_filter"] is False and body["declick"] == "off"
    assert body["restoration_level"] == 0
    assert client.put("/api/config", json={"restoration_level": 2}).status_code == 400


def test_config_new_fields_override_legacy_in_same_request(tmp_config):
    body = client.put(
        "/api/config", json={"restoration_level": 1, "rumble_filter": False, "declick": "medium"}
    ).json()
    assert body["rumble_filter"] is False and body["declick"] == "medium"


def test_config_rejects_bad_values(tmp_config):
    assert client.put("/api/config", json={"declick": "brutal"}).status_code == 400
    assert client.put("/api/config", json={"rumble_filter": "maybe"}).status_code == 422


# --- /api/process request mapping --------------------------------------------------

@pytest.fixture
def captured(monkeypatch):
    seen = []

    async def fake(request):
        seen.append(request)

    monkeypatch.setattr(api, "process_file_background", fake)
    return seen


@pytest.fixture
def session(tmp_path):
    src = tmp_path / "s.wav"
    src.write_bytes(b"x")
    api.session_store.create(
        session_id="pp", source_audio=src, source_filename="s.wav",
        source_duration=100.0, source_size=1,
    )
    yield "pp"
    api.session_store.remove("pp")


def _process(session_id, **kw):
    """Call the endpoint coroutine directly (the background task is stubbed)."""
    body = {"file_id": session_id, "release_id": 1, "track_mapping": []}
    body.update(kw)
    req = api.ProcessRequest(**body)

    async def go():
        result = await api.process_file(req)
        await asyncio.sleep(0)
        return result

    asyncio.run(go())
    return req


def test_process_new_fields(captured, session):
    req = _process(session, rumble_filter=True, declick="medium")
    assert captured == [req]
    assert (req.rumble_filter, req.declick) == (True, "medium")


def test_process_declick_alone_leaves_rumble_off(captured, session):
    req = _process(session, declick="strong")
    assert (req.rumble_filter, req.declick) == (False, "strong")


def test_process_legacy_restoration_level(captured, session):
    on = _process(session, restoration_level=1)
    assert (on.rumble_filter, on.declick) == (True, "light")
    off = _process(session, restoration_level=0)
    assert (off.rumble_filter, off.declick) == (False, "off")


def test_process_no_fields_means_off(captured, session):
    req = _process(session)
    assert (req.rumble_filter, req.declick) == (False, "off")


def test_process_rejects_invalid(captured, session):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        _process(session, declick="brutal")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        _process(session, restoration_level=5)
    assert captured == []
