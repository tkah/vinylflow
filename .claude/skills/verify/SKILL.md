---
name: verify
description: Build/launch/drive recipe for verifying VinylFlow changes end-to-end (FastAPI backend + Alpine.js frontend).
---

# Verifying VinylFlow

## Ground rule: no Discogs API calls, ever

The user forbids hitting Discogs during development. Never copy a real token (or read
`config/settings.json` / the app-support `settings.json`), never run `/api/search`,
`/api/release/{id}` or a real `/api/process` against the live API. Verify offline: Docker with
`--network none`, a throwaway config dir, and Discogs stubbed (see "Stubbing Discogs").

## Offline test suites

Build the test image once (adds pytest + httpx + pytest-xdist on top of the app image; needs `docker compose build` first so `vinylflow-vinylflow` exists):

```bash
printf 'FROM vinylflow-vinylflow\nRUN pip install --no-cache-dir -q pytest httpx pytest-xdist\n' | docker build -q -t vinylflow-test -
```

Backend (pytest). `--network none` makes any stray Discogs call fail loudly; the tmpfs over the
mounted repo's `config/` hides the real `settings.json` (and token) and keeps writes off disk:

```bash
cd <repo> && docker run --rm --network none -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD:/src:ro" --tmpfs /src/config --tmpfs /tmp -w /src \
  vinylflow-test python -m pytest -q -p no:cacheprovider -n auto   # ~20 s parallel; drop -n auto to debug serially
```

Frontend logic (no browser, no deps, Node only; loads `backend/static/app.js` and drives the
Alpine object directly with fake waveform/fetch):

```bash
node --check backend/static/app.js
node tests/frontend/run.js        # runs every tests/frontend/*.test.js, non-zero on failure
```

Also check that `index.html` loads no external scripts/styles (covered by `tests/test_vendor_offline.py`), `grep -n "alert(\|confirm(" backend/static/` is empty (toasts only) and that
`index.html` tags balance.

## Launch the app (sandboxed, offline)

`--network none` containers cannot publish ports, so drive the API from inside the container
(`docker exec` with python/urllib; the slim image has no curl), or use FastAPI's `TestClient` in a throwaway script. Never
run against your real config/output dirs and never touch the user's own `vinylflow` container:

```bash
docker run --rm -d --name vinylflow-verify --network none \
  -v "$PWD:/src:ro" --tmpfs /src/config --tmpfs /tmp \
  -e VINYLFLOW_UPLOAD_DIR=/tmp/uploads -e DEFAULT_OUTPUT_DIR=/tmp/output \
  -e VINYLFLOW_CONFIG_DIR=/tmp/config -w /src vinylflow-test \
  python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
docker exec vinylflow-verify python -c "import urllib.request as u;print(u.urlopen('http://localhost:8000/api/status').read())"
docker rm -f vinylflow-verify
```

Driving the real UI needs a browser reaching the server, which this setup deliberately does not
allow; UI logic is covered by `node tests/frontend/run.js`, and anything visual should be listed
as unverified.

## Stubbing Discogs

- Unit/integration tests: use fakes (`FakeMetadata` in `tests/test_pipeline.py`) or seed the
  handler's release cache: `handler._release_cache[<id>] = SeedRelease()` (see
  `tests/test_pipeline_loudness.py`), so `get_release_by_id` never leaves the process.
- Search results are cached too (`tests/test_search_cache.py`); seed or monkeypatch, don't call out.
- For a running server, use `tests/e2e/offline_server.py`: it imports `backend.api`, seeds a fake
  release (id 424242, three 0:40 tracks, no cover) into the release cache, then runs uvicorn.
  Monkeypatch `metadata_handler.search_basic` the same way if search needs to return something.

## Test audio (3 known tracks: 440/660/880 Hz tones, 3s silence gaps, 126s total)

Generate it with the container's ffmpeg: run the command below via `docker exec vinylflow-verify`
(or `docker run ... vinylflow-test`) with `SCRATCH=/tmp/verify` and `mkdir -p $SCRATCH`:

