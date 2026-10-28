"""Pipeline — turns a Ready Session into a Complete Session.

Runs the mechanical sequence: fetch Release → write Output Folder →
download cover art → for each mapped boundary, ffmpeg-extract → tag →
rename.  Reports progress through a caller-supplied callback so
WebSocket and CLI can subscribe with tiny adapters.

The Pipeline mutates ``session`` (link_release, mark_processing,
mark_complete, mark_failed).  On any exception it marks the Session
``FAILED`` and re-raises.

This function is synchronous — wrap it in ``asyncio.to_thread`` if you
need the calling event loop to stay responsive while ffmpeg runs.
"""

from __future__ import annotations

import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Callable

# audio_processor and metadata_handler live at the project root, not
# under backend/.  api.py extends sys.path before importing them; do
# the same here so the package can be imported from a CLI entry point
# without depending on api.py to set up the path first.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from audio_processor import (
    OUTPUT_FORMATS,
    target_bit_depth,
    AudioProcessor,
    Loudness,
    Track,
    album_gain_db,
    format_replaygain_gain,
    format_replaygain_peak,
    replaygain_gain_db,
)
from metadata_handler import MetadataHandler, with_borrowed_work, with_custom_tracks

from .events import OutputSpec, ProcessingRun, ProgressEvent
from .session import Session, SessionState

ProgressCallback = Callable[[ProgressEvent], None]


def run(
    session: Session,
    spec: OutputSpec,
    release_id: int,
    audio_processor: AudioProcessor,
    metadata_handler: MetadataHandler,
    on_progress: ProgressCallback,
) -> None:
    if not session.boundaries:
        raise ValueError("session.boundaries must be set before pipeline.run")

    run_record = ProcessingRun(started_at=datetime.now())

    try:
        on_progress(
            ProgressEvent(
                phase="fetching_release",
                fraction=0.2,
                message="Fetching release metadata from Discogs...",
            )
        )

        release = metadata_handler.get_release_by_id(release_id)
        if not release:
            raise RuntimeError("Failed to fetch Discogs release")
        if spec.title_source:
            # Borrowed movements first, so renames / custom tracks can still target them.
            donor = metadata_handler.get_release_by_id(spec.title_source.release_id)
            if not donor:
                raise RuntimeError(
                    f"Failed to fetch the title source release {spec.title_source.release_id} from Discogs"
                )
            release = with_borrowed_work(release, donor, spec.title_source)
        if spec.custom_tracks:
            release = with_custom_tracks(release, spec.custom_tracks)

        session.link_release(release)
        session.mark_processing(run_record)

        tracks = _build_tracks(session)

        album_folder = Path(spec.output_dir) / metadata_handler.create_album_folder_name(release)
        album_folder.mkdir(parents=True, exist_ok=True)

        on_progress(
            ProgressEvent(
                phase="downloading_cover",
                fraction=0.3,
                message="Downloading cover art...",
            )
        )

        cover_data = None
        if release.cover_url:
            cover_path = album_folder / "folder.jpg"
            if metadata_handler.download_cover_art(release.cover_url, cover_path):
                cover_data = metadata_handler.prepare_cover_for_embedding(cover_path)

        ext = OUTPUT_FORMATS[spec.output_format]["extension"]
        output_files: list[str] = []
        total = len(tracks)

        bit_depth = target_bit_depth(spec.bit_depth, session.source_bit_depth)

        gain_db = None
        if spec.album_gain:
            gain_db = spec.shared_gain_db if spec.shared_album else _measure_album_gain(session, spec, tracks, audio_processor, on_progress)

        for i, track in enumerate(tracks):
            fraction = 0.4 + (i / total) * 0.5
            on_progress(
                ProgressEvent(
                    phase="extracting",
                    fraction=fraction,
                    message=f"Processing track {i + 1}/{total}...",
                    track_index=i + 1,
                    track_total=total,
                )
            )

            temp_output = album_folder / f"temp_{track.vinyl_number}{ext}"

            audio_processor.extract_track(
                session.source_audio,
                track,
                temp_output,
                spec.output_format,
                rumble=spec.rumble_filter,
                declick=track.declick or spec.declick,
                hum=(spec.hum_freq if spec.hum_filter else 0),
                hiss=spec.hiss_reduction,
                noise=spec.noise_profile,
                gain_db=gain_db,
                bit_depth=bit_depth,
            )

            # Every position this export covers (an album job's members included): numbering,
            # and which split (index) track parts are exported, depend on all of them.
            job_positions = list(spec.job_positions) or [t.vinyl_number for t in tracks]
            metadata_handler.tag_file(
                temp_output, track, release, cover_data, spec.output_format,
                track_numbering=spec.track_numbering,
                job_positions=job_positions,
                prefix_part_titles=spec.prefix_part_titles,
            )

            final_filename = metadata_handler.create_track_filename(
                track, release, spec.output_format, job_positions,
                prefix_part_titles=spec.prefix_part_titles,
            )
            final_path = album_folder / final_filename
            temp_output.replace(final_path)

            output_files.append(final_filename)

        if spec.replaygain:
            _write_replaygain_tags(
                album_folder, output_files, spec, audio_processor, metadata_handler, on_progress
            )

        if spec.defer_completion:
            run_record.output_folder = album_folder
            run_record.output_files = output_files
            on_progress(ProgressEvent(phase="exported", fraction=0.9,
                                      message="Audio saved; waiting for shared album tags..."))
            return
        session.mark_complete(album_folder, output_files)

        on_progress(
            ProgressEvent(
                phase="complete",
                fraction=1.0,
                message="Complete!",
            )
        )

    except Exception as e:
        on_progress(
            ProgressEvent(
                phase="error",
                fraction=run_record.final_fraction,
                message=f"Processing failed: {e}",
                error=str(e),
            )
        )
        if session.state == SessionState.PROCESSING:
            session.mark_failed(str(e))
        raise


