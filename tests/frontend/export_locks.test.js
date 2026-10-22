// Plan 12 A2 + A1: only exporting recordings are locked; queued exports start one at a time; WAV playback falls back once.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();
const cases = [];
const test = (name, run) => cases.push({ name, run });
const tick = () => new Promise(resolve => setImmediate(resolve));
const release = { id: 7, artist: 'Artist', title: 'Triple LP', tracks: [
    { position: 'A1', title: 'First' }, { position: 'C1', title: 'Second' }, { position: 'E1', title: 'Third' }] };
const ids = ['one', 'two', 'three'];
function app() {
    const instance = vinylApp();
    instance.uploadedFiles = ids.map(id => ({ id, filename: id + '.wav', duration: 120, status: 'analyzed' }));
    instance.currentFileId = 'one'; instance.currentFile = instance.uploadedFiles[0];
    instance.selectedRelease = JSON.parse(JSON.stringify(release)); instance.selectedSides = ['A'];
    instance.detectedTracks = [{ number: 1, start: 1, end: 61, duration: 60, ignored: false }];
    instance.customMapping = [0];
    instance.$nextTick = callback => callback?.();
    instance.loadImportList = async () => {};
    instance.initWaveform = async () => {};
    instance.fetchScan = instance.fetchHum = instance.loadCachedClicks = () => {};
    instance.discogsConfigured = false;
    instance.toasts = [];
    instance.notify = (message, options = {}) => { instance.toasts.push({ message, ...options }); return instance.toasts.length; };
    instance.saveWorkspace();
    ids.slice(1).forEach((id, i) => {
        instance.workspaces[id] = JSON.parse(JSON.stringify(instance.workspaces.one));
        instance.workspaces[id].selectedSides = ['CE'[i]]; instance.workspaces[id].customMapping = [i + 1];
        instance.workspaces[id].outputFormat = ['mp3', 'aiff'][i];   // different formats: a batch never groups them into an album job
    });
    return instance;
}
/** Fake server: every POST stays in flight until its terminal event, so overlap is detectable. */
function fakeServer(instance, { onPost, onConfig } = {}) {
    const state = { posts: [], configPuts: 0, inFlight: 0, maxInFlight: 0 };
    global.fetch = async (url, options = {}) => {
        if (url === '/api/config') {
            assert.strictEqual(options.method, 'PUT'); state.configPuts++;
            return { ok: true, json: async () => ({ output_format: 'flac', ...(onConfig || {}) }) };
        }
        assert.strictEqual(url, '/api/process', 'tests must not contact Discogs or the live app');
        const body = JSON.parse(options.body); state.posts.push(body);
        state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        return onPost ? onPost(body, state.posts.length) : { ok: true, json: async () => ({ job_id: body.file_id }) };
    };
    state.finish = (fileId) => {
        state.inFlight--;
        instance.handleWebSocketMessage({ type: 'complete', file_id: fileId, tracks: [fileId + '.flac'] });
    };
    return state;
}

