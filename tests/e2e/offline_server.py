"""Offline verify server: seeds a fake Discogs release, then runs uvicorn."""
import sys

sys.path.insert(0, "/src")

import uvicorn  # noqa: E402

import backend.api as api  # noqa: E402
from metadata_handler import DiscogsTrack  # noqa: E402


class SeedRelease:
    id = 424242
    artist = "Verify Artist"
    title = "Verify Album"
    year = 1979
    label = "Offline Records"
    format = "Vinyl"
    cover_url = None
    images = []
    uri = "/release/424242"
    various_artists = False

    def __init__(self):
        self.tracks = [
            DiscogsTrack("A1", "Four Forty", "0:40"),
            DiscogsTrack("A2", "Six Sixty", "0:40"),
            DiscogsTrack("A3", "Eight Eighty", "0:40"),
        ]


api.metadata_handler._release_cache[SeedRelease.id] = SeedRelease()
uvicorn.run(api.app, host="127.0.0.1", port=8000, log_level="warning")
