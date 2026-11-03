"""Background envelope / silence-analysis tasks: removal cancels them, a failed scan is
retried and reported, and ``scan_complete`` is only sent once ``/api/scan`` is ready.

Endpoint functions are awaited directly inside ``asyncio.run`` (the repo's idiom, no
pytest-asyncio) so background tasks share the request's event loop; ``DELETE
/api/queue`` still runs ``cleanup_session`` in a worker thread, as in production.
The decode is faked with a function that blocks on a ``threading.Event``, so a task
can be caught mid-decode; every test releases it, or the loop's executor shutdown
would wait for the blocked thread forever."""

import asyncio
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta

import numpy as np
import pytest
from fastapi import HTTPException

from backend import api

ENVELOPE = np.full(6000, -15.0, dtype=np.float32)  # 60 s of music at 10 ms frames
ENVELOPE[:100] = ENVELOPE[-100:] = -90.0


class BlockingDecode:
    """Fake ``compute_envelope``: signals ``started``, then waits for ``release``.

    ``fail_first`` makes the first call raise instead (a decode error).  ``write_cache``
    writes envelope.npy before blocking, like the window between the real thread's
    ``os.replace`` and the task finishing."""

    def __init__(self, fail_first=False, block=True, write_cache=None):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.fail_first = fail_first
        self.write_cache = write_cache
        if not block:
            self.release.set()

    def __call__(self, path):
        self.calls += 1
        if self.fail_first and self.calls == 1:
            raise RuntimeError("decode failed")
        if self.write_cache is not None:
            np.save(self.write_cache, ENVELOPE)
        self.started.set()
        assert self.release.wait(10), "test never released the decode"
        return ENVELOPE


@pytest.fixture
def recording(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path)
    for table in ("_envelope_tasks", "_envelope_errors", "_analysis_tasks", "_click_tasks",
                  "_click_progress", "_click_errors", "_click_cancel"):
        monkeypatch.setattr(api, table, {})
    sent = []

    async def broadcast(message):
        sent.append(message)

    monkeypatch.setattr(api, "broadcast_message", broadcast)
    sid = str(uuid.uuid4())
    (tmp_path / sid).mkdir()
    source = tmp_path / sid / "source.wav"
    source.touch()
    api.session_store.create(session_id=sid, source_audio=source, source_filename="side.wav",
                             source_duration=60, source_size=0)
    yield {"id": sid, "source": source, "sent": sent, "dir": tmp_path / sid}
    api.session_store.remove(sid)


def use_decode(monkeypatch, decode):
    monkeypatch.setattr(api.audio_processor, "compute_envelope", decode)
    return decode


async def until(event: threading.Event):
    for _ in range(500):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


async def settle(task):
    """Let a cancel scheduled with call_soon_threadsafe land, and the task finish."""
    await asyncio.wait([task], timeout=2)
    await asyncio.sleep(0.01)  # done callbacks and the broadcasts they schedule


def scan_completes(rec):
    return [m for m in rec["sent"] if m["type"] == "scan_complete" and m["file_id"] == rec["id"]]


# --- A2: removal cancels -------------------------------------------------------------------

def test_delete_mid_decode_cancels_the_scan_and_sends_no_scan_complete(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode())

    async def scenario():
        task = api.start_envelope(recording["id"], recording["source"])
        await until(decode.started)
        try:
            await api.remove_from_queue(recording["id"])
        finally:
            decode.release.set()
        await settle(task)
        return task

    task = asyncio.run(scenario())
    assert task.cancelled()
    assert scan_completes(recording) == []
    assert recording["id"] not in api._envelope_tasks


def test_decode_finishing_during_the_folder_removal_sends_no_scan_complete(recording, monkeypatch):
    # Deleting a large session folder takes a while; a decode that ends meanwhile must not
    # announce a recording that is being removed.  The fake rmtree (in the worker thread, like
    # the real one) lets the decode finish and waits for the task before deleting.
    decode = use_decode(monkeypatch, BlockingDecode())
    real_rmtree = shutil.rmtree
    tasks = {}

    def slow_rmtree(path, *args, **kwargs):
        decode.release.set()
        deadline = time.monotonic() + 2
        while not tasks["task"].done() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)  # done callbacks and the broadcast they schedule
        real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(api.shutil, "rmtree", slow_rmtree)

    async def scenario():
        tasks["task"] = task = api.start_envelope(recording["id"], recording["source"])
        await until(decode.started)
        try:
            await api.remove_from_queue(recording["id"])
        finally:
            decode.release.set()
        await settle(task)

    asyncio.run(scenario())
    assert scan_completes(recording) == []
    assert recording["id"] not in api._envelope_tasks


def test_clear_all_mid_decode_cancels_the_scan(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode())

    async def scenario():
        task = api.start_envelope(recording["id"], recording["source"])
        await until(decode.started)
        try:
            await api.clear_all_temp()
        finally:
            decode.release.set()
        await settle(task)
        return task

    task = asyncio.run(scenario())
    assert task.cancelled()
    assert scan_completes(recording) == []
    assert recording["id"] not in api._envelope_tasks


