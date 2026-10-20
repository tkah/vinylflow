"""
VinylFlow - Audio Processing Module

Handles silence detection, track splitting, and audio format conversion.
Uses FFmpeg for audio analysis and format conversion.
Supports FLAC, MP3, and AIFF output formats.
"""

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple, Optional

# Track Boundary calculation lives in its own pure module.  Re-export Track
# so existing callers that do ``from audio_processor import Track`` keep
# working — the dependency arrow stays one-way (audio_processor ->
# track_boundaries, no import cycle).
from track_boundaries import (
    Track,
    boundaries_for_track_count,
    boundaries_from_gaps,
    envelope_from_pcm,
    gaps_from_envelope,
    parse_silence_log,
    refine_cuts,
)

# Energy envelope: one mono decode at a low sample rate, RMS per 10 ms frame.
ENVELOPE_SAMPLE_RATE = 8000
ENVELOPE_FRAME_S = 0.01


def _ffmpeg() -> str:
    """Return the ffmpeg executable to use.

    In a bundled (PyInstaller) build the launcher sets VINYLFLOW_FFMPEG_PATH
    to the absolute path of the bundled binary.  Fall back to bare 'ffmpeg'
    so plain source-code runs still work.
    """
    return os.environ.get("VINYLFLOW_FFMPEG_PATH") or "ffmpeg"


def run_ffmpeg(args: list, *, text: bool = True, **kwargs) -> subprocess.CompletedProcess:
    """Run ffmpeg with the bundled binary path + correct text-mode defaults.

    All ffmpeg invocations across the project must go through this seam,
    not call ``subprocess.run(["ffmpeg", ...])`` directly — bundled
    builds depend on ``VINYLFLOW_FFMPEG_PATH`` and Windows requires
    utf-8/replace decoding so non-ASCII filenames don't crash the
    subprocess module.

    ``text=True`` (default) captures stdout/stderr as utf-8 strings with
    error replacement — correct for parsing ffmpeg's stderr (silence
    detection, duration probing).  Pass ``text=False`` when you need
    raw bytes (e.g. piping PCM through stdout for waveform peaks).

    All other ``subprocess.run`` kwargs flow through unchanged.
    """
    cmd = [_ffmpeg(), *args]
    if text:
        kwargs.setdefault("encoding", "utf-8")
        kwargs.setdefault("errors", "replace")
    return subprocess.run(cmd, **kwargs)


_DURATION_HEADER_RE = re.compile(r"Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})")


def parse_duration_header(ffmpeg_stderr: str) -> Optional[float]:
    """Parse total duration in seconds from ffmpeg's stderr header, or None."""
    match = _DURATION_HEADER_RE.search(ffmpeg_stderr or "")
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


_STREAM_AUDIO_RE = re.compile(r"Stream #\S+.*?Audio:\s*([^\n]*)")
_PCM_CODEC_RE = re.compile(r"\bpcm_([suf])(\d+)(?:le|be)\b")
_BIT_ANNOTATION_RE = re.compile(r"\((\d+) bit\)")
# ffmpeg sample-format token, e.g. "44100 Hz, stereo, s16, ..." (fallback for non-PCM codecs)
_SAMPLE_FMT_RE = re.compile(r",\s*(u8|s16|s32|s64|flt|dbl)p?\b")


_SAMPLE_RATE_RE = re.compile(r"Audio:.*?,\s*(\d+) Hz")


def parse_sample_rate(ffmpeg_stderr: str) -> Optional[int]:
    """Sample rate of the first audio stream from ffmpeg's header dump."""
    m = _SAMPLE_RATE_RE.search(ffmpeg_stderr or "")
    return int(m.group(1)) if m else None


def parse_source_bit_depth(ffmpeg_stderr: str) -> Optional[int]:
    """Map ffmpeg's first audio stream line to an export depth: 16 or 24.

    ``<= 16`` bits -> 16; anything wider (24/32-bit int, float) -> 24;
    unrecognised or missing -> None (export then errs on the side of 24).  An explicit ``(24 bit)`` annotation wins
    over the codec name, which is how ffmpeg labels e.g. 24-bit in s32 words.
    """
    match = _STREAM_AUDIO_RE.search(ffmpeg_stderr or "")
    if not match:
        return None
    line = match.group(1)
    bits: Optional[int] = None
    annotation = _BIT_ANNOTATION_RE.search(line)
    if annotation:
        bits = int(annotation.group(1))
    else:
        codec = _PCM_CODEC_RE.search(line)
        if codec:
            kind, width = codec.group(1), int(codec.group(2))
            bits = 32 if kind == "f" else width
        else:
            fmt = _SAMPLE_FMT_RE.search(line)
            if fmt:
                bits = {"u8": 8, "s16": 16}.get(fmt.group(1), 32)
    if bits is None:
        return None
    return 16 if bits <= 16 else 24


def target_bit_depth(setting: str, source_depth: Optional[int]) -> int:
    """Resolve the ``bit_depth`` setting ("source" | "24") to 16 or 24.

    Only a source known to be 16-bit exports at 16; an unknown depth exports
    at 24 so a 24-bit source can never be truncated.
    """
    if setting == "24":
        return 24
    return 16 if source_depth == 16 else 24


# --- Export filter chain -----------------------------------------------------

# highpass=f=15: removes inaudible turntable motor rumble (below 15 Hz) without touching bass.
RUMBLE_FILTER = "highpass=f=15"

# Zero-phase form for the A/B "Removed" render only (a plain high-pass's phase shift leaks a
# "ghost" of the music into original - processed: ~25 % of a 60 Hz line).  Forward + reverse
# (``areverse``) squares the magnitude, so the pass must be the "square root" of the export
# filter: |G|^2 = |H|, H = 2-pole Butterworth at 15 Hz.  A single 1-pole pass is 3 dB off at
# the corner; a 2-pole pass with f=7.5 Hz, Q=0.515 (nearly two real poles) fitted to |H| over
# 5-200 Hz is within 0.9 dB everywhere (tests/test_rumble_zero_phase.py).  Chunked like the hum.
RUMBLE_ZERO_PHASE_PASS = "highpass=f=7.5:width_type=q:w=0.515"
RUMBLE_FILTER_ZERO_PHASE = (
    f"aformat=sample_fmts=dblp,{RUMBLE_ZERO_PHASE_PASS},areverse,{RUMBLE_ZERO_PHASE_PASS},areverse"
)

