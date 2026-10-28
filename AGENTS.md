# VinylFlow — Agent Instructions

This file is the single source of truth for agent conventions and project context in this
repository. `CLAUDE.md` imports it. Add or change conventions here, never in a tool-specific
file, so that Claude Code, Codex, and other agents read the same instructions.

## Working in This Repository

- Before reviewing or changing an implementation, inspect `git status` and the relevant diff
  at the repository root.
- Preserve all pre-existing work. Never discard, overwrite, reformat, or fold unrelated dirty
  files into the requested change merely to simplify the diff.
- Prefer editing existing files and following established patterns. Do not add features,
  abstractions, dependencies, or error handling beyond what the task requires.
- Use readable, descriptive variable names. Short loop indices and local mathematical variables
  are fine; names for state, data, and helpers should say what they hold or do.
- Keep implementations straightforward. Share repeated logic through existing helpers or a
  focused utility; avoid speculative abstraction layers.
- Give repeated or meaningful limits, preset values, and protocol strings named constants in
  the appropriate module. Keep backend and frontend contracts consistent.
- Keep audio processing memory bounded: full-album recordings can be about 1.5 GB. Prefer
  chunked decoding and the existing envelope/cache machinery over loading entire recordings.

## Plans and Reviews

- For planned work, treat the applicable document in `docs/plans/` and its settled decisions as
  the implementation contract. These plans are local and git-ignored; do not force-add them.
- A checked box or implementation note is a claim to verify, not evidence of completion.
  Trace requirements to implementation and meaningful tests before updating completion notes.
- When reviewing another agent's work, check the plan's requirements, invariants, and known
  traps as well as the diff. Do not rewrite acceptance criteria to make existing code pass.
- Make implementation briefs self-contained: name the files, required behavior, invariants,
  mistakes to avoid, test cases, and exact offline verification commands.
- If work is delegated, pass on these instructions, the applicable plan, the no-Discogs rule,
  the Git boundary, and the verification commands. Review the result against the plan and
  verify it before reporting completion.
- Choose audio thresholds and filter parameters by measurement where practical. Keep a
  focused synthetic regression test and report the measured trade-offs.

## Git Boundary

- No commits or pushes unless the user asks. Merging belongs to the user unless explicitly
  requested. A statement that work is branched, committed, or clean is status, not permission.
- Never commit to `main`; it is the upstream mirror. New feature work starts on a feature
  branch from `discogs-first-flow`. Preserve an existing in-progress branch and its work.
- Stage only your own changes, by path. Never use `git add -A`, `git add .`, or `git commit -a`.
  Leave files with pre-existing uncommitted edits unstaged and report that boundary.
- Never rewrite history you did not create in the current task: no reset, rebase, amend,
  force operation on pre-existing commits, or branch deletion.
- Read-only Git inspection is allowed. Before committing code, use the verification recipe
  in `.claude/skills/verify/SKILL.md`; documentation-only edits do not need the code suites.

## Testing and Verification Expectations

- For behavior changes, add focused coverage at the affected layer: pytest for backend/audio
  logic and Node tests under `tests/frontend/` for frontend logic.
- For bug fixes and changes to existing behavior, write the regression test first and confirm
  it fails for the expected reason before implementing the fix. Cover relevant error and edge
  cases, not just the happy path.
- Do not weaken a test to make a change pass. If a requirement changed, explain why the test
  must change. Mechanical refactors should keep existing tests green unchanged.
- Documentation, copy, and layout-only changes do not need new automated tests. Verify the
  affected content or layout directly; explain any verification limitations in the final report.