test('switching recordings works during a single export; progress and completion stay with their own file', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();
    assert.strictEqual(server.posts.length, 1); assert.strictEqual(instance.currentLocked, true);
    instance.selectFile('two');
    assert.strictEqual(instance.currentFileId, 'two'); assert.strictEqual(instance.currentLocked, false);
    assert.strictEqual(instance.currentExporting, false, 'the viewed recording is not the exporting one');
    instance.handleWebSocketMessage({ type: 'progress', file_id: 'one', progress: 0.5, message: 'Splitting' });
    assert.strictEqual(instance.uploadedFiles[0].progress, 0.5);
    assert.strictEqual(instance.processingProgress, 0, 'progress for one must not drive two');
    server.finish('one');
    assert.strictEqual(instance.uploadedFiles[0].status, 'completed');
    assert.strictEqual(instance.successMessage, '', 'completion of one must not write the UI of two');
    assert.strictEqual(instance.uploadedFiles[1].status, 'analyzed'); assert.strictEqual(instance.isProcessing, false);
    instance.selectFile('one');
    assert.match(instance.successMessage, /1 tracks saved/);
});
test('viewing the exporting recording is read-only with live progress, and switching away keeps it running', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();
    instance.selectFile('two'); instance.selectFile('one');
    assert.strictEqual(instance.currentLocked, true); assert.strictEqual(instance.currentExporting, true);
    assert.strictEqual(instance.isProcessing, true, 'live export stays tracked');
    instance.handleWebSocketMessage({ type: 'progress', file_id: 'one', progress: 0.7, message: 'Tagging' });
    assert.strictEqual(instance.processingProgress, 0.7);
    assert.strictEqual(instance.processDisabled, true);
    server.finish('one');
    assert.strictEqual(instance.currentLocked, false);
    assert.match(instance.successMessage, /saved/);
});
test('switching works during a batch; queued recordings are locked, others are not', async () => {
    const instance = app(); instance.workspaces.three.selectedRelease = null; // not ready, so not in the batch
    const server = fakeServer(instance);
    const batch = instance.processAllReady(); await tick();
    assert.strictEqual(server.posts.length, 1);
    instance.selectFile('two');
    assert.strictEqual(instance.currentFileId, 'two'); assert.strictEqual(instance.currentLocked, true, 'two is queued in the batch');
    instance.selectFile('three');
    assert.strictEqual(instance.currentLocked, false);
    server.finish('one'); await tick(); server.finish('two'); await batch;
    assert.strictEqual(server.maxInFlight, 1);
});
test('editing gates refuse only on the locked recording', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();
    let calls = 0; const realFetch = global.fetch;
    global.fetch = async (...args) => { if (String(args[0]).startsWith('/api/analyze')) calls++; return realFetch(...args); };
    await instance.analyzeFile(); await instance.reanalyzeFile(); instance.changeRelease();
    assert.strictEqual(calls, 0); assert.ok(instance.selectedRelease, 'locked recording keeps its release');
    instance.selectFile('three');
    instance.changeRelease();
    assert.strictEqual(instance.selectedRelease, null, 'unlocked recording is editable during the export');
    server.finish('one');
});
test('every refused action gives feedback', async () => {
    const instance = app(); fakeServer(instance);
    instance.analyzing = true;
    instance.selectFile('two');
    assert.strictEqual(instance.currentFileId, 'one'); assert.match(instance.toasts.at(-1).message, /track detection/);
    await instance.processFile(); assert.match(instance.toasts.at(-1).message, /track detection/);
    await instance.processAllReady(); assert.ok(instance.toasts.length >= 3);
    instance.analyzing = false;
    await instance.processFile(); instance.toasts.length = 0;
    instance.removeFile('one'); assert.match(instance.toasts.at(-1).message, /can't be removed/);
    await instance.processFile(); assert.match(instance.toasts.at(-1).message, /already exporting/);
});
test('Settings Save works during an export', async () => {
    const instance = app(); const server = fakeServer(instance, { onConfig: { output_format: 'mp3', declick: 'strong' } });
    await instance.processFile();
    instance.showSettings = true; await instance.saveConfig();
    assert.strictEqual(server.configPuts, 1); assert.strictEqual(instance.showSettings, false);
    assert.strictEqual(instance.outputFormat, 'flac', 'the exporting recording in the editor keeps its own values');
    instance.selectFile('two'); await instance.saveConfig();
    assert.strictEqual(server.configPuts, 2); assert.strictEqual(instance.outputFormat, 'mp3');
    server.finish('one');
});
test('Process & Save on another recording queues it and dispatches only after the running export settles', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();
    instance.selectFile('two');
    assert.strictEqual(instance.processButtonLabel, 'Queue export'); assert.ok(instance.processHint);
    await instance.processFile();
    assert.strictEqual(server.posts.length, 1, 'two waits for one');
    assert.strictEqual(instance.uploadedFiles[1].status, 'queued'); assert.strictEqual(instance.currentLocked, true);
    assert.strictEqual(instance.processButtonLabel, 'Queued');
    assert.strictEqual(instance.exportQueue.length, 1);
    instance.workspaces.two.declick = 'strong'; // edits after queuing cannot change the frozen request
    instance.selectFile('three');
    server.finish('one'); await tick();
    assert.strictEqual(server.posts.length, 2); assert.strictEqual(server.posts[1].file_id, 'two');
    assert.strictEqual(server.posts[1].declick, 'off'); assert.strictEqual(server.posts[1].track_mapping[0].discogs, 'C1');
    assert.strictEqual(instance.uploadedFiles[1].status, 'processing'); assert.strictEqual(instance.currentFileId, 'three');
    assert.strictEqual(instance.successMessage, '', 'two finishing must not write the UI of three');
    server.finish('two'); await tick();
    assert.strictEqual(server.maxInFlight, 1); assert.strictEqual(instance.exportQueue.length, 0);
    assert.strictEqual(instance.uploadedFiles[1].status, 'completed'); assert.strictEqual(instance.exportBusy, false);
});
test('queued exports run FIFO, also behind a batch', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();            // one runs
    instance.selectFile('three');
    await instance.processFile();            // three queued
    instance.selectFile('two'); await instance.processFile(); // two queued behind three
    assert.deepStrictEqual(instance.exportQueue.map(item => item.fileId), ['three', 'two']);
    server.finish('one'); await tick(); assert.strictEqual(server.posts.at(-1).file_id, 'three');
    server.finish('three'); await tick(); assert.strictEqual(server.posts.at(-1).file_id, 'two');
    server.finish('two'); await tick();
    assert.strictEqual(server.posts.length, 3); assert.strictEqual(server.maxInFlight, 1);
});
test('an uncertain dispatched item stops the queue and hands the rest back with a reason', async () => {
    const instance = app();
    const server = fakeServer(instance, { onPost: (body, count) => { if (count === 2) throw new Error('Connection lost'); return { ok: true, json: async () => ({ job_id: body.file_id }) }; } });
    await instance.processFile();
    instance.selectFile('two'); await instance.processFile();
    instance.selectFile('three'); await instance.processFile();
    assert.deepStrictEqual(instance.exportQueue.map(item => item.fileId), ['two', 'three']);
    server.finish('one'); await tick(); await tick();
    assert.strictEqual(server.posts.length, 2, 'three is never dispatched');
    assert.strictEqual(instance.uploadedFiles[1].status, 'uncertain');
    assert.strictEqual(instance.uploadedFiles[2].status, 'analyzed'); assert.match(instance.uploadedFiles[2].error, /not started/i);
    assert.strictEqual(instance.exportQueue.length, 0);
    await instance.processFile();            // three: refused while another status is unknown
    assert.strictEqual(server.posts.length, 2); assert.match(instance.toasts.at(-1).message, /status is unknown/);
});
test('Process all ready is disabled with a reason while an export runs or is queued', async () => {
    const instance = app(); const server = fakeServer(instance);
    assert.strictEqual(instance.processAllReason, '');
    await instance.processFile();
    assert.ok(instance.processAllReason); assert.strictEqual(instance.exportBusy, true);
    await instance.processAllReady();
    assert.strictEqual(server.posts.length, 1); assert.match(instance.toasts.at(-1).message, /Available when/);
    assert.strictEqual(instance.batchProcessing, false);
    server.finish('one');
    assert.strictEqual(instance.processAllReason, '');
});
test('unlocked recordings can be removed during an export; locked ones cannot', async () => {
    const instance = app(); const server = fakeServer(instance);
    await instance.processFile();
    instance.selectFile('two');
    instance.removeFile('one'); assert.ok(instance.uploadedFiles.some(file => file.id === 'one'));
    instance.removeFile('three'); assert.ok(!instance.uploadedFiles.some(file => file.id === 'three'));
    instance.pendingRemovals = {};
    server.finish('one');
});

