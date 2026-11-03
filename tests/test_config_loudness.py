"""Persistence + validation of album_gain / replaygain via /api/config."""

import json

import pytest
from fastapi.testclient import TestClient

from backend import api
from config import Config

client = TestClient(api.app)


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    cfg = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    monkeypatch.setattr(api, "config", cfg)
    return cfg


def test_defaults(tmp_config):
    assert tmp_config.album_gain is False
    assert tmp_config.replaygain is True
    body = client.get("/api/config").json()
    assert body["album_gain"] is False and body["replaygain"] is True


def test_put_get_and_persist(tmp_config, tmp_path):
    r = client.put("/api/config", json={"album_gain": True, "replaygain": False})
    assert r.status_code == 200
    assert r.json()["album_gain"] is True and r.json()["replaygain"] is False
    assert client.get("/api/config").json()["album_gain"] is True
    saved = json.loads((tmp_path / "settings.json").read_text())
    assert saved["ALBUM_GAIN"] is True and saved["REPLAYGAIN"] is False
    reloaded = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    assert reloaded.album_gain is True and reloaded.replaygain is False


def test_independent_of_other_fields(tmp_config):
    client.put("/api/config", json={"album_gain": True})
    client.put("/api/config", json={"declick": "medium"})
    body = client.get("/api/config").json()
    assert body["album_gain"] is True and body["declick"] == "medium"
    assert body["restoration_level"] == 1  # derived legacy view
    assert body["replaygain"] is True


def test_validation_rejects_non_bool(tmp_config):
    assert client.put("/api/config", json={"album_gain": "maybe"}).status_code == 422
    assert client.put("/api/config", json={"replaygain": [1]}).status_code == 422


def test_album_description_defaults_off_and_persists(tmp_config, tmp_path):
    assert tmp_config.album_description is False
    assert client.get("/api/config").json()["album_description"] is False
    assert client.put("/api/config", json={"album_description": True}).json()["album_description"] is True
    assert json.loads((tmp_path / "settings.json").read_text())["ALBUM_DESCRIPTION"] is True
    assert client.get("/api/config").json()["album_description"] is True
    reloaded = Config(env_path=tmp_path / ".env", settings_path=tmp_path / "settings.json")
    assert reloaded.album_description is True
    # Turning it back off must persist too (False is not "absent").
    assert client.put("/api/config", json={"album_description": False}).json()["album_description"] is False
    assert json.loads((tmp_path / "settings.json").read_text())["ALBUM_DESCRIPTION"] is False
