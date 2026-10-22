"""
VinylFlow - FastAPI Backend

Provides REST API and WebSocket endpoints for automated vinyl record digitization.
Handles file uploads, audio analysis, metadata fetching, and track processing.
Supports WAV and AIFF input, with FLAC, MP3, and AIFF output.
"""

import os
import re
import math
import hashlib
import uuid
import shutil
import threading
from pathlib import Path
from subprocess import CalledProcessError
from typing import List, Optional
import asyncio
import json
from datetime import datetime, timedelta

import logging

from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from backend.security import SameOriginMiddleware
from dataclasses import replace
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

# Import our existing modules
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import Config
from audio_processor import (
    AudioProcessor,
    SUPPORTED_INPUT_EXTENSIONS,
    OUTPUT_FORMATS,
    ENVELOPE_FRAME_S,
    run_ffmpeg,
    build_export_filters,
    hiss_filter,
    removed_graph,
    trim_filter,
    seek_args,
    DECLICK_LEVELS,
    HISS_LEVELS,
    HUM_FREQS,
    LEGACY_RESTORE,
    NoiseProfile,
    album_gain_db,
    Loudness,
)
import click_detection
import import_folder
import silence_analysis
from track_boundaries import (
    boundaries_from_expected_durations,
    guided_by_alignment,
    gaps_from_envelope,
    music_span,
)
from metadata_handler import MetadataHandler
from backend.sessions import (
    OutputSpec,
    ProgressEvent,
    Session,
    SessionState,
    SessionStore,
    pipeline,
)

from backend.sessions.album import AlbumJob, AlbumMember

# Initialize FastAPI app
app = FastAPI(title="VinylFlow API", version="1.0.0")

# The UI is same-origin, so no CORS: `*` let any website drive this local API.
# Reject foreign Host/Origin instead (DNS rebinding, cross-site form posts and WebSockets).
app.add_middleware(SameOriginMiddleware)

# Global state management.  ``session_store`` owns every Session;
# ``websocket_connections`` is the list of subscribers for progress
# broadcasts (orthogonal to per-Session state).  See CONTEXT.md for the
# Session lifecycle.
session_store = SessionStore()
album_jobs: dict[str, AlbumJob] = {}
MAX_ALBUM_RECORDINGS = 500
websocket_connections: List[WebSocket] = []


def _session_status(session: Session) -> str:
    """Map Session.state → the UI status string the frontend expects.

    The frontend distinguishes "uploaded" (READY without boundaries) from
    "analyzed" (READY with boundaries detected) — derive that here so
    the wire format stays unchanged after the dict-level state went away.
    """
    job = album_jobs.get(session.album_job_id)
    if job and session.id in job.files:
        status = job.files[session.id]['status']
        if status == 'error': return 'error'
        if status == 'complete': return 'completed'
        return 'processing'
    if session.state == SessionState.PROCESSING or session.export_reserved:
        return "processing"
    if session.state == SessionState.COMPLETE:
        return "completed"
    if session.state == SessionState.FAILED:
        return "error"
    return "analyzed" if session.boundaries else "uploaded"


def _serialize_uploaded(session: Session) -> dict:
    """Wire shape returned by /api/queue and friends — matches the dict
    shape the frontend used to consume from ``uploaded_files``."""
    album = album_jobs.get(session.album_job_id)
    album_info = {}
    if album and session.id in album.files:
        item = album.files[session.id]
        album_info = {"album_job_id": album.id, "album_job_status": album.status,
                      "album_warnings": list(album.warnings), "error": item.get("error", ""),
                      "progress": item.get("progress", 0), "processingMessage": item.get("message", "")}
    return {
        "id": session.id,
        "filename": session.source_filename,
        "path": str(session.source_audio),
        "in_place": session.in_place,
        "size": session.source_size,
        "duration": session.source_duration,
        "status": _session_status(session),
        **album_info,
    }


def _serialize_job(session: Session) -> dict:
    """Wire shape returned by /api/process and /api/process/{job_id}.

    job_id == session_id post-Step-4: there's no separate per-run
    identifier any more.  Re-running a Session overwrites ``last_run``;
    callers polling the same id keep seeing fresh status.
    """
    album = album_jobs.get(session.album_job_id)
    if album and session.id in album.files:
        item = dict(album.files[session.id])
        item['status'] = item['status'] if item['status'] in ('complete', 'error') else 'processing'
        return {**item, 'job_id': session.id, 'album_job_id': album.id}
    run = session.last_run
    state = session.state
    if state == SessionState.PROCESSING:
        status = "processing"
    elif state == SessionState.COMPLETE:
        status = "complete"
    elif state == SessionState.FAILED:
        status = "error"
    else:
        status = "processing"  # only reached if /api/process called but pipeline not yet started

    out: dict = {
        "job_id": session.id,
        "file_id": session.id,
        "status": status,
        "progress": run.final_fraction if run is not None else 0.0,
        "message": (run.message if run is not None else "Starting processing..."),
    }
    if run is not None:
        if run.output_folder is not None:
            out["output_path"] = str(run.output_folder)
        if run.output_files:
            out["tracks"] = list(run.output_files)
        if run.error:
            out["error"] = run.error
    return out

# Initialize config and handlers
config = Config()
audio_processor = AudioProcessor(
    silence_threshold=config.default_silence_threshold,
    min_silence_duration=config.default_min_silence_duration,
    min_track_length=config.default_min_track_length,
    flac_compression=config.default_flac_compression,
)
metadata_handler = MetadataHandler(config.discogs_token, config.discogs_user_agent)

# Temp directory for uploads.
# In desktop/bundled mode the launcher sets VINYLFLOW_UPLOAD_DIR to a
# writable location inside the user's AppData folder.  Fall back to a path
# relative to the source tree when running in development.
_upload_dir_env = os.getenv("VINYLFLOW_UPLOAD_DIR")
UPLOAD_DIR = Path(_upload_dir_env) if _upload_dir_env else Path(__file__).parent.parent / "temp_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _require_source(session: Session) -> None:
    """410 when an in-place source vanished from the import folder."""
    if session.in_place and not session.source_audio.is_file():
        raise HTTPException(
            status_code=410,
            detail=f"The source file is no longer in the import folder: {session.source_filename}",
        )


def get_session_path(file_id: str, filename: str = None) -> Path:
    """Get path within session directory."""
    session_dir = UPLOAD_DIR / file_id
    return session_dir if filename is None else session_dir / filename


def cleanup_session(file_id: str) -> bool:
    """Drop a Session and its on-disk source folder."""
    session = session_store.get(file_id)
    if session and session.export_reserved:
        return False
    session_dir = get_session_path(file_id)
    try:
        if session_dir.exists():
            shutil.rmtree(session_dir)
        session_store.remove(file_id)
        return True
    except FileNotFoundError:
        session_store.remove(file_id)
        return True
    except Exception as e:
        print(f"Cleanup failed for {file_id}: {e}")
        session_store.remove(file_id)
        return False
    finally:
        _envelope_tasks.pop(file_id, None)
        _analysis_tasks.pop(file_id, None)
        _drop_click_scans(file_id)


def reap_expired() -> None:
    """One TTL pass: drop stale Sessions and orphan folders under UPLOAD_DIR."""
    ttl = config.temp_ttl_hours
    cutoff = datetime.now() - timedelta(hours=ttl)

    # Drop stale Sessions (the store skips PROCESSING entries),
    # then remove their on-disk source folders.
    for sid in session_store.reap_stale(ttl_hours=ttl):
        session_dir = get_session_path(sid)
        if session_dir.exists():
            shutil.rmtree(session_dir, ignore_errors=True)

    # Drop orphan dirs — folders with no live Session that have
    # been on disk past the TTL (e.g. crash-recovery leftovers).
    for entry in UPLOAD_DIR.iterdir():
        if not entry.is_dir():
            continue
        if session_store.get(entry.name) is not None:
            continue
        try:
            if datetime.fromtimestamp(entry.stat().st_mtime) < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except (FileNotFoundError, OSError):
            pass


# Background cleanup task
async def cleanup_old_files():
    """Delete Sessions and source folders older than the configured TTL."""
    while True:
        try:
            reap_expired()

        except Exception as e:
            print(f"Cleanup error: {e}")

        # Run every 30 minutes
        await asyncio.sleep(30 * 60)


@app.on_event("startup")
async def startup_event():
    """Start background tasks on app startup."""
    asyncio.create_task(cleanup_old_files())


# Pydantic models for API requests/responses
class AnalyzeRequest(BaseModel):
    file_id: str


class RescanRequest(BaseModel):
    file_id: str
    expected_tracks: int


class GuidedAnalyzeRequest(BaseModel):
    file_id: str
    expected_tracks: int
    # One entry per expected track; null for tracks Discogs has no length for.
    durations: Optional[List[Optional[float]]] = None
    # Internal track counts before Discogs side transitions (A -> B, B -> C, ...).
    side_breaks: Optional[List[int]] = None


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5


class TrackMapping(BaseModel):
    detected: int
    discogs: str


class TrackBoundary(BaseModel):
    number: int
    start: float
    end: float
    duration: float
    declick: Optional[str] = None  # per-track override; None = the panel setting


CUSTOM_TRACK_POSITION = r"^[A-Z]+\d+(?:[.\-]\d+)?$"  # A1, B12, or a Discogs sub-track like B6.1
MAX_CUSTOM_TRACKS = 99
MAX_CUSTOM_TITLE = 200


class CustomTrack(BaseModel):
    """A track the user added to the release, or a renamed Discogs track (same position)."""
    position: str = Field(pattern=CUSTOM_TRACK_POSITION)
    title: str = Field(max_length=MAX_CUSTOM_TITLE)

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("title must not be blank")
        return value