- Run the relevant focused tests before reporting completion. Follow the offline commands in
  [Testing](#testing); never substitute a live Discogs call or the user's running container.
- Report what was verified and what could not be verified, with the reason. Passing frontend
  logic tests does not establish that a visual layout works in the app.

## Comments and Readability

- Document public helpers and non-obvious contracts with concise Python docstrings or JavaScript
  comments as appropriate. Explain intent, constraints, or surprising behavior, not obvious code.
- Comment subtle state transitions, async/browser-event handling, security/path boundaries,
  cache invalidation, persistence behavior, and framework or platform workarounds.
- Explain unusual test fakes and mocks so future changes preserve the reason they exist.

## Design and Accessibility

- Minimize clicks for common tasks. Prefer direct navigation and inline controls; use
  progressive disclosure for secondary features.
- Design for desktop windows and smaller browser viewports. Use responsive Tailwind layouts
  and avoid fixed widths that overflow on small screens.
- Meet WCAG 2.1 AA contrast requirements: at least 4.5:1 for normal text and 3:1 for large text
  and meaningful UI graphics. Check new color combinations with a contrast checker.
- Keep interactive controls distinguishable in default, hover, focus, and disabled states.
  Always provide a visible focus indicator.
- Never rely on color alone for meaning; pair it with labels, icons, or patterns. Use muted
  colors for decoration only when they would make meaningful text or controls hard to read.
- Preserve the existing interaction conventions: toasts and inline notices instead of
  `alert()`/`confirm()`, Undo for destructive actions, and Play/Pause toggles for playback.

---

## Project Purpose
Desktop app to digitize vinyl records: upload a WAV/AIFF recording of a vinyl side, detect track boundaries via silence analysis, search Discogs for metadata, and export split + tagged FLAC/MP3/AIFF files.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Alpine.js + Tailwind CSS + WaveSurfer.js (no build step; libraries vendored in `backend/static/vendor/`, no CDN) |
| Backend | FastAPI + uvicorn (Python) |
| Desktop shell | pywebview (WKWebView on macOS, WebView2 on Windows) |
| Audio processing | FFmpeg (via subprocess) + Mutagen (tagging) + Pillow (cover art) |
| Discogs API | `discogs-client` Python library |
| Bundling | PyInstaller (`VinylFlow.spec`) |
| CI/CD | GitHub Actions (`.github/workflows/`) |

---

## Directory Structure

```
vinylflow/
├── backend/
│   ├── api.py              # FastAPI app — all REST endpoints + WebSocket
│   ├── security.py         # Same-origin guard (Host allow-list + Origin check, ASGI middleware; no CORS)
│   ├── sessions/           # Session store/state + Pipeline (export job) + progress events
│   └── static/
│       ├── index.html      # Single-page UI (Alpine.js)
│       ├── app.js          # Main frontend logic (~3000 lines, one Alpine object)
│       └── fonts/          # Mirano Extended font family
├── tests/                  # pytest (backend) + frontend/ (Node logic tests, run.js)
├── rthooks/
│   └── rthook_vinylflow.py # PyInstaller runtime hook (runs before app code)
├── .github/workflows/
│   ├── windows-release.yml # Manual trigger — builds Windows .exe via PyInstaller
│   ├── privacy-guard.yml   # Scans commits for secrets
│   └── release-artifact-scan.yml
├── config.py               # Config management (settings.json > .env > env vars)
├── audio_processor.py      # Envelope, export filter chain, loudness, ffmpeg wrappers
├── import_folder.py       # Pure import-folder path logic: listing, name resolution (no traversal/symlink escape), overlap check
├── track_matching.py       # Pure title normalization + tracklist matching (borrowed lengths)
├── track_boundaries.py     # Pure track-boundary math (gaps, envelope, best-match alignment, guided/snap, refine_cuts)
├── click_detection.py      # Click scan: residual (original - declicked) in ffmpeg, chunk planning, thresholds, cache
├── silence_analysis.py     # Hum detector (50/60 Hz + harmonics) + surface-noise profile, from the silent stretches only
├── metadata_handler.py     # Discogs fetch, cover art download, audio tagging
├── release_credits.py      # Pure Discogs artist names, join strings, credit roles (allowlist) and track ranges
├── desktop_launcher.py     # Entry point — sets up dirs/env vars, starts FastAPI, opens window
├── VinylFlow.spec          # PyInstaller spec (macOS .app + Windows .exe)
├── requirements.txt
└── README.md
```

---

## Architecture & Data Flow

```
User browser / pywebview window
        │ HTTP + WebSocket (localhost:8000)
        ▼
FastAPI (backend/api.py)
        │
   ┌────┴──────────────┬────────────────┬────────────────┐
   ▼                   ▼                ▼                ▼
audio_processor.py  metadata_handler.py  config.py    Discogs API
(ffmpeg subprocess) (Mutagen + Pillow)  (settings)   (discogs-client)
```

**User flow (Discogs-first):**
1. Import a WAV/AIFF from the import folder (in place, no copy) or upload it -> a background scan computes the energy envelope and the music span (lead-in/run-out trimmed); selecting the file auto-searches Discogs from the cleaned filename.
1c. Tracklist parsing (`DiscogsRelease._parse_tracklist`): Discogs `type_` / `sub_tracks` exist only in each track's raw `.data` (discogs_client's Track has no such attributes). Headings are skipped; an **index track** (a suite, e.g. "Feel The Benefit" over B4-B6) becomes one umbrella track at its first part's position ("B4a"/"B4.1" -> "B4"), lasting its own Discogs length or else the sum of its parts (unknown if any part lacks one); the parts stay on `DiscogsTrack.parts`. `_serialize_release` sends them as `parts`; the Release card's "Split into parts" / "Keep as one track" replaces the umbrella in `selectedRelease.tracks` by its parts (each keeps its `umbrella`; Undo toast, re-detects), and `_find_discogs_track` resolves a part position to "Work: Movement" with the umbrella's artist/credits plus a `WORK`/`TIT1` tag. The Release card checkbox "Prefix part titles with the work title" (default on, per workspace, `prefix_part_titles` in `ProcessRequest`/`OutputSpec`) controls that prefix in tags, file names and the UI labels (`partDisplayTitle`); off = bare part title, `WORK`/`TIT1` kept; sequential numbering counts the parts when the job exports them.
1b. "Know the exact pressing?" in the search card takes a Discogs release link or number (`parseDiscogsRelease`: `2874426`, `r2874426`, `[r…]`, `discogs.com/[xx/][sell/]release/<id>`; master links/`m…` get an explanation, not a fetch) and selects it via `GET /api/release/{id}` (`openReleaseById`), skipping search.
2. Pick a release; the app suggests which side(s) the recording covers (by length, else full album). Side chips and presets ("Full album", one per disc) change that scope.
3. Guided detection (`/api/analyze-guided`) places exactly as many tracks as the chosen sides have by **best-match alignment** (`guided_by_alignment`, see Detection internals): each Discogs length is matched to the music between two chosen gaps, so one wrong length no longer shifts later cuts, any unknown length simply costs nothing, and a fragmented side-flip gap is one anchor. Cuts are contiguous, a short pre-roll before the next song. Fallbacks, in order: the old gap/scale model (`boundaries_from_expected_durations`, all lengths known: leftover span split evenly into n-1 gaps, `MAX_GAP_S` = 8 s, else proportional scaling clamped 0.9-1.1), then count-based detection (Smart Rescan ladder; also when no length is known). "Snap to Discogs" re-runs it after hand edits; hand edits ask first (banner) and snapping is undoable.
3b. If the chosen sides lack lengths, the Release card (above the waveform, with Change release and the side picker) offers "Find lengths from other pressings": durations are copied (missing ones only, marked "Lengths borrowed from ...", with Undo) onto the selected release and detection re-runs; tags still come from the selected release.
3c. Title source: `ProcessRequest.title_source` `{release_id, replace_position, donor_position|null, assignments:[{position, source}]}` (`OutputSpec.title_source`, album members must agree) takes one work's movements/titles from another Discogs release; the pipeline fetches that donor through the release cache and `metadata_handler.with_borrowed_work` swaps them in (before `with_custom_tracks`) on a per-job copy. Borrowed tracks/parts take their credits from the title source only (`credits_resolved`; the primary's release credits don't apply), and the donor's release-wide conductor/ensemble fill those roles on the primary's other tracks that have none (`fallback_credits`; never composers or soloists). UI: "Use movements from another release" (Release card, hidden while locked or once set) borrows a work's movements when the selected release lists the work without them (e.g. 2 parts vs 23 movements). The panel takes a release link/number (`loadMovementsDonor`, the own id and master links refused inline), preselects Replace/With by normalized title (`normalizeWorkTitle`) and, when the work crosses a side change, defaults the "Side B starts with" select from `GET /api/scan/{id}?side_changes=N` (`measureMovementTargets` + `defaultMovementSplit`; not measurable -> proportional with a muted note). Positions come from the replaced slots grouped by side (`borrowedPositions`: one movement keeps the slot, bare `A` -> A1..An, `B1` -> B1.1..), refused on a collision. Apply is one copy-on-write edit that inserts the movements as an unfolded umbrella (or plain tracks for "All tracks"), sets the workspace field `titleSource` (cleared by `selectRelease`, in `exportSignature`, sent as `title_source` by `buildExportRequest`), re-detects (ask-first after hand edits) and offers Undo; one title source per recording.
4. Merged track table: detected tracks, Discogs mapping, ignore/inline-edit times, delete. The **Length** column is an input (`setTrackLength`, `parseLengthInput`: m:ss, m:ss.s, h:mm:ss or seconds): end = start + length, capped at the recording's end; a next track that started exactly at the old end follows the cut. The table header and each row are separate grids, so `.track-grid` must not have auto/content-sized columns other than the one fr column (it did, and every header after Start–End sat a column to the right). The waveform (WaveSurfer, draggable regions, dashed ghost markers = Discogs-expected breaks) has a Play/Pause toggle (Space), cut-point audition and zoom. Each row's Discogs-track dropdown ends with "➕ Custom track…" (inline form: position, title) and has a Rename button; entries are flagged `custom` / `renamed` (`originalTitle` kept) in `selectedRelease.tracks`, edited copy-on-write (the release object can be shared with another workspace), never re-detect or move a cut, and come with an Undo toast. Rename on a row whose track other rows share saves a new custom track for that row only ("Rename all N" retitles the shared entry), and a custom track's position is editable (`editCustomTrack`). Export sends them as `custom_tracks: [{position, title}]` (`CustomTrack`, `OutputSpec.custom_tracks`); the pipeline tags a per-job copy via `metadata_handler.with_custom_tracks` (the cached release is never mutated), so numbering/totals include them. An album job merges its recordings' custom tracks.
5. "Audio processing" panel in the Export card (below the track table) (rumble filter, hum removal + 50/60 Hz, click & pop removal Off/Light/Medium/Strong, hiss reduction + Light/Medium/Strong, album gain, ReplayGain tags; each saves as the default immediately and mirrors the Settings modal; hum/hiss are off by default, and a detected hum shows a muted "Hum detected at 60 Hz (−48 dBFS) — Turn on" hint), with an optional A/B test on one track (`POST /api/restoration-test` `{rumble, declick, hum_filter, hum_freq, hiss_reduction, album_gain, album_ranges?}`; legacy `restore` bool = rumble + light), then export. `POST /api/process` takes `rumble_filter`, `declick`, `hum_filter`, `hum_freq` (50|60; the old `hum_freq` field alone is ignored), `hiss_reduction` (legacy `restoration_level` 1 = rumble + light).
6. There is no `alert()`/`confirm()`: `notify()` toasts (info/success auto-dismiss, warning/error sticky, hover pauses) and inline notices. Destructive actions run immediately with an Undo toast (file removal defers `DELETE /api/queue/{id}` ~8 s; delete track and re-analyze restore a snapshot).

