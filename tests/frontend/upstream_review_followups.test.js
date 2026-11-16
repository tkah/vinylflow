// Follow-ups from the upstream maintainer reviews (PRs #94, #95, #96), ported to the fork:
// edits made during a guided detection survive it, the 99-track cap, strict release-link
// parsing, "Load more" wording, guard tests for the pick/lookup tokens and the album
// description preview that used to stay on "Looking up...".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = (number, start, end) => ({ number, start, end, duration: end - start, editing: false, ignored: false });
const release = (id = 1, trackCount = 2) => ({ id, artist: 'A', title: 'T', year: 1970, label: 'L',
    tracks: Array.from({ length: trackCount }, (_, i) => ({ position: `A${i + 1}`, title: `T${i + 1}`, duration: '4:00' })) });

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
    app.initWaveform = async () => { app.waveform = { getDuration: () => 600, destroy() {} }; app.waveformRegions = { getRegions: () => [], clearRegions() {}, addRegion() {} }; };
    app.destroyWaveform = () => { app.waveform = null; app.waveformRegions = null; };
    app.addTrackRegions = () => {};
    return app;
}

/** A fetch whose replies the test resolves by hand: returns {fetch, pending} */
function manualFetch() {
    const pending = [];
    const fake = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
    return { fake, pending };
}
const guidedReply = (tracks, extra = {}) => ({ ok: true, json: async () => ({ tracks, method: 'durations', boundaries: [], ...extra }) });

// A request the test never answers leaves the script waiting on nothing: Node then exits 0 without
// reaching the end. Count that as a failure, or a guard that should prevent a request passes unseen.
let finished = false;
process.on('exit', () => {
    if (!finished) {
        console.error('upstream review followups did not finish (an unexpected request is still pending)');
        process.exitCode = 1;
    }
});

