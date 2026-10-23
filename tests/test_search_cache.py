"""MetadataHandler.search_basic / release cache and the shared serializer."""

from __future__ import annotations

import pytest
from discogs_client.exceptions import HTTPError
from fastapi.testclient import TestClient

import backend.api as api
from backend.api import _serialize_release
from metadata_handler import DiscogsRelease, MetadataHandler


class StrictResult:
    """Search hit that only exposes ``.data`` -- anything else would trigger
    a lazy per-release fetch in discogs_client, so it must never be touched."""

    def __init__(self, data):
        object.__setattr__(self, "data", data)

    def __getattr__(self, name):
        raise AssertionError(f"touched .{name} on a search result (lazy fetch)")


def _hit(i, **over):
    data = {
        "id": i,
        "type": "release",
        "title": f"Artist {i} - Album {i}",
        "year": "1999",
        "label": [f"Label {i}", "Other"],
        "format": ["Vinyl", "LP", "Album"],
        "country": "UK",
        "thumb": f"https://img/thumb{i}.jpg",
        "cover_image": f"https://img/cover{i}.jpg",
        "uri": f"/release/{i}-slug",
        "master_id": 500 + i,
        "resource_url": f"https://api.discogs.com/releases/{i}",
    }
    data.update(over)
    return StrictResult(data)


class FakePages:
    """discogs_client's paginated search list: lazy until ``page()``, which is one
    request using the list's ``per_page`` (50 unless the caller sets it); a page
    past the end is a 404, as Discogs answers."""

    def __init__(self, client):
        self.client = client
        self.per_page = 50

    def page(self, index):
        self.client.page_calls.append((index, self.per_page))
        start = (index - 1) * self.per_page
        if index > 1 and start >= len(self.client.hits):
            raise HTTPError("Page not found", 404)
        return self.client.hits[start:start + self.per_page]


class FakeClient:
    def __init__(self, hits=(), releases=None):
        self.hits = list(hits)
        self.search_calls = []
        self.page_calls = []
        self.release_calls = []
        self.releases = releases or {}

    def search(self, query, **kw):
        self.search_calls.append((query, kw))
        return FakePages(self)

    def release(self, rid):
        self.release_calls.append(rid)
        return self.releases[rid]


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _raw_release(rid):
    return _Obj(
        id=rid,
        title=f"Album {rid}",
        year=2001,
        artists=[_Obj(name="Someone")],
        labels=[_Obj(name="Lab")],
        formats=[{"name": "Vinyl"}],
        images=[{"uri": "https://img/full.jpg"}],
        tracklist=[
            _Obj(position="A1", title="One", duration="3:00"),
            _Obj(position="B1", title="Two", duration=""),
        ],
    )


def make(client):
    h = MetadataHandler.__new__(MetadataHandler)
    h.client = client
    h.min_request_interval = 0
    h.last_request_time = 0
    import threading
    from collections import OrderedDict

    h._rate_limit_lock = threading.Lock()
    h._release_cache = OrderedDict()
    h._release_cache_lock = threading.Lock()
    return h


def test_search_basic_uses_only_data_and_one_request():
    client = FakeClient([_hit(1), _hit(2), _hit(3)])
    h = make(client)
    out = h.search_basic("q", 2)
    assert len(client.search_calls) == 1
    assert client.page_calls == [(1, 2)], "one request, page size set on the list"
    assert client.release_calls == []
    assert [r["id"] for r in out] == [1, 2]
    r = out[0]
    assert r == {
        "id": 1,
        "artist": "Artist 1",
        "title": "Album 1",
        "year": "1999",
        "label": "Label 1",
        "format": "Vinyl",
        "country": "UK",
        "cover_url": "https://img/cover1.jpg",
        "uri": "/release/1",
        "master_id": 501,
    }


