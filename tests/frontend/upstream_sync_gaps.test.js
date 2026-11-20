// Gaps ported from upstream: toasts for a refused release pick, a visible guided-detection failure,
// retrying detection with a release selected, Re-analyze restoring the work when it finds nothing,
// closeCurrentFile resetting searchLoading, and selectRelease ignoring a release without tracks.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const track = (number, start, end) => ({ number, start, end, duration: end - start, editing: false, ignored: false });
const release = (id = 1) => ({ id, artist: 'A', title: 'T', year: 1970, label: 'L', tracks: [
    { position: 'A1', title: 'One', duration: '4:00' }, { position: 'A2', title: 'Two', duration: '4:00' }] });

const EXPORTING_TEXT = 'This recording is exporting. Pick a release when the export has finished.';
const DETECTING_TEXT = 'Wait for track detection to finish before picking a release.';

function mkApp() {
    const app = vinylApp();
    app.$nextTick = async () => {};
    app.$refs = {};
    app.currentFileId = 'f';
    app.uploadedFiles = [{ id: 'f', filename: 'a.wav' }];
    app.currentFile = { duration: 600 };
    app.notices = [];
    const realNotify = app.notify.bind(app);
    app.notify = (message, options) => { app.notices.push({ message, ...options }); return realNotify(message, options); };
    app.initWaveform = async () => {
        app.waveform = { getDuration: () => 600, destroy() {}, pause() {} };
        app.waveformRegions = { getRegions: () => [], clearRegions() {}, addRegion() {} };
    };
    app.destroyWaveform = () => { app.waveform = null; app.waveformRegions = null; };
    app.addTrackRegions = () => {};
    return app;
}
const lockApp = app => Object.defineProperty(app, 'currentLocked', { get: () => true });
const warnings = (app, text) => app.notices.filter(n => n.type === 'warning' && n.message === text);

// A request the test never answers would exit 0 without reaching the asserts: count that as a failure.
let finished = false;
process.on('exit', () => {
    if (!finished) {
        console.error('upstream sync gaps did not finish (an unexpected request is still pending)');
        process.exitCode = 1;
    }
});

