"""Real VinylFlow backend for browser checks: two seeded releases, stubbed search, no network."""
import sys
sys.path.insert(0, "/src")
import uvicorn
import backend.api as api
from metadata_handler import DiscogsTrack

def seed(rid, title, lens):
    class R:
        id = rid; artist = "Verify Artist"; year = 1979; label = "Offline Records"; format = "Vinyl"
        cover_url = None; images = []; uri = f"/release/{rid}"; various_artists = False
        genres = []; credits = []
    R.title = title
    R.tracks = [DiscogsTrack(f"A{i+1}", f"{title} {i+1}", l) for i, l in enumerate(lens)]
    api.metadata_handler._release_cache[rid] = R()
    return {"id": rid, "artist": "Verify Artist", "title": title, "year": 1979, "label": "Offline Records",
            "format": "Vinyl", "country": "US", "cover_url": None, "uri": f"/release/{rid}", "master_id": None}

results = [seed(424242, "Wrong Pressing", ["0:30", "0:50", "0:40"]), seed(424243, "Right Pressing", ["0:40", "0:40", "0:40"])]
api.metadata_handler.search_basic = lambda query, max_results=10: results
uvicorn.run(api.app, host="127.0.0.1", port=8000, log_level="warning")
