"""Silent-stretch analysis (plan 07, slice 4): mains-hum detector + surface-noise profile.

Only the *silent* parts of a recording (lead-in, gaps between tracks, run-out) are
analysed: there the hum and the surface noise are all there is, so a spectral peak
at 50/60 Hz or its harmonics is unambiguous, and the noise spectrum can be read
directly.  Bass notes played *in the music* never enter the analysis.

Everything except ``decode_ranges`` is pure (numpy only) and unit-tested.  The
decode is bounded: a handful of short mono-per-channel windows, ~30 s in total.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from audio_processor import run_ffmpeg
from track_boundaries import MUSIC_FLOOR_DB, gaps_from_envelope

# Bump when the algorithm changes so cached results are discarded.
ANALYSIS_VERSION = 1

MAX_ANALYSIS_S = 30.0       # total audio decoded for the analysis
MAX_RANGE_S = 12.0          # one stretch contributes at most this much (spread over gaps)
MIN_RANGE_S = 1.6           # shorter stretches are skipped (FFT window ~0.75 s)
EDGE_MARGIN_S = 0.5         # keep clear of needle drops / decaying notes at the edges

# --- hum detector -----------------------------------------------------------
HUM_FREQS = (50, 60)
HUM_MAX_HZ = 400.0
HUM_SHARED_HZ = (300.0,)    # a harmonic of both 50 and 60: no evidence either way
HUM_PROMINENCE_DB = 6.0     # peak bin over the neighbouring floor (noise alone: ~+2 dB)
HUM_STRONG_DB = 12.0        # a lone harmonic this prominent is enough
HUM_MIN_LEVEL_DBFS = -75.0  # quieter than this: not worth a suggestion
HUM_TOLERANCE = 0.01        # lines may sit this far (fraction) from k*f0

# --- noise profile ----------------------------------------------------------
# afftdn's 15 custom noise bands (measured with single-band probes; Hz, absolute
# - independent of the sample rate).  Boundaries between band i and i+1.
NOISE_BAND_EDGES_HZ = (87, 139, 215, 334, 509, 760, 1165, 1746, 2617, 3922,
                       5880, 8970, 13440, 20150)
NOISE_BANDS = len(NOISE_BAND_EDGES_HZ) + 1
BN_LIMIT_DB = 24.0          # afftdn accepts band offsets in [-24, 24] dB


# --- selecting the silent stretches ----------------------------------------

def silent_ranges(
    db: np.ndarray,
    frame_s: float,
    max_total_s: float = MAX_ANALYSIS_S,
    max_range_s: float = MAX_RANGE_S,
    margin_s: float = EDGE_MARGIN_S,
    min_range_s: float = MIN_RANGE_S,
) -> List[Tuple[float, float]]:
    """Silent stretches ``(start, end)`` of an envelope, clear of their edges,
    longest first until ``max_total_s`` is filled, returned in time order.

    "Silent" = below ``floor + 10 dB`` where ``floor`` is the 5th-percentile
    level (the recording's own noise floor), capped at the music floor (-38 dB)
    from above and ignoring digital silence.  This adapts to loud hum or noisy
    grooves that sit above the fixed silence threshold.
    """
    if db is None or len(db) == 0:
        return []
    live = db[db > -90.0]
    if live.size < 10:
        return []
    floor = float(np.percentile(live, 5))
    thr = min(floor + 10.0, MUSIC_FLOOR_DB + 8.0)
    gaps = gaps_from_envelope(db, frame_s, thr, min_range_s + 2 * margin_s)
    total = len(db) * frame_s
    cand = []
    for g in gaps:
        a = g.start + margin_s
        b = (total if g.end is None else g.end) - margin_s
        if b - a >= min_range_s:
            cand.append((a, min(b, a + max_range_s)))
    # spread: take the middle part of very long stretches, longest first
    cand.sort(key=lambda r: -(r[1] - r[0]))
    out, used = [], 0.0
    for a, b in cand:
        if used >= max_total_s:
            break
        take = min(b - a, max_total_s - used)
        if take < min_range_s:
            continue
        mid = (a + b) / 2
        out.append((mid - take / 2, mid + take / 2))
        used += take
    return sorted(out)


_CHANNELS_RE = re.compile(r"Audio:.*?\d+ Hz, (mono|stereo|\d+ channels)")


def source_channels(source) -> int:
    """1 for a mono source, else 2 (anything wider is analysed as stereo)."""
    try:
        res = run_ffmpeg(["-hide_banner", "-i", str(source)], capture_output=True, timeout=60)
        m = _CHANNELS_RE.search(res.stderr or "")
        return 1 if m and m.group(1) == "mono" else 2
    except Exception:
        return 2


def decode_ranges(source, ranges: Sequence[Tuple[float, float]], sample_rate: int) -> List[np.ndarray]:
    """Decode each range as float32 ``(n, channels)`` -- mono stays mono (an up-mix would
    lower the level by 3 dB) and wider layouts are folded to stereo, so every channel's
    levels stay true.  One bounded ffmpeg run per range."""
    channels = source_channels(source)
    out = []
    for a, b in ranges:
        res = run_ffmpeg(
            ["-hide_banner", "-loglevel", "error", "-ss", f"{a:.6f}", "-t", f"{b - a:.6f}",
             "-i", str(source), "-f", "f32le", "-ac", str(channels), "-ar", str(sample_rate), "pipe:1"],
            text=False, capture_output=True, timeout=300,
        )
        if res.returncode != 0:
            tail = (res.stderr or b"")[-200:].decode("utf-8", "replace")
            raise RuntimeError(f"silence analysis decode failed: {tail}")
        data = np.frombuffer(res.stdout, dtype="<f4")
        out.append(data[: (len(data) // channels) * channels].reshape(-1, channels))
    return out


# --- spectrum ---------------------------------------------------------------

def fft_size(sample_rate: int) -> int:
    """Power-of-two FFT length giving ~1.4 Hz bins (enough to tell 50 from 60 Hz)."""
    return int(2 ** round(np.log2(sample_rate / 1.4)))


def averaged_power_spectrum(
    segments: Sequence[np.ndarray], sample_rate: int, nfft: Optional[int] = None
) -> Tuple[np.ndarray, np.ndarray, int]:
    """Welch estimate over ``segments`` (1-D float arrays or ``(n, ch)``: every channel
    is a separate trace).  Returns ``(freqs, power, n_frames)`` with ``power`` per bin
    scaled so that ``power.sum()`` is the mean square (dBFS RMS = 10*log10)."""
    nfft = nfft or fft_size(sample_rate)
    win = np.hanning(nfft)
    wpow = float(np.sum(win ** 2))
    acc = np.zeros(nfft // 2 + 1)
    frames = 0
    hop = nfft // 2
    for seg in segments:
        seg = np.asarray(seg, dtype=np.float32)
        traces = [seg] if seg.ndim == 1 else [seg[:, c] for c in range(seg.shape[1])]
        for x in traces:
            if len(x) < nfft:
                continue
            starts = range(0, len(x) - nfft + 1, hop)
            batch = []
            for s in starts:
                batch.append(x[s:s + nfft])
                if len(batch) == 32:
                    acc += _batch_power(np.stack(batch), win)
                    frames += len(batch)
                    batch = []
            if batch:
                acc += _batch_power(np.stack(batch), win)
                frames += len(batch)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sample_rate)
    if frames == 0:
        return freqs, acc, 0
    power = acc / frames / (wpow * nfft)
    power[1:-1] *= 2.0        # one-sided
    return freqs, power, frames


def _batch_power(frames: np.ndarray, win: np.ndarray) -> np.ndarray:
    spec = np.fft.rfft(frames.astype(np.float64) * win, axis=1)
    return np.sum(spec.real ** 2 + spec.imag ** 2, axis=0)


def _db(p: float) -> float:
    return 10.0 * np.log10(max(p, 1e-20))


# --- hum --------------------------------------------------------------------

def _line(freqs: np.ndarray, power: np.ndarray, f: float, bin_hz: float):
    """(peak_bin_index, prominence_db, excess_power) of a spectral line near ``f``."""
    tol = max(HUM_TOLERANCE * f, 1.5 * bin_hz)
    sel = np.flatnonzero((freqs >= f - tol) & (freqs <= f + tol))
    if sel.size == 0:
        return None
    pk = int(sel[np.argmax(power[sel])])
    lo = np.flatnonzero((freqs >= f - 16.0) & (freqs <= f - 5.0))
    hi = np.flatnonzero((freqs >= f + 5.0) & (freqs <= f + 16.0))
    ring = np.concatenate([lo, hi])
    if ring.size < 6:
        return None
    floor = float(np.percentile(power[ring], 30))
    if floor <= 0:
        return None
    width = 2                      # Hann main lobe: peak +/- 2 bins
    line_bins = slice(max(pk - width, 0), pk + width + 1)
    excess = float(np.sum(power[line_bins]) - floor * (2 * width + 1))
    return pk, _db(power[pk]) - _db(floor), max(excess, 0.0)


def detect_hum(freqs: np.ndarray, power: np.ndarray) -> dict:
    """Look for 50/60 Hz and harmonics standing above the neighbouring floor.

    Returns ``{detected: 50|60|None, level_dbfs, prominence_db, harmonics: [Hz...]}``;
    ``level_dbfs`` is the combined RMS of the detected lines, ``harmonics`` their
    nominal frequencies, ``prominence_db`` the strongest line's height over its floor.
    """
    none = {"detected": None, "level_dbfs": None, "prominence_db": None, "harmonics": []}
    if len(freqs) < 8 or not np.any(power > 0):
        return none
    bin_hz = float(freqs[1] - freqs[0])
    best = None
    for f0 in HUM_FREQS:
        found, level_p, strongest = [], 0.0, 0.0
        k = 1
        while f0 * k <= HUM_MAX_HZ:
            f = f0 * k
            k += 1
            if f in HUM_SHARED_HZ:
                continue
            info = _line(freqs, power, f, bin_hz)
            if info is None:
                continue
            _, prom, excess = info
            if prom >= HUM_PROMINENCE_DB:
                found.append((f, prom))
                level_p += excess
                strongest = max(strongest, prom)
        ok = len(found) >= 2 or strongest >= HUM_STRONG_DB
        if not ok:
            continue
        evidence = sum(min(p, 30.0) for _, p in found)
        if best is None or evidence > best[0]:
            best = (evidence, f0, found, level_p, strongest)
    if best is None:
        return none
    _, f0, found, level_p, strongest = best
    level = _db(level_p)
    if level < HUM_MIN_LEVEL_DBFS:
        return none
    return {
        "detected": int(f0),
        "level_dbfs": round(float(level), 1),
        "prominence_db": round(float(strongest), 1),
        "harmonics": [int(f) for f, _ in found],
    }


# --- surface-noise profile --------------------------------------------------

def band_slices(freqs: np.ndarray) -> List[np.ndarray]:
    edges = (0.0,) + tuple(float(e) for e in NOISE_BAND_EDGES_HZ) + (float(freqs[-1]) + 1.0,)
    return [np.flatnonzero((freqs >= a) & (freqs < b)) for a, b in zip(edges[:-1], edges[1:])]


def noise_profile(freqs: np.ndarray, power: np.ndarray, sample_rate: int) -> Optional[dict]:
    """Surface-noise level per afftdn band.

    ``band_dbfs[i]`` is the white-noise-equivalent RMS (dBFS) of band *i*: the RMS a
    white noise with that band's spectral density would have, so a white hiss reads
    the same in every band.  Medians over the band's bins ignore hum lines.
    ``floor_dbfs`` is the median over the mid/high bands (>= ~215 Hz), where hiss lives.
    """
    if len(freqs) < 8 or not np.any(power > 0):
        return None
    nfft = (len(freqs) - 1) * 2
    levels = []
    for idx in band_slices(freqs):
        if idx.size == 0:
            levels.append(None)
            continue
        levels.append(_db(float(np.median(power[idx])) * (nfft / 2.0)))
    known = [v for v in levels[3:] if v is not None]
    if not known:
        return None
    floor = float(np.median(known))
    fill = [round(float(v) if v is not None else floor - BN_LIMIT_DB, 1) for v in levels]
    return {"floor_dbfs": round(floor, 1), "band_dbfs": fill}


def analyze_pcm(segments: Sequence[np.ndarray], sample_rate: int) -> dict:
    """Hum + noise profile of already-decoded silent segments."""
    freqs, power, frames = averaged_power_spectrum(segments, sample_rate)
    if frames < 4:
        return {"hum": detect_hum(freqs, np.zeros_like(power)), "noise": None, "frames": frames}
    return {"hum": detect_hum(freqs, power), "noise": noise_profile(freqs, power, sample_rate),
            "frames": frames}


def analyze_source(source, db: np.ndarray, frame_s: float, sample_rate: int) -> dict:
    """Full analysis of a source file from its envelope: pick the silent stretches,
    decode just those, and analyse.  The result is JSON-ready."""
    ranges = silent_ranges(db, frame_s)
    result = {"version": ANALYSIS_VERSION, "analyzed_s": round(sum(b - a for a, b in ranges), 1),
              "sample_rate": sample_rate}
    if not ranges:
        result.update(hum=detect_hum(np.zeros(8), np.zeros(8)), noise=None)
        return result
    segs = decode_ranges(source, ranges, sample_rate)
    result.update(analyze_pcm(segs, sample_rate))
    return result


# --- cache ------------------------------------------------------------------

def cache_path(session_dir: Path) -> Path:
    return Path(session_dir) / "silence_analysis.json"


def read_cache(path: Path) -> Optional[dict]:
    try:
        data = json.loads(Path(path).read_text())
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("version") != ANALYSIS_VERSION or "hum" not in data:
        return None
    return data


def write_cache(path: Path, payload: dict) -> bool:
    path = Path(path)
    part = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.part")
    try:
        part.write_text(json.dumps(payload))
        os.replace(part, path)
        return True
    except OSError:
        part.unlink(missing_ok=True)
        return False
