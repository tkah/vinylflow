"""MetadataHandler.search_basic / release cache and the shared serializer."""

from __future__ import annotations

import pytest

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


class FakeClient:
    def __init__(self, hits=(), releases=None):
        self.hits = list(hits)
        self.search_calls = []
        self.release_calls = []
        self.releases = releases or {}

    def search(self, query, **kw):
        self.search_calls.append((query, kw))
        return iter(self.hits)

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