# Click & pop removal strengths -> adeclick settings. Chosen by measurement
# (tests/test_declick_strength.py: synthetic music + hiss + drum-like transients +
# 120 known clicks, 0.03-0.6 amplitude). Findings: the burst-fusion parameter ``b``
# and the AR window ``w`` (ms) drive transient damage far more than ``t``; a short
# window (w=30) keeps drum hits intact while a lower threshold ``t`` finds fainter
# clicks, but t<=1.2 becomes ~20x slower (false positives), so Strong stops at 1.5.
#   light  (t=2.5, b=3, w=30)       ~88% removed, damage 0.020 (retuned, plan 07 slice 1b)
#   medium (t=1.8, b=3, w=30)       ~96% removed, damage 0.043, as fast as light
#   strong (t=1.5, b=3, w=30)       ~98% removed, damage 0.063, ~5x slower than light
# LEGACY_LIGHT (documentation only, not used): the original Restore setting was
# "adeclick=t=3:b=3" (86% removed, damage 0.073).  It removed fewer clicks *and*
# damaged transients more than medium, so Light was retuned to a shorter AR window:
#   candidate            removed  damage
#   t=3:b=3 (old)         0.858   0.073
#   t=3:b=3:w=30          0.850   0.012
#   t=3:b=2:w=30          0.758   0.007
#   t=3:b=3:w=40          0.858   0.032
#   t=2.5:b=3:w=30        0.883   0.020   <- chosen
#   t=2.2:b=3:w=30        0.908   0.028
# Exports made with "light" therefore sound slightly different from before.
DECLICK_PRESETS = {
    "light": "adeclick=t=2.5:b=3:w=30",
    "medium": "adeclick=t=1.8:b=3:w=30",
    "strong": "adeclick=t=1.5:b=3:w=30",
}
DECLICK_LEVELS = ("off",) + tuple(DECLICK_PRESETS)

# Legacy ``restoration_level`` 1 (rumble + clicks) -> new settings.
LEGACY_RESTORE = (True, "light")

# --- Mains-hum notch (plan 07 slice 4) ---------------------------------------
# Narrow ``bandreject`` notches (2nd-order biquads) at the fundamental and its first
# harmonics.  Chosen by measurement (tests/hum_measure.py, tests/test_hum_filter.py):
# synthetic music with a bass line sitting 1-3 % off the harmonics + kicks, and hum of
# 7 harmonics at -45..-55 dBFS.  Q trades depth under mains drift against bass damage:
#
#   Q    min cut @0.1 %   @0.2 %   @0.3 % drift     bass-line damage   ghost >400 Hz
#   12   32 dB            26 dB    23 dB             -5.8 dB            -16 dB
#   20   28 dB            22 dB    18 dB             -8.1 dB            -21 dB   <- chosen
#   30   24 dB            18 dB    15 dB             -10.1 dB           -24 dB
#   50   20 dB            14 dB    11 dB             -12.9 dB           -29 dB
#
# Q=20 keeps >= 20 dB for +-0.2 % mains drift (exact-frequency hum: >100 dB).  Six harmonics
# (60 -> 360 Hz, 50 -> 300 Hz): above that the hum is negligible and every extra notch only
# adds bass damage.  Alternatives measured and rejected: a squared band-pass subtracted
# stage by stage leaks less phase "ghost" above 400 Hz but lifts the whole 100-400 Hz range
# by +1..2.5 dB; ``firequalizer`` cannot resolve a 3 Hz notch (max ~13k taps).
#
# A notch's phase shift leaks a faint ghost of the music into ``original - processed``
# (-21 dB re the music above 400 Hz, -31 dB above 1 kHz): inaudible in the export, but
# misleading in the "Removed" render, which must hold the hum and not the song.  That render
# therefore uses the zero-phase form (``zero_phase=True``: forward and backward pass, ghost
# < -50 dB) -- it needs the whole range in memory, so it is rendered in short chunks.
HUM_FREQS = (50, 60)
HUM_NOTCH_Q = 20
HUM_HARMONICS = 6


def hum_filter(
    freq: int,
    zero_phase: bool = False,
    q: float = HUM_NOTCH_Q,
    harmonics: int = HUM_HARMONICS,
) -> str:
    """``bandreject`` cascade removing ``freq`` Hz mains hum and its harmonics.

    Runs in double precision: with the s16 samples of a 16-bit source the narrow biquads
    would otherwise round after every stage (measured: ~25 dB instead of >100 dB at 96 kHz).
    ``zero_phase`` filters forward and backward (``areverse``): no phase shift, |H|^2
    magnitude, but the whole stream is buffered -- for short chunks only (see above)."""
    if freq not in HUM_FREQS:
        raise ValueError(f"hum frequency must be 50 or 60 Hz, got {freq!r}")
    notches = ",".join(
        f"bandreject=f={freq * k}:width_type=q:w={q:g}" for k in range(1, harmonics + 1)
    )
    chain = f"aformat=sample_fmts=dblp,{notches}"
    if zero_phase:
        chain += f",areverse,{notches},areverse"
    return chain


# --- Hiss reduction (plan 07 slice 4) ------------------------------------------
# ``afftdn`` with a per-file noise profile.  tests/hiss_measure.py + tests/test_hiss_reduction.py
# (synthetic tones + cymbals/kicks + white/pink/vinyl-shaped hiss, -70..-46 dBFS):
#  * With afftdn's fixed noise floor (nf=-50) the same nr=20 delivers 3.8 dB on a noisy record
#    (-46 dBFS hiss), 20 dB at -58, and a full 20 dB on a -70 record whose music would be
#    over-reduced too; coloured (vinyl-shaped) hiss with nt=v: 1.8-20 dB.  Noise *tracking*
#    (tn=1) ignores nf and gives 3-19 dB with a gritty residual ("musical noise" index 1.4-1.8).
#  * afftdn's 15 custom bands (nt=c, bn=...) fed with the noise measured in the file's own
#    silent stretches (silence_analysis.noise_profile) make ``nr`` mean what it says: the
#    reduction in the noise band equals ``nr`` (+-0.2 dB) for white, pink and vinyl-shaped hiss
#    alike at every noise level from -70 to -46 dBFS, with a clean residual (index ~1.0), at
#    nf = measured noise + 6 dB (+4 already saturates; +8 starts to dull on noisy records).
#  * Damage on the synthetic music: tones < 0.1 dB, cymbal/hat energy < 0.1 dB (-0.8 dB on the
#    noisiest -46 dBFS record), very quiet HF flicks sitting 7 dB over the hiss < 0.5 dB.  These
#    are synthetic: real cymbal tails and reverb below the hiss floor are the open risk, hence
#    "strong".  Speed: ~0.1 s per minute of stereo audio, the same for every strength.
#   light  nr=6   about 6 dB less hiss, no audible side effects
#   medium nr=12  clearly quieter
#   strong nr=20  hiss mostly gone; can dull very quiet cymbal tails on real music
HISS_PRESETS = {"light": 6, "medium": 12, "strong": 20}
HISS_LEVELS = ("off",) + tuple(HISS_PRESETS)
HISS_NF_MARGIN_DB = 6.0          # nf = measured noise floor + this
HISS_FALLBACK_NF = -55.0         # no profile (no usable silence): generic vinyl noise, tracked
HISS_FALLBACK_MAX_NR = 12
NOISE_BANDS = 15                 # afftdn's custom noise bands


