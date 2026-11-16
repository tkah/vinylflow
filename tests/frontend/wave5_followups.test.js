// Follow-ups from the upstream review of the side-picker / release-link / album-description PRs,
// ported to the fork: guards while detecting, latest-click-wins on refusal, an empty Snap result,
// stale markers after a failed re-detection, release link shapes, "No more results.", and an
// unsaved Settings tick never reaching an export.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = (number, start, end) => ({ number, start, end, duration: end - start, editing: false, ignored: false });
const release = (id = 1) => ({ id, artist: 'A', title: 'T', year: 1970, label: 'L', tracks: [
    { position: 'A1', title: 'One', duration: '4:00' }, { position: 'A2', title: 'Two', duration: '4:00' }] });

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
    // Fake WaveSurfer: initWaveform builds a waveform + regions from the current tracks.
    app.regionsDrawn = [];
    app.initWaveform = async () => {
        app.waveform = { getDuration: () => 600, destroy() {} };
        app.waveformRegions = { getRegions: () => [], clearRegions() {}, addRegion() {} };
        app.regionsDrawn.push(app.detectedTracks.length);
    };
    app.destroyWaveform = () => { app.waveform = null; app.waveformRegions = null; };
    app.addTrackRegions = () => { app.regionsDrawn.push(app.detectedTracks.length); };
    return app;
}

// A request the test never answers leaves the script waiting on nothing: Node then exits 0 without
// reaching the end. Count that as a failure.
let finished = false;
process.on('exit', () => {
    if (!finished) {
        console.error('wave5 followups did not finish (an unexpected request is still pending)');
        process.exitCode = 1;
    }
});

