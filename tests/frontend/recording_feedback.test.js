// Real-record feedback: retry imports, recover editing state, and preserve precise seek intent.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8');
const vinylApp = new Function(source + ';return vinylApp;')();
const cases = [];
const test = (name, run) => cases.push({ name, run });
const track = { number: 1, start: 5, end: 65, duration: 60, ignored: false };
const file = (id = 'one') => ({ id, filename: id + '.wav', duration: 120, status: 'uploaded' });
// Fake storage holds serialized text across separate app instances, just like a refresh.
const storage = new Map();
global.window = { localStorage: { getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) } };
function app() {
    const instance = vinylApp();
    // Most cases start after normal startup has already checked the server queue.
    instance._workspacesLoaded = true;
    instance.uploadedFiles = [file(), file('two')];
    instance.currentFileId = 'one';
    instance.currentFile = instance.uploadedFiles[0];
    instance.fetchScan = instance.fetchHum = instance.loadCachedClicks = () => {};
    instance.initWaveform = async () => {};
    instance.searchDiscogs = () => { throw new Error('Recovery must not search Discogs'); };
    instance.$nextTick = callback => callback();
    instance.detectedTracks = [{ ...track }];
    return instance;
}
test('abandoned and completed imports can both be selected; copying files cannot', () => {
    const instance = app();
    instance.importInfo.files = [{ name: 'one.wav', imported_id: 'one', stable: true },
        { name: 'done.wav', imported_id: 'done', imported_status: 'completed', stable: true },
        { name: 'copy.wav', stable: false }];
    assert.deepStrictEqual(instance.importableFiles.map(row => row.name), ['one.wav', 'done.wav']);
    instance.onImportRowClick(instance.importInfo.files[0]);
    assert.deepStrictEqual(instance.importSelected, ['one.wav']);
    assert.strictEqual(instance.importFileLabel(instance.importInfo.files[1]), 'Complete');
    assert.notStrictEqual(instance.importFileLabel(instance.importInfo.files[0]), 'Complete');
});
test('refresh recovers cuts, mapping, release, settings, position, and live server status', async () => {
    storage.clear();
    const before = app();
    before.selectedRelease = { id: 7, artist: 'Artist', title: 'Album', tracks: [{ position: 'A1', title: 'Song' }] };
    before.selectedSides = ['A']; before.customMapping = [0];
    before.detectedTracks[0].ignored = true; before.detectedTracks[0].declick = 'strong';
    before.boundariesEdited = true; before.playTime = 42; before.outputFormat = 'aiff';
    before.humFilter = true; before.config.bit_depth = '24';
    before.saveWorkspace();
    const after = app(); after.currentFileId = null; after.currentFile = null;
    global.fetch = async url => {
        assert.strictEqual(url, '/api/queue');
        return { ok: true, json: async () => ({ uploaded: [file()], processing: [] }) };
    };
    await after.loadWorkspaces();
    assert.strictEqual(after.recoverableFiles.length, 1);
    after.selectFile('one');
    assert.deepStrictEqual(after.detectedTracks, before.detectedTracks);
    assert.deepStrictEqual(after.customMapping, [0]);
    assert.deepStrictEqual(after.selectedSides, ['A']);
    assert.strictEqual(after.selectedRelease.id, 7);
    assert.strictEqual(after.playTime, 42);
    assert.strictEqual(after.outputFormat, 'aiff');
    assert.strictEqual(after.humFilter, true);
    assert.strictEqual(after.config.bit_depth, '24');
    assert.strictEqual(after.isPlaying, false);
});
test('file switches preserve independent workspaces and ignore a same-file click', () => {
    const instance = app();
    instance.selectFile('one');
    assert.strictEqual(instance.detectedTracks[0].start, 5);
    // The second file has not been searched or analysed yet.
    instance.discogsConfigured = false;
    instance.selectFile('two');
    instance.detectedTracks = [{ ...track, start: 10, duration: 55 }];
    instance.selectFile('one');
    assert.strictEqual(instance.detectedTracks[0].start, 5);
    instance.selectFile('two');
    assert.strictEqual(instance.detectedTracks[0].start, 10);
});
test('stale or corrupt saves cannot resurrect deleted sessions', async () => {
    storage.clear();
    app().saveWorkspace();
    const after = app(); after.currentFileId = null;
    global.fetch = async () => ({ ok: true, json: async () => ({ uploaded: [], processing: [] }) });
    await after.loadWorkspaces();
    assert.deepStrictEqual(after.recoverableFiles, []);
    assert.deepStrictEqual(after.workspaces, {});
    for (const key of storage.keys()) storage.set(key, '{broken');
    await after.loadWorkspaces();
    assert.deepStrictEqual(after.recoverableFiles, []);
});
test('returning to Discogs preserves hand-edited cuts', () => {
    const instance = app(); let searches = 0;
    instance.searchDiscogs = () => { searches++; };
    instance.boundariesEdited = true;
    instance.tryDiscogsAgain();
    assert.strictEqual(searches, 1);
    assert.strictEqual(instance.detectedTracks[0].start, 5);
    assert.strictEqual(instance.boundariesEdited, true);
});
test('Complete describes the exported inputs and clears when export inputs change', () => {
    const instance = app();
    instance.currentFile.completedExportSignature = instance.exportSignature();
    instance.currentFile.status = 'completed';
    assert.strictEqual(instance.processingComplete, true);
    instance.detectedTracks[0].end = 64;
    assert.strictEqual(instance.processingComplete, false);
});
test('a completion for another file updates that file without completing the current one', () => {
    const instance = app();
    instance.uploadedFiles[1].pendingExportSignature = 'submitted-two';
    instance.handleWebSocketMessage({ type: 'complete', file_id: 'two', tracks: ['B1'] });
    assert.strictEqual(instance.uploadedFiles[1].status, 'completed');
    assert.strictEqual(instance.currentFile.status, 'uploaded');
});
test('a seek requested before media metadata survives metadata loading; readout updates immediately', () => {
    const instance = app(); let time = 0;
    const media = { readyState: 0 };
    instance.waveform = { setTime: value => { time = value; }, getCurrentTime: () => time,
        getDuration: () => 120, getMediaElement: () => media };
    instance.seekTo(42);
    assert.strictEqual(instance.playTime, 42);
    // A native media load resets currentTime before loadedmetadata.
    time = 0; media.readyState = 1;
    instance.applyPendingSeek();
    assert.strictEqual(time, 42);
    instance.seekTo(45); instance.applyPendingSeek();
    assert.strictEqual(time, 45, 'a previous seek must not be replayed');
});
test('refresh after a server-side export completed keeps the completed signature', async () => {
    storage.clear();
    const before = app();
    before.currentFile.pendingExportSignature = before.exportSignature();
    before.saveWorkspace();
    const after = app(); after.currentFileId = null; after.currentFile = null;
    global.fetch = async () => ({ ok: true, json: async () => ({ uploaded: [{ ...file(), status: 'completed' }], processing: [] }) });
    await after.loadWorkspaces();
    after.selectFile('one');
    assert.strictEqual(after.processingComplete, true);
});
test('a failed queue check cannot erase a saved workspace', async () => {
    storage.clear(); app().saveWorkspace();
    const prior = [...storage.entries()];
    const after = app(); after.currentFileId = null; after.currentFile = null;
    global.fetch = async () => ({ ok: false });
    await after.loadWorkspaces(); after.saveWorkspace();
    assert.deepStrictEqual([...storage.entries()], prior);
    assert.ok(after.workspaceNotice);
});
test('Process Next File saves the completed workspace before clearing the editor', () => {
    const instance = app();
    instance.currentFile.status = 'completed';
    instance.discogsConfigured = false;
    instance.resetForNextFile();
    instance.selectFile('one');
    assert.strictEqual(instance.detectedTracks[0].start, 5);
});
test('an export finishing before its POST response is not changed back to processing', async () => {
    const instance = app();
    instance.selectedRelease = { id: 7, tracks: [{ position: 'A1' }] };
    instance.customMapping = [0];
    instance.loadImportList = async () => {};
    instance.config.bit_depth = '24';
    global.fetch = async (url, options) => {
        assert.strictEqual(JSON.parse(options.body).bit_depth, '24');
        instance.handleWebSocketMessage({ type: 'complete', file_id: 'one', tracks: ['A1'] });
        return { ok: true, json: async () => ({ job_id: 'one' }) };
    };
    await instance.processFile();
    instance.stopProcessPolling();
    assert.strictEqual(instance.currentFile.status, 'completed');
    assert.strictEqual(instance.processingComplete, true);
});
test('polling completion updates the button and stale polls cannot finish a later export', async () => {
    const oldSet = global.setInterval, oldClear = global.clearInterval;
    const instance = app();
    instance.loadImportList = async () => {};
    let poll;
    global.setInterval = callback => { poll = callback; return 1; };
    global.clearInterval = () => {};
    try {
        instance.currentFile.pendingExportSignature = instance.exportSignature();
        instance.isProcessing = true; instance.startProcessPolling('one');
        let resolveFetch;
        global.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
        const stale = poll();
        instance.stopProcessPolling();
        instance.startProcessPolling('one');
        resolveFetch({ ok: true, json: async () => ({ status: 'complete', file_id: 'one', tracks: ['A1'] }) });
        await stale;
        assert.strictEqual(instance.currentFile.status, 'uploaded');
        global.fetch = async () => ({ ok: true, json: async () => ({ status: 'complete', file_id: 'one', tracks: ['A1'] }) });
        await poll();
        assert.strictEqual(instance.processingComplete, true);
    } finally {
        instance.stopProcessPolling();
        global.setInterval = oldSet; global.clearInterval = oldClear;
    }
});
test('reselecting an abandoned existing import resumes it without queue duplicates', async () => {
    const instance = app();
    instance.currentFile = null; instance.currentFileId = null; instance.discogsConfigured = false;
    global.fetch = async (url, options = {}) => ({ ok: true, json: async () =>
        options.method === 'POST' ? { files: [file()], skipped: [] } : { enabled: true, files: [] } });
    await instance.postImport({ names: ['one.wav'] });
    assert.strictEqual(instance.currentFileId, 'one');
    assert.strictEqual(instance.uploadedFiles.filter(entry => entry.id === 'one').length, 1);
});
test('storage access errors do not prevent recovery of the live queue', async () => {
    const localStorage = window.localStorage;
    window.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    try {
        const instance = app(); instance.currentFileId = null; instance.currentFile = null;
        global.fetch = async () => ({ ok: true, json: async () => ({ uploaded: [file()], processing: [] }) });
        await instance.loadWorkspaces();
        assert.strictEqual(instance.recoverableFiles.length, 1);
        assert.match(instance.workspaceNotice, /saving is unavailable/);
    } finally { window.localStorage = localStorage; }
});
test('directional cursors distinguish each side and a shared boundary', () => {
    const instance = app();
    instance.detectedTracks = [{ ...track, start: 0, end: 60 }, { ...track, number: 2, start: 60, end: 120 }];
    instance.waveform = { getDuration: () => 120,
        getWrapper: () => ({ getBoundingClientRect: () => ({ left: 0, width: 1200 }) }) };
    assert.strictEqual(instance.regionCursorAt(596), 'w-resize');
    assert.strictEqual(instance.regionCursorAt(604), 'e-resize');
    assert.strictEqual(instance.regionCursorAt(600), 'ew-resize');
});
(async () => {
    let failed = 0;
    for (const { name, run } of cases) {
        try { await run(); } catch (error) { failed++; console.error(name + ': ' + error.message); }
    }
    assert.strictEqual(failed, 0, `${failed} recording feedback regressions failed`);
    console.log('recording feedback ok');
})().catch(error => { console.error(error); process.exit(1); });