def test_search_basic_fallbacks():
    h = make(FakeClient([
        _hit(1, title="Just A Title", cover_image="", label=[], format=None, master_id=0),
        _hit(2, title="A - B - C", cover_image=None),
    ]))
    a, b = h.search_basic("q", 5)
    assert (a["artist"], a["title"]) == ("Unknown Artist", "Just A Title")
    assert a["cover_url"] == "https://img/thumb1.jpg"
    assert a["label"] == "" and a["format"] == "" and a["master_id"] is None
    assert (b["artist"], b["title"]) == ("A", "B - C")
    assert b["cover_url"] == "https://img/thumb2.jpg"


def test_search_page_size_is_not_sent_as_a_search_field():
    # The library appends its own per_page to every page URL, so a per_page search
    # field would send Discogs two page sizes and later pages would start at 51.
    client = FakeClient([_hit(i) for i in range(1, 30)])
    make(client).search_basic("q", 12)
    assert "per_page" not in client.search_calls[0][1]
    assert client.page_calls == [(1, 12)]


def test_search_later_page_is_one_request_for_the_next_results():
    client = FakeClient([_hit(i) for i in range(1, 30)])
    out = make(client).search_basic("q", 12, page=2)
    assert [r["id"] for r in out] == list(range(13, 25))
    assert client.page_calls == [(2, 12)]


def test_search_past_the_last_page_is_empty():
    client = FakeClient([_hit(i) for i in range(1, 13)])
    assert make(client).search_basic("q", 12, page=2) == []


def _search_endpoint(monkeypatch, found):
    calls = []

    class Handler:
        def search_basic(self, query, max_results=5, page=1):
            calls.append((query, max_results, page))
            return [{"id": page * 100 + i} for i in range(found)]

    monkeypatch.setattr(api, "metadata_handler", Handler())
    return calls


@pytest.mark.parametrize("page, found, has_more", [
    (1, 12, True), (2, 12, True),
    (api.SEARCH_MAX_PAGES, 12, False),   # the last page we fetch, even when Discogs has more
    (1, 7, False),                       # a short page is Discogs' last
])
def test_search_endpoint_pages(monkeypatch, page, found, has_more):
    calls = _search_endpoint(monkeypatch, found)
    with TestClient(api.app) as client:
        response = client.post("/api/search", json={"query": "q", "max_results": 12, "page": page})
    assert response.status_code == 200
    assert calls == [("q", 12, page)]
    body = response.json()
    assert len(body["results"]) == found and body["has_more"] is has_more


def test_search_endpoint_refuses_pages_beyond_the_limit(monkeypatch):
    calls = _search_endpoint(monkeypatch, 12)
    with TestClient(api.app) as client:
        for page in (0, api.SEARCH_MAX_PAGES + 1):
            response = client.post("/api/search", json={"query": "q", "max_results": 12, "page": page})
            assert response.status_code == 422
    assert calls == [], "never reaches Discogs"


def test_release_cache_hit_and_bound():
    client = FakeClient(releases={i: _raw_release(i) for i in range(1, 200)})
    h = make(client)
    first = h.get_release_by_id(1)
    assert h.get_release_by_id(1) is first
    assert client.release_calls == [1]

    for i in range(2, 2 + MetadataHandler.RELEASE_CACHE_SIZE + 5):
        h.get_release_by_id(i)
    assert len(h._release_cache) == MetadataHandler.RELEASE_CACHE_SIZE
    assert 1 not in h._release_cache  # oldest evicted
    h.get_release_by_id(1)
    assert client.release_calls.count(1) == 2


def test_failed_fetch_not_cached():
    h = make(FakeClient(releases={}))
    assert h.get_release_by_id(9) is None
    assert len(h._release_cache) == 0


def test_serialize_release_shape():
    rel = DiscogsRelease(_raw_release(7))
    assert _serialize_release(rel) == {
        "id": 7,
        "artist": "Someone",
        "title": "Album 7",
        "year": 2001,
        "label": "Lab",
        "format": "Vinyl",
        "cover_url": "https://img/full.jpg",
        "uri": "/release/7",
        "tracks": [
            {"position": "A1", "title": "One", "duration": "3:00"},
            {"position": "B1", "title": "Two", "duration": ""},
        ],
    }
