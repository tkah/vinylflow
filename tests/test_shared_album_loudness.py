"""Shared gain is measured from synthetic audio; Discogs and cover downloads are never used."""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from mutagen.flac import FLAC

from audio_processor import AudioProcessor, run_ffmpeg
from backend.sessions import OutputSpec, SessionStore
from backend.sessions.album import AlbumJob, AlbumMember
from metadata_handler import MetadataHandler


def make_job(tmp_path, gain=True, replaygain=True, rates=(44100, 48000)):
    """Two independent recordings of one release, with an 8 dB intentional level difference."""
    store = SessionStore()
    members = []
    for index, rate in enumerate(rates):
        path = tmp_path / f'disc-{index}.wav'
        result = run_ffmpeg(['-y', '-f', 'lavfi', '-i',
            f'sine=f={440 + index * 220}:d=6:r={rate},volume={-8 * index}dB',
            '-ac', '2', '-c:a', 'pcm_s24le', str(path)], capture_output=True)
        assert result.returncode == 0, result.stderr
        session = store.create(str(index), path, path.name, 6, path.stat().st_size, 24)
        session.set_boundaries([SimpleNamespace(number=1, start=0.0, end=6.0, declick=None)])
        session.set_mappings({1: ['A1', 'C1'][index]})
        spec = OutputSpec('flac', tmp_path / 'output', album_gain=gain, replaygain=replaygain)
        members.append(AlbumMember(session, spec, 99))
    handler = MetadataHandler(discogs_token='', user_agent='')
    handler._release_cache[99] = SimpleNamespace(id=99, artist='Test Artist', title='Double LP',
        year=1990, label='Test', cover_url=None, various_artists=False,
        tracks=[SimpleNamespace(position='A1', title='Loud'), SimpleNamespace(position='C1', title='Quiet')])
    return AlbumJob('test-album', members), handler


def output_paths(job):
    return [member.session.last_run.output_folder / member.session.last_run.output_files[0] for member in job.members]


@pytest.mark.parametrize('output_format', ['flac', 'mp3', 'aiff'])
def test_shared_gain_preserves_relative_levels_and_album_tags(tmp_path, output_format):
    job, handler = make_job(tmp_path)
    job.members = [replace(member, spec=replace(member.spec, output_format=output_format)) for member in job.members]
    audio = AudioProcessor()
    before = [audio.measure_file(member.session.source_audio).integrated for member in job.members]
    job.run(audio, handler)
    assert job.status == 'complete'
    assert all(item['status'] == 'complete' for item in job.view()['files'])
    files = output_paths(job)
    after = [audio.measure_file(path) for path in files]
    assert before[0] - before[1] == pytest.approx(8, abs=.3)
    assert after[0].integrated - after[1].integrated == pytest.approx(8, abs=.3)
    assert after[0].integrated - before[0] == pytest.approx(after[1].integrated - before[1], abs=.2)
    combined = audio.measure_files(files)
    print('shared gain', job.gain_db, 'combined LUFS/peak', combined, 'per-disc LUFS', after)
    assert combined.integrated == pytest.approx(-14, abs=.5)
    assert max(item.true_peak for item in after) <= -1 + .2
    from mutagen import File
    def tag(path, key):
        audio_file = File(path)
        return audio_file[key] if output_format == 'flac' else list(audio_file.tags['TXXX:'+key.upper()].text)
    assert tag(files[0], 'replaygain_album_gain') == tag(files[1], 'replaygain_album_gain')
    assert tag(files[0], 'replaygain_album_peak') == tag(files[1], 'replaygain_album_peak')
    assert tag(files[0], 'replaygain_track_gain') != tag(files[1], 'replaygain_track_gain')
    assert float(tag(files[0], 'replaygain_album_gain')[0].split()[0]) == pytest.approx(-18-combined.integrated, abs=.11)


def test_measurement_failure_skips_gain_for_every_disc(tmp_path, monkeypatch):
    job, handler = make_job(tmp_path, replaygain=False)
    audio = AudioProcessor()
    monkeypatch.setattr(audio, 'measure_sources', lambda sources: None)
    before = [audio.measure_file(member.session.source_audio).integrated for member in job.members]
    job.run(audio, handler)
    after = [audio.measure_file(path).integrated for path in output_paths(job)]
    assert after == pytest.approx(before, abs=.1)
    assert job.gain_db is None
    assert any('gain skipped' in warning.lower() for warning in job.warnings)


def test_partial_failure_continues_but_does_not_claim_complete_album_tags(tmp_path, monkeypatch):
    job, handler = make_job(tmp_path)
    audio = AudioProcessor()
    real_extract = audio.extract_track
    def extract(source, *args, **kwargs):
        if source == job.members[0].session.source_audio:
            raise RuntimeError('Synthetic disk failure')
        return real_extract(source, *args, **kwargs)
    monkeypatch.setattr(audio, 'extract_track', extract)
    job.run(audio, handler)
    states = job.view()['files']
    assert states[0]['status'] == 'error' and states[1]['status'] == 'complete'
    path = output_paths(SimpleNamespace(members=[job.members[1]]))[0]
    tags = FLAC(path)
    assert 'replaygain_track_gain' in tags
    assert 'replaygain_album_gain' not in tags
    assert any('incomplete' in warning.lower() for warning in job.warnings)


def test_gain_and_replaygain_off_stay_off(tmp_path):
    job, handler = make_job(tmp_path, gain=False, replaygain=False)
    job.run(AudioProcessor(), handler)
    assert job.gain_db is None
    assert all('replaygain_album_gain' not in FLAC(path) for path in output_paths(job))