```bash
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=40" -f lavfi -i "anullsrc=r=44100:cl=mono:d=3" \
  -f lavfi -i "sine=frequency=660:duration=40" -f lavfi -i "anullsrc=r=44100:cl=mono:d=3" \
  -f lavfi -i "sine=frequency=880:duration=40" \
  -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1[out]" -map "[out]" -ar 44100 -ac 2 \
  -c:a pcm_s16le "$SCRATCH/Test Récord – Side A.wav"
```

Use a non-ASCII filename on purpose — Content-Disposition regressions show up as 500s.

## Drive the API surface

Scripted: `tests/e2e/offline_drive.py` runs every step below against `offline_server.py` and
prints PASS/FAIL per check (33 checks, incl. a click scan on a second 70 s upload and a hum + hiss run on a third one). Mount the repo read-only at `/src`, start the server in the
network-less container, generate the test WAV into `/tmp/verify` (above), then:

```bash
docker run --rm -d --name vinylflow-verify --network none -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD:/src:ro" --tmpfs /src/config --tmpfs /tmp \
  -e VINYLFLOW_UPLOAD_DIR=/tmp/uploads -e DEFAULT_OUTPUT_DIR=/tmp/output \
  -e VINYLFLOW_CONFIG_DIR=/tmp/config -w /src vinylflow-test python tests/e2e/offline_server.py
# ... generate the WAV via docker exec (see "Test audio") ...
docker exec vinylflow-verify python tests/e2e/offline_drive.py
docker rm -f vinylflow-verify
```

Manual steps:

0. `GET /` and every `/static/vendor/*.js` → 200 inside the `--network none` container (UI is fully offline).
1. `curl -F "files=@<wav>" localhost:8000/api/upload` → expect duration 126.0
2. `GET /api/scan/<id>` until `ready` → music span 0–126s; `POST /api/analyze {"file_id":...}`
   → 3 tracks at ~0/43/86s
3. `POST /api/analyze-guided {"file_id", "expected_tracks": 3, "durations": [40,40,40]}` →
   `method: durations`, 2 snapped boundaries, near-instant (cached envelope)
4. `GET /api/waveform-peaks/<id>` → 200, ~40KB JSON
5. `GET /api/audio/<id>` → `content-type: audio/mpeg` and RFC-5987 `filename*=utf-8''...` header
   (GET only; HEAD 405s — known). **The source is pinned on the first request**: ask before the
   MP3 preconvert (`<upload dir>/<id>/full.mp3`) exists and that session serves WAV for good.
6. `GET /api/preview/<id>/3` twice → second call cached (<50ms); `GET /api/preview/<id>/9?start=10&end=20`
   → 200 (manual splits the backend has no boundary for)
7. `POST /api/restoration-test` (restore + album gain) → both FLAC URLs serve; a `../` name → 400/404
8. `POST /api/process` only with Discogs stubbed (release seeded in the cache, no cover) → poll
   `GET /api/process/<id>` until complete. Never with a live token.
9. Verify output FLACs: each exactly 40.00s, dominant FFT frequency 440/660/880 Hz
   respectively (proves seek accuracy), 16-bit for a 16-bit source under `bit_depth: source`,
   title tags + ReplayGain track/album tags (no picture — the seeded release has no cover).

## Drive the UI (only if a browser can reach a server; not possible with `--network none`)

- `$B goto http://localhost:8000`, `$B upload 'input[type="file"]' <wav>`
- Discogs search runs automatically on file select (needs a stubbed `search_basic`); picking a
  release runs guided detection. Without Discogs, click "Skip Discogs — detect tracks by silence
  only", expect "Detecting tracks…", then 3 tracks + waveform regions render from peaks.
- `$B network` should show `/api/audio/{id}?precise=true` using **206** range requests.
  WAV editing streams the original source for cut-point timing; AIFF uses the pinned preview
  fallback. Default `/api/audio/{id}` still prefers and pins the MP3 when ready.
- WaveSurfer canvas lives in shadow DOM — `#waveform *` counts only 1 light-DOM child;
  screenshot to confirm rendering instead.

- Toasts (`role="status"` / `role="alert"`) appear bottom-right; there is no `alert()` / `confirm()`
  anywhere. Destructive actions (remove file, delete track, re-analyze) show an Undo toast.

## Gotchas

- Session store is in-memory: restarting uvicorn invalidates all file_ids.
- Run pytest in the offline container above, not on the host.
- `node --check backend/static/app.js` catches JS syntax errors (no build step).