**Processing pipeline** (`POST /api/process` -> `backend/sessions/pipeline.py`, run in a worker thread):
1. Fetch release from Discogs (server-side cached)
2. Apply the user's track->position mapping (A1, B2, etc.)
3. Create output folder: `{Artist} - {Album}/`; download + embed cover art
4. If album gain is on: measure all active ranges once (after the clean-up filters) and derive one gain
5. For each track: ffmpeg extract through the shared filter chain (rumble, hum notch, declick, hiss reduction, gain, dither) -> encode -> tag -> rename
6. If ReplayGain is on: measure the final files and write track + album tags
7. Broadcast completion via WebSocket

**Upload session storage:**
- Source file: `VINYLFLOW_UPLOAD_DIR/{file_id}/source.{ext}` (upload) or the original file in the import folder (`Session.in_place`; never inside or linked from the session dir)
- Derived files (MP3 preview, peaks, `envelope.npy`, click/silence caches, A/B renders) always live in `VINYLFLOW_UPLOAD_DIR/{file_id}/`; all cleanup is `rmtree` of that dir only, so an in-place source is never deleted. An import dir overlapping the uploads dir is refused. A vanished in-place source gives HTTP 410
- Output: `DEFAULT_OUTPUT_DIR/{Artist} - {Album}/{position}-{title}.{fmt}`

---