// ---- A1: precise playback fallback ------------------------------------------------------------
function waveformHarness({ canPlay = 'maybe' } = {}) {
    const instance = app(); instance.initWaveform = vinylApp().initWaveform;   // the real method (app() stubs it)
    const wave = { handlers: {}, loads: [], media: { listeners: {}, error: null, readyState: 0, preload: '',
        canPlayType: () => canPlay, addEventListener(ev, fn) { this.listeners[ev] = fn; }, removeEventListener() {} } };
    Object.assign(wave, {
        on(ev, fn) { this.handlers[ev] = fn; }, getMediaElement() { return this.media; },
        registerPlugin() { return { on() {} }; }, destroy() {}, getDuration: () => 120,
        load(url, peaks, duration) { this.loads.push({ url, peaks, duration }); return Promise.resolve(); }
    });
    global.WaveSurfer = { create: () => wave, Regions: { create: () => ({}) } };
    global.fetch = async url => { assert.strictEqual(url, '/api/waveform-peaks/one');
        return { ok: true, json: async () => ({ peaks: [0.1, 0.2], duration: 120 }) }; };
    return { instance, wave };
}
async function startWaveform(options) {
    const { instance, wave } = waveformHarness(options);
    await instance.initWaveform();
    return { instance, wave };
}