@dataclass(frozen=True)
class NoiseProfile:
    """Surface-noise level of a recording, as measured in its silent stretches."""

    floor_dbfs: float                 # white-equivalent RMS of the mid/high bands
    bands_dbfs: Tuple[float, ...]     # per afftdn band, white-equivalent RMS (dBFS)

    @classmethod
    def from_analysis(cls, data) -> Optional["NoiseProfile"]:
        """From ``silence_analysis`` output (``{"floor_dbfs", "band_dbfs"}``) or None."""
        if not isinstance(data, dict):
            return None
        try:
            bands = tuple(float(x) for x in data["band_dbfs"])
            floor = float(data["floor_dbfs"])
        except (KeyError, TypeError, ValueError):
            return None
        if len(bands) != NOISE_BANDS:
            return None
        return cls(floor, bands)


def hiss_filter(strength: str, noise: Optional[NoiseProfile] = None) -> str:
    """``afftdn`` filter for a hiss-reduction strength.

    With a ``noise`` profile the filter is told the file's own noise floor and its
    spectral shape; without one it falls back to a generic, tracking vinyl setting.
    """
    if strength not in HISS_PRESETS:
        raise ValueError(f"unknown hiss strength: {strength!r}")
    nr = HISS_PRESETS[strength]
    if noise is None:
        # Unknown noise: afftdn's own tracking (it ignores nf then), measured at 0.5-10 dB
        # depending on the record -- capped at 12 so a quiet record is never over-reduced.
        return f"afftdn=nr={min(nr, HISS_FALLBACK_MAX_NR)}:nf={HISS_FALLBACK_NF:.0f}:nt=v:tn=1"
    nf = min(max(noise.floor_dbfs + HISS_NF_MARGIN_DB, -80.0), -20.0)
    bn = "|".join(f"{min(max(b - noise.floor_dbfs, -24.0), 24.0):.1f}" for b in noise.bands_dbfs)
    return f"afftdn=nr={nr}:nf={nf:.1f}:nt=c:bn={bn}"


DITHER_TO_16 = "aresample=osf=s16:dither_method=triangular"


def split_export_filters(
    rumble: bool,
    declick: str = "off",
    gain_db: Optional[float] = None,
    dither_to_16: bool = False,
    hum: int = 0,
    hiss: str = "off",
    noise: Optional[NoiseProfile] = None,
    zero_phase_hum: bool = False,
    zero_phase_rumble: bool = False,
) -> Optional[Tuple[str, Optional[str]]]:
    """``(main_chain, dither)`` pieces of the export chain, or None when there is
    no processing.  ``main_chain`` is rumble -> hum notch -> declick -> hiss
    reduction -> volume; ``dither`` is the trailing 16-bit conversion (None
    unless ``dither_to_16``).  Kept apart so padded cuts can trim between the two.

    ``hum`` is the mains frequency (50/60) or 0/None for off; ``hiss`` is
    off|light|medium|strong with an optional per-file ``noise`` profile.
    ``zero_phase_hum`` swaps in the buffered forward-backward notch (chunked "Removed"
    renders only), as does ``zero_phase_rumble`` for the rumble high-pass."""
    filters = [RUMBLE_FILTER_ZERO_PHASE if zero_phase_rumble else RUMBLE_FILTER] if rumble else []
    if hum:
        filters.append(hum_filter(hum, zero_phase_hum))
    if declick and declick != "off":
        if declick not in DECLICK_PRESETS:
            raise ValueError(f"unknown declick strength: {declick!r}")
        filters.append(DECLICK_PRESETS[declick])
    if hiss and hiss != "off":
        filters.append(hiss_filter(hiss, noise))
    if gain_db is not None:
        filters.append(f"volume={gain_db:.3f}dB")
    if not filters:
        return None
    return ",".join(filters), (DITHER_TO_16 if dither_to_16 else None)


def build_export_filters(
    rumble: bool,
    declick: str = "off",
    gain_db: Optional[float] = None,
    dither_to_16: bool = False,
    hum: int = 0,
    hiss: str = "off",
    noise: Optional[NoiseProfile] = None,
    zero_phase_hum: bool = False,
    zero_phase_rumble: bool = False,
) -> Optional[str]:
    """Build the ffmpeg ``-af`` chain used for export (and loudness measurement).

    Order: rumble filter -> mains-hum notch (``hum`` = 50|60) -> click/pop
    removal (``declick`` = off|light|medium|strong) -> hiss reduction (``hiss`` =
    off|light|medium|strong; after the declicker so the denoiser never smears a
    click) -> a pure ``volume=<gain>dB`` when ``gain_db`` is given.  When
    processing runs and ``dither_to_16`` is set, the chain ends with a
    triangular-dithered 16-bit conversion.  Returns None when there is no
    processing (the chain is never just a dither, so unprocessed 16->16 stays
    bit-exact).  Shared by export, album-gain measurement and the A/B test so
    the filter strings live in one place.
    """
    parts = split_export_filters(
        rumble, declick, gain_db, dither_to_16, hum, hiss, noise, zero_phase_hum,
        zero_phase_rumble,
    )
    if parts is None:
        return None
    main, dither = parts
    return f"{main},{dither}" if dither else main


# Filtered cuts are decoded with this much extra audio on each side so the
# filters' start-up transients (highpass settling, adeclick's first window) land
# outside the part that is kept.
FILTER_PAD_S = 1.0


def padded_window(
    start: float,
    end: float,
    total_duration: float,
    sample_rate: int,
    pad_s: float = FILTER_PAD_S,
) -> Tuple[float, float, int, int]:
    """Plan a padded read of ``[start, end]``.

    Returns ``(seek_s, read_dur_s, trim_start_sample, trim_end_sample)``: read
    ``read_dur_s`` seconds from ``seek_s`` (``max(0, start-pad)`` to
    ``min(total, end+pad)``), filter, then keep samples
    ``[trim_start_sample, trim_end_sample)`` of the read.  The read start is
    snapped to a whole sample, so the kept length is exactly
    ``round(end*sr) - round(start*sr)`` and sample-aligned with an unpadded cut.
    """
    s0 = int(round(start * sample_rate))
    s1 = int(round(end * sample_rate))
    r0 = max(0, s0 - int(round(pad_s * sample_rate)))
    seek_s = r0 / sample_rate
    read_end = min(float(total_duration), end + pad_s)
    read_dur = max(read_end - seek_s, 0.0)
    return seek_s, read_dur, s0 - r0, s1 - r0


