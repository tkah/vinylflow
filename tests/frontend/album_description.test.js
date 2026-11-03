// Album description (Wikipedia) preview: when it is fetched, the stale-response guard, the display
// gate, Retry, and the export request / signature. The browser only ever talks to our own backend.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const release = id => ({ id, artist: 'A', title: 'T', year: 1970, label: 'L', tracks: [{ position: 'A1', title: 'One', duration: '3:00' }] });

/** An app whose fetch is a fake: `replies` maps a URL to a function returning a promise of a body. */
function mk({ enabled = true } = {}) {
    const app = vinylApp();
    app.$nextTick = async () => {};
    app.config.album_description = enabled;
    app.fetches = [];
    app.replies = {};
    global.fetch = async url => {
        app.fetches.push(url);
        const body = await (app.replies[url] || (async () => ({ status: 'none' })))();
        return { ok: body.httpStatus ? false : true, status: body.httpStatus || 200, json: async () => body };
    };
    // Isolate from detection: the description feature must never depend on it.
    app.redetectForTargets = () => Promise.resolve(true);
    app.suggestSides = () => ({ sides: ['A'], matched: false, reason: '' });
    app.resetMappingToTargets = () => {};
    app.rememberChoice = () => {};
    return app;
}
const url = id => `/api/release/${id}/description`;
const found = { status: 'found', text: 'An album.', title: 'T (album)', url: 'https://en.wikipedia.org/wiki/T_(album)' };

(async () => {
    // 18: selectRelease fetches once when on; openReleaseById still exactly once; off -> no fetch
    let a = mk();
    a.replies[url(5)] = async () => found;
    a.selectRelease(release(5));
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(a.fetches, [url(5)]);
    assert.strictEqual(a.albumDescription.status, 'found');
    assert.strictEqual(a.albumDescription.releaseId, 5);
    assert.strictEqual(a.albumDescription.text, 'An album.');
    assert.strictEqual(a.albumDescription.url, found.url);

    a = mk();
    a.replies['/api/release/7'] = async () => release(7);
    a.replies[url(7)] = async () => found;
    a.releaseIdInput = '7';
    await a.openReleaseById();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(a.fetches.filter(u => u.endsWith('/description')), [url(7)], 'exactly one description fetch');

    a = mk({ enabled: false });
    a.selectRelease(release(5));
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(a.fetches, [], 'setting off: no request at all');
    assert.notStrictEqual(a.albumDescription.status, 'loading');

    // 19: restoreWorkspace fetches for the restored release
    a = mk();
    a.currentFileId = 'f1';
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav', duration: 400 }];
    a.currentFile = a.uploadedFiles[0];
    a.selectedRelease = release(9);
    const saved = JSON.parse(JSON.stringify(a.captureWorkspace()));
    const b = mk();
    b.replies[url(9)] = async () => found;
    b.workspaces = { f1: saved };
    b.restoreWorkspace('f1');
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(b.fetches, [url(9)]);
    assert.strictEqual(b.albumDescription.releaseId, 9);
    assert.strictEqual(b.albumDescriptionVisible, true);

    // 20: stale guard and display gate
    a = mk();
    let releaseSlowReply;
    a.replies[url(1)] = () => new Promise(resolve => { releaseSlowReply = () => resolve({ status: 'found', text: 'Album ONE', title: 'One', url: 'u1' }); });
    a.replies[url(2)] = async () => ({ status: 'found', text: 'Album TWO', title: 'Two', url: 'u2' });
    a.selectedRelease = release(1);
    const slow = a.loadAlbumDescription();
    a.selectedRelease = release(2);
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.text, 'Album TWO');
    releaseSlowReply();
    await slow;
    assert.strictEqual(a.albumDescription.text, 'Album TWO', "A's late reply leaves B's state alone");
    assert.strictEqual(a.albumDescription.releaseId, 2);
    assert.strictEqual(a.albumDescriptionVisible, true);
    a.selectedRelease = release(3);
    assert.strictEqual(a.albumDescriptionVisible, false, 'state for another release id is hidden');
    a.selectedRelease = null;
    assert.strictEqual(a.albumDescriptionVisible, false);

    // A reply that lands after the setting was switched off (Settings Save resets to idle) stays dropped
    a = mk();
    let releaseLateReply;
    a.replies[url(4)] = () => new Promise(resolve => { releaseLateReply = () => resolve(found); });
    a.selectedRelease = release(4);
    const late = a.loadAlbumDescription();
    a.config.album_description = false;
    await a.loadAlbumDescription();
    releaseLateReply();
    await late;
    assert.strictEqual(a.albumDescription.status, 'idle', 'switched off while loading: the late reply is ignored');
    assert.strictEqual(a.albumDescriptionVisible, false);

    // errors: a failed fetch or a 404 reads as error; disabled hides
    a = mk();
    a.replies[url(4)] = async () => ({ httpStatus: 404, detail: 'nope' });
    a.selectedRelease = release(4);
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.status, 'error');
    a.replies[url(4)] = async () => ({ status: 'disabled' });
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.status, 'disabled');
    global.fetch = async () => { throw new Error('offline'); };
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.status, 'error');

    // 22: Retry after error refetches
    a = mk();
    let attempt = 0;
    a.replies[url(6)] = async () => (++attempt === 1 ? { status: 'error' } : found);
    a.selectedRelease = release(6);
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.status, 'error');
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescription.status, 'found');
    assert.strictEqual(a.fetches.length, 2);

    // show more / less is local view state, reset for a new lookup
    a.albumDescriptionExpanded = true;
    a.selectedRelease = release(8);
    a.replies[url(8)] = async () => found;
    await a.loadAlbumDescription();
    assert.strictEqual(a.albumDescriptionExpanded, false);

    // 21: export request + signature
    const exportApp = enabled => {
        const app = mk({ enabled });
        app.selectedRelease = release(5);
        app.detectedTracks = [{ number: 1, start: 0, end: 100, ignored: false }];
        app.customMapping = [0];
        return app;
    };
    const on = exportApp(true), off = exportApp(false);
    assert.strictEqual(on.buildExportRequest('f1', on.currentWorkspaceState(false)).album_description, true);
    assert.strictEqual(off.buildExportRequest('f1', off.currentWorkspaceState(false)).album_description, false);
    const unset = exportApp(true); delete unset.config.album_description;
    assert.strictEqual(unset.buildExportRequest('f1', unset.currentWorkspaceState(false)).album_description, false, 'unknown counts as off');
    const signatureOn = on.exportSignature();
    on.config.album_description = false;
    assert.notStrictEqual(on.exportSignature(), signatureOn, 'toggling the setting changes the signature');

    // global setting: never part of a workspace
    assert.ok(!('album_description' in on.captureWorkspace()));

    console.log('album description ok');
})().catch(error => { console.error(error); process.exit(1); });
