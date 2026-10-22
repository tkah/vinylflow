# 🎵 VinylFlow

**Digitize vinyl 10x faster. Open source.**

> **This is a fork** of [VinylFlow](https://github.com/olimic1000/vinylflow) by olimic1000, focused on a
> Discogs-first workflow and audio clean-up. See [What's different in this fork](#whats-different-in-this-fork).
> Desktop installers linked below are the original app's builds; this fork runs via Docker or Python.

Turn your vinyl recordings into perfectly tagged, organized digital files in minutes — not hours. VinylFlow automates track splitting, Discogs metadata tagging, cover art embedding, and vinyl-style numbering (A1, A2, B1, B2).

![VinylFlow Demo](docs/demo.gif)

---

## Use VinylFlow

- 🖥️ **Desktop apps (original VinylFlow):** install builds from [vinylflow.app/install](https://vinylflow.app/install)
- 🐳 **Docker (self-hosted):** run locally via [Quick Start (Docker)](#quick-start-docker)
- ⚙️ **Python local mode:** see [Manual Setup (Non-Docker)](#manual-setup-non-docker)

---

## What's different in this fork

**Finding the tracks**

- **Discogs first:** search starts as soon as a file is added; results show whether they have track
  lengths and how well they fit your recording (lead-in/run-out silence excluded).
- **Exact pressing:** paste a Discogs release link (or its number) to pick that exact version directly.
- **Whole albums or single sides:** side picker with Full album / Disc presets, auto-suggested from the
  recording length; multi-disc sets recorded one file per disc share a release.
- **Best-match splits:** the Discogs track lengths are matched against all the pauses in the recording
  at once, so one wrong or missing length doesn't throw off the other splits. Gaps are found after
  smoothing out clicks and surface noise, and a long pause while you flip the record is recognised
  as the side change. Each cut lands just before the next song starts, so fade-outs stay whole.
  Partial tracklists work too; you can also borrow lengths from another pressing.
- **One track table and one player:** mapping, lengths and differences in one place; dashed guides on
  the waveform show where Discogs expects each break; Play/Pause, cut-point auditions, a detailed
  waveform that plays the original WAV for precise editing, and manual edits protected with Snap to
  Discogs + Undo.

**Sound**

- **Audio processing panel:** rumble filter, click & pop removal (with detection and per-track
  strength), hum removal, hiss reduction, optional album gain, ReplayGain tags, and a one-track A/B
  test including "hear what was removed".
- **Bit depth:** exports match the source (24-bit stays 24-bit, including AIFF) or 24-bit on request.

**Working through a stack of records**

- **Import from a folder:** recordings are read where they are (no 1.5 GB browser uploads), from a
  read-only folder VinylFlow never modifies. See [Import from a folder](#import-from-a-folder-no-upload).
- **Every recording keeps its own work:** release, cuts, mapping and settings stay with each file when
  you switch, and survive a page refresh (**Pick up where you left off**).
- **Process all ready:** the queue shows what is ready and what needs attention; export them all in
  one go. Discs of the same release share album loudness and ReplayGain album tags.
- **Keep working during exports:** only the recording being exported is locked. Prepare the next one
  meanwhile; **Process & Save** queues it to start when the current export finishes.

**Safety**

- **Offline and local by default:** the interface works without internet (no CDN), Docker listens on
  this computer only, and requests from other websites are refused.
- **No pop-ups:** notices with Undo instead of `alert()`/`confirm()`.

---

## The Problem

Digitizing a vinyl record manually takes **20–30 minutes per album**: record in Audacity, manually find track boundaries, split, export, look up metadata, type it all in, find cover art, embed it. Multiply that by a collection of hundreds of records and it's a weekend project that never ends.

## The Solution

VinylFlow does it in **3 minutes**. Upload your recording, let it detect the tracks, pick the album from Discogs, and hit process. Done.

---

## Features

- **Automatic silence detection** — intelligently finds track boundaries in your recording
- **Duration-based splitting** — fallback for seamlessly mixed tracks with no gaps
- **Discogs integration** — visual search with album artwork, metadata, and track listings
- **Multiple output formats** — FLAC (lossless), MP3 (320kbps), or AIFF (lossless)
- **Multiple input formats** — WAV and AIFF recordings supported
- **Vinyl-style numbering** — proper A1, A2, B1, B2 track notation
- **Cover art** — downloads and embeds album artwork automatically
- **Interactive waveform editor** — drag regions to fine-tune track boundaries
- **Batch queue** — process multiple records with real-time progress
- **Remote access** — control from any device on your network (phone, tablet, laptop)

---

## Quick Start (Docker)

**Recommended path:** Docker (stable). If you prefer local Python, see [Manual Setup (Non-Docker)](#manual-setup-non-docker).

### Prerequisites

You'll need:
- **Docker Desktop** (free) — [Download here](https://www.docker.com/products/docker-desktop/)

That's it! Git is optional (see Step 1 below). No need to mess with configuration files — VinylFlow will guide you through setup in your browser.

## 1. Get VinylFlow

### Option A: Download ZIP (easiest — no Git required)

1. Go to [github.com/tkah/vinylflow](https://github.com/tkah/vinylflow) (branch `discogs-first-flow`)
2. Click the green **Code** button, then **Download ZIP**
3. Unzip the folder to a location you can find (like your Downloads or Desktop)
4. Open the unzipped `vinylflow` folder

### Option B: Clone with Git (for terminal users)

```bash
git clone -b discogs-first-flow https://github.com/tkah/vinylflow.git
cd vinylflow
```

## 2. Start VinylFlow

1. **Open your terminal:**
   - **Mac:** Open "Terminal" app (or iTerm)
   - **Windows:** Open "Command Prompt" or "PowerShell"
   - **Linux:** Open your terminal application

2. **Navigate to the VinylFlow folder:**
   - If you downloaded the ZIP, type `cd ` (with a space after) and drag the `vinylflow` folder into the terminal window, then press Enter
   - Or type the full path, like: `cd ~/Downloads/vinylflow` or `cd C:\Users\YourName\Downloads\vinylflow`
   - **Windows shortcut:** In File Explorer, open the vinylflow folder, click the address bar, type `cmd` and press Enter

3. **Start VinylFlow:**
   ```bash
   docker compose up -d
   ```

4. **Open your browser** and go to **http://localhost:8000**

### Accessing from other devices (LAN)

By default the port is published on `127.0.0.1` only, so VinylFlow is reachable just from the computer running it. To open it from a phone or another computer, add `BIND_ADDRESS=0.0.0.0` to your `.env` and run `docker compose up -d` again, then browse to `http://<your-computer's-IP>:8000`. To reach it by a hostname instead of an IP, also add `VINYLFLOW_ALLOWED_HOSTS=<name>` (e.g. `nas.local`) to your `.env`.

**Risk:** VinylFlow has no authentication, and the API can change the output folder and write files there. Anyone who can reach the port can use it, so only enable this on a trusted network.

### Import from a folder (no upload)

A full album recorded at 24-bit/96 kHz is about 1.5 GB, and uploading it through the browser copies it into the container. Instead, put your recordings in the `incoming/` folder next to `docker-compose.yml` (created on first start) and use the **Import from folder** tab: VinylFlow reads them where they are.

- To use a folder you already have, set `IMPORT_FOLDER=/path/to/your/recordings` in `.env` and run `docker compose up -d` again.
- The folder is mounted **read-only**: VinylFlow never modifies, moves or deletes your recordings. Removing a file from the queue (or the automatic temp clean-up) only deletes VinylFlow's own preview and analysis files.
- Subfolders are listed (up to 3 levels). A file that was changed in the last few seconds shows as "Still copying…" until the copy finishes.
- Desktop app: the import folder is `~/Music/VinylFlow/Incoming`, and **Choose files…** opens any WAV/AIFF on your computer in place.

## 3. First-Run Setup

When you open VinylFlow for the first time, you'll see a welcome screen that guides you through setup in seconds:

![VinylFlow Setup Screen](docs/modal.jpg)

1. **Get your free Discogs API token** — Click the link in the setup screen or visit [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
2. **Generate a new token** — Click "Generate new token" on the Discogs settings page
3. **Copy and paste** — Paste your token into VinylFlow's setup screen
4. **Click Continue** — Done! VinylFlow validates the token and you're ready to digitize

**That's it!** 🎵 No hidden files, no terminal commands, no restart needed. Your token is saved securely and persists across Docker restarts.

**Tip:** You can update your token anytime from the Settings (⚙️) menu in VinylFlow.

## Desktop Apps (Beta)

VinylFlow desktop apps are available for macOS and Windows (beta track).

- Installer downloads (original VinylFlow, without this fork's changes): [vinylflow.app/install](https://vinylflow.app/install)

- Desktop beta work is published from `desktop-beta`
- `main` remains the stable Docker-first channel
- For local desktop mode, run: `python desktop_launcher.py`
- Packaging/release scripts are in `scripts/`

### Developer Branch Note

To avoid accidental promotion of beta app work:

- Open desktop feature PRs into `desktop-beta`
- Keep `main` for stable/docs/release-safe changes
- Promote desktop work to `main` only when explicitly ready

For full branching and release details, see [docs/BRANCHING_STRATEGY.md](docs/BRANCHING_STRATEGY.md).

---

## Manual Setup (Non-Docker)

For tech-savvy users who prefer managing their own Python environment.

### Prerequisites

You'll need to install these system dependencies first:

- **Python 3.11 or later**
- **FFmpeg** (handles all audio processing and format conversion: MP3, FLAC, AIFF)
- **FLAC encoder** (optional, provides dedicated FLAC encoding tools)
- **libsndfile1** (optional, audio I/O library)

**Installation by OS:**

**macOS** (using Homebrew):
```bash
brew install python@3.11 ffmpeg flac libsndfile
```

**Ubuntu/Debian**:
```bash
sudo apt-get update
sudo apt-get install python3.11 python3.11-venv ffmpeg flac libsndfile1-dev
```

**Windows**:
- Install [Python 3.11+](https://www.python.org/downloads/) (check "Add to PATH" during installation)
- Download [FFmpeg](https://ffmpeg.org/download.html) and add it to your PATH
- FLAC and libsndfile are bundled with FFmpeg on Windows

### Installation Steps

```bash
# 1. Clone the repository
git clone -b discogs-first-flow https://github.com/tkah/vinylflow.git
cd vinylflow

# 2. Create and activate a Python virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Start the server
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
```

Open **http://localhost:8000** in your browser.

### First-Run Setup (Non-Docker)

Just like with Docker, VinylFlow will show you a welcome screen on first run:

1. Visit [discogs.com/settings/developers](https://www.discogs.com/settings/developers) and generate a free API token
2. Paste it into the VinylFlow setup screen
3. Click Continue — done!

Your token is saved to `config/settings.json` and works immediately without restart.

**Alternative (for advanced users):** You can still use a `.env` file if you prefer:

```bash
cp .env.example .env
```

Edit `.env` and add your token:

```ini
DISCOGS_USER_TOKEN=your_token_here
DEFAULT_OUTPUT_DIR=~/Music/VinylFlow
```

**Notes:**
- The `output/` and `temp_uploads/` directories are created automatically
- To import recordings in place instead of uploading them, add `VINYLFLOW_IMPORT_DIR=~/Music/VinylFlow/Incoming` (or any folder) to `.env`
- You can adjust silence detection and other settings in `.env` (see [Configuration](#configuration) below)
- To stop the server, press `Ctrl+C` in the terminal

---

## How It Works

1. **Import or upload** — pick a WAV or AIFF recording from the import folder, or drag and drop it
2. **Pick the release** — VinylFlow searches Discogs from the file name; choose the release and which
   sides the recording covers (suggested from its length)
3. **Check the splits** — the Discogs track lengths place the splits; drag any that need it, audition
   cut points, and fix the track mapping in the table (no release? detect by silence only)
4. **Clean up (optional)** — rumble, clicks, hum and hiss, tried on one track before the whole album
5. **Choose format** — FLAC, MP3, or AIFF output
6. **Process** — tracks are split, converted, tagged, and saved with cover art

Your files appear in the `output/` folder, organized as `Artist - Album/A1-Track Name.flac`.

### Process several recordings

Prepare each recording's release, cuts, position mapping, and output settings. Switching between
recordings keeps those edits. The queue shows **Ready** or **Needs attention**, with the reason;
ignored tracks do not need mappings. Conflicting positions for the same release and output format
need correcting before export.

Only a recording that is exporting (or waiting to export) is read-only, so you can keep preparing
the others. **Process & Save** while another export runs queues that recording; exports always run
one at a time.

Click **Process all ready** to export the prepared recordings sequentially. Recordings with the
same Discogs release and output format are exported together, at the first matching entry in the
queue. Use matching **Album gain** and **ReplayGain** toggles for those recordings; the queue explains
any mismatch. Their other processing settings can differ.

**Shared album loudness:** when Album gain is on, the group receives one gain measured from all
selected audio after each recording's cleanup filters. This preserves level differences between
discs, targets −14 LUFS, and limits gain using the strongest native true peak (−1 dBTP ceiling).
ReplayGain uses the finished files: album tags match across the group, and each track keeps its own
track gain/peak. Different output formats form separate groups. Changing one recording makes the
shared group ready again so its gain and tags can be recalculated together. **Process & Save** on a
single recording and **Test on one track** continue to use that recording's own measurements.

A failed export stays in the queue while later recordings continue. An incomplete album gets
track ReplayGain only, with a warning explaining why shared album tags were skipped. A failed shared
gain measurement skips gain consistently across the group. The summary reports completed/failed
recordings, and **Ready to retry** items can be retried explicitly.

An accepted album group finishes on the server, including final tags, even if the page refreshes.
Use **Pick up where you left off** to observe it again. Keep the page open to start additional
unsubmitted groups; refresh never submits those automatically. If acceptance is uncertain, further
dispatch stops until the server status is checked. Browser editing state and jobs still depend on
the running server session; server restart recovery is not implemented.

---

## Output Example

```
output/
└── Aril Brikha - Departure/
    ├── A1-Groove La Chord.flac
    ├── A2-Art Of Vengeance.flac
    ├── B1-Ambiogenesis.flac
    ├── B2-Deeparture In Mars.flac
    └── folder.jpg
```

Each file includes embedded metadata: artist, album, title, track number, year, label, Discogs ID, and cover art.

---

## Who Is This For?

- **DJs** digitizing crate finds for digital sets
- **Vinyl collectors** preserving and cataloguing collections
- **Record labels** archiving back catalogs
- **Music lovers** who want their vinyl in lossless digital

---

## Configuration

**Discogs Token**: Managed via the web UI (Settings ⚙️ menu)

**Audio Processing Settings**: Adjust in the app via Settings (⚙️), or for advanced users, edit `config/settings.json` or `.env`:

```ini
# Silence detection (adjust if tracks aren't splitting correctly)
DEFAULT_SILENCE_THRESHOLD=-40      # dB — increase to -35 if tracks are merging
DEFAULT_MIN_SILENCE_DURATION=1.5   # seconds — decrease to 1.0 for short gaps
DEFAULT_MIN_TRACK_LENGTH=30        # seconds — ignore segments shorter than this

# FLAC compression (0-8, higher = smaller files)
DEFAULT_FLAC_COMPRESSION=8
```

**Config Priority**: `config/settings.json` (UI-editable) → `.env` (manual) → environment variables (Docker)

**Track Numbering**: Configurable via Settings (⚙️) or by setting `TRACK_NUMBERING` in `config/settings.json`:
- `sequential_disc_per_lp` *(default)* — writes integer `DISCNUMBER` (A+B = disc 1, C+D = disc 2) and sequential `TRACKNUMBER` across both sides of each LP, with track/disc totals (`TRACKTOTAL`/`DISCTOTAL`, or `n/total` in ID3) and the original vinyl position preserved in a `VINYLPOSITION` tag. Single LPs appear as one disc; 2-LP sets appear as two. When several recordings of one release are exported together, numbering and totals span all of them.
- `vinyl` — writes the vinyl position (e.g. `A1`, `B2`) directly as `TRACKNUMBER`, without totals. Preserves vinyl notation but some players (Jellyfin, Roon) may mis-sort tracks.

### Silence Detection Tips

| Problem | Fix |
|---|---|
| Tracks merging together | Increase threshold (e.g. `-35` instead of `-40`) |
| Too many splits | Decrease threshold (e.g. `-45` instead of `-40`) |
| Splitting on brief silence | Increase min silence duration (e.g. `2.0`) |

---

## Managing Docker

```bash
# View logs
docker compose logs -f

# Stop VinylFlow
docker compose stop

# Restart
docker compose restart

# Remove containers (keeps your files in ./output)
docker compose down
```

---

## Troubleshooting

**See the setup screen on first run?**
This is normal! VinylFlow guides you through adding your Discogs token via the web interface. Just follow the on-screen instructions — it takes 30 seconds.

**"command not found: git"?**
You don't need Git! Use the **Download ZIP** option in [Step 1](#1-get-vinylflow) instead.

**"command not found: docker"?**
Make sure Docker Desktop is installed and **running**. You should see the Docker icon in your system tray (Mac menu bar or Windows taskbar).

**Can't navigate to the VinylFlow folder in terminal?**
- **Mac/Linux:** Type `cd ` (with a space) and drag the vinylflow folder into the terminal window, then press Enter
- **Windows:** Open the vinylflow folder in File Explorer, click the address bar, type `cmd` and press Enter — this opens a terminal already in the right folder

**Container won't start?**
Check if port 8000 is in use: `lsof -i :8000` (Mac/Linux) or `netstat -ano | findstr :8000` (Windows). Change the port in `.env` with `PORT=8080`.

**Files not appearing in output/?**
Make sure the `output/` directory exists and has write permissions: `chmod -R 755 ./output`

**Discogs search returns no results?**
Your API token might be invalid or revoked. Click the Settings (⚙️) button and update your token, or generate a new one at [discogs.com/settings/developers](https://www.discogs.com/settings/developers)

**Tracks not splitting correctly?**
Pick the Discogs release first: its track lengths place the splits, and **Snap to Discogs** re-places them after hand edits. Songs that run straight into each other (common on classical records) have no pause to find, so those breaks land only near the right spot. Drag them into place and audition the cut. Without a release, adjust silence detection in Settings (⚙️) or use Smart Rescan with the number of songs.

---

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Python, FastAPI, uvicorn |
| Audio processing | FFmpeg |
| Metadata tagging | Mutagen (FLAC, MP3, AIFF) |
| Music database | Discogs API |
| Frontend | Alpine.js, Tailwind CSS |
| Waveform display | WaveSurfer.js |
| Deployment | Docker |

---

## Roadmap

### Shipped (v1.0)
- Core digitization workflow
- Discogs integration with visual search
- Interactive waveform editor with draggable track boundaries
- Manual track splitting and deletion
- Vinyl-style track numbering (A1, A2, B1, B2)
- FLAC, MP3, and AIFF output
- WAV and AIFF input
- Duration-based splitting fallback
- WebSocket real-time progress
- Docker one-command setup
- **Web-based first-run setup** — no more hidden `.env` files!

### Added in this fork
- Discogs-first flow with side/disc picker and best-match splits from track lengths
- Import recordings in place from a folder
- Click & pop removal, rumble filter, hum removal, hiss reduction, with a one-track A/B test
- Optional album gain and ReplayGain tags, shared across the discs of a release
- Per-recording workspaces, Process all ready, and queued exports
- Source bit depth kept on export (24-bit stays 24-bit)
- Richer tags: album artist, track/disc totals, compilation flag and per-track artists, classical composer/conductor/ensemble/performers
- Fully offline interface, localhost-only by default

### Planned
- BPM and key detection
- Rekordbox / Traktor export
- MusicBrainz integration
- Cloud-hosted option

---

## Contributing

Found a bug in this fork? [Open an issue here](https://github.com/tkah/vinylflow/issues). Issues with the
original app belong at [olimic1000/vinylflow](https://github.com/olimic1000/vinylflow/issues).

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

**VinylFlow** — Built with ❤️ by DJs, for DJs.