def test_shared_gain_obeys_the_loudest_native_peak(tmp_path):
    import numpy as np
    import wave
    job, handler = make_job(tmp_path, replaygain=False)
    rate = 48000
    indices = np.arange(rate * 6)
    # Sparse strong transients over a quiet tone: peak headroom binds before -14 LUFS.
    amplitude = np.where(indices % rate < 100, .8, .003)
    samples = (amplitude * np.sin(2 * np.pi * 440 * indices / rate) * 32767).astype('<i2')
    with wave.open(str(job.members[0].session.source_audio), 'wb') as output:
        output.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        output.writeframes(np.repeat(samples[:, None], 2, axis=1).tobytes())
    audio = AudioProcessor()
    source_peaks = [audio.measure_file(member.session.source_audio).true_peak for member in job.members]
    job.run(audio, handler)
    measured = [audio.measure_file(path) for path in output_paths(job)]
    print('peak-limited shared gain', job.gain_db, 'native source peaks', source_peaks, 'output', measured)
    assert job.gain_db <= -1 - max(source_peaks) + .1
    assert max(item.true_peak for item in measured) <= -.8
    assert audio.measure_files(output_paths(job)).integrated < -14


def test_shared_measurement_uses_each_recordings_filters_and_per_track_override(tmp_path, monkeypatch):
    job, handler = make_job(tmp_path, replaygain=False)
    first = job.members[0]
    first.session.boundaries[0].declick = 'light'
    job.members[0] = replace(first, spec=replace(first.spec, rumble_filter=True, declick='strong'))
    audio = AudioProcessor()
    sources = []
    extractions = []
    real_measure = audio.measure_sources
    real_extract = audio.extract_track
    def measure(items):
        sources.extend(items)
        return real_measure(items)
    def extract(source, *args, **kwargs):
        extractions.append((source, kwargs))
        return real_extract(source, *args, **kwargs)
    monkeypatch.setattr(audio, 'measure_sources', measure)
    monkeypatch.setattr(audio, 'extract_track', extract)
    job.run(audio, handler)
    assert sources[0].rumble and sources[0].ranges[0][2] == 'light'
    assert not sources[1].rumble and sources[1].ranges[0][2] == 'off'
    assert extractions[0][1]['rumble'] and extractions[0][1]['declick'] == 'light'
    assert not extractions[1][1]['rumble']
    assert extractions[0][1]['gain_db'] == extractions[1][1]['gain_db'] == job.gain_db


def test_shared_replaygain_measurement_failure_keeps_track_tags_and_reports_warning(tmp_path, monkeypatch):
    job, handler = make_job(tmp_path, gain=False)
    audio = AudioProcessor()
    monkeypatch.setattr(audio, 'measure_files', lambda paths: None)
    job.run(audio, handler)
    for path in output_paths(job):
        tags = FLAC(path)
        assert 'replaygain_track_gain' in tags
        assert 'replaygain_album_gain' not in tags
    assert job.warnings and all(item['status'] == 'complete' for item in job.view()['files'])


def test_album_endpoint_finishes_real_worker_and_is_safe_to_poll_after_refresh(tmp_path, monkeypatch):
    import time
    import uuid
    from fastapi.testclient import TestClient
    from backend import api
    job, handler = make_job(tmp_path)
    store = SessionStore()
    for member in job.members:
        source = member.session
        store.create(source.id, source.source_audio, source.source_filename, source.source_duration,
                     source.source_size, source.source_bit_depth)
    uploads = tmp_path / 'uploads'
    uploads.mkdir()
    monkeypatch.setattr(api, 'session_store', store)
    monkeypatch.setattr(api, 'album_jobs', {})
    monkeypatch.setattr(api, 'UPLOAD_DIR', uploads)
    monkeypatch.setattr(api, 'audio_processor', AudioProcessor())
    monkeypatch.setattr(api, 'metadata_handler', handler)
    monkeypatch.setattr(api.config, 'default_output_dir', str(tmp_path / 'api-output'))
    body = {'job_id':str(uuid.uuid4()), 'files':[
        {'file_id':member.session.id, 'release_id':99, 'output_format':'flac', 'album_gain':True,
         'replaygain':True, 'track_boundaries':[{'number':1,'start':0,'end':6,'duration':6}],
         'track_mapping':[{'detected':1,'discogs':['A1','C1'][index]}]}
        for index,member in enumerate(job.members)]}
    with TestClient(api.app) as client:
        response = client.post('/api/process-album', json=body)
        assert response.status_code == 200, response.text
        job_id = response.json()['job_id']
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = client.get('/api/process-album/'+job_id).json()
            if state['status'] == 'complete': break
            time.sleep(.02)
        assert state['status'] == 'complete', state
        assert all(item['status'] == 'complete' for item in state['files']), state
        assert all(not session.export_reserved for session in store.list())
        queue = client.get('/api/queue').json()['uploaded']
        assert all(item['album_job_id'] == job_id and item['status'] == 'completed' for item in queue)
        assert client.post('/api/process-album', json=body).json()['status'] == 'complete'
        files = [session.last_run.output_folder / session.last_run.output_files[0] for session in store.list()]
        assert FLAC(files[0])['replaygain_album_gain'] == FLAC(files[1])['replaygain_album_gain']


def test_reexport_replaces_existing_outputs_on_windows(tmp_path, monkeypatch):
    job, handler = make_job(tmp_path, replaygain=False)
    audio = AudioProcessor()
    job.run(audio, handler)
    real_rename = Path.rename
    def windows_rename(source, target):
        """Windows rename refuses an existing destination; replace is the portable overwrite."""
        if Path(target).exists():
            raise FileExistsError(str(target))
        return real_rename(source, target)
    monkeypatch.setattr(Path, 'rename', windows_rename)
    retry = AlbumJob('reexport', job.members)
    retry.run(audio, handler)
    assert all(item['status'] == 'complete' for item in retry.view()['files']), retry.view()