def trim_filter(trim_start: int, trim_end: int) -> str:
    """Keep samples ``[trim_start, trim_end)`` and restart timestamps at 0."""
    return f"atrim=start_sample={trim_start}:end_sample={trim_end},asetpts=PTS-STARTPTS"


def seek_args(seek_s: float, read_dur: float) -> List[str]:
    return ["-ss", f"{seek_s:.9f}", "-t", f"{read_dur:.9f}"]


def removed_graph(
    chain: str, channels: int = 2, trim: Optional[Tuple[int, int]] = None
) -> str:
    """ffmpeg filter_complex giving ``original - chain(original)`` per channel
    (output label ``[out]``).  Same asplit/amerge/pan-difference technique as
    click_detection.residual_graph, but keeps the channel layout (stereo stays
    left-left' / right-right').  ``chain`` must contain only the clean-up
    filters: gain and dither would make the residual the whole song scaled.

    ``trim`` = (start_sample, end_sample) for a padded read: both the original
    and the filtered branch are trimmed identically so they stay aligned."""
    if channels == 1:
        pan = "pan=mono|c0=c0-c1"
        fmt = "aformat=sample_fmts=fltp:channel_layouts=mono"
    else:
        pan = "pan=stereo|c0=c0-c2|c1=c1-c3"
        fmt = "aformat=sample_fmts=fltp:channel_layouts=stereo"
    if trim is None:
        return (
            f"[0:a]{fmt},asplit[a][b];[b]{chain}[c];"
            f"[a][c]amerge=inputs=2,{pan}[out]"
        )
    cut = trim_filter(*trim)
    return (
        f"[0:a]{fmt},asplit[a][b];[b]{chain},{cut}[c];[a]{cut}[a2];"
        f"[a2][c]amerge=inputs=2,{pan}[out]"
    )


# The "Removed" render of a chain holding the zero-phase hum notch / rumble filter buffers what it filters
# (``areverse``), so it is rendered in chunks with this much context on each side.
REMOVED_CHUNK_S = 40.0
REMOVED_CONTEXT_S = 3.0


def plan_removed_chunks(
    start: float, end: float, sample_rate: int, chunk_s: float = REMOVED_CHUNK_S
) -> List[Tuple[float, float]]:
    """Split ``[start, end]`` into consecutive spans of ~``chunk_s`` on whole-sample
    boundaries: they tile the range exactly (no sample twice, none missing)."""
    s0 = int(round(start * sample_rate))
    s1 = int(round(end * sample_rate))
    step = max(int(round(chunk_s * sample_rate)), 1)
    edges = list(range(s0, s1, step)) + [s1]
    return [(a / sample_rate, b / sample_rate) for a, b in zip(edges[:-1], edges[1:]) if b > a]


# --- Loudness measurement (EBU R128 via ffmpeg ebur128=peak=true) -------------

ALBUM_TARGET_LUFS = -14.0
ALBUM_PEAK_CEILING_DBTP = -1.0
REPLAYGAIN_REFERENCE_LUFS = -18.0

# ebur128 reports -70.0 LUFS (its absolute gate floor) for silence.
_SILENCE_FLOOR_LUFS = -69.9

_EBUR_I_RE = re.compile(r"^\s*I:\s*(-?inf|-?\d+(?:\.\d+)?)\s*LUFS", re.MULTILINE)
_EBUR_PEAK_RE = re.compile(r"^\s*Peak:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dBFS", re.MULTILINE)


@dataclass(frozen=True)
class Loudness:
    """Integrated loudness (LUFS) and true peak (dBTP) of some audio."""

    integrated: float
    true_peak: float


@dataclass(frozen=True)
class LoudnessSource:
    """A recording's active ranges and the cleanup chain used for their export."""

    path: Path
    ranges: list[tuple]
    rumble: bool = False
    declick: str = "off"
    hum: int = 0
    hiss: str = "off"
    noise: Optional[NoiseProfile] = None


def parse_ebur128_summary(ffmpeg_stderr: str) -> Optional[Loudness]:
    """Parse the ``Summary:`` block printed by ``ebur128=peak=true``.

    Only the text after the last ``Summary:`` is read, so the per-frame
    log lines (which also contain ``I:``) are ignored.  Returns None when
    there is no summary, or when the audio was silent (I at the -70 LUFS
    floor, or an -inf value) so callers never compute a gain from nothing.
    """
    text = ffmpeg_stderr or ""
    idx = text.rfind("Summary:")
    if idx < 0:
        return None
    summary = text[idx:]
    i_match = _EBUR_I_RE.search(summary)
    p_match = _EBUR_PEAK_RE.search(summary)
    if not i_match or not p_match:
        return None
    integrated = float(i_match.group(1))
    peak = float(p_match.group(1))
    if integrated != integrated or peak != peak:
        return None
    if integrated <= _SILENCE_FLOOR_LUFS or integrated in (float("inf"), float("-inf")):
        return None
    if peak in (float("inf"), float("-inf")):
        return None
    return Loudness(integrated=integrated, true_peak=peak)


def album_gain_db(
    loudness: Optional[Loudness],
    target: float = ALBUM_TARGET_LUFS,
    peak_ceiling: float = ALBUM_PEAK_CEILING_DBTP,
) -> Optional[float]:
    """Single gain (dB) taking the album to ``target`` LUFS without pushing
    the true peak above ``peak_ceiling`` dBTP.  May be negative."""
    if loudness is None:
        return None
    return min(target - loudness.integrated, peak_ceiling - loudness.true_peak)


def replaygain_gain_db(loudness: Loudness) -> float:
    """ReplayGain 2.0 gain: -18 LUFS reference minus integrated loudness."""
    return REPLAYGAIN_REFERENCE_LUFS - loudness.integrated


def format_replaygain_gain(gain_db: float) -> str:
    """e.g. ``-3.20 dB`` / ``+1.05 dB``."""
    return "%+.2f dB" % gain_db


def format_replaygain_peak(true_peak_dbtp: float) -> str:
    """Linear peak (1.0 = full scale) from a dBTP value, 6 decimals."""
    return "%.6f" % (10 ** (true_peak_dbtp / 20.0))


