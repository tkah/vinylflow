/**
 * VinylFlow Frontend Application
 * Alpine.js application for managing vinyl digitization workflow
 */

// Region colour palette (no red, so no cycle colour can look like an ignored track)
const TRACK_COLORS = [
    'rgba(59, 130, 246, 0.3)',
    'rgba(16, 185, 129, 0.3)',
    'rgba(245, 158, 11, 0.3)',
    'rgba(139, 92, 246, 0.3)',
    'rgba(236, 72, 153, 0.3)',
    'rgba(6, 182, 212, 0.3)',
    'rgba(132, 204, 22, 0.3)',
];
// Ignored tracks: neutral grey, lower opacity than the palette
const IGNORED_TRACK_COLOR = 'rgba(120, 120, 120, 0.15)';
// Shortest track a drag / inline edit may produce (seconds)
const MIN_TRACK_LENGTH = 1;
// Cuts closer than this are "touching": the neighbour follows when a shared cut moves (seconds)
const TOUCHING_CUTS_S = 0.05;
// "3.45" typed as a length: seconds by our parser, but almost always meant as m:ss
const MINUTES_DOT_SECONDS_PATTERN = /^\d{1,2}\.\d{2}$/;
// ... offered as m:ss only while its seconds are below this
const SECONDS_PER_MINUTE = 60;
// A dragged region that ends further than this from the requested edge was clamped (seconds)
const REGION_CLAMP_TOLERANCE_S = 0.01;
// Focused elements that use Space themselves: the global Play/Pause shortcut leaves them alone.
// A BUTTON is not in the set: it keeps Space only when keyboard-focused (see onGlobalKeydown).
const SPACE_OWNING_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
// Set once the document listeners exist (init() runs twice on the page)
let globalListenersBound = false;
// A failed peaks request with one of these statuses means the server refuses the source itself
// (imported file gone / changed), so the audio URL would be refused the same way: no fallback player.
const SOURCE_REFUSED_STATUSES = new Set([409, 410]);
// Where the player volume (0-1) is remembered between sessions
const PLAYER_VOLUME_STORAGE_KEY = 'vinylflow.playerVolume.v1';
const DEFAULT_PLAYER_VOLUME = 1;
// Dashed ghost markers on the waveform: where the Discogs lengths expect each break (not draggable).
// Opaque #9C2418; contrast (WCAG): 7.4:1 on the card (#FAF9F6), 5.1:1 at worst on a 30 % region tint
// over the card, and 3.3:1 at worst over a region tint on the unplayed bars (#93C5FD), so 3:1 for
// graphics holds there. (#B02A1E gave only 2.8:1 over the pink and purple regions on the bars.) Over
// the played bars (#1d4ed8) it is only 1.2-1.6:1; there the marker is told apart by its dashed line
// running above and between the bars, not by contrast with them.
const EXPECTED_MARKER_COLOR = '#9C2418';
// Longest title shown in a waveform region label
const REGION_TITLE_MAX = 28;
// Version the allowlisted editing state; no audio, source paths, or credentials are stored.
const WORKSPACE_STORAGE_KEY = 'vinylflow.workspaces.v1';
const WORKSPACE_VERSION = 1;
const WORKSPACE_SAVE_DELAY_MS = 400;
const PROCESS_POLL_INTERVAL_MS = 1500;
const PREVIEW_AUDIO_NOTICE = "Playing the preview \u2014 this browser can't play the original WAV, so cut points may be up to ~50 ms less precise.";
// Discogs results per search fetch ("Load more" fetches the next page). Each result's release page
// is fetched for its lengths, so one fetch costs this many + 1 rate-limited Discogs calls.
const SEARCH_PAGE_SIZE = 12;
// Fetches per query, the first included; must match SEARCH_MAX_PAGES in backend/api.py.
const SEARCH_MAX_PAGES = 3;

// Most tracks one guided detection places. Must match MAX_EXPECTED_TRACKS in backend/api.py.
const MAX_GUIDED_TRACKS = 99;
// Release fetches one lookup for other pressings may spend at most (mirrors find_length_donors' max_fetches)
const DONOR_FETCH_BUDGET = 12;
// Shown when an Undo finds the release object replaced: by a later edit (undoing would discard it) or by
// reopening the recording (its workspace is restored as a clone, so identity can't tell the two apart)
const RELEASE_CHANGED_NOTICE = 'This can no longer be undone: the release was edited or the recording was reopened since.';
// Additional workspace fields are optional when reading saves made before Plan 05.
const WORKSPACE_ADDITIONS = { searchResults: [], onlyWithLengths: false, detailsSettled: false, currentZoom: 50,
    searchedQuery: '', searchPage: 0, searchHasMore: false, prefixPartTitles: true, titleSource: null,
    sidesTouched: false };
// The "number after /release/" help line shows for this many recordings, then only after a failed lookup.
const RELEASE_ID_HELP_STORAGE_KEY = 'vinylflow.releaseIdHelp.v1';
const RELEASE_ID_HELP_MAX_RECORDINGS = 5;

/** Recording ids that have shown the release-number help; storage may be missing, denied or corrupt. */
function loadReleaseIdHelpSeen() {
    try {
        const seen = JSON.parse(window.localStorage.getItem(RELEASE_ID_HELP_STORAGE_KEY) || '[]');
        return Array.isArray(seen) ? seen.filter(id => typeof id === 'string').slice(0, RELEASE_ID_HELP_MAX_RECORDINGS) : [];
    } catch (error) { return []; }
}
// Wheel/pinch zoom speed: zoom factor = exp(-deltaY * rate); one 100 px wheel notch ≈ x1.35
const WHEEL_ZOOM_RATE = 0.003;
// Custom tracks (must match CustomTrack in backend/api.py): new positions are A1/B12; titles <= 200 chars.
const CUSTOM_POSITION_RE = /^[A-Z]+\d+$/;
const CUSTOM_TITLE_MAX = 200;
// Toast stack cap: past it the oldest toast without an action makes room (an Undo is never evicted)
const MAX_TOASTS = 5;
// How long an Undo toast stays (ms)
const UNDO_TOAST_MS = 8000;
// Dragging a track wider than the view keeps its leading edge this far (fraction of the view) in from the screen edge
const DRAG_EDGE_MARGIN = 0.15;
const REGION_EDGE_HIT_PX = 6;
const REGION_SHARED_EDGE_PX = 1;
const WORKSPACE_FIELDS = [
    'detectedTracks', 'selectedRelease', 'selectedSides', 'suggestedSides',
    'sidesMatchedByDuration', 'sidesSuggestionReason', 'customMapping', 'trackMappingReversed',
    'expectedBoundaries', 'boundariesEdited', 'searchQuery', 'expectedTracks',
    'outputFormat', 'rumbleFilter', 'declick', 'humFilter', 'humFreq',
    'hissReduction', 'hissStrength', 'albumGain', 'playTime', ...Object.keys(WORKSPACE_ADDITIONS)
];

// Keep WaveSurfer objects out of Alpine's reactive proxies. Through a proxy,
// WaveSurfer's identity checks fail (a removed region compares proxy vs raw and
// stays in the plugin's list, so the next remove() throws and aborts the caller).
function markRaw(obj) {
    if (obj && typeof obj === 'object') {
        Object.defineProperty(obj, '__v_skip', { value: true, configurable: true });
    }
    return obj;
}

// A Discogs id: 1-10 digits, no leading zero (so 0, m0 and release/0 are not references).
const DISCOGS_ID = '[1-9]\\d{0,9}';
const DISCOGS_BARE_RELEASE = new RegExp(`^\\[?r?(${DISCOGS_ID})\\]?$`, 'i');
const DISCOGS_BARE_MASTER = new RegExp(`^\\[?m(${DISCOGS_ID})\\]?$`, 'i');
// Website link: scheme and www./m. optional, any path prefix segments (language, sell, old
// Artist-Title slug), then release/<id> or master/<id> ending the input or followed by - / ? #.
const DISCOGS_WEB_LINK = new RegExp(
    `^(?:https?://)?(?:www\\.|m\\.)?discogs\\.com/(?:[^\\s/?#]+/)*(release|master)/(${DISCOGS_ID})(?:[-/?#]\\S*)?$`, 'i');
// API link: api.discogs.com/releases/<id> or /masters/<id>, ending the input or followed by / ? #.
const DISCOGS_API_LINK = new RegExp(
    `^(?:https?://)?api\\.discogs\\.com/(release|master)s/(${DISCOGS_ID})(?:[/?#]\\S*)?$`, 'i');

/**
 * A Discogs release reference typed or pasted by the user: "2874426", "r2874426",
 * "[r2874426]", "m123" (master), or a link that is the whole input: discogs.com/release/<id>
 * or /master/<id> (optional http(s)://, www. or m.; any path before it such as /pt_BR/,
 * /sell/ or the old artist-slug form; a "-slug", "/", "?" or "#" may follow the id), or
 * api.discogs.com/releases/<id> / masters/<id>. Ids have at most 10 digits and are never 0;
 * anything else (other hosts, text around the link, longer ids) is null. One wrapping layer
 * (<>, quotes, parentheses) and trailing . , ; : ! ? ) are stripped first, for links pasted from prose.
 * Returns {id}, {master: id} for a master release (not one exact version), or null.
 */
function parseDiscogsRelease(text) {
    let s = String(text || '').trim();
    // Pasted from prose: drop one wrapping layer (<>, quotes, parentheses) and trailing punctuation.
    // Punctuation after the wrapper goes first ("…/release/5",), but not ")", which may close it.
    s = s.replace(/[.,;:!?]+$/, '');
    const wrapped = s.match(/^(?:<(.*)>|"(.*)"|'(.*)'|\((.*)\))$/s);
    if (wrapped) s = (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? wrapped[4]).trim();
    s = s.replace(/[.,;:!?)]+$/, '');
    let m = s.match(DISCOGS_BARE_RELEASE);
    if (m) return { id: Number(m[1]) };
    m = s.match(DISCOGS_BARE_MASTER);
    if (m) return { master: Number(m[1]) };
    m = s.match(DISCOGS_WEB_LINK) || s.match(DISCOGS_API_LINK);
    if (m) return m[1].toLowerCase() === 'release' ? { id: Number(m[2]) } : { master: Number(m[2]) };
    return null;
}

// ---- Movements from another release (plan 14; pure helpers, exposed on the app object for tests) ----

// "With" choice meaning the donor's top-level tracks instead of one of its index tracks
// (sent as donor_position: null).
const MOVEMENTS_ALL_DONOR_TRACKS = '__all__';

