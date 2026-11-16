"""Album-job validation/reservations with inert audio and a stubbed worker: no network."""
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from backend import api
from backend.sessions import SessionStore


@pytest.fixture
def album_env(tmp_path, monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(api, 'session_store', store)
    monkeypatch.setattr(api, 'album_jobs', {}, raising=False)
    monkeypatch.setattr(api, 'UPLOAD_DIR', tmp_path)
    for index in range(2):
        path = tmp_path / f'{index}.wav'
        path.write_bytes(b'fake source; worker is stubbed')
        store.create(str(index), path, path.name, 60, path.stat().st_size)
    async def idle(job):
        """Leave sources reserved so tests can probe competing mutations deterministically."""
        job.status = 'processing'
    monkeypatch.setattr(api, '_run_album_job', idle, raising=False)
    body = {'job_id': str(uuid.uuid4()), 'files': [
        {'file_id': str(index), 'release_id': 99, 'output_format': 'flac',
         'album_gain': True, 'replaygain': True,
         'track_boundaries': [{'number': 1, 'start': 0, 'end': 60, 'duration': 60}],
         'track_mapping': [{'detected': 1, 'discogs': ['A1', 'C1'][index]}]}
        for index in range(2)]}
    return TestClient(api.app), store, body


def test_album_job_is_idempotent_and_reserves_sources(album_env):
    client, store, body = album_env
    first = client.post('/api/process-album', json=body)
    assert first.status_code == 200, first.text
    again = client.post('/api/process-album', json=body)
    assert again.status_code == 200
    assert first.json()['job_id'] == again.json()['job_id']
    assert len(api.album_jobs) == 1
    assert all(session.export_reserved for session in store.list())
    assert client.post('/api/process', json=body['files'][0]).status_code == 409
    assert client.post('/api/analyze', json={'file_id':'0'}).status_code == 409
    assert client.delete('/api/queue/0').status_code == 409
    assert client.delete('/api/temp/clear-all').status_code == 200
    assert store.get('0') is not None
    for session in store.list(): session.updated_at = datetime.now() - timedelta(days=1)
    assert store.reap_stale(1) == []
    queue = client.get('/api/queue').json()['uploaded']
    assert all(file['album_job_id'] == body['job_id'] and file['status'] == 'processing' for file in queue)
    body['files'][0]['declick'] = 'strong'
    assert client.post('/api/process-album', json=body).status_code == 409


@pytest.mark.parametrize('change', ['release', 'format', 'gain', 'replaygain', 'position', 'range', 'source'])
def test_invalid_album_rejected_before_mutation(album_env, change):
    client, store, body = album_env
    second = body['files'][1]
    if change == 'release': second['release_id'] = 100
    if change == 'format': second['output_format'] = 'mp3'
    if change == 'gain': second['album_gain'] = False
    if change == 'replaygain': second['replaygain'] = False
    if change == 'position': second['track_mapping'][0]['discogs'] = 'A1'
    if change == 'range': second['track_boundaries'][0]['end'] = 61
    if change == 'source': store.get('1').source_audio.unlink()
    response = client.post('/api/process-album', json=body)
    assert response.status_code in (400, 410), response.text
    assert all(not session.export_reserved and session.boundaries == [] for session in store.list())


def test_queue_keeps_terminal_album_errors_and_warnings_for_recovery(album_env):
    client, store, body = album_env
    assert client.post('/api/process-album', json=body).status_code == 200
    job = api.album_jobs[body['job_id']]
    job.status = 'complete'
    job.warnings = ['Shared album ReplayGain skipped: incomplete album.']
    job.files['0'].update(status='error', error='Synthetic failure', message='Synthetic failure')
    queued = {file['id']: file for file in client.get('/api/queue').json()['uploaded']}
    assert queued['0']['error'] == 'Synthetic failure'
    assert queued['0']['album_warnings'] == job.warnings


def test_album_members_must_agree_on_album_description(album_env, monkeypatch):
    # Members are compared by what they resolve to; with the saved setting off, True and False both
    # resolve to off and agree. The setting is on here so the two requests really differ.
    monkeypatch.setattr(api.config, 'album_description', True)
    client, store, body = album_env
    body['files'][0]['album_description'] = True
    body['files'][1]['album_description'] = False
    response = client.post('/api/process-album', json=body)
    assert response.status_code == 400, response.text
    assert 'album description' in response.json()['detail'].lower()
    assert all(not session.export_reserved for session in store.list())


def test_album_member_whose_in_place_source_changed_is_refused_409(album_env):
    """An imported (in place) recording re-recorded under the same name: its boundaries and
    caches describe the old audio, so the group is refused before anything is reserved."""
    client, store, body = album_env
    member = store.get('1')
    member.in_place = True
    member.source_mtime = member.source_audio.stat().st_mtime
    member.source_audio.write_bytes(b'a different, longer re-recording of the same side')
    response = client.post('/api/process-album', json=body)
    assert response.status_code == 409, response.text
    assert 'Import it again' in response.json()['detail']
    assert all(not session.export_reserved and session.boundaries == [] for session in store.list())


@pytest.fixture
def setting_off_request_true(album_env, monkeypatch):
    """The saved setting is off while the requests (frozen earlier in the browser) say true."""
    monkeypatch.setattr(api.config, 'album_description', False)
    client, store, body = album_env
    for item in body['files']:
        item['album_description'] = True
    return client, store, body


def test_album_job_with_the_setting_off_ignores_a_true_request(setting_off_request_true):
    client, _, body = setting_off_request_true
    assert client.post('/api/process-album', json=body).status_code == 200
    job = api.album_jobs[body['job_id']]
    assert [member.spec.album_description for member in job.members] == [False, False]


def test_album_members_that_resolve_the_same_are_not_refused(album_env, monkeypatch):
    """None and True both resolve to "on" with the setting on, so they agree."""
    client, _, body = album_env
    monkeypatch.setattr(api.config, 'album_description', True)
    body['files'][0]['album_description'] = None
    body['files'][1]['album_description'] = True
    assert client.post('/api/process-album', json=body).status_code == 200
    assert [member.spec.album_description for member in api.album_jobs[body['job_id']].members] == [True, True]


def test_album_members_that_resolve_differently_are_refused(album_env, monkeypatch):
    client, _, body = album_env
    monkeypatch.setattr(api.config, 'album_description', True)
    body['files'][0]['album_description'] = None
    body['files'][1]['album_description'] = False
    assert client.post('/api/process-album', json=body).status_code == 400


def test_single_export_with_the_setting_off_ignores_a_true_request(setting_off_request_true, monkeypatch):
    """The real background function runs; only the pipeline it calls in a worker thread is faked."""
    import time
    _, _, body = setting_off_request_true
    specs = []

    def fake_pipeline_run(session, spec, release_id, audio_processor, metadata_handler, on_progress):
        specs.append(spec)
    monkeypatch.setattr(api.pipeline, 'run', fake_pipeline_run)
    with TestClient(api.app) as client:   # one event loop for the whole test, so the task created by the endpoint runs
        assert client.post('/api/process', json=body['files'][0]).status_code == 200
        deadline = time.monotonic() + 3
        while not specs and time.monotonic() < deadline:
            client.get('/api/queue')
            time.sleep(0.05)
    assert [spec.album_description for spec in specs] == [False]
