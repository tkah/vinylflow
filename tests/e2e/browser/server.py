"""Real VinylFlow backend for browser checks: three seeded releases, stubbed search, no network."""
import sys
sys.path.insert(0, "/src")
import uvicorn
import backend.api as api
from metadata_handler import DiscogsTrack

def seed(rid, title, lens, index=None):
    class R:
        id = rid; artist = "Verify Artist"; year = 1979; label = "Offline Records"; format = "Vinyl"
        cover_url = None; images = []; uri = f"/release/{rid}"; various_artists = False
        genres = []; credits = []
    R.title = title
    R.tracks = [DiscogsTrack(f"A{i+1}", f"{title} {i+1}", l) for i, l in enumerate(lens)]
    if index:  # an index track (suite) over the last two positions, as Discogs lists it
        R.tracks[-2:] = [DiscogsTrack("A2", index, "1:20", parts=[
            {"position": "A2", "title": "I. Allegro", "duration": "0:40"},
            {"position": "A3", "title": "II. Adagio", "duration": "0:40"}])]
    api.metadata_handler._release_cache[rid] = R()
    return {"id": rid, "artist": "Verify Artist", "title": title, "year": 1979, "label": "Offline Records",
            "format": "Vinyl", "country": "US", "cover_url": None, "uri": f"/release/{rid}", "master_id": None}

results = [seed(424242, "Wrong Pressing", ["0:30", "0:50", "0:40"]), seed(424243, "Right Pressing", ["0:40", "0:40", "0:40"]),
           seed(424244, "Suite Pressing", ["0:40", "0:40", "0:40"], index="Suite In Two Movements")]
api.metadata_handler.search_basic = lambda query, max_results=10, page=1: results if page == 1 else []
uvicorn.run(api.app, host="127.0.0.1", port=8000, log_level="warning")