def _legacy_restore(level: Optional[int]) -> tuple:
    """Map the legacy ``restoration_level`` (0/1) to (rumble, declick)."""
    if level not in (0, 1):
        raise HTTPException(status_code=400, detail="restoration_level must be 0 or 1")
    return LEGACY_RESTORE if level == 1 else (False, "off")


def _check_declick(value: str) -> str:
    if value not in DECLICK_LEVELS:
        raise HTTPException(
            status_code=400, detail="declick must be off, light, medium or strong"
        )
    return value


def _check_hiss(value: str) -> str:
    if value not in HISS_LEVELS:
        raise HTTPException(
            status_code=400, detail="hiss_reduction must be off, light, medium or strong"
        )
    return value


def _check_hum_freq(value) -> int:
    if isinstance(value, bool) or value not in HUM_FREQS:
        raise HTTPException(status_code=400, detail="hum_freq must be 50 or 60")
    return int(value)


class ProcessRequest(BaseModel):
    file_id: str
    release_id: int
    track_mapping: List[TrackMapping]
    reversed: bool = False
    track_boundaries: Optional[List[TrackBoundary]] = None
    output_format: str = "flac"  # 'flac', 'mp3', or 'aiff'
    rumble_filter: Optional[bool] = None  # 15 Hz high-pass
    declick: Optional[str] = None         # off | light | medium | strong
    restoration_level: Optional[int] = None  # legacy: 1 = rumble + light declick
    hum_filter: bool = False     # mains-hum notch
    hum_freq: int = 60           # 50 | 60 Hz (ignored while hum_filter is off, so old clients sending 50 are harmless)
    hiss_reduction: str = "off"  # off | light | medium | strong
    album_gain: bool = False     # one gain for the whole album to -14 LUFS
    replaygain: bool = True      # write ReplayGain 2.0 track + album tags
    bit_depth: Optional[str] = None  # per-workspace depth; omitted uses the server default
    custom_tracks: Optional[List[CustomTrack]] = Field(default=None, max_length=MAX_CUSTOM_TRACKS)  # user-added tracks / renamed Discogs titles


class ConfigUpdate(BaseModel):
    silence_threshold: Optional[float] = None
    min_silence_duration: Optional[float] = None
    min_track_length: Optional[float] = None
    output_dir: Optional[str] = None
    track_numbering: Optional[str] = None
    output_format: Optional[str] = None
    bit_depth: Optional[str] = None
    rumble_filter: Optional[bool] = None
    declick: Optional[str] = None
    restoration_level: Optional[int] = None  # legacy: 1 = rumble + light declick, 0 = both off
    hum_filter: Optional[bool] = None
    hum_freq: Optional[int] = None           # 50 | 60
    hiss_reduction: Optional[str] = None     # off | light | medium | strong
    hiss_strength: Optional[str] = None      # remembered strength (light | medium | strong)
    album_gain: Optional[bool] = None
    replaygain: Optional[bool] = None


class DiscogsSetupRequest(BaseModel):
    token: str
    user_agent: Optional[str] = "VinylFlow/1.0"


# WebSocket broadcast helper
async def broadcast_message(message: dict):
    """Broadcast message to all connected WebSocket clients."""
    disconnected = []
    for ws in websocket_connections:
        try:
            await ws.send_json(message)
        except Exception:
            disconnected.append(ws)

    # Clean up disconnected clients
    for ws in disconnected:
        if ws in websocket_connections:
            websocket_connections.remove(ws)


# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    websocket_connections.append(websocket)

    try:
        await websocket.send_json({"type": "connected", "message": "WebSocket connected"})

        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")

    except WebSocketDisconnect:
        if websocket in websocket_connections:
            websocket_connections.remove(websocket)


# API Routes
@app.get("/")
async def read_root():
    """Serve the main HTML page."""
    html_path = Path(__file__).parent / "static" / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(
        content="<h1>VinylFlow</h1><p>Frontend not found. Please create static/index.html</p>"
    )


@app.get("/api/formats")
async def get_output_formats():
    """Return available output formats for the UI."""
    return {
        "formats": [
            {"id": fmt_id, "label": fmt["label"], "extension": fmt["extension"]}
            for fmt_id, fmt in OUTPUT_FORMATS.items()
        ]
    }


# Energy envelope (per-frame RMS dBFS), computed once per Session in the
# background at upload and cached as envelope.npy in the session dir.  The
# task's result is the array itself, so endpoints just await it instead of
# re-decoding.  file_id -> Task[np.ndarray]
_envelope_tasks: dict = {}


def _load_or_compute_envelope(file_id: str, file_path: Path):
    """Blocking: load envelope.npy if cached, else decode and cache it."""
    import numpy as np

    cache_path = get_session_path(file_id, "envelope.npy")
    if cache_path.exists():
        try:
            return np.load(cache_path)
        except Exception:
            cache_path.unlink(missing_ok=True)  # corrupt cache: recompute

    db = audio_processor.compute_envelope(file_path)

    # Write via a temp file + atomic rename so a reader never sees a
    # half-written cache.  Caching is best-effort (the session dir may have
    # been removed while we were decoding).
    part_path = get_session_path(file_id, f"envelope.{uuid.uuid4().hex[:8]}.part")
    try:
        with open(part_path, "wb") as f:
            np.save(f, db)
        os.replace(part_path, cache_path)
    except OSError:
        part_path.unlink(missing_ok=True)
    return db


async def _run_envelope(file_id: str, file_path: Path):
    db = await asyncio.to_thread(_load_or_compute_envelope, file_id, file_path)
    start, end = music_span(db, ENVELOPE_FRAME_S)
    await broadcast_message(
        {
            "type": "scan_complete",
            "file_id": file_id,
            "music_start": start,
            "music_end": end,
            "music_duration": max(0.0, end - start),
        }
    )
    return db


def start_envelope(file_id: str, file_path: Path) -> "asyncio.Task":
    """Start (or join) the envelope computation for a Session."""
    task = _envelope_tasks.get(file_id)
    if task is None:
        task = asyncio.create_task(_run_envelope(file_id, file_path))
        _envelope_tasks[file_id] = task

        def _done(t: "asyncio.Task") -> None:
            # Failed scans must not poison later requests: drop the task so
            # the next caller retries.
            if t.cancelled() or t.exception() is not None:
                if t.exception() is not None:
                    print(f"Envelope scan failed for {file_id}: {t.exception()}")
                if _envelope_tasks.get(file_id) is t:
                    _envelope_tasks.pop(file_id, None)

        task.add_done_callback(_done)
    return task


async def get_envelope(session: Session):
    """Awaitable accessor: in-flight task -> cache on disk -> compute now."""
    task = start_envelope(session.id, session.source_audio)
    # shield: a cancelled request must not cancel the shared background scan.
    return await asyncio.shield(task)


# --- Silent-stretch analysis (plan 07 slice 4): hum detector + noise profile --------
# One background task per file_id; the result is cached as silence_analysis.json in
# the session dir.  It decodes only the silent stretches (<= ~30 s), so it is cheap.
_analysis_tasks: dict = {}


def _compute_silence_analysis(file_id: str, source: Path, db) -> dict:
    """Blocking: cached result, else analyse the silent stretches and cache it."""
    cache = silence_analysis.cache_path(get_session_path(file_id))
    cached = silence_analysis.read_cache(cache)
    if cached is not None:
        return cached
    _, rate = audio_processor.probe_info(source)
    result = silence_analysis.analyze_source(source, db, ENVELOPE_FRAME_S, int(rate or 44100))
    silence_analysis.write_cache(cache, result)
    return result


async def _run_silence_analysis(session: Session) -> dict:
    db = await get_envelope(session)
    return await asyncio.to_thread(
        _compute_silence_analysis, session.id, session.source_audio, db
    )


async def get_silence_analysis(session: Session) -> dict:
    """Awaitable accessor: in-flight task -> cache on disk -> compute now."""
    task = _analysis_tasks.get(session.id)
    if task is None or (task.done() and (task.cancelled() or task.exception() is not None)):
        task = asyncio.create_task(_run_silence_analysis(session))
        _analysis_tasks[session.id] = task
    # shield: a cancelled request must not cancel the shared analysis.
    return await asyncio.shield(task)


async def _noise_profile_for(session: Session) -> Optional[NoiseProfile]:
    """The file's measured NoiseProfile for hiss reduction, or None (generic
    fallback chain) when the analysis finds no usable silence or fails."""
    try:
        data = await get_silence_analysis(session)
    except Exception as e:
        logger.warning(f"Noise profile unavailable for {session.id}: {e}")
        return None
    return NoiseProfile.from_analysis(data.get("noise"))


@app.get("/api/hum/{file_id}")
async def get_hum(file_id: str):
    """Mains-hum detection (50/60 Hz + harmonics) in the file's silent stretches.

    ``{detected: 50|60|null, level_dbfs, prominence_db, harmonics: [Hz...]}`` plus
    ``analyzed_s`` (audio examined) and ``noise`` (the surface-noise profile that
    hiss reduction uses, or null).  Cached in the session dir.
    """
    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        data = await get_silence_analysis(session)
    except Exception as e:
        logger.error(f"Hum analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Hum analysis failed: {e}")
    return {**data["hum"], "analyzed_s": data.get("analyzed_s", 0.0), "noise": data.get("noise")}


