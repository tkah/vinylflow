// The latest release pick wins: a card still loading its tracklist must not select its release
// once another release was picked, Change release was pressed, the recording was switched or
// re-analyzed, or an Undo put a release back.  Also: "Try Discogs again" without a token.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = (position, duration) => ({ position, title: `Song ${position}`, duration });
const fullRelease = (id) => ({ id, artist: 'Artist', title: `Pressing ${id}`, tracks: [track('A1', '5:00'), track('A2', '6:00')] });
const card = (id) => ({ id, artist: 'Artist', title: `Pressing ${id}`, tracks: null, detailStatus: 'pending' });

/** Release fetches stay pending until the test answers them, so a click can be left "loading". */
function fakeServer() {
    const pending = {}, searches = [];
    global.fetch = (url) => {
        if (url === '/api/search') { searches.push(url); return Promise.resolve({ ok: true, json: async () => ({ results: [], has_more: false }) }); }
        assert.ok(/^\/api\/release\/\d+$/.test(url), `unexpected request ${url} (tests must never reach Discogs)`);
        return new Promise(resolve => { pending[url.split('/').pop()] = resolve; });
    };
    return {
        searches,
        answer: (id, body = fullRelease(id)) => pending[id]({ ok: true, json: async () => body }),
    };
}

function mkApp() {
    const app = vinylApp();
    app.$nextTick = callback => callback?.();
    app.uploadedFiles = [{ id: 'f1', filename: 'side.wav', status: 'analyzed', duration: 600 }];
    app.currentFileId = 'f1';
    app.currentFile = app.uploadedFiles[0];
    app.detectedTracks = [{ number: 1, start: 0, end: 300, duration: 300, ignored: false },
                          { number: 2, start: 300, end: 600, duration: 300, ignored: false }];
    // The detection / waveform / persistence side effects of a pick are not under test here.
    app.afterTargetsChanged = () => {};
    app.loadAlbumDescription = () => {};
    app.saveWorkspace = () => {};
    app.persistWorkspaces = () => {};
    app.fetchScan = app.fetchHum = app.loadCachedClicks = () => {};
    app.destroyWaveform = app.pauseWaveform = app.initWaveform = () => {};
    app.toasts = [];
    app.notify = (message, options = {}) => { app.toasts.push({ message, ...options }); return app.toasts.length; };
    return app;
}

const failures = [];
/** Runs one scenario; a failure is reported but does not hide the others. */
async function scenario(name, body) {
    try { await body(); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

(async () => {
    // ---- "Try Discogs again" without a token opens the token setup instead of searching ----
    await scenario('"Try Discogs again" without a token opens the token setup in', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.discogsConfigured = false;
            app.tryDiscogsAgain();
            assert.strictEqual(app.setupRequired, true, 'the Discogs setup modal opens');
            assert.strictEqual(server.searches.length, 0, 'no search without a token');
    });

    // ---- a later pick wins over a card still loading ----
    await scenario('a later pick wins over a card still loading', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.searchResults = [card(1), Object.assign(card(2), fullRelease(2), { detailStatus: 'loaded' })];
            const clickA = app.chooseResult(app.searchResults[0]);   // waits for its tracklist
            app.chooseResult(app.searchResults[1]);                  // loaded: selected at once
            assert.strictEqual(app.selectedRelease.id, 2);
            server.answer(1);
            await clickA;
            assert.strictEqual(app.selectedRelease.id, 2, 'the earlier click does not override the later one');
            assert.ok(Array.isArray(app.searchResults[0].tracks), 'the card still fills in');
    });

    // ---- ...and a card is selected normally when nothing intervenes ----
    await scenario('...and a card is selected normally when nothing intervenes', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.searchResults = [card(1)];
            const click = app.chooseResult(app.searchResults[0]);
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease.id, 1);
            assert.strictEqual(app._pendingPickId, null);
    });

    // ---- Change release cancels the pick still loading ----
    await scenario('Change release cancels the pick still loading', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.searchResults = [card(1)];
            app.selectedRelease = fullRelease(9);
            const click = app.chooseResult(app.searchResults[0]);
            app.changeRelease();
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease, null, 'Change release cancels the pick still loading');
    });

    // ---- a file switch cancels it ----
    await scenario('a file switch cancels it', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.uploadedFiles.push({ id: 'f2', filename: 'other.wav', status: 'uploaded', duration: 600 });
            app.searchDiscogs = async () => {};
            app.searchResults = [card(1)];
            const click = app.chooseResult(app.searchResults[0]);
            app.selectFile('f2');
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease, null, 'a card of the previous recording never selects');
    });

    // ---- a re-analysis (which clears the release) started while a card loads ----
    await scenario('a re-analysis (which clears the release) started while a car', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.analyzeFile = async () => {};
            app.searchResults = [card(1)];
            app.selectedRelease = fullRelease(9);
            const click = app.chooseResult(app.searchResults[0]);
            await app.reanalyzeFile();
            assert.strictEqual(app.selectedRelease, null);
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease, null, 'the card must not select after the re-analysis cleared the release');
    });

    // ---- ...nor replace the release the re-analysis Undo put back ----
    await scenario('...nor replace the release the re-analysis Undo put back', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.analyzeFile = async () => {};
            app.searchResults = [card(1)];
            app.selectedRelease = fullRelease(9);
            const snapshot = app.snapshotEdits();
            snapshot.selectedRelease = app.selectedRelease;
            snapshot.selectedSides = [];
            snapshot.suggestedSides = [];
            const click = app.chooseResult(app.searchResults[0]);
            await app.restoreReanalyze('f1', snapshot);
            assert.strictEqual(app.selectedRelease.id, 9);
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease.id, 9, 'the release the Undo restored stays');
    });

    // ---- a release opened by link/number is a pick too: a card picked meanwhile wins ----
    await scenario('a card picked while a pasted release loads wins', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.searchResults = [Object.assign(card(2), fullRelease(2), { detailStatus: 'loaded' })];
            app.releaseIdInput = '7';
            const byId = app.openReleaseById();
            app.chooseResult(app.searchResults[0]);
            assert.strictEqual(app.selectedRelease.id, 2);
            server.answer(7);
            await byId;
            assert.strictEqual(app.selectedRelease.id, 2, 'the pasted release does not replace the later card pick');
            assert.strictEqual(app.releaseIdLoading, false);
    });

    // ---- ...and it never lands on another recording ----
    await scenario('a pasted release still loading never selects on another recording', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.uploadedFiles.push({ id: 'f2', filename: 'other.wav', status: 'uploaded', duration: 600 });
            app.searchDiscogs = async () => {};
            app.releaseIdInput = '7';
            const byId = app.openReleaseById();
            app.selectFile('f2');
            assert.strictEqual(app.releaseIdLoading, false, 'the new recording can paste a release at once');
            server.answer(7);
            await byId;
            assert.strictEqual(app.selectedRelease, null, 'release 7 is not selected on f2');
    });

    // ---- removing the open recording cancels a card still loading ----
    await scenario('closing the open recording cancels a card still loading', async () => {
            const server = fakeServer();
            const app = mkApp();
            app.searchResults = [card(1)];
            const click = app.chooseResult(app.searchResults[0]);
            app.closeCurrentFile();
            server.answer(1);
            await click;
            assert.strictEqual(app.selectedRelease, null, 'no release is selected with no recording open');
    });

    if (failures.length) { console.error(`${failures.length} scenario(s) failed`); process.exit(1); }
    console.log('latest_pick ok');
})().catch(error => { console.error(error); process.exit(1); });
