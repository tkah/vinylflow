// Borrow track lengths from another pressing: visibility, progress, apply, undo, resets.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();

const T = (p, d) => ({ position: p, title: 't' + p, duration: d });
const mkRelease = (id = 7) => ({ id, artist: 'A', title: 'T', tracks: [T('A1', ''), T('A2', '4:00'), T('A3', ''), T('B1', ''), T('B2', '')] });

function mk(release = mkRelease(), sides = ['A']) {
    const a = vinylApp();
    a.$nextTick = async () => {};
    a.currentFileId = 'f1';
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav' }, { id: 'f2', filename: 'two.wav' }];
    a.currentFile = a.uploadedFiles[0];
    a.selectedRelease = release;
    a.selectedSides = sides;
    a.afterCalls = 0;
    a.afterTargetsChanged = () => { a.afterCalls++; return Promise.resolve(true); };
    return a;
}
const donor = (over = {}) => ({
    release_id: 99, label: 'Reissue', year: 2005, country: 'US', format: 'Vinyl, LP',
    matched: 4, total: 5, lengths: { '0': '3:00', '1': '9:99', '2': '5:00', '4': '2:30' }, ...over
});
const click = (a) => a.runToastAction(a.toasts[a.toasts.length - 1].id);

(async () => {
    // ---- visibility: target sides only ----
    let a = mk(mkRelease(), ['A']);
    assert.strictEqual(a.showBorrowLengths, true);
    assert.strictEqual(a.borrowLengthsMessage, 'Only 1/3 tracks have lengths');
    a = mk({ id: 1, tracks: [T('A1', '3:00'), T('A2', '4:00'), T('B1', ''), T('B2', '')] }, ['A']);
    assert.strictEqual(a.showBorrowLengths, false, 'full on target sides, gaps on the other side');
    a.selectedSides = ['B'];
    assert.strictEqual(a.showBorrowLengths, true);
    assert.strictEqual(a.borrowLengthsMessage, 'This release has no track lengths');
    a.selectedSides = ['A', 'B'];
    assert.strictEqual(a.borrowLengthsMessage, 'Only 2/4 tracks have lengths');
    a.selectedRelease = null;
    assert.strictEqual(a.showBorrowLengths, false);

    // ---- search: fetch, progress text, results ----
    a = mk();
    let resolveFetch;
    const urls = [];
    global.fetch = (url) => { urls.push(url); return new Promise(r => { resolveFetch = r; }); };
    const p = a.findLengthDonors();
    assert.deepStrictEqual(urls, ['/api/release/7/length-donors']);
    assert.strictEqual(a.donors.status, 'searching');
    assert.strictEqual(a.donorProgressText, 'Checking other pressings… (0 of up to 12)');
    a.handleWebSocketMessage({ type: 'donor_progress', release_id: 8, checked: 5, budget: 12, found: 0 });
    assert.strictEqual(a.donors.checked, 0, 'other release ignored');
    a.handleWebSocketMessage({ type: 'donor_progress', release_id: 7, checked: 3, budget: 12, found: 1 });
    assert.strictEqual(a.donorProgressText, 'Checking other pressings… (3 of up to 12)');
    resolveFetch({ ok: true, json: async () => ({ donors: [donor()] }) });
    await p;
    assert.strictEqual(a.donors.status, 'done');
    assert.strictEqual(a.donors.list.length, 1);
    assert.strictEqual(a.donorTitle(a.donors.list[0]), 'Reissue · 2005 · US · Vinyl, LP');

    // empty + error
    global.fetch = async () => ({ ok: true, json: async () => ({ donors: [] }) });
    await a.findLengthDonors();
    assert.deepStrictEqual([a.donors.status, a.donors.list.length], ['done', 0]);
    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({ detail: 'Discogs down' }) });
    await a.findLengthDonors();
    assert.deepStrictEqual([a.donors.status, a.donors.error], ['error', 'Discogs down']);
    global.fetch = async () => { throw new Error('offline'); };
    await a.findLengthDonors();
    assert.deepStrictEqual([a.donors.status, a.donors.error], ['error', 'offline']);

    // stale response after release change is dropped
    a = mk();
    global.fetch = () => new Promise(r => { resolveFetch = r; });
    const stale = a.findLengthDonors();
    a.changeRelease();
    resolveFetch({ ok: true, json: async () => ({ donors: [donor()] }) });
    await stale;
    assert.strictEqual(a.donors.status, 'idle');
    assert.deepStrictEqual(a.donors.list, []);

    // ---- apply: fills only missing, marker, afterTargetsChanged, toast ----
    a = mk();
    const rel = a.selectedRelease;
    a.donors = { releaseId: 7, status: 'done', checked: 2, budget: 12, list: [donor()], error: '' };
    a.applyDonor(donor());
    assert.deepStrictEqual(rel.tracks.map(t => t.duration), ['3:00', '4:00', '5:00', '', '2:30'],
        'existing 4:00 untouched; unparseable donor length (9:99 for A2) never used');
    assert.deepStrictEqual(a.lengthsBorrowedFrom, { release_id: 99, label: 'Reissue', year: 2005, country: 'US' });
    assert.strictEqual(a.borrowedLabel(a.lengthsBorrowedFrom), 'Reissue, 2005, US');
    assert.strictEqual(a.afterCalls, 1);
    assert.strictEqual(a.donors.status, 'idle');
    assert.strictEqual(a.showBorrowLengths, false, 'target side A now full');
    assert.strictEqual(a.releaseDurationInfo(rel).withDuration, 4);
    assert.strictEqual(a.toasts.length, 1);
    assert.strictEqual(a.toasts[0].type, 'success');
    assert.strictEqual(a.toasts[0].action.label, 'Undo');

    // ---- undo restores durations + marker, re-detects ----
    click(a);
    assert.deepStrictEqual(rel.tracks.map(t => t.duration), ['', '4:00', '', '', '']);
    assert.strictEqual(a.lengthsBorrowedFrom, null);
    assert.strictEqual(a.afterCalls, 2);
    assert.strictEqual(a.showBorrowLengths, true);

    // undo after switching release: restores the original object, no re-detect
    a = mk();
    const r1 = a.selectedRelease;
    a.applyDonor(donor());
    a.selectedRelease = mkRelease(8);
    const calls = a.afterCalls;
    click(a);
    assert.deepStrictEqual(r1.tracks.map(t => t.duration), ['', '4:00', '', '', '']);
    assert.strictEqual(a.afterCalls, calls);

    // nothing to fill -> no marker, no re-detect
    a = mk({ id: 3, tracks: [T('A1', '3:00')] });
    a.applyDonor(donor({ lengths: { '0': '9:00' } }));
    assert.strictEqual(a.lengthsBorrowedFrom, null);
    assert.strictEqual(a.afterCalls, 0);

    // ---- identity: marker + lengths travel with the shared release object ----
    a = mk();
    const shared = a.selectedRelease;
    a.workspaces = { f1: { selectedRelease: shared, selectedSides: ['A'] } };
    a.applyDonor(donor());
    a.currentFileId = 'f2';
    a.currentFile = a.uploadedFiles[1];
    assert.strictEqual(a.sameReleaseShortcuts[0].release, shared, 'same object offered to other files');
    a.selectedRelease = null;
    a.selectRelease(a.sameReleaseShortcuts[0].release);
    assert.strictEqual(a.lengthsBorrowedFrom.release_id, 99);
    assert.strictEqual(a.selectedRelease.tracks[0].duration, '3:00');

    // ---- reset on release change and file change ----
    a = mk();
    a.donors = { releaseId: 7, status: 'done', checked: 1, budget: 12, list: [donor()], error: '' };
    a.changeRelease();
    assert.strictEqual(a.donors.status, 'idle');
    assert.strictEqual(a.lengthsBorrowedFrom, null);
    a = mk();
    a.applyDonor(donor());
    a.donors = { releaseId: 7, status: 'done', checked: 1, budget: 12, list: [donor()], error: '' };
    a.selectedRelease = mkRelease(11);
    a.selectRelease(a.selectedRelease);
    assert.strictEqual(a.donors.status, 'idle');
    assert.strictEqual(a.lengthsBorrowedFrom, null, 'new release has no marker');
    a.donors = { releaseId: 7, status: 'done', checked: 1, budget: 12, list: [donor()], error: '' };
    a.fetchScan = () => {};
    a.selectFile('f2');
    assert.strictEqual(a.donors.status, 'idle');
    assert.strictEqual(a.selectedRelease, null);

    console.log('borrow_lengths: ok');
})().catch(e => { console.error(e); process.exit(1); });