# --- Click scans (plan 07 slice 2) --------------------------------------------
# One background task per (file_id, strength); results cached as
# clicks_<strength>.json in the session dir.  Progress lives in memory.
_click_tasks: dict = {}      # (file_id, strength) -> asyncio.Task
_click_progress: dict = {}   # (file_id, strength) -> 0..1
_click_errors: dict = {}     # (file_id, strength) -> message
_click_cancel: dict = {}     # file_id -> threading.Event


def _drop_click_scans(file_id: str) -> None:
    """Cancel and forget every click scan of a removed Session."""
    event = _click_cancel.pop(file_id, None)
    if event is not None:
        event.set()  # the worker thread checks this between chunks
    for key in [k for k in _click_tasks if k[0] == file_id]:
        task = _click_tasks.pop(key, None)
        if task is not None and not task.done():
            task.cancel()
    for d in (_click_progress, _click_errors):
        for key in [k for k in d if k[0] == file_id]:
            d.pop(key, None)


def _click_cached(file_id: str, strength: str) -> Optional[dict]:
    return click_detection.read_cache(click_detection.cache_path(get_session_path(file_id), strength), strength)


def _click_view(file_id: str, strength: str, requested: str, payload: Optional[dict]) -> dict:
    """Response body shared by POST and GET /api/clicks."""
    key = (file_id, strength)
    base = {"strength": strength, "requested": requested}
    if payload is not None:
        return {**base, "status": "done", "progress": 1.0, "count": payload["count"],
                "times": payload["times"], "music_start": payload.get("music_start"),
                "music_end": payload.get("music_end"), "scanned_at": payload.get("scanned_at")}
    task = _click_tasks.get(key)
    if task is not None and not task.done():
        return {**base, "status": "running", "progress": _click_progress.get(key, 0.0)}
    if key in _click_errors:
        return {**base, "status": "error", "progress": 0.0, "error": _click_errors[key]}
    return {**base, "status": "none", "progress": 0.0}


async def _run_click_scan(file_id: str, session: Session, strength: str) -> None:
    key = (file_id, strength)
    loop = asyncio.get_running_loop()
    cancel = _click_cancel.setdefault(file_id, threading.Event())
    db = await get_envelope(session)
    start, end = music_span(db, ENVELOPE_FRAME_S)
    if end - start <= 0:
        start, end = 0.0, session.source_duration

    def progress(fraction: float) -> None:
        _click_progress[key] = fraction
        asyncio.run_coroutine_threadsafe(
            broadcast_message({"type": "click_scan_progress", "file_id": file_id,
                               "strength": strength, "progress": fraction}),
            loop,
        )

    times = await asyncio.to_thread(
        click_detection.scan_clicks, session.source_audio, start, end, strength,
        session.source_duration, progress, cancel.is_set,
    )
    payload = click_detection.make_payload(strength, start, end, times)
    click_detection.write_cache(click_detection.cache_path(get_session_path(file_id), strength), payload)
    await broadcast_message({"type": "click_scan_complete", "file_id": file_id,
                             "strength": strength, "count": len(times)})


def start_click_scan(session: Session, strength: str) -> "asyncio.Task":
    """Start (or join) the click scan of a Session at ``strength``."""
    key = (session.id, strength)
    task = _click_tasks.get(key)
    if task is None or task.done():
        _click_errors.pop(key, None)
        _click_progress[key] = 0.0
        task = asyncio.create_task(_run_click_scan(session.id, session, strength))
        _click_tasks[key] = task

        def _done(t: "asyncio.Task") -> None:
            if t.cancelled():
                return
            if t.exception() is not None:
                print(f"Click scan failed for {key}: {t.exception()}")
                _click_errors[key] = str(t.exception())
                asyncio.ensure_future(broadcast_message({
                    "type": "click_scan_complete", "file_id": key[0], "strength": key[1],
                    "count": 0, "error": str(t.exception())}))

        task.add_done_callback(_done)
    return task


class ClickScanRequest(BaseModel):
    declick: str = "medium"   # panel strength; "off" scans at medium


@app.post("/api/clicks/{file_id}")
async def post_clicks(file_id: str, req: ClickScanRequest):
    """Start (or join) a click scan; a cached result returns immediately."""
    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    requested = _check_declick(req.declick)
    strength = click_detection.scan_strength(requested)
    cached = _click_cached(file_id, strength)
    if cached is None:
        start_click_scan(session, strength)
    return _click_view(file_id, strength, requested, cached)


@app.get("/api/clicks/{file_id}")
async def get_clicks(file_id: str, declick: str = "medium"):
    """Scan state / result for the strength the panel maps to; never blocks."""
    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    requested = _check_declick(declick)
    strength = click_detection.scan_strength(requested)
    return _click_view(file_id, strength, requested, _click_cached(file_id, strength))


async def preconvert_to_mp3(file_id: str, file_path: Path):
    """
    Convert audio to MP3 in background for faster waveform loading.
    Uses lower bitrate (128k) for quick conversion and smaller file size.
    """
    mp3_path = get_session_path(file_id, "full.mp3")
    # Encode to a temp name and atomically rename on success: ffmpeg fills
    # the output over tens of seconds, and /api/audio must never see (and
    # then permanently cache) a half-written file.
    part_path = get_session_path(file_id, f"full.{uuid.uuid4().hex[:8]}.part")

    if not mp3_path.exists():
        try:
            await asyncio.to_thread(
                run_ffmpeg,
                [
                    "-y",
                    "-i",
                    str(file_path),
                    "-acodec",
                    "libmp3lame",
                    "-b:a",
                    "128k",
                    "-f",
                    "mp3",
                    str(part_path),
                ],
                check=True,
                capture_output=True,
            )
            os.replace(part_path, mp3_path)
            print(
                f"Pre-converted {file_id} to MP3 ({mp3_path.stat().st_size // 1024 // 1024}MB)"
            )
        except Exception as e:
            part_path.unlink(missing_ok=True)
            print(f"MP3 conversion failed for {file_id}: {e}")


async def _register_source(
    file_id: str, file_path: Path, filename: str, file_size: int, in_place: bool = False
) -> dict:
    """Probe a source file, create its Session and start the background
    tasks (MP3 preview, envelope).  Shared by upload and import; returns the
    upload-entry wire shape."""
    get_session_path(file_id).mkdir(parents=True, exist_ok=True)  # derived files live here

    # Duration off the event loop; one header read gives duration and
    # source bit depth.
    try:
        duration, source_bit_depth = await asyncio.to_thread(
            audio_processor.probe_audio, file_path
        )
        if duration is None:
            duration = 0
    except Exception:
        duration, source_bit_depth = 0, None

    session_store.create(
        session_id=file_id,
        source_audio=file_path,
        source_filename=filename,
        source_duration=float(duration),
        source_size=file_size,
        source_bit_depth=source_bit_depth,
        in_place=in_place,
    )

    # Start MP3 conversion in background (for fast waveform loading)
    asyncio.create_task(preconvert_to_mp3(file_id, file_path))
    # ...and the energy envelope (music span + instant silence rescans).
    start_envelope(file_id, file_path)

    return {
        "id": file_id,
        "filename": filename,
        "size": file_size,
        "duration": duration,
        "in_place": in_place,
    }


