"""Click detection (plan 07, slice 2).

Detection = what the remover would change: decode the music span in
overlapping chunks, build ``original - declicked`` (the *residual*) in ffmpeg
with the chosen strength's adeclick preset, and treat residual impulses as
click positions.  Memory stays bounded to one ~61 s mono float chunk at a time.

The pure parts (``click_events_from_residual``, ``local_threshold``,
``plan_chunks``, ``dedupe_events``) have no ffmpeg dependency and are unit-tested.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Union

import numpy as np

from audio_processor import DECLICK_PRESETS, run_ffmpeg

# Bump when the algorithm/thresholds change so cached scans are discarded.
DETECTOR_VERSION = 1

DETECT_SR = 44100          # scan rate: mono, resampled (adeclick windows are in ms)
CHUNK_S = 60.0             # owned span per ffmpeg decode
MARGIN_S = 0.5             # extra decoded each side -> 1 s overlap between neighbours
MERGE_MS = 20.0            # residual peaks closer than this are one click (a repaired
                           # burst can ring over several ms; two clicks inside 20 ms are one scratch)
EDGE_S = 0.05              # ignore this much at each decode edge (declicker warm-up artefacts)

# Threshold = max(absolute floor, rel * local music RMS, rough_k * local roughness).
# Roughness = robust (median-based) sigma of the second difference of the original,
# i.e. the local noise/transient level the declicker itself judges against; unlike
# plain RMS a few big pops do not inflate it, and surface hiss or busy music raise
# the bar so adeclick's small "nibbles" at noise are not reported as clicks.
FLOOR_DB = -50.0           # absolute floor (dBFS)
REL_DB = -20.0             # also must exceed the local music RMS by this margin
LEVEL_WINDOW_S = 0.2       # window for the local RMS
ROUGH_K = 3.0              # residual must exceed this many local-roughness sigmas
ROUGH_BLOCK_S = 0.02       # block size for the median roughness estimate


@dataclass(frozen=True)
class Chunk:
    decode_start: float    # where ffmpeg starts (-ss)
    decode_dur: float      # how much it decodes (-t)
    own_start: float       # events are kept only inside [own_start, own_end)
    own_end: float


def plan_chunks(
    start: float,
    end: float,
    chunk_s: float = CHUNK_S,
    margin_s: float = MARGIN_S,
    total: Optional[float] = None,
) -> List[Chunk]:
    """Split ``[start, end)`` into owned spans of ``chunk_s``; each decode is
    padded by ``margin_s`` on both sides (clamped to ``[0, total]``) so the
    declicker has context at the seams.  Ownership partitions the range, so an
    event inside an overlap is kept by exactly one chunk."""
    if end <= start:
        return []
    chunks: List[Chunk] = []
    n = max(1, int(np.ceil((end - start) / chunk_s - 1e-9)))
    for i in range(n):
        own_start = start + i * chunk_s
        own_end = end if i == n - 1 else start + (i + 1) * chunk_s
        ds = max(0.0, own_start - margin_s)
        de = own_end + margin_s
        if total is not None:
            de = min(de, total)
        chunks.append(Chunk(ds, max(0.0, de - ds), own_start, own_end))
    return chunks


def dedupe_events(times: Sequence[float], min_gap_s: float = MERGE_MS / 1000.0) -> List[float]:
    """Sorted times with any event within ``min_gap_s`` of the previous kept one dropped."""
    out: List[float] = []
    for t in sorted(times):
        if not out or t - out[-1] >= min_gap_s:
            out.append(float(t))
    return out


def local_roughness(level: np.ndarray, sr: int, block_s: float = ROUGH_BLOCK_S) -> np.ndarray:
    """Per-sample robust noise sigma: block-wise median(|second difference|) / 0.6745,
    widened to the max of each block and its neighbours."""
    x = np.asarray(level, dtype=np.float64)
    n = len(x)
    if n < 3:
        return np.zeros(n)
    d2 = np.zeros(n)
    d2[2:] = x[2:] - 2.0 * x[1:-1] + x[:-2]
    blk = max(8, int(block_s * sr))
    nb = int(np.ceil(n / blk))
    padded = np.full(nb * blk, np.nan)
    padded[:n] = np.abs(d2)
    sigma = np.nanmedian(padded.reshape(nb, blk), axis=1) / 0.6745
    wide = sigma.copy()
    wide[1:] = np.maximum(wide[1:], sigma[:-1])
    wide[:-1] = np.maximum(wide[:-1], sigma[1:])
    return np.repeat(wide, blk)[:n]


def local_threshold(
    level: np.ndarray,
    sr: int,
    floor_db: float = FLOOR_DB,
    rel_db: float = REL_DB,
    window_s: float = LEVEL_WINDOW_S,
    rough_k: float = ROUGH_K,
) -> np.ndarray:
    """Per-sample click threshold (linear amplitude).

    ``max(floor, rel * local RMS, rough_k * local roughness)`` of ``level``
    (the original programme).  Loud passages and noisy/busy ones raise the bar;
    quiet clean ones fall back to the absolute floor."""
    x = np.asarray(level, dtype=np.float64)
    n = len(x)
    floor = 10.0 ** (floor_db / 20.0)
    if n == 0:
        return np.zeros(0)
    win = max(1, int(window_s * sr))
    csum = np.concatenate(([0.0], np.cumsum(x * x)))
    idx = np.arange(n)
    lo = np.clip(idx - win // 2, 0, n)
    hi = np.clip(idx + win // 2 + 1, 0, n)
    rms = np.sqrt((csum[hi] - csum[lo]) / np.maximum(hi - lo, 1))
    thr = np.maximum(floor, (10.0 ** (rel_db / 20.0)) * rms)
    if rough_k:
        thr = np.maximum(thr, rough_k * local_roughness(x, sr))
    return thr


def click_events_from_residual(
    residual: np.ndarray,
    sr: int,
    threshold: Union[float, np.ndarray],
    merge_ms: float = MERGE_MS,
) -> List[float]:
    """Click times (seconds from the start of ``residual``).

    Samples whose ``|residual|`` exceeds ``threshold`` (scalar, or one value per
    sample) are grouped when closer than ``merge_ms``; each group is reported
    once, at its largest-magnitude sample."""
    r = np.abs(np.asarray(residual, dtype=np.float64))
    if r.size == 0:
        return []
    hot = np.flatnonzero(r > threshold)
    if hot.size == 0:
        return []
    gap = max(1, int(round(merge_ms / 1000.0 * sr)))
    splits = np.flatnonzero(np.diff(hot) > gap) + 1
    times: List[float] = []
    for grp in np.split(hot, splits):
        peak = grp[int(np.argmax(r[grp]))]
        times.append(float(peak) / sr)
    return times


def residual_graph(strength: str) -> str:
    """ffmpeg filter_complex: mono downmix -> original & declicked branches ->
    ``original - declicked`` as channel 0, the original programme as channel 1
    (for the local level).  Output label ``[out]``."""
    if strength not in DECLICK_PRESETS:
        raise ValueError(f"unknown declick strength: {strength!r}")
    return (
        # Stereo average (0.5*L + 0.5*R) keeps click amplitudes true to the file;
        # swr's own mono downmix would sum at -3 dB each (+3 dB for correlated
        # content).  A mono source is first upmixed to stereo by swr, so it reads
        # 3 dB low -- harmless for a relative threshold.
        f"[0:a]aformat=sample_fmts=flt:sample_rates={DETECT_SR}:channel_layouts=stereo,"
        "pan=mono|c0=0.5*c0+0.5*c1,asplit=3[o1][o2][o3];"
        f"[o2]{DECLICK_PRESETS[strength]}[d];"
        "[o1][d]amerge=inputs=2,pan=mono|c0=c0-c1[res];"
        "[res][o3]amerge=inputs=2[out]"
    )


def decode_chunk(source, chunk: Chunk, strength: str):
    """Run one chunk through the residual graph; returns ``(residual, original)``
    float32 arrays (mono, ``DETECT_SR``)."""
    res = run_ffmpeg(
        [
            "-hide_banner", "-loglevel", "error",
            "-ss", f"{chunk.decode_start:.6f}", "-t", f"{chunk.decode_dur:.6f}",
            "-i", str(source),
            "-filter_complex", residual_graph(strength),
            "-map", "[out]", "-f", "f32le", "-ac", "2", "-ar", str(DETECT_SR), "pipe:1",
        ],
        text=False, capture_output=True, timeout=900,
    )
    if res.returncode != 0:
        tail = (res.stderr or b"")[-300:].decode("utf-8", "replace")
        raise RuntimeError(f"click scan ffmpeg failed: {tail}")
    data = np.frombuffer(res.stdout, dtype="<f4")
    data = data[: (len(data) // 2) * 2].reshape(-1, 2)
    return data[:, 0], data[:, 1]


def detect_chunk(residual: np.ndarray, original: np.ndarray, chunk: Chunk) -> List[float]:
    """Absolute click times for one decoded chunk, restricted to the chunk's owned span."""
    thr = local_threshold(original, DETECT_SR)
    events = click_events_from_residual(residual, DETECT_SR, thr)
    span = len(residual) / DETECT_SR
    absolute = [chunk.decode_start + t for t in events if EDGE_S <= t < span - EDGE_S]
    return [t for t in absolute if chunk.own_start <= t < chunk.own_end]


