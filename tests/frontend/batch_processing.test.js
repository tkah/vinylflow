// Sequential export contracts: fake server events and timers keep tests offline and deterministic.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();
const cases = [];
const test = (name, run) => cases.push({ name, run });
const tick = () => new Promise(resolve => setImmediate(resolve));
const release = { id: 7, artist: 'Artist', title: 'Double LP', tracks: [
    { position: 'A1', title: 'First' }, { position: 'C1', title: 'Second' }] };
function app() {
    const instance = vinylApp();
    instance.uploadedFiles = ['one', 'two'].map(id => ({ id, filename: id + '.wav', duration: 120, status: 'analyzed' }));
    instance.currentFileId = 'one'; instance.currentFile = instance.uploadedFiles[0];
    instance.selectedRelease = JSON.parse(JSON.stringify(release)); instance.selectedSides = ['A'];
    instance.detectedTracks = [{ number: 1, start: 1, end: 61, duration: 60, ignored: false }];
    instance.customMapping = [0];
    instance.$nextTick = callback => callback?.();
    instance.loadImportList = async () => {};
    instance.initWaveform = async () => {};
    instance.fetchScan = instance.fetchHum = instance.loadCachedClicks = () => {};
    instance.discogsConfigured = false;
    instance.saveWorkspace();
    instance.workspaces.two = JSON.parse(JSON.stringify(instance.workspaces.one));
    instance.workspaces.two.selectedSides = ['C']; instance.workspaces.two.customMapping = [1];
    instance.workspaces.two.outputFormat = 'aiff'; instance.workspaces.two.bitDepth = '24';
    instance.workspaces.two.declick = 'strong';
    return instance;
}
function fakeServer(instance, onPost) {
    const posts = [];
    global.fetch = async (url, options = {}) => {
        assert.strictEqual(url, '/api/process', 'tests must not contact Discogs or the live app');
        assert.strictEqual(options.method, 'POST');
        const body = JSON.parse(options.body); posts.push(body);
        return onPost ? onPost(body, posts.length) : { ok: true, json: async () => ({ job_id: body.file_id }) };
    };
    return posts;
}
function complete(instance, fileId) { instance.handleWebSocketMessage({ type: 'complete', file_id: fileId, tracks: ['saved.flac'] }); }