test('WaveSurfer objects stay out of Alpine reactivity (proxied regions could not be removed)', async () => {
    const { instance, wave } = await startWaveform();
    assert.strictEqual(wave.__v_skip, true); assert.strictEqual(instance.waveformRegions.__v_skip, true);
    assert.ok(!Object.keys(wave).includes('__v_skip'), 'non-enumerable: never serialised or iterated');
});
test('a browser that cannot play WAV loads the MP3 preview from the start', async () => {
    const { instance, wave } = await startWaveform({ canPlay: '' });
    assert.strictEqual(wave.loads.length, 1); assert.strictEqual(wave.loads[0].url, '/api/audio/one');
    assert.match(instance.playerInfo, /Playing the preview/);
});
test('a decode error on the original WAV reloads the preview exactly once, keeping peaks, zoom and position', async () => {
    const { instance, wave } = await startWaveform();
    assert.strictEqual(wave.loads[0].url, '/api/audio/one?precise=true'); assert.strictEqual(instance.playerInfo, '');
    instance.playTime = 42; instance.currentZoom = 80; instance.isPlaying = false;
    wave.media.error = { code: 3 };
    wave.media.listeners.error(); wave.handlers.error(new Error('twin of the same failure'));
    assert.strictEqual(instance.playerNotice, '', 'the twin event of one failure is absorbed'); await tick();
    assert.strictEqual(wave.loads.length, 2); assert.strictEqual(wave.loads[1].url, '/api/audio/one');
    assert.deepStrictEqual(wave.loads[1].peaks, wave.loads[0].peaks); assert.strictEqual(wave.loads[1].duration, 120);
    assert.strictEqual(instance._pendingSeek, 42); assert.strictEqual(instance._restoreZoom, 80);
    assert.match(instance.playerInfo, /cut points may be up to ~50 ms less precise/);
    assert.strictEqual(instance.playerNotice, '', 'the fallback replaces the error notice');
    wave.media.listeners.error(); wave.handlers.error(new Error('preview failed too'));
    assert.strictEqual(wave.loads.length, 2, 'never loops');
    assert.match(instance.playerNotice, /Audio playback error: preview failed too/);
});
test('a WaveSurfer error on the precise URL also falls back; unrelated media errors do not', async () => {
    const { instance, wave } = await startWaveform();
    wave.media.error = { code: 2 }; wave.media.listeners.error(); await tick();
    assert.strictEqual(wave.loads.length, 1, 'network errors are not a format problem');
    wave.handlers.error(new Error('decode')); await tick();
    assert.strictEqual(wave.loads.length, 2);
});
test('an error on the preview URL keeps the normal error notice and does not reload', async () => {
    const { instance, wave } = await startWaveform({ canPlay: '' });
    wave.media.error = { code: 4 }; wave.media.listeners.error(); wave.handlers.error(new Error('bad mp3'));
    assert.strictEqual(wave.loads.length, 1); assert.match(instance.playerNotice, /Audio playback error: bad mp3/);
});
test('a stale error after switching recordings does nothing', async () => {
    const { instance, wave } = await startWaveform();
    instance.waveform = null; instance.currentFileId = 'two';
    wave.media.error = { code: 4 }; wave.media.listeners.error(); wave.handlers.error(new Error('late'));
    assert.strictEqual(wave.loads.length, 1);
});

(async () => {
    let failed = 0;
    const previousSet = global.setInterval, previousClear = global.clearInterval;
    global.setInterval = () => 1; global.clearInterval = () => {};
    try {
        for (const { name, run } of cases) {
            try { await run(); } catch (error) { failed++; console.error(name + ': ' + (error.stack || error.message)); }
        }
    } finally { global.setInterval = previousSet; global.clearInterval = previousClear; }
    assert.strictEqual(failed, 0, `${failed} export lock regressions failed`);
    console.log('export locks ok');
})().catch(error => { console.error(error); process.exit(1); });