def scan_clicks(
    source,
    start: float,
    end: float,
    strength: str,
    total: Optional[float] = None,
    progress: Optional[Callable[[float], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
    chunk_s: float = CHUNK_S,
) -> List[float]:
    """Sorted click times (seconds, file-wide) in ``[start, end)`` at ``strength``."""
    chunks = plan_chunks(start, end, chunk_s=chunk_s, total=total)
    times: List[float] = []
    for i, chunk in enumerate(chunks):
        if cancelled is not None and cancelled():
            raise RuntimeError("click scan cancelled")
        residual, original = decode_chunk(source, chunk, strength)
        times.extend(detect_chunk(residual, original, chunk))
        if progress is not None:
            progress((i + 1) / len(chunks))
    return dedupe_events(times)


# --- Per-strength result cache (clicks_<strength>.json in the session dir) ----

def scan_strength(panel_declick: str) -> str:
    """Strength a scan runs at: the panel's, or ``medium`` when the panel is
    ``off`` (so you can still see whether a record needs cleaning)."""
    return "medium" if panel_declick in (None, "", "off") else panel_declick


def cache_path(session_dir: Path, strength: str) -> Path:
    return Path(session_dir) / f"clicks_{strength}.json"


def make_payload(strength: str, start: float, end: float, times: Sequence[float]) -> dict:
    return {
        "version": DETECTOR_VERSION,
        "strength": strength,
        "chain": DECLICK_PRESETS[strength],
        "music_start": start,
        "music_end": end,
        "scanned_at": datetime.now().isoformat(timespec="seconds"),
        "count": len(times),
        "times": [round(float(t), 4) for t in sorted(times)],
    }


def read_cache(path: Path, strength: str) -> Optional[dict]:
    """The cached payload, or None if missing/corrupt/stale (detector or preset changed)."""
    try:
        data = json.loads(Path(path).read_text())
    except Exception:
        return None
    if (
        not isinstance(data, dict)
        or data.get("version") != DETECTOR_VERSION
        or data.get("strength") != strength
        or data.get("chain") != DECLICK_PRESETS.get(strength)
        or not isinstance(data.get("times"), list)
    ):
        return None
    return data


def write_cache(path: Path, payload: dict) -> bool:
    """Atomic write (temp file + rename); False if the session dir is gone."""
    path = Path(path)
    part = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.part")
    try:
        part.write_text(json.dumps(payload))
        os.replace(part, path)
        return True
    except OSError:
        part.unlink(missing_ok=True)
        return False