@app.post("/api/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """
    Upload audio file(s) for processing.
    Supports WAV and AIFF formats.
    Returns file IDs and metadata.
    """
    uploaded = []

    for file in files:
        # Check file extension against supported formats
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in SUPPORTED_INPUT_EXTENSIONS:
            continue

        # Generate unique file ID, create session folder
        file_id = str(uuid.uuid4())
        session_dir = get_session_path(file_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        file_path = session_dir / f"source{file_ext}"

        # Save uploaded file in chunks — never buffer a whole multi-hundred-MB
        # recording in memory.
        with open(file_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)

        uploaded.append(
            await _register_source(file_id, file_path, file.filename, file_path.stat().st_size)
        )

    return {"files": uploaded}


# --- Import from folder ------------------------------------------------------
# Files already on disk become Sessions that reference the file in place.
# The source is never copied into, or linked from, the session dir, so the
# rmtree-based cleanup paths can't touch it.

# Absolute paths granted by the desktop file dialog (in-process only; the
# pywebview bridge is not reachable over HTTP).
_granted_import_paths: set[Path] = set()


def _vet_granted(real: Path) -> Path:
    if UPLOAD_DIR.resolve() in real.parents:
        raise ValueError("File is inside the uploads folder")
    return import_folder.vet_file(real)


def grant_import_paths(paths) -> list[str]:
    """Allow POST /api/import to take these absolute paths. Returns the
    resolved paths that are regular supported files."""
    granted: list[str] = []
    for p in paths or []:
        try:
            real = _vet_granted(Path(str(p)).expanduser().resolve())
        except (ValueError, OSError):
            continue
        _granted_import_paths.add(real)
        granted.append(str(real))
    return granted


def _import_dir() -> Optional[Path]:
    value = config.import_dir
    return Path(value).expanduser() if value else None


def _import_state() -> tuple[Optional[Path], Optional[str]]:
    """(import dir or None, error or None)."""
    d = _import_dir()
    if d is None:
        return None, None
    return d, import_folder.dir_error(d, UPLOAD_DIR)


def _session_for_source(real: Path) -> Optional[Session]:
    for s in session_store.list():
        try:
            if s.source_audio.resolve() == real:
                return s
        except OSError:
            continue
    return None


class ImportRequest(BaseModel):
    names: Optional[List[str]] = None
    paths: Optional[List[str]] = None


@app.get("/api/import")
async def list_import():
    """List audio files in the import folder (read-only)."""
    d, error = _import_state()
    if d is None:
        return {"enabled": False, "dir": None, "error": None, "files": []}
    out = {"enabled": True, "dir": str(d), "error": error, "files": []}
    if error:
        return out
    entries = await asyncio.to_thread(import_folder.list_audio, d)
    for e in entries:
        s = _session_for_source(e.pop("path"))
        e["imported_id"] = s.id if s else None
        e["imported_status"] = _session_status(s) if s else None
    out["files"] = entries
    return out


@app.post("/api/import")
async def import_files(req: ImportRequest):
    """Create Sessions for files in the import folder (``names``) or files
    granted by the desktop dialog (``paths``), without copying them."""
    if req.names is None and req.paths is None:
        raise HTTPException(status_code=400, detail="Provide names and/or paths")

    d, error = _import_state()
    imported: list[dict] = []
    skipped: list[dict] = []

    # (label, resolver) so both kinds share the vet + register logic.
    candidates: list[tuple[str, Path]] = []
    for name in req.names or []:
        try:
            if d is None:
                raise ValueError("Import folder is not configured")
            if error:
                raise ValueError(error)
            candidates.append((name, import_folder.resolve_name(d, name)))
        except (ValueError, OSError) as e:
            skipped.append({"name": str(name), "reason": str(e)})
    for p in req.paths or []:
        try:
            real = Path(str(p)).expanduser().resolve()
            if real not in _granted_import_paths:
                raise ValueError("Path was not chosen in the file dialog")
            candidates.append((str(p), _vet_granted(real)))
        except (ValueError, OSError) as e:
            skipped.append({"name": str(p), "reason": str(e)})

    for label, real in candidates:
        try:
            existing = _session_for_source(real)
            if existing is not None:
                imported.append({
                    "id": existing.id,
                    "status": _session_status(existing),
                    "filename": existing.source_filename,
                    "size": existing.source_size,
                    "duration": existing.source_duration,
                    "in_place": True,
                })
                continue
            if not import_folder.is_stable(real):
                skipped.append({"name": label, "reason": "File is still being copied"})
                continue
            imported.append(
                await _register_source(
                    str(uuid.uuid4()), real, real.name, real.stat().st_size, in_place=True
                )
            )
        except Exception as e:
            logger.warning("Import of %s failed: %s", label, e)
            skipped.append({"name": label, "reason": "Could not read the file"})

    return {"files": imported, "skipped": skipped}


@app.post("/api/analyze")
async def analyze_file(request: AnalyzeRequest):
    """
    Analyze audio file for silence detection and track boundaries.
    Returns detected track segments.
    """
    session = session_store.get(request.file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)
    _require_editable(session)
    session.album_job_id = None

    file_path = session.source_audio

    await broadcast_message(
        {
            "type": "progress",
            "file_id": request.file_id,
            "step": "detecting",
            "progress": 0.1,
            "message": "Detecting silence boundaries...",
        }
    )

    try:
        # detect_silence is a full-file ffmpeg decode — run it off the event
        # loop so WebSocket pings and other requests keep flowing.
        tracks = await asyncio.to_thread(
            audio_processor.detect_silence, file_path, verbose=False
        )

        tracks_data = [
            {"number": i + 1, "start": track.start, "end": track.end, "duration": track.duration}
            for i, track in enumerate(tracks)
        ]

        session.set_boundaries(tracks)

        await broadcast_message(
            {
                "type": "step_complete",
                "file_id": request.file_id,
                "step": "detection",
                "message": f"Detected {len(tracks)} tracks",
            }
        )

        return {"tracks": tracks_data}

    except Exception as e:
        await broadcast_message(
            {
                "type": "error",
                "file_id": request.file_id,
                "message": f"Silence detection failed: {str(e)}",
                "recoverable": True,
            }
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/rescan")
async def rescan_file(request: RescanRequest):
    """
    Smart Rescan: sweep silence-detection settings automatically until the
    analysis yields the expected number of tracks.  Falls back to the
    closest result when no setting matches exactly.
    """
    if not 1 <= request.expected_tracks <= 99:
        raise HTTPException(status_code=422, detail="expected_tracks must be between 1 and 99")

    session = session_store.get(request.file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)
    _require_editable(session)
    session.album_job_id = None

    file_path = session.source_audio

    await broadcast_message(
        {
            "type": "progress",
            "file_id": request.file_id,
            "step": "detecting",
            "progress": 0.1,
            "message": f"Rescanning for {request.expected_tracks} tracks...",
        }
    )

    try:
        # Ladder sweep runs in memory over the cached envelope (awaiting the
        # background scan if it is still decoding) — no per-rung ffmpeg run.
        db = await get_envelope(session)
        tracks, scan_info = await asyncio.to_thread(
            audio_processor.tracks_for_count_from_envelope, db, request.expected_tracks
        )

        tracks_data = [
            {"number": i + 1, "start": track.start, "end": track.end, "duration": track.duration}
            for i, track in enumerate(tracks)
        ]

        session.set_boundaries(tracks)

        await broadcast_message(
            {
                "type": "step_complete",
                "file_id": request.file_id,
                "step": "detection",
                "message": f"Smart rescan detected {len(tracks)} tracks",
            }
        )

        return {"tracks": tracks_data, "matched": scan_info["matched"], "scan": scan_info}

    except Exception as e:
        await broadcast_message(
            {
                "type": "error",
                "file_id": request.file_id,
                "message": f"Smart rescan failed: {str(e)}",
                "recoverable": True,
            }
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/scan/{file_id}")
async def get_scan(file_id: str):
    """Music span from the background envelope scan; never blocks on it."""
    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")

    task = _envelope_tasks.get(file_id)
    if task is None and get_session_path(file_id, "envelope.npy").exists():
        db = await get_envelope(session)  # cached on disk: quick load
    elif task is not None and task.done() and not task.cancelled() and task.exception() is None:
        db = task.result()
    else:
        return {"ready": False}

    start, end = music_span(db, ENVELOPE_FRAME_S)
    return {
        "ready": True,
        "music_start": start,
        "music_end": end,
        "music_duration": max(0.0, end - start),
    }


@app.post("/api/analyze-guided")
async def analyze_guided(request: GuidedAnalyzeRequest):
    """
    Place track boundaries using the cached envelope.  With a Discogs
    duration for every expected track, boundaries are laid out from those
    lengths over the music span and snapped to nearby silence gaps;
    otherwise the Smart Rescan ladder is swept in memory for the count.
    Best-match alignment runs first (any known length, unknown ones cost
    nothing); the gap/scale model is the fallback when every length is
    known, and count-based detection when not.
    """
    if not 1 <= request.expected_tracks <= 99:
        raise HTTPException(status_code=422, detail="expected_tracks must be between 1 and 99")

    side_breaks = request.side_breaks or []
    if side_breaks != sorted(set(side_breaks)) or any(
        not 1 <= index < request.expected_tracks for index in side_breaks
    ):
        raise HTTPException(status_code=422, detail="side_breaks must be sorted unique internal track indices")

    session = session_store.get(request.file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)
    _require_editable(session)
    session.album_job_id = None

    durations = request.durations
    sized = durations is not None and len(durations) == request.expected_tracks
    known = [d if d is not None and d > 0 else None for d in durations] if sized else []
    all_known = sized and all(d is not None for d in known)
    try_align = sized and request.expected_tracks >= 2 and any(d is not None for d in known)

    try:
        db = await get_envelope(session)

        def _compute():
            music_start, music_end = music_span(db, ENVELOPE_FRAME_S)
            result = None
            if try_align:
                try:
                    result = guided_by_alignment(
                        db, ENVELOPE_FRAME_S, music_start, music_end,
                        [float(d) if d is not None else None for d in known],
                        side_breaks=side_breaks,
                    )
                except Exception:
                    logger.warning("Best-match alignment failed; using fallback", exc_info=True)
            if result is None and all_known:
                gaps = gaps_from_envelope(
                    db,
                    ENVELOPE_FRAME_S,
                    audio_processor.SMART_RESCAN_LADDER[0][0],
                    audio_processor.SMART_RESCAN_LADDER[0][1],
                )
                result = boundaries_from_expected_durations(
                    gaps, music_start, music_end, [float(d) for d in known],
                    side_breaks=side_breaks,
                )
            if result is not None:
                # Contiguous aligned cuts touch, so only the outer edges widen.
                refined = audio_processor.refine_tracks(db, result.tracks)
                return refined, True, result, music_start, music_end
            tracks, info = audio_processor.tracks_for_count_from_envelope(
                db, request.expected_tracks
            )
            return tracks, info["matched"], None, music_start, music_end

        tracks, matched, guided, music_start, music_end = await asyncio.to_thread(_compute)
        session.set_boundaries(tracks)

        boundaries = []
        if guided is not None:
            boundaries = [
                {
                    "index": b.index,
                    "expected": b.expected,
                    "snapped": b.snapped,
                    "position": b.position,
                    "gap": {"start": b.gap.start, "end": b.gap.end} if b.gap else None,
                }
                for b in guided.boundaries
            ]

        return {
            "tracks": [
                {"number": i + 1, "start": t.start, "end": t.end, "duration": t.duration}
                for i, t in enumerate(tracks)
            ],
            "method": "durations" if guided is not None else "count",
            "matched": matched,
            "boundaries": boundaries,
            "scale": guided.scale if guided else None,
            "scale_clamped": guided.scale_clamped if guided else None,
            "model": guided.model if guided else None,
            "gap_s": guided.gap_s if guided else None,
            "music_start": music_start,
            "music_end": music_end,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Guided analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/preview/{file_id}/{track_number}")
async def preview_track(
    file_id: str, track_number: int, start: Optional[float] = None, end: Optional[float] = None
):
    """
    Generate and serve a preview of a detected track (first 30 seconds).
    Supports custom start/end times for manual adjustments.
    """
    from fastapi.responses import FileResponse

    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)

    # Explicit start/end (manual edits, e.g. splits the backend hasn't seen)
    # don't need a stored boundary; otherwise look the track up.
    boundaries = session.boundaries
    file_path = session.source_audio
    if start is not None and end is not None:
        track_start, track_end = start, end
    else:
        if track_number < 1 or track_number > len(boundaries):
            raise HTTPException(status_code=404, detail="Track not found")
        track = boundaries[track_number - 1]
        track_start = start if start is not None else track.start
        track_end = end if end is not None else track.end
    track_duration = track_end - track_start

    if track_duration <= 0 or track_start < 0:
        raise HTTPException(status_code=400, detail="Invalid preview range: end must be after start")

    import hashlib

    params_hash = hashlib.md5(f"{track_start}_{track_end}".encode()).hexdigest()[:8]
    preview_path = get_session_path(file_id, f"preview_track{track_number}_{params_hash}.mp3")

    try:
        duration = min(30, track_duration)

        # Serve from cache when this exact start/end was already rendered.
        # Encode to a unique temp name + atomic rename so concurrent or
        # interrupted encodes never leave a truncated file in the cache.
        if not preview_path.exists():
            part_path = preview_path.with_name(f"{preview_path.stem}.{uuid.uuid4().hex[:8]}.part")
            # -ss before -i: input-side seek, so encoding a preview near the
            # end of a side no longer decodes everything before it.
            try:
                await asyncio.to_thread(
                    run_ffmpeg,
                    [
                        "-y",
                        "-ss",
                        str(track_start),
                        "-t",
                        str(duration),
                        "-i",
                        str(file_path),
                        "-acodec",
                        "libmp3lame",
                        "-b:a",
                        "128k",
                        "-f",
                        "mp3",
                        str(part_path),
                    ],
                    check=True,
                    capture_output=True,
                )
                os.replace(part_path, preview_path)
            except Exception:
                part_path.unlink(missing_ok=True)
                raise

        return FileResponse(
            preview_path,
            media_type="audio/mpeg",
            headers={"Content-Disposition": f"inline; filename=track{track_number}_preview.mp3"},
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview generation failed: {str(e)}")


# --- Plan 06 slice 1: A/B test of the audio processing chain on one track -----------

_RT_NAME_RE = re.compile(r"rt(?:orig|proc|diff)_[0-9a-f]{12}\.flac")
_RT_MAX_RANGES = 200


class RestorationTestRequest(BaseModel):
    file_id: str
    start: float
    end: float
    rumble: Optional[bool] = None
    declick: Optional[str] = None
    restore: Optional[bool] = None   # legacy: True = rumble + light declick
    hum_filter: bool = False         # mains-hum notch at hum_freq
    hum_freq: int = 60
    hiss_reduction: str = "off"      # off | light | medium | strong
    album_gain: bool = False
    # [start, end] or [start, end, declick|null]: per-track click strength for the album measurement
    album_ranges: Optional[List[list]] = None


def hiss_filter_key(hiss: str, noise: Optional[NoiseProfile]) -> str:
    """Cache-key text for a hiss setting (the full afftdn string, so the noise profile counts)."""
    return hiss_filter(hiss, noise) if hiss and hiss != "off" else ""


def _rt_hash(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def _rt_write_json(path: Path, data) -> None:
    part = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.part")
    try:
        part.write_text(json.dumps(data))
        os.replace(part, path)
    except Exception:
        part.unlink(missing_ok=True)
        raise


def _rt_read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _rt_loud_to_json(loud: Optional[Loudness]):
    return None if loud is None else {"integrated": loud.integrated, "true_peak": loud.true_peak}


def _rt_loud_from_json(d) -> Optional[Loudness]:
    if not isinstance(d, dict):
        return None
    try:
        return Loudness(integrated=float(d["integrated"]), true_peak=float(d["true_peak"]))
    except Exception:
        return None


def _rt_render(source: Path, start: float, end: float, chain: Optional[str], out: Path) -> bool:
    """Render [start, end] to FLAC at ``out`` unless cached.  Identical
    encoding for original and processed.  Returns True on a cache hit."""
    if out.exists():
        return True
    part = out.with_name(f"{out.stem}.{uuid.uuid4().hex[:8]}.part")
    window = audio_processor.padded_cut(source, start, end) if chain else None
    if window:
        seek_s, read_dur, t0, t1 = window
        args = ["-y", *seek_args(seek_s, read_dur), "-i", str(source),
                "-af", f"{chain},{trim_filter(t0, t1)}"]
    else:
        args = ["-y", "-ss", str(start), "-t", str(end - start), "-i", str(source)]
        if chain:
            args += ["-af", chain]
    args += [
        "-c:a", "flac", "-compression_level", str(audio_processor.flac_compression),
        "-sample_fmt", "s16", "-f", "flac", str(part),
    ]
    try:
        run_ffmpeg(args, check=True, capture_output=True, timeout=600)
        os.replace(part, out)
    except Exception:
        part.unlink(missing_ok=True)
        raise
    return False


_CHANNELS_RE = re.compile(r"Audio:.*?\d+ Hz, (mono|stereo|\d+ channels)")
_MAX_VOL_RE = re.compile(r"max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB")


def _rt_channels(source: Path) -> int:
    """1 for a mono source, else 2 (anything else is rendered as stereo)."""
    try:
        res = run_ffmpeg(["-hide_banner", "-i", str(source)], capture_output=True, timeout=60)
        m = _CHANNELS_RE.search(res.stderr or "")
        return 1 if m and m.group(1) == "mono" else 2
    except Exception:
        return 2


def _rt_render_removed(
    source: Path, start: float, end: float, cleanup: str, out: Path, chunked: bool = False
) -> bool:
    """Render ``original - cleanup(original)`` as 24-bit FLAC (the residual is
    small; 16 bits would add quantisation noise to it).  True on a cache hit.

    ``chunked`` is for cleanups holding the zero-phase hum notch / rumble filter, which buffers what it
    filters: rendered in short chunks (bounded memory) by the AudioProcessor."""
    if out.exists():
        return True
    part = out.with_name(f"{out.stem}.{uuid.uuid4().hex[:8]}.part")
    if chunked:
        try:
            audio_processor.render_removed_flac(
                source, start, end, cleanup, _rt_channels(source), part
            )
            os.replace(part, out)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        return False
    window = audio_processor.padded_cut(source, start, end)
    if window:
        seek_s, read_dur, t0, t1 = window
        graph = removed_graph(cleanup, _rt_channels(source), (t0, t1))
        seek = seek_args(seek_s, read_dur)
    else:
        graph = removed_graph(cleanup, _rt_channels(source))
        seek = ["-ss", str(start), "-t", str(end - start)]
    args = [
        "-y", *seek, "-i", str(source),
        "-filter_complex", graph, "-map", "[out]",
        "-c:a", "flac", "-compression_level", str(audio_processor.flac_compression),
        "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-f", "flac", str(part),
    ]
    try:
        run_ffmpeg(args, check=True, capture_output=True, timeout=600)
        os.replace(part, out)
    except Exception:
        part.unlink(missing_ok=True)
        raise
    return False


def _rt_removed_stats(path: Path) -> dict:
    """{'lufs': float|None, 'peak_dbfs': float|None} of the residual, cached beside it."""
    side = path.with_name(path.name + ".stats.json")
    data = _rt_read_json(side) if side.exists() else None
    if isinstance(data, dict) and "lufs" in data and "peak_dbfs" in data:
        return data
    loud = audio_processor.measure_file(path)
    peak = None
    try:
        res = run_ffmpeg(
            ["-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, timeout=300,
        )
        m = _MAX_VOL_RE.search(res.stderr or "")
        if m and "inf" not in m.group(1):
            peak = float(m.group(1))
    except Exception:
        peak = None
    data = {"lufs": loud.integrated if loud else None, "peak_dbfs": peak}
    _rt_write_json(side, data)
    return data


def _rt_loudness(path: Path) -> Optional[Loudness]:
    side = path.with_name(path.name + ".loud.json")
    if side.exists():
        data = _rt_read_json(side)
        loud = _rt_loud_from_json(data)
        if loud is not None:
            return loud
    loud = audio_processor.measure_file(path)
    if loud is not None:
        _rt_write_json(side, _rt_loud_to_json(loud))
    return loud


def _rt_album_gain(
    session_id: str, source: Path, ranges, rumble: bool, declick: str,
    hum: int = 0, hiss: str = "off", noise: Optional[NoiseProfile] = None,
) -> Optional[float]:
    """Album gain exactly as export computes it (post clean-up filters, all active ranges)."""
    key = _rt_hash(
        json.dumps(ranges), rumble, declick, hum, hiss,
        hiss_filter_key(hiss, noise),
    )
    cache = get_session_path(session_id, f"rtgain_{key}.json")
    loud = _rt_loud_from_json(_rt_read_json(cache)) if cache.exists() else None
    if loud is None:
        extra = {"hum": hum, "hiss": hiss, "noise": noise} if (hum or hiss != "off") else {}
        loud = audio_processor.measure_ranges(
            source, [tuple(r) for r in ranges], rumble, declick, **extra
        )
        if loud is not None:
            _rt_write_json(cache, _rt_loud_to_json(loud))
    return album_gain_db(loud)


def _rt_settings(req: RestorationTestRequest) -> tuple:
    """(rumble, declick, hum, hiss): rumble/declick from the new fields, else the
    legacy ``restore`` bool; ``hum`` is the mains frequency or 0 (off)."""
    if req.rumble is None and req.declick is None:
        rumble, declick = LEGACY_RESTORE if req.restore else (False, "off")
    else:
        rumble, declick = bool(req.rumble), _check_declick(req.declick or "off")
    hum = _check_hum_freq(req.hum_freq) if req.hum_filter else 0
    return rumble, declick, hum, _check_hiss(req.hiss_reduction or "off")


def _run_restoration_test(
    session_id: str, source: Path, req: RestorationTestRequest, ranges,
    rumble: bool, declick: str, hum: int = 0, hiss: str = "off",
    noise: Optional[NoiseProfile] = None,
) -> dict:
    gain_db = None
    if req.album_gain:
        gain_db = _rt_album_gain(session_id, source, ranges, rumble, declick, hum, hiss, noise)
    chain = build_export_filters(rumble, declick, gain_db, hum=hum, hiss=hiss, noise=noise)
    if not chain:
        raise HTTPException(
            status_code=422,
            detail="Could not measure album loudness, so there is nothing to test",
        )

    base = _rt_hash(f"{req.start:.6f}", f"{req.end:.6f}")
    orig_name = f"rtorig_{base}.flac"
    proc_name = f"rtproc_{_rt_hash(f'{req.start:.6f}', f'{req.end:.6f}', chain)}.flac"
    orig_path = get_session_path(session_id, orig_name)
    proc_path = get_session_path(session_id, proc_name)

    hit_o = _rt_render(source, req.start, req.end, None, orig_path)
    hit_p = _rt_render(source, req.start, req.end, chain, proc_path)
    # Residual: clean-up filters only (no gain, no dither), cached under that chain.
    # The residual shows what the clean-up took out, so the hum notch and rumble filter run
    # zero-phase there: a normal filter's phase shift would leak a faint copy of the music into it.
    cleanup = build_export_filters(
        rumble, declick, None, hum=hum, hiss=hiss, noise=noise,
        zero_phase_hum=bool(hum), zero_phase_rumble=bool(rumble),
    )
    removed = {"removed_url": None, "removed_lufs": None, "removed_peak_dbfs": None}
    hit_r = True
    if cleanup:
        diff_name = f"rtdiff_{_rt_hash(f'{req.start:.6f}', f'{req.end:.6f}', cleanup, 'diff24')}.flac"
        diff_path = get_session_path(session_id, diff_name)
        hit_r = _rt_render_removed(source, req.start, req.end, cleanup, diff_path,
                                 chunked=bool(hum) or bool(rumble))
        stats = _rt_removed_stats(diff_path)
        removed = {
            "removed_url": f"/api/restoration-test/{session_id}/{diff_name}",
            "removed_lufs": stats["lufs"],
            "removed_peak_dbfs": stats["peak_dbfs"],
        }
    orig_loud = _rt_loudness(orig_path)
    proc_loud = _rt_loudness(proc_path)
    return {
        "original_url": f"/api/restoration-test/{session_id}/{orig_name}",
        "processed_url": f"/api/restoration-test/{session_id}/{proc_name}",
        "original_lufs": orig_loud.integrated if orig_loud else None,
        "processed_lufs": proc_loud.integrated if proc_loud else None,
        "gain_db": gain_db,
        "rumble": rumble,
        "declick": declick,
        "hum": hum,
        "hiss": hiss,
        "chain": chain,
        **removed,
        "cached": bool(hit_o and hit_p and hit_r),
    }


@app.post("/api/restoration-test")
async def restoration_test(req: RestorationTestRequest):
    """Render one track range with and without the export filter chain."""
    session = session_store.get(req.file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)
    rumble, declick, hum, hiss = _rt_settings(req)
    if not (rumble or declick != "off" or hum or hiss != "off" or req.album_gain):
        raise HTTPException(
            status_code=400,
            detail="Turn on a clean-up (rumble, hum, clicks or hiss) or album gain to test",
        )
    if not (math.isfinite(req.start) and math.isfinite(req.end)) or req.start < 0 or req.end <= req.start:
        raise HTTPException(status_code=400, detail="Invalid range: end must be after start")

    ranges = []
    if req.album_gain:
        ranges = req.album_ranges or [[req.start, req.end]]
        if len(ranges) > _RT_MAX_RANGES:
            raise HTTPException(status_code=400, detail="Too many album ranges")
        clean = []
        for r in ranges:
            ok = isinstance(r, list) and len(r) in (2, 3) and all(
                isinstance(x, (int, float)) and math.isfinite(x) for x in r[:2]
            )
            if not ok or r[0] < 0 or r[1] <= r[0]:
                raise HTTPException(status_code=400, detail="Invalid album range")
            override = _check_declick(r[2]) if len(r) == 3 and r[2] is not None else None
            clean.append([round(r[0], 6), round(r[1], 6)] + ([override] if override else []))
        ranges = clean

    noise = await _noise_profile_for(session) if hiss != "off" else None
    try:
        return await asyncio.to_thread(
            _run_restoration_test, req.file_id, session.source_audio, req, ranges,
            rumble, declick, hum, hiss, noise,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Restoration test failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Test render failed: {e}")


@app.get("/api/restoration-test/{file_id}/{name}")
async def get_restoration_test_audio(file_id: str, name: str):
    """Serve a rendered A/B file (FileResponse handles range requests)."""
    from fastapi.responses import FileResponse

    if session_store.get(file_id) is None:
        raise HTTPException(status_code=404, detail="File not found")
    if not _RT_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="Invalid name")
    path = get_session_path(file_id, name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Render not found")
    return FileResponse(path, media_type="audio/flac")


@app.get("/api/waveform-peaks/{file_id}")
async def get_waveform_peaks(file_id: str):
    """Generate waveform peaks for visualization."""

    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)

    file_path = session.source_audio

    # Old peaks.json has only 3,000 bins per recording, losing sub-second
    # timing on albums. Existing sessions must regenerate the detailed waveform.
    peaks_cache_path = get_session_path(file_id, "peaks_v2.json")
    if peaks_cache_path.exists():
        with open(peaks_cache_path, "r") as f:
            cached_data = json.load(f)
            return JSONResponse(content=cached_data)

    try:
        response_data = await asyncio.to_thread(audio_processor.compute_waveform_peaks, file_path)

        with open(peaks_cache_path, "w") as f:
            json.dump(response_data, f)

        return JSONResponse(content=response_data)

    except CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        raise HTTPException(status_code=500, detail=f"FFmpeg failed: {stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Peaks generation failed: {str(e)}")


@app.get("/api/audio/{file_id}")
async def get_audio_file(file_id: str, precise: bool = False):
    """Stream source WAV for precise editing, or the pinned preview otherwise."""
    from fastapi.responses import FileResponse

    session = session_store.get(file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)

    if precise and session.source_audio.suffix.lower() == ".wav":
        # Cut-point playback uses the same source as the waveform, removing
        # MP3 seeking/decoder behavior from this path. FileResponse streams
        # byte ranges; the album is not decoded into browser JS memory.
        file_path = session.source_audio
    else:
        # AIFF needs the browser-compatible preview. Pin this URL's choice so
        # an in-progress range request never switches from source to MP3 bytes.
        if session.playback_audio is None or not session.playback_audio.exists():
            mp3_path = get_session_path(file_id, "full.mp3")
            session.playback_audio = mp3_path if mp3_path.exists() else session.source_audio
        file_path = session.playback_audio

    if file_path.suffix.lower() == ".mp3":
        media_type = "audio/mpeg"
        filename = Path(session.source_filename).stem + ".mp3"
    else:
        ext = file_path.suffix.lower()
        media_types = {
            ".wav": "audio/wav",
            ".aiff": "audio/aiff",
            ".aif": "audio/aiff",
        }
        media_type = media_types.get(ext, "audio/wav")
        filename = session.source_filename

    # filename= lets Starlette RFC-5987-encode non-latin-1 characters
    # (e.g. "Björk – Debut") — a hand-built header crashes on them.
    return FileResponse(
        file_path,
        media_type=media_type,
        filename=filename,
        content_disposition_type="inline",
    )


def _serialize_release(release) -> dict:
    """Full release payload shared by /api/release/{id} (tracks always set)."""
    return {
        "id": release.id,
        "artist": release.artist,
        "title": release.title,
        "year": release.year,
        "label": release.label,
        "format": release.format,
        "cover_url": release.cover_url,
        "uri": release.uri,
        "tracks": [_serialize_track(t) for t in release.tracks],
    }


def _serialize_track(t) -> dict:
    out = {"position": t.position, "title": t.title, "duration": t.duration_str}
    parts = getattr(t, "parts", None)
    if parts:  # umbrella (index) track: the parts it can be unfolded into
        out["parts"] = [
            {"position": p["position"], "title": p["title"], "duration": p["duration"]} for p in parts
        ]
    return out


@app.post("/api/search")
async def search_discogs(request: SearchRequest):
    """Search Discogs; basic cards only (tracks: null = not loaded yet).

    Full tracklists come from GET /api/release/{id}.
    """
    try:
        # One search round-trip (rate-limit sleep inside) — off the event loop.
        basic = await asyncio.to_thread(
            metadata_handler.search_basic, request.query, request.max_results
        )
        return {"results": [{**r, "tracks": None} for r in basic]}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/release/{release_id}")
async def get_release(release_id: int):
    """Full release details including tracklist (server-side cached)."""
    release = await asyncio.to_thread(metadata_handler.get_release_by_id, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="Release not found or Discogs unavailable")
    return _serialize_release(release)


@app.get("/api/release/{release_id}/length-donors")
async def get_length_donors(release_id: int):
    """Other pressings (same master) whose track lengths match this release.

    Runs in a worker thread (rate-limited Discogs fetches); progress goes out
    over the WebSocket as ``donor_progress`` messages.  Results are cached per
    release by the handler.
    """
    loop = asyncio.get_running_loop()

    def on_progress(checked: int, budget: int, found: int) -> None:
        asyncio.run_coroutine_threadsafe(
            broadcast_message({
                "type": "donor_progress",
                "release_id": release_id,
                "checked": checked,
                "budget": budget,
                "found": found,
            }),
            loop,
        )

    try:
        donors = await asyncio.to_thread(
            metadata_handler.find_length_donors, release_id, on_progress=on_progress
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.warning("length-donors lookup failed for %s: %s", release_id, e)
        raise HTTPException(
            status_code=502,
            detail="Couldn't reach Discogs to look for other pressings. Try again in a moment.",
        )
    return {"donors": donors}


def _require_editable(session: Session) -> None:
    """Reserve mappings/sources throughout measurement, metadata fetch, export and tagging."""
    if session.export_reserved or session.state == SessionState.PROCESSING:
        raise HTTPException(status_code=409, detail="This recording is being exported.")


def _validate_process_options(request: ProcessRequest) -> None:
    """Normalize and validate the shared single/group export options without mutating Sessions."""
    # Validate output format
    if request.output_format not in OUTPUT_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported output format: {request.output_format}. "
            f"Choose from: {', '.join(OUTPUT_FORMATS.keys())}",
        )

    if request.bit_depth is not None and request.bit_depth not in ("source", "24"):
        raise HTTPException(status_code=400, detail="bit_depth must be source or 24")

    # Normalise rumble/declick now (400 on bad values) so the background job can't fail on them.
    if request.rumble_filter is None and request.declick is None:
        # Legacy clients send restoration_level; no field at all = nothing on.
        request.rumble_filter, request.declick = _legacy_restore(request.restoration_level or 0)
    else:
        request.rumble_filter = bool(request.rumble_filter)
        request.declick = _check_declick(request.declick or "off")

    request.hiss_reduction = _check_hiss(request.hiss_reduction or "off")
    request.hum_filter = bool(request.hum_filter)
    if request.hum_filter:
        request.hum_freq = _check_hum_freq(request.hum_freq)

    for boundary in request.track_boundaries or []:
        if boundary.declick is not None:
            _check_declick(boundary.declick)

    custom = request.custom_tracks or []
    if len({entry.position for entry in custom}) != len(custom):
        raise HTTPException(status_code=400, detail="Custom track positions must be unique.")


def _output_spec(request: ProcessRequest, noise_profile=None) -> OutputSpec:
    """Capture server defaults and request overrides into an immutable export specification."""
    return OutputSpec(
        output_format=request.output_format,
        output_dir=Path(config.default_output_dir),
        flac_compression=config.default_flac_compression,
        rumble_filter=bool(request.rumble_filter),
        declick=request.declick or "off",
        hum_filter=request.hum_filter,
        hum_freq=request.hum_freq if request.hum_filter else 60,
        hiss_reduction=request.hiss_reduction,
        noise_profile=noise_profile,
        album_gain=request.album_gain,
        replaygain=request.replaygain,
        track_numbering=config.track_numbering,
        bit_depth=request.bit_depth or config.bit_depth,
        custom_tracks=tuple((entry.position, entry.title) for entry in request.custom_tracks or []),
    )


class AlbumProcessRequest(BaseModel):
    job_id: uuid.UUID
    files: List[ProcessRequest]


@app.post("/api/process-album")
async def process_album(request: AlbumProcessRequest):
    """Accept one identifiable, immutable album group; no audio work blocks the HTTP response."""
    if not 2 <= len(request.files) <= MAX_ALBUM_RECORDINGS:
        raise HTTPException(status_code=400, detail=f"An album group needs 2 to {MAX_ALBUM_RECORDINGS} recordings.")
    for item in request.files:
        _validate_process_options(item)
    fingerprint = hashlib.sha256(json.dumps(request.model_dump(mode='json'), sort_keys=True).encode()).hexdigest()
    job_id = str(request.job_id)
    existing = album_jobs.get(job_id)
    if existing:
        if existing.fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="This album job id belongs to different export inputs.")
        return existing.view()
    reference = request.files[0]
    # One release, one set of custom tracks: numbering and totals must agree across recordings.
    merged_custom: dict = {}
    for item in request.files:
        for entry in item.custom_tracks or []:
            if merged_custom.setdefault(entry.position, entry.title) != entry.title:
                raise HTTPException(status_code=400, detail=f"Recordings disagree on the title of {entry.position}.")
    shared_custom = tuple(merged_custom.items())
    members = []
    positions = set()
    file_ids = set()
    for item in request.files:
        if (item.release_id, item.output_format, item.album_gain, item.replaygain) != (
                reference.release_id, reference.output_format, reference.album_gain, reference.replaygain):
            raise HTTPException(status_code=400, detail="Use the same release, format, album gain and ReplayGain choices for an album group.")
        session = session_store.get(item.file_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        _require_source(session)
        if not session.source_audio.is_file():
            raise HTTPException(status_code=410, detail="The source recording is no longer available.")
        _require_editable(session)
        if item.file_id in file_ids:
            raise HTTPException(status_code=400, detail="An album group cannot repeat a recording.")
        file_ids.add(item.file_id)
        boundaries = item.track_boundaries or []
        mapping = {entry.detected: entry.discogs for entry in item.track_mapping}
        numbers = [boundary.number for boundary in boundaries]
        if not boundaries or len(set(numbers)) != len(numbers) or set(mapping) != set(numbers) or len(mapping) != len(item.track_mapping):
            raise HTTPException(status_code=400, detail="Every unique active boundary needs one position mapping.")
        previous_end = 0
        for boundary in boundaries:
            if boundary.number < 1 or not math.isfinite(boundary.start) or not math.isfinite(boundary.end) or boundary.start < previous_end or boundary.end <= boundary.start or boundary.end > session.source_duration:
                raise HTTPException(status_code=400, detail="Invalid album track boundaries.")
            previous_end = boundary.end
            position = mapping[boundary.number].strip()
            if not position or position in positions:
                raise HTTPException(status_code=400, detail="Album positions must be nonempty and unique across recordings.")
            positions.add(position)
        members.append(AlbumMember(session, replace(_output_spec(item), custom_tracks=shared_custom), item.release_id))
    # No await before all validations/reservations: competing requests cannot split the group.
    for member, item in zip(members, request.files):
        member.session.set_boundaries(list(item.track_boundaries))
        member.session.set_mappings({entry.detected: entry.discogs for entry in item.track_mapping})
        member.session.album_job_id = job_id
        member.session.export_reserved = True
    for old_id, old_job in list(album_jobs.items()):
        if old_job.status == 'complete' and all(session_store.get(member.session.id) is None or
                session_store.get(member.session.id).album_job_id != old_id for member in old_job.members):
            del album_jobs[old_id]
    job = AlbumJob(job_id, members, fingerprint)
    album_jobs[job_id] = job
    asyncio.create_task(_run_album_job(job))
    return job.view()


async def _run_album_job(job: AlbumJob):
    """Prepare each source's noise profile, then run its album worker off the event loop."""
    try:
        for index, member in enumerate(job.members):
            if member.spec.hiss_reduction != 'off':
                from dataclasses import replace
                noise = await _noise_profile_for(member.session)
                job.members[index] = AlbumMember(member.session, replace(member.spec, noise_profile=noise), member.release_id)
        await asyncio.to_thread(job.run, audio_processor, metadata_handler)
    except Exception as error:
        job.status = 'complete'
        job.warnings.append(f'Album preparation failed: {error}')
        for item in job.files.values():
            item.update(status='error', error=str(error), message=str(error))
    finally:
        for member in job.members:
            member.session.export_reserved = False


@app.get("/api/process-album/{job_id}")
async def get_album_job(job_id: str):
    """Poll group preparation, per-file export progress and final shared-tag results."""
    job = album_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Album job not found")
    return job.view()


@app.post("/api/process")
async def process_file(request: ProcessRequest):
    """
    Process file: split tracks, tag with metadata, and save.
    Supports FLAC, MP3, and AIFF output formats.
    """
    session = session_store.get(request.file_id)
    if session is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_source(session)

    _require_editable(session)
    _validate_process_options(request)
    session.album_job_id = None
    if request.track_boundaries:
        session.set_boundaries(list(request.track_boundaries))
    session.set_mappings({m.detected: m.discogs for m in request.track_mapping})

    # job_id == session_id post-Step-4: re-runs reuse the same id, since
    # ``last_run`` is overwritten on each invocation and there's no
    # per-run tracking surface to preserve across restarts.
    session.export_reserved = True
    asyncio.create_task(process_file_background(request))

    return {"job_id": session.id, "status": "processing"}


# Map Pipeline phase names → existing UI step names so the frontend
# WebSocket consumer keeps working unchanged during the strangler.
_PHASE_TO_UI_STEP = {
    "fetching_release": "fetching",
    "downloading_cover": "cover_art",
    "extracting": "splitting",
}


async def process_file_background(request: ProcessRequest):
    """Always release a single-export reservation, including failures before pipeline startup."""
    session = session_store.get(request.file_id)
    try:
        await _process_file_background(request)
    finally:
        if session:
            session.export_reserved = False


async def _process_file_background(request: ProcessRequest):
    """Run the Pipeline for ``request`` and bridge progress events to the
    WebSocket broadcaster.

    Per-run state lives on ``session.last_run`` (mutated by the Pipeline);
    this coroutine just translates Pipeline ProgressEvents into the
    WebSocket message shapes the frontend expects, plus updates
    ``last_run.message`` / ``last_run.final_fraction`` so polling
    /api/process/{job_id} returns fresh status.

    The Pipeline itself is sync; we run it in a worker thread so ffmpeg
    no longer blocks the FastAPI event loop.  Progress callbacks are
    re-marshalled onto the main loop via ``run_coroutine_threadsafe``.
    """
    file_id = request.file_id
    session = session_store.get(file_id)
    if session is None:
        return

    noise_profile = None
    if request.hiss_reduction != "off":
        noise_profile = await _noise_profile_for(session)

    spec = _output_spec(request, noise_profile)

    loop = asyncio.get_running_loop()

    async def emit(event: ProgressEvent) -> None:
        run = session.last_run
        if event.phase == "complete":
            await broadcast_message({
                "type": "complete",
                "file_id": file_id,
                "output_path": str(run.output_folder) if run and run.output_folder else "",
                "tracks": list(run.output_files) if run else [],
            })
        elif event.phase == "error":
            await broadcast_message({
                "type": "error",
                "file_id": file_id,
                "message": event.message,
                "recoverable": False,
            })
        else:
            if run is not None:
                run.final_fraction = event.fraction
                run.message = event.message
            await broadcast_message({
                "type": "progress",
                "file_id": file_id,
                "step": _PHASE_TO_UI_STEP.get(event.phase, event.phase),
                "progress": event.fraction,
                "message": event.message,
            })

    def on_progress(event: ProgressEvent) -> None:
        # pipeline.run executes in a worker thread; bounce each event back
        # to the main loop so broadcasts stay single-threaded.
        asyncio.run_coroutine_threadsafe(emit(event), loop)

    try:
        await asyncio.to_thread(
            pipeline.run,
            session,
            spec,
            request.release_id,
            audio_processor,
            metadata_handler,
            on_progress,
        )
    except Exception:
        # The Pipeline already emitted an "error" event and marked the
        # Session FAILED.  Nothing to clean up here.
        pass


@app.get("/api/process/{job_id}")
async def get_process_job(job_id: str):
    """Get processing job status and progress for polling fallbacks.

    ``job_id`` is the Session id post-Step-4: every process invocation
    against the same Session updates ``last_run`` in place.
    """
    session = session_store.get(job_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Job not found")
    # _serialize_job copes with last_run==None — returns a "processing"
    # stub for the brief window between /api/process kickoff and the
    # Pipeline calling mark_processing.
    return _serialize_job(session)


@app.get("/api/queue")
async def get_queue():
    """Get current Session queue + per-Session run status."""
    sessions = session_store.list()
    return {
        "uploaded": [_serialize_uploaded(s) for s in sessions],
        "processing": [_serialize_job(s) for s in sessions if s.last_run is not None],
    }


@app.delete("/api/queue/{file_id}")
async def remove_from_queue(file_id: str):
    """Remove a Session and its on-disk source folder."""
    if session_store.get(file_id) is None:
        raise HTTPException(status_code=404, detail="File not found")
    _require_editable(session_store.get(file_id))
    await asyncio.to_thread(cleanup_session, file_id)
    return {"status": "removed"}


@app.delete("/api/temp/clear-all")
async def clear_all_temp():
    """Drop every Session and source folder except those mid-Pipeline."""
    cleared = 0
    keep_ids = {s.id for s in session_store.list() if s.state == SessionState.PROCESSING or s.export_reserved}

    for entry in list(UPLOAD_DIR.iterdir()):
        if entry.is_dir() and entry.name not in keep_ids:
            try:
                shutil.rmtree(entry)
                cleared += 1
            except Exception as e:
                print(f"Failed to remove {entry.name}: {e}")

    for session in session_store.list():
        if session.id not in keep_ids:
            session_store.remove(session.id)

    return {"status": "cleared", "sessions_removed": cleared}


@app.get("/api/config")
async def get_config():
    """Get current configuration."""
    return {
        "silence_threshold": audio_processor.silence_threshold,
        "min_silence_duration": audio_processor.min_silence_duration,
        "min_track_length": audio_processor.min_track_length,
        "flac_compression": audio_processor.flac_compression,
        "output_dir": config.default_output_dir,
        "import_dir": str(_import_dir()) if _import_dir() else None,  # read-only
        "track_numbering": config.track_numbering,
        "output_format": config.output_format,
        "bit_depth": config.bit_depth,
        "rumble_filter": config.rumble_filter,
        "declick": config.declick,
        "restoration_level": config.restoration_level,  # legacy, derived
        "hum_filter": config.hum_filter,
        "hum_freq": config.hum_freq,
        "hiss_reduction": config.hiss_reduction,
        "hiss_strength": config.hiss_strength,
        "album_gain": config.album_gain,
        "replaygain": config.replaygain,
    }


@app.put("/api/config")
async def update_config(updates: ConfigUpdate):
    """Update configuration parameters."""
    # Validate the clean-up fields before touching anything (no half-applied update).
    if updates.hum_freq is not None:
        _check_hum_freq(updates.hum_freq)
    if updates.hiss_reduction is not None:
        _check_hiss(updates.hiss_reduction)
    if updates.hiss_strength is not None and updates.hiss_strength not in HISS_LEVELS[1:]:
        raise HTTPException(status_code=400, detail="hiss_strength must be light, medium or strong")
    if updates.silence_threshold is not None:
        audio_processor.silence_threshold = updates.silence_threshold
    if updates.min_silence_duration is not None:
        audio_processor.min_silence_duration = updates.min_silence_duration
    if updates.min_track_length is not None:
        audio_processor.min_track_length = updates.min_track_length
    if updates.output_dir is not None:
        output_dir = str(Path(updates.output_dir).expanduser())
        config.default_output_dir = output_dir
        config.save_output_dir(output_dir)
    if updates.track_numbering is not None:
        if updates.track_numbering in ("sequential_disc_per_lp", "vinyl"):
            config.track_numbering = updates.track_numbering
            config.save_track_numbering(updates.track_numbering)
    if updates.output_format is not None:
        if updates.output_format not in ("flac", "mp3", "aiff"):
            raise HTTPException(status_code=400, detail="output_format must be flac, mp3 or aiff")
        config.output_format = updates.output_format
        config.save_output_format(updates.output_format)
    if updates.bit_depth is not None:
        if updates.bit_depth not in ("source", "24"):
            raise HTTPException(status_code=400, detail="bit_depth must be source or 24")
        config.bit_depth = updates.bit_depth
        config.save_bit_depth(updates.bit_depth)
    if updates.restoration_level is not None:  # legacy: maps to the new pair
        rumble, declick = _legacy_restore(updates.restoration_level)
        config.rumble_filter, config.declick = rumble, declick
        config.save_rumble_filter(rumble)
        config.save_declick(declick)
    if updates.rumble_filter is not None:
        config.rumble_filter = updates.rumble_filter
        config.save_rumble_filter(updates.rumble_filter)
    if updates.declick is not None:
        config.declick = _check_declick(updates.declick)
        config.save_declick(updates.declick)
    if updates.hum_filter is not None:
        config.hum_filter = bool(updates.hum_filter)
        config.save_hum_filter(config.hum_filter)
    if updates.hum_freq is not None:
        config.hum_freq = int(updates.hum_freq)
        config.save_hum_freq(config.hum_freq)
    if updates.hiss_strength is not None:      # first: an explicit hiss_reduction below wins
        config.hiss_strength = updates.hiss_strength
        config.save_hiss_strength(updates.hiss_strength)
    if updates.hiss_reduction is not None:
        config.hiss_reduction = updates.hiss_reduction
        if updates.hiss_reduction != "off":
            config.hiss_strength = updates.hiss_reduction
        config.save_hiss_reduction(updates.hiss_reduction)
    if updates.album_gain is not None:
        config.album_gain = updates.album_gain
        config.save_album_gain(updates.album_gain)
    if updates.replaygain is not None:
        config.replaygain = updates.replaygain
        config.save_replaygain(updates.replaygain)

    return await get_config()


@app.get("/api/status")
async def get_status():
    """Check app configuration status."""
    token_exists = bool(config.discogs_token and config.discogs_token != "your_token_here")

    response = {"discogs_configured": token_exists}

    # If configured, try to get username
    if token_exists:
        try:
            success, message = await asyncio.to_thread(config.test_discogs_connection)
            if success and ": " in message:
                username = message.split(": ")[-1]
                response["discogs_username"] = username
        except:
            pass

    return response


@app.post("/api/setup/discogs-token")
async def setup_discogs_token(request: DiscogsSetupRequest):
    """
    Configure Discogs API token via web UI.
    Validates token, saves to persistent config, reinitializes without restart.
    """
    try:
        # Validate token
        import discogs_client

        test_client = discogs_client.Client(
            request.user_agent,
            user_token=request.token
        )

        try:
            identity = test_client.identity()
            username = identity.username
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid Discogs token: {str(e)}"
            )

        # Save to persistent config
        if not config.save_token(request.token, request.user_agent):
            raise HTTPException(
                status_code=500,
                detail="Failed to save token to config file"
            )

        # Reload config and reinitialize handler
        config.reload()
        global metadata_handler
        metadata_handler.reinitialize(config.discogs_token, config.discogs_user_agent)

        return {
            "success": True,
            "username": username,
            "message": f"Connected as {username}"
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Setup failed: {str(e)}"
        )


# Mount static files (must be last)
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    host = os.environ.get("HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
