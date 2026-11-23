// Review follow-ups of the ported player fixes: one player at a time (waveform, fallback <audio> and the
// A/B player), Space scoping, no fallback for a source the server refuses, and the initWaveform wiring
// (deleting any of these handlers used to keep the suite green).  Async part sets `finished`: run.js
// only checks exit codes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', 'backend', 'static');
const vinylApp = new Function(fs.readFileSync(path.join(root, 'app.js'), 'utf8') + ';return vinylApp;')();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let finished = false;
process.on('exit', () => { if (!finished) { console.error('wave6_review_followups: async part did not finish'); process.exitCode = 1; } });

const track = (number, start, end) => ({ number, start, end, duration: end - start, ignored: false, editing: false });
const audioEl = (paused = true) => ({ paused, pauses: 0, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; this.pauses++; } });
function emitter() {
    const handlers = {};
    return { handlers, on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
        emit(name, ...args) { (handlers[name] || []).slice().forEach(fn => fn(...args)); } };
}
function fakeMedia() {
    return Object.assign(emitter(), { preload: null, volume: 1,
        addEventListener(name, fn) { this.on(name, fn); }, removeEventListener() {} });
}
function fakeWave(media) {
    return Object.assign(emitter(), {
        media, pauses: 0, times: [], destroyed: false,
        registerPlugin: () => Object.assign(emitter(), { getRegions: () => [], clearRegions() {} }),
        getMediaElement: () => media,
        getWrapper: () => ({ addEventListener() {}, getBoundingClientRect: () => ({ left: 0, width: 1000 }), parentElement: null }),
        load: async () => {}, getDuration: () => 600, getCurrentTime: () => 0, isPlaying: () => false,
        setTime(time) { this.times.push(time); }, zoom() {}, play: async () => {},
        pause() { this.pauses++; }, destroy() { this.destroyed = true; this.emit('destroy'); },
    });
}
function install(wave, fetchImpl) {
    global.window = global.window || {};
    global.document = { getElementById: () => ({ offsetWidth: 1000, addEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    global.WaveSurfer = { create: () => wave, Regions: { create: () => ({}) } };
    global.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ peaks: [0, 1], duration: 600 }) }));
}
function mkApp(refs = {}) {
    const app = vinylApp();
    app.toasts = []; app.notify = (message, options = {}) => { app.toasts.push({ message, ...options }); return app.toasts.length; };
    app.uploadedFiles = [{ id: 'one', filename: 'a.wav', status: 'analyzed' }];
    app.currentFileId = 'one'; app.currentFile = app.uploadedFiles[0];
    app.detectedTracks = [track(1, 10, 100)];
    app.$nextTick = () => {}; app.$refs = refs;
    return app;
}
const press = (target, extra = {}) => ({ code: 'Space', key: ' ', repeat: false, defaultPrevented: false, target,
    prevented: false, preventDefault() { this.prevented = true; }, ...extra });

// ---- markup: the fallback element hands over to nothing else ----
assert.ok(/<audio x-ref="fallbackAudio"[^>]*@play="onFallbackPlay\(\)"/.test(html), 'the fallback player pauses the A/B player when it starts');

