"""Discogs side hints reach guided placement; no Discogs calls are needed."""
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient

import backend.api as api


@pytest.fixture
def recording(tmp_path, monkeypatch):
    sid = str(uuid.uuid4())
    source = tmp_path / 'album.wav'
    source.touch()
    api.session_store.create(session_id=sid, source_audio=source, source_filename='album.wav',
                             source_duration=466, source_size=0)
    envelope = np.full(46600, -12.)
    for start, end in [(100, 103), (203, 263), (363, 366)]:
        envelope[start * 100:end * 100] = -90

    async def cached_envelope(session):
        return envelope

    monkeypatch.setattr(api, 'get_envelope', cached_envelope)
    yield sid
    api.session_store.remove(sid)


def test_guided_endpoint_uses_side_hint_for_guides_and_cuts(recording):
    response = TestClient(api.app).post('/api/analyze-guided', json={
        'file_id': recording, 'expected_tracks': 4, 'durations': [100] * 4, 'side_breaks': [2],
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert [b['expected'] for b in body['boundaries']] == pytest.approx([101.5, 233, 364.5])
    assert body['tracks'][1]['end'] == pytest.approx(203)
    assert body['tracks'][2]['start'] == pytest.approx(263)


@pytest.mark.parametrize('breaks', [[0], [4], [2, 2], [3, 1]])
def test_invalid_side_hints_are_rejected(recording, breaks):
    response = TestClient(api.app).post('/api/analyze-guided', json={
        'file_id': recording, 'expected_tracks': 4, 'durations': [100] * 4, 'side_breaks': breaks,
    })
    assert response.status_code == 422