## Key API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` | Upload WAV/AIFF, create session UUID, queue MP3 preview |
| GET | `/api/import` | Import folder listing `{enabled, dir, error, files: [{name, size, mtime, stable, imported_id, imported_status}]}` (recursive ≤3 levels, hidden/`._*` skipped, ≤500) |
| POST | `/api/import` | `{names?, paths?}` -> in-place Sessions (same shape as upload + `in_place`; `skipped` with reasons). `names` must resolve inside the import dir; `paths` only if granted by the desktop file dialog |
| POST | `/api/analyze` | Silence detection -> track boundaries (from the cached envelope) |
| POST | `/api/rescan` | Smart Rescan: sweep detection settings to hit an expected track count |
| POST | `/api/analyze-guided` | Guided detection: expected count + Discogs lengths -> snapped boundaries |
| GET | `/api/scan/{file_id}?side_changes=N` | Background scan status (music span); N in 0-8 also returns `side_changes: [[start, end], ...]` (longest non-music stretches, time order) |
| GET | `/api/preview/{file_id}/{track_number}` | Generate 30s MP3 preview |
| POST | `/api/clicks/{file_id}` | Start/join a click scan `{declick}` ("off" scans at medium); cached result returns at once |
| GET | `/api/clicks/{file_id}?declick=` | `{status: none/running/done/error, progress, strength, requested, times?}` (WebSocket `click_scan_progress` / `click_scan_complete`) |
| GET | `/api/hum/{file_id}` | `{detected: 50\|60\|null, level_dbfs, prominence_db, harmonics, analyzed_s, noise}` — hum detector + noise profile over the silent stretches (lead-in / gaps / run-out, ≤30 s decoded); cached as `silence_analysis.json`; the frontend calls it when the scan completes |
| POST | `/api/restoration-test` | Render one track original / processed / removed (A/B test); `album_ranges` entries are `[start, end]` or `[start, end, declick]` |
| GET | `/api/restoration-test/{file_id}/{name}` | Serve an A/B render (`rt(orig\|proc\|diff)_<12hex>.flac`) |
| GET | `/api/waveform-peaks/{file_id}` | Equal-width peaks at ≤10 ms per bin, reduced from a temporary PCM file in bounded blocks; `peaks_v2.json` replaces coarse caches |
| GET | `/api/audio/{file_id}` | Range playback; waveform uses `?precise=true` for source WAV, AIFF keeps the pinned preview fallback |
| POST | `/api/search` | Discogs search `{query, max_results, page}` -> `{results, has_more}`; 12 per page in the UI, "Load more" up to `SEARCH_MAX_PAGES` (3) fetches per query. The page size is set on the result list, never as a `per_page` search field (the library appends its own, so Discogs got two) |
| GET | `/api/release/{release_id}` | Full release + tracklist (cached) |
| GET | `/api/release/{release_id}/length-donors` | Other pressings of the same master with matching track lengths (rate-limited, <=12 fetches, cached; progress via WS `donor_progress`) |
| POST | `/api/process` | Start background processing job |
| GET | `/api/process/{job_id}` | Poll job status |
| POST | `/api/process-album` | `{job_id: UUID, files: [ProcessRequest, ...]}` — reserve and export a shared-loudness group sequentially |
| GET | `/api/process-album/{job_id}` | Group preparation, per-file progress/outcomes, common gain, and warnings |
| GET/DELETE | `/api/queue`, `/api/queue/{file_id}` | Manage upload queue |
| GET/PUT | `/api/config` | Read/write settings |
| POST | `/api/setup/discogs-token` | Save Discogs token |
| WS | `/ws` | Real-time progress updates |

---

## Environment Variables

All set by `desktop_launcher.py` before starting FastAPI. **Never hardcode paths in api.py or audio_processor.py.**

| Variable | Set by | Purpose |
|----------|--------|---------|
| `VINYLFLOW_CONFIG_DIR` | launcher | Platform config dir (AppData / Library / .config) |
| `VINYLFLOW_UPLOAD_DIR` | launcher | Temp uploads dir |
| `VINYLFLOW_ALLOWED_HOSTS` | user / compose | Extra comma-separated Host names (e.g. `nas.local`) beyond localhost, `*.localhost` and IP literals; read per request |
| `VINYLFLOW_FFMPEG_PATH` | launcher | Absolute path to ffmpeg binary |
| `DEFAULT_OUTPUT_DIR` | launcher | Default output folder |
| `VINYLFLOW_IMPORT_DIR` | launcher / compose | Import folder read in place (desktop `~/Music/VinylFlow/Incoming`, Docker `/app/incoming` mounted `:ro`). settings.json `IMPORT_DIR` overrides; **not** settable via `PUT /api/config`, so a web page can never widen what is importable (defence in depth beside the same-origin guard). Unset = import disabled |
| `DISCOGS_USER_TOKEN` | user / settings.json | Discogs API token |
| `DISCOGS_USER_AGENT` | user / settings.json | Discogs API user agent |
| `DEFAULT_SILENCE_THRESHOLD` | config | Silence detection threshold (dB) |
| `DEFAULT_MIN_SILENCE_DURATION` | config | Min silence gap (seconds) |
| `DEFAULT_MIN_TRACK_LENGTH` | config | Min track length (seconds) |
| `DEFAULT_FLAC_COMPRESSION` | config | FLAC compression level 0–8 |
| `TEMP_TTL_HOURS` | config | Temp file cleanup timeout |

**Config priority (highest → lowest):** `settings.json` → `.env` → environment vars → code defaults

---

## PyInstaller / Bundling Rules

These rules are **critical** — violating them breaks the bundled app silently.

