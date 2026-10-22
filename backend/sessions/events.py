"""Value types crossing the Session/Pipeline seam."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


@dataclass(frozen=True)
class OutputSpec:
    """What the caller wants the Pipeline to produce."""

    output_format: str
    output_dir: Path
    flac_compression: int = 5
    rumble_filter: bool = False
    declick: str = "off"  # off | light | medium | strong
    hum_filter: bool = False  # mains-hum notch (hum_freq 50|60 Hz + harmonics)
    hum_freq: int = 60
    hiss_reduction: str = "off"  # off | light | medium | strong
    noise_profile: Optional[Any] = None  # audio_processor.NoiseProfile for the hiss filter
    album_gain: bool = False
    shared_album: bool = False  # suppress local gain measurement when a group already measured it
    shared_gain_db: Optional[float] = None
    defer_completion: bool = False  # group finalization writes shared tags before Session completion
    replaygain: bool = True
    track_numbering: str = "sequential_disc_per_lp"
    # Vinyl positions exported by the whole job (an album job: every recording), so
    # sequential numbering and totals span them; () = just this file's tracks.
    job_positions: tuple[str, ...] = ()
    bit_depth: str = "source"  # "source" | "24"


@dataclass(frozen=True)
class ProgressEvent:
    """One observable step of a Pipeline run.

    The Pipeline emits these via the caller-supplied callback.  Adapters
    (WebSocket broadcaster, CLI stdout printer) consume the same shape.
    """

    phase: str
    fraction: float
    message: str
    track_index: Optional[int] = None
    track_total: Optional[int] = None
    error: Optional[str] = None


@dataclass
class ProcessingRun:
    """Record of one Pipeline execution attempt against a Session.

    A Session may accumulate multiple runs over its lifetime (re-process
    after fixing mappings).  ``last_run`` on the Session points at the
    most recent.

    ``final_fraction`` and ``message`` track current progress while the
    run is in flight; on completion ``final_fraction`` is set to 1.0.
    """

    started_at: datetime
    completed_at: Optional[datetime] = None
    output_folder: Optional[Path] = None
    output_files: list[str] = field(default_factory=list)
    final_fraction: float = 0.0
    message: str = ""
    error: Optional[str] = None