def test_ttl_reaper_cancels_the_scan(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode())
    api.session_store.get(recording["id"]).updated_at = datetime.now() - timedelta(days=30)

    async def scenario():
        task = api.start_envelope(recording["id"], recording["source"])
        await until(decode.started)
        try:
            api.reap_expired()
        finally:
            decode.release.set()
        await settle(task)
        return task

    task = asyncio.run(scenario())
    assert task.cancelled()
    assert scan_completes(recording) == []


def test_rescan_waiting_on_a_removed_recording_gets_404(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode())

    async def scenario():
        request = asyncio.ensure_future(
            api.rescan_file(api.RescanRequest(file_id=recording["id"], expected_tracks=2)))
        await until(decode.started)
        try:
            await api.remove_from_queue(recording["id"])
        finally:
            decode.release.set()
        with pytest.raises(HTTPException) as err:
            await asyncio.wait_for(request, 5)
        return err.value

    assert asyncio.run(scenario()).status_code == 404


def test_hum_waiting_on_a_removed_recording_gets_404(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode())
    # No ffmpeg: the analysis itself is irrelevant, only how its awaiter ends.
    monkeypatch.setattr(api, "_compute_silence_analysis",
                        lambda *a: {"hum": {"detected": None}, "analyzed_s": 0.0, "noise": None})

    async def scenario():
        request = asyncio.ensure_future(api.get_hum(recording["id"]))
        await until(decode.started)
        try:
            await api.remove_from_queue(recording["id"])
        finally:
            decode.release.set()
        with pytest.raises(HTTPException) as err:
            await asyncio.wait_for(request, 5)
        return err.value

    assert asyncio.run(scenario()).status_code == 404
    assert recording["id"] not in api._analysis_tasks


def test_start_envelope_for_an_unknown_recording_is_404(recording, monkeypatch):
    use_decode(monkeypatch, BlockingDecode(block=False))

    async def scenario():
        with pytest.raises(HTTPException) as err:
            api.start_envelope("no-such-id", recording["source"])
        return err.value

    assert asyncio.run(scenario()).status_code == 404
    assert "no-such-id" not in api._envelope_tasks


def test_removal_cancels_from_the_worker_thread_safely(recording, monkeypatch):
    # asyncio debug mode raises "Non-thread-safe operation" when Task.cancel runs off the
    # loop thread; DELETE /api/queue runs cleanup_session in a worker thread.  A running
    # click scan (cancelled with task.cancel() before this fix) and the envelope both go
    # through the same path.
    decode = use_decode(monkeypatch, BlockingDecode())

    async def scenario():
        envelope = api.start_envelope(recording["id"], recording["source"])
        session = api.session_store.get(recording["id"])
        click_scan = api.start_click_scan(session, "medium")  # waits on the envelope
        await until(decode.started)
        try:
            await api.remove_from_queue(recording["id"])
        finally:
            decode.release.set()
        await settle(envelope)
        await settle(click_scan)
        return envelope, click_scan

    # Own loop rather than asyncio.run(debug=True): an unsafe cancel leaves the task stuck
    # forever, and asyncio.run's final cancel-all would then hang instead of failing.
    loop = asyncio.new_event_loop()
    loop.set_debug(True)
    try:
        envelope, click_scan = loop.run_until_complete(scenario())
    finally:
        loop.close()
    assert envelope.cancelled() and click_scan.cancelled()


# --- A3: failed scans are retried and reported; scan_complete implies ready -----------------

def test_failed_scan_is_retried_and_reported(recording, monkeypatch):
    use_decode(monkeypatch, BlockingDecode(fail_first=True, block=False))

    async def scenario():
        first = api.start_envelope(recording["id"], recording["source"])
        await settle(first)
        failed = await api.get_scan(recording["id"], side_changes=0)
        retry = api._envelope_tasks.get(recording["id"])
        assert retry is not None and retry is not first, "/api/scan must start a new scan"
        await settle(retry)
        return failed, await api.get_scan(recording["id"], side_changes=0)

    failed, ready = asyncio.run(scenario())
    assert failed["ready"] is False and "decode failed" in failed["error"]
    assert ready["ready"] is True and "error" not in ready
    assert len(scan_completes(recording)) == 1
    assert recording["id"] not in api._envelope_errors


def test_scan_complete_is_sent_once_the_scan_is_ready(recording, monkeypatch):
    use_decode(monkeypatch, BlockingDecode(block=False))
    seen = []

    async def broadcast(message):
        if message["type"] == "scan_complete":
            seen.append(await api.get_scan(message["file_id"], side_changes=0))

    monkeypatch.setattr(api, "broadcast_message", broadcast)

    async def scenario():
        await settle(api.start_envelope(recording["id"], recording["source"]))

    asyncio.run(scenario())
    assert len(seen) == 1 and seen[0]["ready"] is True


def test_scan_never_blocks_on_a_running_task_even_when_the_cache_exists(recording, monkeypatch):
    decode = use_decode(monkeypatch, BlockingDecode(write_cache=recording["dir"] / "envelope.npy"))

    async def scenario():
        task = api.start_envelope(recording["id"], recording["source"])
        await until(decode.started)
        try:
            return await asyncio.wait_for(api.get_scan(recording["id"], side_changes=0), 1)
        finally:
            decode.release.set()
            await settle(task)

    assert asyncio.run(scenario()) == {"ready": False}