def _aselect_ranges_filter(ranges: List[Tuple[float, float]]) -> str:
    expr = "+".join(f"between(t,{a:.6f},{b:.6f})" for a, b in ranges)
    return f"aselect='{expr}',asetpts=N/SR/TB"


# Supported input formats
SUPPORTED_INPUT_EXTENSIONS = {".wav", ".aiff", ".aif"}

# Output format configurations: codec flags for FFmpeg + file extension
OUTPUT_FORMATS = {
    "flac": {
        "extension": ".flac",
        "codec_args": ["-c:a", "flac"],
        "label": "FLAC (Lossless)",
    },
    "mp3": {
        "extension": ".mp3",
        "codec_args": ["-c:a", "libmp3lame", "-b:a", "320k"],
        "label": "MP3 (320kbps)",
    },
    "aiff": {
        "extension": ".aiff",
        "codec_args": ["-c:a", "pcm_s16be"],  # pcm_s24be at 24-bit, see depth_codec_args
        "label": "AIFF (Lossless)",
    },
}


def depth_codec_args(output_format: str, bit_depth: int) -> List[str]:
    """Extra codec args pinning the output sample depth (FLAC/AIFF only)."""
    if output_format == "flac":
        if bit_depth == 24:
            return ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
        return ["-sample_fmt", "s16"]
    if output_format == "aiff":
        return ["-c:a", "pcm_s24be" if bit_depth == 24 else "pcm_s16be"]
    return []