1. **Never exclude** `pythonnet`, `clr`, `clr_loader` from spec — pywebview's `edgechromium` backend needs them on Windows.
2. **Collect** `certifi` data files in spec so `cacert.pem` is present → HTTPS to Discogs works.
3. **Collect** `pythonnet` data files so `Python.Runtime.dll` is bundled.
4. **UPX exclusions** — both must be in `upx_exclude`:
   - `Python.Runtime.dll` — UPX corrupts .NET assemblies
   - `ffmpeg.exe` — UPX-packed ffmpeg is flagged by Windows Defender
5. **Runtime hook** `rthooks/rthook_vinylflow.py` runs before any import; sets:
   - `PYTHONNET_RUNTIME_DLL` → bundled `Python.Runtime.dll`
   - `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE` → bundled `cacert.pem`
6. Bundle `backend/static/` as data files so the frontend is served correctly.

---

## FFmpeg Usage Rules

- `audio_processor.py` **must** call `_ffmpeg()` helper (not hardcode `"ffmpeg"`) — reads `VINYLFLOW_FFMPEG_PATH`.
- Use `encoding='utf-8', errors='replace'` on subprocess calls — **not** `text=True` (breaks on Windows with non-ASCII).
- `desktop_launcher.py` `_bundled_ffmpeg_path()` must try **both** `ffmpeg.exe` (Windows) and `ffmpeg` (macOS/Linux).

---

## Frontend Notes (app.js / index.html)

