"""``GET /api/release/{id}/description`` and ``_output_spec`` album-description resolution.
Offline: the release cache and the Wikipedia lookup are both fakes."""

import pytest
from fastapi.testclient import TestClient

from album_description import DescriptionResult
from backend import api

client = TestClient(api.app)


class FakeRelease:
    id = 42
    master_id = 7


class FakeDescriptions:
    def __init__(self, result):
        self.result = result
        self.lookups = []

    def lookup(self, release_id, master_id):
        self.lookups.append((release_id, master_id))
        return self.result


class FakeHandler:
    def __init__(self, release, descriptions):
        self.release = release
        self.album_descriptions = descriptions

    def get_release_by_id(self, release_id):
        return self.release


class FakeConfig:
    def __init__(self, enabled):
        self.album_description = enabled


def install(monkeypatch, enabled, result=None, release=FakeRelease()):
    descriptions = FakeDescriptions(result)
    monkeypatch.setattr(api, "metadata_handler", FakeHandler(release, descriptions))
    monkeypatch.setattr(api, "config", FakeConfig(enabled))
    return descriptions


def test_disabled_returns_status_without_lookup(monkeypatch):
    descriptions = install(monkeypatch, False, DescriptionResult("found", "x", "t", "u"))
    assert client.get("/api/release/42/description").json() == {"status": "disabled"}
    assert descriptions.lookups == []


def test_found_none_and_error_shapes(monkeypatch):
    descriptions = install(monkeypatch, True, DescriptionResult("found", "Text", "Title", "https://en.wikipedia.org/wiki/Title"))
    assert client.get("/api/release/42/description").json() == {
        "status": "found", "text": "Text", "title": "Title", "url": "https://en.wikipedia.org/wiki/Title"}
    assert descriptions.lookups == [(42, 7)]
    for status in ("none", "error"):
        descriptions.result = DescriptionResult(status, None, None, None)
        assert client.get("/api/release/42/description").json() == {
            "status": status, "text": None, "title": None, "url": None}


def test_release_without_master_id_looks_up_with_none(monkeypatch):
    class Bare:
        id = 5

    descriptions = install(monkeypatch, True, DescriptionResult("none", None, None, None), release=Bare())
    client.get("/api/release/5/description")
    assert descriptions.lookups == [(5, None)]


def test_unknown_release_is_404(monkeypatch):
    install(monkeypatch, True, DescriptionResult("none", None, None, None), release=None)
    assert client.get("/api/release/42/description").status_code == 404


def process_request(**extra):
    return api.ProcessRequest(file_id="f", release_id=1, track_mapping=[], **extra)


# A request may only turn the lookup off: a request frozen with True (queued export) must not
# contact Wikipedia once the saved setting is off. (Was: True in the request overrode a saved False.)
@pytest.mark.parametrize("config_value,request_value,expected", [
    (True, None, True), (False, None, False), (False, True, False), (True, False, False), (True, True, True)])
def test_output_spec_resolves_album_description(monkeypatch, config_value, request_value, expected):
    monkeypatch.setattr(api.config, "album_description", config_value)
    spec = api._output_spec(process_request(album_description=request_value))
    assert spec.album_description is expected


def test_real_discogs_release_searches_wikidata_by_its_master_id(monkeypatch):
    """A real ``DiscogsRelease`` built from a Discogs payload (not a fake carrying master_id)
    reaches the first Wikidata search as ``haswbstatement:P1954=<master_id>``."""
    import discogs_client
    from album_description import AlbumDescriptions
    from metadata_handler import DiscogsRelease

    data = {"id": 42, "master_id": 7, "title": "Album", "year": 1970, "artists": [{"name": "Artist", "id": 1}],
            "labels": [{"name": "Label", "id": 2}], "tracklist": [{"position": "A1", "title": "One", "duration": "4:00"}],
            "genres": [], "styles": [], "images": [], "extraartists": [], "formats": []}
    raw = discogs_client.Release(discogs_client.Client("VinylFlow-tests"), data)
    release = DiscogsRelease(raw)
    assert release.master_id == 7

    calls = []

    def fake_http_get(url, params=None, headers=None, timeout=None):
        calls.append(params)

        class Reply:
            status_code = 200

            def json(self):
                return {"query": {"search": []}}
        return Reply()

    install(monkeypatch, True, release=release)
    api.metadata_handler.album_descriptions = AlbumDescriptions(http_get=fake_http_get)
    assert client.get("/api/release/42/description").json()["status"] == "none"
    assert calls[0]["srsearch"] == "haswbstatement:P1954=7"


def test_release_without_images_key_does_not_refetch_from_discogs():
    """discogs_client refreshes a Release (one more, unthrottled request) when an attribute's key is
    missing from its payload; ``images`` must come from the raw payload dict instead."""
    import json
    from pathlib import Path

    import discogs_client
    from metadata_handler import DiscogsRelease

    data = json.loads((Path(__file__).parent / "fixtures" / "discogs_release_848848.json").read_text())
    data.pop("images", None)
    raw = discogs_client.Release(discogs_client.Client("VinylFlow-tests"), data)
    refreshes = []
    raw.refresh = lambda *_: refreshes.append(1)

    release = DiscogsRelease(raw)

    assert refreshes == []
    assert release.images == [] and release.cover_url is None