test('readiness validates mappings and active bounds and excludes unchanged completed work', () => {
    const instance = app();
    assert.strictEqual(instance.fileReadiness('one').ready, true);
    instance.customMapping = [null]; assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.customMapping = ['']; assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.customMapping = [99]; assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.customMapping = [0]; instance.detectedTracks[0].end = 121;
    assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.detectedTracks[0].end = 61; instance.detectedTracks[0].ignored = true;
    assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.detectedTracks[0].ignored = false;
    instance.detectedTracks.push({ number: 2, start: 65, end: 110, ignored: true });
    assert.strictEqual(instance.fileReadiness('one').ready, true, 'ignored tracks need no mapping');
    instance.detectedTracks[1].ignored = false; instance.customMapping.push(0);
    assert.strictEqual(instance.fileReadiness('one').ready, false, 'positions cannot repeat');
    instance.detectedTracks.pop(); instance.customMapping.pop();
    instance.detectedTracks.push({ number: 1, start: 65, end: 110, ignored: false }); instance.customMapping.push(1);
    assert.strictEqual(instance.fileReadiness('one').ready, false, 'duplicate boundary numbers overwrite backend mappings');
    instance.detectedTracks.pop(); instance.customMapping.pop();
    const selected = instance.selectedRelease;
    instance.selectedRelease = null; assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.selectedRelease = selected;
    instance.currentFile.completedExportSignature = instance.exportSignature(); instance.currentFile.status = 'completed';
    assert.strictEqual(instance.fileReadiness('one').ready, false);
    instance.detectedTracks[0].end = 60; assert.strictEqual(instance.fileReadiness('one').ready, true);
});
test('overlapping positions in the same release and format need attention before dispatch', () => {
    const instance = app();
    instance.workspaces.two.outputFormat = 'flac'; instance.workspaces.two.customMapping = [0];
    assert.strictEqual(instance.fileReadiness('one').ready, false);
    assert.match(instance.fileReadiness('one').reason, /two.wav/);
    assert.strictEqual(instance.fileReadiness('two').ready, false);
    instance.workspaces.two.outputFormat = 'mp3';
    assert.strictEqual(instance.readyFiles.length, 2, 'different formats do not overwrite each other');
});
test('batch freezes per-file inputs and dispatches exactly one job at a time', async () => {
    const instance = app(); const posts = fakeServer(instance);
    const batch = instance.processAllReady(); await tick();
    assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].file_id, 'one');
    instance.workspaces.two.declick = 'off'; instance.outputFormat = 'mp3';
    instance.handleWebSocketMessage({ type: 'progress', file_id: 'one', progress: 0.6, message: 'Splitting' });
    assert.strictEqual(instance.uploadedFiles[0].progress, 0.6);
    complete(instance, 'one'); await tick();
    assert.strictEqual(posts.length, 2); assert.strictEqual(posts[1].file_id, 'two');
    assert.strictEqual(posts[1].output_format, 'aiff'); assert.strictEqual(posts[1].bit_depth, '24');
    assert.strictEqual(posts[1].declick, 'strong'); assert.strictEqual(posts[1].track_mapping[0].discogs, 'C1');
    complete(instance, 'one'); await tick(); assert.strictEqual(posts.length, 2, 'duplicate event cannot advance next item');
    complete(instance, 'two'); await batch;
    assert.strictEqual(instance.currentFileId, 'one'); assert.strictEqual(instance.outputFormat, 'mp3');
    assert.strictEqual(instance.batchSummary.completed, 2); assert.strictEqual(instance.batchProcessing, false);
});
test('confirmed rejection records an error and continues with the next recording', async () => {
    const instance = app(); const posts = fakeServer(instance, (body, count) => count === 1
        ? { ok: false, status: 400, json: async () => ({ detail: 'Bad mapping' }) }
        : { ok: true, json: async () => ({ job_id: body.file_id }) });
    const batch = instance.processAllReady(); await tick();
    assert.strictEqual(posts.length, 2); assert.strictEqual(instance.uploadedFiles[0].status, 'error');
    assert.match(instance.uploadedFiles[0].error, /Bad mapping/);
    complete(instance, 'two'); await batch;
    assert.strictEqual(instance.batchSummary.failed, 1); assert.strictEqual(instance.batchSummary.completed, 1);
});
test('recoverable and unrelated errors do not advance the active export; terminal failure does', async () => {
    const instance = app(); const posts = fakeServer(instance);
    const batch = instance.processAllReady(); await tick();
    instance.handleWebSocketMessage({ type: 'error', file_id: 'one', message: 'Analysis hint', recoverable: true });
    instance.handleWebSocketMessage({ type: 'error', file_id: 'other', message: 'Unrelated', recoverable: false });
    await tick(); assert.strictEqual(posts.length, 1);
    instance.handleWebSocketMessage({ type: 'error', file_id: 'one', message: 'Disk full', recoverable: false });
    await tick(); assert.strictEqual(posts.length, 2);
    complete(instance, 'two'); await batch;
    assert.match(instance.batchSummary.results[0].error, /Disk full/);
});
test('fast WebSocket completion before POST response still advances each item exactly once', async () => {
    const instance = app();
    const posts = fakeServer(instance, body => {
        complete(instance, body.file_id);
        return { ok: true, json: async () => ({ job_id: body.file_id }) };
    });
    await instance.processAllReady();
    assert.strictEqual(posts.length, 2); assert.strictEqual(instance.batchSummary.completed, 2);
    assert.ok(instance.uploadedFiles.every(file => file.status === 'completed'));
});
test('uncertain network failure does not submit a second potentially concurrent export', async () => {
    const instance = app(); const posts = fakeServer(instance, () => { throw new Error('Connection lost'); });
    await instance.processAllReady();
    assert.strictEqual(posts.length, 1); assert.strictEqual(instance.batchSummary.notStarted, 1);
    assert.strictEqual(instance.uploadedFiles[0].status, 'uncertain');
    assert.strictEqual(instance.batchProcessing, false);
});
test('a second batch or single export cannot be started while the batch is active', async () => {
    const instance = app(); const posts = fakeServer(instance);
    const batch = instance.processAllReady(); await tick();
    await instance.processAllReady(); await instance.processFile();
    assert.strictEqual(posts.length, 1);
    complete(instance, 'one'); await tick(); complete(instance, 'two'); await batch;
});
test('search state and zoom survive file switches; release choices derive from workspaces', () => {
    const instance = app();
    instance.searchResults = [{ id: 9, tracks: null }]; instance.onlyWithLengths = true; instance.currentZoom = 125;
    instance.selectFile('two'); instance.selectFile('one');
    assert.strictEqual(instance.searchResults[0].id, 9); assert.strictEqual(instance.onlyWithLengths, true);
    assert.strictEqual(instance.currentZoom, 125);
    instance.workspaces.two.selectedRelease = { ...release, id: 33 };
    assert.strictEqual(instance.releaseChoices.two.release.id, 33);
});
test('polling completion advances the batch when WebSocket delivery is missing', async () => {
    const previousSet = global.setInterval;
    let poll;
    global.setInterval = callback => { poll = callback; return 1; };
    try {
        const instance = app(); let posts = 0;
        global.fetch = async (url, options = {}) => {
            if (options.method === 'POST') {
                posts++;
                return { ok: true, json: async () => ({ job_id: JSON.parse(options.body).file_id }) };
            }
            return { ok: true, json: async () => ({ file_id: url.split('/').pop(), status: 'complete', tracks: ['saved'] }) };
        };
        const batch = instance.processAllReady(); await tick();
        assert.strictEqual(posts, 1); await poll(); await tick();
        assert.strictEqual(posts, 2); await poll(); await batch;
        assert.strictEqual(instance.batchSummary.completed, 2);
    } finally { global.setInterval = previousSet; }
});
test('a server export recovered after refresh can be selected and polled', () => {
    const instance = app();
    instance.currentFileId = null; instance.currentFile = null;
    instance.uploadedFiles[0].status = 'processing';
    instance.selectFile('one');
    assert.strictEqual(instance.currentFileId, 'one');
    assert.strictEqual(instance.currentJobId, 'one');
    complete(instance, 'one');
    assert.strictEqual(instance.isProcessing, false);
});
test('legacy browser saves receive search/zoom defaults without losing cuts', async () => {
    const instance = app(); const legacy = JSON.parse(JSON.stringify(instance.workspaces.one));
    for (const field of ['searchResults', 'onlyWithLengths', 'detailsSettled', 'currentZoom']) delete legacy[field];
    const previousWindow = global.window;
    global.window = { localStorage: { getItem: () => JSON.stringify({ version: 1, workspaces: { one: legacy } }), setItem() {} } };
    try {
        global.fetch = async () => ({ ok: true, json: async () => ({ uploaded: instance.uploadedFiles }) });
        instance.currentFileId = null; instance.currentFile = null;
        await instance.loadWorkspaces(); instance.selectFile('one');
        assert.strictEqual(instance.detectedTracks[0].start, 1);
        assert.deepStrictEqual(instance.searchResults, []); assert.strictEqual(instance.currentZoom, 50);
    } finally { global.window = previousWindow; }
});
(async () => {
    let failed = 0;
    // Polling is exercised separately; keep these WebSocket-driven tests free of real intervals.
    const previousSet = global.setInterval, previousClear = global.clearInterval;
    global.setInterval = () => 1; global.clearInterval = () => {};
    try {
        for (const { name, run } of cases) {
            try { await run(); } catch (error) { failed++; console.error(name + ': ' + error.message); }
        }
    } finally { global.setInterval = previousSet; global.clearInterval = previousClear; }
    assert.strictEqual(failed, 0, `${failed} batch regressions failed`);
    console.log('batch processing ok');
})().catch(error => { console.error(error); process.exit(1); });