- **No build step, fully offline** — Alpine.js, Tailwind (v3 Play script), WaveSurfer + regions are vendored, version-pinned, in `backend/static/vendor/` (versions, SHA-256, update steps in its README). `tests/test_vendor_offline.py` fails if index.html loads anything external or a hash drifts. Don't add CDN tags.
- All UI state lives in one Alpine.js `x-data` object (see `app.js`).
- **WaveSurfer.js** handles waveform rendering with draggable region markers for track boundaries. WaveSurfer objects are stored via `markRaw` (`__v_skip`) so Alpine never proxies them (proxied regions break WaveSurfer's own identity checks). Its native scrollbar is hidden (`hideScrollbar`); `bindWaveScrollbar` drives an always-visible scrollbar under the waveform (`waveView` = visible fractions) that only shows when zoomed in. `tameRegionDragScroll` overrides the regions plugin's `adjustScroll`: a whole-region drag of a region wider than the view used to flip the view between its start and end on every pointer move; now it follows the leading edge (start when dragging left, end when right; direction fixed from the pointerdown position) kept `DRAG_EDGE_MARGIN` (15 %) in from the screen edge. ⌘/Ctrl + wheel and trackpad pinch (sent by browsers as Ctrl + wheel) zoom around the pointer (`wheelZoom`, `WHEEL_ZOOM_RATE`), between fit-to-width and 500 px/s; a plain wheel is left to the page.
- WebSocket (`/ws`) receives real-time progress updates during processing.
- **Workspace recovery:** the browser saves per-session editing state under `vinylflow.workspaces.v1` in localStorage. Startup checks `/api/queue` before offering resume; deleted/expired server sessions are dropped. File switches preserve work. Resume restores paused without Discogs search or detection. Audio, source paths, and credentials are never stored; this does not survive a server restart that clears the session store.
- **Export locks:** only the recordings being exported are read-only (`isLocked`: processing / queued / uncertain / unfinished album job); switching files, editing others and Settings Save work during exports. The waveform player stays usable on a locked recording, but its regions can't be dragged. Process & Save while something exports freezes the request and queues it (browser-side FIFO, one export in flight; `uncertain` halts the queue). Process all ready waits until nothing runs or is queued.
- **Playback source:** the waveform plays `/api/audio/{id}?precise=true` (original WAV); if the browser can't play it (`canPlayType`, media error 3/4) it reloads once from the MP3 preview, keeping position and zoom, with a muted notice.
- **Shared measurement:** `measure_sources` runs the per-recording native peak pass only when sample rates or channel counts differ; uniform groups use one combined pass. All-mono groups stay mono (otherwise the skipped native pass would leave the peak ~3 dB low); mixed groups fold mono at 0.70711 (same loudness as ffmpeg's implicit −3 dB upmix).
- **Batch export and shared loudness:** `Process all ready` freezes per-file requests. Same-release/same-format recordings with matching album gain/ReplayGain toggles form a server job (`POST /api/process-album`, poll `GET /api/process-album/{id}`). One post-cleanup gain is measured across their explicit active ranges; preserve native peak maxima and never average LUFS. Shared ReplayGain comes from the explicit successful final files, never an output-directory glob. Partial groups get track-only tags and a warning. Group members stay reserved through final tags; do not bypass source/mapping/cleanup guards. Client UUIDs are idempotent and recoverable through `/api/queue`. Completion contexts include every member's signature; changing any member invalidates shared results. Single export and A/B remain local. The browser starts remaining groups; an accepted server group continues through refresh. Release shortcuts remain derived from workspaces.
- **Import retries:** every stable folder row remains selectable; the server reuses the existing session. "In queue" and "Complete" are distinct. A completed-export signature drives the Process & Save / Complete button; changing export inputs permits another export.

### macOS Context Menu Fix (critical)
WKWebView intercepts right-click before JavaScript sees it. Fix applied in `init()`:
```javascript
// Capture phase — fires before WKWebView's shadow DOM handler
document.addEventListener('contextmenu', e => e.preventDefault(), true);
```
Also: guard `@click.away` with `!$event.ctrlKey` so Ctrl+click (which triggers `contextmenu` on macOS) doesn't immediately dismiss the custom context menu.

---

## Deployment Modes

| Mode | Command | Notes |
|------|---------|-------|
| Docker | `docker compose up` | Recommended for self-hosting. Published on `127.0.0.1` only; LAN access is opt-in via `BIND_ADDRESS=0.0.0.0` in `.env` (no auth, so trusted networks only); LAN by IP works, by hostname needs `VINYLFLOW_ALLOWED_HOSTS` |
| Desktop (bundled) | `VinylFlow.app` / `VinylFlow.exe` | PyInstaller build |
| Local dev | `python desktop_launcher.py` | Opens browser or native window (binds 127.0.0.1) |
| Backend only | `uvicorn backend.api:app --reload` | For API development; `python -m backend.api` binds `HOST` (default 127.0.0.1) |

---

## GitHub Actions

- **`windows-release.yml`** — Manual trigger with `tag` input. Builds on `windows-latest`, installs FFmpeg via Chocolatey, runs PyInstaller, uploads `VinylFlow-windows-unsigned.zip` to the release.
- **`privacy-guard.yml`** — Scans commits for secrets.
- **`release-artifact-scan.yml`** — Scans release assets before publishing.

---

## Known Bugs Fixed (Feb 2026)

| File | Bug | Fix |
|------|-----|-----|
| `backend/api.py` | `UPLOAD_DIR` ignored `VINYLFLOW_UPLOAD_DIR` env var (hardcoded `__file__` path) | Read env var at startup |
| `backend/api.py` | `logger` NameError | Define logger before use |
| `config.py` | `config.DEFAULT_SILENCE_THRESHOLD` (uppercase) | Lowercase attribute name |
| `desktop_launcher.py` | `_bundled_ffmpeg_path()` only tried `'ffmpeg'`, not `'ffmpeg.exe'` | Try both |
| `audio_processor.py` | Hardcoded `"ffmpeg"` instead of `_ffmpeg()` | Use helper; use `encoding='utf-8', errors='replace'` |
| `backend/static/app.js` | Right-click opened WKWebView native menu on macOS | Capture-phase `preventDefault` in `init()` |
| `backend/static/app.js` | Ctrl+click dismissed custom context menu immediately | Guard `@click.away` with `!$event.ctrlKey` |
| `VinylFlow.spec` | `ffmpeg.exe` UPX-packed → blocked by Windows Defender | Add to `upx_exclude` |

---

## Audio Formats

- **Input:** `.wav`, `.aiff`, `.aif` — minimum 60 seconds
- **Output:** FLAC (compression 0–8), MP3 (320 kbps), AIFF (PCM, 16- or 24-bit big-endian per `bit_depth`)
- **Filter edges:** filtered cuts (rumble/hum/declick/hiss/gain) are decoded with ~1 s of pre- and post-roll and trimmed sample-exactly afterwards (`padded_window`); unfiltered cuts are untouched (bit-exact).
- **Tagging:** Mutagen handles all three formats; cover art embedded as bytes

---

## Settings (`/api/config`, `settings.json`)

Besides silence detection and `track_numbering`/`output_dir`:

| Setting | Values | Notes |
|---------|--------|-------|
| `output_format` | `flac` / `mp3` / `aiff` | Remembered default |
| `rumble_filter` | bool, default off | `highpass=f=15` |
| `declick` | `off` (default) / `light` / `medium` / `strong` | `adeclick` strength (`DECLICK_PRESETS`). Settings keys `RUMBLE_FILTER` / `DECLICK`; if absent, migrated from legacy `RESTORATION_LEVEL` (1 -> rumble on + light, else off). `PUT /api/config` still accepts `restoration_level` (same mapping); `GET` returns it derived |
| `hum_filter` / `hum_freq` | bool default off / `50`\|`60` default 60 | Mains-hum notch (`HUM_FREQS`); keys `HUM_FILTER` / `HUM_FREQ` |
| `hiss_reduction` / `hiss_strength` | `off` (default) / `light` / `medium` / `strong`; remembered strength default `light` | `afftdn` (`HISS_PRESETS` nr 6/12/20 dB). The UI toggle is off ↔ `hiss_strength`; choosing a strength sets both; `PUT` with `hiss_reduction` wins over `hiss_strength` in the same request. Keys `HISS_REDUCTION` / `HISS_STRENGTH` |
| `album_gain` | bool, default off | One gain for the whole album |
| `replaygain` | bool, default on | ReplayGain 2.0 tags |
| `bit_depth` | `"source"` (default) / `"24"` | FLAC/AIFF depth. Source depth is probed at upload; unknown -> 24 (never truncates). 16-bit targets get triangular dither only when processing runs (rumble / hum / declick / hiss / gain); unprocessed 16->16 stays bit-exact. MP3 unaffected |

## Tags

- Built once per file (`MetadataHandler._build_tag_set` -> `TagSet`), written by `_apply_vorbis` (FLAC) / `_apply_id3` (MP3, AIFF). Unknown values are omitted, never written empty.
- Artist names: Discogs join strings ("&", ","; fallback ", "), disambiguation suffix stripped ("Nirvana (2)" -> "Nirvana"; also the album folder name). ALBUMARTIST/TPE2 always (release artist, or "Various Artists").
- Default numbering is `sequential_disc_per_lp`: DISCNUMBER + TRACKNUMBER with `TRACKTOTAL`/`DISCTOTAL` (ID3 `n/total`). Numbering follows the release tracklist plus the exported positions (`OutputSpec.job_positions`), so a side exported on its own continues after side A; a skipped track leaves a gap. DISCTOTAL = LPs in the release. `vinyl` mode writes no totals.
- Compilations (release artist Various): ARTIST = the track's own Discogs artist(s), ALBUMARTIST "Various Artists", `COMPILATION=1` / `TCMP`.
- Classical (release genre "Classical"): COMPOSER/TCOM from composer credits (else release artist), ARTIST = soloists, then ensembles, then conductor credited on the track (else release artist), CONDUCTOR/TPE3, ENSEMBLE (TXXX), `PERFORMER=Name (Instrument)` / TMCL. Only the allowlisted performing roles in `release_credits.py` are tagged; credit track ranges ("A1 to A3", "B1, B2") are honoured, unresolvable ones cover nothing.

## Detection internals

- **Side flips:** guided requests include `side_breaks`, the track counts before lettered Discogs side changes. A ≥10 s silence near the expected change anchors independent spans for the sides; ordinary gap/scale placement then runs within each span. No hint or no nearby long silence preserves the existing model. Numeric-only positions do not imply a flip.
- **Envelope cache:** the upload decodes the file once (mono, 8 kHz, 10 ms RMS frames) and caches it as `envelope.npy` in the session dir. Gaps at any threshold, the music span and Smart Rescan are answered in memory from it.
- **Best-match alignment** (`track_boundaries.py`, response `model: "align"`): `smooth_envelope` (310 ms rolling median, removes clicks/thumps) -> `gap_candidates` (strong: quiet runs below span p3 + 10 dB, >= 0.4 s, runs < 1 s apart merged, scored by length + contrast with the music +-8 s; weak: quietest 0.3 s per 5 s window for segues, penalised) -> `align_durations_to_gaps` (vectorised DP over n-1 candidates, minimises sum of `log1p(((L-d)/sigma)^2)` with sigma = 3 s + 3 % per track minus `GAP_STRENGTH_W` (2) x gap strength, doubled at side changes; unknown d = no cost; < 5 s tracks infeasible; < 0.1 s for 45 min) -> `onset_cut`: the next song's onset follows the candidate's *last* quiet run of >= `ONSET_LONG_QUIET_S` (1 s) — a merged candidate can contain a soft intro's first notes (rests < 1 s) or run-out thumps before a flip — where the smoothed level rises `ONSET_RISE_DB` (6; `ONSET_FLIP_RISE_DB` 10 in a >= 10 s flip gap) above that run's level, refined on the raw envelope to a >= 50 ms sustained rise (a click is shorter); after a side flip (arm-up silence <= `ARM_UP_DB` -68 dB before the first sound) `_after_needle_drop` skips the thump and lead-in crackle: the change point maximising (median of the next `LEAD_IN_AFTER_S`) - (p90 of the crackle before it), accepted only with score >= `LEAD_IN_MIN_SCORE_DB` (5) and step >= `LEAD_IN_MIN_STEP_DB` (8) so a song starting right after the thump or a very quiet opening keeps the earlier start (side A's lead-in is already trimmed by `music_span`); the next track starts `PRE_ROLL_S` (0.8) before it and the previous track ends exactly there (a gap shorter than `PRE_ROLL_S` + `POST_ROLL_S` (0.5) is shared in proportion), except silence beyond `MAX_TAIL_S` (4 s) after the fade is dropped (digital silence keeps no tail). The first track starts and the last ends `EDGE_PAD_S` (0.5) into the lead-in / run-out. Ghost markers (`expected`) measure from each song's onset, not its padded start. Weak candidates cut contiguously at their dip. Outer edges (music span) are widened by `refine_cuts`, which leaves touching cuts alone. `expected` = this track's start + its own length (the ghost marker); `snapped` = a real gap was used. All constants are module-level and were tuned on real records with `tests/e2e/real_records_eval.py` (needs `records/` + `output/` mounted read-only, see its docstring; caches envelopes in a /work dir; `--set`/`--grid` override constants). The eval also reports **clipped** cuts (track starting after the true onset): the "inside the gap" score cannot see clipping. Synthetic cases: `tests/test_best_match_splits.py`. Not yet measured on classical / segued records.
- **No lengths at all** (`guided_without_lengths`, response `model: "align-even"`, `method: "count"` so the UI draws no ghost markers): sides first. `find_side_changes` takes the (number of `side_breaks`) longest non-music stretches (1 s blocks whose p75 is `SIDE_QUIET_DB` 15 under the median block, runs < `SIDE_MERGE_S` 5 s apart merged, >= `SIDE_MIN_S` 10 s) as strong candidates, so `onset_cut` gives the usual tail cap and `_after_needle_drop` skips the thump and nothing is centred in run-out noise; fewer stretches than side changes are matched to the changes a proportional split puts nearest (the rest are placed by the alignment with the flip bonus). Inside each side span `align_durations_to_gaps` runs on the recording-wide candidate pool (the quiet floor needs the plentiful noise; a span of its own takes quiet music for the floor) against an even split with `sigma_frac` `EVEN_SIGMA_FRAC` (2.5: the prior only breaks ties) and `EVEN_MIN_TRACK_S` (30) as the shortest song. Constants chosen on the `no lengths` scenario of `tests/e2e/real_records_eval.py` and on a 4 h, 12-side box set (5 tracks per side, 2.3-3.6 min, 0.2 s). More than `MAX_EVEN_CANDIDATES` in one span falls back to the count ladder.
- **`refine_cuts`:** detection may use a permissive threshold; cuts are then widened over audio still above the user's configured threshold so quiet fades aren't clipped.
- **Music span:** lead-in/run-out trimmed; used for side suggestions and guided placement.

## Click detection & per-track strength

- **Detection** (`click_detection.py`): scan = what the remover would change. Music span (from the envelope) decoded in ~60 s chunks with 0.5 s margin each side (`plan_chunks`; events kept only in the chunk's owned span, so overlaps never duplicate), mono 44.1 kHz. One ffmpeg graph outputs `original - declicked(strength)` (residual) plus the original; impulses above `max(-50 dBFS, local RMS -20 dB, 3x local roughness)` merge within 20 ms into click times. Roughness (median |2nd difference|) is what keeps surface hiss / busy music from flooding results. Known limit: hard drum attacks that adeclick also treats as clicks are reported.
- **Cache/jobs:** `clicks_<strength>.json` in the session dir (atomic; invalidated if the preset string or `DETECTOR_VERSION` changes). One asyncio task per (file, strength) like the envelope; cancelled with the session. Frontend derives per-track counts from the file-wide times, draws the density strip canvas on the waveform wrapper, and re-scans when the panel strength changes.
- **Per-track override:** `track_boundaries[].declick` (optional; absent = panel setting). `extract_track` uses it per track; `measure_ranges` takes `(start, end[, declick])` and, when strengths differ, measures a seeked-input-per-range `concat` (uniform strength keeps the single `aselect` pass). The A/B test and `abSignature` use the chosen track's effective strength.

## Loudness

- **Rumble filter** (`highpass=f=15`), **hum removal**, **click & pop removal** (`adeclick`, strength presets chosen by measurement in `tests/test_declick_strength.py`) and **hiss reduction** are independent. No per-track loudnorm.
- **Hum removal:** cascade of 6 `bandreject` notches (Q=20) at f0..6·f0 (60 -> 360 Hz, 50 -> 300 Hz) after `aformat=dblp` (16-bit sources would otherwise round per stage). Q/harmonics chosen by `tests/test_hum_filter.py` (≥20 dB cut at ±0.2 % mains drift, bounded bass damage). A notch's phase leaks a ghost of the music into `original − processed`, so the A/B "Removed" render uses the zero-phase form (`hum_filter(f, zero_phase=True)`: forward + `areverse` pass; buffers what it filters, hence `AudioProcessor.render_removed_flac` renders it in 40 s chunks with 3 s context, memory bounded). The rumble high-pass has the same ghost, so Removed also uses `RUMBLE_FILTER_ZERO_PHASE` (2-pole `highpass=f=7.5:w=0.515` forward + reverse, whose squared response is within ~0.9 dB of `highpass=f=15` over 5-200 Hz; `tests/test_rumble_zero_phase.py`); export and the Processed render keep the normal filters. A rumble or hum cleanup is rendered chunked. The Audio processing panel and Settings show a caution note under Hum removal (`humNoteFreqs`).
- **Hiss reduction:** `afftdn` with the file's own noise profile (`silence_analysis.noise_profile`: white-equivalent level per afftdn custom band from the silent stretches; `nt=c:bn=…`, `nf` = noise + 6 dB), so `nr` (6/12/20 dB) means what it says on any record; without usable silence it falls back to `nr<=12 + tn=1` (noise tracking, erratic). `tests/test_hiss_reduction.py` has the measurements.
- **Hum/noise analysis** (`silence_analysis.py`): `silent_ranges` (envelope; floor-relative so loud hum still finds its gaps) -> bounded decode (native channels, ≤30 s) -> Welch spectrum -> `detect_hum` (lines at f0·k vs the neighbouring floor, ≥2 harmonics or one ≥12 dB; 300 Hz ignored) + `noise_profile`. Bass played in the music never enters the analysis.
- **Album gain** (optional): one gain targeting -14 LUFS, capped by -1 dBTP headroom (pure gain, no limiter). Shared album jobs measure all participating recordings after their own cleanup chains; native per-recording peaks conservatively bound the combined measurement. Single export and A/B measure only their current recording.
- **ReplayGain 2.0** tags (default on): -18 LUFS reference; track and album gain/peak measured on the final files. A measurement failure skips the tags with a warning rather than failing the job.
- **A/B test renders (3 FLACs):** `rtorig_` (source), `rtproc_` (full chain incl. album gain), `rtdiff_` ("Removed" = original − (rumble + hum + declick + hiss; no gain/dither), via `audio_processor.removed_graph`: asplit/amerge/pan difference per channel, no gain/dither, 24-bit, cached under the clean-up chain only). Response adds `removed_url` (null when no clean-up filter is on), `removed_lufs`, `removed_peak_dbfs`. Frontend: Original | Processed | Removed switch (third hidden `<audio>`); Removed plays at unity with an optional +12 dB WebAudio GainNode (`_abBoostNodes` WeakMap, one MediaElementSource per element, created lazily in the play click; no WebAudio = checkbox hidden).
- One shared filter-chain builder (`build_export_filters(rumble, declick, gain_db, dither_to_16, hum, hiss, noise)`, order rumble -> hum notch -> declick -> hiss reduction -> volume -> dither; declick before denoise so the denoiser never smears clicks) feeds export, album-gain measurement and the A/B test. Cache keys include the full chain string, so a changed noise profile re-renders.

---

## Testing

**No Discogs API calls during development — ever.** Tests and verification run offline with Discogs faked/seeded; never read `config/settings.json` or copy a token.

```bash
# Backend (build the image once: see .claude/skills/verify/SKILL.md)
docker run --rm --network none -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD:/src:ro" \
  --tmpfs /src/config --tmpfs /tmp -w /src vinylflow-test python -m pytest -q -p no:cacheprovider -n auto
# Frontend logic (Node only, no deps)
node --check backend/static/app.js && node tests/frontend/run.js
```

`--network none` plus the tmpfs over `config/` guarantees no network and hides the real token. Never touch the user's own `vinylflow` container. Frontend tests load `app.js` with fake waveform/`fetch`; visual layout still needs a manual look in the app.

---

## Python Dependencies (key ones)

```
fastapi, uvicorn[standard]   # API server
pywebview                    # Desktop window
mutagen                      # Audio tagging
discogs-client               # Discogs API
requests, certifi            # HTTP + SSL
pillow                       # Cover art processing
numpy                        # Waveform peak generation
python-dotenv                # .env parsing
python-multipart             # File upload parsing
aiofiles                     # Async file I/O
websockets                   # WebSocket support
```
