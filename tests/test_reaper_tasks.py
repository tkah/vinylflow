"""The TTL reaper forgets an expired recording's background work, like Remove does.

Each per-recording table in backend.api (envelope, silence analysis, click scans) holds
results in memory; entries left behind for reaped recordings were never freed."""

import threading
import uuid
from datetime import datetime, timedelta

import pytest

from backend import api


class RunningTask:
    """Stands in for an unfinished asyncio.Task: records the cancel."""

    def __init__(self):
        self.cancelled = False

    def done(self):
        return False

    def cancel(self):
        self.cancelled = True


@pytest.fixture
def expired(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(api, "get_session_path", lambda file_id, name=None: tmp_path / file_id / (name or ""))
    for table in ("_envelope_tasks", "_analysis_tasks", "_click_tasks", "_click_progress",
                  "_click_errors", "_click_cancel"):
        monkeypatch.setattr(api, table, {})
    sid = str(uuid.uuid4())
    (tmp_path / sid).mkdir()
    source = tmp_path / sid / "source.wav"
    source.touch()
    api.session_store.create(session_id=sid, source_audio=source, source_filename="side.wav",
                             source_duration=60, source_size=0)
    api.session_store.get(sid).updated_at = datetime.now() - timedelta(days=30)
    yield sid
    api.session_store.remove(sid)


def test_reaper_drops_every_task_of_an_expired_recording(expired):
    click_scan, cancel = RunningTask(), threading.Event()
    api._envelope_tasks[expired] = object()
    api._analysis_tasks[expired] = object()
    api._click_tasks[(expired, "medium")] = click_scan
    api._click_progress[(expired, "medium")] = 0.4
    api._click_errors[(expired, "light")] = "boom"
    api._click_cancel[expired] = cancel

    api.reap_expired()

    assert api.session_store.get(expired) is None
    for table in (api._envelope_tasks, api._analysis_tasks, api._click_cancel):
        assert expired not in table
    for table in (api._click_tasks, api._click_progress, api._click_errors):
        assert not [key for key in table if key[0] == expired]
    assert click_scan.cancelled and cancel.is_set()   # a running scan is stopped, as on Remove


def test_reaper_leaves_live_recordings_alone(expired):
    live = str(uuid.uuid4())
    api.session_store.create(session_id=live, source_audio=api.UPLOAD_DIR / "live.wav",
                             source_filename="live.wav", source_duration=60, source_size=0)
    try:
        api._envelope_tasks[live] = object()
        api.reap_expired()
        assert live in api._envelope_tasks
    finally:
        api.session_store.remove(live)