class AudioProcessor:
    """Handles audio processing operations."""

    def __init__(
        self,
        silence_threshold=-40,
        min_silence_duration=1.5,
        min_track_length=30,
        flac_compression=8,
    ):
        """
        Initialize audio processor.

        Args:
            silence_threshold: Silence threshold in dB (negative)
            min_silence_duration: Minimum silence duration in seconds
            min_track_length: Minimum track length in seconds
            flac_compression: FLAC compression level (0-8)
        """
        self.silence_threshold = silence_threshold
        self.min_silence_duration = min_silence_duration
        self.min_track_length = min_track_length
        self.flac_compression = flac_compression
        # (path, mtime_ns, size) -> (duration, sample_rate); one header read per source.
        self._probe_cache: dict = {}

    def probe_info(self, file_path: Path) -> Tuple[Optional[float], Optional[int]]:
        """(duration seconds, sample rate Hz), cached per source file."""
        try:
            st = Path(file_path).stat()
            key = (str(file_path), st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key is not None and key in self._probe_cache:
            return self._probe_cache[key]
        try:
            result = run_ffmpeg(["-i", str(file_path)], capture_output=True, timeout=30)
            info = (parse_duration_header(result.stderr), parse_sample_rate(result.stderr))
        except Exception as e:
            print(f"Error probing audio: {e}")
            return None, None
        if key is not None and info[0] is not None and info[1]:
            self._probe_cache[key] = info
        return info

    def padded_cut(self, file_path: Path, start: float, end: float):
        """``padded_window`` for a cut of ``file_path`` or None if the source
        can't be probed (callers then fall back to an unpadded cut)."""
        duration, rate = self.probe_info(file_path)
        if not duration or not rate:
            return None
        return padded_window(start, end, duration, rate)

    def get_audio_duration(self, file_path: Path) -> Optional[float]:
        """
        Get total duration of audio file in seconds.

        Args:
            file_path: Path to audio file

        Returns:
            Duration in seconds, or None if error
        """
        try:
            # No output target: ffmpeg prints the Duration header and exits
            # nonzero without decoding the file, so this is O(1) in file size.
            result = run_ffmpeg(
                ["-i", str(file_path)],
                capture_output=True,
                timeout=30,
            )

            return parse_duration_header(result.stderr)
        except Exception as e:
            print(f"Error getting audio duration: {e}")
            return None

    def probe_audio(self, file_path: Path) -> Tuple[Optional[float], int]:
        """One ffmpeg header read -> (duration seconds or None, source bit depth 16|24)."""
        try:
            result = run_ffmpeg(["-i", str(file_path)], capture_output=True, timeout=30)
            duration = parse_duration_header(result.stderr)
            rate = parse_sample_rate(result.stderr)
            try:
                st = Path(file_path).stat()
                if duration is not None and rate:
                    self._probe_cache[(str(file_path), st.st_mtime_ns, st.st_size)] = (duration, rate)
            except OSError:
                pass
            return duration, parse_source_bit_depth(result.stderr)
        except Exception as e:
            print(f"Error probing audio: {e}")
            return None, 16

    def detect_silence(self, file_path: Path, verbose=False) -> List[Track]:
        """
        Detect silence in audio file and return track boundaries.

        Args:
            file_path: Path to audio file
            verbose: Print detailed output

        Returns:
            List of Track objects
        """
        if verbose:
            print(f"Detecting silence in: {file_path.name}")
            print(
                f"Threshold: {self.silence_threshold}dB, Min duration: {self.min_silence_duration}s"
            )

        try:
            gaps, total_duration = self._scan_gaps(
                file_path, self.silence_threshold, self.min_silence_duration
            )

            tracks = boundaries_from_gaps(gaps, total_duration, self.min_track_length)

            if verbose:
                print(f"\nDetected {len(tracks)} tracks:")
                for track in tracks:
                    print(f"  {track}")

            return tracks

        except subprocess.TimeoutExpired:
            raise RuntimeError("Silence detection timed out (>5 minutes)")
        except Exception as e:
            raise RuntimeError(f"Silence detection failed: {e}")

    def _scan_gaps(self, file_path: Path, threshold: float, min_duration: float):
        """Run one ffmpeg silencedetect pass and return (gaps, total_duration).

        Owns the ffmpeg subprocess; parsing Gaps and computing Track
        Boundaries stay in the pure ``track_boundaries`` module.
        """
        args = [
            "-i",
            str(file_path),
            "-af",
            f"silencedetect=noise={threshold}dB:duration={min_duration}",
            "-f",
            "null",
            "-",
        ]

        result = run_ffmpeg(args, capture_output=True, timeout=300)

        gaps = parse_silence_log(result.stderr)

        # The silencedetect run's stderr already contains the Duration
        # header, so avoid a second ffmpeg probe of the same file.
        total_duration = parse_duration_header(result.stderr)
        if total_duration is None:
            total_duration = self.get_audio_duration(file_path)
        if total_duration is None:
            raise ValueError("Could not determine audio duration")

        return gaps, total_duration

    # Smart Rescan scan ladder.  Each pass is a full-file ffmpeg decode, so
    # the first pass is permissive enough (-30dB, 0.3s) to surface nearly
    # every real inter-track gap as a candidate in one decode — picking the
    # right ones happens in pure Python (boundaries_for_track_count), not in
    # more ffmpeg runs.  Later passes escalate for very noisy records whose
    # surface noise sits above the previous threshold.
    SMART_RESCAN_LADDER = [(-30.0, 0.3), (-25.0, 0.25), (-20.0, 0.2)]

    def detect_tracks_for_count(self, file_path: Path, target_count: int):
        """Find the split that yields exactly ``target_count`` tracks.

        Args:
            file_path: Path to audio file
            target_count: How many tracks the recording should contain

        Returns:
            (tracks, scan_info) where scan_info holds the settings of the
            pass that produced the result and ``matched`` (True when the
            track count equals ``target_count``).  When no pass matches
            exactly, the closest result across all passes is returned.
        """
        best_tracks = None
        best_info = None

        try:
            for threshold, min_duration in self.SMART_RESCAN_LADDER:
                gaps, total_duration = self._scan_gaps(file_path, threshold, min_duration)
                tracks = boundaries_for_track_count(
                    gaps, total_duration, self.min_track_length, target_count
                )
                info = {
                    "silence_threshold": threshold,
                    "min_silence_duration": min_duration,
                    "matched": len(tracks) == target_count,
                }
                if info["matched"]:
                    return tracks, info
                if best_tracks is None or abs(len(tracks) - target_count) < abs(
                    len(best_tracks) - target_count
                ):
                    best_tracks, best_info = tracks, info

            return best_tracks, best_info

        except subprocess.TimeoutExpired:
            raise RuntimeError("Silence detection timed out (>5 minutes)")
        except Exception as e:
            raise RuntimeError(f"Smart rescan failed: {e}")

    def compute_envelope(self, file_path: Path):
        """Decode ``file_path`` once and return its per-frame RMS dBFS envelope.

        Mono, 8 kHz, 10 ms frames (``ENVELOPE_FRAME_S``).  Every silence
        question (gaps at any threshold, music span) is then answered in
        memory from this array.
        """
        import numpy as np

        result = run_ffmpeg(
            [
                "-i",
                str(file_path),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                str(ENVELOPE_SAMPLE_RATE),
                "-",
            ],
            text=False,
            capture_output=True,
            check=True,
        )
        samples = np.frombuffer(result.stdout, dtype=np.int16)
        return envelope_from_pcm(samples, int(ENVELOPE_SAMPLE_RATE * ENVELOPE_FRAME_S))

    def compute_waveform_peaks(self, file_path: Path) -> dict:
        """Keep 10 ms transient timing at any album length, with bounded PCM memory.

        Spool the low-rate decode to a temporary file and reduce it in blocks.
        A fixed number of peaks per album smears cut-point timing as recordings grow.
        Equal-width bins cover the entire decoded duration, including its tail.
        """
        import numpy as np

        frame_samples = int(ENVELOPE_SAMPLE_RATE * ENVELOPE_FRAME_S)
        peaks = []
        with tempfile.TemporaryFile() as pcm:
            run_ffmpeg(
                ["-v", "error", "-i", str(file_path), "-f", "s16le", "-acodec", "pcm_s16le",
                 "-ac", "1", "-ar", str(ENVELOPE_SAMPLE_RATE), "-"],
                text=False, stdout=pcm, stderr=subprocess.PIPE, check=True,
            )
            sample_count = pcm.tell() // 2
            peak_count = (sample_count + frame_samples - 1) // frame_samples
            for first in range(0, peak_count, 1000):
                last = min(first + 1000, peak_count)
                # WaveSurfer spreads peaks evenly over duration. Distribute the
                # partial tail across bins too, rather than shifting late peaks.
                edges = np.arange(first, last + 1, dtype=np.int64) * sample_count // peak_count
                pcm.seek(int(edges[0]) * 2)
                block = pcm.read(int(edges[-1] - edges[0]) * 2)
                # Promote before abs: abs(-32768) overflows in int16.
                samples = np.frombuffer(block, dtype="<i2").astype(np.int32)
                values = np.maximum.reduceat(np.abs(samples), edges[:-1] - edges[0]) / 32768.0
                peaks.extend(np.round(values, 6).tolist())
        return {"peaks": peaks or [0.0], "length": len(peaks) or 1,
                "duration": sample_count / ENVELOPE_SAMPLE_RATE}

    def refine_tracks(self, db, tracks):
        """Widen envelope-derived tracks over audio still above the user's
        silence threshold, so quiet fades aren't clipped by permissive
        detection thresholds."""
        return refine_cuts(db, ENVELOPE_FRAME_S, tracks, self.silence_threshold)

    def tracks_for_count_from_envelope(self, db, target_count: int):
        """Smart Rescan over a cached envelope: same ladder as
        ``detect_tracks_for_count`` but with no ffmpeg decode per rung.

        Returns ``(tracks, scan_info)`` like ``detect_tracks_for_count``.
        """
        total_duration = len(db) * ENVELOPE_FRAME_S
        best_tracks = None
        best_info = None

        for threshold, min_duration in self.SMART_RESCAN_LADDER:
            gaps = gaps_from_envelope(db, ENVELOPE_FRAME_S, threshold, min_duration)
            tracks = boundaries_for_track_count(
                gaps, total_duration, self.min_track_length, target_count
            )
            info = {
                "silence_threshold": threshold,
                "min_silence_duration": min_duration,
                "matched": len(tracks) == target_count,
            }
            if info["matched"]:
                return self.refine_tracks(db, tracks), info
            if best_tracks is None or abs(len(tracks) - target_count) < abs(
                len(best_tracks) - target_count
            ):
                best_tracks, best_info = tracks, info

        return self.refine_tracks(db, best_tracks), best_info

    # --- Loudness measurement ---------------------------------------------

    def _measure(self, args: list, timeout: int = 1800) -> Optional[Loudness]:
        """Run one ebur128 pass (``args`` up to the filter) and parse it."""
        try:
            result = run_ffmpeg(args + ["-f", "null", "-"], capture_output=True, timeout=timeout)
        except Exception as e:  # timeout, missing binary...
            print(f"Loudness measurement failed: {e}")
            return None
        if result.returncode != 0:
            print(f"Loudness measurement failed: {(result.stderr or '')[-300:]}")
            return None
        return parse_ebur128_summary(result.stderr)

    def measure_ranges(
        self,
        input_file: Path,
        ranges: List[tuple],
        rumble: bool = False,
        declick: str = "off",
        hum: int = 0,
        hiss: str = "off",
        noise: Optional[NoiseProfile] = None,
    ) -> Optional[Loudness]:
        """Loudness of the concatenation of ``ranges`` of the source *after* the
        clean-up filters (rumble, hum notch, declick, hiss reduction), as one programme.

        Each range is ``(start, end)`` or ``(start, end, declick)``; the third
        element (None = ``declick``) is that range's click-removal strength, so
        the measurement matches per-track export chains.  Integrated loudness is
        measured on the concatenation (never averaged)."""
        if not ranges:
            return None
        norm = [(r[0], r[1], (r[2] if len(r) > 2 and r[2] else declick)) for r in ranges]
        if len({d for _, _, d in norm}) == 1 and not build_export_filters(
            rumble, norm[0][2], None, hum=hum, hiss=hiss, noise=noise
        ):
            # No filters at all: a single aselect pass over one input.
            chain = _aselect_ranges_filter([(a, b) for a, b, _ in norm])
            chain += ",ebur128=peak=true:framelog=quiet"
            return self._measure(["-hide_banner", "-nostats", "-i", str(input_file), "-af", chain])
        # Filters present: filter each range on its own (padded, then trimmed)
        # so no filter ever runs across a junction between ranges.
        return self._measure_ranges_concat(input_file, norm, rumble, hum, hiss, noise)

    def _measure_ranges_concat(
        self,
        input_file: Path,
        ranges: List[tuple],
        rumble: bool,
        hum: int = 0,
        hiss: str = "off",
        noise: Optional[NoiseProfile] = None,
    ) -> Optional[Loudness]:
        """Per-range chains: one seeked input per range (memory-bounded), each
        through its own chain, concatenated into a single ebur128 pass."""
        args = ["-hide_banner", "-nostats"]
        parts = []
        for i, (start, end, declick) in enumerate(ranges):
            chain = build_export_filters(rumble, declick, None, hum=hum, hiss=hiss, noise=noise)
            window = self.padded_cut(input_file, start, end) if chain else None
            if window:
                seek_s, read_dur, t0, t1 = window
                args += seek_args(seek_s, read_dur) + ["-i", str(input_file)]
                chain = f"{chain},{trim_filter(t0, t1)}"
            else:
                args += ["-ss", f"{start:.6f}", "-t", f"{end - start:.6f}", "-i", str(input_file)]
                chain = chain or "anull"
            parts.append(f"[{i}:a]{chain}[s{i}]")
        joined = "".join(f"[s{i}]" for i in range(len(ranges)))
        graph = (
            ";".join(parts)
            + f";{joined}concat=n={len(ranges)}:v=0:a=1,ebur128=peak=true:framelog=quiet"
        )
        return self._measure(args + ["-filter_complex", graph])

    def measure_sources(self, sources: List[LoudnessSource]) -> Optional[Loudness]:
        """Measure concatenated, separately cleaned cuts, retaining the native peak ceiling.

        A single integrated pass applies the loudness gate to the entire programme. Native
        per-source measurements supply a conservative peak when layouts/sample rates differ.
        FFmpeg streams the cuts; no album-sized PCM array is returned to Python.
        """
        if not sources or any(not source.ranges for source in sources):
            return None
        peaks = []
        rates = []
        for source in sources:
            native = self.measure_ranges(source.path, source.ranges, source.rumble, source.declick,
                                         hum=source.hum, hiss=source.hiss, noise=source.noise)
            _, rate = self.probe_info(source.path)
            if native is None or not rate:
                return None
            peaks.append(native.true_peak)
            rates.append(rate)
        common_rate = max(rates)
        args = ["-hide_banner", "-nostats"]
        parts = []
        for source in sources:
            for bounds in source.ranges:
                start, end = bounds[:2]
                declick = bounds[2] if len(bounds) > 2 and bounds[2] else source.declick
                chain = build_export_filters(source.rumble, declick, None, hum=source.hum,
                                             hiss=source.hiss, noise=source.noise)
                if chain:
                    seek, duration, first, last = self.padded_cut(source.path, start, end)
                    args += seek_args(seek, duration) + ["-i", str(source.path)]
                    chain += f",{trim_filter(first, last)}"
                else:
                    args += ["-ss", f"{start:.6f}", "-t", f"{end-start:.6f}", "-i", str(source.path)]
                    chain = "asetpts=PTS-STARTPTS"
                index = len(parts)
                parts.append(f"[{index}:a]{chain},aresample={common_rate},"
                             f"aformat=sample_fmts=dbl:channel_layouts=stereo[s{index}]")
        inputs = "".join(f"[s{index}]" for index in range(len(parts)))
        graph = ";".join(parts) + f";{inputs}concat=n={len(parts)}:v=0:a=1,ebur128=peak=true:framelog=quiet"
        album = self._measure(args + ["-filter_complex", graph])
        return Loudness(album.integrated, max(album.true_peak, *peaks)) if album else None

    def measure_file(self, file_path: Path) -> Optional[Loudness]:
        """Loudness of one finished file."""
        return self._measure(
            ["-hide_banner", "-nostats", "-i", str(file_path),
             "-af", "ebur128=peak=true:framelog=quiet"]
        )

    def measure_files(self, file_paths: List[Path]) -> Optional[Loudness]:
        """Loudness of several files played back to back (ffmpeg ``concat``)."""
        if not file_paths:
            return None
        if len(file_paths) == 1:
            return self.measure_file(file_paths[0])
        args = ["-hide_banner", "-nostats"]
        for p in file_paths:
            args += ["-i", str(p)]
        rates = [self.probe_info(path)[1] for path in file_paths]
        if not all(rates):
            return None
        common_rate = max(rates)
        parts = [f"[{index}:a]aresample={common_rate},aformat=sample_fmts=dbl:channel_layouts=stereo,"
                 f"asetpts=PTS-STARTPTS[s{index}]" for index in range(len(file_paths))]
        inputs = "".join(f"[s{index}]" for index in range(len(file_paths)))
        graph = ";".join(parts) + f";{inputs}concat=n={len(file_paths)}:v=0:a=1,ebur128=peak=true:framelog=quiet"
        return self._measure(args + ["-filter_complex", graph])

    def render_removed_flac(
        self,
        source: Path,
        start: float,
        end: float,
        chain: str,
        channels: int,
        out_path: Path,
        chunk_s: float = REMOVED_CHUNK_S,
        context_s: float = REMOVED_CONTEXT_S,
    ) -> None:
        """Render ``original - chain(original)`` of ``[start, end]`` to 24-bit FLAC, in chunks.

        For chains that buffer what they filter (the zero-phase hum notch and rumble filter) so memory stays
        bounded by the chunk, not the track.  Every chunk is read with ``context_s`` of
        pre/post-roll and trimmed sample-exactly, so the pieces tile the range exactly; the
        PCM goes to a temporary file that one last ffmpeg run encodes."""
        duration, rate = self.probe_info(source)
        if not duration or not rate:
            raise RuntimeError("cannot probe the source for the Removed render")
        raw = out_path.with_name(out_path.name + ".raw")
        try:
            with open(raw, "wb") as f:
                for a, b in plan_removed_chunks(start, end, rate, chunk_s):
                    seek_s, read_dur, t0, t1 = padded_window(a, b, duration, rate, context_s)
                    res = run_ffmpeg(
                        ["-hide_banner", "-loglevel", "error", *seek_args(seek_s, read_dur),
                         "-i", str(source), "-filter_complex",
                         removed_graph(chain, channels, (t0, t1)), "-map", "[out]",
                         "-f", "s32le", "-ar", str(rate), "pipe:1"],
                        text=False, capture_output=True, timeout=900,
                    )
                    if res.returncode != 0:
                        tail = (res.stderr or b"")[-300:].decode("utf-8", "replace")
                        raise RuntimeError(f"Removed render failed: {tail}")
                    f.write(res.stdout)
            run_ffmpeg(
                ["-y", "-hide_banner", "-loglevel", "error", "-f", "s32le", "-ar", str(rate),
                 "-ac", str(channels), "-i", str(raw), "-c:a", "flac",
                 "-compression_level", str(self.flac_compression), "-sample_fmt", "s32",
                 "-bits_per_raw_sample", "24", "-f", "flac", str(out_path)],
                check=True, capture_output=True, timeout=900,
            )
        finally:
            raw.unlink(missing_ok=True)

    def extract_track(
        self,
        input_file: Path,
        track: Track,
        output_file: Path,
        output_format: str = "flac",
        verbose: bool = False,
        rumble: bool = False,
        declick: str = "off",
        gain_db: Optional[float] = None,
        bit_depth: int = 16,
        hum: int = 0,
        hiss: str = "off",
        noise: Optional[NoiseProfile] = None,
    ) -> bool:
        """
        Extract a single track and convert to the specified format.

        Args:
            input_file: Source audio file
            track: Track object with start/end times
            output_file: Output file path
            output_format: One of 'flac', 'mp3', 'aiff'
            verbose: Print detailed output
            rumble: apply the 15 Hz rumble high-pass
            declick: click/pop removal strength (off|light|medium|strong)
            gain_db: Optional pure gain applied after the filters (album gain)
            bit_depth: 16 or 24 for FLAC/AIFF output (ignored for MP3)
            hum: mains frequency (50/60) for the hum notch, 0 = off
            hiss: hiss-reduction strength (off|light|medium|strong)
            noise: the file's measured NoiseProfile (hiss reduction), if any

        Returns:
            True if successful
        """
        if verbose:
            print(f"Extracting {track.vinyl_number or f'Track {track.number}'}: {output_file.name}")

        format_config = OUTPUT_FORMATS.get(output_format, OUTPUT_FORMATS["flac"])

        # -ss/-t before -i: input-side seek, so ffmpeg jumps straight to the
        # track instead of decoding everything before it. Sample-accurate for
        # PCM WAV/AIFF input.
        parts = split_export_filters(
            rumble,
            declick,
            gain_db,
            dither_to_16=(bit_depth == 16 and output_format in ("flac", "aiff")),
            hum=hum,
            hiss=hiss,
            noise=noise,
        )
        # Filtered cuts are read with pre/post-roll and trimmed sample-exactly
        # after the filters (dither last); unfiltered cuts stay untouched.
        window = self.padded_cut(input_file, track.start, track.end) if parts else None
        if window:
            seek_s, read_dur, t0, t1 = window
            args = seek_args(seek_s, read_dur) + ["-i", str(input_file)]
        else:
            args = ["-ss", str(track.start), "-t", str(track.duration), "-i", str(input_file)]

        # Add codec-specific args
        args.extend(format_config["codec_args"])
        args.extend(depth_codec_args(output_format, bit_depth))

        # Add FLAC compression level if applicable
        if output_format == "flac":
            args.extend(["-compression_level", str(self.flac_compression)])

        # Add audio restoration filter chain if requested
        af_chain = None
        if parts:
            main, dither = parts
            if window:
                main = f"{main},{trim_filter(t0, t1)}"
            af_chain = f"{main},{dither}" if dither else main
        if af_chain:
            args.extend(["-af", af_chain])

        args.extend([
            "-y",  # Overwrite output file
            str(output_file),
        ])

        try:
            result = run_ffmpeg(args, capture_output=True, timeout=600)

            if result.returncode != 0:
                print(f"Error: ffmpeg failed: {result.stderr}")
                return False

            # Verify output file exists and has reasonable size
            if not output_file.exists():
                print(f"Error: Output file not created: {output_file}")
                return False

            if output_file.stat().st_size < 1000:
                print(f"Error: Output file suspiciously small: {output_file}")
                return False

            # Verify duration is close to expected
            actual_duration = self.get_audio_duration(output_file)
            if actual_duration is None:
                print(f"Warning: Could not verify duration of {output_file}")
            elif abs(actual_duration - track.duration) > 2.0:
                print(
                    f"Warning: Duration mismatch for {output_file}: "
                    f"expected {track.duration:.1f}s, got {actual_duration:.1f}s"
                )

            return True

        except subprocess.TimeoutExpired:
            print(f"Error: Track extraction timed out")
            return False
        except Exception as e:
            print(f"Error extracting track: {e}")
            return False

    def validate_audio_file(self, file_path: Path) -> Tuple[bool, str]:
        """
        Validate that file is a valid audio file.

        Args:
            file_path: Path to file

        Returns:
            (is_valid, message)
        """
        if not file_path.exists():
            return False, f"File not found: {file_path}"

        if not file_path.is_file():
            return False, f"Not a file: {file_path}"

        if file_path.stat().st_size == 0:
            return False, f"File is empty: {file_path}"

        # Check extension
        if file_path.suffix.lower() not in SUPPORTED_INPUT_EXTENSIONS:
            return False, (
                f"Unsupported format: {file_path.suffix}. "
                f"Supported: {', '.join(SUPPORTED_INPUT_EXTENSIONS)}"
            )

        # Try to get duration (validates it's a readable audio file)
        duration = self.get_audio_duration(file_path)
        if duration is None:
            return False, f"Not a valid audio file: {file_path}"

        if duration < 60:
            return False, f"Audio file too short ({duration:.1f}s): {file_path}"

        return True, f"Valid audio file ({duration / 60:.1f} minutes)"