(async () => {
    // ---- 1. Change release is refused while detecting (the running detection would land on no release) ----
    let app = mkApp();
    app.selectedRelease = release();
    app.analyzing = true;
    app.changeRelease();
    assert.ok(app.selectedRelease, 'changeRelease must not drop the release while a detection runs');
    app.analyzing = false;
    app.changeRelease();
    assert.strictEqual(app.selectedRelease, null);

    // ---- 7a. ...and clears the "exact pressing" loading flag ----
    app = mkApp();
    app.selectedRelease = release();
    app.releaseIdLoading = true;
    app.changeRelease();
    assert.strictEqual(app.releaseIdLoading, false);

    // ---- 2. A refused pick still ends the card that was loading ----
    for (const refusal of ['analyzing', 'locked']) {
        for (const via of ['selectRelease', 'chooseResult']) {
            app = mkApp();
            app.searchResults = [Object.assign({ id: 2, tracks: release(2).tracks }, {})];
            if (refusal === 'analyzing') app.analyzing = true;
            else Object.defineProperty(app, 'currentLocked', { get: () => true });
            app._pendingPickId = 99;   // an older card still loading
            if (via === 'selectRelease') app.selectRelease(release(2)); else await app.chooseResult(app.searchResults[0]);
            assert.strictEqual(app._pendingPickId, null, `${via} refused (${refusal}) must clear the pending pick`);
            assert.strictEqual(app.selectedRelease, null);
        }
    }
    // a double click on the card that is already opening is not a new pick
    app = mkApp();
    app._pendingPickId = 5;
    await app.chooseResult({ id: 5, opening: true });
    assert.strictEqual(app._pendingPickId, 5);

    // ---- 3. Snap to Discogs that finds nothing keeps the hand edits ----
    app = mkApp();
    app.selectedRelease = release();
    app.selectedSides = ['A'];
    app.detectedTracks = [track(1, 0, 100), track(2, 100, 250)];
    app.customMapping = [0, 1];
    app.boundariesEdited = true;
    app.waveform = { getDuration: () => 600, destroy() {} };
    app.waveformRegions = { getRegions: () => [], clearRegions() {}, addRegion() {} };
    global.fetch = async () => ({ ok: true, json: async () => ({ tracks: [], method: 'count', matched: false }) });
    await app.snapToDiscogs();
    assert.strictEqual(app.snapUndo, null, 'no Snapped/Undo banner for an empty result');
    assert.ok(!/Snapped/.test(app.snapNotice));
    assert.deepStrictEqual(app.detectedTracks.map(t => [t.start, t.end]), [[0, 100], [100, 250]], 'hand edits are back');
    assert.strictEqual(app.boundariesEdited, true);
    assert.ok(app.waveform, 'the waveform is rebuilt for the restored tracks');
    assert.strictEqual(app.regionsDrawn[app.regionsDrawn.length - 1], 2);
    assert.ok(app.notices.some(n => n.type === 'warning' && /No tracks/.test(n.message)), 'the user is warned');
    assert.strictEqual(app.rescanNotice, '', 'no "Placed 0 tracks" text left over');

    // ---- 3b. Undo of a snap rebuilds a missing waveform and clears the notice ----
    app = mkApp();
    app.selectedRelease = release();
    app.snapUndo = { tracks: [track(1, 0, 100)], mapping: [0], reversed: false, expected: [], edited: true };
    app.rescanNotice = 'Placed 2 tracks';
    app.waveform = null; app.waveformRegions = null;
    await app.undoSnap();
    assert.strictEqual(app.rescanNotice, '');
    assert.ok(app.waveform, 'waveform rebuilt');
    assert.strictEqual(app.detectedTracks.length, 1);

    // ---- 4. A failed re-detection drops the previous sides' dashed markers ----
    app = mkApp();
    app.selectedRelease = release();
    app.selectedSides = ['A'];
    app.expectedBoundaries = [95, 190];
    global.fetch = async () => ({ ok: false, json: async () => ({ detail: 'boom' }) });
    const originalError = console.error; console.error = () => {};
    await app.redetectForTargets();
    console.error = originalError;
    assert.deepStrictEqual(app.expectedBoundaries, []);

    // ---- 7b. "Load more" that adds nothing says so; a new search / reset clears it ----
    app = mkApp();
    app.searchedQuery = 'q'; app.searchPage = 1; app.searchHasMore = true;
    app.searchResults = [{ id: 1 }];
    // The last page (has_more false) says "No more results."; with another page the wording changes (B4).
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ id: 1 }], has_more: false }) });
    await app.loadMoreResults();
    assert.strictEqual(app.searchMoreNotice, 'No more results.');
    app.resetSearchResults();
    assert.strictEqual(app.searchMoreNotice, '');
    app.searchedQuery = 'q'; app.searchPage = 1; app.searchHasMore = true;
    app.searchResults = [{ id: 1 }];
    app.loadAllReleaseDetails = () => {};
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ id: 2, artist: 'x', title: 'y' }], has_more: false }) });
    app.searchMoreNotice = 'stale';
    await app.loadMoreResults();
    assert.strictEqual(app.searchMoreNotice, '');

    // ---- 8a. An unsaved Settings tick never reaches an export request ----
    app = mkApp();
    app.config = { album_description: false, output_dir: '/o', silence_threshold: -50 };
    app.openSettings();
    app.config.album_description = true;
    app.config.output_dir = '/typed';
    assert.strictEqual(app.config.album_description === true, true);
    app.closeSettings();   // Cancel / Escape / click-away
    assert.strictEqual(app.showSettings, false);
    assert.strictEqual(app.config.album_description, false);
    assert.strictEqual(app.config.output_dir, '/o');
    // ...and Save keeps the edits (the server reply becomes the config)
    app.openSettings();
    app.config.album_description = true;
    global.fetch = async () => ({ ok: true, json: async () => ({ album_description: true, output_dir: '/o' }) });
    app.loadAlbumDescription = () => {};
    await app.saveConfig();
    assert.strictEqual(app.config.album_description, true);
    assert.strictEqual(app.showSettings, false);
    app.openSettings(); app.closeSettings();
    assert.strictEqual(app.config.album_description, true, 'closing after a save must not roll back to the pre-save copy');
    // closing while already closed (Escape / click-away fire anywhere) changes nothing
    app.config.album_description = false;
    app.closeSettings();
    assert.strictEqual(app.config.album_description, false);

    // ---- 8c. Undo that restores a different release reloads its description preview ----
    app = mkApp();
    app.config.album_description = true;
    const loaded = [];
    app.loadAlbumDescription = () => { loaded.push(app.selectedRelease?.id ?? null); };
    app.selectedRelease = release(7);
    app.albumDescription = { releaseId: 7, status: 'found', text: 't', title: '', url: '' };
    const snapshot = Object.assign(app.snapshotEdits(), { selectedRelease: release(9), selectedSides: [], suggestedSides: [] });
    await app.restoreReanalyze('f', snapshot);
    assert.deepStrictEqual(loaded, [9]);
    // same release restored: nothing to reload
    app.albumDescription = { releaseId: 9, status: 'found', text: 't', title: '', url: '' };
    await app.restoreReanalyze('f', Object.assign(app.snapshotEdits(), { selectedRelease: release(9), selectedSides: [], suggestedSides: [] }));
    assert.deepStrictEqual(loaded, [9]);

    console.log('wave5 followups ok');
    finished = true;
})().catch(error => { console.error(error); process.exit(1); });
