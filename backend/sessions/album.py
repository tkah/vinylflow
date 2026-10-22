"""A server-owned album export: measure once, export sequentially, then write shared tags."""
from dataclasses import dataclass, field, replace

from audio_processor import LoudnessSource, album_gain_db
from .events import OutputSpec
from .session import Session, SessionState
from . import pipeline


@dataclass(frozen=True)
class AlbumMember:
    """An immutable export specification attached to a reserved source Session."""
    session: Session
    spec: OutputSpec
    release_id: int


@dataclass
class AlbumJob:
    """Small, pollable job state; audio remains in files and FFmpeg streams."""
    id: str
    members: list[AlbumMember]
    fingerprint: str = ''
    status: str = 'queued'
    gain_db: float | None = None
    warnings: list[str] = field(default_factory=list)
    files: dict = field(default_factory=dict)

    def __post_init__(self):
        self.files = {member.session.id: {'file_id': member.session.id, 'status': 'queued',
                      'progress': 0, 'message': 'Waiting for shared album measurement', 'tracks': []}
                      for member in self.members}

    def view(self):
        """Snapshot without source paths, credentials or mutable processing specifications."""
        return {'job_id': self.id, 'status': self.status, 'gain_db': self.gain_db,
                'warnings': list(self.warnings), 'files': [dict(item) for item in self.files.values()]}

    def run(self, audio, metadata):
        """Own reservations until every successful file has finished shared tagging."""
        self.status = 'processing'
        for item in self.files.values():
            item.update(message='Measuring shared album loudness...', progress=0.05)
        successful = []
        try:
            if self.members[0].spec.album_gain:
                sources = [LoudnessSource(member.session.source_audio,
                    [(track.start, track.end, getattr(track, 'declick', None) or member.spec.declick)
                     for track in member.session.boundaries], member.spec.rumble_filter, member.spec.declick,
                    member.spec.hum_freq if member.spec.hum_filter else 0, member.spec.hiss_reduction,
                    member.spec.noise_profile) for member in self.members]
                try:
                    self.gain_db = album_gain_db(audio.measure_sources(sources))
                except Exception:
                    self.gain_db = None
                if self.gain_db is None:
                    self.warnings.append('Shared album gain skipped: the complete programme could not be measured.')
            # Sequential track numbers and totals span every recording of the release.
            job_positions = tuple(sorted({track.vinyl_number for member in self.members
                                          for track in pipeline._build_tracks(member.session)}))
            for member in self.members:
                session = member.session
                item = self.files[session.id]
                item.update(status='processing', message='Exporting with shared album settings')
                def progress(event, item=item):
                    item.update(progress=event.fraction, message=event.message)
                    if event.message.startswith('Warning:'):
                        self.warnings.append(event.message)
                spec = replace(member.spec, shared_album=True, shared_gain_db=self.gain_db,
                               replaygain=False, defer_completion=True, job_positions=job_positions)
                try:
                    pipeline.run(session, spec, member.release_id, audio, metadata, progress)
                    successful.append(member)
                    item.update(status='tagging', tracks=list(session.last_run.output_files))
                except Exception as error:
                    item.update(status='error', error=str(error), message=str(error))
            if successful and self.members[0].spec.replaygain:
                paths = [member.session.last_run.output_folder / name for member in successful
                         for name in member.session.last_run.output_files]
                complete = len(successful) == len(self.members)
                if not complete:
                    self.warnings.append('Shared album ReplayGain skipped: the album export is incomplete. Track tags are retained.')
                def tagging(event):
                    for member in successful:
                        self.files[member.session.id].update(progress=event.fraction, message=event.message)
                ok = pipeline.write_replaygain_paths(paths, self.members[0].spec.output_format,
                    audio, metadata, tagging, include_album=complete)
                if not ok:
                    self.warnings.append('Some ReplayGain measurements or tags could not be written.')
            for member in successful:
                session = member.session
                run = session.last_run
                session.mark_complete(run.output_folder, run.output_files)
                message = f'Complete — shared album gain {self.gain_db:+.1f} dB' if self.gain_db is not None else 'Complete!'
                self.files[session.id].update(status='complete', progress=1, message=message)
        except Exception as error:
            # Keep a final status even when an unexpected preparation/tagging failure escapes.
            self.warnings.append(f'Album processing failed: {error}')
            for member in self.members:
                item = self.files[member.session.id]
                if item['status'] not in ('complete', 'error'):
                    item.update(status='error', error=str(error), message=str(error))
                    if member.session.state == SessionState.PROCESSING:
                        member.session.mark_failed(str(error))
        finally:
            for member in self.members:
                member.session.export_reserved = False
            self.status = 'complete'