/** Title key for matching works across releases: lowercase, no diacritics, parentheticals or punctuation. */
function normalizeWorkTitle(title) {
    return String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 2 = same work title, 1 = one starts with the other, 0 = no match. */
function workTitleMatchScore(first, second) {
    const a = normalizeWorkTitle(first), b = normalizeWorkTitle(second);
    if (!a || !b) return 0;
    return a === b ? 2 : (a.startsWith(b) || b.startsWith(a)) ? 1 : 0;
}

/** Slot positions grouped by consecutive side letter: ['A', 'B1'] -> [{side:'A', slots:['A']}, {side:'B', slots:['B1']}]. */
function slotGroups(slots) {
    const groups = [];
    for (const slot of slots) {
        const side = /^[A-Z]+/.exec(String(slot))?.[0] || '';
        const last = groups[groups.length - 1];
        if (last && last.side === side) last.slots.push(slot);
        else groups.push({ side, slots: [slot] });
    }
    return groups;
}

/**
 * New positions for borrowed movements, one flat list in order.  counts[i] movements go to group i:
 * exactly one keeps the group's first slot position (a bare side letter "A" becomes "A1"); several
 * give A1..An after a bare side letter, else "<slot>.<n>" ("B1" -> B1.1, B1.2, ...), which sorts
 * before the next track (B2) in positionKey.  Mirrors the contract the backend validates.
 */
function borrowedPositions(slots, counts) {
    const out = [];
    slotGroups(slots).forEach((group, index) => {
        const first = group.slots[0], bare = /^[A-Z]+$/.test(first), count = counts[index] || 0;
        for (let n = 1; n <= count; n++) {
            out.push(count === 1 ? (bare ? `${first}1` : first) : bare ? `${first}${n}` : `${first}.${n}`);
        }
    });
    return out;
}

/**
 * How many movements each position group gets.  With measured `targets` (cumulative music seconds
 * at the end of each group but the last) every boundary takes the cut whose cumulative donor length
 * is nearest; without them (or with an unknown length) movements are split proportionally by count.
 * Every group keeps at least one movement; null when there are fewer movements than groups.
 */
function defaultMovementSplit(durationsSeconds, targets, groupCount) {
    const total = durationsSeconds.length;
    if (groupCount < 1 || total < groupCount) return null;
    const useTargets = Array.isArray(targets) && targets.length === groupCount - 1 &&
        durationsSeconds.every(Number.isFinite);
    const cumulative = [0];
    durationsSeconds.forEach((seconds, i) => cumulative.push(cumulative[i] + (Number(seconds) || 0)));
    const cuts = [];
    for (let boundary = 1; boundary < groupCount; boundary++) {
        const lowest = (cuts[boundary - 2] || 0) + 1, highest = total - (groupCount - boundary);
        let cut;
        if (useTargets) {
            cut = lowest;
            for (let k = lowest; k <= highest; k++) {
                if (Math.abs(cumulative[k] - targets[boundary - 1]) < Math.abs(cumulative[cut] - targets[boundary - 1])) cut = k;
            }
        } else {
            cut = Math.max(lowest, Math.min(highest, Math.round(total * boundary / groupCount)));
        }
        cuts.push(cut);
    }
    return [...cuts, total].map((cut, i) => cut - (cuts[i - 1] || 0));
}

// ---- Click detection helpers (pure; exposed on the app object for tests) ----

/** Number of sorted click times t with start <= t < end (binary search). */
function countClicksInRange(times, start, end) {
    if (!Array.isArray(times) || !(end > start)) return 0;
    const lowerBound = (x) => {
        let lo = 0, hi = times.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (times[mid] < x) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
    return lowerBound(end) - lowerBound(start);
}

/**
 * Bin click times into `bins` equal columns over [0, duration].
 * Returns an array of counts; times outside the range are ignored.
 */
function clickDensityBins(times, duration, bins) {
    const n = Math.max(0, Math.floor(bins) || 0);
    const out = new Array(n).fill(0);
    if (!n || !(duration > 0) || !Array.isArray(times)) return out;
    for (const t of times) {
        if (!(t >= 0 && t <= duration)) continue;
        out[Math.min(n - 1, Math.floor((t / duration) * n))]++;
    }
    return out;
}

/** Tick opacity for a bin: faint for a lone click, solid once 4+ share a column. */
function clickTickAlpha(count) {
    return count > 0 ? 0.3 + 0.7 * Math.min(1, count / 4) : 0;
}

/** A search result card; tracks: null = tracklist not loaded yet (filled in progressively). */
function newSearchCard(result) {
    return { ...result, tracks: result.tracks ?? null, detailStatus: 'pending', opening: false };
}

// The share of peaks that must fit under full height: the 99.9th percentile, so a needle-drop thump
// or a few clicks (single loud 10 ms bins) do not make the music of a quiet side look low.
const PEAK_SCALE_PERCENTILE = 0.999;
// ...but never below this share of the loudest bin: a recording that is mostly digital silence has a
// ~0 percentile, which would stretch its few real peaks into a solid block.
const PEAK_SCALE_FLOOR_FRACTION = 1 / 8;

// A failed preview that the server is still preparing is polled this often, for at most this long
// (the encode of even a long album takes well under it), before the notice is left as it is.
const PREVIEW_POLL_INTERVAL_MS = 3000;
const PREVIEW_POLL_MAX_MS = 10 * 60 * 1000;

/**
 * Scale waveform peaks so the recording's 99.9th-percentile peak is full height (louder bins clip
 * at +-1). Replaces WaveSurfer's `normalize`, which scales each rendered canvas (one per screen
 * width when zoomed) to its own loudest bar and so stretches the surface noise of a gap to full
 * height. The reference is found by sorting one Float64Array copy (an album has ~1.4 M peaks), not
 * Math.max(...peaks), whose arguments would overflow the stack.
 */
function scalePeaksToRecording(peaks) {
    if (!peaks.length) return peaks;
    const magnitudes = Float64Array.from(peaks, peak => Math.abs(peak));
    magnitudes.sort();
    const percentile = magnitudes[Math.ceil(PEAK_SCALE_PERCENTILE * magnitudes.length) - 1];
    const reference = Math.max(percentile, magnitudes[magnitudes.length - 1] * PEAK_SCALE_FLOOR_FRACTION);
    if (!(reference > 0)) return peaks;
    return peaks.map(peak => Math.max(-1, Math.min(1, peak / reference)));
}

// Density strip: a thin canvas overlaid on the bottom of the waveform wrapper.
const CLICK_STRIP_HEIGHT = 6;
const CLICK_STRIP_MAX_PX = 16384;   // browsers cap canvas width (~32k); CSS stretches it
const CLICK_STRIP_COLOR = '217, 64, 50';

// A/B "Removed" boost: audio element -> { ctx, source, gain } (one MediaElementSource per element)
const _abBoostNodes = new WeakMap();

// What a media element's error code means, for the notice when WaveSurfer re-emits it without a message.
const MEDIA_ERROR_MESSAGES = {
    1: 'playback was aborted',
    2: 'a network error interrupted the audio download',
    3: 'the audio could not be decoded',
    4: 'the audio format is not supported',
};

/** The remembered player volume, or the default when it is missing, invalid or storage is unavailable */
function readStoredPlayerVolume() {
    try {
        const stored = localStorage.getItem(PLAYER_VOLUME_STORAGE_KEY);
        if (stored === null || String(stored).trim() === '') return DEFAULT_PLAYER_VOLUME;
        const volume = Number(stored);
        return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_PLAYER_VOLUME;
    } catch (error) {
        return DEFAULT_PLAYER_VOLUME;
    }
}

function vinylApp() {
    return {
        // WebSocket connection
        ws: null,
        wsPingTimer: null,

        // UI State
        dragging: false,
        showSettings: false,
        settingsSnapshot: null,   // config as saved, taken when Settings opens; Cancel / Escape / click-away restore it
        uploadProgress: 0,
        uploadFinalizing: false,
        uploadNotice: '',
        // Import from folder (files read in place, no browser upload)
        importTab: 'upload',            // 'folder' | 'upload'
        importInfo: { enabled: false, dir: '', error: null, files: [] },
        importSelected: [],             // names ticked in the folder list
        importBusy: false,              // POST /api/import in flight
        importLoading: false,           // GET /api/import in flight
        desktopPicker: false,           // pywebview bridge offers a native file dialog
        analyzing: false,
        searchLoading: false,
        searchNotice: '',
        releaseIdInput: '',      // exact Discogs release: ID or pasted link
        releaseIdNotice: '',
        releaseIdHelpSeen: loadReleaseIdHelpSeen(),
        releaseIdLoading: false,
        trackCountMismatch: false,
        autoRetryAttempts: 0,
        maxAutoRetries: 3,

        // Files and Queue
        uploadedFiles: [],
        currentFileId: null,
        currentFile: null,
        workspaces: {},
        workspaceNotice: '',
        _workspaceSaveTimer: null,
        _workspacesLoaded: false,

        // Analysis
        detectedTracks: [],

        // Waveform
        isPlaying: false,
        playTime: 0,
        playDuration: 0,
        playheadIdx: -1,       // index of the track under the playhead (-1 = gap / none)
        playerNotice: '',
        playerInfo: '',        // muted, persistent note (preview fallback); playerNotice is for errors
        _audioSource: null,    // {waveform, fileId, precise, peaks, duration, fellBack, settled, generation} of the loaded audio (raw)
        playerBuffering: false,
        waveView: { start: 0, end: 1 },   // visible part of the waveform (fractions), for the scrollbar
        _waveScroller: null,
        _pendingSeek: null,
        _auditionStop: null,   // one-shot stop time (s) for cut-point auditions
        playerVolume: readStoredPlayerVolume(),   // 0-1, shared by the waveform and the fallback player
        fallbackAudioUrl: '',   // plain <audio> source while the waveform could not be built
        _spaceClaimedByPlayer: false,   // the last Space keydown toggled playback: cancel its keyup too
        // How the focused element got its focus.  Changes on every pointerdown and is read by no
        // template, so it lives in a markRaw holder: no reactive writes, no re-render.
        _pointerFocus: markRaw({ pending: false, byPointer: false, lastFocusIn: null, lastFocused: null }),
        waveform: null,
        waveformLoading: false,
        previewPollIntervalMs: PREVIEW_POLL_INTERVAL_MS,   // instance fields so tests can shorten them
        previewPollMaxMs: PREVIEW_POLL_MAX_MS,
        waveformRegions: null,
        currentZoom: 50,
        prefixPartTitles: true,   // title split index-track parts "Work: Part" in tags/filenames and the UI

        // Context Menu for waveform splits
        contextMenu: {
            show: false,
            x: 0,
            y: 0,
            time: 0
        },

        // Context Menu for region actions
        regionContextMenu: {
            show: false,
            x: 0,
            y: 0,
            trackNumber: null,
            isIgnored: false,
            time: 0  // Position for split functionality
        },

        // Discogs Search
        searchQuery: '',
        searchResults: [],
        selectedRelease: null,
        trackMappingReversed: false,
        customMapping: [],
        trackForm: null,          // Inline custom-track / rename form under a row: {fileId, idx, mode: 'add'|'edit', position, title, error}
        expectedBoundaries: [],   // Seconds where Discogs lengths put each break (ghost markers)
        boundariesEdited: false,  // True once the user hand-edits boundaries (until detection replaces them)
        boundaryEditCount: 0,     // Bumped by every hand edit and Undo restore, so a guided reply started before one is discarded
        editBanner: false,        // Show "You've adjusted boundaries by hand" choice
        snapUndo: null,           // Snapshot taken before Snap to Discogs
        snapNotice: '',
        onlyWithLengths: false,   // Result filter: hide releases without track lengths
        selectedSides: [],        // Side keys ('A', 'B', '' = unlettered) the recording covers
        suggestedSides: [],       // Sides auto-picked when the release was selected
        sidesMatchedByDuration: false,
        sidesSuggestionReason: '',   // 'length' | 'default' | 'single' | '' (how suggestedSides was chosen)
        sidesTouched: false,         // The user picked sides (chip or preset) since the release was selected
        // Borrow track lengths from another pressing (state for the selected release only)
        donors: { releaseId: null, status: 'idle', checked: 0, versions: null, budget: DONOR_FETCH_BUDGET, list: [], error: '' },
        _donorSeq: 0,             // Guards against stale length-donor responses
        _movementsSeq: 0,         // Guards against stale side-split measurements
        titleSource: null,        // movements borrowed from another release (workspace field; sent as title_source on export)
        movementsPanel: { open: false, input: '', loading: false, error: '', donor: null,
            replacePosition: '', donorPosition: '', starts: [], splitNote: '' },
        searchSeq: 0,             // Guards against stale search responses
        searchedQuery: '',        // Query the shown results came from ("Load more" continues it, not the edited box)
        searchPage: 0,            // Discogs result pages fetched for it
        searchHasMore: false,     // Discogs has another page and the fetch limit allows it
        searchMoreLoading: false,
        searchMoreError: '',
        searchMoreNotice: '',     // After a Load more that added nothing: "No more results." (last page) or "No new results on this page." (Load more stays)
        detailsSettled: false,    // True once every result's tracklist load finished/failed
        _detailInflight: {},      // `${searchSeq}:${releaseId}` -> in-flight detail fetch promise
        _pendingPickId: null,     // Card clicked while its tracklist loads; a later pick clears it
        _releaseIdCall: 0,        // Bumped per "exact pressing" lookup; only the latest resets releaseIdLoading

        // Smart Rescan
        expectedTracks: null,
        rescanNotice: '',

        // Processing
        isProcessing: false,
        processingProgress: 0,
        processingMessage: '',
        successMessage: '',
        currentJobId: null,
        processPollTimer: null,
        _processPollToken: 0,
        lastProgressAt: null,
        batchProcessing: false,
        batchItems: [],
        batchSummary: null,
        _activeExportFileId: null,
        _exportAttempt: 0,
        _batchFileId: null,
        _batchResolve: null,
        exportQueue: [],          // Frozen single exports waiting for the running one (browser-side only, FIFO)
        _restoreZoom: null,
        currentAlbumJobId: null,
        albumWarnings: [],
        _albumResolve: null,

        // Output format
        outputFormat: 'flac',
        availableFormats: [],

        // Audio processing panel (Plan 07 slice 1). Defaults persist via saveExportDefault.
        rumbleFilter: false,   // 15 Hz high-pass
        declick: 'off',        // 'off' | 'light' | 'medium' | 'strong'
        declickLevels: [
            { id: 'off', label: 'Off' }, { id: 'light', label: 'Light' },
            { id: 'medium', label: 'Medium' }, { id: 'strong', label: 'Strong' }
        ],
        albumGain: false,      // one gain for the whole album (-14 LUFS), off by default

        // Hum removal + hiss reduction (Plan 07 slice 4): both off by default.
        humFilter: false,      // mains-hum notch (+ harmonics)
        humFreq: 60,           // 50 | 60
        hissReduction: 'off',  // 'off' | 'light' | 'medium' | 'strong' (the toggle maps off <-> hissStrength)
        hissStrength: 'light', // last chosen strength, remembered while the feature is off
        hissLevels: [
            { id: 'light', label: 'Light' }, { id: 'medium', label: 'Medium' }, { id: 'strong', label: 'Strong' }
        ],
        // Hum detector (silent stretches only), per file id ->
        // { status: 'loading'|'done'|'error', detected: 50|60|null, level_dbfs, prominence_db, harmonics }
        humInfo: {},

        // Click detection (Plan 07 slice 2): per file id ->
        // { strength, requested, status: 'running'|'done'|'error', progress, times, scannedAt }
        clickScans: {},
        _clickPollTimers: {},
        _clickCanvas: null,
        _clickWrapper: null,

        // A/B test of the audio processing chain on one track (Plan 06 slice 1)
        abTrackIdx: null,      // chosen track index; null = follow playhead / first active
        abRendering: false,
        abError: '',
        abResult: null,        // { original_url, processed_url, *_lufs, gain_db, chain, sig, rumble, declick, album }
        abSide: 'original',    // 'original' | 'processed' | 'removed'
        abBoost: true,         // Removed: +12 dB via WebAudio (only while Removed is selected)
        abAudioFailed: false,  // WebAudio unusable -> Removed plays at unity, checkbox hidden
        abPlaying: false,
        abTime: 0,
        abDur: 0,
        abMatch: true,
        _abSeq: 0,

        // Toasts (see notify) and soft-removed queue files awaiting their DELETE
        toasts: [],
        _toastSeq: 0,
        _toastTimers: {},
        pendingRemovals: {},   // fileId -> { file, order, wasCurrent, toastId, committed }

        // Config
        config: {
            silence_threshold: -40,
            min_silence_duration: 1.5,
            track_numbering: 'sequential_disc_per_lp',
            min_track_length: 30,
            flac_compression: 8,
            output_dir: '',
            output_format: 'flac',
            bit_depth: 'source',
            rumble_filter: false,
            declick: 'off',
            hum_filter: false,
            hum_freq: 60,
            hiss_reduction: 'off',
            hiss_strength: 'light',
            album_gain: false,
            replaygain: true,
            hide_support_ask: false,
            album_description: false   // global like output_dir: not a workspace field
        },

        // Wikipedia description of the selected release (from our backend; never stored). Shown
        // only while releaseId matches selectedRelease.id, so a stale state is simply hidden.
        albumDescription: { releaseId: null, status: 'idle', text: '', title: '', url: '' },
        albumDescriptionExpanded: false,   // "Show more" in the preview

        // Supported input file extensions
        supportedExtensions: ['.wav', '.aiff', '.aif'],

        // Status
        discogsConfigured: true,

        // Setup (first-run)
        setupRequired: false,
        setupLoading: false,
        setupError: null,
        setupToken: '',
        setupUserAgent: 'VinylFlow/1.0',

        /**
         * Document-level listeners for the Space shortcut and its pointer-focus tracking.  The page
         * calls init() twice (Alpine runs it, and index.html also has x-init="init()"), so they are
         * bound once per page.  The handlers stay safe if they ever run twice for one event.
         */
        bindGlobalListeners() {
            if (globalListenersBound) return;
            globalListenersBound = true;
            // Space toggles waveform play/pause
            document.addEventListener('keydown', (e) => this.onGlobalKeydown(e));
            document.addEventListener('keyup', (e) => this.onGlobalKeyup(e));
            // Capture phase, so no handler that stops propagation hides how focus arrived
            document.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
            document.addEventListener('pointerup', () => this.onPointerUp(), true);
            document.addEventListener('pointercancel', () => this.onPointerCancel(), true);
            document.addEventListener('focusin', (e) => this.onFocusIn(e), true);
        },

        /**
         * Initialize the application
         */
        async init() {
            // Suppress the native WebKit/WKWebView context menu globally.
            // WaveSurfer v7 renders inside a shadow DOM; by the time the
            // 'contextmenu' event bubbles to our container listener WKWebView
            // has already decided to show its native menu.  Calling
            // preventDefault() in the capture phase (before any shadow-DOM
            // handler fires) is the only reliable way to stop it.
            document.addEventListener('contextmenu', e => e.preventDefault(), true);

            this.bindGlobalListeners();

            // Files removed from the queue are deleted server-side after an
            // undo window; flush them if the page goes away first.
            window.addEventListener('pagehide', () => {
                this.saveWorkspace();
                this.commitAllRemovals({ keepalive: true });
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.saveWorkspace();
            });

            // Keep waveform region labels in step with the mapping
            this.$watch('customMapping', () => this.refreshRegionLabels());
            this.$watch('selectedRelease', () => this.refreshRegionLabels());
            this.$watch('selectedSides', () => this.refreshRegionLabels());
            // Freeze / release region dragging when the viewed recording's lock changes
            this.$watch('currentLocked', () => { if (this.waveform && this.waveformRegions) this.addTrackRegions(); });

            await this.loadConfig();
            await this.loadFormats();
            // Fall back to FLAC if the remembered format isn't offered by the backend
            if (!this.availableFormats.some(f => f.id === this.outputFormat)) {
                this.outputFormat = 'flac';
            }
            await this.checkStatus();
            await this.loadWorkspaces();
            for (const field of [...WORKSPACE_FIELDS, 'config.bit_depth', 'config.replaygain']) {
                this.$watch(field, () => this.scheduleWorkspaceSave());
            }
            this.connectWebSocket();

            // Import from folder: pywebview injects its bridge asynchronously
            this.detectDesktopPicker();
            window.addEventListener('pywebviewready', () => this.detectDesktopPicker());
            await this.loadImportList();
            this.chooseDefaultImportTab();

            this.$watch('currentFile', (file) => {
                if (file && !this.searchQuery) {
                    this.searchQuery = this.cleanFilename(file.filename);
                }
            });
        },

        // ---------------------------------------------------------------
        // Toasts / notices
        // ---------------------------------------------------------------

        /**
         * Show a toast.  notify(message, { type, action: {label, fn}, timeout, onClose })
         *  - type: 'info' | 'success' (auto-dismiss ~5 s) | 'warning' | 'error' (sticky)
         *  - timeout: ms override (0 = sticky)
         *  - action: button on the toast; clicking runs fn and closes the toast
         *  - onClose(reason): reason is 'timeout' | 'dismiss' | 'action' | 'commit' | 'evict'
         *    (used by undo flows; 'commit' = a pending removal was committed early,
         *    'evict' = pushed out by the stack cap, which never happens to a toast with an action)
         * Hovering a toast pauses its timer.  Returns the toast id.
         */
        notify(message, opts = {}) {
            const type = ['info', 'success', 'warning', 'error'].includes(opts.type) ? opts.type : 'info';
            const sticky = type === 'warning' || type === 'error';
            const timeout = opts.timeout !== undefined ? opts.timeout : (sticky ? 0 : 5000);
            message = String(message);

            // An identical toast already on screen is refreshed, not stacked
            const dup = this.toasts.find(t => t.message === message && t.type === type && !t.action && !opts.action);
            if (dup) {
                this._armToast(dup.id, timeout);
                return dup.id;
            }

            const id = ++this._toastSeq;
            this.toasts.push({
                id, message, type,
                action: opts.action || null,
                onClose: opts.onClose || null
            });
            // Keep the stack short: the oldest other toast without an action makes room.  Toasts
            // with an action (Undo) are never evicted, so the stack may grow past the cap.
            while (this.toasts.length > MAX_TOASTS) {
                const oldest = this.toasts.find(t => !t.action && t.id !== id);
                if (!oldest) break;
                this.dismissToast(oldest.id, 'evict');
            }
            this._armToast(id, timeout);
            return id;
        },

        /** Type icon shown before a toast's message (decorative: the type word is read instead) */
        toastIcon(type) {
            return { success: '\u2713', warning: '\u26a0', error: '\u2715' }[type] || '\u2139';
        },

        _armToast(id, ms) {
            this._clearToastTimer(id);
            if (!(ms > 0)) return;
            const handle = setTimeout(() => this.dismissToast(id, 'timeout'), ms);
            if (handle && handle.unref) handle.unref();   // Node (frontend tests) only
            this._toastTimers[id] = { handle, remaining: ms, startedAt: Date.now() };
        },

        _clearToastTimer(id) {
            const t = this._toastTimers[id];
            if (t) clearTimeout(t.handle);
            delete this._toastTimers[id];
        },

        /** Hover: stop the countdown, remembering how much was left */
        pauseToast(id) {
            const t = this._toastTimers[id];
            if (!t || t.paused) return;
            clearTimeout(t.handle);
            t.remaining = Math.max(t.remaining - (Date.now() - t.startedAt), 500);
            t.paused = true;
        },

        /** Mouse leave: continue with the remaining time */
        resumeToast(id) {
            const t = this._toastTimers[id];
            if (!t || !t.paused) return;
            this._armToast(id, t.remaining);
        },

        /** Close a toast; reason is passed to its onClose callback */
        dismissToast(id, reason = 'dismiss') {
            const i = this.toasts.findIndex(t => t.id === id);
            if (i === -1) return;
            const [toast] = this.toasts.splice(i, 1);
            this._clearToastTimer(id);
            if (toast.onClose) {
                try { toast.onClose(reason); } catch (e) { console.error('Toast onClose failed:', e); }
            }
        },

        /** Run a toast's action button */
        runToastAction(id) {
            const toast = this.toasts.find(t => t.id === id);
            if (!toast || !toast.action) return;
            const fn = toast.action.fn;
            this.dismissToast(id, 'action');
            if (fn) fn();
        },

        /** Convenience for error toasts from catch blocks */
        notifyError(prefix, error) {
            const detail = error && error.message ? error.message : String(error || '');
            return this.notify(detail ? `${prefix}: ${detail}` : prefix, { type: 'error' });
        },

        /** Why an edit Undo for `fileId` can't run now, or '' when it can. */
        undoBlockedReason(fileId) {
            if (this.currentFileId !== fileId) return 'Switch back to that file to undo.';
            if (this.analyzing) return 'Wait for track detection to finish, then undo.';
            if (this.isLocked(fileId)) return "Can't undo while this recording is exporting.";
            return '';
        },

        /**
         * Undo toast.  Its button first checks undoBlockedReason(fileId); a refusal is a
         * warning toast and leaves the state alone.  guard: false skips that check (file
         * removal must stay undoable while another file is open).
         */
        notifyUndo(message, undo, { fileId = null, guard = true, type = 'info', timeout = UNDO_TOAST_MS, onClose } = {}) {
            return this.notify(message, {
                type, timeout, onClose,
                action: {
                    label: 'Undo',
                    fn: () => {
                        const blocked = guard ? this.undoBlockedReason(fileId) : '';
                        if (blocked) {
                            this.notify(blocked, { type: 'warning', timeout: 6000 });
                            return;
                        }
                        undo();
                    }
                }
            });
        },

        /** Read the active editor without cloning large search results on every queue update. */
        currentWorkspaceState(includePlaybackPosition = true) {
            const state = {};
            // Queue/readiness effects must not subscribe to the per-frame playback clock.
            for (const field of WORKSPACE_FIELDS) {
                if (includePlaybackPosition || field !== 'playTime') state[field] = this[field];
            }
            state.bitDepth = this.config.bit_depth;
            state.replaygain = this.config.replaygain;
            const file = this.uploadedFiles.find(entry => entry.id === this.currentFileId) || this.currentFile;
            state.completedExportSignature = file?.completedExportSignature || null;
            state.pendingExportSignature = file?.pendingExportSignature || null;
            state.pendingExportAccepted = file?.pendingExportAccepted !== false;
            state.pendingAlbumJobId = file?.pendingAlbumJobId || null;
            state.pendingAlbumContext = file?.pendingAlbumContext || null;
            state.completedAlbumContext = file?.completedAlbumContext || null;
            return state;
        },

        /** Freeze allowlisted editing state for storage; no player instances or credentials. */
        captureWorkspace() {
            return JSON.parse(JSON.stringify(this.currentWorkspaceState()));
        },

        /** The active editor is authoritative, including changes not yet flushed by autosave. */
        workspaceFor(fileId) {
            return fileId === this.currentFileId ? this.currentWorkspaceState(false) : this.workspaces[fileId];
        },

        /** Save the active editor before switching files or freezing a batch. */
        saveWorkspace() {
            clearTimeout(this._workspaceSaveTimer);
            this._workspaceSaveTimer = null;
            if (this.currentFileId && !this.pendingRemovals[this.currentFileId]) {
                this.workspaces = { ...this.workspaces, [this.currentFileId]: this.captureWorkspace() };
            }
            this.persistWorkspaces();
        },

        /** Debounce deep Alpine watchers; pagehide/visibilitychange also flush synchronously. */
        scheduleWorkspaceSave() {
            clearTimeout(this._workspaceSaveTimer);
            this._workspaceSaveTimer = setTimeout(() => this.saveWorkspace(), WORKSPACE_SAVE_DELAY_MS);
        },

        /** Browser storage may be unavailable or full; keep the in-memory workspace usable. */
        persistWorkspaces() {
            // Never overwrite an existing save before checking the server queue successfully.
            if (!this._workspacesLoaded) return;
            try {
                window.localStorage.setItem(WORKSPACE_STORAGE_KEY,
                    JSON.stringify({ version: WORKSPACE_VERSION, workspaces: this.workspaces }));
            } catch (error) {
                this.workspaceNotice = 'Automatic saving is unavailable in this browser. Keep this page open to preserve your edits.';
            }
        },

        /** Reconcile saved edits with live sessions; stale saves never recreate deleted sources. */
        async loadWorkspaces() {
            this._workspacesLoaded = false;
            try {
                const response = await fetch('/api/queue');
                if (!response.ok) throw new Error('Queue unavailable');
                const data = await response.json();
                this.uploadedFiles = (data.uploaded || []).map(file => ({ ...file, musicStart: null, musicDuration: null }));
                this.albumWarnings = [...new Set(this.uploadedFiles.flatMap(file => file.album_warnings || []))];
                let saved = null;
                try { saved = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || 'null'); }
                catch (error) { /* A corrupt save must not block the server queue. */ }
                const liveIds = new Set(this.uploadedFiles.map(file => file.id));
                const entries = saved?.version === WORKSPACE_VERSION && saved.workspaces
                    ? Object.entries(saved.workspaces) : [];
                this.workspaces = Object.fromEntries(entries
                    .map(([id, state]) => [id, this.upgradeWorkspaceState(state)])
                    .filter(([id, state]) => liveIds.has(id) && this.validWorkspace(state)));
                for (const file of this.uploadedFiles) {
                    const state = this.workspaces[file.id];
                    if (state) {
                        file.completedExportSignature = state.completedExportSignature;
                        file.pendingExportSignature = state.pendingExportSignature;
                        file.pendingExportAccepted = state.pendingExportAccepted !== false;
                        file.pendingAlbumJobId = state.pendingAlbumJobId;
                        file.pendingAlbumContext = state.pendingAlbumContext;
                        file.completedAlbumContext = state.completedAlbumContext;
                        if (state.pendingAlbumJobId && state.pendingAlbumJobId === file.album_job_id) {
                            // The server's matching UUID confirms acceptance even when its POST response was lost.
                            state.pendingExportAccepted = file.pendingExportAccepted = true;
                        }
                        // Export may have finished while the browser was refreshing/disconnected.
                        if (file.status === 'completed' && file.pendingExportSignature && state.pendingExportAccepted !== false &&
                            (!state.pendingAlbumJobId || state.pendingAlbumJobId === file.album_job_id)) {
                            state.completedExportSignature = file.completedExportSignature = file.pendingExportSignature;
                            state.pendingExportSignature = null;
                            if (state.pendingAlbumContext) {
                                state.completedAlbumContext = file.completedAlbumContext = state.pendingAlbumContext;
                                state.pendingAlbumContext = null;
                                delete file.pendingAlbumContext;
                            }
                            delete file.pendingExportSignature;
                        } else if (file.status !== 'processing' && state.pendingExportAccepted === false) {
                            // A lost POST response is not evidence that newly edited inputs were exported.
                            state.pendingExportSignature = null;
                            delete file.pendingExportSignature;
                        }
                    }
                }
                this._workspacesLoaded = true;
                this.persistWorkspaces();
            } catch (error) {
                this.workspaceNotice = 'Could not check saved work. Reload when the server is available to recover it.';
            }
        },

        /**
         * Fill the fields a save made before they existed lacks.  `sidesTouched` is derived: sides
         * that differ from the suggestion were picked by the user (a borrow must not re-suggest them).
         */
        upgradeWorkspaceState(state) {
            const upgraded = { ...WORKSPACE_ADDITIONS, ...state };
            if (!('sidesTouched' in (state || {})) && Array.isArray(state?.selectedSides) && Array.isArray(state?.suggestedSides)) {
                upgraded.sidesTouched = state.selectedSides.length !== state.suggestedSides.length
                    || !state.selectedSides.every(side => state.suggestedSides.includes(side));
            }
            return upgraded;
        },

        /** Reject malformed state before assigning it to the Alpine editing model. */
        validWorkspace(state) {
            if (!state || typeof state !== 'object' || !Array.isArray(state.detectedTracks)) return false;
            if (!state.detectedTracks.every(track => track && Number.isFinite(track.start) && Number.isFinite(track.end)
                && track.start >= 0 && track.end > track.start && Number.isInteger(track.number))) return false;
            if (state.selectedRelease !== null && (!state.selectedRelease || !Array.isArray(state.selectedRelease.tracks))) return false;
            return WORKSPACE_FIELDS.every(field => field in state &&
                (Array.isArray(this[field]) ? Array.isArray(state[field]) :
                    this[field] === null || typeof state[field] === typeof this[field]));
        },

        /**
         * Unfinished recordings with work to come back to: a release picked or tracks detected, or an
         * export still running. Untouched ones (e.g. a batch import, or a file opened only for the
         * automatic Discogs search) are left to the Queue, which lists every recording.
         */
        get recoverableFiles() {
            return this.uploadedFiles.filter(file => {
                if (file.id === this.currentFileId || file.status === 'completed') return false;
                const state = this.workspaces[file.id];
                return this.isLocked(file.id) || !!(state && (state.selectedRelease || state.detectedTracks.length));
            });
        },

        /** Resume editing without detection/search/export side effects; rebuild only the waveform. */
        restoreWorkspace(fileId) {
            const state = this.workspaces[fileId];
            if (!state) return false;
            for (const field of WORKSPACE_FIELDS) {
                this[field] = JSON.parse(JSON.stringify(state[field]));
            }
            this.config.bit_depth = state.bitDepth;
            this.config.replaygain = state.replaygain;
            this.loadAlbumDescription();
            this.trackCountMismatch = !!this.selectedRelease && this.activeTrackCount !== this.targetTracks.length;
            this._restoreZoom = this.currentZoom;
            if (this.detectedTracks.length) this.$nextTick(() => this.initWaveform());
            return true;
        },

        /** Exact export inputs; shared by active and background workspaces. */
        exportSignature(state = this.currentWorkspaceState(false)) {
            return JSON.stringify({
                tracks: state.detectedTracks.map(track => [track.number, track.start, track.end, !!track.ignored, track.declick || null]),
                release: state.selectedRelease, mapping: state.customMapping, reversed: state.trackMappingReversed,
                format: state.outputFormat, rumble: state.rumbleFilter, declick: state.declick,
                hum: state.humFilter, frequency: state.humFreq, hiss: state.hissReduction,
                gain: state.albumGain, replaygain: state.replaygain, depth: state.bitDepth,
                prefixPartTitles: state.prefixPartTitles !== false,
                titleSource: state.titleSource || null,
                outputDir: this.config.output_dir,
                albumDescription: this.config.album_description === true
            });
        },

        get processingComplete() {
            return this.currentFile?.status === 'completed' &&
                this.currentFile.completedExportSignature === this.exportSignature();
        },

        /** Validate one source's active ranges and mappings without changing the editor. */
        exportProblem(file, state) {
            if (!state?.selectedRelease?.id || !Array.isArray(state.selectedRelease.tracks)) return 'Choose a release.';
            const active = state.detectedTracks?.filter(track => !track.ignored) || [];
            if (!active.length) return 'Select at least one track.';
            let previousEnd = 0;
            const positions = new Set();
            const trackNumbers = new Set();
            for (const track of active) {
                if (!Number.isInteger(track.number) || track.number < 1 || trackNumbers.has(track.number)) return 'Track numbers must be unique positive integers.';
                trackNumbers.add(track.number);
                if (!Number.isFinite(track.start) || !Number.isFinite(track.end) || track.start < previousEnd ||
                    track.end <= track.start || !(file.duration > 0) || track.end > file.duration) return 'Check the track boundaries.';
                previousEnd = track.end;
                const rawIndex = state.customMapping?.[state.detectedTracks.indexOf(track)];
                const index = typeof rawIndex === 'number' || (typeof rawIndex === 'string' && /^\d+$/.test(rawIndex)) ? Number(rawIndex) : -1;
                const mapped = Number.isInteger(index) && index >= 0 ? state.selectedRelease.tracks[index] : null;
                if (!mapped?.position?.trim()) return 'Map every active track to a release position.';
                if (positions.has(mapped.position)) return `Position ${mapped.position} is mapped more than once.`;
                positions.add(mapped.position);
            }
            return '';
        },

        /** Eligibility before checking another ready recording's claimed output positions. */
        baseReadiness(fileId, shared = true) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            if (!file || this.pendingRemovals[fileId]) return { ready: false, reason: 'Recording removed.' };
            if (file.status === 'queued') return { ready: false, reason: 'Waiting for the current export to finish.' };
            if (['processing', 'uncertain'].includes(file.status)) return { ready: false, reason: file.error || 'Export in progress.' };
            const state = this.workspaceFor(fileId);
            const reason = this.exportProblem(file, state);
            if (reason) return { ready: false, reason };
            if (file.status === 'completed' && file.completedExportSignature === this.exportSignature(state) && (!shared || this.albumContextMatches(fileId))) {
                return { ready: false, completed: true, reason: '' };
            }
            return { ready: true, reason: '' };
        },

        /** Prepared recordings that could contribute to the same album/encoding. */
        albumCohort(fileId) {
            const state = this.workspaceFor(fileId);
            if (!state?.selectedRelease) return [];
            return this.uploadedFiles.filter(file => {
                const other = this.workspaceFor(file.id);
                return !this.pendingRemovals[file.id] && other?.selectedRelease?.id === state.selectedRelease.id &&
                    other.outputFormat === state.outputFormat && !this.exportProblem(file, other);
            });
        },

        /** Any changed/added/re-exported member invalidates the old shared measurement for all. */
        albumContextMatches(fileId) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            const context = file?.completedAlbumContext;
            const cohort = this.albumCohort(fileId);
            const state = this.workspaceFor(fileId);
            const shared = cohort.length > 1 && (state.albumGain || state.replaygain !== false);
            if (!context) return !shared;
            const ids = Object.keys(context.signatures);
            if (cohort.length !== ids.length) return false;
            return cohort.every(member => ids.includes(member.id) &&
                member.completedAlbumContext?.job_id === context.job_id && member.album_job_id === context.job_id &&
                this.exportSignature(this.workspaceFor(member.id)) === context.signatures[member.id]);
        },

        /** Detect duplicate positions before two recordings can overwrite the same release's tracks. */
        fileReadiness(fileId, shared = true) {
            if (shared) {
                const state = this.workspaceFor(fileId);
                const mismatch = this.albumCohort(fileId).find(file => {
                    const other = this.workspaceFor(file.id);
                    return other.albumGain !== state.albumGain || (other.replaygain !== false) !== (state.replaygain !== false);
                });
                if (mismatch) return { ready: false, reason: 'Use matching album gain and ReplayGain choices for recordings of this release and format.' };
            }
            const readiness = this.baseReadiness(fileId, shared);
            if (!readiness.ready) return readiness;
            const state = this.workspaceFor(fileId);
            const request = this.buildExportRequest(fileId, state);
            const positions = new Set(request.track_mapping.map(mapping => mapping.discogs));
            for (const other of this.uploadedFiles) {
                if (other.id === fileId || !this.baseReadiness(other.id, shared).ready) continue;
                const otherState = this.workspaceFor(other.id);
                if (otherState.selectedRelease.id !== state.selectedRelease.id || otherState.outputFormat !== state.outputFormat) continue;
                const collision = this.buildExportRequest(other.id, otherState).track_mapping.find(mapping => positions.has(mapping.discogs));
                if (collision) return { ready: false, reason: `Position ${collision.discogs} is also mapped by ${other.filename}.` };
            }
            return readiness;
        },

        get readyFiles() {
            return this.uploadedFiles.filter(file => this.fileReadiness(file.id).ready);
        },

        /** Locked = exporting, waiting for its export turn, status unknown, or in an unfinished album job. */
        isLocked(fileId) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            if (!file) return false;
            return ['processing', 'queued', 'uncertain'].includes(file.status) ||
                !!(file.album_job_status && file.album_job_status !== 'complete');
        },

        /** The recording in the editor is read-only while it is locked; others stay editable. */
        /** The support note in the "Processing Complete" card: after every export until turned off */
        get showSupportAsk() {
            return !!this.successMessage && !this.config.hide_support_ask;
        },

        /**
         * "Don't show this again" on the support note.  Saved in settings.json, not
         * localStorage: the desktop window starts with empty web storage every launch.
         * Sends only this key, so unsaved edits in the Settings dialog are not saved with it;
         * an open Settings dialog's snapshot gets it too, so Cancel does not bring the note back.
         */
        async hideSupportAsk() {
            this.config.hide_support_ask = true;
            if (this.settingsSnapshot) this.settingsSnapshot.hide_support_ask = true;
            try {
                await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ hide_support_ask: true })
                });
            } catch (error) {
                console.error('Failed to save support note choice:', error);
            }
        },

        get currentLocked() {
            return !!this.currentFileId && this.isLocked(this.currentFileId);
        },

        /** Genuinely global: an export is in flight (single, batch, album, or recovered from the server). */
        get exportRunning() {
            return this.batchProcessing || this.isProcessing || this.uploadedFiles.some(file => ['processing', 'uncertain'].includes(file.status));
        },

        /** Running or waiting: Process all ready and the dispatcher use this, editing gates do not. */
        get exportBusy() {
            return this.exportRunning || this.exportQueue.length > 0;
        },

        get hasUncertainExport() {
            return this.uploadedFiles.some(file => file.status === 'uncertain');
        },

        /** Single-export button state follows the viewed recording, not the global flag. */
        get currentExporting() {
            return this.currentFile?.status === 'processing';
        },

        get processDisabled() {
            return !this.currentFileId || this.analyzing || this.currentLocked || this.hasUncertainExport ||
                !this.fileReadiness(this.currentFileId, false).ready;
        },

        get processButtonLabel() {
            const status = this.currentFile?.status;
            if (this.processingComplete) return '✓ Complete';
            if (status === 'queued') return 'Queued';
            if (status === 'uncertain') return 'Status unknown';
            if (!this.currentLocked && this.exportBusy) return 'Queue export';
            return '✓ Process & Save';
        },

        /** Why the button is disabled or what it will do; empty when nothing needs saying. */
        get processHint() {
            const file = this.currentFile;
            if (!file) return '';
            if (file.status === 'queued') return 'Waiting for the current export to finish. It starts automatically.';
            if (file.status === 'uncertain') return file.error || 'Export status unknown. Reload to check the server before continuing.';
            if (file.status === 'processing') return '';
            if (this.analyzing) return 'Track detection is running.';
            if (this.hasUncertainExport) return "An earlier export's status is unknown. Reload to check the server before exporting.";
            const readiness = this.fileReadiness(file.id, false);
            if (!readiness.ready) return readiness.completed ? '' : readiness.reason;
            if (this.exportBusy) return 'Another export is running. This one starts right after it finishes.';
            return '';
        },

        /** Visible reason Process all ready is disabled ('' = enabled). */
        get processAllReason() {
            if (this.batchProcessing) return '';
            if (this.exportBusy) return 'Available when the current and queued exports have finished.';
            if (this.analyzing) return 'Available when track detection has finished.';
            return '';
        },

        queueLabel(file) {
            if (file.status === 'processing') return 'Processing';
            if (file.status === 'queued') return 'Queued';
            if (file.status === 'uncertain') return 'Status unknown';
            const readiness = this.fileReadiness(file.id);
            if (readiness.completed) return 'Complete';
            return readiness.ready ? (file.error ? 'Ready to retry' : 'Ready') : 'Needs attention';
        },

        queueReason(file) {
            return file.error || this.fileReadiness(file.id).reason;
        },

        /** One payload builder for single and batch export; ignored tracks never consume mappings. */
        buildExportRequest(fileId, state = this.workspaceFor(fileId)) {
            const active = state.detectedTracks.filter(track => !track.ignored);
            return {
                file_id: fileId, release_id: state.selectedRelease.id,
                track_mapping: active.map(track => ({ detected: track.number,
                    discogs: state.selectedRelease.tracks[Number(state.customMapping[state.detectedTracks.indexOf(track)])].position })),
                reversed: state.trackMappingReversed,
                track_boundaries: active.map(track => ({ number: track.number, start: track.start, end: track.end,
                    duration: track.end - track.start, declick: track.declick || undefined })),
                output_format: state.outputFormat, rumble_filter: state.rumbleFilter, declick: state.declick,
                hum_filter: state.humFilter, hum_freq: state.humFreq, hiss_reduction: state.hissReduction,
                album_gain: state.albumGain, replaygain: state.replaygain !== false, bit_depth: state.bitDepth,
                album_description: this.config.album_description === true,
                custom_tracks: this.customTracksPayload(state.selectedRelease),
                prefix_part_titles: state.prefixPartTitles !== false,
                // Contract: only these four keys (label/work are display-only workspace fields).
                ...(state.titleSource ? { title_source: {
                    release_id: state.titleSource.release_id, replace_position: state.titleSource.replace_position,
                    donor_position: state.titleSource.donor_position, assignments: state.titleSource.assignments } } : {})
            };
        },

        /** Update the matching queue entry, regardless of which recording is in the editor. */
        exportProgress(fileId, progress, message) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            if (!file) return;
            file.progress = Math.max(file.progress || 0, Math.max(0, Math.min(1, progress || 0)));
            file.processingMessage = message || 'Processing…';
            if (fileId === this.currentFileId) {
                this.processingProgress = file.progress;
                this.processingMessage = file.processingMessage;
            }
            this.lastProgressAt = Date.now();
        },

        /** A terminal event settles only the active file, and only once. */
        settleExport(fileId, result) {
            if (this._activeExportFileId === fileId) {
                this.stopProcessPolling();
                this._activeExportFileId = null;
                this.isProcessing = false;
            }
            if (this._batchFileId === fileId && this._batchResolve) {
                const resolve = this._batchResolve;
                this._batchResolve = null;
                resolve(result);
            }
            this.scheduleExportDrain();
        },

        /** Start the next frozen queued export once nothing else is running (one POST in flight at a time). */
        scheduleExportDrain() {
            if (this.exportQueue.length) Promise.resolve().then(() => this.drainExportQueue());
        },

        drainExportQueue() {
            if (!this.exportQueue.length) return;
            if (this.hasUncertainExport) { this.haltExportQueue(); return; }
            if (this.exportRunning) return;
            const item = this.exportQueue.shift();
            const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
            if (!file || file.status !== 'queued') { this.drainExportQueue(); return; }
            this.submitExport(item.fileId, item.request, item.signature);
        },

        /** An export of unknown outcome may still be running: start nothing else, hand the rest back. */
        haltExportQueue() {
            const waiting = this.exportQueue.splice(0);
            for (const item of waiting) {
                const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
                if (file?.status === 'queued') {
                    file.status = item.previousStatus;
                    file.error = "Not started: an earlier export's status is unknown.";
                }
            }
            if (waiting.length) this.notify(`${waiting.length} queued export${waiting.length > 1 ? 's were' : ' was'} not started because an earlier export's status is unknown.`, { type: 'warning' });
        },

        /** Record completion for the exported snapshot, not edits made while a batch was running. */
        completeExport(fileId, tracks = []) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            if (!file) return;
            file.status = 'completed'; file.progress = 1; file.processingMessage = 'Complete!';
            file.error = '';
            file.successMessage = tracks.length ? `✅ ${tracks.length} tracks saved.\n\nTracks: ${tracks.join(', ')}` : '✅ Processing complete. Files saved.';
            file.completedExportSignature = file.pendingExportSignature || file.completedExportSignature;
            delete file.pendingExportSignature;
            delete file.pendingExportAccepted;
            delete file.pendingAlbumJobId;
            delete file.pendingAlbumContext;
            const state = this.workspaces[fileId];
            if (state) {
                state.completedExportSignature = file.completedExportSignature;
                state.pendingExportSignature = null;
                state.pendingAlbumJobId = null;
                state.pendingAlbumContext = null;
                state.completedAlbumContext = file.completedAlbumContext || null;
            }
            if (fileId === this.currentFileId) {
                this.processingProgress = 1;
                this.processingMessage = 'Complete!';
                this.successMessage = file.successMessage;
                this.saveWorkspace();
            } else this.persistWorkspaces();
            this.settleExport(fileId, { status: 'complete' });
            this.loadImportList();
        },

        /** A confirmed failure leaves the recording and error available for an explicit retry. */
        failExport(fileId, message) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            if (!file) return;
            file.status = 'error'; file.error = message; file.processingMessage = message;
            delete file.pendingExportSignature;
            delete file.pendingExportAccepted;
            if (this.workspaces[fileId]) this.workspaces[fileId].pendingExportSignature = null;
            if (fileId === this.currentFileId) this.processingMessage = `Error: ${message}`;
            if (!this.batchProcessing) this.notify(`Processing error: ${message}`, { type: 'error' });
            this.persistWorkspaces();
            this.settleExport(fileId, { status: 'error', error: message });
        },

        /**
         * Load available output formats from API
         */
        async loadFormats() {
            try {
                const response = await fetch('/api/formats');
                const data = await response.json();
                this.availableFormats = data.formats;
            } catch (error) {
                console.error('Failed to load formats:', error);
                this.availableFormats = [
                    { id: 'flac', label: 'FLAC (Lossless)', extension: '.flac' },
                    { id: 'mp3', label: 'MP3 (320kbps)', extension: '.mp3' },
                    { id: 'aiff', label: 'AIFF (Lossless)', extension: '.aiff' },
                ];
            }
        },

        /**
         * Connect to WebSocket for real-time updates
         */
        connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws`;

            // Clear any previous ping timer — reconnects must not stack
            // one leaked interval per attempt.
            if (this.wsPingTimer) {
                clearInterval(this.wsPingTimer);
                this.wsPingTimer = null;
            }

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
            };

            this.ws.onmessage = (event) => {
                if (event.data === 'pong') return;

                try {
                    const data = JSON.parse(event.data);
                    this.handleWebSocketMessage(data);
                } catch (error) {
                    console.warn('Non-JSON WebSocket message:', event.data);
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected, reconnecting...');
                setTimeout(() => this.connectWebSocket(), 3000);
            };

            this.wsPingTimer = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send('ping');
                }
            }, 30000);
        },

        /**
         * Handle WebSocket messages
         */
        handleWebSocketMessage(data) {
            console.log('WebSocket message:', data);

            switch (data.type) {
                case 'donor_progress':
                    if (this.donors.status === 'searching' && Number(data.release_id) === Number(this.donors.releaseId)) {
                        this.donors.checked = data.checked;
                        if (data.budget > 0) this.donors.budget = data.budget;
                    }
                    break;

                case 'progress':
                    if (data.file_id === this._activeExportFileId) this.exportProgress(data.file_id, data.progress, data.message);
                    break;

                case 'scan_complete':
                    this.applyScan(data.file_id, data);
                    this.fetchHum(data.file_id);   // envelope ready: look for hum in the silent stretches
                    break;

                case 'click_scan_progress':
                case 'click_scan_complete':
                    this.onClickScanMessage(data);
                    break;

                case 'step_complete':
                    if (data.file_id === this.currentFileId) {
                        console.log(data.message);
                    }
                    break;

                case 'complete':
                    this.completeExport(data.file_id, data.tracks || []);
                    break;

                case 'error':
                    if (data.file_id === this._activeExportFileId && data.recoverable !== true) {
                        this.failExport(data.file_id, data.message);
                    } else if (data.file_id === this.currentFileId) {
                        this.notify(data.message, { type: 'error' });
                    }
                    break;
            }
        },

        /**
         * Load configuration from API
         */
        async loadConfig() {
            try {
                const response = await fetch('/api/config');
                const data = await response.json();
                this.config = data;
                // Remembered export defaults
                this.outputFormat = data.output_format || 'flac';
                this.rumbleFilter = !!data.rumble_filter;
                this.declick = this.normDeclick(data.declick);
                this.albumGain = !!data.album_gain;
                this.syncCleanupFromConfig(data);
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        },

        /**
         * Check app configuration status
         */
        async checkStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                this.discogsConfigured = data.discogs_configured;

                // Show setup modal if not configured
                if (!this.discogsConfigured) {
                    this.setupRequired = true;
                }
            } catch (error) {
                console.error('Failed to check status:', error);
            }
        },

        /**
         * Submit setup with Discogs token
         */
        async submitSetup() {
            this.setupLoading = true;
            this.setupError = null;

            try {
                const response = await fetch('/api/setup/discogs-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: this.setupToken,
                        user_agent: this.setupUserAgent
                    })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.detail || 'Setup failed');
                }

                // Success!
                this.discogsConfigured = true;
                this.setupRequired = false;
                this.setupToken = '';

                this.notify(`Connected to Discogs as ${data.username}.`, { type: 'success' });

            } catch (error) {
                this.setupError = error.message;
            } finally {
                this.setupLoading = false;
            }
        },

        /** Open the Settings modal; its fields edit `config` in place, so remember what was saved. */
        openSettings() {
            this.settingsSnapshot = { ...this.config };
            this.showSettings = true;
        },

        /**
         * Close Settings without saving (Cancel, Escape, click-away). The modal edits `config`
         * directly and exports read it (e.g. album_description), so an unsaved tick must not
         * outlive the modal: put the saved copy back. Called from window-level handlers too,
         * hence the guard when it is already closed.
         */
        closeSettings() {
            if (!this.showSettings) return;
            if (this.settingsSnapshot) this.config = this.settingsSnapshot;
            this.settingsSnapshot = null;
            this.showSettings = false;
        },

        /**
         * Save configuration to API
         */
        async saveConfig() {
            // Allowed during exports: running jobs captured their spec when accepted. A frozen
            // queued export keeps its request too, but the server reads the output dir when it dispatches.
            try {
                const response = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.configPayload())
                });
                const data = await response.json();
                if (this.currentLocked) {
                    // The exporting recording in the editor keeps its own values.
                    this.config = { ...data, bit_depth: this.config.bit_depth, replaygain: this.config.replaygain };
                } else {
                    this.config = data;
                    this.outputFormat = data.output_format || 'flac';
                    this.rumbleFilter = !!data.rumble_filter;
                    this.declick = this.normDeclick(data.declick);
                    this.albumGain = !!data.album_gain;
                    this.syncCleanupFromConfig(data);
                }
                this.settingsSnapshot = null;   // saved: nothing to roll back
                this.showSettings = false;
                this.loadAlbumDescription();   // the setting may have just been switched on or off
                this.notify('Settings saved.', { type: 'success' });
            } catch (error) {
                console.error('Failed to save config:', error);
                this.notify('Failed to save settings.', { type: 'error' });
            }
        },

        /**
         * Change the output format and remember it as the default
         */
        setOutputFormat(format) {
            this.outputFormat = format;
            this.saveExportDefault({ output_format: format });
        },

        /** Unknown / missing declick strengths read as 'off' */
        normDeclick(value) {
            return this.declickLevels.some(l => l.id === value) ? value : 'off';
        },

        /**
         * Settings payload: the config minus the derived legacy restoration_level.
         * While hiss reduction is on the remembered strength is whatever is selected, so the
         * (possibly stale) hiss_strength is left out.
         */
        configPayload() {
            // hide_support_ask is saved only by hideSupportAsk(): a Settings save from a config that
            // failed to load (defaults) must not bring the support note back
            const { restoration_level, hide_support_ask, ...rest } = this.config;
            if (rest.hiss_reduction && rest.hiss_reduction !== 'off') delete rest.hiss_strength;
            return rest;
        },

        // ---- Hum removal + hiss reduction (Plan 07 slice 4) ----------------

        normHumFreq(value) { return Number(value) === 50 ? 50 : 60; },

        /** "60, 120 \u2026 360 Hz" for the caution note under the Hum removal toggle */
        humNoteFreqs(freq) {
            const f = this.normHumFreq(freq);
            return `${f}, ${2 * f} \u2026 ${6 * f} Hz`;
        },

        /** Unknown / missing hiss settings read as 'off' */
        normHiss(value) { return this.hissLevels.some(l => l.id === value) ? value : 'off'; },

        normHissStrength(value) { return this.hissLevels.some(l => l.id === value) ? value : 'light'; },

        /** Mirror the server's hum / hiss defaults into the panel state */
        syncCleanupFromConfig(data) {
            this.humFilter = !!data.hum_filter;
            this.humFreq = this.normHumFreq(data.hum_freq);
            this.hissReduction = this.normHiss(data.hiss_reduction);
            this.hissStrength = this.hissReduction !== 'off'
                ? this.hissReduction : this.normHissStrength(data.hiss_strength);
        },

        /** Toggle hum removal and remember it as the default */
        toggleHum() {
            this.humFilter = !this.humFilter;
            this.abClear();
            this.saveExportDefault({ hum_filter: this.humFilter });
        },

        /** Choose the mains frequency (50 / 60 Hz) and remember it as the default */
        setHumFreq(freq) {
            freq = this.normHumFreq(freq);
            if (freq === this.humFreq) return;
            this.humFreq = freq;
            this.abClear();
            this.saveExportDefault({ hum_freq: freq });
        },

        hissOn() { return this.hissReduction !== 'off'; },

        /** Hiss toggle: off <-> the last chosen strength */
        toggleHiss() {
            this.hissReduction = this.hissOn() ? 'off' : this.hissStrength;
            this.abClear();
            this.saveExportDefault({ hiss_reduction: this.hissReduction });
        },

        /** Choose the hiss strength; while the feature is off it is only remembered */
        setHissStrength(level) {
            level = this.normHissStrength(level);
            if (level === this.hissStrength && (!this.hissOn() || this.hissReduction === level)) return;
            this.hissStrength = level;
            this.abClear();
            if (this.hissOn()) {
                this.hissReduction = level;
                this.saveExportDefault({ hiss_reduction: level });
            } else {
                this.saveExportDefault({ hiss_strength: level });
            }
        },

        /** Hum detection for a file (analyses only its silent stretches); retried after an error */
        async fetchHum(fileId) {
            const known = this.humInfo[fileId];
            if (known && known.status !== 'error') return;
            this.humInfo = { ...this.humInfo, [fileId]: { status: 'loading' } };
            try {
                const res = await fetch(`/api/hum/${fileId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) || {};
                this.humInfo = { ...this.humInfo, [fileId]: {
                    status: 'done', detected: data.detected || null, level_dbfs: data.level_dbfs,
                    prominence_db: data.prominence_db, harmonics: data.harmonics || [] } };
            } catch (error) {
                console.warn('Hum detection unavailable:', error);
                this.humInfo = { ...this.humInfo, [fileId]: { status: 'error' } };
            }
        },

        /**
         * The muted hint under the hum control: offers to turn hum removal on at the detected
         * frequency, or (already on, wrong frequency) to switch.  null when there is nothing to say.
         */
        humSuggestion() {
            const info = this.humInfo[this.currentFileId];
            if (!info || info.status !== 'done' || !info.detected) return null;
            const freq = info.detected;
            if (!this.humFilter) {
                const level = Number.isFinite(info.level_dbfs) ? ` (\u2212${Math.abs(Math.round(info.level_dbfs))} dBFS)` : '';
                return { kind: 'on', freq, text: `Hum detected at ${freq} Hz${level}`, action: 'Turn on' };
            }
            if (this.humFreq !== freq) {
                return { kind: 'switch', freq, text: `Hum detected at ${freq} Hz, not ${this.humFreq} Hz`,
                         action: `Switch to ${freq} Hz` };
            }
            return null;
        },

        /** Apply the suggestion: hum removal on, at the detected frequency */
        applyHumSuggestion() {
            const s = this.humSuggestion();
            if (!s) return;
            this.humFilter = true;
            this.humFreq = s.freq;
            this.abClear();
            this.saveExportDefault({ hum_filter: true, hum_freq: s.freq });
        },

        /**
         * Toggle the rumble filter and remember it as the default
         */
        toggleRumble() {
            this.rumbleFilter = !this.rumbleFilter;
            this.abClear();
            this.saveExportDefault({ rumble_filter: this.rumbleFilter });
        },

        /**
         * Set the click & pop removal strength and remember it as the default
         */
        setDeclick(level) {
            level = this.normDeclick(level);
            if (level === this.declick) return;
            this.declick = level;
            this.abClear();
            this.saveExportDefault({ declick: level });
            // A scan on screen follows the panel strength ("off" scans at medium).
            const scan = this.clickScans[this.currentFileId];
            if (scan && scan.strength !== this.clickScanStrength()) this.scanClicks();
        },

        /**
         * Toggle ReplayGain tags and remember it as the default
         */
        toggleReplayGain() {
            const next = this.config.replaygain === false;
            this.config.replaygain = next;
            this.saveExportDefault({ replaygain: next });
        },

        /**
         * Toggle album gain and remember it as the default
         */
        toggleAlbumGain() {
            this.albumGain = !this.albumGain;
            this.abClear();
            this.saveExportDefault({ album_gain: this.albumGain });
        },

        /**
         * Persist a single export default via PUT /api/config
         */
        async saveExportDefault(update) {
            try {
                const response = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(update)
                });
                if (response.ok) {
                    const data = await response.json();
                    this.config.output_format = data.output_format;
                    this.config.rumble_filter = data.rumble_filter;
                    this.config.declick = data.declick;
                    this.config.hum_filter = data.hum_filter;
                    this.config.hum_freq = data.hum_freq;
                    this.config.hiss_reduction = data.hiss_reduction;
                    this.config.hiss_strength = data.hiss_strength;
                    this.config.album_gain = data.album_gain;
                    this.config.replaygain = data.replaygain;
                }
            } catch (error) {
                console.error('Failed to save export default:', error);
            }
        },

        /**
         * Open desktop folder picker for output directory
         */
        async chooseOutputFolder() {
            try {
                if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.select_output_folder) {
                    this.notify('The folder picker is available in the desktop app only.', { type: 'info' });
                    return;
                }

                const selected = await window.pywebview.api.select_output_folder(this.config.output_dir || '');
                if (selected) {
                    this.config.output_dir = selected;
                }
            } catch (error) {
                console.error('Failed to choose output folder:', error);
                this.notify('Failed to open the folder picker.', { type: 'error' });
            }
        },

        /**
         * Check if a file has a supported extension
         */
        isSupportedFile(filename) {
            const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
            return this.supportedExtensions.includes(ext);
        },

        // ---------------------------------------------------------------
        // Import from folder
        // ---------------------------------------------------------------

        /** True when the desktop shell offers a native file dialog */
        detectDesktopPicker() {
            this.desktopPicker = typeof window !== 'undefined'
                && typeof window.pywebview?.api?.choose_import_files === 'function';
            return this.desktopPicker;
        },

        /** The folder tab shows when an import dir is configured or the desktop dialog exists */
        get showFolderTab() {
            return this.importInfo.enabled || this.desktopPicker;
        },

        /** Every stable source can be selected again, even after a previous import or export. */
        get importableFiles() {
            return (this.importInfo.files || []).filter(f => f.stable !== false);
        },

        /** Reload the folder listing; failures leave the previous list in place */
        async loadImportList() {
            this.importLoading = true;
            try {
                const response = await fetch('/api/import');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                this.importInfo = {
                    enabled: !!data.enabled,
                    dir: data.dir || '',
                    error: data.error || null,
                    files: data.files || []
                };
                // Drop ticks for rows that vanished or became unselectable
                const ok = new Set(this.importableFiles.map(f => f.name));
                this.importSelected = this.importSelected.filter(n => ok.has(n));
            } catch (error) {
                console.error('Failed to list import folder:', error);
            } finally {
                this.importLoading = false;
            }
        },

        isImportSelected(name) {
            return this.importSelected.includes(name);
        },

        toggleImportSelected(name) {
            this.importSelected = this.isImportSelected(name)
                ? this.importSelected.filter(n => n !== name)
                : [...this.importSelected, name];
        },

        get allImportSelected() {
            const n = this.importableFiles.length;
            return n > 0 && this.importableFiles.every(f => this.importSelected.includes(f.name));
        },

        toggleImportAll() {
            this.importSelected = this.allImportSelected ? [] : this.importableFiles.map(f => f.name);
        },

        /** A queue entry is not proof of a completed export. */
        importFileLabel(file) {
            if (file.stable === false) return 'Still copying…';
            const entry = this.uploadedFiles.find(item => item.id === file.imported_id);
            const status = entry?.status || file.imported_status;
            if (status === 'processing') return 'Processing…';
            if (status === 'completed' || entry?.completedExportSignature || file.imported_status === 'completed') return 'Complete';
            return file.imported_id ? 'In queue' : '';
        },

        /** Row and checkbox use the same selection behavior; existing sessions are reused. */
        onImportRowClick(file) {
            if (file.stable !== false) this.toggleImportSelected(file.name);
        },

        /** Folder tab only when it has recordings: an empty one would hide the drop zone from a new user */
        chooseDefaultImportTab() {
            this.importTab = this.importInfo.files.length > 0 ? 'folder' : 'upload';
        },

        /** Import the ticked folder files */
        async importSelectedFiles() {
            if (!this.importSelected.length) return;
            await this.postImport({ names: [...this.importSelected] });
            this.importSelected = [];
        },

        /** Desktop: native multi-select dialog, then import the chosen paths */
        async chooseImportFiles() {
            if (this.importBusy || !this.detectDesktopPicker()) return;
            let paths;
            try {
                paths = await window.pywebview.api.choose_import_files();
            } catch (error) {
                this.notifyError('Could not open the file dialog', error);
                return;
            }
            if (!paths || !paths.length) return;
            await this.postImport({ paths });
        },

        /** POST /api/import and queue the returned files like an upload */
        async postImport(body) {
            this.importBusy = true;
            try {
                await this.commitAllRemovals();
                const lockedIds = this.uploadedFiles.filter(file => this.isLocked(file.id)).map(file => file.id);
                const response = await fetch('/api/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(lockedIds.length ? { ...body, locked_ids: lockedIds } : body)
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();

                const known = new Set(this.uploadedFiles.map(f => f.id));
                const added = [];
                let replacedCurrentBy = null;
                (data.files || []).forEach(file => {
                    if (file.replaces) {
                        if (file.replaces === this.currentFileId) replacedCurrentBy = file.id;
                        this.dropReplacedFile(file);
                    }
                    if (known.has(file.id)) {
                        const existing = this.uploadedFiles.find(entry => entry.id === file.id);
                        if (file.status) existing.status = file.status;
                        return;
                    }
                    known.add(file.id);
                    const entry = {
                        ...file,
                        status: file.status || 'uploaded',
                        musicStart: null,
                        musicDuration: null  // Filled by the background scan (scan_complete / /api/scan)
                    };
                    this.uploadedFiles.push(entry);
                    added.push(entry);
                });
                if (replacedCurrentBy) {
                    this.selectFile(replacedCurrentBy);
                } else if (!this.currentFile && data.files?.length > 0) {
                    this.selectFile((added[0] || data.files[0]).id);
                } else if (data.files?.length === 1 && known.has(data.files[0].id) && !added.length) {
                    this.selectFile(data.files[0].id);
                }
                this.saveWorkspace();

                const skipped = data.skipped || [];
                if (skipped.length) {
                    const shown = skipped.slice(0, 3).map(s => `${s.name} — ${s.reason}`);
                    if (skipped.length > 3) shown.push(`and ${skipped.length - 3} more`);
                    this.notify(`${skipped.length} file(s) not imported: ${shown.join('; ')}`, { type: 'warning' });
                }
            } catch (error) {
                this.notifyError('Import failed', error);
            } finally {
                this.importBusy = false;
            }
            await this.loadImportList();
        },

        /**
         * The file changed on disk, so the server dropped its session and started over.  Closes
         * it first: selectFile saves the open workspace, which would bring the old work back,
         * and it refuses during detection, which would leave the dropped session on screen.
         */
        dropReplacedFile(file) {
            if (file.replaces === this.currentFileId) this.closeCurrentFile();
            this.uploadedFiles = this.uploadedFiles.filter(entry => entry.id !== file.replaces);
            delete this.workspaces[file.replaces];
            this.notify(`"${this.shortFilename(file.filename)}" changed on disk, so it was imported again. Earlier splits for it are gone.`, { type: 'warning' });
        },

        /**
         * Handle file drop
         */
        async handleDrop(event) {
            this.dragging = false;
            const dropped = Array.from(event.dataTransfer.files);
            const files = dropped.filter(f => this.isSupportedFile(f.name));

            const skipped = dropped.length - files.length;
            if (skipped > 0) {
                this.showUploadNotice(`${skipped} file(s) skipped — only WAV and AIFF are supported`);
            }

            await this.uploadFiles(files);
        },

        /**
         * Show a transient notice under the upload zone (replaces any
         * previous one so an old timer can't clear a newer message early)
         */
        showUploadNotice(message) {
            this.uploadNotice = message;
            if (this._uploadNoticeTimer) clearTimeout(this._uploadNoticeTimer);
            this._uploadNoticeTimer = setTimeout(() => { this.uploadNotice = ''; }, 6000);
        },

        /**
         * Handle file selection from input
         */
        async handleFileSelect(event) {
            const files = Array.from(event.target.files);
            await this.uploadFiles(files);
            event.target.value = '';
        },

        /**
         * Upload files to server with progress tracking
         */
        async uploadFiles(files) {
            if (files.length === 0) return;

            const formData = new FormData();
            files.forEach(file => formData.append('files', file));

            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();

                // Track upload progress. When the last byte is sent the
                // server still has to write the file and probe its duration,
                // so switch to a "finalizing" state instead of hiding the bar.
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        this.uploadProgress = (e.loaded / e.total) * 100;
                        if (e.loaded >= e.total) {
                            this.uploadFinalizing = true;
                        }
                    }
                });

                // Handle completion
                xhr.addEventListener('load', () => {
                    this.uploadProgress = 100;
                    this.uploadFinalizing = false;

                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const data = JSON.parse(xhr.responseText);

                            data.files.forEach(file => {
                                this.uploadedFiles.push({
                                    ...file,
                                    status: 'uploaded',
                                    musicStart: null,
                                    musicDuration: null  // Filled by the background scan (scan_complete / /api/scan)
                                });
                            });

                            if (data.files.length === 0) {
                                this.showUploadNotice('No files were uploaded — only WAV and AIFF are supported');
                            }

                            if (!this.currentFile && data.files.length > 0) {
                                this.selectFile(data.files[0].id);
                            }

                            // Reset progress after a short delay — the queue
                            // panel is the success feedback, no alert needed.
                            setTimeout(() => {
                                this.uploadProgress = 0;
                            }, 1000);

                            resolve(data);
                        } catch (error) {
                            console.error('Upload failed:', error);
                            this.notify('Upload failed: invalid response from the server.', { type: 'error' });
                            this.uploadProgress = 0;
                            reject(error);
                        }
                    } else {
                        console.error('Upload failed:', xhr.statusText);
                        this.notify('Upload failed' + (xhr.statusText ? ': ' + xhr.statusText : '.'), { type: 'error' });
                        this.uploadProgress = 0;
                        reject(new Error(xhr.statusText));
                    }
                });

                // Handle errors
                xhr.addEventListener('error', () => {
                    console.error('Upload failed');
                    this.notify('Upload failed: could not reach the server.', { type: 'error' });
                    this.uploadProgress = 0;
                    this.uploadFinalizing = false;
                    reject(new Error('Upload failed'));
                });

                // Send the request
                xhr.open('POST', '/api/upload');
                xhr.send(formData);
            });
        },

        /**
         * Select a file from the queue
         */
        selectFile(fileId) {
            if (fileId === this.currentFileId || !this.uploadedFiles.some(file => file.id === fileId)) return;
            // Exports never block switching; only this recording's own detection does.
            if (this.analyzing) {
                this.notify('Wait for track detection to finish before switching recordings.', { type: 'warning', timeout: 5000 });
                return;
            }
            this.saveWorkspace();
            this.abReset();
            this.releaseIdLoading = false;   // a lookup for the previous recording is dropped on arrival
            // Before the id changes: a waveform (or fallback player) of the old recording must never
            // be seen under the new id
            this.destroyWaveform();
            this.currentFileId = fileId;
            this.currentFile = this.uploadedFiles.find(f => f.id === fileId);
            if (this.currentFile && !(this.currentFile.musicDuration > 0)) {
                this.fetchScan(fileId);
            } else if (this.currentFile) {
                this.fetchHum(fileId);
            }
            this.loadCachedClicks(fileId);
            this.detectedTracks = [];
            this.resetEditState();
            this.resetSearchResults();
            this.detailsSettled = false;
            this.selectedRelease = null;
            this._pendingPickId = null;
            this.titleSource = null;
            this.closeMovementsPanel();
            this.trackForm = null;
            this.resetDonors();
            this.selectedSides = [];
            this.suggestedSides = [];
            this.sidesMatchedByDuration = false;
            this.sidesSuggestionReason = '';
            this.sidesTouched = false;
            this.customMapping = [];
            this.trackCountMismatch = false;
            this.releaseIdNotice = '';
            this.releaseIdInput = '';
            this.searchNotice = '';
            this.searchLoading = false;
            this.searchSeq++;
            this.rescanNotice = '';
            this.successMessage = '';
            this.processingProgress = 0;
            this.processingMessage = '';

            const restored = this.restoreWorkspace(fileId);
            const viewed = this.currentFile;
            if (viewed && ['processing', 'queued'].includes(viewed.status)) {
                this.processingProgress = viewed.progress || 0;
                this.processingMessage = viewed.processingMessage || '';
            }
            if (viewed?.status === 'completed' && viewed.successMessage && viewed.completedExportSignature === this.exportSignature()) {
                this.successMessage = viewed.successMessage;
            }
            // Recover an export only when nothing is observed yet (after a reload); a live one keeps its own polling.
            if (!this.isProcessing && !this.batchProcessing && (this.currentFile?.status === 'processing' ||
                (this.currentFile?.album_job_status && this.currentFile.album_job_status !== 'complete'))) {
                this.isProcessing = true;
                this.currentJobId = fileId;
                if (this.currentFile.album_job_id) this.startAlbumPolling(this.currentFile.album_job_id);
                else this.startProcessPolling(fileId);
            }
            if (restored) return;
            if (this.currentFile) {
                this.searchQuery = this.cleanFilename(this.currentFile.filename);

                // Discogs-first: kick off the search right away (not awaited,
                // so the UI never blocks on it).
                if (this.discogsConfigured && this.searchQuery.trim()) {
                    this.searchDiscogs();
                }
            }
        },

        /**
         * Remove a file from the queue.  The entry disappears immediately and
         * an Undo toast is shown; the server-side DELETE only happens once the
         * undo window has passed (or the toast is closed / the page unloads).
         */
        removeFile(fileId, undoMs = 8000) {
            const index = this.uploadedFiles.findIndex(f => f.id === fileId);
            if (index === -1 || this.pendingRemovals[fileId]) return;

            const file = this.uploadedFiles[index];
            if (this.isLocked(fileId) || (fileId === this.currentFileId && this.analyzing)) {
                this.notify(this.isLocked(fileId) ? "A recording can't be removed while it is exporting or waiting to export." : 'Wait for track detection to finish before removing this recording.', { type: 'warning', timeout: 5000 });
                return;
            }
            this.saveWorkspace();
            const entry = {
                file,
                order: this.uploadedFiles.map(f => f.id),   // queue order before this removal, for Undo
                wasCurrent: this.currentFileId === fileId,
                committed: false,
                toastId: null
            };
            this.pendingRemovals = { ...this.pendingRemovals, [fileId]: entry };

            this.uploadedFiles = this.uploadedFiles.filter(f => f.id !== fileId);
            if (entry.wasCurrent) this.closeCurrentFile();

            const removedMsg = file.in_place
                ? `Removed "${this.shortFilename(file.filename)}" from the queue. The original file stays in the import folder.`
                : `Removed "${this.shortFilename(file.filename)}" from the queue.`;
            entry.toastId = this.notifyUndo(removedMsg, () => this.undoRemoveFile(fileId), {
                guard: false,
                timeout: undoMs,
                onClose: (reason) => { if (reason !== 'action') this.commitRemoval(fileId); }
            });
        },

        /** Leave the editor empty: the recording in it is going away */
        closeCurrentFile() {
            this.pauseWaveform();
            this.destroyWaveform();
            this.currentFileId = null;
            this.currentFile = null;
            this.detectedTracks = [];
            this.resetEditState();
            // Replies of its search and release picks still in flight are dropped.
            this.searchSeq++;
            this._pendingPickId = null;
            this.releaseIdLoading = false;
            this.searchLoading = false;
        },

        /** Put a soft-removed file back in its old queue position */
        undoRemoveFile(fileId) {
            const entry = this.pendingRemovals[fileId];
            if (!entry || entry.committed) return;
            const next = { ...this.pendingRemovals };
            delete next[fileId];
            this.pendingRemovals = next;

            this.reinsertFile(entry.file, entry.order);
            if (entry.wasCurrent && !this.currentFileId) {
                this.selectFile(fileId);
            }
        },

        /**
         * Put a removed file back where it was in `order` (the queue's ids before its
         * removal): before the first later file still queued, else after the nearest
         * earlier one, else at the end.  Removals and Undos may interleave in any order.
         */
        reinsertFile(file, order) {
            const files = this.uploadedFiles.filter(f => f.id !== file.id);
            const at = order.indexOf(file.id);
            const position = id => files.findIndex(f => f.id === id);
            let index = -1;
            if (at !== -1) {
                for (const id of order.slice(at + 1)) {
                    index = position(id);
                    if (index !== -1) break;
                }
                for (const id of index === -1 ? order.slice(0, at).reverse() : []) {
                    const before = position(id);
                    if (before !== -1) { index = before + 1; break; }
                }
            }
            files.splice(index === -1 ? files.length : index, 0, file);
            this.uploadedFiles = files;
        },

        /** Really delete a soft-removed file on the server */
        async commitRemoval(fileId, { keepalive = false } = {}) {
            const entry = this.pendingRemovals[fileId];
            if (!entry || entry.committed) return;
            entry.committed = true;
            const workspace = this.workspaces[fileId];
            delete this.workspaces[fileId];
            this.persistWorkspaces();
            if (entry.toastId) this.dismissToast(entry.toastId, 'commit');
            try {
                const response = await fetch(`/api/queue/${fileId}`, { method: 'DELETE', keepalive });
                if (!response.ok && response.status !== 404) {
                    throw new Error(`HTTP ${response.status}`);
                }
                // The "Imported" marker in the folder list clears now
                if (entry.file.in_place) this.loadImportList();
            } catch (error) {
                // Server still has it: bring the file back so the queue
                // reflects reality, and say so.
                console.error('Failed to remove file:', error);
                if (workspace) this.workspaces = { ...this.workspaces, [fileId]: workspace };
                this.persistWorkspaces();
                if (!this.uploadedFiles.some(f => f.id === fileId)) {
                    this.reinsertFile(entry.file, entry.order);
                }
                this.notifyError(`Could not remove "${this.shortFilename(entry.file.filename)}"`, error);
            } finally {
                const next = { ...this.pendingRemovals };
                delete next[fileId];
                this.pendingRemovals = next;
            }
        },

        /** Commit every pending removal now (page unload, process start) */
        commitAllRemovals(opts = {}) {
            return Promise.all(Object.keys(this.pendingRemovals).map(id => this.commitRemoval(id, opts)));
        },

        /** Return to the existing search UI while keeping all current cuts; searches only if it has no results. */
        tryDiscogsAgain() {
            if (this.analyzing || this.currentLocked) return;
            if (!this.discogsConfigured) {
                // Without a token a search (or a release lookup) can only fail: open the setup.
                this.setupRequired = true;
                return;
            }
            if (!this.searchQuery.trim()) this.searchQuery = this.cleanFilename(this.currentFile?.filename || '');
            if (this.searchResults.length === 0) this.searchDiscogs();
            this.$nextTick(() => {
                if (typeof document === 'undefined') return;
                const search = document.getElementById('discogs-search');
                search?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.getElementById('discogs-query')?.focus({ preventScroll: true });
            });
        },

        /**
         * The "no tracks yet" action: with a release selected, retry guided detection for its
         * sides; without one, detect by silence only (Skip Discogs).
         */
        retryOrSkipDetection() {
            return this.selectedRelease ? this.redetectForTargets() : this.analyzeFile();
        },

        /**
         * Analyze file for silence detection
         */
        async analyzeFile() {
            if (!this.currentFileId || this.analyzing || this.currentLocked) return;

            this.analyzing = true;
            this.rescanNotice = '';
            this.processingMessage = 'Analyzing...';

            try {
                const response = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_id: this.currentFileId })
                });
                const data = await response.json();

                if (!response.ok || !data.tracks) {
                    throw new Error(data.detail || 'Analysis failed');
                }

                this.setDetectedTracks(data.tracks);
                this.processingMessage = '';

                const file = this.uploadedFiles.find(f => f.id === this.currentFileId);
                if (file) {
                    file.status = 'analyzed';
                }

                // A release may already be selected (re-analysis after a
                // release was chosen) - keep the mapping aligned with it.
                if (this.selectedRelease) {
                    this.resetMappingToTargets();
                }

                // No tracks, no waveform: initWaveform keeps an existing one, so a retry's tracks
                // would get no regions.
                if (this.detectedTracks.length) await this.initWaveform();
                else this.notify('No tracks were found in this recording. Try another release or adjust the silence settings.', { type: 'warning' });
            } catch (error) {
                console.error('Analysis failed:', error);
                this.notifyError('Analysis failed', error);
                this.processingMessage = '';
            } finally {
                this.analyzing = false;
            }
        },

        /**
         * Re-analyze file with current settings.  Runs immediately; an Undo
         * toast restores the previous boundaries, release and mapping.
         */
        async reanalyzeFile() {
            if (!this.currentFileId || this.analyzing || this.currentLocked) return;

            const fileId = this.currentFileId;
            const snapshot = this.snapshotEdits();
            snapshot.selectedRelease = this.selectedRelease;
            snapshot.selectedSides = [...this.selectedSides];
            snapshot.suggestedSides = [...this.suggestedSides];
            snapshot.sidesTouched = this.sidesTouched;
            snapshot.sidesSuggestionReason = this.sidesSuggestionReason;
            snapshot.sidesMatchedByDuration = this.sidesMatchedByDuration;
            snapshot.status = this.currentFile?.status;

            this.detectedTracks = [];
            this.resetEditState();
            this.selectedRelease = null;
            this._pendingPickId = null;   // a card still loading must not bring a release back
            this.resetDonors();
            this.selectedSides = [];
            this.sidesTouched = false;
            this.trackMappingReversed = false;
            this.customMapping = [];

            this.pauseWaveform();

            this.destroyWaveform();
            await this.analyzeFile();

            if (this.currentFileId === fileId && this.detectedTracks.length === 0 && snapshot.tracks.length > 0) {
                // Found nothing (analyzeFile already said so, or why it failed). Nobody confirmed the reset, so put
                // the previous boundaries and release back; there is nothing to undo.
                await this.restoreReanalyze(fileId, snapshot);
                return;
            }
            if (this.currentFileId === fileId && this.detectedTracks.length > 0) {
                this.notifyUndo('Re-analyzed. Boundaries and release were reset.',
                    () => this.restoreReanalyze(fileId, snapshot), { fileId });
            }
        },

        /** Undo a re-analysis: previous tracks, release, sides and mapping (its toast checks undoBlockedReason) */
        async restoreReanalyze(fileId, snap) {
            this.pauseWaveform();
            this.restoreEdits(snap, { rebuildRegions: false });
            this.selectedRelease = snap.selectedRelease;
            this._pendingPickId = null;   // an Undo cancels a card still loading, even one restoring no release
            // The preview shows the release that was selected when it loaded; a different one needs its own
            if ((this.selectedRelease?.id ?? null) !== this.albumDescription.releaseId) this.loadAlbumDescription();
            this.resetDonors();
            this.selectedSides = snap.selectedSides;
            this.suggestedSides = snap.suggestedSides;
            this.sidesTouched = !!snap.sidesTouched;
            this.sidesSuggestionReason = snap.sidesSuggestionReason ?? this.sidesSuggestionReason;
            this.sidesMatchedByDuration = snap.sidesMatchedByDuration ?? this.sidesMatchedByDuration;
            this.trackCountMismatch = !!this.selectedRelease &&
                this.activeTrackCount !== this.targetTracks.length;
            if (this.currentFile && snap.status) this.currentFile.status = snap.status;

            this.destroyWaveform();
            await this.$nextTick();
            await this.initWaveform();
        },

        /**
         * Deep snapshot of the boundary/mapping state, for undo
         */
        snapshotEdits() {
            return {
                tracks: this.detectedTracks.map(t => ({ ...t })),
                mapping: [...this.customMapping],
                reversed: this.trackMappingReversed,
                expected: [...this.expectedBoundaries],
                edited: this.boundariesEdited
            };
        },

        /**
         * Put a snapshotEdits() result back and rebuild the regions
         */
        restoreEdits(snap, { rebuildRegions = true } = {}) {
            this.boundaryEditCount++;   // an Undo replaces the boundaries outside detection
            this.detectedTracks = snap.tracks.map(t => ({ ...t }));
            this.customMapping = [...snap.mapping];
            this.trackMappingReversed = snap.reversed;
            this.expectedBoundaries = [...snap.expected];
            this.boundariesEdited = snap.edited;
            this.editBanner = false;
            this.snapUndo = null;
            this.snapNotice = '';
            this.trackCountMismatch = !!this.selectedRelease &&
                this.activeTrackCount !== this.targetTracks.length;
            if (rebuildRegions && this.waveformRegions && this.waveform) {
                this.addTrackRegions();
            }
        },

        /**
         * Smart Rescan: ask the backend to sweep detection settings until it
         * finds the expected number of tracks.  Unlike reanalyzeFile(), this
         * keeps the Discogs search/selection intact so it works as a quick
         * retry from the track-count-mismatch warning too.
         */
        async smartRescan(target) {
            target = parseInt(target, 10);
            if (!this.currentFileId || this.analyzing || this.currentLocked) return;
            if (!target || target < 1 || target > MAX_GUIDED_TRACKS) {
                this.rescanNotice = `Enter how many songs the recording contains (1–${MAX_GUIDED_TRACKS}) first.`;
                return;
            }

            this.analyzing = true;
            this.rescanNotice = '';
            this.processingMessage = `Rescanning for ${target} tracks...`;
            this.pauseWaveform();

            try {
                const response = await fetch('/api/rescan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: this.currentFileId,
                        expected_tracks: target
                    })
                });
                const data = await response.json();

                if (!response.ok || !data.tracks) {
                    throw new Error(data.detail || 'Smart rescan failed');
                }

                this.setDetectedTracks(data.tracks);
                this.processingMessage = '';

                const file = this.uploadedFiles.find(f => f.id === this.currentFileId);
                if (file) {
                    file.status = 'analyzed';
                }

                // Boundary edits from the old analysis no longer apply.
                if (this.selectedRelease) {
                    this.resetMappingToTargets();
                }

                this.destroyWaveform();
                // Let Alpine reveal the (initially x-show hidden) waveform
                // container before WaveSurfer measures it.
                await this.$nextTick();
                await this.initWaveform();

                this.rescanNotice = data.matched
                    ? `✅ Found exactly ${data.tracks.length} tracks.`
                    : `⚠️ Couldn't find exactly ${target} tracks — closest result is ${data.tracks.length}. Right-click the waveform to add or remove splits manually.`;
            } catch (error) {
                console.error('Smart rescan failed:', error);
                this.rescanNotice = '❌ Smart rescan failed: ' + error.message;
                this.processingMessage = '';
            } finally {
                this.analyzing = false;
            }
        },

        /**
         * Search Discogs for releases
         */
        async searchDiscogs() {
            if (this.searchLoading) return;
            if (!this.searchQuery.trim()) {
                this.searchNotice = 'Please enter a search query';
                return;
            }

            this.searchLoading = true;
            this.resetSearchResults();
            this.detailsSettled = false;
            this.searchNotice = '';
            const seq = ++this.searchSeq;
            const query = this.searchQuery;

            try {
                const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, max_results: SEARCH_PAGE_SIZE, page: 1 })
                });
                const data = await response.json();
                if (seq !== this.searchSeq) return;   // a newer search/file superseded this one

                // Surface the server's error (missing token, network down)
                // instead of corrupting searchResults with undefined.
                if (!response.ok || !Array.isArray(data.results)) {
                    throw new Error(data.detail || 'Search failed');
                }

                this.searchResults = data.results.map(newSearchCard);
                this.searchedQuery = query;
                this.searchPage = 1;
                this.searchHasMore = !!data.has_more;

                if (this.searchResults.length === 0) {
                    this.searchNotice = 'No results found. Try a different search query.';
                } else {
                    // Not awaited: cards are already visible.
                    this.loadAllReleaseDetails(seq);
                }
            } catch (error) {
                if (seq !== this.searchSeq) return;
                console.error('Search failed:', error);
                this.resetSearchResults();
                this.searchNotice = 'Search failed: ' + error.message;
            } finally {
                if (seq === this.searchSeq) {
                    this.searchLoading = false;
                }
            }
        },

        /** Forget the shown results and their "Load more" state (not the query box). */
        resetSearchResults() {
            this.searchResults = [];
            this.searchedQuery = '';
            this.searchPage = 0;
            this.searchHasMore = false;
            this.searchMoreLoading = false;
            this.searchMoreError = '';
            this.searchMoreNotice = '';
        },

        /**
         * "Load more": fetch the next page of the same query and append it, with its
         * tracklists loading like the first page's. At most SEARCH_MAX_PAGES fetches.
         */
        async loadMoreResults() {
            if (!this.searchHasMore || this.searchLoading || this.searchMoreLoading || this.searchPage >= SEARCH_MAX_PAGES) return;
            const seq = this.searchSeq;
            const page = this.searchPage + 1;
            this.searchMoreLoading = true;
            this.searchMoreError = '';
            this.searchMoreNotice = '';
            try {
                const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: this.searchedQuery, max_results: SEARCH_PAGE_SIZE, page })
                });
                const data = await response.json();
                if (seq !== this.searchSeq) return;   // a new search/file replaced these results
                if (!response.ok || !Array.isArray(data.results)) {
                    throw new Error(data.detail || 'Search failed');
                }
                // Discogs' order can shift between requests: never show a release twice
                // (cards are keyed by id, and a duplicate key breaks the grid).
                const shown = new Set(this.searchResults.map(r => r.id));
                const added = data.results.filter(r => !shown.has(r.id)).map(newSearchCard);
                this.searchPage = page;
                this.searchHasMore = !!data.has_more && page < SEARCH_MAX_PAGES;
                if (added.length) {
                    this.detailsSettled = false;
                    this.searchResults = [...this.searchResults, ...added];
                    this.loadAllReleaseDetails(seq, added.map(r => r.id));
                } else {
                    this.searchMoreNotice = this.searchHasMore ? 'No new results on this page.' : 'No more results.';
                }
            } catch (error) {
                if (seq !== this.searchSeq) return;
                console.error('Load more failed:', error);
                this.searchMoreError = "Couldn't load more results: " + error.message;
            } finally {
                if (seq === this.searchSeq) this.searchMoreLoading = false;
            }
        },

        /**
         * Fetch full tracklists for results (default: all shown) in display order,
         * two at a time (the server rate-limits Discogs anyway).  Stops as
         * soon as searchSeq moves on (new search or file switch).  Settled only
         * when no result is still pending: "Load more" can run beside the first page's loader.
         */
        async loadAllReleaseDetails(seq, ids = this.searchResults.map(r => r.id), concurrency = 2) {
            let next = 0;
            const worker = async () => {
                while (seq === this.searchSeq && next < ids.length) {
                    await this.loadReleaseDetails(ids[next++], seq);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
            if (seq === this.searchSeq && !this.searchResults.some(r => r.detailStatus === 'pending')) this.detailsSettled = true;
        },

        /**
         * Fetch one release's full details and merge them into its result
         * card.  Shares in-flight requests (click vs. background loader).
         * Resolves true when the tracklist is loaded.
         */
        loadReleaseDetails(id, seq = this.searchSeq) {
            const existing = this.searchResults.find(r => r.id === id);
            if (existing && existing.tracks) return Promise.resolve(true);
            // Keyed by search too: a load left over from the previous search must not be handed
            // to this one (its reply is dropped, so the card would stay pending).
            const key = `${seq}:${id}`;
            if (this._detailInflight[key]) return this._detailInflight[key];

            const promise = (async () => {
                try {
                    const response = await fetch(`/api/release/${id}`);
                    const data = await response.json();
                    if (!response.ok || !Array.isArray(data.tracks)) {
                        throw new Error(data.detail || 'Release fetch failed');
                    }
                    if (seq !== this.searchSeq) return false;
                    const result = this.searchResults.find(r => r.id === id);
                    if (!result) return false;
                    Object.assign(result, { ...data, cover_url: data.cover_url || result.cover_url, detailStatus: 'loaded' });
                    return true;
                } catch (error) {
                    if (seq === this.searchSeq) {
                        const result = this.searchResults.find(r => r.id === id);
                        if (result) result.detailStatus = 'error';
                    }
                    console.error('Release details failed:', error);
                    return false;
                } finally {
                    delete this._detailInflight[key];
                }
            })();
            this._detailInflight[key] = promise;
            return promise;
        },

        /**
         * Card click: make sure the tracklist is loaded, then select.  The latest click
         * wins: a later pick, Change release, a re-analysis (or its Undo) or a file switch
         * while this card loads clears _pendingPickId, and its reply then only fills the card.
         */
        async chooseResult(result) {
            if (result.opening) return;   // a second click on the card already opening is no new pick
            if (this.refusePickWhileBusy()) {
                this._pendingPickId = null;   // refused, but it was the latest click: an older card must not land
                return;
            }
            if (result.tracks) {
                this.selectRelease(result);
                return;
            }
            const seq = this.searchSeq;
            this._pendingPickId = result.id;
            result.opening = true;
            try {
                const ok = await this.loadReleaseDetails(result.id, seq);
                if (ok && seq === this.searchSeq && this._pendingPickId === result.id) {
                    const fresh = this.searchResults.find(r => r.id === result.id);
                    if (fresh) this.selectRelease(fresh);
                }
            } finally {
                if (this._pendingPickId === result.id) this._pendingPickId = null;
                result.opening = false;
            }
        },

        parseDiscogsRelease,
        maxGuidedTracks: MAX_GUIDED_TRACKS,
        normalizeWorkTitle,
        workTitlesMatch: (first, second) => workTitleMatchScore(first, second) > 0,
        slotGroups,
        borrowedPositions,
        defaultMovementSplit,
        ALL_DONOR_TRACKS: MOVEMENTS_ALL_DONOR_TRACKS,

        /** Help for the release-number field: the first few recordings, and whenever a lookup went wrong. */
        get showReleaseIdHelp() {
            return !!this.releaseIdNotice || this.releaseIdHelpSeen.length < RELEASE_ID_HELP_MAX_RECORDINGS ||
                this.releaseIdHelpSeen.includes(this.currentFileId);
        },

        /**
         * Count the open recording once while the search card shows (a file with no release yet).
         * Runs from an x-effect on the card, so it re-checks on every file or release change.
         */
        noteReleaseIdHelpShown() {
            const fileId = this.currentFileId;
            if (!this.currentFile || this.selectedRelease || !fileId) return;
            if (this.releaseIdHelpSeen.includes(fileId) || this.releaseIdHelpSeen.length >= RELEASE_ID_HELP_MAX_RECORDINGS) return;
            this.releaseIdHelpSeen = [...this.releaseIdHelpSeen, fileId];
            try {
                window.localStorage.setItem(RELEASE_ID_HELP_STORAGE_KEY, JSON.stringify(this.releaseIdHelpSeen));
            } catch (error) { /* Without storage the help simply shows again after a reload. */ }
        },

        /** Select the exact release the user named by ID or link, skipping search. */
        async openReleaseById() {
            if (this.releaseIdLoading) return;
            // Enter in an empty box is no pick: it gets the hint below, not a "wait" toast
            if (this.releaseIdInput.trim() && this.refusePickWhileBusy()) return;
            const ref = parseDiscogsRelease(this.releaseIdInput);
            if (!ref) {
                this.releaseIdNotice = 'Paste a Discogs release link (discogs.com/release/…) or type its number, e.g. 2874426.';
                return;
            }
            if (ref.master) {
                this.releaseIdNotice = `That is a master release (all versions of the album). Open it on Discogs, pick the exact pressing you own, and paste that release's link.`;
                return;
            }
            this.releaseIdNotice = '';
            this.releaseIdLoading = true;
            // A pick like a card click: a later pick, Change release or a file switch while
            // this loads clears _pendingPickId, and the reply is then dropped.
            const call = ++this._releaseIdCall;
            const pick = `id:${call}`;
            const fileId = this.currentFileId;
            const superseded = () => this._pendingPickId !== pick || this.currentFileId !== fileId;
            this._pendingPickId = pick;
            try {
                const response = await fetch(`/api/release/${ref.id}`);
                const data = await response.json().catch(() => ({}));
                if (superseded()) return;
                if (!response.ok || !Array.isArray(data.tracks)) {
                    this.releaseIdNotice = response.status === 404
                        ? `Discogs release ${ref.id} was not found (or Discogs is unavailable right now).`
                        : `Couldn't load release ${ref.id}: ${data.detail || 'unknown error'}`;
                    return;
                }
                if (!data.tracks.length) {
                    this.releaseIdNotice = `Release ${ref.id} has no tracklist on Discogs, so it can't guide the splits.`;
                    return;
                }
                if (this.refusePickWhileBusy()) return;   // keep the link in the box to try again
                this.releaseIdInput = '';
                this.selectRelease({ ...data, detailStatus: 'loaded' });
            } catch (error) {
                if (!superseded()) this.releaseIdNotice = `Couldn't reach the server to load release ${ref.id}.`;
            } finally {
                if (this._pendingPickId === pick) this._pendingPickId = null;
                if (this._releaseIdCall === call) this.releaseIdLoading = false;
            }
        },

        /**
         * Parse a Discogs duration string ("5:24", "1:02:03") into seconds.
         * Returns null when missing/unparseable/zero.
         */
        parseTrackDuration(str) {
            if (!str || typeof str !== 'string') return null;
            const parts = str.trim().split(':');
            if (parts.length < 2 || parts.length > 3) return null;
            if (!parts.every(p => /^\d+$/.test(p))) return null;
            const nums = parts.map(p => parseInt(p, 10));
            const secs = nums.length === 3
                ? nums[0] * 3600 + nums[1] * 60 + nums[2]
                : nums[0] * 60 + nums[1];
            return secs > 0 ? secs : null;
        },

        /**
         * How many of a release's tracks carry a usable length.
         * status: 'full' | 'partial' | 'none'
         */
        releaseDurationInfo(release) {
            const tracks = release?.tracks || [];
            const total = tracks.length;
            const withDuration = tracks.filter(t => this.parseTrackDuration(t.duration) !== null).length;
            let status = 'none';
            if (total > 0 && withDuration === total) status = 'full';
            else if (withDuration > 0) status = 'partial';
            return { total, withDuration, status };
        },

        /**
         * Group a release's tracks by vinyl side (leading letters of the
         * position, e.g. "A1" -> "A").  Tracks without a letter prefix
         * ("1", "2") share a single group with side ''.  Groups keep the
         * order in which they first appear; every track carries its
         * original index in release.tracks as releaseIdx.
         * totalSeconds is null unless every track in the group has a length.
         */
        releaseSides(release) {
            const groups = [];
            const bySide = {};
            (release?.tracks || []).forEach((t, releaseIdx) => {
                const m = /^([A-Za-z]+)/.exec(String(t.position || '').trim());
                const side = m ? m[1].toUpperCase() : '';
                if (!bySide[side]) {
                    bySide[side] = { side, tracks: [], totalSeconds: 0 };
                    groups.push(bySide[side]);
                }
                const g = bySide[side];
                g.tracks.push({ ...t, releaseIdx });
                const secs = this.parseTrackDuration(t.duration);
                g.totalSeconds = (g.totalSeconds !== null && secs !== null) ? g.totalSeconds + secs : null;
            });
            return groups;
        },

        /**
         * Short "A·4  B·5" summary of a release's sides
         */
        sidesSummary(release) {
            return this.releaseSides(release)
                .map(g => `${this.sideLabel(g.side)}·${g.tracks.length}`)
                .join('  ');
        },

        /**
         * Display label for a side key
         */
        sideLabel(side) {
            return side === '' ? 'All' : side;
        },

        /**
         * Search results after applying the "only with track lengths" filter.
         * Discogs relevance order is preserved.
         */
        get filteredResults() {
            // Unloaded (tracks null) and failed results stay visible: the
            // filter only hides releases KNOWN to lack full lengths.
            const shown = this.onlyWithLengths
                ? this.searchResults.filter(r => !r.tracks || this.releaseDurationInfo(r).status === 'full')
                : this.searchResults;
            if (!this.detailsSettled) return shown;
            // All details in: fitting releases first, stable within groups.
            return [
                ...shown.filter(r => this.cardFit(r)?.state === 'fit'),
                ...shown.filter(r => this.cardFit(r)?.state !== 'fit')
            ];
        },

        /**
         * Human label for a set of sides, matching the scope presets
         * ("Full album", "Disc 2 (C/D)"); falls back to "Side A" / "Sides A+B".
         */
        scopeLabel(release, sides) {
            const groups = this.releaseSides(release);
            if (groups.length <= 1 || sides.length === groups.length) return 'Full album';
            const preset = this.presetsFor(groups).find(p =>
                p.sides.length === sides.length && p.sides.every(k => sides.includes(k)));
            if (preset) return preset.label;
            const names = sides.map(k => this.sideLabel(k));
            return names.length === 1 ? `Side ${names[0]}` : `Sides ${names.join('+')}`;
        },

        /**
         * How well a loaded release fits the current file's music length.
         * Returns null when unknown (tracks not loaded, no lengths, no file
         * length yet), else
         *   { state: 'fit', label, scopeSeconds, fileSeconds, usesMusic, diff }
         *   { state: 'nofit', fullSeconds, fileSeconds, usesMusic }
         */
        cardFit(release) {
            if (!release?.tracks) return null;
            const music = this.currentFile?.musicDuration;
            const usesMusic = music > 0;
            const fileSeconds = usesMusic ? music : this.currentFile?.duration;
            if (!(fileSeconds > 0)) return null;

            const groups = this.releaseSides(release);
            if (!groups.length) return null;
            const used = Object.keys(this.sidesUsedByOthers(release));
            const sumOf = sides => {
                const gs = groups.filter(g => sides.includes(g.side));
                return gs.every(g => g.totalSeconds !== null)
                    ? gs.reduce((t, g) => t + g.totalSeconds, 0) : null;
            };

            const fullSeconds = sumOf(groups.map(g => g.side));
            // suggestSides() has no candidates for single-sided releases.
            const suggestion = groups.length <= 1
                ? { sides: groups.map(g => g.side), matched: fullSeconds !== null && Math.abs(fullSeconds - fileSeconds) / fileSeconds <= 0.15 }
                : this.suggestSides(release, fileSeconds, used);

            if (suggestion.matched) {
                const scopeSeconds = sumOf(suggestion.sides);
                if (scopeSeconds !== null) {
                    return {
                        state: 'fit',
                        label: this.scopeLabel(release, suggestion.sides),
                        scopeSeconds,
                        fileSeconds,
                        usesMusic,
                        diff: Math.abs(scopeSeconds - fileSeconds) / fileSeconds
                    };
                }
            }
            if (fullSeconds === null) return null;
            return { state: 'nofit', fullSeconds, fileSeconds, usesMusic };
        },

        /**
         * Card text for a fit result ('' when unknown)
         */
        fitText(fit) {
            if (!fit) return '';
            const what = fit.usesMusic ? 'music' : 'file';
            if (fit.state === 'fit') {
                return `${fit.label} ${this.formatDuration(fit.scopeSeconds)} · your ${what} ${this.formatDuration(fit.fileSeconds)} ✓`;
            }
            return `Lengths don't fit this file (full album ${this.formatDuration(fit.fullSeconds)} vs ${what} ${this.formatDuration(fit.fileSeconds)})`;
        },

        /**
         * Id of the single closest fit, once all details are in (else null)
         */
        get bestFitId() {
            if (!this.detailsSettled) return null;
            let best = null;
            for (const r of this.searchResults) {
                const fit = this.cardFit(r);
                if (fit?.state === 'fit' && (best === null || fit.diff < best.diff)) {
                    best = { id: r.id, diff: fit.diff };
                }
            }
            return best ? best.id : null;
        },

        /**
         * Decide which side(s) the recording most likely contains.
         *
         * Candidates are every contiguous run of sides in release order
         * (A, B, A-B, B-C, A-D ...) whose total length is fully known.  The
         * run closest to the recording length wins if within 15%.  Near-ties
         * (within 1 percentage point) prefer the full album, then a
         * disc-aligned run (even start index, even length), then anything else.
         *
         * usedSides lists sides already claimed by other queue files for the
         * same release; overlapping runs are skipped unless nothing else is
         * left.  With no length match, the default is the first disc-aligned
         * run of unused sides when other files use this release, otherwise
         * the full album.
         *
         * Returns { sides: [keys], matched: bool, reason: 'length'|'default'|'single' }.
         */
        suggestSides(release, recordingSeconds, usedSides = []) {
            const groups = this.releaseSides(release);
            const keys = groups.map(g => g.side);
            const n = groups.length;
            if (n <= 1) {
                return { sides: keys, matched: false, reason: 'single' };
            }

            const runs = [];
            for (let i = 0; i < n; i++) {
                let total = 0;
                for (let j = i; j < n; j++) {
                    total = (total !== null && groups[j].totalSeconds !== null)
                        ? total + groups[j].totalSeconds : null;
                    const len = j - i + 1;
                    runs.push({
                        sides: keys.slice(i, j + 1),
                        total,
                        rank: len === n ? 0 : (i % 2 === 0 && len % 2 === 0 ? 1 : 2)
                    });
                }
            }

            const used = new Set(usedSides);
            const free = runs.filter(r => !r.sides.some(k => used.has(k)));
            const pool = free.length ? free : runs;

            if (recordingSeconds > 0) {
                const scored = pool
                    .filter(r => r.total !== null)
                    .map(r => ({ ...r, diff: Math.abs(r.total - recordingSeconds) / recordingSeconds }));
                if (scored.length) {
                    const bestDiff = Math.min(...scored.map(r => r.diff));
                    if (bestDiff <= 0.15) {
                        const near = scored
                            .filter(r => r.diff <= bestDiff + 0.01)
                            .sort((x, y) => x.rank - y.rank || x.diff - y.diff);
                        return { sides: near[0].sides, matched: true, reason: 'length' };
                    }
                }
            }

            // No length match: prefer the first disc of still-unused sides.
            if (used.size > 0 && free.length) {
                const aligned = free.find(r => r.rank === 1 && r.sides.length === 2);
                if (aligned) {
                    return { sides: aligned.sides, matched: false, reason: 'default' };
                }
                const firstFree = keys.find(k => !used.has(k));
                if (firstFree !== undefined) {
                    return { sides: [firstFree], matched: false, reason: 'default' };
                }
            }

            return { sides: keys, matched: false, reason: 'default' };
        },

        /**
         * Sides of a release already claimed by OTHER queue files.
         * Returns { sideKey: filename }.
         */
        sidesUsedByOthers(release) {
            const used = {};
            if (!release) return used;
            for (const [fileId, choice] of Object.entries(this.releaseChoices)) {
                if (fileId === this.currentFileId || choice.release?.id !== release.id) continue;
                const file = this.uploadedFiles.find(f => f.id === fileId);
                for (const side of choice.sides) {
                    if (!(side in used)) used[side] = file?.filename || 'another file';
                }
            }
            return used;
        },

        /**
         * Shortened filename for compact notes
         */
        shortFilename(name) {
            const base = String(name || '').replace(/\.(wav|aiff|aif)$/i, '');
            return base.length > 18 ? base.slice(0, 17) + '…' : base;
        },

        /**
         * Releases already chosen for other queue files (one entry per
         * release), offered as a shortcut in the search panel.
         */
        get sameReleaseShortcuts() {
            const seen = new Set();
            const out = [];
            for (const [fileId, choice] of Object.entries(this.releaseChoices)) {
                if (fileId === this.currentFileId || !choice.release || seen.has(choice.release.id)) continue;
                const file = this.uploadedFiles.find(f => f.id === fileId);
                if (!file) continue;
                seen.add(choice.release.id);
                out.push({ fileId, filename: file.filename, release: choice.release });
            }
            return out;
        },

        /** Derived view for release shortcuts; the workspace remains the only stored state. */
        get releaseChoices() {
            const choices = {};
            for (const file of this.uploadedFiles) {
                const state = this.workspaceFor(file.id);
                if (state?.selectedRelease) choices[file.id] = { release: state.selectedRelease, sides: state.selectedSides };
            }
            return choices;
        },

        /** Persist the chosen release/sides as part of the complete editing workspace. */
        rememberChoice() {
            this.saveWorkspace();
        },

        /**
         * Scope presets for the selected release: "Full album" plus one per
         * disc (sides pair up in order: A/B = disc 1, C/D = disc 2 ...).
         * Disc presets only exist when the release has more than 2 sides.
         */
        get sidePresets() {
            return this.presetsFor(this.sideChips);
        },

        presetsFor(groups) {
            if (groups.length <= 1) return [];
            const sum = gs => gs.every(g => g.totalSeconds !== null)
                ? gs.reduce((t, g) => t + g.totalSeconds, 0) : null;
            const make = (label, gs) => ({
                label,
                sides: gs.map(g => g.side),
                trackCount: gs.reduce((t, g) => t + g.tracks.length, 0),
                totalSeconds: sum(gs)
            });
            const presets = [make('Full album', groups)];
            if (groups.length > 2) {
                for (let i = 0; i < groups.length; i += 2) {
                    const gs = groups.slice(i, i + 2);
                    presets.push(make(`Disc ${i / 2 + 1} (${gs.map(g => g.side).join('/')})`, gs));
                }
            }
            return presets;
        },

        /**
         * Does the current selection exactly equal this side set?
         */
        sidesEqualSelection(sides) {
            return sides.length === this.selectedSides.length &&
                sides.every(k => this.selectedSides.includes(k));
        },

        /**
         * Is this exact side set what the auto-suggestion picked by length?
         */
        isMatchedScope(sides) {
            return this.sidesSuggestionReason === 'length' &&
                sides.length === this.suggestedSides.length &&
                sides.every(k => this.suggestedSides.includes(k));
        },

        /**
         * Muted note shown when the scope was defaulted rather than matched
         */
        get defaultScopeNote() {
            if (this.sidesSuggestionReason !== 'default' || this.sideChips.length <= 1) return '';
            if (!this.sidesEqualSelection(this.suggestedSides)) return '';
            return this.suggestedSides.length === this.sideChips.length
                ? 'Defaulted to full album — pick a disc or side if this file holds less.'
                : 'Defaulted to the sides not used by your other file(s) — adjust if this is wrong.';
        },

        /**
         * Apply a scope preset and re-run detection
         */
        applyPreset(sides) {
            if (this.analyzing || this.currentLocked) return;
            this.selectedSides = this.sideChips.map(g => g.side).filter(k => sides.includes(k));
            this.sidesTouched = true;   // even a pick equal to the default is the user's own choice
            this.rememberChoice();
            this.resetMappingToTargets();
            this.afterTargetsChanged();
        },

        /**
         * Release sides as chips (with counts/lengths) for the selected release
         */
        get sideChips() {
            return this.releaseSides(this.selectedRelease);
        },

        /**
         * Release tracks on the selected sides, in release order, each
         * carrying its releaseIdx into selectedRelease.tracks.
         */
        get targetTracks() {
            if (!this.selectedRelease) return [];
            return this.releaseSides(this.selectedRelease)
                .filter(g => this.selectedSides.includes(g.side))
                .flatMap(g => g.tracks)
                .sort((a, b) => a.releaseIdx - b.releaseIdx);
        },

        /**
         * Point customMapping at targetTracks (detected track i -> i-th
         * target; clamped to the last target when there are more detected
         * tracks than targets) and refresh the mismatch flag.
         */
        resetMappingToTargets() {
            const targets = this.targetTracks;
            const last = targets.length ? targets[targets.length - 1].releaseIdx : null;
            this.trackMappingReversed = false;
            this.customMapping = Array.from({ length: this.detectedTracks.length }, (_, i) =>
                targets[i]?.releaseIdx ?? last ?? i
            );
            this.trackCountMismatch = !!this.selectedRelease &&
                this.activeTrackCount !== targets.length;
            this.refreshRegionLabels();
        },

        /**
         * Install a fresh detection result.  Detection replaces any hand
         * edits, so the edit/undo state and ghost markers start over.
         */
        setDetectedTracks(tracks, opts = {}) {
            this.detectedTracks = tracks.map(track => ({
                ...track,
                editing: false,
                ignored: false
            }));
            // An open Rename / custom-track form reads customMapping at Save; a detection resets that
            // mapping, so the form would retitle another track. Every detection install comes through here.
            this.trackForm = null;
            this.boundariesEdited = false;
            this.editBanner = false;
            this.snapUndo = null;
            this.snapNotice = '';
            this.expectedBoundaries = opts.expected ? [...opts.expected] : [];
        },

        /**
         * Forget edit flags, banners, undo snapshot and ghost markers
         */
        resetEditState() {
            this.boundariesEdited = false;
            this.editBanner = false;
            this.snapUndo = null;
            this.snapNotice = '';
            this.expectedBoundaries = [];
        },

        /**
         * Record that the user changed boundaries by hand
         */
        markEdited() {
            this.boundaryEditCount++;
            this.boundariesEdited = true;
            this.snapUndo = null;
            this.snapNotice = '';
        },

        /**
         * Re-run guided detection after the release / sides changed, unless
         * the user hand-edited boundaries - then offer a choice instead.
         */
        afterTargetsChanged() {
            if (this.boundariesEdited && this.detectedTracks.length > 0) {
                this.editBanner = true;
                this.clearExpectedMarkers();
                return Promise.resolve(false);
            }
            return this.redetectForTargets();
        },

        /**
         * Snap boundaries to the Discogs lengths (undoable)
         */
        async snapToDiscogs() {
            if (this.analyzing || this.currentLocked || !this.selectedRelease || this.targetTracks.length < 1) return;

            const snapshot = {
                tracks: JSON.parse(JSON.stringify(this.detectedTracks)),
                mapping: [...this.customMapping],
                reversed: this.trackMappingReversed,
                expected: [...this.expectedBoundaries],
                edited: this.boundariesEdited
            };
            this.editBanner = false;

            const fileId = this.currentFileId;
            const editCount = this.boundaryEditCount;
            const ok = await this.redetectForTargets();
            if (this.currentFileId !== fileId) return;
            if (ok) {
                this.snapUndo = snapshot;
                this.snapNotice = 'Snapped to Discogs.';
            } else if (this.detectedTracks.length === 0 && snapshot.tracks.length > 0 && this.boundaryEditCount === editCount) {
                // Found nothing (redetectForTargets already warned): keep the hand edits rather
                // than leave an empty editor with nothing to undo.
                this.rescanNotice = '';
                await this.restoreSnapshotWithWaveform(snapshot);
            }
        },

        /**
         * Put a snapshot of the edits back and build the waveform it needs: a detection that
         * found nothing leaves none, and restoreEdits only redraws regions on an existing one.
         */
        async restoreSnapshotWithWaveform(snapshot) {
            this.restoreEdits(snapshot, { rebuildRegions: false });
            if (this.waveform) {
                this.addTrackRegions();
                return;
            }
            await this.$nextTick();
            await this.initWaveform();
        },

        /**
         * Restore the boundaries and mapping from before the last snap
         */
        async undoSnap() {
            const snap = this.snapUndo;
            if (!snap) return;

            this.rescanNotice = '';   // "Placed N tracks" described the snap, not the restored edits
            await this.restoreSnapshotWithWaveform(snap);
            this.rescanNotice = '';
        },

        /**
         * Dismiss the hand-edit banner, keeping boundaries; the mapping
         * follows the new release / sides.
         */
        keepMyEdits() {
            this.editBanner = false;
            this.resetMappingToTargets();
        },

        /**
         * True (with a warning toast saying why) while a release pick must be refused: the
         * recording is exporting or its tracks are being detected.
         */
        refusePickWhileBusy() {
            if (this.currentLocked) {
                this.notify('This recording is exporting. Pick a release when the export has finished.', { type: 'warning', timeout: 5000 });
                return true;
            }
            if (this.analyzing) {
                this.notify('Wait for track detection to finish before picking a release.', { type: 'warning', timeout: 5000 });
                return true;
            }
            return false;
        },

        /**
         * Select a release from search results, resolve which side(s) the
         * recording covers and (re)run detection for that many tracks.
         */
        selectRelease(release) {
            if (!Array.isArray(release?.tracks)) return;   // nothing to select; leaves a pick still loading alone
            // Latest click wins even when refused: an older card still loading must not land later
            this._pendingPickId = null;
            if (this.refusePickWhileBusy()) return;

            this.selectedRelease = release;
            this.loadAlbumDescription();
            this.prefixPartTitles = true;  // a per-release choice
            this.titleSource = null;       // borrowed movements belong to the previous release
            this.closeMovementsPanel();
            this.resetDonors();
            this.applySideSuggestion(release);
            this.rememberChoice();

            this.resetMappingToTargets();
            this.afterTargetsChanged();
        },

        /**
         * Pick the sides this recording most likely holds (by its length, else the sides the other
         * files leave free) for `release` and select them.  A suggestion is not a user choice, so
         * `sidesTouched` starts over.
         */
        applySideSuggestion(release) {
            const suggestion = this.suggestSides(
                release,
                this.currentFile?.musicDuration || this.currentFile?.duration,
                Object.keys(this.sidesUsedByOthers(release))
            );
            this.selectedSides = suggestion.sides;
            this.suggestedSides = suggestion.sides;
            this.sidesMatchedByDuration = suggestion.matched;
            this.sidesSuggestionReason = suggestion.reason;
            this.sidesTouched = false;
        },

        /** True when the loaded description belongs to the release now selected and is worth showing. */
        get albumDescriptionVisible() {
            const state = this.albumDescription;
            return !!this.selectedRelease && state.releaseId === this.selectedRelease.id
                && ['loading', 'found', 'none', 'error'].includes(state.status);
        },

        /**
         * Fetch the Wikipedia description of the selected release for the preview. Skipped (no
         * request) when the setting is off. A reply for a release that is no longer selected is
         * ignored. Never touches detection or tracks. Called explicitly, not from a watcher.
         */
        async loadAlbumDescription() {
            const releaseId = this.selectedRelease?.id;
            this.albumDescriptionExpanded = false;
            if (!releaseId || this.config.album_description !== true) {
                this.albumDescription = { releaseId: null, status: 'idle', text: '', title: '', url: '' };
                return;
            }
            this.albumDescription = { releaseId, status: 'loading', text: '', title: '', url: '' };
            let result;
            try {
                const response = await fetch(`/api/release/${releaseId}/description`);
                // A 404 means the release itself can't be loaded; the preview treats it as an error.
                result = response.ok ? await response.json() : { status: 'error' };
            } catch (error) {
                result = { status: 'error' };
            }
            // Stale reply: another release was selected, or the setting was switched off meanwhile.
            if (this.selectedRelease?.id !== releaseId || this.config.album_description !== true) {
                // Still showing this release's "loading" (cleared and restored by Undo meanwhile): nothing
                // else will reload it, so reset and let the next check start a new lookup.
                if (this.albumDescription.releaseId === releaseId && this.albumDescription.status === 'loading') {
                    this.albumDescription = { releaseId: null, status: 'idle', text: '', title: '', url: '' };
                }
                return;
            }
            this.albumDescription = {
                releaseId, status: result.status || 'error',
                text: result.text || '', title: result.title || '', url: result.url || ''
            };
        },

        /**
         * Toggle a side chip (multi-select, at least one side stays selected)
         * and re-run detection for the new track count.
         */
        toggleSide(side) {
            if (this.analyzing || this.currentLocked) return;

            const isSelected = this.selectedSides.includes(side);
            if (isSelected && this.selectedSides.length === 1) return;

            const wanted = isSelected
                ? this.selectedSides.filter(s => s !== side)
                : [...this.selectedSides, side];
            // Keep release order regardless of click order
            this.selectedSides = this.sideChips.map(g => g.side).filter(s => wanted.includes(s));
            this.sidesTouched = true;
            this.rememberChoice();

            this.resetMappingToTargets();
            this.afterTargetsChanged();
        },

        /**
         * Run detection for the number of tracks on the selected sides
         */
        async redetectForTargets() {
            const targets = this.targetTracks;
            const count = targets.length;
            if (count < 1 || !this.currentFileId || this.analyzing || this.currentLocked) return false;

            if (count > MAX_GUIDED_TRACKS) {
                // Also a toast: rescanNotice only renders once tracks are detected, and a first pick has none.
                const text = `The chosen sides hold ${count} tracks; detection places at most ${MAX_GUIDED_TRACKS} at a time.`
                    + (this.sideChips.length > 1 ? ' Pick a disc or side.' : '');
                this.clearExpectedMarkers();   // they belonged to the previous sides
                this.rescanNotice = `⚠️ ${text}`;
                this.notify(text, { type: 'warning' });
                return false;
            }

            // The waveform, inline inputs and context menu stay live while this runs: a reply is only
            // installed if the recording, the release and the hand edits are still what they were.
            const fileId = this.currentFileId;
            const releaseId = this.selectedRelease?.id ?? null;
            const editCount = this.boundaryEditCount;
            const superseded = () => this.currentFileId !== fileId
                || (this.selectedRelease?.id ?? null) !== releaseId
                || this.boundaryEditCount !== editCount;
            const discardSuperseded = () => {
                this.processingMessage = '';
                // Same recording and release, so the markers on screen belong to other sides now and
                // the tracks may no longer match the release: stale markers go, the ask-first banner
                // offers the choice. A different recording or release is none of this one's business.
                if (this.currentFileId === fileId && (this.selectedRelease?.id ?? null) === releaseId) {
                    this.clearExpectedMarkers();
                    this.editBanner = this.detectedTracks.length > 0;
                }
                return false;
            };

            let succeeded = false;
            this.analyzing = true;
            this.rescanNotice = '';
            this.processingMessage = 'Placing track boundaries...';
            this.pauseWaveform();

            try {
                const response = await fetch('/api/analyze-guided', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: fileId,
                        expected_tracks: count,
                        durations: targets.map(t => this.parseTrackDuration(t.duration)),
                        side_breaks: targets.flatMap((track, index) => {
                            if (!index) return [];
                            const side = t => /^([A-Za-z]+)/.exec(String(t.position || '').trim())?.[1]?.toUpperCase();
                            const before = side(targets[index - 1]), after = side(track);
                            return before && after && before !== after ? [index] : [];
                        })
                    })
                });
                const data = await response.json();

                if (superseded()) return discardSuperseded();
                if (!response.ok || !data.tracks) {
                    throw new Error(data.detail || 'Boundary detection failed');
                }

                this.setDetectedTracks(data.tracks, {
                    expected: data.method === 'durations'
                        ? (data.boundaries || []).map(b => b.expected).filter(x => Number.isFinite(x))
                        : []
                });
                this.processingMessage = '';

                const file = this.uploadedFiles.find(f => f.id === fileId);
                if (file) {
                    file.status = 'analyzed';
                }
                this.applyScan(fileId, data);

                if (this.selectedRelease) {
                    this.resetMappingToTargets();
                }

                // initWaveform keeps an existing waveform, and with it the old regions
                this.destroyWaveform();
                if (data.tracks.length === 0) {
                    // No waveform either, or a retry's tracks would get no regions
                    this.notify('No tracks were found in this recording. Try another release or adjust the silence settings.', { type: 'warning' });
                } else {
                    await this.$nextTick();
                    await this.initWaveform();
                }

                if (data.method === 'durations') {
                    const snapped = (data.boundaries || []).filter(b => b.snapped).length;
                    this.rescanNotice = `✅ Placed ${data.tracks.length} tracks from Discogs lengths (${snapped} of ${(data.boundaries || []).length} boundaries snapped to silence).`;
                } else {
                    this.rescanNotice = data.matched
                        ? `✅ Placed ${data.tracks.length} tracks by track count (Discogs lengths unavailable).`
                        : `⚠️ Couldn't find exactly ${count} tracks — closest result is ${data.tracks.length}. Right-click the waveform to add or remove splits manually.`;
                }
                // Nothing found is not a success: the caller must not offer an Undo of it
                succeeded = data.tracks.length > 0;
            } catch (error) {
                if (superseded()) return discardSuperseded();
                console.error('Guided detection failed:', error);
                this.rescanNotice = '❌ Boundary detection failed: ' + error.message;
                // rescanNotice only renders in the track table, which needs tracks
                this.notifyError('Boundary detection failed', error);
                this.processingMessage = '';
                this.clearExpectedMarkers();   // they belonged to the previous sides
            } finally {
                this.analyzing = false;
            }
            return succeeded;
        },

        /**
         * Record the music span (recording minus lead-in/run-out) for a file.
         * Only stores the number; never touches the user's side selection.
         */
        applyScan(fileId, scan) {
            const file = this.uploadedFiles.find(f => f.id === fileId);
            if (!file || !(scan.music_end > scan.music_start)) return;
            file.musicDuration = scan.music_end - scan.music_start;
            file.musicStart = scan.music_start;
        },

        /**
         * Ask the server whether the background scan finished (it may have
         * completed before this file was selected / the WebSocket connected).
         */
        async fetchScan(fileId) {
            try {
                const response = await fetch(`/api/scan/${fileId}`);
                if (!response.ok) return;
                const data = await response.json();
                if (data.ready) {
                    this.applyScan(fileId, data);
                    this.fetchHum(fileId);
                }
            } catch (error) {
                console.warn('Scan status unavailable:', error);
            }
        },

        // ---- Borrow track lengths from another pressing ----------------

        /** Forget donor search results / in-flight search (release or file changed) */
        resetDonors() {
            this._donorSeq++;
            this.donors = { releaseId: null, status: 'idle', checked: 0, versions: null, budget: DONOR_FETCH_BUDGET, list: [], error: '' };
        },

        /** Lengths coverage of the selected sides only */
        get targetLengthInfo() {
            return this.releaseDurationInfo({ tracks: this.targetTracks });
        },

        /** Offer borrowing when the target tracks lack full lengths */
        get showBorrowLengths() {
            return !!this.selectedRelease && this.targetTracks.length > 0 &&
                this.targetLengthInfo.status !== 'full';
        },

        get borrowLengthsMessage() {
            const info = this.targetLengthInfo;
            return info.status === 'none'
                ? 'This release has no track lengths'
                : `Only ${info.withDuration}/${info.total} tracks have lengths`;
        },

        get donorProgressText() {
            return `Checking other pressings… (${this.donors.checked} of up to ${this.donors.budget})`;
        },

        /**
         * Every pressing the selected release's lengths were borrowed from, in order
         * ({release_id, label, year, country}). The marker lives on the release object, so it
         * follows that object when another file reuses the same release. (A workspace saved before
         * several sources were kept holds a single object.)
         */
        get lengthsBorrowedFrom() {
            const marker = this.selectedRelease?.lengthsBorrowedFrom;
            return Array.isArray(marker) ? marker : (marker ? [marker] : []);
        },

        /**
         * The lookup's donors recomputed against the release as it is now, for the chosen sides:
         * `matched` = lengths the donor still supplies for chosen-side tracks that have none,
         * `missing` = chosen-side tracks without a length.  Donors that fill nothing are dropped
         * and the rest sorted by fills (the backend's order breaks ties), so a list fetched before
         * a borrow, a hand edit or a side change never shows stale counts.
         */
        get visibleDonors() {
            if (!this.selectedRelease) return [];
            const missingIndexes = new Set(this.targetTracks
                .filter(track => this.parseTrackDuration(track.duration) === null)
                .map(track => track.releaseIdx));
            const chosenIndexes = new Set(this.targetTracks.map(track => track.releaseIdx));
            return this.donors.list
                .map((donor, order) => {
                    const matched = this.donorFills(donor).filter(fill => missingIndexes.has(fill.index)).length;
                    return {
                        donor: {
                            ...donor, matched, missing: missingIndexes.size,
                            compared: this.donorPlacedCount(donor, donor.compared_indexes, chosenIndexes, donor.compared),
                            disagree: this.donorPlacedCount(donor, donor.disagree_indexes, chosenIndexes, donor.disagree)
                        },
                        order
                    };
                })
                .filter(entry => entry.donor.matched > 0)
                // Donors whose lengths agree with the release's own come first, by the `disagree` count
                // recounted above for the chosen sides (only the server knows the lengths of tracks the
                // release already has, so it sends which tracks it compared); then most fills
                .sort((a, b) => (a.donor.disagree > 0) - (b.donor.disagree > 0)
                    || b.donor.matched - a.donor.matched || a.order - b.order)
                .map(entry => entry.donor);
        },

        /**
         * How many of the tracks a donor's index list names (server track indexes, as the keys of
         * `lengths`) are on the chosen sides.  Each is placed by Discogs position through
         * `donorTrackIndex` exactly like a length; one that cannot be placed (split part, custom or
         * borrowed-title track, unknown position) is skipped.  Without the list (an older reply),
         * the server's own total.
         */
        donorPlacedCount(donor, indexes, chosenIndexes, total) {
            if (!Array.isArray(indexes)) return total;
            return indexes.filter(key => {
                const position = donor.positions?.[key];
                if (position === undefined || position === null) return false;
                return chosenIndexes.has(this.donorTrackIndex(position, key));
            }).length;
        },

        /**
         * Tracks that are still the Discogs ones: not custom, not a split part (`umbrella`) and not
         * placed by the title source.  Donor lengths may only land on these.
         */
        isDiscogsTrack(track) {
            if (track.custom || track.umbrella) return false;
            if (!this.titleSource) return true;
            return track.position !== this.titleSource.replace_position &&
                !(this.titleSource.assignments || []).some(row => row.position === track.position);
        },

        /**
         * The release track (index into `selectedRelease.tracks`) a donor's length belongs to, or -1.
         * The donor's keys index the server's pristine tracklist, which a split, a custom track or a title
         * source may have reshaped, so the track is found by Discogs position: the one Discogs track
         * that has it (none when it is empty or shared by several).  `key` is the server index: while
         * nothing was inserted (no custom track, split part or title source) the tracklist still has the
         * server's shape, and the track at that index with that position is taken directly, which also
         * serves duplicate and empty positions.  Once something was inserted that shortcut is off:
         * a shifted index could hold another track that merely shares the position.
         */
        donorTrackIndex(position, key) {
            const tracks = this.selectedRelease?.tracks || [];
            const unshifted = tracks.every(track => !track.custom && !track.umbrella) && !this.titleSource;
            const direct = tracks[Number(key)];
            if (unshifted && direct && direct.position === position) return Number(key);
            if (!position) return -1;
            let found = -1;
            for (let index = 0; index < tracks.length; index++) {
                if (tracks[index].position !== position || !this.isDiscogsTrack(tracks[index])) continue;
                if (found !== -1) return -1;
                found = index;
            }
            return found;
        },

        /** A donor's usable lengths as [{index, length}] on the current tracklist (unparseable or unplaceable ones are left out). */
        donorFills(donor) {
            const fills = [];
            for (const [key, length] of Object.entries(donor.lengths || {})) {
                const position = donor.positions?.[key];
                if (position === undefined || position === null || this.parseTrackDuration(length) === null) continue;
                const index = this.donorTrackIndex(position, key);
                if (index !== -1) fills.push({ index, length });
            }
            return fills;
        },

        /** "fills 4 of 5 missing": the lengths this pressing can supply, out of the lengths the release lacks */
        donorFillText(donor) {
            return `fills ${donor.matched} of ${donor.missing} missing`;
        },

        /** Muted note on a donor whose lengths differ from the ones this release already has; '' when none do */
        donorDisagreeText(donor) {
            if (!(donor?.disagree > 0)) return '';
            return `Lengths differ from this release on ${donor.disagree} of ${donor.compared} track${donor.compared === 1 ? '' : 's'}`;
        },

        /** Said when no pressing fills anything: how far the lookup got, so a spent budget is visible */
        get donorEmptyText() {
            const checked = this.donors.checked;
            if (!(checked > 0)) return 'No other pressing has the missing lengths.';
            const of = this.donors.versions > checked ? ` (of ${this.donors.versions})` : '';
            return checked === 1
                ? `The 1 other pressing checked${of} doesn't have the missing lengths.`
                : `No other pressing has the missing lengths among the ${checked} checked${of}.`;
        },

        borrowedLabel(borrowed) {
            const parts = [borrowed?.label, borrowed?.year, borrowed?.country]
                .filter(part => part !== undefined && part !== null && part !== '');
            return parts.join(', ') || `release ${borrowed?.release_id}`;
        },

        donorTitle(donor) {
            return [donor.label, donor.year, donor.country, donor.format]
                .filter(part => part !== undefined && part !== null && part !== '').join(' · ');
        },

        /** Look for other pressings of the selected release's master that carry the missing lengths */
        async findLengthDonors() {
            const release = this.selectedRelease;
            if (!release || this.donors.status === 'searching') return;
            if (this.analyzing) {
                this.notify('Wait for track detection to finish before looking for other pressings.', { type: 'warning', timeout: 5000 });
                return;
            }
            if (this.currentLocked) {
                this.notify('This recording is exporting. Look for other pressings when the export has finished.', { type: 'warning', timeout: 5000 });
                return;
            }
            const sequence = ++this._donorSeq;
            this.donors = {
                releaseId: release.id, status: 'searching', checked: 0, versions: null, budget: DONOR_FETCH_BUDGET, list: [], error: ''
            };
            try {
                const response = await fetch(`/api/release/${release.id}/length-donors`);
                let body = null;
                try { body = await response.json(); } catch (_) { /* non-JSON error body */ }
                // A release, file or Undo change since the request started: the answer is for something else
                if (sequence !== this._donorSeq) return;
                if (!response.ok) throw new Error((body && body.detail) || 'Could not look for other pressings.');
                this.donors = {
                    ...this.donors, status: 'done', list: Array.isArray(body?.donors) ? body.donors : [],
                    // The reply's own counts replace the live progress ones: what was examined, of how many
                    checked: Number.isFinite(body?.checked) ? body.checked : this.donors.checked,
                    versions: Number.isFinite(body?.versions) ? body.versions : null
                };
            } catch (error) {
                if (sequence !== this._donorSeq) return;
                this.donors = {
                    ...this.donors, status: 'error', list: [],
                    error: error.message || 'Could not look for other pressings.'
                };
            }
        },

        /**
         * Copy a donor's lengths onto the selected release's tracks that have none (chosen sides
         * only), mark where they came from, and re-run detection (afterTargetsChanged: ask first
         * after hand edits).  Copy-on-write: the release object may also be a search result or
         * another workspace's release, so it is replaced by an edited copy and Undo puts the
         * original object back.
         */
        applyDonor(donor) {
            const release = this.selectedRelease;
            if (!release || !donor) return;
            if (this.analyzing) {
                this.notify('Wait for track detection to finish before borrowing lengths.', { type: 'warning', timeout: 5000 });
                return;
            }
            if (this.currentLocked) {
                this.notify('This recording is exporting. Borrow lengths when the export has finished.', { type: 'warning', timeout: 5000 });
                return;
            }
            // The list belongs to one release: a different one (or none) means a stale click
            if (this.donors.releaseId !== release.id) return;

            // Only tracks of the chosen sides, so the count agrees with "fills N of M missing"
            const chosenIndexes = new Set(this.targetTracks.map(track => track.releaseIdx));
            let filled = 0;
            const tracks = (release.tracks || []).map(track => ({ ...track }));
            for (const { index, length } of this.donorFills(donor)) {
                const track = tracks[index];
                if (!chosenIndexes.has(index)) continue;
                if (this.parseTrackDuration(track.duration) !== null) continue;   // only missing lengths
                track.duration = length;
                filled++;
            }
            if (filled === 0) {
                this.notify('That pressing has no lengths this release is missing.', { type: 'info' });
                return;
            }
            const borrowed = { release_id: donor.release_id, label: donor.label, year: donor.year, country: donor.country };
            const edited = { ...release, tracks, lengthsBorrowedFrom: [...this.lengthsBorrowedFrom, borrowed] };
            const fileId = this.currentFileId;
            // Without lengths the sides were only defaulted (full album, or the sides other files leave
            // free).  Now that lengths exist the length fit can pick the real side, unless the user chose
            // sides since (even the very ones that were the default): that is theirs.  The mapping depends
            // on the sides, so what Undo needs of it is captured too.
            // The selection must also still equal the suggestion: the app itself adds or drops sides
            // (a custom track on another side, a split) without the user picking any.
            const resuggest = !this.sidesTouched && this.sidesSuggestionReason === 'default'
                && this.sidesEqualSelection(this.suggestedSides);
            const previous = {
                sides: [...this.selectedSides], suggested: [...this.suggestedSides],
                matched: this.sidesMatchedByDuration, reason: this.sidesSuggestionReason,
                mapping: [...this.customMapping], reversed: this.trackMappingReversed,
                mismatch: this.trackCountMismatch,
                // The tracks that mapping describes: the borrow's own re-detection may replace them
                tracks: this.detectedTracks, trackCount: this.detectedTracks.length
            };
            this.selectedRelease = edited;
            const installed = this.selectedRelease;   // as read back (Alpine's proxy), like the other release undos
            this.resetDonors();
            let sidesChanged = false;
            if (resuggest) {
                this.applySideSuggestion(edited);
                sidesChanged = !this.sidesEqualSelection(previous.sides);
                // Hand-made mapping stays while the sides do
                if (sidesChanged) this.resetMappingToTargets();
                this.rememberChoice();
            }
            const resuggestedSides = [...this.selectedSides];
            this.afterTargetsChanged();   // once, with the new sides

            this.notifyUndo(`Borrowed ${filled} track length${filled === 1 ? '' : 's'} from ${this.borrowedLabel(borrowed)}.`, () => {
                // Any later change of the release (another pick, a custom or renamed track, a split, a title
                // source) replaced the copy: putting the original back would discard that change
                if (this.selectedRelease !== installed) {
                    this.notify(RELEASE_CHANGED_NOTICE, { type: 'warning', timeout: 6000 });
                    return;
                }
                this.selectedRelease = release;
                this.resetDonors();
                if (resuggest) {
                    // The suggestion belongs to the release's lengths, which are gone again
                    this.suggestedSides = previous.suggested;
                    this.sidesMatchedByDuration = previous.matched;
                    this.sidesSuggestionReason = previous.reason;
                    // The sides (and what depends on them) only if the borrow changed them and the user
                    // has not picked sides since, even the very ones the borrow chose
                    if (sidesChanged && !this.sidesTouched && this.sidesEqualSelection(resuggestedSides)) {
                        this.selectedSides = previous.sides;
                        if (this.detectedTracks === previous.tracks && this.detectedTracks.length === previous.trackCount) {
                            this.customMapping = previous.mapping;
                            this.trackMappingReversed = previous.reversed;
                            this.trackCountMismatch = previous.mismatch;
                        } else {
                            // Re-detection, a delete, a split or a workspace restore (which installs a copy of
                            // the tracks) replaced the array: the saved mapping describes other tracks, so it
                            // is reset, never kept.  The length check is defence for an in-place splice.
                            this.resetMappingToTargets();
                        }
                    }
                    this.rememberChoice();
                }
                this.afterTargetsChanged();
            }, { fileId, type: 'success' });
        },

        /**
         * Index tracks (suites, classical works) of the selected release: one entry
         * per work, folded (one umbrella track carrying `parts`) or unfolded (its
         * parts as separate tracks, each remembering its `umbrella`).
         */
        get indexTracks() {
            const out = [];
            (this.selectedRelease?.tracks || []).forEach((t, index) => {
                if (t.parts?.length) {
                    out.push({ umbrella: t, unfolded: false, index, count: t.parts.length });
                } else if (t.umbrella) {
                    const last = out[out.length - 1];
                    if (last?.unfolded && last.umbrella.position === t.umbrella.position &&
                        last.umbrella.title === t.umbrella.title) last.count++;
                    else out.push({ umbrella: t.umbrella, unfolded: true, index, count: 1 });
                }
            });
            return out.map(e => {
                const parts = e.umbrella.parts;
                const first = parts[0].position, last = parts[parts.length - 1].position;
                return { ...e, title: e.umbrella.title, range: first === last ? first : `${first}\u2013${last}` };
            });
        },

        /** The first split work's first part as it will be titled, for the prefix checkbox; or ''. */
        get partPrefixExample() {
            const first = this.indexTracks.find(entry => entry.unfolded);
            const part = first?.umbrella.parts[0];
            return part ? this.partDisplayTitle({ title: part.title, umbrella: first.umbrella }) : '';
        },

        /**
         * Replace an index track by its parts (or the parts by the index track),
         * re-detect for the new track count (or ask first after hand edits), offer Undo.
         * Copy-on-write like applyDonor: the release object may be shared with another recording,
         * and a later Undo can tell by identity whether this edit is still the current one.
         */
        setIndexUnfolded(entry, unfold) {
            const release = this.selectedRelease;
            if (!release || !entry || this.analyzing || this.currentLocked || entry.unfolded === unfold) return;
            const snapshot = {
                sides: [...this.selectedSides],
                all: this.selectedSides.length === this.sideChips.length
            };
            const fileId = this.currentFileId;
            const umbrella = JSON.parse(JSON.stringify(entry.umbrella));
            const replacement = unfold
                ? umbrella.parts.map(p => ({ position: p.position, title: p.title, duration: p.duration, umbrella }))
                : [umbrella];
            const edited = { ...release, tracks: JSON.parse(JSON.stringify(release.tracks)) };
            edited.tracks.splice(entry.index, unfold ? 1 : entry.count, ...replacement);
            this.selectedRelease = edited;
            const installed = this.selectedRelease;
            this.afterIndexChange(release.id, snapshot.all);

            this.notifyUndo(unfold
                ? `${umbrella.title}: split into ${umbrella.parts.length} parts.`
                : `${umbrella.title}: kept as one track.`, () => {
                if (this.selectedRelease !== installed) {
                    this.refuseReleaseUndo();
                    return;
                }
                this.selectedRelease = release;
                this.selectedSides = snapshot.sides;
                this.afterIndexChange(release.id, false);
            }, { fileId, type: 'success' });
        },

        /** Tracks changed shape: keep only sides that still exist, remap, re-detect. */
        afterIndexChange(releaseId, all) {
            this.resetDonors();
            const sides = this.sideChips.map(g => g.side);
            const kept = this.selectedSides.filter(side => sides.includes(side));
            this.selectedSides = all || !kept.length ? sides : kept;
            this.rememberChoice();
            this.resetMappingToTargets();
            if (this.selectedRelease?.id === releaseId) this.afterTargetsChanged();
        },

        /* ---- Movements from another release (plan 14) ----
         * The primary release keeps everything release-level; one work (or plain track) of it is replaced
         * by the movements of a work in a second release.  The tracks are ordinary release tracks (an
         * unfolded umbrella, or plain tracks), so detection, mapping, rename and fold/unfold need nothing
         * new; `titleSource` is what the export sends so the backend can resolve titles and credits. */

        /**
         * Offered while a release is chosen, the recording is editable and nothing is borrowed yet, and only
         * when it can help: the release has an index track (a work), or detection disagrees with its track count.
         */
        get canUseMovements() {
            return !!this.selectedRelease && !this.currentLocked && !this.titleSource &&
                (this.indexTracks.length > 0 || this.trackCountMismatch);
        },

        openMovementsPanel() {
            if (!this.canUseMovements) return;
            this._movementsSeq++;
            this.movementsPanel = { open: true, input: '', loading: false, error: '', donor: null,
                replacePosition: '', donorPosition: '', starts: [], splitNote: '' };
        },

        closeMovementsPanel() {
            this._movementsSeq++;
            this.movementsPanel = { open: false, input: '', loading: false, error: '', donor: null,
                replacePosition: '', donorPosition: '', starts: [], splitNote: '' };
        },

        /** The muted Release-card line while movements are borrowed. */
        get movementsLine() {
            return this.titleSource ? `Movements of ${this.titleSource.work} from ${this.titleSource.label}` : '';
        },

        /**
         * Works of the selected release that can be replaced: index tracks (folded, or unfolded into
         * their parts) and plain tracks, in release order.  `slots` are the positions the work occupies,
         * `start`/`count` its entries in release.tracks.
         */
        replaceableWorks(release = this.selectedRelease) {
            const works = [];
            (release?.tracks || []).forEach((track, index) => {
                if (track.parts?.length) {
                    works.push({ position: track.position, title: track.title, slots: track.parts.map(part => part.position),
                        folded: true, start: index, count: 1 });
                } else if (track.umbrella) {
                    const last = works[works.length - 1];
                    if (last && !last.folded && last.position === track.umbrella.position && last.title === track.umbrella.title) last.count++;
                    else works.push({ position: track.umbrella.position, title: track.umbrella.title,
                        slots: track.umbrella.parts.map(part => part.position), folded: false, start: index, count: 1 });
                } else {
                    works.push({ position: track.position, title: track.title, slots: [track.position], folded: true, start: index, count: 1 });
                }
            });
            return works;
        },

        get replaceOptions() {
            return this.replaceableWorks().map(work => ({ value: work.position, label: `${work.position} \u00b7 ${work.title}` }));
        },

        get donorMovementOptions() {
            const donor = this.movementsPanel.donor;
            if (!donor) return [];
            const umbrellas = donor.tracks.filter(track => track.parts?.length).map(track => ({
                value: track.position,
                label: `${track.title} \u00b7 ${track.parts.length} movement${track.parts.length === 1 ? '' : 's'}` }));
            return [...umbrellas, { value: MOVEMENTS_ALL_DONOR_TRACKS, label: `All tracks (${donor.tracks.length})` }];
        },

        /** The donor's chosen umbrella (or null for "All tracks"). */
        get donorUmbrella() {
            const panel = this.movementsPanel;
            if (!panel.donor || panel.donorPosition === MOVEMENTS_ALL_DONOR_TRACKS) return null;
            return panel.donor.tracks.find(track => track.parts?.length && track.position === panel.donorPosition) || null;
        },

        /** Movements on offer: the umbrella's parts, or the donor's top-level tracks. */
        get donorMovements() {
            const panel = this.movementsPanel;
            if (!panel.donor) return [];
            return this.donorUmbrella ? this.donorUmbrella.parts : panel.donor.tracks;
        },

        get replacedWork() {
            return this.replaceableWorks().find(work => work.position === this.movementsPanel.replacePosition) || null;
        },

        /** "Side B starts with" choices for boundary `boundary`: movement 2..n with its start time when known. */
        splitOptions(boundary) {
            const movements = this.donorMovements;
            let clock = 0, known = true;
            const options = [];
            movements.forEach((movement, index) => {
                if (index > 0) {
                    options.push({ value: index, label: `${index + 1} \u00b7 ${movement.title}` + (known ? ` (starts ${this.formatClock(clock)})` : '') });
                }
                const seconds = this.parseTrackDuration(movement.duration);
                if (seconds === null) known = false; else clock += seconds;
            });
            return options;
        },

        /** Sides the replaced work crosses, e.g. ['A', 'B']; the split editor shows when there are several. */
        get movementSides() {
            return this.replacedWork ? slotGroups(this.replacedWork.slots).map(group => group.side) : [];
        },

        /**
         * Validated result of the current panel choices: new positions, preview rows, and an error
         * (inline, no apply) when a side would get no movement or a new position is already taken.
         */
        get movementsPlan() {
            const panel = this.movementsPanel, work = this.replacedWork, movements = this.donorMovements;
            const none = { ok: false, error: '', rows: [], preview: [], positions: [], counts: [] };
            if (!panel.donor || !work || !movements.length) return none;
            const groups = slotGroups(work.slots);
            if (movements.length < groups.length) return { ...none, error: `${work.title} spans ${groups.length} sides and needs at least ${groups.length} movements.` };
            const bounds = [0, ...panel.starts.map(Number), movements.length];
            const counts = bounds.slice(1).map((bound, i) => bound - bounds[i]);
            if (counts.length !== groups.length || counts.some(count => count < 1)) {
                return { ...none, error: 'Each side needs at least one movement, in order.' };
            }
            const positions = borrowedPositions(work.slots, counts);
            const own = new Set([work.position, ...work.slots]);
            const taken = new Set([...this.releasePositions()].filter(position => !own.has(position)));
            const clash = positions.find(position => taken.has(position));
            if (clash) return { ...none, error: `${clash} is already used by another track on this release.` };
            const umbrella = this.donorUmbrella;
            const rows = movements.map((movement, i) => ({ position: positions[i], source: movement.position, title: movement.title, duration: movement.duration || '' }));
            const label = row => `${row.position} \u00b7 ${umbrella ? this.partDisplayTitle({ title: row.title, umbrella }) : row.title}`;
            const preview = rows.length <= 5 ? rows.map(label) : [...rows.slice(0, 3).map(label), '\u2026', label(rows[rows.length - 1])];
            return { ok: true, error: '', rows, preview, positions, counts };
        },

        /** Fetch the donor release by link/number and preselect the matching works. */
        async loadMovementsDonor() {
            const panel = this.movementsPanel;
            if (panel.loading || !this.selectedRelease) return;
            const ref = parseDiscogsRelease(panel.input);
            if (!ref) {
                panel.error = 'Paste a Discogs release link (discogs.com/release/\u2026) or type its number, e.g. 9326206.';
                return;
            }
            if (ref.master) {
                panel.error = `That is a master release (all versions of the album). Open it on Discogs, pick the exact pressing whose titles you want, and paste that release's link.`;
                return;
            }
            if (ref.id === this.selectedRelease.id) {
                panel.error = 'That is the release you already selected. Paste a different release to borrow its movements.';
                return;
            }
            panel.error = '';
            panel.loading = true;
            try {
                const response = await fetch(`/api/release/${ref.id}`);
                const data = await response.json().catch(() => ({}));
                if (this.movementsPanel !== panel) return;
                if (!response.ok || !Array.isArray(data.tracks)) {
                    panel.error = response.status === 404
                        ? `Discogs release ${ref.id} was not found (or Discogs is unavailable right now).`
                        : `Couldn't load release ${ref.id}: ${data.detail || 'unknown error'}`;
                    return;
                }
                if (!data.tracks.length) {
                    panel.error = `Release ${ref.id} has no tracklist on Discogs.`;
                    return;
                }
                panel.donor = data;
                this.preselectMovementWorks();
                await this.refreshMovementsSplit();
            } catch (error) {
                if (this.movementsPanel === panel) panel.error = `Couldn't reach the server to load release ${ref.id}.`;
            } finally {
                panel.loading = false;
            }
        },

        /** Best normalized-title pair of (work to replace, donor umbrella); else the first umbrella of each. */
        preselectMovementWorks() {
            const panel = this.movementsPanel;
            const works = this.replaceableWorks();
            const umbrellas = panel.donor.tracks.filter(track => track.parts?.length);
            let best = { score: 0, work: null, umbrella: null };
            for (const work of works) {
                for (const umbrella of umbrellas) {
                    const score = workTitleMatchScore(work.title, umbrella.title);
                    if (score > best.score) best = { score, work, umbrella };
                }
            }
            const work = best.work || works.find(entry => entry.slots.length > 1 || !entry.folded) || works[0];
            panel.replacePosition = work?.position || '';
            panel.donorPosition = (best.umbrella || umbrellas[0])?.position ?? MOVEMENTS_ALL_DONOR_TRACKS;
        },

        /** The Replace / With selects changed: keep the pairing sensible and recompute the split default. */
        async onMovementsChoiceChanged(changed) {
            const panel = this.movementsPanel;
            if (changed === 'replace' && panel.donor) {
                const work = this.replacedWork;
                const umbrella = panel.donor.tracks.filter(track => track.parts?.length)
                    .find(track => work && workTitleMatchScore(work.title, track.title) > 0);
                if (umbrella) panel.donorPosition = umbrella.position;
            }
            await this.refreshMovementsSplit();
        },

        /**
         * Default for the "Side B starts with" selects: measured from the recording when possible,
         * else proportional with a muted note.
         */
        async refreshMovementsSplit() {
            const panel = this.movementsPanel, work = this.replacedWork, movements = this.donorMovements;
            const sequence = ++this._movementsSeq;
            panel.splitNote = '';
            const groups = work ? slotGroups(work.slots) : [];
            if (groups.length < 2 || !movements.length) { panel.starts = []; return; }
            const durations = movements.map(movement => this.parseTrackDuration(movement.duration));
            const targets = durations.every(seconds => seconds !== null) ? await this.measureMovementTargets(work) : null;
            if (sequence !== this._movementsSeq || this.movementsPanel !== panel) return;
            const counts = defaultMovementSplit(durations, targets, groups.length);
            panel.starts = counts ? counts.slice(0, -1).map((count, i) => counts.slice(0, i + 1).reduce((sum, n) => sum + n, 0)) : [];
            if (!targets) {
                const sides = groups.slice(1).map(group => group.side);
                panel.splitNote = `Couldn't measure where side${sides.length > 1 ? 's' : ''} ${sides.join(', ')} start${sides.length > 1 ? '' : 's'} \u2014 check the split.`;
            }
        },

        /**
         * Cumulative music seconds at the end of each side of `work` but the last, from the recording's
         * side changes (GET /api/scan?side_changes=N): a side's length minus the other tracks on it, summed
         * over the work's sides so far.  null when anything needed is missing (count of side changes,
         * a side not selected, an unknown length).
         */
        async measureMovementTargets(work) {
            const groups = slotGroups(work.slots);
            const sideCount = this.selectedSides.length - 1;
            if (groups.length < 2 || sideCount < 1 || !this.currentFileId) return null;
            let scan;
            try {
                const response = await fetch(`/api/scan/${this.currentFileId}?side_changes=${sideCount}`);
                if (!response.ok) return null;
                scan = await response.json();
            } catch (error) {
                return null;
            }
            const changes = scan?.side_changes;
            if (!scan?.ready || !Array.isArray(changes) || changes.length !== sideCount ||
                !Number.isFinite(scan.music_start) || !Number.isFinite(scan.music_end)) return null;
            const sideLength = index => {
                const start = index === 0 ? scan.music_start : changes[index - 1]?.[1];
                const end = changes[index] ? changes[index][0] : scan.music_end;
                return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null;
            };
            const entrySeconds = track => {
                const own = this.parseTrackDuration(track.duration);
                if (own !== null || !track.parts?.length) return own;
                const parts = track.parts.map(part => this.parseTrackDuration(part.duration));
                return parts.every(seconds => seconds !== null) ? parts.reduce((sum, seconds) => sum + seconds, 0) : null;
            };
            const tracks = this.selectedRelease.tracks;
            const workSides = groups.map(group => group.side);
            if (new Set(workSides).size !== workSides.length) return null;
            let cumulative = 0;
            const targets = [];
            for (const group of groups.slice(0, -1)) {
                const sideIndex = this.selectedSides.indexOf(group.side);
                const length = sideIndex < 0 ? null : sideLength(sideIndex);
                if (length === null) return null;
                let others = 0;
                tracks.forEach((track, index) => {
                    if (index >= work.start && index < work.start + work.count) return;
                    if ((/^[A-Z]+/.exec(String(track.position).toUpperCase())?.[0] || '') !== group.side) return;
                    const seconds = entrySeconds(track);
                    others = seconds === null || others === null ? null : others + seconds;
                });
                if (others === null) return null;
                cumulative += length - others;
                targets.push(cumulative);
            }
            return targets;
        },

        /** Sum of movement lengths as Discogs text ("36:09"), or '' when any is unknown. */
        movementsTotalText(movements) {
            const seconds = movements.map(movement => this.parseTrackDuration(movement.duration));
            return seconds.length && seconds.every(value => value !== null)
                ? this.formatClock(seconds.reduce((sum, value) => sum + value, 0)) : '';
        },

        /**
         * Replace the chosen work by the donor's movements in one copy-on-write edit (the release object
         * may be shared with another recording), record `titleSource`, re-detect (or ask first after hand
         * edits, like Keep as one track) and offer Undo.
         */
        applyMovements() {
            const release = this.selectedRelease, panel = this.movementsPanel, work = this.replacedWork;
            if (!release || !panel.donor || !work || this.analyzing || this.currentLocked || this.titleSource) return;
            const plan = this.movementsPlan;
            if (!plan.ok) return;
            const before = { fileId: this.currentFileId, release, sides: [...this.selectedSides], titleSource: this.titleSource };
            const donor = panel.donor, donorUmbrella = this.donorUmbrella;
            const umbrella = donorUmbrella ? {
                position: plan.positions[0], title: donorUmbrella.title, duration: this.movementsTotalText(donorUmbrella.parts),
                parts: plan.rows.map(row => ({ position: row.position, title: row.title, duration: row.duration }))
            } : null;
            const newTracks = plan.rows.map(row => ({ position: row.position, title: row.title, duration: row.duration,
                ...(umbrella ? { umbrella } : {}) }));
            this.editReleaseCopy(edited => {
                edited.tracks.splice(work.start, work.count);
                for (const track of newTracks) {
                    // Sorted place, same rule as addCustomTrack: after the last track that sorts at or before it.
                    const key = this.positionKey(track.position);
                    let at = 0;
                    edited.tracks.forEach((existing, i) => {
                        if (this.comparePositionKeys(this.positionKey(existing.position), key) <= 0) at = i + 1;
                    });
                    edited.tracks.splice(at, 0, track);
                }
            });
            const workTitle = donorUmbrella ? donorUmbrella.title : work.title;
            this.titleSource = {
                release_id: donor.id, label: `${donor.artist} \u2013 ${donor.title}`, work: workTitle,
                replace_position: work.position,
                donor_position: donorUmbrella ? donorUmbrella.position : null,
                assignments: plan.rows.map(row => ({ position: row.position, source: row.source }))
            };
            const after = this.selectedRelease;
            this.closeMovementsPanel();
            this.afterIndexChange(after.id, false);
            this.notifyUndo(`Movements of \u201c${workTitle}\u201d from ${donor.id}.`, () => {
                if (this.selectedRelease !== after) {
                    this.refuseReleaseUndo();
                    return;
                }
                this.selectedRelease = before.release;
                this.titleSource = before.titleSource;
                this.selectedSides = before.sides;
                this.trackForm = null;
                this.afterIndexChange(before.release.id, false);
            }, { fileId: before.fileId, type: 'success' });
        },

        /**
         * Drop the selected release but keep search results and the current
         * detection/waveform so another release can be picked.
         */
        changeRelease() {
            // A running detection would install its tracks and markers on a release that is gone
            if (this.analyzing || this.currentLocked) return;
            this.selectedRelease = null;
            this._pendingPickId = null;   // a card still loading must not bring a release back
            this.releaseIdLoading = false;   // a pasted-link lookup in flight is dropped (its _releaseIdCall stays latest-only)
            this.titleSource = null;
            this.closeMovementsPanel();
            this.trackForm = null;
            this.resetDonors();
            this.selectedSides = [];
            this.sidesTouched = false;
            this.trackMappingReversed = false;
            this.trackCountMismatch = false;
            this.editBanner = false;
            this.snapUndo = null;
            this.snapNotice = '';
            this.clearExpectedMarkers();
            this.refreshRegionLabels();
        },

        /**
         * Reverse track mapping order
         */
        reverseMapping() {
            if (this.analyzing) return;   // a running detection's reply would reset the mapping
            this.trackMappingReversed = !this.trackMappingReversed;

            if (this.trackMappingReversed) {
                const targets = this.targetTracks;
                const numTracks = this.detectedTracks.length;
                this.customMapping = Array.from({ length: numTracks }, (_, i) => {
                    if (!targets.length) return numTracks - 1 - i;
                    const j = Math.min(Math.max(numTracks - 1 - i, 0), targets.length - 1);
                    return targets[j].releaseIdx;
                });
            } else {
                this.resetMappingToTargets();
            }
            this.refreshRegionLabels();
        },

        /**
         * Update custom mapping when user changes dropdown
         */
        updateCustomMapping() {
            this.trackMappingReversed = false;
            this.customMapping = this.customMapping.map(Number);
            this.refreshRegionLabels();
        },

        /**
         * Map detected track idx to release track dtIdx (dropdown handler)
         */
        setMapping(idx, value) {
            if (this.analyzing) return;
            const mapping = [...this.customMapping];
            mapping[idx] = Number(value);
            this.customMapping = mapping;
            this.trackMappingReversed = false;
            this.refreshRegionLabels();
        },

        /* ---- Custom tracks and renames ----
         * The user's own tracks and renamed titles live in selectedRelease.tracks (flagged `custom` /
         * `renamed`), so they persist with the workspace and ride along in the export request.
         * Every edit swaps in a modified deep copy: the release object may be shared with another
         * recording's workspace. Cuts and detection are never touched. */

        /** Sort key of a vinyl position: [side, number, sub-track]; mirrors position_sort_key in metadata_handler.py. */
        positionKey(position) {
            const m = /^([A-Z]+)(\d+)(?:[.\-](\d+))?/.exec(String(position || ''));
            return m ? [m[1], Number(m[2]), Number(m[3] || 0)] : [String(position || ''), 0, 0];
        },

        comparePositionKeys(a, b) {
            return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] - b[1]) || (a[2] - b[2]);
        },

        /** Every position the release uses, index-track parts included. */
        releasePositions(release = this.selectedRelease) {
            const used = new Set();
            for (const t of release?.tracks || []) {
                used.add(t.position);
                for (const part of t.parts || []) used.add(part.position);
            }
            return used;
        },

        /** Next free position on the side of the row above (else this row's own track): B5 after B4. */
        suggestCustomPosition(idx) {
            const anchor = this.mappedTrack(idx - 1) || this.mappedTrack(idx) || this.selectedRelease?.tracks?.[0];
            const m = /^([A-Z]+)(\d+)/.exec(anchor?.position || '');
            const side = m ? m[1] : 'A';
            const used = this.releasePositions();
            let next = (m ? Number(m[2]) : 0) + 1;
            while (used.has(`${side}${next}`)) next++;
            return `${side}${next}`;
        },

        /** Mapping dropdown handler: "Custom track..." opens the form, anything else maps the row. */
        onMappingSelect(idx, select) {
            if (select.value !== 'custom') return this.setMapping(idx, select.value);
            select.value = String(this.customMapping[idx]);
            this.openTrackForm(idx, 'add');
        },

        /** Open the inline form for row idx: 'add' a custom track, or 'edit' (rename / remove) the mapped one. */
        openTrackForm(idx, mode) {
            if (!this.selectedRelease || this.currentLocked || this.analyzing) return;
            if (this.trackForm && this.trackForm.idx === idx && this.trackForm.mode === mode &&
                this.trackForm.fileId === this.currentFileId) { this.trackForm = null; return; }
            const mapped = this.mappedTrack(idx);
            if (mode === 'edit' && !mapped) return;
            // Rows (their detected-track numbers) that also use the entry being edited. A renamed title
            // would show on all of them, so a shared entry saves a new custom track for this row instead.
            const sharedWith = mode === 'edit' ? this.otherRowsOnTrack(idx) : [];
            this.trackForm = {
                fileId: this.currentFileId, idx, mode, error: '', sharedWith,
                originalPosition: mode === 'edit' ? mapped.position : '',
                position: mode === 'add' || sharedWith.length ? this.suggestCustomPosition(idx) : mapped.position,
                title: mode === 'add' ? '' : mapped.title
            };
        },

        /** Numbers of the other, non-ignored detected tracks mapped to the same release entry as row idx. */
        otherRowsOnTrack(idx) {
            const releaseIdx = Number(this.customMapping[idx]);
            const numbers = [];
            this.customMapping.forEach((m, i) => {
                if (i !== idx && Number(m) === releaseIdx && !this.detectedTracks[i]?.ignored) {
                    numbers.push(this.detectedTracks[i].number);
                }
            });
            return numbers;
        },

        /** The edit form's position field is only editable for a custom track or a new track for a shared row. */
        trackFormPositionLocked() {
            const form = this.trackForm;
            if (!form || form.mode === 'add' || form.sharedWith?.length) return false;
            return !this.mappedTrack(form.idx)?.custom;
        },

        /** Note under the edit form explaining a shared track. */
        sharedTrackNote() {
            const numbers = this.trackForm?.sharedWith || [];
            if (!numbers.length) return '';
            return `Also used by ${numbers.length === 1 ? 'track' : 'tracks'} ${numbers.join(', ')}. Save adds a new track for this row only.`;
        },

        closeTrackForm() { this.trackForm = null; },

        /** True when the form belongs to row idx of the file in the editor. */
        trackFormShown(idx) {
            return !!this.trackForm && this.trackForm.idx === idx && this.trackForm.fileId === this.currentFileId;
        },

        /** Form Add / Save button. */
        submitTrackForm() {
            const form = this.trackForm;
            if (!form) return;
            const releaseIdx = Number(this.customMapping[form.idx]);
            const normalizedPosition = String(form.position || '').trim().toUpperCase();
            let error;
            if (form.mode === 'add' || form.sharedWith?.length) {
                error = this.addCustomTrack(form.idx, form.position, form.title);
            } else if (this.mappedTrack(form.idx)?.custom && normalizedPosition !== form.originalPosition) {
                error = this.editCustomTrack(releaseIdx, form.position, form.title);
            } else {
                error = this.renameTrack(releaseIdx, form.title);
            }
            form.error = error;
            if (!error) this.trackForm = null;
        },

        /** "Rename all N" on a shared track: retitle the shared entry, as before. */
        renameAllSharedTracks() {
            const form = this.trackForm;
            if (!form) return;
            const error = this.renameTrack(Number(this.customMapping[form.idx]), form.title);
            form.error = error;
            if (!error) this.trackForm = null;
        },

        /** Reset the mapped track's title to the Discogs one (edit form). */
        resetTrackTitle() {
            const form = this.trackForm;
            if (!form) return;
            const error = this.resetRenamedTrack(Number(this.customMapping[form.idx]));
            form.error = error;
            if (!error) this.trackForm = null;
        },

        /** Remove the custom track mapped to the form's row (edit form). */
        removeFormTrack() {
            const form = this.trackForm;
            if (!form) return;
            const error = this.removeCustomTrack(Number(this.customMapping[form.idx]), form.idx);
            form.error = error;
            if (!error) this.trackForm = null;
        },

        /** Swap in a modified deep copy of the release (never mutate the possibly shared object). */
        editReleaseCopy(change) {
            const edited = JSON.parse(JSON.stringify(this.selectedRelease));
            change(edited);
            this.selectedRelease = edited;
            this.resetDonors();   // borrowed-length donors are keyed by track index
            this.saveWorkspace();
        },

        /** Undo toast for a release edit: puts back the previous release and mapping if nothing replaced the edit since. */
        offerTrackUndo(message, before, after) {
            this.notifyUndo(message, () => {
                if (this.selectedRelease !== after) {
                    this.refuseReleaseUndo();
                    return;
                }
                this.selectedRelease = before.release;
                this.customMapping = before.mapping;
                this.selectedSides = before.sides;
                this.trackForm = null;
                this.resetDonors();
                this.afterReleaseEdit();
            }, { fileId: before.fileId, type: 'success' });
        },

        /**
         * A release Undo found the release replaced.  (Another recording being open never gets here:
         * notifyUndo's undoBlockedReason refuses that first.)
         */
        refuseReleaseUndo() {
            this.notify(RELEASE_CHANGED_NOTICE, { type: 'warning', timeout: 6000 });
        },

        /** Targets changed shape without re-detecting: refresh the count flag and labels. */
        afterReleaseEdit() {
            this.trackCountMismatch = !!this.selectedRelease && this.activeTrackCount !== this.targetTracks.length;
            this.refreshRegionLabels();
            this.saveWorkspace();
        },

        /** Returns an error message, or '' when row idx now maps to the new custom track. */
        addCustomTrack(idx, positionText, titleText) {
            if (!this.selectedRelease || this.currentLocked || this.analyzing) return 'Not available right now.';
            const position = String(positionText || '').trim().toUpperCase();
            const title = String(titleText || '').trim();
            if (!CUSTOM_POSITION_RE.test(position)) return 'Position needs a side letter and a number, like B5.';
            if (this.releasePositions().has(position)) return `${position} is already on this release.`;
            if (!title) return 'Enter a title.';
            if (title.length > CUSTOM_TITLE_MAX) return `Keep the title under ${CUSTOM_TITLE_MAX} characters.`;

            const before = { fileId: this.currentFileId, release: this.selectedRelease,
                mapping: [...this.customMapping], sides: [...this.selectedSides] };
            const key = this.positionKey(position);
            let at = 0;
            this.selectedRelease.tracks.forEach((t, i) => {
                if (this.comparePositionKeys(this.positionKey(t.position), key) <= 0) at = i + 1;
            });
            this.editReleaseCopy(release => release.tracks.splice(at, 0, { position, title, duration: '', custom: true }));
            const mapping = this.customMapping.map(m => (Number(m) >= at ? Number(m) + 1 : Number(m)));
            mapping[idx] = at;
            this.customMapping = mapping;
            this.trackMappingReversed = false;
            if (!this.selectedSides.includes(key[0]) && this.sideChips.some(g => g.side === key[0])) {
                this.selectedSides = [...this.selectedSides, key[0]];
            }
            this.afterReleaseEdit();
            this.offerTrackUndo(`Added ${position} \u00b7 ${title}.`, before, this.selectedRelease);
            return '';
        },

        /** Give release track releaseIdx a new title (or reset it when it equals the Discogs one). */
        renameTrack(releaseIdx, titleText) {
            const track = this.selectedRelease?.tracks?.[releaseIdx];
            if (!track || this.currentLocked || this.analyzing) return 'Not available right now.';
            const title = String(titleText || '').trim();
            if (!title) return 'Enter a title.';
            if (title.length > CUSTOM_TITLE_MAX) return `Keep the title under ${CUSTOM_TITLE_MAX} characters.`;
            if (title === track.title) return '';
            const before = { fileId: this.currentFileId, release: this.selectedRelease,
                mapping: [...this.customMapping], sides: [...this.selectedSides] };
            this.editReleaseCopy(release => {
                const entry = release.tracks[releaseIdx];
                if (!entry.custom) {
                    entry.originalTitle = entry.originalTitle ?? entry.title;
                    if (title !== entry.originalTitle) entry.renamed = true;
                    else { delete entry.renamed; delete entry.originalTitle; }
                }
                entry.title = title;
            });
            this.refreshRegionLabels();
            this.offerTrackUndo(`Renamed ${track.position} to \u201c${title}\u201d.`, before, this.selectedRelease);
            return '';
        },

        /**
         * Give a custom track a new position and title in one edit: it moves to its sorted place, every row
         * keeps pointing at the same track, sides follow. Returns an error message, or ''.
         */
        editCustomTrack(releaseIdx, positionText, titleText) {
            const tracks = this.selectedRelease?.tracks || [];
            const track = tracks[releaseIdx];
            if (!track?.custom || this.currentLocked || this.analyzing) return 'Not available right now.';
            const position = String(positionText || '').trim().toUpperCase();
            const title = String(titleText || '').trim();
            if (!CUSTOM_POSITION_RE.test(position)) return 'Position needs a side letter and a number, like B5.';
            const takenByOthers = this.releasePositions();
            takenByOthers.delete(track.position);
            if (takenByOthers.has(position)) return `${position} is already on this release.`;
            if (!title) return 'Enter a title.';
            if (title.length > CUSTOM_TITLE_MAX) return `Keep the title under ${CUSTOM_TITLE_MAX} characters.`;

            const before = { fileId: this.currentFileId, release: this.selectedRelease,
                mapping: [...this.customMapping], sides: [...this.selectedSides] };
            const key = this.positionKey(position);
            // order[newIndex] = oldIndex: the other entries keep their order, this one goes to its sorted place.
            const order = tracks.map((_, i) => i).filter(i => i !== releaseIdx);
            let at = 0;
            order.forEach((oldIdx, n) => {
                if (this.comparePositionKeys(this.positionKey(tracks[oldIdx].position), key) <= 0) at = n + 1;
            });
            order.splice(at, 0, releaseIdx);
            this.editReleaseCopy(release => {
                const entry = release.tracks[releaseIdx];
                entry.position = position;
                entry.title = title;
                release.tracks = order.map(oldIdx => release.tracks[oldIdx]);
            });
            this.customMapping = this.customMapping.map(m => order.indexOf(Number(m)));
            const sides = this.sideChips.map(g => g.side);
            const kept = this.selectedSides.filter(side => sides.includes(side));
            if (!kept.includes(key[0]) && sides.includes(key[0])) kept.push(key[0]);
            this.selectedSides = kept.length ? kept : sides;
            this.afterReleaseEdit();
            this.offerTrackUndo(`Moved ${track.position} to ${position} \u00b7 ${title}.`, before, this.selectedRelease);
            return '';
        },

        /** Put a renamed Discogs track's title back. */
        resetRenamedTrack(releaseIdx) {
            const track = this.selectedRelease?.tracks?.[releaseIdx];
            if (!track?.renamed || this.currentLocked || this.analyzing) return 'Not available right now.';
            const before = { fileId: this.currentFileId, release: this.selectedRelease,
                mapping: [...this.customMapping], sides: [...this.selectedSides] };
            this.editReleaseCopy(release => {
                const entry = release.tracks[releaseIdx];
                entry.title = entry.originalTitle;
                delete entry.originalTitle;
                delete entry.renamed;
            });
            this.refreshRegionLabels();
            this.offerTrackUndo(`${track.position} is back to \u201c${track.originalTitle}\u201d.`, before, this.selectedRelease);
            return '';
        },

        /** Remove a custom track no other row maps to; row idx falls back to the track before it. */
        removeCustomTrack(releaseIdx, idx) {
            const track = this.selectedRelease?.tracks?.[releaseIdx];
            if (!track?.custom || this.currentLocked || this.analyzing) return 'Not available right now.';
            const others = this.customMapping.some((m, i) => i !== idx && Number(m) === releaseIdx &&
                !this.detectedTracks[i]?.ignored);
            if (others) return `Another track is mapped to ${track.position}. Map it elsewhere first.`;
            const before = { fileId: this.currentFileId, release: this.selectedRelease,
                mapping: [...this.customMapping], sides: [...this.selectedSides] };
            this.editReleaseCopy(release => release.tracks.splice(releaseIdx, 1));
            this.customMapping = this.customMapping.map(m =>
                Number(m) === releaseIdx ? Math.max(releaseIdx - 1, 0) : Number(m) > releaseIdx ? Number(m) - 1 : Number(m));
            const sides = this.sideChips.map(g => g.side);
            const kept = this.selectedSides.filter(side => sides.includes(side));
            this.selectedSides = kept.length ? kept : sides;
            this.afterReleaseEdit();
            this.offerTrackUndo(`Removed ${track.position} \u00b7 ${track.title}.`, before, this.selectedRelease);
            return '';
        },

        /** What the export needs to rebuild the custom and renamed entries: [{position, title}], one per position. */
        customTracksPayload(release) {
            const seen = new Set();
            const out = [];
            for (const t of release?.tracks || []) {
                if ((t.custom || t.renamed) && !seen.has(t.position)) {
                    seen.add(t.position);
                    out.push({ position: t.position, title: t.title });
                }
            }
            return out;
        },

        /**
         * Title as it will be exported: a split index-track part (it has `umbrella`) reads
         * "Work: Part" while prefixPartTitles is on.  Mirrors MetadataHandler._part_title
         * (a part already starting with the work title, case-insensitively, is kept as is;
         * empty titles fall back to the other one).  Display only: edit forms and
         * customTracksPayload use the bare `title`.
         */
        partDisplayTitle(track) {
            const partTitle = String(track?.title ?? '');
            const workTitle = String(track?.umbrella?.title ?? '');
            if (!track?.umbrella || !this.prefixPartTitles) return partTitle;
            if (!workTitle || partTitle.toLowerCase().startsWith(workTitle.toLowerCase())) return partTitle || workTitle;
            return partTitle ? `${workTitle}: ${partTitle}` : workTitle;
        },

        /** Label for the mapping dropdown: "B5 · Title", marked when custom or renamed. */
        trackOptionLabel(dt) {
            return `${dt.position} \u00b7 ${this.partDisplayTitle(dt)}${dt.custom ? ' \u00b7 custom' : dt.renamed ? ' \u00b7 renamed' : ''}`;
        },

        /**
         * Release track mapped to detected track idx (or null)
         */
        mappedTrack(idx) {
            if (!this.selectedRelease || !(idx >= 0)) return null;
            const m = Number(this.customMapping[idx]);
            if (!Number.isInteger(m)) return null;
            return this.selectedRelease.tracks?.[m] || null;
        },

        /**
         * Discogs length (seconds) of the track mapped to idx, or null
         */
        discogsLength(idx) {
            const dt = this.mappedTrack(idx);
            return dt ? this.parseTrackDuration(dt.duration) : null;
        },

        /**
         * Detected minus Discogs length in seconds, or null when unknown
         */
        trackDelta(track, idx) {
            const d = this.discogsLength(idx);
            if (d === null || d === undefined || !Number.isFinite(track.duration)) return null;
            return track.duration - d;
        },

        deltaBucket(delta) {
            if (delta === null || delta === undefined) return 'none';
            const a = Math.abs(delta);
            return a <= 3 ? 'good' : a <= 10 ? 'warn' : 'bad';
        },

        deltaColor(delta) {
            return { good: '#10B981', warn: '#D98E00', bad: '#D94032', none: '#8A8A86' }[this.deltaBucket(delta)];
        },

        deltaText(delta) {
            if (delta === null || delta === undefined) return '—';
            const r = Math.round(Math.abs(delta));
            return `${delta < 0 ? '−' : '+'}${r}s`;
        },

        /**
         * Swatch colour for a table row: identical to its region colour
         */
        trackSwatchColor(track, idx) {
            return track.ignored ? IGNORED_TRACK_COLOR : this.getTrackColor(idx);
        },

        /** End of the recording in seconds (Infinity while it is not known yet) */
        recordingEnd() {
            return this.playDuration || this.currentFile?.duration || Infinity;
        },

        /**
         * Why a typed Start/End/Length would break the track table, or '' when it is fine.
         * Typing is held to a stricter rule than dragging (which clamps): a typo such as End "5"
         * on a track starting at 10 must be refused, not turned into a 1 s track, and an edit
         * must not squeeze a neighbour (ignored or not: it keeps its cut points) below
         * MIN_TRACK_LENGTH.  A neighbour only counts when the edit shrinks it.  start/end are
         * already capped at the recording's end.
         */
        typedBoundsProblem(idx, start, end, which = 'end') {
            const track = this.detectedTracks[idx];
            const previous = this.detectedTracks[idx - 1];
            const next = this.detectedTracks[idx + 1];
            if (end <= start) {
                return which === 'start'
                    ? `Track ${track.number}: the start must be before its end.`
                    : `Track ${track.number}: the end must be after its start.`;
            }
            if (end - start < MIN_TRACK_LENGTH - 1e-6) {
                return `Track ${track.number} must last at least ${MIN_TRACK_LENGTH} s.`;
            }
            if (next && end > next.start && next.end - end < MIN_TRACK_LENGTH - 1e-6) {
                return `That would leave track ${next.number} shorter than ${MIN_TRACK_LENGTH} s.`;
            }
            if (previous && start < previous.end && start - previous.start < MIN_TRACK_LENGTH - 1e-6) {
                return `That would leave track ${previous.number} shorter than ${MIN_TRACK_LENGTH} s.`;
            }
            return '';
        },

        /**
         * Typed Start/End (inline Adjust): apply, or refuse with a warning.  The field always ends up
         * showing the stored value, so text that was not applied (or was capped) never stays on screen.
         */
        applyTypedBounds(idx, which, value, input) {
            const track = this.detectedTracks[idx];
            if (!track) return false;
            if (this.currentLocked) {   // the fields are disabled too, but a stale event must not edit a locked recording
                if (input) input.value = track[which];
                return false;
            }
            const typed = parseFloat(value);
            let changed = false;
            if (!isNaN(typed) && typed >= 0) {
                const start = which === 'start' ? typed : track.start;
                const end = which === 'end' ? typed : track.end;   // applyTrackBounds caps it at the recording's end
                const problem = this.typedBoundsProblem(idx, start, end, which);
                if (problem) {
                    this.notify(problem, { type: 'warning', timeout: 5000 });
                } else {
                    changed = this.applyTrackBounds(idx, start, end);
                    this.syncRegionsAround(idx);
                }
            }
            if (input) input.value = track[which];
            return changed;
        },

        /** Update track start time (inline Adjust) */
        updateTrackStart(idx, value, input = null) {
            return this.applyTypedBounds(idx, 'start', value, input);
        },

        /** Update track end time (inline Adjust) */
        updateTrackEnd(idx, value, input = null) {
            return this.applyTypedBounds(idx, 'end', value, input);
        },

        /** "3:45", "3:45.5", "1:02:03" or plain seconds -> seconds; null if unreadable. */
        parseLengthInput(text) {
            const trimmed = String(text ?? '').trim();
            if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
            const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
            if (!match) return null;
            const [, hours, minutes, seconds] = match;
            // With hours, minutes and seconds must be below 60; "3:75" is not a length
            if (parseFloat(seconds) >= 60 || (hours && parseInt(minutes, 10) >= 60)) return null;
            return (hours ? parseInt(hours, 10) * 3600 : 0) + parseInt(minutes, 10) * 60 + parseFloat(seconds);
        },

        /**
         * Typed length (e.g. from a streaming service): keep the start, end = start + length.
         * A next track that began exactly at the old end follows the cut (applyTrackBounds), so
         * nothing falls between them.  A length that would collapse the track or squeeze a neighbour
         * under MIN_TRACK_LENGTH is refused (typedBoundsProblem); one past the recording's end is
         * capped there, and the notice says so.  A plain "3.45" is refused too: it reads as 3.45 s
         * but is usually meant as 3:45.
         */
        setTrackLength(idx, text, input = null) {
            const track = this.detectedTracks[idx];
            if (!track) return false;
            if (this.currentLocked) {   // the field is disabled too, but a stale event must not edit a locked recording
                if (input) input.value = this.formatDuration(track.duration);
                return false;
            }
            const showLength = () => { if (input) input.value = this.formatDuration(track.duration); };
            const typedText = String(text ?? '').trim();
            if (MINUTES_DOT_SECONDS_PATTERN.test(typedText)) {
                const [minutes, seconds] = typedText.split('.');
                showLength();
                if (Number(seconds) < SECONDS_PER_MINUTE) {
                    const suggestion = `${parseInt(minutes, 10)}:${seconds}`;
                    // The toast outlives the click: by then rows may have been deleted or the recording
                    // switched or locked, so the action finds its track again and re-checks the file
                    const fileId = this.currentFileId;
                    const durationAtToast = track.duration;
                    this.notify(`Type ${suggestion} for minutes and seconds.`, {
                        type: 'warning',
                        timeout: 8000,
                        action: {
                            label: `Use ${suggestion}`,
                            fn: () => {
                                if (this.currentFileId !== fileId || this.currentLocked) return;
                                if (Math.abs(track.duration - durationAtToast) > 1e-6) return;   // retyped since
                                const currentIdx = this.detectedTracks.indexOf(track);
                                if (currentIdx >= 0) this.setTrackLength(currentIdx, suggestion, null);
                            },
                        },
                    });
                } else {
                    // "3.75" cannot be m:ss either: refuse without offering a "3:75" that would fail
                    this.notify('Type a length like 3:45 (minutes:seconds).', { type: 'warning', timeout: 4000 });
                }
                return false;
            }
            const length = this.parseLengthInput(text);
            if (!(length >= MIN_TRACK_LENGTH)) {
                showLength();
                this.notify('Type a length like 3:45 (minutes:seconds).', { type: 'warning', timeout: 4000 });
                return false;
            }
            const newEnd = Math.min(track.start + length, this.recordingEnd());   // never past the recording
            const problem = this.typedBoundsProblem(idx, track.start, newEnd);
            if (problem) {
                showLength();
                this.notify(problem, { type: 'warning', timeout: 5000 });
                return false;
            }
            const changed = this.applyTrackBounds(idx, track.start, newEnd);
            if (changed) this.syncRegionsAround(idx);
            showLength();
            if (newEnd - track.start < length - 0.05) {
                this.notify(`Track ${track.number} can only be ${this.formatDuration(track.duration)} here (the end of the recording is in the way).`, { type: 'info', timeout: 5000 });
            }
            return changed;
        },

        /**
         * Move track idx to [start, end].  Cuts that touch (guided detection makes them contiguous)
         * move together: a next track that started at the old end follows the new end, a previous
         * track that ended at the old start follows the new start, so no stretch of audio is left
         * in no file.  A real gap stays a gap (a leftward end move makes it bigger); neighbours are
         * otherwise only pushed when the regions would overlap.  Every track keeps at least
         * MIN_TRACK_LENGTH (a neighbour that is already shorter stops the edit at its cut), a
         * whole-region move keeps its length and shifts at the recording's end or a neighbour, and
         * an edit that cannot fit is refused.  Returns true when anything changed (and then marks
         * the boundaries hand-edited).
         */
        applyTrackBounds(idx, start, end) {
            const tracks = this.detectedTracks;
            const track = tracks[idx];
            if (!track || !Number.isFinite(start) || !Number.isFinite(end)) return false;
            const prev = tracks[idx - 1];
            const next = tracks[idx + 1];
            const EPS = 1e-6;
            const MIN = MIN_TRACK_LENGTH;

            const startMoved = Math.abs(start - track.start) > EPS;
            const endMoved = Math.abs(end - track.end) > EPS;
            if (!startMoved && !endMoved) return false;

            // Neighbours that share a cut with this track, judged before anything moves
            const nextFollows = !!next && Math.abs(next.start - track.end) < TOUCHING_CUTS_S;
            const prevFollows = !!prev && Math.abs(prev.end - track.start) < TOUCHING_CUTS_S;

            // Never past the end of the recording (typed Start/End, Length and region updates all land here).
            // Where a neighbour is already shorter than MIN the edit stops at its cut (a neighbour
            // that short is left alone, not used to jump the edit backwards).
            const limit = this.recordingEnd();
            const endBound = next ? Math.max(next.start, next.end - MIN) : Infinity;
            const startBound = prev ? Math.min(prev.end, prev.start + MIN) : 0;
            const requestedStart = start;
            const requestedEnd = end;
            if (startMoved && endMoved) {
                // Whole-region drag: keep the length, stop at the recording's end and the neighbours
                const len = end - start;
                if (end > limit) { start -= end - limit; end = limit; }
                if (end > endBound) { end = endBound; start = end - len; }
                if (start < startBound) { start = startBound; end = start + len; }
                if (start < 0) { end -= start; start = 0; }
            } else if (endMoved) {
                const lastEnd = Math.min(limit, endBound);
                end = Math.min(end, lastEnd);
                end = Math.max(end, start + MIN);
                // The MIN floor must fit before the recording's end and the next cut, and a track that
                // was already too short must not move against the drag to reach it
                if (end > lastEnd + EPS || ((requestedEnd < track.end) !== (end < track.end) && end !== track.end)) return false;
            } else {
                start = Math.max(start, startBound);
                start = Math.min(start, end - MIN);
                if (start < startBound - EPS || ((requestedStart > track.start) !== (start > track.start) && start !== track.start)) return false;
            }

            const valid = end - start >= MIN - EPS &&
                (!next || end <= next.start || next.end - end >= MIN - EPS) &&
                (!prev || start >= prev.end || start - prev.start >= MIN - EPS);
            if (!valid) return false;

            const endChanged = Math.abs(end - track.end) > EPS;
            const startChanged = Math.abs(start - track.start) > EPS;
            if (!endChanged && !startChanged) return false;

            track.start = start;
            track.end = end;
            track.duration = end - start;
            if (next && ((nextFollows && endChanged) || end > next.start)) {
                next.start = end;
                next.duration = next.end - next.start;
            }
            if (prev && ((prevFollows && startChanged) || start < prev.end)) {
                prev.end = start;
                prev.duration = prev.end - prev.start;
            }
            this.markEdited();
            return true;
        },

        /**
         * Push track values onto the matching waveform region
         */
        syncRegion(track) {
            if (!track || !this.waveformRegions) return;
            const region = this.waveformRegions.getRegions().find(r => r.id === `track-${track.number}`);
            if (region && (Math.abs(region.start - track.start) > 1e-6 || Math.abs(region.end - track.end) > 1e-6)) {
                region.setOptions({ start: track.start, end: track.end });
            }
        },

        syncRegionsAround(idx) {
            [idx - 1, idx, idx + 1].forEach(i => this.syncRegion(this.detectedTracks[i]));
        },

        /**
         * Initialize waveform visualization
         */
        async initWaveform() {
            if (!this.currentFileId || this.waveform) return;

            this.waveformLoading = true;
            const fileId = this.currentFileId;
            this.clearFallback();
            // The waveform this build created.  Every await below can outlive the build (file switch,
            // re-analysis, a newer build of the same file), and a stale one must touch nothing.
            let built = null;
            const isCurrentBuild = () => this.waveform === built && this.currentFileId === fileId;

            try {
                if (typeof WaveSurfer === 'undefined') {
                    throw new Error('WaveSurfer library not loaded. Please refresh the page.');
                }

                if (typeof WaveSurfer.Regions === 'undefined') {
                    throw new Error('WaveSurfer Regions plugin not loaded. Please refresh the page.');
                }

                if (this.waveform) {
                    this.waveform.destroy();
                }

                // After a failed build the container was hidden (the fallback player replaced it); WaveSurfer
                // measures it when it is created, so wait for it to be shown again
                const waveformContainer = typeof document !== 'undefined' ? document.getElementById?.('waveform') : null;
                if (waveformContainer && waveformContainer.offsetParent === null && this.$nextTick) {
                    await this.$nextTick();
                    if (this.currentFileId !== fileId || this.waveform) return;   // switched away, or a newer build
                }

                // Default MediaElement backend: renders instantly from the
                // precomputed peaks and streams audio on demand, instead of
                // WebAudio which downloads + decodes the whole file up front.
                //
                // height:'auto' fills the #waveform container, which MUST
                // have a fixed CSS height (see index.html) — a min-height
                // floor lets the canvas/container feedback loop grow the
                // waveform forever on fractional-DPI Windows displays (#63).
                this.waveform = markRaw(WaveSurfer.create({
                    container: '#waveform',
                    waveColor: '#93c5fd',
                    progressColor: '#1d4ed8',   // darker than waveColor: the played part is visible
                    cursorColor: '#1e40af',
                    height: 'auto',
                    normalize: false,   // peaks arrive pre-scaled (scalePeaksToRecording)
                    barWidth: 2,
                    barGap: 1,
                    hideScrollbar: true   // our own always-visible scrollbar sits under the waveform
                }));

                const waveform = this.waveform;
                built = waveform;
                let uiBound = false;

                // With MediaElement + provided peaks, load() resolves without
                // fetching the audio — a later fetch failure only surfaces as
                // an 'error' event, which must clear the loading spinner.
                // WaveSurfer re-emits EVERY media error here as emit('error', undefined) (network and
                // aborted ones too), and so does a throw inside its load/ready path: only the media
                // element's own code (still set at this point) says the WAV cannot be played.
                this.waveform.on('error', (err) => {
                    console.error('Waveform error:', err);
                    if (waveform !== this.waveform) return;
                    const code = waveform.getMediaElement?.()?.error?.code;
                    // A fallback in flight absorbs the twin of its own failure, whatever the code now says
                    if ((code === 3 || code === 4 || this.fallbackInFlight(waveform)) && this.fallBackToPreview(waveform, fileId)) return;
                    this.waveformLoading = false;
                    const message = (err && err.message) || err || MEDIA_ERROR_MESSAGES[code] || 'unknown';
                    // On the preview already: the server may be why (source gone, preview not ready)
                    if (this._audioSource?.waveform === waveform && !this._audioSource.precise) this.explainPreviewFailure(waveform, fileId, message);
                    else this.showPlayerNotice('Audio playback error: ' + message);
                });

                // Transport state follows the real player events
                this.waveform.on('play', () => { this.isPlaying = true; this.abPause(); });
                this.waveform.on('pause', () => { this.isPlaying = false; this.cancelAudition(); });
                this.waveform.on('finish', () => { this.isPlaying = false; this.cancelAudition(); });
                this.waveform.on('timeupdate', (t) => this.onPlayerTime(t));
                // Keep the click density strip in step with zoom / resize / first render
                for (const ev of ['zoom', 'redraw', 'ready']) {
                    this.waveform.on(ev, () => this.refreshClickStrip());
                }
                // User clicked/dragged on the waveform itself: abandon any audition
                this.waveform.on('interaction', (time) => {
                    this.cancelAudition();
                    this.seekTo(time);
                });
                const media = this.waveform.getMediaElement();
                media.volume = this.playerVolume;
                media.preload = 'metadata';   // stream on demand; 'auto' would buffer hundreds of MB of the original WAV on every rebuild
                const mediaListeners = {
                    // A failed load never finishes buffering; DECODE (3) / SRC_NOT_SUPPORTED (4) on the
                    // original WAV: retry once with the MP3 preview
                    error: () => {
                        this.playerBuffering = false;
                        const code = media.error?.code;
                        if (code === 3 || code === 4) this.fallBackToPreview(waveform, fileId);
                    },
                    loadedmetadata: () => this.applyPendingSeek(),
                    seeking: () => { this.playerBuffering = true; },
                    waiting: () => { this.playerBuffering = true; },
                    seeked: () => { this.playerBuffering = false; },
                    playing: () => { this.playerBuffering = false; },
                    pause: () => { this.playerBuffering = false; },
                    ended: () => { this.playerBuffering = false; }
                };
                for (const [event, listener] of Object.entries(mediaListeners)) media.addEventListener(event, listener);
                waveform.on('destroy', () => {
                    for (const [event, listener] of Object.entries(mediaListeners)) media.removeEventListener(event, listener);
                });

                this.waveformRegions = markRaw(this.waveform.registerPlugin(WaveSurfer.Regions.create()));
                this.tameRegionDragScroll(waveform, this.waveformRegions);
                this.guardRegionDragRelease(this.waveformRegions);
                this.bindWaveScrollbar(waveform);

                const peaksResponse = await fetch(`/api/waveform-peaks/${fileId}`);
                if (!isCurrentBuild()) return;
                if (!peaksResponse.ok) {
                    // e.g. 409/410: an imported file changed or vanished; say which and what to do
                    const data = await peaksResponse.json().catch(() => ({}));
                    const failure = new Error(data.detail || 'Failed to load waveform peaks');
                    failure.status = peaksResponse.status;
                    throw failure;
                }
                const peaksData = await peaksResponse.json();
                if (!isCurrentBuild()) return;

                this.waveform.on('ready', () => {
                    console.log('Waveform ready');

                    // 'ready' fires again after a preview-fallback reload: bind DOM listeners only once.
                    const firstReady = !uiBound;
                    uiBound = true;
                    const duration = this.waveform.getDuration();
                    this.playDuration = duration;
                    if (this.playTime > 0) this.seekTo(this.playTime);
                    const wrapper = this.waveform.getWrapper();
                    if (firstReady) wrapper.addEventListener('pointermove', event => {
                        const handle = event.target.closest?.('[part~="region-handle"]');
                        if (handle) handle.style.cursor = this.regionCursorAt(event.clientX);
                    });
                    const container = document.getElementById('waveform');
                    const containerWidth = container ? container.offsetWidth : 1000;

                    const calculatedZoom = containerWidth / duration;
                    this.currentZoom = this._restoreZoom || Math.max(1, Math.min(calculatedZoom, 200));
                    this._restoreZoom = null;
                    this.waveform.zoom(this.currentZoom);

                    const openWaveformContextMenu = (e) => {
                        const isSecondaryClick = e.type === 'contextmenu' || e.button === 2 || (e.button === 0 && e.ctrlKey);
                        if (!isSecondaryClick) {
                            return;
                        }

                        e.preventDefault();

                        const wrapper = this.waveform.getWrapper();
                        const rect = wrapper.getBoundingClientRect();
                        const relativeX = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
                        const time = relativeX * this.waveform.getDuration();

                        this.contextMenu.x = e.clientX;
                        this.contextMenu.y = e.clientY;
                        this.contextMenu.time = time;
                        this.contextMenu.show = true;
                    };

                    // Add right-click handler for manual splits
                    if (firstReady) {
                        container.addEventListener('contextmenu', openWaveformContextMenu);
                        container.addEventListener('mousedown', openWaveformContextMenu);
                    }

                    setTimeout(() => {
                        // A re-detect or Undo within these 100 ms replaced this waveform
                        if (!isCurrentBuild()) return;
                        this.addTrackRegions();
                        this.waveformLoading = false;
                    }, 100);
                });

                // Regions swallow clicks, so seek from here (plain primary click only)
                this.waveformRegions.on('region-clicked', (region, e) => this.onRegionClicked(region, e));

                this.waveformRegions.on('region-updated', (region) => {
                    this.updateTrackFromRegion(region);
                });

                // Add right-click handler for region actions
                this.waveformRegions.on('region-created', (region) => {
                    const regionElement = region.element;
                    if (regionElement) {
                        // Set the actual v7 shadow-DOM handles, including directional native cursors.
                        const startHandle = regionElement.querySelector('[part~="region-handle-left"]');
                        const endHandle = regionElement.querySelector('[part~="region-handle-right"]');
                        if (startHandle) startHandle.style.cursor = 'e-resize';
                        if (endHandle) endHandle.style.cursor = 'w-resize';
                        const openRegionContextMenu = (e) => {
                            const isSecondaryClick = e.type === 'contextmenu' || e.button === 2 || (e.button === 0 && e.ctrlKey);
                            if (!isSecondaryClick) {
                                return;
                            }

                            if (e.target.closest?.('[part~=region-handle]')) {
                                return;
                            }

                            e.preventDefault();
                            e.stopPropagation();

                            const trackNumber = parseInt(region.id.replace('track-', ''), 10);
                            if (!isNaN(trackNumber)) {
                                const track = this.detectedTracks.find(t => t.number === trackNumber);
                                const wrapper = this.waveform.getWrapper();
                                const rect = wrapper.getBoundingClientRect();
                                const relativeX = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
                                const time = relativeX * this.waveform.getDuration();

                                this.regionContextMenu.x = e.clientX;
                                this.regionContextMenu.y = e.clientY;
                                this.regionContextMenu.trackNumber = trackNumber;
                                this.regionContextMenu.isIgnored = track ? track.ignored : false;
                                this.regionContextMenu.time = time;
                                this.regionContextMenu.show = true;
                            }
                        };

                        regionElement.addEventListener('contextmenu', openRegionContextMenu);
                        regionElement.addEventListener('mousedown', openRegionContextMenu);
                    }
                });

                // Pass duration only when valid — WaveSurfer can then render
                // immediately from pre-computed peaks without fetching the audio.
                // If duration is missing or 0 (probe failed at upload), omit it
                // so WaveSurfer falls back to fetching the file (slower but safe).
                const knownDuration = peaksData.duration > 0 ? peaksData.duration : undefined;
                // Browsers that cannot play WAV at all go straight to the MP3 preview.
                const preciseOk = !!(media.canPlayType && media.canPlayType('audio/wav'));
                const peaks = [scalePeaksToRecording(peaksData.peaks)];
                // Raw: Alpine must not wrap the ~240k-element peaks in a proxy for WaveSurfer
                this._audioSource = markRaw({ waveform, fileId, precise: preciseOk, peaks,
                    duration: knownDuration, fellBack: false, settled: true, generation: 0 });
                this.playerInfo = preciseOk ? '' : PREVIEW_AUDIO_NOTICE;
                await this.waveform.load(this.audioUrl(fileId, preciseOk), peaks, knownDuration);

            } catch (error) {
                // A fallback reload already took over this load's failure.
                if (this._audioSource?.fellBack) return;
                console.error('Waveform initialization failed:', error);
                // A failure of a build that was replaced (another file, a newer waveform) concerns
                // nothing on screen: no toast, no teardown, no fallback
                if (!isCurrentBuild()) return;
                this.notifyError('Failed to load waveform', error);
                // A half-built waveform (created before the peaks request) would still answer Play and
                // zoom, and could play beside the fallback: tear it down first.  destroyWaveform also
                // clears fallbackAudioUrl and resets loading, so the fallback is set after it.
                this.destroyWaveform();
                this.waveformLoading = false;
                if (SOURCE_REFUSED_STATUSES.has(error?.status)) return;   // the toast above carries the server's reason
                // So the recording can still be heard: the preview URL, which every browser plays
                this.fallbackAudioUrl = this.audioUrl(fileId, false);
                this.$nextTick?.(() => this.applyPlayerVolume());
            }
        },

        /**
         * WaveSurfer scrolls a dragged region into view on every pointer move: its start when
         * that is off-screen, else its end.  A region wider than the view always has one of them
         * off-screen, so a whole-region drag while zoomed in flipped the view between the two.
         * Wider regions now follow their leading edge instead: the edge the drag moves towards
         * (start when dragging left, end when dragging right, fixed for the whole drag) is kept
         * DRAG_EDGE_MARGIN of the view in from the screen edge, so what lies ahead of the track
         * (e.g. the previous track it is being moved up to) scrolls into sight.
         */
        tameRegionDragScroll(waveform, regions) {
            const follow = regions.adjustScroll?.bind(regions);
            if (!follow) return;
            const drags = new WeakMap();   // region -> { start, dir } for the drag in progress
            // Where the region was when the pointer went down, so the first move knows its direction
            regions.on?.('region-created', region => region.element?.addEventListener('pointerdown',
                () => drags.set(region, { start: region.start, dir: 0 })));
            regions.on?.('region-updated', region => drags.delete(region));   // drag ended
            regions.adjustScroll = region => {
                const view = waveform.getWrapper?.()?.parentElement;
                const width = region?.element?.getBoundingClientRect?.().width || 0;
                if (!view || width <= view.clientWidth) { follow(region); return; }
                const drag = drags.get(region) || { start: region.start, dir: 0 };
                if (!drag.dir && region.start !== drag.start) drag.dir = region.start < drag.start ? -1 : 1;
                drags.set(region, drag);
                if (!drag.dir) return;
                const pxPerSec = view.scrollWidth / (waveform.getDuration?.() || 1);
                const margin = view.clientWidth * DRAG_EDGE_MARGIN;
                view.scrollLeft = drag.dir < 0
                    ? region.start * pxPerSec - margin
                    : region.end * pxPerSec - (view.clientWidth - margin);
            };
        },

        /**
         * The regions plugin ends a drag only on a document pointerup/pointercancel and its
         * pointermove never checks `buttons`; a second pointerdown on the same element also
         * overwrites the remover of the first drag's listeners. If a pointerup is lost (macOS
         * Ctrl+click opening our context menu, a fast double-click) the region stays glued to
         * the pointer. This ends such a drag with a synthetic document pointerup: when a
         * press arrives while one is still active, or a move arrives with no button held.
         * Document listeners are installed once per app, however often the waveform reloads.
         */
        guardRegionDragRelease(regions) {
            if (!this._regionDragGuard) {
                const guard = this._regionDragGuard = markRaw({ active: false });
                guard.endDrag = event => {
                    guard.active = false;
                    const init = { bubbles: true, clientX: event.clientX, clientY: event.clientY };
                    document.dispatchEvent(typeof PointerEvent === 'function'
                        ? new PointerEvent('pointerup', init) : new MouseEvent('pointerup', init));
                };
                document.addEventListener('pointermove', event => {
                    if (guard.active && event.buttons === 0) guard.endDrag(event);
                }, true);
                // Real or synthetic releases both clear the flag
                for (const type of ['pointerup', 'pointercancel']) {
                    document.addEventListener(type, () => { guard.active = false; }, true);
                }
            }
            const guard = this._regionDragGuard;
            // Capture phase: runs before the plugin's own (and the resize handles') listeners
            regions.on?.('region-created', region => region.element?.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                if (guard.active) guard.endDrag(event);
                guard.active = true;
            }, true));
        },

        /** Track WaveSurfer's scroll position (its scroll element wraps the waveform wrapper). */
        bindWaveScrollbar(waveform) {
            const scroller = waveform.getWrapper?.()?.parentElement;
            if (!scroller) return;
            this._waveScroller = markRaw(scroller);
            const update = () => {
                if (waveform !== this.waveform) return;
                const total = scroller.scrollWidth || 1;
                const start = Math.max(0, scroller.scrollLeft / total);
                const end = Math.min(1, (scroller.scrollLeft + scroller.clientWidth) / total);
                if (Math.abs(start - this.waveView.start) > 1e-4 || Math.abs(end - this.waveView.end) > 1e-4) {
                    this.waveView = { start, end };
                }
            };
            scroller.addEventListener('scroll', update, { passive: true });
            for (const ev of ['zoom', 'redraw', 'ready']) waveform.on(ev, update);
            // ⌘/Ctrl + wheel, and trackpad pinch (browsers send it as Ctrl + wheel), zoom the
            // waveform around the pointer; plain wheel keeps scrolling the page.
            const container = document.getElementById('waveform');
            const wheel = event => {
                if (waveform !== this.waveform || !(event.ctrlKey || event.metaKey)) return;
                event.preventDefault();
                this.wheelZoom(event, scroller);
            };
            container?.addEventListener('wheel', wheel, { passive: false });
            waveform.on('destroy', () => {
                scroller.removeEventListener('scroll', update);
                container?.removeEventListener('wheel', wheel);
            });
        },

        /** Zoom by a wheel/pinch delta, keeping the moment under the pointer in place. */
        wheelZoom(event, scroller) {
            const duration = this.waveform?.getDuration();
            if (!duration) return;
            const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;   // lines/pages -> px
            const dy = Math.max(-200, Math.min(200, event.deltaY * lines));
            const fit = scroller.clientWidth / duration;            // zoomed all the way out
            const shown = scroller.scrollWidth / duration;          // current pixels per second
            const next = Math.max(fit, Math.min(500, shown * Math.exp(-dy * WHEEL_ZOOM_RATE)));
            if (Math.abs(next - shown) < 1e-3) return;
            const x = event.clientX - scroller.getBoundingClientRect().left;
            const time = (scroller.scrollLeft + x) / shown;
            this.currentZoom = next;
            this.waveform.zoom(next);
            scroller.scrollLeft = time * (scroller.scrollWidth / duration) - x;
        },

        /** Scrollbar: drag the thumb, or press the track to centre the view there. */
        waveScrollbarDown(event) {
            const bar = event.currentTarget, scroller = this._waveScroller;
            if (!scroller || event.button > 0) return;
            const rect = bar.getBoundingClientRect();
            const span = this.waveView.end - this.waveView.start;
            const at = (event.clientX - rect.left) / rect.width;
            const onThumb = at >= this.waveView.start && at <= this.waveView.end;
            const scrollTo = start => {
                const clamped = Math.max(0, Math.min(1 - span, start));
                scroller.scrollLeft = clamped * scroller.scrollWidth;
            };
            if (!onThumb) scrollTo(at - span / 2);
            // Where in the thumb the pointer holds it (a track press grabs the thumb's middle)
            const grab = onThumb ? at - this.waveView.start : span / 2;
            bar.classList.add('dragging');
            try { bar.setPointerCapture(event.pointerId); } catch { /* keep dragging without capture */ }
            const move = e => scrollTo((e.clientX - rect.left) / rect.width - grab);
            const up = () => {
                bar.classList.remove('dragging');
                bar.removeEventListener('pointermove', move);
                bar.removeEventListener('pointerup', up);
                bar.removeEventListener('pointercancel', up);
            };
            bar.addEventListener('pointermove', move);
            bar.addEventListener('pointerup', up);
            bar.addEventListener('pointercancel', up);
            event.preventDefault();
        },

        audioUrl(fileId, precise) {
            return precise ? `/api/audio/${fileId}?precise=true` : `/api/audio/${fileId}`;
        },

        /** True while a preview-fallback reload of this waveform is still loading */
        fallbackInFlight(waveform) {
            const source = this._audioSource;
            return !!source && source.waveform === waveform && source.fellBack && !source.settled;
        },

        /**
         * The original WAV failed to play: reload the pinned MP3 preview once, keeping peaks,
         * zoom, playhead and paused state. Returns true when it took over the error.
         * Never loops: an error on the preview URL falls through to the normal notice.
         */
        fallBackToPreview(waveform, fileId) {
            const source = this._audioSource;
            if (!source || source.waveform !== waveform || waveform !== this.waveform || fileId !== this.currentFileId) return false;
            // The media element and WaveSurfer both report the same failure: absorb the twin while reloading.
            if (source.fellBack && !source.settled) return true;
            if (!source.precise) return false;
            this.reloadPreview(waveform, fileId, source);
            return true;
        },

        /**
         * Load the MP3 preview into the waveform, keeping peaks, zoom, playhead and paused/playing
         * state. Shared by the fallback from the WAV and the single retry once the server has the preview.
         */
        reloadPreview(waveform, fileId, source) {
            source.precise = false;
            source.fellBack = true;
            source.settled = false;
            source.generation++;   // a play() started on the earlier source is now stale
            const resume = this.isPlaying;
            this.isPlaying = false;
            this.playerInfo = PREVIEW_AUDIO_NOTICE;
            this.waveformLoading = true;
            this._restoreZoom = this.currentZoom;
            if (this.playTime > 0) this._pendingSeek = this.playTime;
            const stale = () => waveform !== this.waveform || fileId !== this.currentFileId;
            Promise.resolve(waveform.load(this.audioUrl(fileId, false), source.peaks, source.duration)).then(() => {
                source.settled = true;
                if (stale()) return;
                this.playerNotice = '';   // a retry after a failure: the preview plays now
                if (resume) this.startPlayback();
            }, (err) => {
                source.settled = true;
                if (stale()) return;
                console.error('Preview fallback failed:', err);
                this.waveformLoading = false;
                this.explainPreviewFailure(waveform, fileId, (err && err.message) || err || 'unknown');
            });
        },

        /**
         * The preview could not be played either. Show the player's own message at once, then ask the
         * server why with a ranged GET of the non-waiting probe form of the preview URL (`wait=0`, which
         * never waits; it starts the encode only if none ran yet, and never re-runs a failed one):
         *  - not ok: its `detail` replaces the message (410 source gone, 409 changed, 503 preview not
         *    ready or not made). A 503 with Retry-After means "still being prepared": poll every
         *    `previewPollIntervalMs`, up to `previewPollMaxMs`;
         *  - ok: the preview is there now (the encode finished meanwhile): reload it, once per waveform,
         *    so this never loops;
         *  - the probe itself failing keeps the player's message.
         * Stops silently when the file is switched, the waveform rebuilt or destroyed.
         */
        async explainPreviewFailure(waveform, fileId, fallbackMessage) {
            const source = this._audioSource;
            const stale = () => waveform !== this.waveform || fileId !== this.currentFileId || this._audioSource !== source;
            if (!source || stale() || source.probing) return;
            const show = (message) => { if (!stale()) this.showPlayerNotice('Audio playback error: ' + message); };
            show(fallbackMessage);
            source.probing = true;   // the error and its WaveSurfer twin must start one probe loop, not two
            try {
                const deadline = Date.now() + this.previewPollMaxMs;
                for (;;) {
                    let response;
                    try {
                        response = await fetch(this.audioUrl(fileId, false) + '?wait=0', { headers: { Range: 'bytes=0-1' } });
                    } catch (err) {
                        return;
                    }
                    if (stale()) return;
                    if (response.ok) {
                        if (source.settled && !source.previewRetried) {
                            source.previewRetried = true;
                            this.reloadPreview(waveform, fileId, source);
                        }
                        return;
                    }
                    const data = await response.json().catch(() => ({}));
                    if (stale()) return;
                    show(data.detail || `the server answered HTTP ${response.status}`);
                    const stillPreparing = response.status === 503 && response.headers?.get?.('Retry-After');
                    if (!stillPreparing || Date.now() >= deadline) return;
                    await new Promise(resolve => setTimeout(resolve, this.previewPollIntervalMs));
                    if (stale()) return;
                }
            } finally {
                source.probing = false;
            }
        },

        /**
         * Add draggable region markers for each track
         */
        addTrackRegions() {
            if (!this.waveformRegions || !this.waveform) return;

            const totalDuration = this.waveform.getDuration();

            try {
                this.waveformRegions.clearRegions();
            } catch (e) {
                console.error('Error clearing regions:', e);
            }

            this.detectedTracks.forEach((track, idx) => {
                try {
                    const clampedStart = Math.min(track.start, totalDuration);
                    const clampedEnd = Math.min(track.end, totalDuration);

                    if (clampedEnd <= clampedStart) return;

                    this.waveformRegions.addRegion({
                        start: clampedStart,
                        end: clampedEnd,
                        color: track.ignored ? IGNORED_TRACK_COLOR : this.getTrackColor(idx),
                        // An exporting recording is read-only: its cuts can't be dragged
                        drag: !this.currentLocked,
                        resize: !this.currentLocked,
                        id: `track-${track.number}`,
                        content: this.regionLabel(track)
                    });
                } catch (e) {
                    console.error(`Failed to create region for Track ${track.number}:`, e);
                }
            });

            this.addExpectedMarkers(totalDuration);

            // Regions were rebuilt: re-apply the current-track emphasis
            this.playheadIdx = -1;
            if (this.playTime > 0) this.updateCurrentTrack(this.playTime, true);
        },

        /**
         * Thin dashed, non-interactive markers at the Discogs-expected breaks
         */
        addExpectedMarkers(totalDuration) {
            if (!this.waveformRegions) return;
            const total = totalDuration || this.waveform?.getDuration?.() || Infinity;
            this.expectedBoundaries.forEach((time, i) => {
                if (!(time > 0 && time < total)) return;
                try {
                    const marker = this.waveformRegions.addRegion({
                        start: time,
                        color: EXPECTED_MARKER_COLOR,
                        drag: false,
                        resize: false,
                        id: `expected-${i + 1}`
                    });
                    if (marker && marker.element && marker.element.style) {
                        marker.element.style.pointerEvents = 'none';
                        marker.element.style.borderLeft = `2px dashed ${EXPECTED_MARKER_COLOR}`;
                        marker.element.style.backgroundColor = 'transparent';
                    }
                } catch (e) {
                    console.error('Failed to create expected-boundary marker:', e);
                }
            });
        },

        /**
         * Drop the ghost markers (data and drawn regions)
         */
        clearExpectedMarkers() {
            this.expectedBoundaries = [];
            if (!this.waveformRegions) return;
            try {
                this.waveformRegions.getRegions()
                    .filter(r => String(r.id).startsWith('expected-'))
                    .forEach(r => r.remove());
            } catch (e) {
                console.error('Error clearing expected markers:', e);
            }
        },

        /**
         * Update existing region labels in place (no waveform rebuild)
         */
        refreshRegionLabels() {
            if (!this.waveformRegions) return;
            try {
                this.waveformRegions.getRegions().forEach(region => {
                    if (!String(region.id).startsWith('track-')) return;
                    const number = parseInt(region.id.slice('track-'.length), 10);
                    const track = this.detectedTracks.find(t => t.number === number);
                    if (!track) return;
                    const content = this.regionLabel(track);
                    if (region.content !== content && region.element?.textContent !== content) {
                        region.setOptions({ content });
                    }
                });
            } catch (e) {
                console.error('Error refreshing region labels:', e);
            }
        },

        /** Why a right-click split found no track to cut: a gap or the outside, or exactly a boundary */
        notifySplitRefused(time) {
            const touchesTrack = this.detectedTracks.some(t => time >= t.start && time <= t.end);
            this.notify(touchesTrack
                ? 'Cannot split here: the position must be inside a track, not on a boundary.'
                : 'This spot is between tracks; right-click inside a track to split it.',
                { type: 'warning', timeout: 6000 });
        },

        /**
         * Split track at context menu position
         */
        splitAtContextMenu() {
            this.contextMenu.show = false;

            const time = this.contextMenu.time;

            // Find which track contains this time position (must be strictly inside)
            const trackIndex = this.detectedTracks.findIndex(t =>
                time > t.start && time < t.end
            );

            if (trackIndex === -1) {
                this.notifySplitRefused(time);
                return;
            }

            const trackToSplit = this.detectedTracks[trackIndex];

            // Create two new tracks from the split
            const newTrack1 = {
                number: trackToSplit.number,
                start: trackToSplit.start,
                end: time,
                duration: time - trackToSplit.start,
                editing: false,
                ignored: false
            };

            const newTrack2 = {
                number: trackToSplit.number + 1,
                start: time,
                end: trackToSplit.end,
                duration: trackToSplit.end - time,
                editing: false,
                ignored: false
            };

            // Replace the split track with two new tracks, then renumber cleanly
            this.detectedTracks.splice(trackIndex, 1, newTrack1, newTrack2);
            this.renumberTracks();
            this.markEdited();

            // Refresh waveform regions
            this.addTrackRegions();

            // Track count changed: keep the release, re-align the mapping
            // (also refreshes the mismatch warning)
            if (this.selectedRelease) {
                this.resetMappingToTargets();
            }
        },

        /**
         * Delete track from region context menu
         */
        deleteTrackFromRegionMenu() {
            this.regionContextMenu.show = false;
            this.deleteTrack(this.regionContextMenu.trackNumber);
        },

        /**
         * Split track at region context menu position
         */
        splitAtRegionContextMenu() {
            this.regionContextMenu.show = false;

            const time = this.regionContextMenu.time;

            // Find which track contains this time position (must be strictly inside)
            const trackIndex = this.detectedTracks.findIndex(t =>
                time > t.start && time < t.end
            );

            if (trackIndex === -1) {
                this.notifySplitRefused(time);
                return;
            }

            const trackToSplit = this.detectedTracks[trackIndex];

            // Create two new tracks from the split
            const newTrack1 = {
                number: trackToSplit.number,
                start: trackToSplit.start,
                end: time,
                duration: time - trackToSplit.start,
                editing: false,
                ignored: false
            };

            const newTrack2 = {
                number: trackToSplit.number + 1,
                start: time,
                end: trackToSplit.end,
                duration: trackToSplit.end - time,
                editing: false,
                ignored: false
            };

            // Replace the split track with two new tracks, then renumber cleanly
            this.detectedTracks.splice(trackIndex, 1, newTrack1, newTrack2);
            this.renumberTracks();
            this.markEdited();

            // Refresh waveform regions
            this.addTrackRegions();

            // Track count changed: keep the release, re-align the mapping
            // (also refreshes the mismatch warning)
            if (this.selectedRelease) {
                this.resetMappingToTargets();
            }
        },

        /**
         * Delete a track and renumber the rest.  Immediate, with an Undo
         * toast that restores the track and rebuilds the regions.
         */
        deleteTrack(trackNumber) {
            const trackIndex = this.detectedTracks.findIndex(t => t.number === trackNumber);

            if (trackIndex === -1) {
                return;
            }

            const snapshot = this.snapshotEdits();
            const fileId = this.currentFileId;

            // Remove the track, then renumber cleanly
            this.detectedTracks.splice(trackIndex, 1);
            this.renumberTracks();
            this.markEdited();

            // Refresh waveform regions
            this.addTrackRegions();

            // Track count changed: keep the release, re-align the mapping
            // (also refreshes the mismatch warning)
            if (this.selectedRelease) {
                this.resetMappingToTargets();
            }

            this.notifyUndo(`Deleted track ${trackNumber}.`, () => this.restoreEdits(snapshot), { fileId });
        },

        renumberTracks() {
            this.detectedTracks.forEach((track, i) => { track.number = i + 1; });
        },

        /**
         * Get count of non-ignored tracks
         */
        /**
         * The count warning, except while the first detection runs: a pick starts it, and
         * "0 detected" is no finding yet (its Snap to Discogs button would race it too).
         * With tracks present it stays up during a Smart Rescan, whose spinner lives in it.
         */
        get showTrackCountMismatch() {
            return this.trackCountMismatch && (this.detectedTracks.length > 0 || !this.analyzing);
        },

        get activeTrackCount() {
            return this.detectedTracks.filter(t => !t.ignored).length;
        },

        /**
         * Toggle track ignored status and update region color
         */
        toggleTrackIgnored(track) {
            if (this.analyzing) return;
            track.ignored = !track.ignored;

            if (this.waveformRegions) {
                const region = this.waveformRegions.getRegions().find(r => r.id === `track-${track.number}`);
                if (region) {
                    const newColor = track.ignored
                        ? IGNORED_TRACK_COLOR
                        : this.getTrackColor(this.detectedTracks.indexOf(track));
                    region.setOptions({ color: newColor, content: this.regionLabel(track) });
                }
            }
        },

        /**
         * Get color for track by index
         */
        getTrackColor(idx) {
            return TRACK_COLORS[idx % TRACK_COLORS.length];
        },

        /**
         * Waveform region label for a track
         */
        regionLabel(track) {
            let base = `Track ${track.number}`;
            const dt = this.mappedTrack(this.detectedTracks.indexOf(track));
            if (dt) {
                const title = this.partDisplayTitle(dt);
                const short = title.length > REGION_TITLE_MAX
                    ? title.slice(0, REGION_TITLE_MAX - 1).trimEnd() + '…'
                    : title;
                base = `${dt.position} · ${short}`;
            }
            return track.ignored ? `Ignored: ${base}` : base;
        },

        /**
         * Update track data when region is dragged/resized
         */
        updateTrackFromRegion(region) {
            // Ghost markers (and anything else) are not tracks
            if (!region || typeof region.id !== 'string' || !region.id.startsWith('track-')) return;

            const trackNumber = parseInt(region.id.slice('track-'.length), 10);
            const idx = this.detectedTracks.findIndex(t => t.number === trackNumber);
            if (idx < 0) return;

            const startBefore = this.detectedTracks[idx].start;
            const endBefore = this.detectedTracks[idx].end;
            const requestedStart = region.start;
            const requestedEnd = region.end;
            this.applyTrackBounds(idx, requestedStart, requestedEnd);
            // region-updated fires once per drag end and the region holds what the user asked for;
            // when the track ended up elsewhere the region is about to snap back or shrink: say why
            const track = this.detectedTracks[idx];
            if (Math.abs(track.start - requestedStart) > REGION_CLAMP_TOLERANCE_S
                || Math.abs(track.end - requestedEnd) > REGION_CLAMP_TOLERANCE_S) {
                const moved = (track.start !== startBefore || track.end !== endBefore);
                const pastRecording = requestedEnd > this.recordingEnd() + REGION_CLAMP_TOLERANCE_S;
                this.notify(pastRecording
                    ? (moved ? `Track ${track.number} stops at the end of the recording.` : `Track ${track.number} can't move past the end of the recording.`)
                    : moved
                        ? `Track ${track.number} stops here: every track keeps at least ${MIN_TRACK_LENGTH} s.`
                        : `Track ${track.number} can't move there: every track keeps at least ${MIN_TRACK_LENGTH} s.`,
                    { type: 'info', timeout: 4000 });
            }
            // Push any clamping / neighbour changes back onto the regions
            this.syncRegionsAround(idx);
        },

        /**
         * Clock text m:ss for the transport readout
         */
        formatClock(seconds) {
            const t = Math.max(0, Math.floor(Number(seconds) || 0));
            return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        },

        showPlayerNotice(msg) {
            this.playerNotice = msg;
        },

        /**
         * Start playback, reporting failures inline instead of silently
         */
        startPlayback() {
            const waveform = this.waveform;
            if (!waveform) return;
            this.abPause();   // one player at a time
            // A play() started on the WAV can reject after the preview fallback took over (and
            // restarted playback itself); that says nothing about the preview.
            const generation = this._audioSource?.generation;
            try {
                const started = waveform.play();
                if (started && typeof started.then === 'function') {
                    started.then(() => { if (this.waveform === waveform) this.playerNotice = ''; }, (err) => {
                        // A reply for a waveform that was destroyed or replaced meanwhile (file switch,
                        // re-analysis, Snap) says nothing about the current one
                        if (this.waveform !== waveform || this._audioSource?.generation !== generation) return;
                        // WaveSurfer 7.8.10 rejects play() with AbortError when it is paused before
                        // playback starts: the user's own action, not a failure
                        if (err && err.name === 'AbortError') return;
                        console.error('Playback failed:', err);
                        this.isPlaying = false;
                        // A load failure can leave the media element "playing"; stop it so the
                        // next click plays instead of pausing
                        waveform.pause();
                        this.showPlayerNotice('Could not start playback: ' + ((err && err.message) || err || 'unknown error'));
                    });
                } else {
                    this.playerNotice = '';
                }
            } catch (err) {
                console.error('Playback failed:', err);
                this.isPlaying = false;
                this.showPlayerNotice('Could not start playback: ' + ((err && err.message) || err));
            }
        },

        // ---- Click detection: scan, per-track counts, density strip --------------

        /** Pure helpers, also reachable from the Alpine object (and tests) */
        countClicksInRange(times, start, end) { return countClicksInRange(times, start, end); },
        clickDensityBins(times, duration, bins) { return clickDensityBins(times, duration, bins); },
        clickTickAlpha(count) { return clickTickAlpha(count); },

        /** Strength a scan runs at: the panel's, or Medium when the panel is Off */
        clickScanStrength() {
            return this.declick === 'off' ? 'medium' : this.declick;
        },

        /** Effective click-removal strength of a track: its override, else the panel's */
        trackEffectiveDeclick(track) {
            return track && track.declick ? this.normDeclick(track.declick) : this.declick;
        },

        /** Label of the "Default" option in the per-track dropdown */
        declickDefaultLabel() {
            const lvl = this.declickLevels.find(l => l.id === this.declick);
            return `Default (${lvl ? lvl.label : 'Off'})`;
        },

        setTrackDeclick(idx, value) {
            if (this.analyzing) return;
            const t = this.detectedTracks[idx];
            if (!t) return;
            t.declick = value ? this.normDeclick(value) : null;
        },

        clickScanFor(fileId) { return this.clickScans[fileId || this.currentFileId] || null; },

        clickScanRunning() {
            const s = this.clickScanFor();
            return !!(s && s.status === 'running');
        },

        /** True once the current file has click times (a re-scan keeps showing the previous ones) */
        hasClickScan() {
            const s = this.clickScanFor();
            return !!(s && Array.isArray(s.times));
        },

        clickScanButtonText() {
            const s = this.clickScanFor();
            if (s && s.status === 'running') return `Scanning for clicks… ${Math.round((s.progress || 0) * 100)}%`;
            return this.hasClickScan() ? 'Rescan for clicks' : 'Scan for clicks';
        },

        /** One line under the Tracks header: what the scan used / found */
        clickScanNote() {
            const s = this.clickScanFor();
            if (!s) return '';
            if (s.status === 'error') return `Click scan failed: ${s.error || 'unknown error'}`;
            if (s.status !== 'done') return '';
            const n = s.times.length;
            const clicks = `${n} click${n === 1 ? '' : 's'} found`;
            return s.requested === 'off'
                ? `${clicks} (scanned at Medium; click removal is off)`
                : `${clicks} at ${s.strength}`;
        },

        /** Clicks inside the track's current [start, end); null before a scan */
        trackClicks(track) {
            if (!this.hasClickScan() || !track) return null;
            return countClicksInRange(this.clickScanFor().times, track.start, track.end);
        },

        clickCountText(track) {
            const n = this.trackClicks(track);
            return n === null ? '—' : String(n);
        },

        clickTooltip(track) {
            const n = this.trackClicks(track);
            if (n === null) return 'Not scanned yet. Use "Scan for clicks".';
            const minutes = (track.end - track.start) / 60;
            const perMin = minutes > 0 ? (n / minutes).toFixed(1) : '0.0';
            return `${n} click${n === 1 ? '' : 's'} (${perMin} per minute) — detected at ${this.clickScanFor().strength}`;
        },

        clickLegendVisible() { return this.hasClickScan() && !!this.waveform; },

        clickLegendText() {
            const s = this.clickScanFor();
            return s ? `Red ticks: detected clicks (${s.strength})` : '';
        },

        /** Start a scan for the current file at the panel's strength (button / strength change) */
        async scanClicks(fileId) {
            fileId = fileId || this.currentFileId;
            if (!fileId) return;
            const prev = this.clickScans[fileId];
            try {
                const res = await fetch(`/api/clicks/${fileId}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ declick: this.declick }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || `Scan failed (${res.status})`);
                this.applyClickResponse(fileId, data, prev);
            } catch (err) {
                this.clickScans = { ...this.clickScans, [fileId]: {
                    ...(prev || {}), status: 'error', progress: 0, error: (err && err.message) || 'Scan failed',
                    times: prev && prev.times ? prev.times : null } };
                this.notifyError('Click scan failed', err);
            }
        },

        /** Start a scan only if the file has none for the current strength */
        ensureClickScan() {
            const s = this.clickScanFor();
            if (s && (s.status === 'running' || (s.status === 'done' && s.strength === this.clickScanStrength()))) return;
            this.scanClicks();
        },

        /** Silently pick up a scan cached on the server (e.g. after reselecting a file) */
        async loadCachedClicks(fileId) {
            if (!fileId || this.clickScans[fileId]) return;
            try {
                const res = await fetch(`/api/clicks/${fileId}?declick=${encodeURIComponent(this.declick)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (data.status === 'done' || data.status === 'running') this.applyClickResponse(fileId, data, null);
            } catch (err) {
                console.warn('Click scan state unavailable:', err);
            }
        },

        /** Merge a POST/GET /api/clicks response into the per-file state */
        applyClickResponse(fileId, data, prev) {
            prev = prev || this.clickScans[fileId] || null;
            if (data.status === 'done') {
                this.stopClickPoll(fileId);
                this.clickScans = { ...this.clickScans, [fileId]: {
                    strength: data.strength, requested: data.requested, status: 'done', progress: 1,
                    times: data.times || [], scannedAt: data.scanned_at || null } };
                if (fileId === this.currentFileId) this.refreshClickStrip();
            } else if (data.status === 'running' || data.status === 'none') {
                // keep the previous result visible while a re-scan runs
                this.clickScans = { ...this.clickScans, [fileId]: {
                    strength: data.strength, requested: data.requested, status: 'running',
                    progress: data.progress || 0,
                    times: prev && prev.times ? prev.times : null, scannedAt: prev ? prev.scannedAt : null } };
                this.startClickPoll(fileId);
            } else if (data.status === 'error') {
                this.stopClickPoll(fileId);
                this.clickScans = { ...this.clickScans, [fileId]: {
                    ...(prev || {}), strength: data.strength, requested: data.requested, status: 'error',
                    progress: 0, error: data.error || 'Scan failed' } };
                this.notify(`Click scan failed: ${data.error || 'unknown error'}`, { type: 'error' });
            }
        },

        /** WebSocket click_scan_progress / click_scan_complete */
        onClickScanMessage(data) {
            const s = this.clickScans[data.file_id];
            if (!s || s.strength !== data.strength) return;
            if (data.type === 'click_scan_progress') {
                if (s.status === 'running') {
                    this.clickScans = { ...this.clickScans, [data.file_id]: { ...s, progress: data.progress || 0 } };
                }
            } else if (data.error) {
                this.applyClickResponse(data.file_id, { status: 'error', strength: s.strength,
                    requested: s.requested, error: data.error }, s);
            } else {
                this.fetchClickResult(data.file_id);
            }
        },

        async fetchClickResult(fileId) {
            const s = this.clickScans[fileId];
            try {
                const res = await fetch(`/api/clicks/${fileId}?declick=${encodeURIComponent(s ? s.requested : this.declick)}`);
                if (!res.ok) return;
                this.applyClickResponse(fileId, await res.json(), s);
            } catch (err) {
                console.warn('Click scan result unavailable:', err);
            }
        },

        /** Polling fallback in case the WebSocket drops mid-scan */
        startClickPoll(fileId) {
            if (this._clickPollTimers[fileId]) return;
            this._clickPollTimers[fileId] = setInterval(() => {
                const s = this.clickScans[fileId];
                if (!s || s.status !== 'running') { this.stopClickPoll(fileId); return; }
                this.fetchClickResult(fileId);
            }, 2000);
        },

        stopClickPoll(fileId) {
            if (this._clickPollTimers[fileId]) {
                clearInterval(this._clickPollTimers[fileId]);
                delete this._clickPollTimers[fileId];
            }
        },

        /** Create the density canvas on the waveform wrapper if needed; returns it or null */
        ensureClickStrip() {
            if (!this.waveform || typeof this.waveform.getWrapper !== 'function') return null;
            const wrapper = this.waveform.getWrapper();
            if (!wrapper) return null;
            if (this._clickCanvas && this._clickWrapper === wrapper) return this._clickCanvas;
            this.removeClickStrip();
            const canvas = document.createElement('canvas');
            canvas.className = 'click-density-strip';
            canvas.setAttribute('aria-hidden', 'true');
            Object.assign(canvas.style, {
                position: 'absolute', left: '0', bottom: '0', width: '100%',
                height: `${CLICK_STRIP_HEIGHT}px`, pointerEvents: 'none', zIndex: '9'
            });
            wrapper.appendChild(canvas);
            this._clickCanvas = canvas;
            this._clickWrapper = wrapper;
            return canvas;
        },

        /** (Re)draw the strip from the current file's click times; hides it when there are none */
        refreshClickStrip() {
            const times = this.hasClickScan() ? this.clickScanFor().times : null;
            if (!times || !times.length || !this.waveform) {
                if (this._clickCanvas) this.drawClickStrip(this._clickCanvas, [], 0, 0);
                return;
            }
            const canvas = this.ensureClickStrip();
            if (!canvas) return;
            const wrapper = this._clickWrapper;
            const width = Math.floor(wrapper.scrollWidth || wrapper.clientWidth || 0);
            this.drawClickStrip(canvas, times, this.waveform.getDuration(), width);
        },

        drawClickStrip(canvas, times, duration, widthPx) {
            const w = Math.max(0, Math.min(Math.floor(widthPx), CLICK_STRIP_MAX_PX));
            canvas.width = w || 1;
            canvas.height = CLICK_STRIP_HEIGHT;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, canvas.width, CLICK_STRIP_HEIGHT);
            if (!w || !times.length) return;
            const bins = clickDensityBins(times, duration, w);
            for (let x = 0; x < bins.length; x++) {
                if (!bins[x]) continue;
                ctx.fillStyle = `rgba(${CLICK_STRIP_COLOR}, ${clickTickAlpha(bins[x]).toFixed(2)})`;
                ctx.fillRect(x, 0, 2, CLICK_STRIP_HEIGHT);
            }
        },

        removeClickStrip() {
            const canvas = this._clickCanvas;
            if (canvas) {
                if (typeof canvas.remove === 'function') canvas.remove();
                else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
            }
            this._clickCanvas = null;
            this._clickWrapper = null;
        },

        // ---- A/B test of the audio processing chain on one track -----------------

        /** Indices of tracks that will be exported */
        abActiveIdx() {
            const out = [];
            this.detectedTracks.forEach((t, i) => { if (!t.ignored) out.push(i); });
            return out;
        },

        /** Chosen track: explicit pick, else the track under the playhead, else the first active */
        abEffectiveIdx() {
            const active = this.abActiveIdx();
            if (this.abTrackIdx !== null && active.includes(this.abTrackIdx)) return this.abTrackIdx;
            if (active.includes(this.playheadIdx)) return this.playheadIdx;
            return active.length ? active[0] : -1;
        },

        /** Label like the track table: "A1 · Title" when mapped, else "Track N" */
        abTrackLabel(idx) {
            const t = this.detectedTracks[idx];
            if (!t) return '';
            const dt = this.mappedTrack(idx);
            return dt ? `${dt.position} · ${dt.title}` : `Track ${t.number}`;
        },

        /** True when anything in the audio processing panel would change the audio */
        abAnyProcessing() {
            const t = this.detectedTracks[this.abEffectiveIdx()];
            const eff = t ? this.trackEffectiveDeclick(t) : this.declick;
            return !!(this.rumbleFilter || this.humFilter || this.hissOn() || eff !== 'off' || this.albumGain);
        },

        abCanRender() {
            return this.abAnyProcessing() && this.abEffectiveIdx() >= 0 && !this.abRendering;
        },

        /** Everything the rendered result depends on */
        abSignature() {
            const idx = this.abEffectiveIdx();
            const t = this.detectedTracks[idx];
            const ranges = this.albumGain
                ? this.detectedTracks.filter(x => !x.ignored)
                    .map(x => [x.start, x.end, this.trackEffectiveDeclick(x)]) : null;
            return JSON.stringify([this.currentFileId, idx, t ? [t.start, t.end] : null,
                !!this.rumbleFilter, this.declick, t ? this.trackEffectiveDeclick(t) : null,
                !!this.albumGain, ranges,
                this.humFilter ? this.humFreq : 0, this.hissReduction]);
        },

        /** Clear the player when something it was rendered from changed (x-effect) */
        abCheckStale() {
            const sig = this.abSignature();
            if (this.abResult && this.abResult.sig !== sig) this.abClear();
            else if (this.abRendering && this._abRenderSig !== sig) this.abClear();
        },

        abSelectTrack(value) {
            const n = parseInt(value, 10);
            this.abTrackIdx = Number.isInteger(n) ? n : null;
        },

        abEl(which) {
            const refs = this.$refs || {};
            if (which === 'removed') return refs.abRemoved;
            return which === 'processed' ? refs.abProcessed : refs.abOriginal;
        },

        /** Removed (original - clean-up) exists only when a clean-up filter was on */
        abRemovedAvailable() { return !!(this.abResult && this.abResult.removed_url); },

        abBoostAvailable() {
            if (this.abAudioFailed || typeof window === 'undefined') return false;
            return !!(window.AudioContext || window.webkitAudioContext);
        },

        abBoostGain() { return this.abBoost ? Math.pow(10, 12 / 20) : 1; },

        /**
         * Route the Removed element through AudioContext -> GainNode (+12 dB).
         * Lazy, called inside the user's play click; a MediaElementSource can be
         * created once per element, so it is cached per element (a WeakMap, not
         * Alpine state: reactive proxies break native audio objects).
         */
        abEnsureBoost() {
            const el = this.abEl('removed');
            if (!el || !this.abBoostAvailable()) return;
            try {
                let nodes = _abBoostNodes.get(el);
                if (!nodes) {
                    const Ctx = window.AudioContext || window.webkitAudioContext;
                    const ctx = new Ctx();
                    const gain = ctx.createGain();
                    const source = ctx.createMediaElementSource(el);
                    source.connect(gain);
                    gain.connect(ctx.destination);
                    nodes = { ctx, source, gain };
                    _abBoostNodes.set(el, nodes);
                }
                nodes.gain.gain.value = this.abBoostGain();
                if (nodes.ctx.state === 'suspended' && typeof nodes.ctx.resume === 'function') {
                    const r = nodes.ctx.resume();
                    if (r && typeof r.catch === 'function') r.catch(() => {});
                }
            } catch (err) {
                this.abAudioFailed = true;
            }
        },

        abRemovedLevelText() {
            const r = this.abResult;
            if (!r || !Number.isFinite(r.removed_peak_dbfs)) return '';
            return `Removed audio peaks at ${Math.round(r.removed_peak_dbfs)} dBFS`;
        },

        /** Any A/B element playing, whichever side is shown (the real elements, not abPlaying). */
        abAnyPlaying() {
            return ['original', 'processed', 'removed'].some(w => { const el = this.abEl(w); return !!el && !el.paused; });
        },

        abPause() {
            for (const w of ['original', 'processed', 'removed']) {
                const el = this.abEl(w);
                if (el && !el.paused) el.pause();
            }
        },

        /** Drop the result and stop playback; keeps the section and the track choice */
        abClear() {
            this._abSeq++;
            this.abPause();
            this.abResult = null;
            this.abRendering = false;
            this.abError = '';
            this.abPlaying = false;
            this.abTime = 0;
            this.abDur = 0;
            this.abSide = 'original';
        },

        /** Also forget the track choice (file changed) */
        abReset() {
            this.abClear();
            this.abTrackIdx = null;
        },

        async abRender() {
            if (!this.abCanRender()) return;
            const idx = this.abEffectiveIdx();
            const t = this.detectedTracks[idx];
            this.abTrackIdx = idx;
            const sig = this.abSignature();
            const seq = ++this._abSeq;
            this._abRenderSig = sig;
            this.abPause();
            this.abResult = null;
            this.abError = '';
            this.abRendering = true;
            const body = {
                file_id: this.currentFileId, start: t.start, end: t.end,
                rumble: !!this.rumbleFilter, declick: this.trackEffectiveDeclick(t),
                hum_filter: !!this.humFilter, hum_freq: this.humFreq, hiss_reduction: this.hissReduction,
                album_gain: !!this.albumGain,
            };
            if (this.albumGain) {
                body.album_ranges = this.detectedTracks.filter(x => !x.ignored)
                    .map(x => [x.start, x.end, this.trackEffectiveDeclick(x)]);
            }

            try {
                const pending = fetch('/api/restoration-test', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                // The tested track uses click removal: show where the clicks are by
                // scanning the whole file once, in parallel with the render.
                if (body.declick !== 'off') this.ensureClickScan();
                const res = await pending;
                const data = await res.json().catch(() => ({}));
                if (seq !== this._abSeq) return;
                if (!res.ok) throw new Error(data.detail || `Render failed (${res.status})`);
                this.abResult = {
                    ...data, sig, rumble: body.rumble, declick: body.declick, album: body.album_gain,
                    hum: body.hum_filter ? body.hum_freq : 0, hiss: body.hiss_reduction,
                };
                this.abSide = 'original';
                this.abTime = 0;
                this.abDur = 0;
                this.abApplyVolumes();
            } catch (err) {
                if (seq !== this._abSeq) return;
                this.abError = (err && err.message) || 'Render failed';
            } finally {
                if (seq === this._abSeq) this.abRendering = false;
            }
        },

        /** Match levels: lower the louder one so the comparison isn't won by volume */
        abVolumes() {
            const r = this.abResult;
            let original = 1, processed = 1;   // Removed always plays at unity
            if (this.abMatch && r && Number.isFinite(r.original_lufs) && Number.isFinite(r.processed_lufs)) {
                const diff = r.processed_lufs - r.original_lufs;
                if (diff > 0) processed = Math.min(1, Math.pow(10, -diff / 20));
                else original = Math.min(1, Math.pow(10, diff / 20));
            }
            return { original, processed, removed: 1 };
        },

        abApplyVolumes() {
            const v = this.abVolumes();
            const o = this.abEl('original');
            const p = this.abEl('processed');
            if (o) o.volume = v.original;
            if (p) p.volume = v.processed;
            const rm = this.abEl('removed');
            if (rm) rm.volume = v.removed;
            const nodes = rm && _abBoostNodes.get(rm);
            if (nodes) nodes.gain.gain.value = this.abBoostGain();
        },

        abMatchNote() {
            const r = this.abResult;
            if (!r || !Number.isFinite(r.original_lufs) || !Number.isFinite(r.processed_lufs)) return '';
            const diff = r.processed_lufs - r.original_lufs;
            if (Math.abs(diff) < 0.05) return 'Both versions are at the same loudness';
            const how = `Processed is ${Math.abs(diff).toFixed(1)} dB ${diff > 0 ? 'louder' : 'quieter'}`;
            return this.abMatch ? `${how}; matched for fair comparison` : `${how}; not matched`;
        },

        /** What the processed version has applied */
        abAppliedText() {
            const r = this.abResult;
            if (!r) return '';
            const parts = [];
            if (r.rumble) parts.push('Rumble');
            if (r.hum) parts.push(`hum ${r.hum} Hz`);
            if (r.declick && r.declick !== 'off') parts.push(`clicks (${r.declick})`);
            if (r.hiss && r.hiss !== 'off') parts.push(`hiss (${r.hiss})`);
            if (r.album) {
                parts.push(Number.isFinite(r.gain_db)
                    ? `album gain ${r.gain_db >= 0 ? '+' : '−'}${Math.abs(r.gain_db).toFixed(1)} dB`
                    : 'album gain (could not be measured)');
            }
            const text = parts.join(' + ');
            const cap = text.charAt(0).toUpperCase() + text.slice(1);
            return parts.length === 1 && !r.album ? `${cap} only` : cap;
        },

        abToggle() {
            const el = this.abEl(this.abSide);
            if (!el || !this.abResult) return;
            if (!el.paused) { el.pause(); return; }
            this.pauseWaveform();
            this.pauseFallback();
            if (this.abSide === 'removed') this.abEnsureBoost();
            try {
                const p = el.play();
                if (p && typeof p.catch === 'function') {
                    p.catch((err) => { this.abError = 'Could not start playback: ' + ((err && err.message) || err); });
                }
            } catch (err) {
                this.abError = 'Could not start playback: ' + ((err && err.message) || err);
            }
        },

        /** Switch Original | Processed | Removed, keeping the position and play state */
        abSetSide(side) {
            if (side === this.abSide || !this.abResult) return;
            if (side === 'removed' && !this.abRemovedAvailable()) return;
            const from = this.abEl(this.abSide);
            const to = this.abEl(side);
            const t = from ? from.currentTime : this.abTime;
            const wasPlaying = !!from && !from.paused;
            if (from) from.pause();
            this.abSide = side;
            if (to) {
                to.currentTime = t;
                if (wasPlaying) this.abToggle();
            }
            this.abTime = t;
        },

        abSeek(value) {
            const t = Number(value);
            const el = this.abEl(this.abSide);
            if (!Number.isFinite(t) || !el) return;
            el.currentTime = t;
            this.abTime = t;
        },

        abOnPlay(which) {
            if (which !== this.abSide) return;
            this.abPlaying = true;
            this.pauseWaveform();
            this.pauseFallback();
        },
        abOnPause(which) { if (which === this.abSide) this.abPlaying = false; },
        abOnTime(which) {
            if (which !== this.abSide) return;
            const el = this.abEl(which);
            if (el) this.abTime = el.currentTime;
        },
        abOnMeta(which) {
            if (which !== this.abSide) return;
            const el = this.abEl(which);
            if (el && Number.isFinite(el.duration)) this.abDur = el.duration;
        },
        abOnEnded(which) { if (which === this.abSide) this.abPlaying = false; },

        /** Remove the fallback player: stop it first (dropping the src would not stop a playing element) */
        clearFallback() {
            this.$refs?.fallbackAudio?.pause?.();
            this.fallbackAudioUrl = '';
        },

        /** The fallback <audio> stops when another player starts (it is not the waveform's media element) */
        pauseFallback() {
            this.$refs?.fallbackAudio?.pause?.();
        },

        /** The fallback player started: the A/B player must not play on top of it */
        onFallbackPlay() {
            this.abPause();
        },

        /** A built waveform that has loaded its duration: header Play, zoom, Space and the row buttons need it */
        get playerReady() {
            return !!this.waveform && !this.waveformLoading && this.playDuration > 0;
        },

        /** Put the chosen volume on the waveform's media element and on the fallback player */
        applyPlayerVolume() {
            const media = this.waveform?.getMediaElement?.();
            if (media) media.volume = this.playerVolume;
            const fallbackElement = this.$refs?.fallbackAudio;
            if (fallbackElement) fallbackElement.volume = this.playerVolume;
        },

        /** Volume slider: 0-1, applied at once and remembered; anything else is ignored */
        setPlayerVolume(value) {
            const volume = Number(value);
            if (value === '' || value === null || !Number.isFinite(volume)) return;
            this.playerVolume = Math.min(1, Math.max(0, volume));
            this.applyPlayerVolume();
            try { localStorage.setItem(PLAYER_VOLUME_STORAGE_KEY, String(this.playerVolume)); } catch (error) { /* storage unavailable: the choice lasts for this session */ }
        },

        /** The fallback player's own volume control moved: keep the slider and storage in step */
        onFallbackVolumeChange(audioElement) {
            if (audioElement && audioElement.volume !== this.playerVolume) this.setPlayerVolume(audioElement.volume);
        },

        /**
         * Single play/pause toggle bound to the real player state
         */
        togglePlay() {
            if (!this.waveform) return;
            this.cancelAudition();
            if (this.waveform.isPlaying()) {
                this.waveform.pause();
                return;
            }
            const start = this.currentFile?.musicStart;
            if (this.waveform.getCurrentTime() < 0.05 && start > 0.5) {
                this.seekTo(start);
            }
            this.startPlayback();
        },

        pauseWaveform() {
            this.cancelAudition();
            if (this.waveform && typeof this.waveform.pause === 'function') this.waveform.pause();
        },

        seekTo(time) {
            if (!this.waveform || !Number.isFinite(time)) return;
            time = Math.max(0, Math.min(time, this.waveform.getDuration()));
            const media = this.waveform.getMediaElement?.();
            this._pendingSeek = media?.readyState === 0 ? time : null;
            this.waveform.setTime(time);
            this.onPlayerTime(time);
        },

        /** MediaElement can reset an early currentTime assignment while loading metadata. */
        applyPendingSeek() {
            if (this._pendingSeek === null || !this.waveform) return;
            const time = this._pendingSeek;
            this._pendingSeek = null;
            this.waveform.setTime(time);
            this.onPlayerTime(time);
        },

        /** Distinguish the inside of either edge from the narrow shared boundary itself. */
        regionCursorAt(clientX) {
            if (!this.waveform) return 'ew-resize';
            const rect = this.waveform.getWrapper().getBoundingClientRect();
            const duration = this.waveform.getDuration();
            const x = clientX - rect.left;
            let start = false, end = false;
            for (const track of this.detectedTracks) {
                const startDelta = x - track.start / duration * rect.width;
                const endDelta = x - track.end / duration * rect.width;
                start ||= startDelta >= -REGION_SHARED_EDGE_PX && startDelta <= REGION_EDGE_HIT_PX;
                end ||= endDelta >= -REGION_EDGE_HIT_PX && endDelta <= REGION_SHARED_EDGE_PX;
            }
            return start && end ? 'ew-resize' : end ? 'w-resize' : 'e-resize';
        },

        /**
         * Pointer-focus tracking for Space (see onGlobalKeydown).  A focusin that arrives between a
         * pointerdown and the following pointerup/task was caused by the mouse; any other focusin
         * (Tab, script) was not.  Clicking the element that already has focus fires no focusin, so
         * pointerdown marks it pointer-focused directly.
         */
        onPointerDown(e) {
            this._pointerFocus.pending = true;
            const active = document.activeElement;
            if (active && active !== document.body && active.contains(e.target)) this._pointerFocus.byPointer = true;
        },

        /** A cancelled pointer (touch scroll, pen) never reaches pointerup: it must not stay "pending" */
        onPointerCancel() {
            this._pointerFocus.pending = false;
        },

        onPointerUp() {
            // After the click's own focus change, which comes before pointerup's task ends
            setTimeout(() => {
                this._pointerFocus.pending = false;
                // A press that landed on something taking no focus (a scrollbar) leaves the focused element
                // and its claim alone; the claim ends only once focus has really moved off it
                if (document.activeElement !== this._pointerFocus.lastFocused) this._pointerFocus.lastFocused = null;
            }, 0);
        },

        onFocusIn(e) {
            // init() runs twice (Alpine calls it, and so does x-init), so every document listener is
            // registered twice in principle (bindGlobalListeners guards that): a second call for the
            // same event must not undo the first.
            if (e && this._pointerFocus.lastFocusIn === e) return;
            this._pointerFocus.lastFocusIn = e || null;
            const focused = e && e.target ? e.target : null;
            // Browsers re-dispatch focusin on the focused element when the window regains focus: with no
            // pointer press pending that is no new focus, so the origin of the focus is unchanged
            const windowReactivation = focused !== null && focused === this._pointerFocus.lastFocused && !this._pointerFocus.pending;
            if (!windowReactivation) this._pointerFocus.byPointer = this._pointerFocus.pending;
            this._pointerFocus.lastFocused = focused;
            this._pointerFocus.pending = false;
        },

        /**
         * Space toggles playback, except while typing, in a dialog or a right-click menu, or on a
         * control that uses Space itself.  Fields, selects and sliders always keep it.  A button keeps
         * it only when it was focused from the keyboard: Chromium, Firefox and WebView2 also focus a
         * button that was merely clicked (WKWebView does not), and Space would then press it again
         * (flip Reverse, un-ignore, delete the next track).  :focus-visible cannot tell them apart:
         * Chromium's heuristic turns it on at any keypress, so the focus origin is tracked from the
         * pointer events instead.  For a pointer-focused button Space plays/pauses, and preventDefault
         * on keydown stops the button's own activation (a button is clicked by the keyup of Space, and
         * only after an un-cancelled keydown); Firefox is also told to ignore the keyup (onGlobalKeyup).
         * While an A/B render plays, Space pauses it instead of starting the waveform.
         */
        onGlobalKeydown(e) {
            // Any key ends a pointer press's claim on the next focus: Tab's keydown precedes its focusin
            this._pointerFocus.pending = false;
            // Tabbing out of the document and back onto the same element is keyboard focus, not the
            // window re-activation that onFocusIn tells apart by "same element, nothing pending"
            // (plain or Shift+Tab only: Ctrl/Alt/Meta+Tab may reach a tabless WebView without moving focus)
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) this._pointerFocus.lastFocused = null;
            if (e.code !== 'Space' && e.key !== ' ') return;
            // Safe if a handler ever sees an event twice: the first already handled it
            if (e.defaultPrevented) return;
            // A claimed Space whose keyup never came (window switch) must not cancel a later keyup
            this._spaceClaimedByPlayer = false;
            const target = e.target;
            const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
            // The volume slider has no use for Space, so it never owns it (the A/B scrubber still does)
            const isRangeInput = tag === 'INPUT' && String(target.type).toLowerCase() === 'range'
                && !!target.classList?.contains('volume-slider');
            if ((SPACE_OWNING_TAGS.has(tag) && !isRangeInput) || (target && target.isContentEditable)) return;
            // A keyboard-focused button keeps Space; a pointer-focused one must never be pressed by it,
            // whatever the modifiers and whether or not the player can play right now
            if (tag === 'BUTTON' && !this._pointerFocus.byPointer) return;
            const pointerFocusedButton = tag === 'BUTTON';
            const modifierHeld = e.ctrlKey || e.metaKey || e.altKey;
            if (pointerFocusedButton) {
                // With a modifier only the keyup is cancelled: preventDefault on the keydown could swallow a
                // system shortcut (Alt+Space opens the Windows window menu), and cancelling the keyup alone
                // stops the button's activation (measured with real input in Chromium, WebKit and Firefox)
                if (modifierHeld) this._spaceClaimedByPlayer = true;
                else this._claimSpace(e);
            }
            if (modifierHeld) return;
            if (this.showSettings || this.setupRequired) return;
            if (this.contextMenu.show || this.regionContextMenu.show) return;
            const abPlaying = this.abAnyPlaying();
            // No waveform control while the waveform is not built, still loading, or replaced by the fallback player
            if (!abPlaying && (!this.playerReady || this.fallbackAudioUrl)) return;
            if (!pointerFocusedButton) this._claimSpace(e);
            // A held key repeats keydown: keep the page from scrolling, but toggle only once
            if (e.repeat) return;
            // Pause whatever is playing: Space during the A/B test used to start the
            // waveform instead (from its playhead, often in the lead-in's surface noise).
            if (abPlaying) this.abPause();
            else this.togglePlay();
        },

        /** Take this Space: no page scroll, no button press; its keyup is cancelled as well */
        _claimSpace(e) {
            e.preventDefault();
            this._spaceClaimedByPlayer = true;
        },

        /**
         * Pairs with onGlobalKeydown: cancel the keyup of a Space the player took, so a mouse-focused
         * button is never clicked by it
         */
        onGlobalKeyup(e) {
            if (!this._spaceClaimedByPlayer || (e.code !== 'Space' && e.key !== ' ')) return;
            this._spaceClaimedByPlayer = false;
            e.preventDefault();
        },

        /**
         * Playhead moved
         */
        onPlayerTime(t) {
            this.playTime = t;
            if (this._auditionStop !== null && t >= this._auditionStop) {
                this._auditionStop = null;
                if (this.waveform) this.waveform.pause();
            }
            this.updateCurrentTrack(t);
        },

        /**
         * Track whose [start, end) contains the playhead (-1 in a gap).
         * Only touches the DOM / regions when the index actually changes.
         */
        updateCurrentTrack(t, force = false) {
            let idx = -1;
            for (let i = 0; i < this.detectedTracks.length; i++) {
                const tr = this.detectedTracks[i];
                if (t >= tr.start && t < tr.end) { idx = i; break; }
            }
            if (idx === this.playheadIdx && !force) return;
            const old = this.playheadIdx;
            this.playheadIdx = idx;
            this.setRegionEmphasis(old, false);
            this.setRegionEmphasis(idx, true);
        },

        setRegionEmphasis(idx, on) {
            const track = this.detectedTracks[idx];
            if (!track || !this.waveformRegions) return;
            const region = this.waveformRegions.getRegions().find(r => r.id === `track-${track.number}`);
            if (!region) return;
            let color = track.ignored ? IGNORED_TRACK_COLOR : this.getTrackColor(idx);
            if (on && !track.ignored) color = color.replace(/0\.3\)$/, '0.55)');
            region.setOptions({ color });
        },

        /**
         * Row toggle: play this track in the waveform (continuing onward) or pause
         */
        toggleTrackPlay(idx) {
            const track = this.detectedTracks[idx];
            if (!track || !this.waveform) return;
            this.cancelAudition();
            if (this.isPlaying && this.playheadIdx === idx) {
                this.waveform.pause();
                return;
            }
            this.seekTo(track.start);
            this.startPlayback();
        },

        /**
         * Hear a cut point: 3 s before to 3 s after the track's start or end
         */
        auditionCut(idx, which) {
            const track = this.detectedTracks[idx];
            if (!track || !this.waveform) return;
            const total = this.waveform.getDuration() || Infinity;
            const point = which === 'end' ? track.end : track.start;
            const from = Math.max(0, point - 3);
            const to = Math.min(total, point + 3);
            this.cancelAudition();
            this.seekTo(from);
            this._auditionStop = to;
            this.startPlayback();
        },

        cancelAudition() {
            this._auditionStop = null;
        },

        /**
         * Region click: seek to the click position.  A drag never arrives here: the regions plugin
         * cancels the primary-button pointerdown on a region and swallows the click that ends a real
         * drag (capture-phase click listener), so every 'region-clicked' is a plain click.
         */
        onRegionClicked(region, e) {
            if (!this.waveform || !e) return;
            if (e.button !== undefined && e.button !== 0) return;
            if (e.ctrlKey || e.metaKey) return;
            if (String(region.id).startsWith('expected-')) return;
            if (e.target && e.target.closest?.('[part~=region-handle]')) return;
            const rect = this.waveform.getWrapper().getBoundingClientRect();
            const relativeX = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
            this.cancelAudition();
            this.seekTo(relativeX * this.waveform.getDuration());
        },

        zoomIn() {
            if (this.waveform) {
                this.currentZoom = Math.min(this.currentZoom * 1.5, 500);
                this.waveform.zoom(this.currentZoom);
            }
        },

        zoomOut() {
            if (this.waveform) {
                this.currentZoom = Math.max(this.currentZoom / 1.5, 1);
                this.waveform.zoom(this.currentZoom);
            }
        },

        destroyWaveform() {
            this.waveformLoading = false;   // an in-flight initWaveform returns silently once stale
            this.clearFallback();
            this.removeClickStrip();
            if (this.waveform) {
                this.waveform.destroy();
                this.waveform = null;
                this.waveformRegions = null;
            }
            this.isPlaying = false;
            this.playTime = 0;
            this.playDuration = 0;
            this.playheadIdx = -1;
            this.playerNotice = '';
            this.playerInfo = '';
            this._audioSource = null;
            this._waveScroller = null;
            this.waveView = { start: 0, end: 1 };
            this.playerBuffering = false;
            this._pendingSeek = null;
            this._restoreZoom = null;
            this._auditionStop = null;
        },

        /** Validate and export just the recording currently in the editor. */
        async processFile() {
            if (!this.currentFileId) return;
            if (this.analyzing) {
                this.notify('Wait for track detection to finish before exporting.', { type: 'warning', timeout: 5000 });
                return;
            }
            if (this.currentLocked) {
                this.notify('This recording is already exporting or waiting to export.', { type: 'info', timeout: 4000 });
                return;
            }
            const readiness = this.fileReadiness(this.currentFileId, false);
            if (!readiness.ready) {
                if (!readiness.completed) this.notify(readiness.reason, { type: 'warning', timeout: 6000 });
                return;
            }
            // An export of unknown outcome may still be running: never start or queue another on a guess.
            if (this.hasUncertainExport) {
                this.notify("An earlier export's status is unknown. Reload to check the server before exporting.", { type: 'warning', timeout: 6000 });
                return;
            }
            this.saveWorkspace();
            const request = this.buildExportRequest(this.currentFileId);
            const signature = this.exportSignature();
            if (this.exportBusy) {
                this.enqueueExport(this.currentFileId, request, signature);
                return;
            }
            await this.submitExport(this.currentFileId, request, signature);
        },

        /** Freeze this recording's request now; the dispatcher starts it after the running export settles. */
        enqueueExport(fileId, request, signature) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            this.exportQueue.push(JSON.parse(JSON.stringify({ fileId, filename: file.filename,
                previousStatus: file.status, signature, request })));
            file.status = 'queued'; file.error = ''; file.progress = 0;
            file.processingMessage = 'Waiting for the current export…';
            this.successMessage = '';
            this.notify(`"${this.shortFilename(file.filename)}" is queued. It starts after the current export.`, { type: 'info', timeout: 5000 });
            this.scheduleExportDrain();
        },

        /** Freeze the ready set, then wait for each terminal result before submitting the next. */
        async processAllReady() {
            if (this.exportBusy || this.analyzing) {
                this.notify(this.processAllReason || 'Wait for the current export to finish.', { type: 'warning', timeout: 5000 });
                return;
            }
            this.batchProcessing = true;
            this.batchSummary = null;
            this.albumWarnings = [];
            const results = [];
            let items = [];
            try {
                await this.commitAllRemovals();
                this.saveWorkspace();
                items = this.readyFiles.map(file => ({ fileId: file.id, filename: file.filename,
                    previousStatus: file.status, signature: this.exportSignature(this.workspaceFor(file.id)),
                    request: this.buildExportRequest(file.id) }));
                // No object in the dispatch list may share mutable arrays with an editor workspace.
                items = JSON.parse(JSON.stringify(items));
                this.batchItems = items;
                for (const item of items) this.uploadedFiles.find(file => file.id === item.fileId).status = 'queued';
                const dispatched = new Set();
                for (const item of items) {
                    if (dispatched.has(item.fileId)) continue;
                    const peers = items.filter(other => other.request.release_id === item.request.release_id &&
                        other.request.output_format === item.request.output_format);
                    if (peers.length > 1 && (item.request.album_gain || item.request.replaygain)) {
                        peers.forEach(peer => dispatched.add(peer.fileId));
                        const outcomes = await this.submitAlbumExport(peers);
                        results.push(...outcomes);
                        if (outcomes.some(result => result.status === 'uncertain')) break;
                        continue;
                    }
                    dispatched.add(item.fileId);
                    this._batchFileId = item.fileId;
                    const terminal = new Promise(resolve => { this._batchResolve = resolve; });
                    await this.submitExport(item.fileId, item.request, item.signature);
                    const result = await terminal;
                    results.push({ fileId: item.fileId, filename: item.filename, ...result });
                    if (result.status === 'uncertain') break;
                }
            } finally {
                for (const item of items) {
                    const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
                    if (file?.status === 'queued') file.status = item.previousStatus;
                }
                this._batchFileId = null; this._batchResolve = null;
                this.batchProcessing = false;
                this.scheduleExportDrain();
                this.batchSummary = { results, completed: results.filter(result => result.status === 'complete').length,
                    failed: results.filter(result => result.status === 'error').length,
                    uncertain: results.filter(result => result.status === 'uncertain').length,
                    notStarted: items.length - results.length };
            }
        },

        /** Start one server-owned group; its UUID identifies acceptance even across refresh. */
        async submitAlbumExport(items) {
            const random = globalThis.crypto;
            const jobId = random.randomUUID ? random.randomUUID() : Array.from(random.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
            const context = { job_id: jobId, signatures: Object.fromEntries(items.map(item => [item.fileId, item.signature])) };
            this.isProcessing = true;
            for (const item of items) {
                const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
                Object.assign(file, { status: 'processing', pendingExportSignature: item.signature,
                    pendingExportAccepted: false, pendingAlbumJobId: jobId, pendingAlbumContext: context, progress: 0, error: '' });
                if (file.id === this.currentFileId) this.saveWorkspace();
                else if (this.workspaces[file.id]) Object.assign(this.workspaces[file.id], {
                    pendingExportSignature: item.signature, pendingExportAccepted: false,
                    pendingAlbumJobId: jobId, pendingAlbumContext: context });
            }
            this.persistWorkspaces();
            try {
                const response = await fetch('/api/process-album', { method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_id: jobId, files: items.map(item => item.request) }) });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    const error = data.detail || `Album export rejected (HTTP ${response.status}).`;
                    for (const item of items) this.failExport(item.fileId, error);
                    this.isProcessing = false;
                    return items.map(item => ({ fileId: item.fileId, filename: item.filename, status: 'error', error }));
                }
                const data = await response.json();
                if (data.job_id.replaceAll('-', '') !== jobId.replaceAll('-', '')) throw new Error('Album acceptance could not be confirmed.');
                for (const item of items) {
                    const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
                    file.album_job_id = data.job_id;
                    file.pendingAlbumJobId = context.job_id = data.job_id;
                    file.pendingExportAccepted = true;
                    if (this.workspaces[file.id]) Object.assign(this.workspaces[file.id], {
                        pendingAlbumJobId: data.job_id, pendingExportAccepted: true });
                }
                if (items.some(item => item.fileId === this.currentFileId)) this.saveWorkspace();
                this.persistWorkspaces();
                const terminal = new Promise(resolve => { this._albumResolve = resolve; });
                this.startAlbumPolling(data.job_id);
                this.applyAlbumJob(data);
                return await terminal;
            } catch (error) {
                // A lost acceptance response is not permission to start another export.
                const message = 'Album export status unknown. Reload to check the server before continuing.';
                for (const item of items) {
                    const file = this.uploadedFiles.find(entry => entry.id === item.fileId);
                    file.status = 'uncertain'; file.error = message;
                }
                return items.map(item => ({ fileId: item.fileId, filename: item.filename, status: 'uncertain', error: message }));
            }
        },

        /** Group outcomes become Complete only after shared tagging, never after audio alone. */
        applyAlbumJob(job) {
            if (job.job_id !== this.currentAlbumJobId) return;
            this.albumWarnings = [...new Set([...this.albumWarnings, ...(job.warnings || [])])];
            for (const item of job.files || []) {
                const file = this.uploadedFiles.find(entry => entry.id === item.file_id);
                if (!file) continue;
                file.album_job_id = job.job_id;
                file.album_job_status = job.status;
                this.exportProgress(file.id, item.progress, item.message);
                if (job.status !== 'complete') {
                    file.status = item.status === 'error' ? 'error' : 'processing';
                    if (item.error) file.error = item.error;
                }
            }
            if (job.status !== 'complete') return;
            // Assign every context first so peers validate consistently during Alpine updates.
            for (const item of job.files || []) {
                const file = this.uploadedFiles.find(entry => entry.id === item.file_id);
                if (file && item.status === 'complete') file.completedAlbumContext = file.pendingAlbumContext || file.completedAlbumContext;
            }
            const outcomes = [];
            for (const item of job.files || []) {
                const file = this.uploadedFiles.find(entry => entry.id === item.file_id);
                if (!file) continue;
                if (item.status === 'complete') {
                    this.completeExport(file.id, item.tracks || []);
                    if (item.message) file.processingMessage = item.message;
                } else this.failExport(file.id, item.error || 'Album export failed.');
                outcomes.push({ fileId: file.id, filename: file.filename, status: item.status === 'complete' ? 'complete' : 'error', error: item.error });
            }
            this.isProcessing = false;
            this.stopProcessPolling();
            this.scheduleExportDrain();
            if (this._albumResolve) {
                const resolve = this._albumResolve;
                this._albumResolve = null;
                resolve(outcomes);
            }
        },

        /** Resume observing the accepted server job; this never submits any exports. */
        startAlbumPolling(jobId) {
            this.stopProcessPolling();
            this._activeExportFileId = null;
            this.currentAlbumJobId = jobId;
            this.isProcessing = true;
            const token = this._processPollToken;
            let inFlight = false;
            this.processPollTimer = setInterval(async () => {
                if (inFlight || token !== this._processPollToken) return;
                inFlight = true;
                try {
                    const response = await fetch(`/api/process-album/${jobId}`);
                    if (token !== this._processPollToken) return;
                    if (response.status === 404) {
                        const files = this.uploadedFiles.filter(file => file.album_job_id === jobId || file.pendingAlbumJobId === jobId);
                        this.applyAlbumJob({ job_id: jobId, status: 'complete', files: files.map(file => ({ file_id: file.id, status: 'error', error: 'The album job is no longer available.' })) });
                        return;
                    }
                    if (response.ok) this.applyAlbumJob(await response.json());
                } catch (error) { console.warn('Waiting for album status:', error); }
                finally { inFlight = false; }
            }, PROCESS_POLL_INTERVAL_MS);
        },

        /** Submit one immutable request; a fast terminal event may precede its HTTP response. */
        async submitExport(fileId, request, signature) {
            const file = this.uploadedFiles.find(entry => entry.id === fileId);
            const attempt = ++this._exportAttempt;
            this._activeExportFileId = fileId;
            file.pendingExportSignature = signature;
            file.pendingExportAccepted = false;
            file.pendingAlbumJobId = null;
            file.pendingAlbumContext = null;
            file.completedAlbumContext = null;
            file.album_job_id = null;
            file.status = 'processing'; file.progress = 0; file.error = '';
            this.isProcessing = true;
            if (fileId === this.currentFileId) this.successMessage = '';
            this.exportProgress(fileId, 0.1, 'Starting…');
            if (fileId === this.currentFileId) this.saveWorkspace();
            else if (this.workspaces[fileId]) {
                this.workspaces[fileId].pendingExportSignature = signature;
                this.workspaces[fileId].pendingExportAccepted = false;
                this.persistWorkspaces();
            }
            try {
                const response = await fetch('/api/process', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
                });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    if (this._activeExportFileId === fileId && attempt === this._exportAttempt) {
                        this.failExport(fileId, data.detail || `Export rejected (HTTP ${response.status}).`);
                    }
                    return;
                }
                const data = await response.json();
                if (!data.job_id) throw new Error('The server did not return an export status.');
                if (this._activeExportFileId === fileId && attempt === this._exportAttempt) {
                    file.pendingExportAccepted = true;
                    if (fileId === this.currentFileId) this.saveWorkspace();
                    else {
                        this.workspaces[fileId].pendingExportAccepted = true;
                        this.persistWorkspaces();
                    }
                    this.startProcessPolling(data.job_id, fileId);
                }
            } catch (error) {
                if (this._activeExportFileId !== fileId || attempt !== this._exportAttempt) return;
                // The request may already be running. Never dispatch another export on a guess.
                file.status = 'uncertain';
                file.error = 'Export status unknown. Reload to check the server before continuing.';
                file.processingMessage = file.error;
                if (fileId === this.currentFileId) this.processingMessage = file.error;
                if (this._batchResolve && this._batchFileId === fileId) {
                    const resolve = this._batchResolve;
                    this._batchResolve = null;
                    resolve({ status: 'uncertain', error: file.error });
                } else {
                    this.notify(file.error, { type: 'error' });
                    this.scheduleExportDrain();   // halts anything queued behind the unknown export
                }
            }
        },

        /** Polling is the fallback for missed WebSocket events, scoped to the current attempt. */
        startProcessPolling(jobId, fileId = this._activeExportFileId || this.currentFileId) {
            this.stopProcessPolling();
            this.currentJobId = jobId;
            this._activeExportFileId = fileId;
            const token = this._processPollToken;
            let inFlight = false;
            this.processPollTimer = setInterval(async () => {
                if (!this.isProcessing || token !== this._processPollToken || inFlight) return;
                inFlight = true;
                try {
                    const response = await fetch(`/api/process/${jobId}`);
                    if (token !== this._processPollToken) return;
                    if (response.status === 404) {
                        this.failExport(fileId, 'The recording session is no longer available.');
                        return;
                    }
                    if (!response.ok) return;
                    const job = await response.json();
                    if (token !== this._processPollToken || job.file_id !== fileId) return;
                    if (job.status === 'processing') this.exportProgress(fileId, job.progress || 0.1, job.message);
                    if (job.status === 'complete') this.completeExport(fileId, job.tracks || []);
                    if (job.status === 'error') this.failExport(fileId, job.error || 'Unknown export error');
                } catch (error) {
                    console.warn('Waiting for export status:', error);
                } finally { inFlight = false; }
            }, PROCESS_POLL_INTERVAL_MS);
        },

        stopProcessPolling() {
            this._processPollToken++;
            if (this.processPollTimer) {
                clearInterval(this.processPollTimer);
                this.processPollTimer = null;
            }
            this.currentJobId = null;
            this.currentAlbumJobId = null;
        },

        /**
         * Reset UI for next file
         */
        resetForNextFile() {
            if (this.currentLocked) return;
            this.saveWorkspace();
            // A playing waveform or fallback <audio> would go on with nothing to control it
            this.destroyWaveform();
            this.currentFileId = null;
            this.currentFile = null;
            // Another recording's export may be running: leave its polling and flag alone.
            this.abReset();
            this.successMessage = '';
            this.detectedTracks = [];
            this.resetEditState();
            this.searchSeq++;
            this.resetSearchResults();
            this.detailsSettled = false;
            this.selectedRelease = null;
            this._pendingPickId = null;
            this.resetDonors();
            this.searchQuery = '';
            this.processingProgress = 0;
            this.processingMessage = '';

            const nextFile = this.uploadedFiles.find(f => f.status === 'uploaded');
            if (nextFile) {
                this.selectFile(nextFile.id);
            } else {
                this.currentFileId = null;
                this.currentFile = null;
            }
        },

        /**
         * Clean filename for Discogs search
         */
        cleanFilename(filename) {
            // Remove all supported extensions
            let name = filename.replace(/\.(wav|aiff|aif)$/i, '');
            name = name.replace(/[-_]+/g, ' ');
            name = name.replace(/\s+/g, ' ').trim();
            return name;
        },

        formatSize(bytes) {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        },

        formatDuration(seconds) {
            if (!seconds) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        formatTime(seconds) {
            return this.formatDuration(seconds);
        },

        statusClass(status) {
            switch (status) {
                case 'uploaded': return 'text-blue-600 font-medium';
                case 'analyzed': return 'text-purple-600 font-medium';
                case 'processing': return 'text-yellow-600 font-medium';
                case 'completed': return 'text-green-600 font-medium';
                case 'error': return 'text-red-600 font-medium';
                default: return 'text-gray-600';
            }
        }
    };
}
