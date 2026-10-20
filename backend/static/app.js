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
// Ghost marker (Discogs-expected boundary) colour
const EXPECTED_MARKER_COLOR = 'rgba(217, 64, 50, 0.75)';
// Longest title shown in a waveform region label
const REGION_TITLE_MAX = 28;

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

// Density strip: a thin canvas overlaid on the bottom of the waveform wrapper.
const CLICK_STRIP_HEIGHT = 6;
const CLICK_STRIP_MAX_PX = 16384;   // browsers cap canvas width (~32k); CSS stretches it
const CLICK_STRIP_COLOR = '217, 64, 50';

// A/B "Removed" boost: audio element -> { ctx, source, gain } (one MediaElementSource per element)
const _abBoostNodes = new WeakMap();

function vinylApp() {
    return {
        // WebSocket connection
        ws: null,
        wsPingTimer: null,

        // UI State
        dragging: false,
        showSettings: false,
        uploadProgress: 0,
        uploadFinalizing: false,
        uploadNotice: '',
        analyzing: false,
        searchLoading: false,
        searchNotice: '',
        trackCountMismatch: false,
        autoRetryAttempts: 0,
        maxAutoRetries: 3,

        // Files and Queue
        uploadedFiles: [],
        currentFileId: null,
        currentFile: null,

        // Analysis
        detectedTracks: [],

        // Waveform
        isPlaying: false,
        playTime: 0,
        playDuration: 0,
        playheadIdx: -1,       // index of the track under the playhead (-1 = gap / none)
        playerNotice: '',
        _auditionStop: null,   // one-shot stop time (s) for cut-point auditions
        _regionDownX: null,
        _spaceToggled: false,  // space toggled playback; swallow the matching keyup
        waveform: null,
        waveformLoading: false,
        waveformRegions: null,
        currentZoom: 50,

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
        expectedBoundaries: [],   // Seconds where Discogs lengths put each break (ghost markers)
        boundariesEdited: false,  // True once the user hand-edits boundaries (until detection replaces them)
        editBanner: false,        // Show "You've adjusted boundaries by hand" choice
        snapUndo: null,           // Snapshot taken before Snap to Discogs
        snapNotice: '',
        onlyWithLengths: false,   // Result filter: hide releases without track lengths
        selectedSides: [],        // Side keys ('A', 'B', '' = unlettered) the recording covers
        suggestedSides: [],       // Sides auto-picked when the release was selected
        sidesMatchedByDuration: false,
        sidesSuggestionReason: '',   // 'length' | 'default' | 'single' | '' (how suggestedSides was chosen)
        releaseChoices: {},          // fileId -> { release, sides } chosen for that queue file
        // Borrow track lengths from another pressing (state for the selected release only)
        donors: { releaseId: null, status: 'idle', checked: 0, budget: 12, list: [], error: '' },
        _donorSeq: 0,             // Guards against stale length-donor responses
        searchSeq: 0,             // Guards against stale search responses
        detailsSettled: false,    // True once every result's tracklist load finished/failed
        _detailInflight: {},      // release id -> in-flight detail fetch promise

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
        lastProgressAt: null,

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
        pendingRemovals: {},   // fileId -> { file, index, choice, toastId, committed }

        // Config
        config: {
            silence_threshold: -40,
            min_silence_duration: 1.5,
            track_numbering: 'vinyl',
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
            replaygain: true
        },

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

            // Space bar toggles waveform play/pause
            document.addEventListener('keydown', (e) => this.onGlobalKeydown(e));
            document.addEventListener('keyup', (e) => this.onGlobalKeyup(e));

            // Files removed from the queue are deleted server-side after an
            // undo window; flush them if the page goes away first.
            window.addEventListener('pagehide', () => this.commitAllRemovals({ keepalive: true }));

            // Keep waveform region labels in step with the mapping
            this.$watch('customMapping', () => this.refreshRegionLabels());
            this.$watch('selectedRelease', () => this.refreshRegionLabels());
            this.$watch('selectedSides', () => this.refreshRegionLabels());

            await this.loadConfig();
            await this.loadFormats();
            // Fall back to FLAC if the remembered format isn't offered by the backend
            if (!this.availableFormats.some(f => f.id === this.outputFormat)) {
                this.outputFormat = 'flac';
            }
            await this.checkStatus();
            this.connectWebSocket();

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
         *  - onClose(reason): reason is 'timeout' | 'dismiss' | 'action' (used by undo flows)
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
                onClose: opts.onClose || null,
                role: type === 'error' || type === 'warning' ? 'alert' : 'status'
            });
            // Keep the stack short; the oldest toast makes room
            while (this.toasts.length > 5) this.dismissToast(this.toasts[0].id, 'dismiss');
            this._armToast(id, timeout);
            return id;
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
                    if (data.file_id === this.currentFileId) {
                        this.processingProgress = data.progress;
                        this.processingMessage = data.message;
                        this.lastProgressAt = Date.now();
                    }
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
                    if (data.file_id === this.currentFileId) {
                        this.stopProcessPolling();
                        this.processingProgress = 1.0;
                        this.processingMessage = 'Complete!';
                        this.isProcessing = false;
                        this.successMessage = `✅ ${data.tracks.length} tracks saved to your VinylFlow/output folder\n\nTracks: ${data.tracks.join(', ')}`;

                        const file = this.uploadedFiles.find(f => f.id === data.file_id);
                        if (file) {
                            file.status = 'completed';
                        }
                    }
                    break;

                case 'error':
                    if (data.file_id === this.currentFileId) {
                        this.stopProcessPolling();
                        this.isProcessing = false;
                        this.processingMessage = `Error: ${data.message}`;
                        this.notify(`Processing error: ${data.message}`, { type: 'error' });

                        const file = this.uploadedFiles.find(f => f.id === data.file_id);
                        if (file) {
                            file.status = 'error';
                        }
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

        /**
         * Save configuration to API
         */
        async saveConfig() {
            try {
                const response = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.configPayload())
                });
                const data = await response.json();
                this.config = data;
                this.outputFormat = data.output_format || 'flac';
                this.rumbleFilter = !!data.rumble_filter;
                this.declick = this.normDeclick(data.declick);
                this.albumGain = !!data.album_gain;
                this.syncCleanupFromConfig(data);
                this.showSettings = false;
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
            const { restoration_level, ...rest } = this.config;
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
            this.abReset();
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
            this.searchResults = [];
            this.detailsSettled = false;
            this.selectedRelease = null;
            this.resetDonors();
            this.selectedSides = [];
            this.suggestedSides = [];
            this.sidesMatchedByDuration = false;
            this.sidesSuggestionReason = '';
            this.customMapping = [];
            this.trackCountMismatch = false;
            this.searchNotice = '';
            this.searchLoading = false;
            this.searchSeq++;
            this.rescanNotice = '';
            this.successMessage = '';
            this.processingProgress = 0;
            this.processingMessage = '';

            this.destroyWaveform();

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
            const entry = {
                file, index,
                choice: this.releaseChoices[fileId] || null,
                wasCurrent: this.currentFileId === fileId,
                committed: false,
                toastId: null
            };
            this.pendingRemovals = { ...this.pendingRemovals, [fileId]: entry };

            this.uploadedFiles = this.uploadedFiles.filter(f => f.id !== fileId);
            this.forgetChoice(fileId);
            if (entry.wasCurrent) {
                this.pauseWaveform();
                this.destroyWaveform();
                this.currentFileId = null;
                this.currentFile = null;
                this.detectedTracks = [];
                this.resetEditState();
            }

            entry.toastId = this.notify(`Removed "${this.shortFilename(file.filename)}" from the queue.`, {
                type: 'info',
                timeout: undoMs,
                action: { label: 'Undo', fn: () => this.undoRemoveFile(fileId) },
                onClose: (reason) => { if (reason !== 'action') this.commitRemoval(fileId); }
            });
        },

        /** Put a soft-removed file back in its old queue position */
        undoRemoveFile(fileId) {
            const entry = this.pendingRemovals[fileId];
            if (!entry || entry.committed) return;
            const next = { ...this.pendingRemovals };
            delete next[fileId];
            this.pendingRemovals = next;

            const files = [...this.uploadedFiles];
            files.splice(Math.min(entry.index, files.length), 0, entry.file);
            this.uploadedFiles = files;
            if (entry.choice) {
                this.releaseChoices = { ...this.releaseChoices, [fileId]: entry.choice };
            }
            if (entry.wasCurrent && !this.currentFileId) {
                this.selectFile(fileId);
            }
        },

        /** Really delete a soft-removed file on the server */
        async commitRemoval(fileId, { keepalive = false } = {}) {
            const entry = this.pendingRemovals[fileId];
            if (!entry || entry.committed) return;
            entry.committed = true;
            if (entry.toastId) this.dismissToast(entry.toastId, 'commit');
            try {
                const response = await fetch(`/api/queue/${fileId}`, { method: 'DELETE', keepalive });
                if (!response.ok && response.status !== 404) {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                // Server still has it: bring the file back so the queue
                // reflects reality, and say so.
                console.error('Failed to remove file:', error);
                if (!this.uploadedFiles.some(f => f.id === fileId)) {
                    this.uploadedFiles = [...this.uploadedFiles, entry.file];
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

        /**
         * Analyze file for silence detection
         */
        async analyzeFile() {
            if (!this.currentFileId || this.analyzing) return;

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

                await this.initWaveform();
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
            if (!this.currentFileId || this.analyzing) return;

            const fileId = this.currentFileId;
            const snapshot = this.snapshotEdits();
            snapshot.selectedRelease = this.selectedRelease;
            snapshot.selectedSides = [...this.selectedSides];
            snapshot.suggestedSides = [...this.suggestedSides];
            snapshot.choice = this.releaseChoices[fileId] || null;
            snapshot.status = this.currentFile?.status;

            this.detectedTracks = [];
            this.resetEditState();
            this.selectedRelease = null;
            this.resetDonors();
            this.selectedSides = [];
            this.trackMappingReversed = false;
            this.customMapping = [];

            this.pauseWaveform();

            this.destroyWaveform();
            await this.analyzeFile();

            if (this.currentFileId === fileId && this.detectedTracks.length > 0) {
                this.notify('Re-analyzed. Boundaries and release were reset.', {
                    type: 'info',
                    timeout: 8000,
                    action: { label: 'Undo', fn: () => this.restoreReanalyze(fileId, snapshot) }
                });
            }
        },

        /** Undo a re-analysis: previous tracks, release, sides and mapping */
        async restoreReanalyze(fileId, snap) {
            if (this.currentFileId !== fileId) {
                this.notify('Switch back to that file to undo the re-analysis.', { type: 'warning', timeout: 6000 });
                return;
            }
            this.pauseWaveform();
            this.restoreEdits(snap, { rebuildRegions: false });
            this.selectedRelease = snap.selectedRelease;
            this.resetDonors();
            this.selectedSides = snap.selectedSides;
            this.suggestedSides = snap.suggestedSides;
            if (snap.choice) {
                this.releaseChoices = { ...this.releaseChoices, [fileId]: snap.choice };
            }
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
            if (!this.currentFileId || this.analyzing) return;
            if (!target || target < 1 || target > 99) {
                this.rescanNotice = 'Enter how many songs the recording contains (1–99) first.';
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
            this.searchResults = [];
            this.detailsSettled = false;
            this.searchNotice = '';
            const seq = ++this.searchSeq;

            try {
                const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: this.searchQuery,
                        max_results: 12
                    })
                });
                const data = await response.json();
                if (seq !== this.searchSeq) return;   // a newer search/file superseded this one

                // Surface the server's error (missing token, network down)
                // instead of corrupting searchResults with undefined.
                if (!response.ok || !Array.isArray(data.results)) {
                    throw new Error(data.detail || 'Search failed');
                }

                // tracks: null = not loaded yet; filled in progressively below.
                this.searchResults = data.results.map(r => ({ ...r, tracks: r.tracks ?? null, detailStatus: 'pending', opening: false }));

                if (this.searchResults.length === 0) {
                    this.searchNotice = 'No results found. Try a different search query.';
                } else {
                    // Not awaited: cards are already visible.
                    this.loadAllReleaseDetails(seq);
                }
            } catch (error) {
                if (seq !== this.searchSeq) return;
                console.error('Search failed:', error);
                this.searchResults = [];
                this.searchNotice = 'Search failed: ' + error.message;
            } finally {
                if (seq === this.searchSeq) {
                    this.searchLoading = false;
                }
            }
        },

        /**
         * Fetch full tracklists for the current results in display order,
         * two at a time (the server rate-limits Discogs anyway).  Stops as
         * soon as searchSeq moves on (new search or file switch).
         */
        async loadAllReleaseDetails(seq, concurrency = 2) {
            const ids = this.searchResults.map(r => r.id);
            let next = 0;
            const worker = async () => {
                while (seq === this.searchSeq && next < ids.length) {
                    await this.loadReleaseDetails(ids[next++], seq);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
            if (seq === this.searchSeq) this.detailsSettled = true;
        },

        /**
         * Fetch one release's full details and merge them into its result
         * card.  Shares in-flight requests (click vs. background loader).
         * Resolves true when the tracklist is loaded.
         */
        loadReleaseDetails(id, seq = this.searchSeq) {
            const existing = this.searchResults.find(r => r.id === id);
            if (existing && existing.tracks) return Promise.resolve(true);
            if (this._detailInflight[id]) return this._detailInflight[id];

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
                    delete this._detailInflight[id];
                }
            })();
            this._detailInflight[id] = promise;
            return promise;
        },

        /**
         * Card click: make sure the tracklist is loaded, then select.
         */
        async chooseResult(result) {
            if (this.analyzing || result.opening) return;
            if (result.tracks) {
                this.selectRelease(result);
                return;
            }
            const seq = this.searchSeq;
            result.opening = true;
            try {
                const ok = await this.loadReleaseDetails(result.id, seq);
                if (ok && seq === this.searchSeq) {
                    const fresh = this.searchResults.find(r => r.id === result.id);
                    if (fresh) this.selectRelease(fresh);
                }
            } finally {
                result.opening = false;
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

        /**
         * Remember which release/sides the current file uses
         */
        rememberChoice() {
            if (!this.currentFileId || !this.selectedRelease) return;
            this.releaseChoices = {
                ...this.releaseChoices,
                [this.currentFileId]: { release: this.selectedRelease, sides: [...this.selectedSides] }
            };
        },

        /**
         * Drop a file's remembered release choice (file removed / release changed)
         */
        forgetChoice(fileId) {
            if (!(fileId in this.releaseChoices)) return;
            const next = { ...this.releaseChoices };
            delete next[fileId];
            this.releaseChoices = next;
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
            if (this.analyzing) return;
            this.selectedSides = this.sideChips.map(g => g.side).filter(k => sides.includes(k));
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
            if (this.analyzing || !this.selectedRelease || this.targetTracks.length < 1) return;

            const snapshot = {
                tracks: JSON.parse(JSON.stringify(this.detectedTracks)),
                mapping: [...this.customMapping],
                reversed: this.trackMappingReversed,
                expected: [...this.expectedBoundaries],
                edited: this.boundariesEdited
            };
            this.editBanner = false;

            const ok = await this.redetectForTargets();
            if (ok) {
                this.snapUndo = snapshot;
                this.snapNotice = 'Snapped to Discogs.';
            }
        },

        /**
         * Restore the boundaries and mapping from before the last snap
         */
        undoSnap() {
            const snap = this.snapUndo;
            if (!snap) return;

            this.detectedTracks = snap.tracks;
            this.customMapping = snap.mapping;
            this.trackMappingReversed = snap.reversed;
            this.expectedBoundaries = snap.expected;
            this.boundariesEdited = snap.edited;
            this.snapUndo = null;
            this.snapNotice = '';
            this.rescanNotice = '';
            this.editBanner = false;
            this.trackCountMismatch = !!this.selectedRelease &&
                this.activeTrackCount !== this.targetTracks.length;

            if (this.waveformRegions && this.waveform) {
                this.addTrackRegions();
            }
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
         * Select a release from search results, resolve which side(s) the
         * recording covers and (re)run detection for that many tracks.
         */
        selectRelease(release) {
            if (this.analyzing) return;

            this.selectedRelease = release;
            this.resetDonors();
            const suggestion = this.suggestSides(
                release,
                this.currentFile?.musicDuration || this.currentFile?.duration,
                Object.keys(this.sidesUsedByOthers(release))
            );
            this.selectedSides = suggestion.sides;
            this.suggestedSides = suggestion.sides;
            this.sidesMatchedByDuration = suggestion.matched;
            this.sidesSuggestionReason = suggestion.reason;
            this.rememberChoice();

            this.resetMappingToTargets();
            this.afterTargetsChanged();
        },

        /**
         * Toggle a side chip (multi-select, at least one side stays selected)
         * and re-run detection for the new track count.
         */
        toggleSide(side) {
            if (this.analyzing) return;

            const isSelected = this.selectedSides.includes(side);
            if (isSelected && this.selectedSides.length === 1) return;

            const wanted = isSelected
                ? this.selectedSides.filter(s => s !== side)
                : [...this.selectedSides, side];
            // Keep release order regardless of click order
            this.selectedSides = this.sideChips.map(g => g.side).filter(s => wanted.includes(s));
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
            if (count < 1 || !this.currentFileId || this.analyzing) return false;

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
                        file_id: this.currentFileId,
                        expected_tracks: count,
                        durations: targets.map(t => this.parseTrackDuration(t.duration))
                    })
                });
                const data = await response.json();

                if (!response.ok || !data.tracks) {
                    throw new Error(data.detail || 'Boundary detection failed');
                }

                this.setDetectedTracks(data.tracks, {
                    expected: data.method === 'durations'
                        ? (data.boundaries || []).map(b => b.expected).filter(x => Number.isFinite(x))
                        : []
                });
                this.processingMessage = '';

                const file = this.uploadedFiles.find(f => f.id === this.currentFileId);
                if (file) {
                    file.status = 'analyzed';
                }
                this.applyScan(this.currentFileId, data);

                if (this.selectedRelease) {
                    this.resetMappingToTargets();
                }

                this.destroyWaveform();
                await this.$nextTick();
                await this.initWaveform();

                if (data.method === 'durations') {
                    const snapped = (data.boundaries || []).filter(b => b.snapped).length;
                    this.rescanNotice = `✅ Placed ${data.tracks.length} tracks from Discogs lengths (${snapped} of ${(data.boundaries || []).length} boundaries snapped to silence).`;
                } else {
                    this.rescanNotice = data.matched
                        ? `✅ Placed ${data.tracks.length} tracks by track count (Discogs lengths unavailable).`
                        : `⚠️ Couldn't find exactly ${count} tracks — closest result is ${data.tracks.length}. Right-click the waveform to add or remove splits manually.`;
                }
                succeeded = true;
            } catch (error) {
                console.error('Guided detection failed:', error);
                this.rescanNotice = '❌ Boundary detection failed: ' + error.message;
                this.processingMessage = '';
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
            this.donors = { releaseId: null, status: 'idle', checked: 0, budget: 12, list: [], error: '' };
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

        /** Marker for the selected release (lives on the release object, so it
         *  follows the object when another file reuses the same release) */
        get lengthsBorrowedFrom() {
            return this.selectedRelease?.lengthsBorrowedFrom || null;
        },

        borrowedLabel(b) {
            const parts = [b?.label, b?.year, b?.country].filter(x => x !== undefined && x !== null && x !== '');
            return parts.join(', ') || `release ${b?.release_id}`;
        },

        donorTitle(d) {
            return [d.label, d.year, d.country, d.format].filter(x => x !== undefined && x !== null && x !== '').join(' · ');
        },

        async findLengthDonors() {
            const release = this.selectedRelease;
            if (!release || this.donors.status === 'searching') return;
            const seq = ++this._donorSeq;
            const id = release.id;
            this.donors = { releaseId: id, status: 'searching', checked: 0, budget: 12, list: [], error: '' };
            try {
                const res = await fetch(`/api/release/${id}/length-donors`);
                let body = null;
                try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
                if (seq !== this._donorSeq) return;
                if (!res.ok) {
                    throw new Error((body && body.detail) || 'Could not look for other pressings.');
                }
                this.donors = {
                    ...this.donors, status: 'done',
                    list: Array.isArray(body?.donors) ? body.donors : []
                };
            } catch (error) {
                if (seq !== this._donorSeq) return;
                this.donors = {
                    ...this.donors, status: 'error', list: [],
                    error: error.message || 'Could not look for other pressings.'
                };
            }
        },

        /**
         * Copy a donor's lengths onto the selected release's tracks (missing
         * lengths only), mark the release as borrowed, re-detect, offer Undo.
         * The release object is mutated in place: releaseChoices and the
         * same-release shortcut share it, so other files see the lengths too.
         */
        applyDonor(donor) {
            const release = this.selectedRelease;
            if (!release || !donor) return;
            const originals = (release.tracks || []).map(t => t.duration);
            const previousMarker = release.lengthsBorrowedFrom || null;

            let filled = 0;
            for (const [key, length] of Object.entries(donor.lengths || {})) {
                const t = release.tracks?.[Number(key)];
                if (!t || this.parseTrackDuration(t.duration) !== null) continue;
                if (this.parseTrackDuration(length) === null) continue;
                t.duration = length;
                filled++;
            }
            if (filled === 0) {
                this.notify('That pressing has no lengths this release is missing.', { type: 'info' });
                return;
            }
            release.lengthsBorrowedFrom = {
                release_id: donor.release_id, label: donor.label, year: donor.year, country: donor.country
            };
            const fileId = this.currentFileId;
            this.resetDonors();
            this.afterTargetsChanged();

            this.notify(`Borrowed ${filled} track length${filled === 1 ? '' : 's'} from ${this.borrowedLabel(release.lengthsBorrowedFrom)}.`, {
                type: 'success',
                timeout: 8000,
                action: {
                    label: 'Undo',
                    fn: () => {
                        release.tracks.forEach((t, i) => { if (i < originals.length) t.duration = originals[i]; });
                        release.lengthsBorrowedFrom = previousMarker;
                        if (this.currentFileId === fileId && this.selectedRelease?.id === release.id) {
                            this.afterTargetsChanged();
                        }
                    }
                }
            });
        },

        /**
         * Drop the selected release but keep search results and the current
         * detection/waveform so another release can be picked.
         */
        changeRelease() {
            this.forgetChoice(this.currentFileId);
            this.selectedRelease = null;
            this.resetDonors();
            this.selectedSides = [];
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
            const mapping = [...this.customMapping];
            mapping[idx] = Number(value);
            this.customMapping = mapping;
            this.trackMappingReversed = false;
            this.refreshRegionLabels();
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

        /**
         * Update track start time (inline Adjust)
         */
        updateTrackStart(idx, value) {
            const newStart = parseFloat(value);
            const track = this.detectedTracks[idx];
            if (!track || isNaN(newStart) || newStart < 0) return;
            this.applyTrackBounds(idx, newStart, track.end);
            this.syncRegionsAround(idx);
        },

        /**
         * Update track end time (inline Adjust)
         */
        updateTrackEnd(idx, value) {
            const newEnd = parseFloat(value);
            const track = this.detectedTracks[idx];
            if (!track || isNaN(newEnd) || newEnd < 0) return;
            this.applyTrackBounds(idx, track.start, newEnd);
            this.syncRegionsAround(idx);
        },

        /**
         * Move track idx to [start, end].  Neighbours are only pushed when
         * the regions would overlap (gaps are preserved); every track keeps
         * at least MIN_TRACK_LENGTH.  Returns true when anything changed.
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

            start = Math.max(0, start);
            if (startMoved && endMoved) {
                // Whole-region drag: keep the length, stop at the neighbours' minimum
                const len = end - start;
                if (next && end > next.end - MIN) { end = next.end - MIN; start = end - len; }
                if (prev && start < prev.start + MIN) { start = prev.start + MIN; end = start + len; }
                if (start < 0) { end -= start; start = 0; }
            } else if (endMoved) {
                if (next) end = Math.min(end, next.end - MIN);
                end = Math.max(end, start + MIN);
            } else {
                if (prev) start = Math.max(start, prev.start + MIN);
                start = Math.min(start, end - MIN);
            }

            const valid = end - start >= MIN - EPS &&
                (!next || next.end - Math.max(next.start, end) >= MIN - EPS) &&
                (!prev || Math.min(prev.end, start) - prev.start >= MIN - EPS);
            if (!valid) return false;

            const changed = Math.abs(start - track.start) > EPS || Math.abs(end - track.end) > EPS;
            if (!changed) return false;

            track.start = start;
            track.end = end;
            track.duration = end - start;
            if (next && end > next.start) {
                next.start = end;
                next.duration = next.end - next.start;
            }
            if (prev && start < prev.end) {
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

                // Default MediaElement backend: renders instantly from the
                // precomputed peaks and streams audio on demand, instead of
                // WebAudio which downloads + decodes the whole file up front.
                //
                // height:'auto' fills the #waveform container, which MUST
                // have a fixed CSS height (see index.html) — a min-height
                // floor lets the canvas/container feedback loop grow the
                // waveform forever on fractional-DPI Windows displays (#63).
                this.waveform = WaveSurfer.create({
                    container: '#waveform',
                    waveColor: '#93c5fd',
                    progressColor: '#1d4ed8',
                    cursorColor: '#1e40af',
                    height: 'auto',
                    normalize: true,
                    barWidth: 2,
                    barGap: 1
                });

                // With MediaElement + provided peaks, load() resolves without
                // fetching the audio — a later fetch failure only surfaces as
                // an 'error' event, which must clear the loading spinner.
                this.waveform.on('error', (err) => {
                    console.error('Waveform error:', err);
                    this.waveformLoading = false;
                    this.showPlayerNotice('Audio playback error: ' + ((err && err.message) || err || 'unknown'));
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
                this.waveform.on('audioprocess', (t) => this.onPlayerTime(t));
                // User clicked/dragged on the waveform itself: abandon any audition
                this.waveform.on('interaction', () => this.cancelAudition());

                this.waveformRegions = this.waveform.registerPlugin(WaveSurfer.Regions.create());

                const peaksResponse = await fetch(`/api/waveform-peaks/${this.currentFileId}`);
                if (!peaksResponse.ok) {
                    throw new Error('Failed to load waveform peaks');
                }
                const peaksData = await peaksResponse.json();

                this.waveform.on('ready', () => {
                    console.log('Waveform ready');

                    const duration = this.waveform.getDuration();
                    this.playDuration = duration;
                    const container = document.getElementById('waveform');
                    const containerWidth = container ? container.offsetWidth : 1000;

                    const calculatedZoom = containerWidth / duration;
                    this.currentZoom = Math.max(1, Math.min(calculatedZoom, 200));
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
                    container.addEventListener('contextmenu', openWaveformContextMenu);
                    container.addEventListener('mousedown', openWaveformContextMenu);

                    setTimeout(() => {
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
                        const openRegionContextMenu = (e) => {
                            const isSecondaryClick = e.type === 'contextmenu' || e.button === 2 || (e.button === 0 && e.ctrlKey);
                            if (!isSecondaryClick) {
                                return;
                            }

                            if (e.target.classList.contains('wavesurfer-handle')) {
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

                        regionElement.addEventListener('mousedown', (e) => { this._regionDownX = e.clientX; });
                        regionElement.addEventListener('contextmenu', openRegionContextMenu);
                        regionElement.addEventListener('mousedown', openRegionContextMenu);
                    }
                });

                // Pass duration only when valid — WaveSurfer can then render
                // immediately from pre-computed peaks without fetching the audio.
                // If duration is missing or 0 (probe failed at upload), omit it
                // so WaveSurfer falls back to fetching the file (slower but safe).
                const knownDuration = peaksData.duration > 0 ? peaksData.duration : undefined;
                await this.waveform.load(`/api/audio/${this.currentFileId}`, [peaksData.peaks], knownDuration);

            } catch (error) {
                console.error('Waveform initialization failed:', error);
                this.notifyError('Failed to load waveform', error);
                this.waveformLoading = false;
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
                        drag: true,
                        resize: true,
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
                this.notify('Cannot split here: the position must be inside a track, not on a boundary.', { type: 'warning', timeout: 6000 });
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
                this.notify('Cannot split here: the position must be inside a track, not on a boundary.', { type: 'warning', timeout: 6000 });
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

            this.notify(`Deleted track ${trackNumber}.`, {
                type: 'info',
                timeout: 8000,
                action: {
                    label: 'Undo',
                    fn: () => {
                        if (this.currentFileId !== fileId) return;
                        this.restoreEdits(snapshot);
                    }
                }
            });
        },

        renumberTracks() {
            this.detectedTracks.forEach((track, i) => { track.number = i + 1; });
        },

        /**
         * Get count of non-ignored tracks
         */
        get activeTrackCount() {
            return this.detectedTracks.filter(t => !t.ignored).length;
        },

        /**
         * Toggle track ignored status and update region color
         */
        toggleTrackIgnored(track) {
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
                const title = String(dt.title ?? '');
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

            this.applyTrackBounds(idx, region.start, region.end);
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
            if (!this.waveform) return;
            this.abPause();   // one player at a time
            try {
                const p = this.waveform.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => { this.playerNotice = ''; }, (err) => {
                        console.error('Playback failed:', err);
                        this.isPlaying = false;
                        this.showPlayerNotice('Could not start playback: ' + ((err && err.message) || err || 'unknown error'));
                    });
                } else {
                    this.playerNotice = '';
                }
            } catch (err) {
                console.error('Playback failed:', err);
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
            if (!this.waveform) return;
            this.waveform.setTime(time);
            this.updateCurrentTrack(time);
        },

        /**
         * Space bar toggles playback unless the user is typing or a modal is open
         */
        onGlobalKeydown(e) {
            if (e.code !== 'Space' && e.key !== ' ') return;
            if (e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
            if (!this.waveform) return;
            if (this.showSettings || this.setupRequired) return;
            const el = e.target;
            const tag = el && el.tagName ? String(el.tagName).toUpperCase() : '';
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
            e.preventDefault();
            // A focused button (e.g. ▶️ just clicked) would also "click" on
            // keyup and toggle straight back — swallow that keyup.
            this._spaceToggled = true;
            this.togglePlay();
        },

        /**
         * Pairs with onGlobalKeydown: cancel the focused button's keyup activation
         */
        onGlobalKeyup(e) {
            if (e.code !== 'Space' && e.key !== ' ') return;
            if (!this._spaceToggled) return;
            this._spaceToggled = false;
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
         * Region click: seek to the click position (primary, undragged clicks only)
         */
        onRegionClicked(region, e) {
            if (!this.waveform || !e) return;
            if (e.button !== undefined && e.button !== 0) return;
            if (e.ctrlKey || e.metaKey) return;
            if (String(region.id).startsWith('expected-')) return;
            if (e.target && e.target.classList && e.target.classList.contains('wavesurfer-handle')) return;
            const down = this._regionDownX;
            this._regionDownX = null;
            if (down !== null && Math.abs(e.clientX - down) > 3) return;  // drag end, not a click
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
            this._auditionStop = null;
        },

        /**
         * Process file with selected release
         */
        async processFile() {
            if (!this.currentFileId || !this.selectedRelease) return;

            const activeTracks = this.detectedTracks.filter(t => !t.ignored);

            if (activeTracks.length === 0) {
                this.notify('No tracks selected for processing. Un-ignore at least one track.', { type: 'warning', timeout: 6000 });
                return;
            }

            const trackMapping = activeTracks.map((track, idx) => {
                const originalIdx = this.detectedTracks.indexOf(track);
                const discogsIdx = this.customMapping[originalIdx];
                const discogsTrack = this.selectedRelease.tracks[discogsIdx];
                return {
                    detected: track.number,
                    discogs: discogsTrack?.position || 'Unknown'
                };
            });

            const trackBoundaries = activeTracks.map(track => ({
                number: track.number,
                start: track.start,
                end: track.end,
                duration: track.duration,
                // per-track click-removal override; omitted = the panel setting
                declick: track.declick || undefined
            }));

            try {
                this.isProcessing = true;
                this.processingProgress = 0.1;
                this.processingMessage = 'Starting...';
                this.lastProgressAt = Date.now();

                const response = await fetch('/api/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: this.currentFileId,
                        release_id: this.selectedRelease.id,
                        track_mapping: trackMapping,
                        reversed: this.trackMappingReversed,
                        track_boundaries: trackBoundaries,
                        output_format: this.outputFormat,
                        rumble_filter: this.rumbleFilter,
                        declick: this.declick,
                        hum_filter: this.humFilter,
                        hum_freq: this.humFreq,
                        hiss_reduction: this.hissReduction,
                        album_gain: this.albumGain,
                        replaygain: this.config.replaygain !== false
                    })
                });

                const data = await response.json();
                if (!response.ok || !data.job_id) {
                    throw new Error(data.detail || 'Failed to start processing');
                }
                console.log('Processing started:', data);
                this.currentJobId = data.job_id;
                this.startProcessPolling(data.job_id);

                const file = this.uploadedFiles.find(f => f.id === this.currentFileId);
                if (file) {
                    file.status = 'processing';
                }
            } catch (error) {
                console.error('Processing failed:', error);
                this.stopProcessPolling();
                this.isProcessing = false;
                this.processingProgress = 0;
                this.processingMessage = '';
                this.notifyError('Processing failed', error);
            }
        },

        startProcessPolling(jobId) {
            this.stopProcessPolling();

            this.processPollTimer = setInterval(async () => {
                if (!this.isProcessing || !jobId) {
                    this.stopProcessPolling();
                    return;
                }

                try {
                    const response = await fetch(`/api/process/${jobId}`);
                    if (!response.ok) {
                        return;
                    }

                    const job = await response.json();

                    if (job.status === 'processing') {
                        this.processingProgress = Math.max(this.processingProgress, job.progress || 0.1);
                        this.processingMessage = job.message || 'Processing...';
                        return;
                    }

                    if (job.status === 'complete') {
                        this.stopProcessPolling();
                        this.processingProgress = 1.0;
                        this.processingMessage = 'Complete!';
                        this.isProcessing = false;

                        const tracks = Array.isArray(job.tracks) ? job.tracks : [];
                        if (tracks.length > 0) {
                            this.successMessage = `✅ ${tracks.length} tracks saved to your VinylFlow/output folder\n\nTracks: ${tracks.join(', ')}`;
                        } else {
                            this.successMessage = '✅ Processing complete. Files saved to your VinylFlow/output folder.';
                        }

                        const file = this.uploadedFiles.find(f => f.id === job.file_id);
                        if (file) {
                            file.status = 'completed';
                        }
                        return;
                    }

                    if (job.status === 'error') {
                        this.stopProcessPolling();
                        this.isProcessing = false;
                        this.processingMessage = `Error: ${job.error || 'Unknown error'}`;

                        const file = this.uploadedFiles.find(f => f.id === job.file_id);
                        if (file) {
                            file.status = 'error';
                        }

                        this.notify(`Processing error: ${job.error || 'Unknown error'}`, { type: 'error' });
                    }
                } catch (error) {
                    console.warn('Process polling failed:', error);
                }
            }, 1500);
        },

        stopProcessPolling() {
            if (this.processPollTimer) {
                clearInterval(this.processPollTimer);
                this.processPollTimer = null;
            }
            this.currentJobId = null;
        },

        /**
         * Reset UI for next file
         */
        resetForNextFile() {
            this.stopProcessPolling();
            this.abReset();
            this.successMessage = '';
            this.isProcessing = false;
            this.detectedTracks = [];
            this.resetEditState();
            this.searchSeq++;
            this.searchResults = [];
            this.detailsSettled = false;
            this.selectedRelease = null;
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