def _build_tracks(session: Session) -> list[Track]:
    """Convert Session boundaries into Tracks with vinyl_number and the optional
    per-track ``declick`` override applied.

    Boundaries may be either ``audio_processor.Track`` (set by /api/analyze)
    or pydantic ``TrackBoundary`` (set by /api/process when the user
    manually edited regions).  Both expose .number/.start/.end.
    """
    tracks: list[Track] = []
    for b in session.boundaries:
        t = Track(number=b.number, start=b.start, end=b.end)
        existing = getattr(b, "vinyl_number", None)
        if existing is not None:
            t.vinyl_number = existing
        t.declick = getattr(b, "declick", None) or None
        if t.number in session.mappings:
            t.vinyl_number = session.mappings[t.number]
        tracks.append(t)
    return tracks


def _measure_album_gain(session, spec, tracks, audio_processor, on_progress):
    """Measure the active track ranges (post clean-up filters) and return the album
    gain in dB, or None (with a progress warning) if it can't be measured."""
    on_progress(
        ProgressEvent(
            phase="measuring_loudness",
            fraction=0.32,
            message="Measuring album loudness...",
        )
    )
    try:
        loudness = audio_processor.measure_ranges(
            session.source_audio,
            [(t.start, t.end, t.declick or spec.declick) for t in tracks],
            spec.rumble_filter,
            spec.declick,
            hum=(spec.hum_freq if spec.hum_filter else 0),
            hiss=spec.hiss_reduction,
            noise=spec.noise_profile,
        )
        gain = album_gain_db(loudness)
    except Exception:
        traceback.print_exc()
        gain = None
        loudness = None

    if gain is None:
        message = "Warning: could not measure album loudness - album gain skipped"
    else:
        message = f"Album gain {gain:+.1f} dB (from {loudness.integrated:.1f} LUFS)"
    on_progress(ProgressEvent(phase="measuring_loudness", fraction=0.38, message=message))
    return gain


def _write_replaygain_tags(
    album_folder, output_files, spec, audio_processor, metadata_handler, on_progress
):
    """Measure every final file and the album as a whole, then tag them.

    Measurement or tagging failures log a warning and skip RG for that file
    (or the album values); they never fail the job.
    """
    return write_replaygain_paths([album_folder / name for name in output_files], spec.output_format,
                                 audio_processor, metadata_handler, on_progress)


def write_replaygain_paths(paths, output_format, audio_processor, metadata_handler, on_progress,
                          include_album=True):
    """Tag only the explicit successful outputs, measuring their combined programme once."""
    total = len(paths)
    per_file = []
    for i, path in enumerate(paths):
        on_progress(
            ProgressEvent(
                phase="replaygain",
                fraction=0.9 + (i / total) * 0.04,
                message=f"Measuring loudness for ReplayGain {i + 1}/{total}...",
                track_index=i + 1,
                track_total=total,
            )
        )
        try:
            per_file.append(audio_processor.measure_file(path))
        except Exception:
            traceback.print_exc()
            per_file.append(None)

    on_progress(
        ProgressEvent(
            phase="replaygain",
            fraction=0.94,
            message="Measuring album loudness for ReplayGain...",
        )
    )
    try:
        album = audio_processor.measure_files(paths) if include_album else None
        if album is not None:
            # Layout conversion in the combined pass must never hide a native output's peak.
            album = Loudness(album.integrated, max([album.true_peak] + [loud.true_peak for loud in per_file if loud]))
    except Exception:
        traceback.print_exc()
        album = None

    album_gain = format_replaygain_gain(replaygain_gain_db(album)) if album else None
    album_peak = format_replaygain_peak(album.true_peak) if album else None

    written = 0
    for path, loud in zip(paths, per_file):
        if loud is None and album is None:
            continue
        try:
            ok = metadata_handler.write_replaygain(
                path,
                output_format,
                format_replaygain_gain(replaygain_gain_db(loud)) if loud else None,
                format_replaygain_peak(loud.true_peak) if loud else None,
                album_gain,
                album_peak,
            )
        except Exception:
            traceback.print_exc()
            ok = False
        written += 1 if ok else 0

    if written == total and not include_album:
        message = "Track ReplayGain tags written; shared album tags skipped"
    elif written == total and album is not None:
        message = f"ReplayGain tags written (album {album_gain})"
    else:
        message = f"Warning: ReplayGain tags written for {written}/{total} files"
    on_progress(ProgressEvent(phase="replaygain", fraction=0.98, message=message))
    return written == total and (album is not None or not include_album)