(async () => {
    // ---- 1. A refused release pick says why, once ----
    for (const via of ['selectRelease', 'chooseResult']) {
        for (const refusal of ['locked', 'analyzing']) {
            const app = mkApp();
            if (refusal === 'locked') lockApp(app); else app.analyzing = true;
            const text = refusal === 'locked' ? EXPORTING_TEXT : DETECTING_TEXT;
            app._pendingPickId = 99;
            if (via === 'selectRelease') app.selectRelease(release(2)); else await app.chooseResult(release(2));
            assert.strictEqual(warnings(app, text).length, 1, `${via} refused (${refusal}) toasts exactly once`);
            assert.strictEqual(app.notices.find(n => n.message === text).timeout, 5000);
            assert.strictEqual(app._pendingPickId, null, 'latest click still wins');
            assert.strictEqual(app.selectedRelease, null);
        }
    }
    // a pasted release link while detecting / exporting is refused with the same text
    let app = mkApp();
    app.analyzing = true;
    app.releaseIdInput = '2874426';
    global.fetch = async () => { throw new Error('no request expected'); };
    await app.openReleaseById();
    assert.strictEqual(warnings(app, DETECTING_TEXT).length, 1, 'pasted link refused while detecting');
    app = mkApp();
    lockApp(app);
    app.releaseIdInput = '2874426';
    await app.openReleaseById();
    assert.strictEqual(warnings(app, EXPORTING_TEXT).length, 1, 'pasted link refused while exporting');
    // a lookup that lands while detecting is refused by selectRelease with a toast
    app = mkApp();
    app.releaseIdInput = '2874426';
    global.fetch = async () => ({ ok: true, status: 200, json: async () => release(2874426) });
    const lookup = app.openReleaseById();
    app.analyzing = true;
    await lookup;
    assert.strictEqual(warnings(app, DETECTING_TEXT).length, 1);
    assert.strictEqual(app.selectedRelease, null);

    assert.strictEqual(app.releaseIdInput, '2874426', 'the refused link stays in the box to try again');
    // Enter in an empty box while detecting is no pick: nothing to refuse
    app = mkApp();
    app.analyzing = true;
    app.releaseIdInput = '  ';
    await app.openReleaseById();
    assert.strictEqual(app.notices.length, 0, 'an empty box toasts nothing');

    // ---- 2. Guided detection failing with no tracks is visible outside the track table ----
    app = mkApp();
    app.selectedRelease = release();
    app.selectedSides = ['A'];
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) });
    await app.redetectForTargets();
    assert.ok(app.notices.some(n => n.type === 'error' && /Boundary detection failed/.test(n.message)),
        'a failed guided detection toasts an error');
    assert.ok(/Boundary detection failed/.test(app.rescanNotice), 'the inline notice stays');

    // a failure of a run superseded by a hand edit stays silent
    app = mkApp();
    app.selectedRelease = release();
    app.selectedSides = ['A'];
    let rejectGuided;
    global.fetch = () => new Promise((resolve, reject) => { rejectGuided = reject; });
    const superseded = app.redetectForTargets();
    app.boundaryEditCount++;
    rejectGuided(new Error('boom'));
    await superseded;
    assert.strictEqual(app.notices.length, 0, 'a superseded failure toasts nothing');

    // ---- 3. With a release selected, the no-tracks action retries guided detection ----
    app = mkApp();
    app.selectedRelease = release();
    app.selectedSides = ['A'];
    let urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ tracks: [], method: 'count', matched: false }) }; };
    await app.retryOrSkipDetection();
    assert.deepStrictEqual(urls, ['/api/analyze-guided']);
    app = mkApp();
    urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ tracks: [] }) }; };
    await app.retryOrSkipDetection();
    assert.deepStrictEqual(urls, ['/api/analyze'], 'no release: silence-only detection');
    assert.strictEqual(warnings(app, 'No tracks were found in this recording. Try another release or adjust the silence settings.').length, 1, 'finding nothing says so');
    const html = fs.readFileSync(path.join(__dirname, '../../backend/static/index.html'), 'utf8');
    assert.ok(html.includes('retryOrSkipDetection()') && html.includes('Retry track detection'));

    // ---- 4. Re-analyze that finds nothing (or fails) puts the previous work back ----
    for (const outcome of ['empty', 'failed']) {
        app = mkApp();
        const rel = release();
        app.selectedRelease = rel; app.selectedSides = ['A']; app.customMapping = [0, 1];
        app.detectedTracks = [track(1, 0, 100), track(2, 100, 200)];
        global.fetch = async () => ({ ok: true, json: async () => ({ status: 'none' }) });
        app.analyzeFile = async () => {
            if (outcome === 'empty') app.setDetectedTracks([]); else app.notifyError('Analysis failed', new Error('x'));
        };
        await app.reanalyzeFile();
        assert.strictEqual(app.selectedRelease, rel, `${outcome}: release is back`);
        assert.deepStrictEqual(app.detectedTracks.map(t => t.end), [100, 200], `${outcome}: tracks are back`);
        assert.deepStrictEqual(app.selectedSides, ['A']);
        assert.ok(app.waveform, `${outcome}: waveform rebuilt`);
        assert.ok(!app.toasts.some(t => t.action), `${outcome}: no Undo toast`);
    }

    app = mkApp();
    app.selectedRelease = release(); app.selectedSides = ['A'];
    app.detectedTracks = [track(1, 0, 100), track(2, 100, 200)];
    app.analyzeFile = async () => { app.currentFileId = 'other'; app.selectedRelease = null; app.detectedTracks = []; };
    await app.reanalyzeFile();
    assert.strictEqual(app.selectedRelease, null, 'nothing restored onto another file');
    assert.strictEqual(app.detectedTracks.length, 0);

    // ---- 6. Closing the file resets searchLoading ----
    app = mkApp();
    app.searchLoading = true;
    app.closeCurrentFile();
    assert.strictEqual(app.searchLoading, false);

    // ---- 7. A release without tracks is ignored before it touches the pending pick ----
    app = mkApp();
    app._pendingPickId = 7;
    app.selectRelease({ id: 3 });
    assert.strictEqual(app._pendingPickId, 7);
    assert.strictEqual(app.selectedRelease, null);
    assert.strictEqual(app.notices.length, 0);

    finished = true;
    console.log('upstream sync gaps ok');
})().catch(err => { console.error(err); process.exit(1); });