(async () => {
    // ---- A2. Edits made while a guided detection runs are kept ----
    const guidedSetup = () => {
        const app = mkApp();
        app.selectedRelease = release(1);
        app.selectedSides = ['A'];
        app.detectedTracks = [track(1, 0, 100), track(2, 100, 250), track(3, 250, 400)];
        app.customMapping = [0, 1, 2];
        app.expectedBoundaries = [111];
        return app;
    };
    let app = guidedSetup();
    let manual = manualFetch(); global.fetch = manual.fake;
    let running = app.redetectForTargets();
    assert.strictEqual(manual.pending.length, 1);
    app.deleteTrack(3);   // a real edit path while the request is out
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, false);
    assert.strictEqual(app.detectedTracks.length, 2, 'the hand-deleted track list is kept, not overwritten');
    assert.deepStrictEqual(app.detectedTracks.map(t => t.end), [100, 250]);
    assert.strictEqual(app.boundariesEdited, true);
    // The dashed markers on screen belonged to the sides before the edit and the tracks no longer match the
    // release: they go, and the ask-first banner offers Snap or keep. (The first version of this test pinned
    // [111] here, which encoded the bug of leaving stale markers behind.) No toast: the banner is the notice.
    assert.deepStrictEqual(app.expectedBoundaries, []);
    assert.strictEqual(app.editBanner, true);
    assert.strictEqual(app.processingMessage, '');
    assert.strictEqual(app.analyzing, false);
    assert.ok(!app.notices.some(n => /Kept your changes/.test(n.message)), 'no toast');

    // an edit through applyTrackBounds counts as well
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    app.applyTrackBounds(0, 0, 120);
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, false);
    assert.strictEqual(app.detectedTracks.length, 3);
    assert.strictEqual(app.boundariesEdited, true);

    // an Undo restore (outside detection) counts too
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    app.restoreEdits(app.snapshotEdits(), { rebuildRegions: false });
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, false);
    assert.strictEqual(app.detectedTracks.length, 3);

    // (b) the release cleared while pending: nothing installed
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    app.selectedRelease = null;
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, false);
    assert.strictEqual(app.detectedTracks.length, 3);
    assert.deepStrictEqual(app.expectedBoundaries, [111], 'a different release is none of this reply\'s business');
    assert.strictEqual(app.editBanner, false);
    assert.strictEqual(app.rescanNotice, '');

    // a copy-on-write replacement of the same release (custom track, rename) is not a change
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    app.selectedRelease = { ...app.selectedRelease };
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, true);
    assert.strictEqual(app.detectedTracks.length, 2);

    // a failed reply for a superseded request neither warns nor installs; stale markers go, the banner offers the choice
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    const originalError = console.error; console.error = () => {};
    running = app.redetectForTargets();
    app.deleteTrack(3);
    manual.pending[0].resolve({ ok: false, json: async () => ({ detail: 'boom' }) });
    await running;
    console.error = originalError;
    assert.deepStrictEqual(app.expectedBoundaries, []);
    assert.strictEqual(app.editBanner, true);
    assert.strictEqual(app.rescanNotice, '');

    // the same when the fetch itself rejects (the catch path's own check)
    app = guidedSetup();
    let rejectFetch;
    global.fetch = () => new Promise((_, reject) => { rejectFetch = reject; });
    console.error = () => {};
    running = app.redetectForTargets();
    app.deleteTrack(3);
    rejectFetch(new Error('network down'));
    await running;
    console.error = originalError;
    assert.deepStrictEqual(app.expectedBoundaries, []);
    assert.strictEqual(app.rescanNotice, '', 'no failure notice for a discarded request');
    assert.strictEqual(app.detectedTracks.length, 2);
    assert.strictEqual(app.analyzing, false);

    // (c) an undisturbed request installs; Snap on a superseded run offers no Undo and restores nothing
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, true);
    assert.strictEqual(app.detectedTracks.length, 2);
    assert.strictEqual(app.boundariesEdited, false, 'a detection that lands resets the edit flag');

    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    const snapping = app.snapToDiscogs();
    app.deleteTrack(3);
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    await snapping;
    assert.strictEqual(app.snapUndo, null);
    assert.strictEqual(app.detectedTracks.length, 2);
    assert.deepStrictEqual(app.detectedTracks.map(t => t.end), [100, 250], 'the hand edit stays');

    // ---- A3. More than 99 tracks on the chosen sides: no request, a notice ----
    app = mkApp();
    app.selectedRelease = release(1, 100);
    app.selectedSides = ['A'];
    let requests = 0;
    global.fetch = async () => { requests++; return guidedReply([]); };
    assert.strictEqual(await app.redetectForTargets(), false);
    assert.strictEqual(requests, 0);
    assert.match(app.rescanNotice, /100 tracks.*at most 99/);
    app.selectedRelease = release(1, 99);
    global.fetch = async () => { requests++; return guidedReply([track(1, 0, 100)]); };
    await app.redetectForTargets();
    assert.strictEqual(requests, 1, '99 tracks is still allowed');

    // ---- B2/B3. Release link parsing ----
    const parse = app.parseDiscogsRelease;
    const accepted = [
        ['2874426', { id: 2874426 }], ['r2874426', { id: 2874426 }], ['[r2874426]', { id: 2874426 }],
        ['https://www.discogs.com/release/2874426-Foo-Bar', { id: 2874426 }],
        ['https://www.discogs.com/release/2874426', { id: 2874426 }],
        ['discogs.com/release/2874426/', { id: 2874426 }],
        ['https://www.discogs.com/pt_BR/release/2874426', { id: 2874426 }],
        ['https://www.discogs.com/zh-hans/release/2874426-x', { id: 2874426 }],
        ['https://www.discogs.com/Artist-Title/release/2874426', { id: 2874426 }],
        ['https://www.discogs.com/sell/release/2874426?ev=rb', { id: 2874426 }],
        ['https://m.discogs.com/release/2874426#tracks', { id: 2874426 }],
        ['https://api.discogs.com/releases/2874426', { id: 2874426 }],
        ['m123', { master: 123 }], ['[m123]', { master: 123 }],
        ['https://www.discogs.com/master/123-Foo', { master: 123 }],
        ['https://api.discogs.com/masters/123', { master: 123 }],
        ['9999999999', { id: 9999999999 }],
    ];
    for (const [input, expected] of accepted) assert.deepStrictEqual(parse(input), expected, input);
    // pasted from prose: one wrapping layer and trailing punctuation are stripped
    for (const [input, expected] of [
        ['<https://www.discogs.com/release/5>', { id: 5 }], ['"https://www.discogs.com/release/5-Foo",', { id: 5 }],
        ['(https://www.discogs.com/master/9).', { master: 9 }], ['https://www.discogs.com/release/5.', { id: 5 }],
        ['https://api.discogs.com/releases/5;', { id: 5 }]]) assert.deepStrictEqual(parse(input), expected, input);
    for (const bad of ['https://www.discogs.com/release/5-Foo is the one I own', 'see <https://www.discogs.com/release/5>',
        'https://www.discogs.com/release/05', 'release/0']) assert.strictEqual(parse(bad), null, bad);
    for (const bad of ['', 'abc', '0', 'm0', 'r0', 'https://www.discogs.com/master/0', 'https://www.discogs.com/release/0',
        'notdiscogs.com/release/5', 'example.com/?u=discogs.com/release/8', 'https://evil.example/discogs.com/release/8',
        'https://www.discogs.com/release/12345678901', '12345678901', 'https://www.discogs.com/release/12x',
        'https://api.discogs.com/releases/0', 'https://www.discogs.com/artist/12']) {
        assert.strictEqual(parse(bad), null, bad);
    }

    // ---- B4. "Load more" wording depends on whether the server has another page ----
    for (const [hasMore, expectedNotice] of [[false, 'No more results.'], [true, 'No new results on this page.']]) {
        app = mkApp();
        app.searchedQuery = 'q'; app.searchPage = 1; app.searchHasMore = true;
        app.searchResults = [{ id: 1 }];
        global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ id: 1 }], has_more: hasMore }) });
        await app.loadMoreResults();
        assert.strictEqual(app.searchMoreNotice, expectedNotice);
        assert.strictEqual(app.searchHasMore, hasMore);
    }

    // ---- B6a. A superseded "exact pressing" lookup must not reset the loading flag of the newer one ----
    app = mkApp();
    app.selectRelease = () => {};
    manual = manualFetch(); global.fetch = manual.fake;
    app.releaseIdInput = '111';
    const lookupA = app.openReleaseById();
    assert.strictEqual(app.releaseIdLoading, true);
    app.changeRelease();   // supersedes A and resets the flag
    assert.strictEqual(app.releaseIdLoading, false);
    app.releaseIdInput = '222';
    const lookupB = app.openReleaseById();
    assert.strictEqual(app.releaseIdLoading, true);
    manual.pending[0].resolve({ ok: true, status: 200, json: async () => release(111) });
    await lookupA;
    assert.strictEqual(app.releaseIdLoading, true, "A's late reply must not clear B's loading flag");
    manual.pending[1].resolve({ ok: true, status: 200, json: async () => release(222) });
    await lookupB;
    assert.strictEqual(app.releaseIdLoading, false);

    // ---- B6b. The client page cap: the server says has_more on the last allowed page ----
    app = mkApp();
    app.searchedQuery = 'q'; app.searchPage = 2; app.searchHasMore = true;   // SEARCH_MAX_PAGES is 3
    app.searchResults = [{ id: 1 }];
    app.loadAllReleaseDetails = () => {};
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ id: 2, artist: 'x', title: 'y' }], has_more: true }) });
    await app.loadMoreResults();
    assert.strictEqual(app.searchPage, 3);
    assert.strictEqual(app.searchHasMore, false, 'no Load more beyond the page limit');

    // ---- B6c. Remove a file while its card pick loads, Undo: the late reply selects nothing ----
    app = mkApp();
    app.saveWorkspace = () => {};
    app.selectRelease = release => { app.selectedRelease = release; };
    manual = manualFetch(); global.fetch = manual.fake;
    app.releaseIdInput = '111';
    const lookupC = app.openReleaseById();
    app.removeFile('f');
    app.undoRemoveFile('f');
    manual.pending[0].resolve({ ok: true, status: 200, json: async () => release(111) });
    await lookupC;
    assert.strictEqual(app.selectedRelease, null, 'a pick started before the removal must not land after the Undo');
    // the card-click path uses the same pending-pick token
    app = mkApp();
    app.saveWorkspace = () => {};
    app._pendingPickId = 42;
    app.removeFile('f');
    assert.strictEqual(app._pendingPickId, null);

    // ---- C5. Preview stuck on "Looking up..." after clear + Undo ----
    app = mkApp();
    app.config.album_description = true;
    app.selectedRelease = release(5);
    manual = manualFetch(); global.fetch = manual.fake;
    const firstLoad = app.loadAlbumDescription();
    assert.strictEqual(app.albumDescription.status, 'loading');
    const snapshot = Object.assign(app.snapshotEdits(), { selectedRelease: release(5), selectedSides: [], suggestedSides: [] });
    app.selectedRelease = null;   // delete track / re-analyze clears the release while the lookup runs
    manual.pending[0].resolve({ ok: true, json: async () => ({ status: 'found', text: 'x' }) });
    await firstLoad;
    await app.restoreReanalyze('f', snapshot);   // Undo brings release 5 back
    assert.strictEqual(manual.pending.length, 2, 'Undo requests the description again');
    manual.pending[1].resolve({ ok: true, json: async () => ({ status: 'found', text: 'Lead paragraph', title: 'T', url: 'u' }) });
    await tick(); await tick();
    assert.strictEqual(app.albumDescription.status, 'found');
    assert.strictEqual(app.albumDescription.releaseId, 5);

    // ---- A3 (round 2). A first pick of a 120-track release: nothing detected yet, so the notice must be a toast ----
    app = mkApp();
    app.selectedRelease = release(1, 120);
    app.selectedSides = ['A'];
    app.expectedBoundaries = [10];
    app.detectedTracks = [];
    requests = 0; global.fetch = async () => { requests++; return guidedReply([]); };
    assert.strictEqual(await app.redetectForTargets(), false);
    assert.strictEqual(requests, 0);
    assert.deepStrictEqual(app.expectedBoundaries, [], 'markers of the previous sides are cleared');
    let warning = app.notices.find(n => n.type === 'warning');
    assert.ok(warning && /120 tracks.*at most 99 at a time\./.test(warning.message), 'a warning toast');
    assert.ok(!/Pick a disc or side/.test(warning.message), 'one side only: no advice to pick another');
    app = mkApp();
    app.selectedRelease = { ...release(1, 120), tracks: Array.from({ length: 120 }, (_, i) => ({ position: `${i < 60 ? 'A' : 'B'}${(i % 60) + 1}`, title: 't', duration: '1:00' })) };
    app.selectedSides = ['A', 'B'];
    await app.redetectForTargets();
    warning = app.notices.find(n => n.type === 'warning');
    assert.match(warning.message, /Pick a disc or side\./);
    assert.strictEqual(app.maxGuidedTracks, 99);
    app.rescanNotice = '';
    await app.smartRescan(100);
    assert.match(app.rescanNotice, /1–99/);

    // ---- A2 (round 2). Snap that finds nothing, with a hand edit made meanwhile: nothing is restored ----
    app = mkApp();
    app.selectedRelease = release(1); app.selectedSides = ['A'];
    app.detectedTracks = [track(1, 0, 100)]; app.customMapping = [0]; app.boundariesEdited = true;
    app.waveform = { getDuration: () => 600, destroy() {} };
    manual = manualFetch(); global.fetch = manual.fake;
    const snapEmpty = app.snapToDiscogs();
    app.deleteTrack(1);
    manual.pending[0].resolve(guidedReply([]));
    await snapEmpty;
    assert.strictEqual(app.detectedTracks.length, 0, 'the deleted track is not brought back by the Snap restore');
    assert.strictEqual(app.snapUndo, null);

    // ---- A2 (round 2). Row edits that no edit counter covers are refused while detecting; the reply then installs ----
    app = guidedSetup();
    app.selectedRelease = { ...release(1), tracks: [...release(1).tracks, { position: 'A3', title: 'T3', duration: '4:00' }] };
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    assert.strictEqual(app.analyzing, true);
    const before = JSON.stringify([app.customMapping, app.detectedTracks, app.selectedRelease, app.trackMappingReversed]);
    app.toggleTrackIgnored(app.detectedTracks[0]);
    app.setMapping(0, 2);
    app.reverseMapping();
    app.setTrackDeclick(0, 'light');
    assert.notStrictEqual(app.addCustomTrack(0, 'A9', 'Custom'), '');
    assert.notStrictEqual(app.renameTrack(0, 'Renamed'), '');
    assert.notStrictEqual(app.editCustomTrack(0, 'A9', 'x'), '');
    assert.notStrictEqual(app.resetRenamedTrack(0), '');
    assert.notStrictEqual(app.removeCustomTrack(0, 0), '');
    app.trackForm = null; app.openTrackForm(0, 'add');
    assert.strictEqual(app.trackForm, null, 'the inline form does not open');
    assert.strictEqual(JSON.stringify([app.customMapping, app.detectedTracks, app.selectedRelease, app.trackMappingReversed]), before);
    assert.strictEqual(app.boundaryEditCount, 0, 'refused edits do not count as edits');
    manual.pending[0].resolve(guidedReply([track(1, 0, 200), track(2, 200, 400)]));
    assert.strictEqual(await running, true);
    assert.strictEqual(app.detectedTracks.length, 2);

    // ---- B6b (round 2). The early return: no request once the page cap is reached ----
    app = mkApp();
    app.searchedQuery = 'q'; app.searchPage = 3; app.searchHasMore = true;
    requests = 0; global.fetch = async () => { requests++; return { ok: true, json: async () => ({ results: [], has_more: true }) }; };
    await app.loadMoreResults();
    assert.strictEqual(requests, 0);

    // ---- Round 3. An open Rename form must not survive a detection: the mapping it reads at Save is reset ----
    app = mkApp();
    app.selectedRelease = { ...release(1), tracks: [
        { position: 'A1', title: 'One', duration: '4:00' }, { position: 'A2', title: 'Two', duration: '4:00' },
        { position: 'B1', title: 'Three', duration: '4:00' }] };
    app.selectedSides = ['B'];
    app.detectedTracks = [track(1, 0, 100)]; app.customMapping = [2];
    app.openTrackForm(0, 'edit');
    assert.ok(app.trackForm, 'the form is open');
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    manual.pending[0].resolve(guidedReply([track(1, 0, 100), track(2, 100, 200)]));
    await running;
    assert.strictEqual(app.trackForm, null, 'a detection install closes the form');

    // ---- Round 3. Custom-track editors refuse while detecting, even for a track they would otherwise change ----
    app = mkApp();
    app.selectedRelease = { ...release(1), tracks: [
        { position: 'A1', title: 'One', duration: '4:00', custom: true },
        { position: 'A2', title: 'Two', duration: '4:00', renamed: true, originalTitle: 'Orig' }] };
    app.detectedTracks = [track(1, 0, 100), track(2, 100, 200)]; app.customMapping = [0, 1];
    app.analyzing = true;
    for (const [name, call] of [['edit', () => app.editCustomTrack(0, 'A9', 'x')], ['reset', () => app.resetRenamedTrack(1)], ['remove', () => app.removeCustomTrack(0, 0)]]) {
        assert.strictEqual(call(), 'Not available right now.', name);
    }
    app.analyzing = false;
    assert.notStrictEqual(app.resetRenamedTrack(1), 'Not available right now.', 'the same call works when idle');

    // ---- Round 3. A discarded reply with no tracks left shows no banner ----
    app = guidedSetup();
    manual = manualFetch(); global.fetch = manual.fake;
    running = app.redetectForTargets();
    app.deleteTrack(3); app.deleteTrack(2); app.deleteTrack(1);
    manual.pending[0].resolve(guidedReply([track(1, 0, 200)]));
    await running;
    assert.strictEqual(app.detectedTracks.length, 0);
    assert.strictEqual(app.editBanner, false);

    // ---- Round 3. Trailing ")" and punctuation inside a wrapper ----
    for (const [input, expected] of [['https://www.discogs.com/release/5)', { id: 5 }], ['<https://www.discogs.com/release/5.>', { id: 5 }]]) {
        assert.deepStrictEqual(app.parseDiscogsRelease(input), expected, input);
    }

    console.log('upstream review followups ok');
    finished = true;
})().catch(error => { console.error(error); process.exit(1); });