(async () => {
    // ---- 1. one player at a time: fallback <audio> <-> A/B ----
    {
        const fallback = audioEl(false);
        const app = mkApp({ fallbackAudio: fallback, abOriginal: audioEl(true), abProcessed: audioEl(true), abRemoved: audioEl(true) });
        app.fallbackAudioUrl = '/api/audio/one'; app.abResult = { original_url: 'o', processed_url: 'p' };
        app.abToggle();
        assert.strictEqual(fallback.paused, true, 'starting the A/B player pauses the fallback player');
        const fallback2 = audioEl(false);
        const app2 = mkApp({ fallbackAudio: fallback2, abOriginal: audioEl(true), abProcessed: audioEl(true), abRemoved: audioEl(true) });
        app2.abOnPlay('original');
        assert.strictEqual(fallback2.paused, true, 'the A/B play event pauses the fallback player too');
        // other direction
        const refs = { fallbackAudio: audioEl(false), abOriginal: audioEl(false), abProcessed: audioEl(true), abRemoved: audioEl(true) };
        const app3 = mkApp(refs);
        app3.onFallbackPlay();
        assert.strictEqual(refs.abOriginal.paused, true, 'starting the fallback pauses the A/B player');
        assert.strictEqual(refs.fallbackAudio.paused, false, 'and leaves the fallback itself playing');
    }
    // one-player survivors: abOnPlay pauses the waveform, startPlayback and the waveform's play event pause A/B
    {
        const app = mkApp({ abOriginal: audioEl(false), abProcessed: audioEl(true), abRemoved: audioEl(true) });
        app.waveform = fakeWave(fakeMedia());
        app.abOnPlay('original');
        assert.strictEqual(app.waveform.pauses, 1, 'abOnPlay pauses the waveform');
        const refs = { abOriginal: audioEl(false), abProcessed: audioEl(true), abRemoved: audioEl(true) };
        const app2 = mkApp(refs); app2.waveform = fakeWave(fakeMedia());
        app2.startPlayback();
        assert.strictEqual(refs.abOriginal.paused, true, 'startPlayback pauses the A/B player');
    }

    // ---- 2. Space: only the volume slider is exempt among range inputs ----
    {
        const app = mkApp(); app.waveform = fakeWave(fakeMedia()); app.playDuration = 600;
        let toggles = 0; app.togglePlay = () => { toggles++; };
        const seek = press({ tagName: 'INPUT', type: 'range', classList: { contains: name => name === 'x' } });
        app.onGlobalKeydown(seek);
        assert.ok(!seek.prevented && toggles === 0, 'the A/B scrubber keeps Space');
        const volume = press({ tagName: 'INPUT', type: 'range', classList: { contains: name => name === 'volume-slider' } });
        app.onGlobalKeydown(volume);
        assert.ok(volume.prevented && toggles === 1, 'the volume slider does not own Space');
        assert.ok(/<input type="range"[^>]*class="volume-slider"/.test(html));
    }

    // ---- Space pauses a playing A/B render whatever the waveform player is doing ----
    for (const [label, setup] of [['no waveform', () => {}], ['fallback shown', a => { a.fallbackAudioUrl = '/api/audio/one'; }]]) {
        const refs = { abOriginal: audioEl(false), abProcessed: audioEl(true), abRemoved: audioEl(true) };
        const app = mkApp(refs); setup(app);
        const event = press({ tagName: 'DIV' });
        app.onGlobalKeydown(event);
        assert.ok(event.prevented && refs.abOriginal.paused, label + ': Space pauses the A/B player');
    }

    // ---- 3. a source the server refuses gets no fallback player ----
    for (const [status, detail] of [[410, 'The source file is no longer in the import folder.'], [409, 'It changed on disk.']]) {
        const wave = fakeWave(fakeMedia()); install(wave, async () => ({ ok: false, status, json: async () => ({ detail }) }));
        const app = mkApp(); app.fallbackAudioUrl = '';
        await app.initWaveform();
        assert.strictEqual(app.fallbackAudioUrl, '', status + ': no fallback (its audio request is refused the same way)');
        assert.strictEqual(app.waveform, null, status + ': waveform torn down');
        assert.strictEqual(wave.destroyed, true);
        assert.strictEqual(app.waveformLoading, false);
        assert.ok(app.toasts.some(toast => toast.message.includes(detail)), status + ': the reason is in the toast');
    }
    {
        const wave = fakeWave(fakeMedia()); install(wave, async () => ({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) }));
        const app = mkApp(); await app.initWaveform();
        assert.strictEqual(app.fallbackAudioUrl, '/api/audio/one', 'control: another failure keeps the fallback');
    }

    // ---- 4. initWaveform wiring ----
    {
        const media = fakeMedia(), wave = fakeWave(media); install(wave);
        const app = mkApp(); await app.initWaveform();
        const refs = { abOriginal: audioEl(false), abProcessed: audioEl(true), abRemoved: audioEl(true) };
        app.$refs = refs;
        wave.emit('play');
        assert.strictEqual(app.isPlaying, true); assert.strictEqual(refs.abOriginal.paused, true, 'the waveform play event pauses A/B');
        app._auditionStop = 50; wave.emit('pause');
        assert.strictEqual(app.isPlaying, false, 'pause'); assert.strictEqual(app._auditionStop, null, 'pause ends an audition');
        app.isPlaying = true; app._auditionStop = 50; wave.emit('finish');
        assert.strictEqual(app.isPlaying, false, 'finish'); assert.strictEqual(app._auditionStop, null);
        wave.emit('timeupdate', 42);
        assert.strictEqual(app.playTime, 42, 'timeupdate moves the playhead');
        app._auditionStop = 50; wave.emit('interaction', 33);
        assert.strictEqual(app._auditionStop, null, 'a click on the waveform abandons an audition');
        assert.ok(wave.times.includes(33), 'and seeks there');
        app._pendingSeek = 77; media.emit('loadedmetadata');
        assert.ok(wave.times.includes(77), 'loadedmetadata applies a seek made before the length was known');
    }

    // ---- togglePlay ends an audition ----
    {
        const app = mkApp(); app.waveform = fakeWave(fakeMedia()); app.waveform.isPlaying = () => true;
        app._auditionStop = 50; app.togglePlay();
        assert.strictEqual(app._auditionStop, null);
    }

    // ---- closing the last recording stops whatever plays ----
    {
        const wave = fakeWave(fakeMedia());
        const app = mkApp({ fallbackAudio: audioEl(false) });
        app.waveform = wave; app.fallbackAudioUrl = '/api/audio/one';
        app.closeCurrentFile();
        assert.strictEqual(wave.destroyed, true, 'waveform destroyed');
        assert.strictEqual(app.waveform, null);
        assert.strictEqual(app.fallbackAudioUrl, '', 'fallback removed');
        assert.strictEqual(app.$refs.fallbackAudio.paused, true, 'and stopped');
    }

    // ---- a lock change redraws the regions (frozen / draggable) ----
    {
        const watchers = {};
        global.document = { addEventListener() {} }; global.window = { addEventListener() {} };
        const app = mkApp(); app.$watch = (name, fn) => { watchers[name] = fn; };
        app.loadConfig = app.loadFormats = app.checkStatus = app.loadImportList = async () => {};
        app.connectWebSocket = app.detectDesktopPicker = app.chooseDefaultImportTab = () => {};
        try { await app.init(); } catch (error) { /* the rest of init is not under test */ }
        let redraws = 0; app.addTrackRegions = () => { redraws++; };
        app.waveform = {}; app.waveformRegions = {};
        watchers.currentLocked();
        assert.strictEqual(redraws, 1, 'regions are rebuilt when the lock changes');
        app.waveform = null; watchers.currentLocked();
        assert.strictEqual(redraws, 1, 'but not without a waveform');
    }
    finished = true;
    console.log('wave6_review_followups: ok');
})().catch(error => { console.error(error); process.exit(1); });
