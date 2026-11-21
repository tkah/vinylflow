// Borrow lengths next to the fork's other release edits (custom / renamed tracks, split parts,
// title source): Undo of a borrow must not discard a later edit, and donor lengths (keyed by the
// server's tracklist) must land on the right track of a tracklist that has changed shape since.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

// An async test that never reaches its end would exit 0 unnoticed (run.js judges exit codes only).
let finished = false;
process.on('exit', () => {
    if (!finished) {
        console.error('borrow_lengths_edits tests did not finish');
        process.exitCode = 1;
    }
});

const T = (position, title, duration = '') => ({ position, title, duration });
const plainRelease = () => ({ id: 7, artist: 'A', title: 'T', tracks: [
    T('A1', 'Glass Harbor'), T('A2', 'Paper Lantern'), T('A4', 'Slow Meridian'), T('B1', 'Quiet Orchard')] });
const suiteRelease = () => ({ id: 7, artist: 'A', title: 'T', tracks: [
    T('A1', 'Glass Harbor'),
    { position: 'A2', title: 'Tidal Suite', duration: '', parts: [T('A2a', 'Ebb'), T('A2b', 'Flow')] },
    T('B1', 'Quiet Orchard')] });

function mk(release, sides = ['A', 'B']) {
    const app = vinylApp();
    app.$nextTick = async () => {};
    app.currentFileId = 'f1';
    app.uploadedFiles = [{ id: 'f1', filename: 'one.wav' }, { id: 'f2', filename: 'two.wav' }];
    app.currentFile = app.uploadedFiles[0];
    app.selectedRelease = release;
    app.selectedSides = sides;
    app.detectedTracks = release.tracks.map((_, i) => ({ number: i + 1, start: i * 100, end: i * 100 + 100, duration: 100 }));
    app.customMapping = release.tracks.map((_, i) => i);
    app.refreshRegionLabels = () => {};
    app.redetectForTargets = () => Promise.resolve(true);
    return app;
}
// A donor as the server answers it: keys are indexes of the server's (unedited) tracklist, with their positions
const donorFor = (release, lengthsByIndex) => ({
    release_id: 99, label: 'Reissue', year: 2005, country: 'US', format: 'LP',
    lengths: lengthsByIndex,
    positions: Object.fromEntries(Object.keys(lengthsByIndex).map(key => [key, release.tracks[Number(key)].position]))
});
const setList = (app, donors) => {
    app.donors = { releaseId: app.selectedRelease.id, status: 'done', checked: 1, budget: 12, list: donors, error: '' };
};
const lastToast = app => app.toasts[app.toasts.length - 1];
const toastMatching = (app, pattern) => app.toasts.filter(toast => pattern.test(toast.message)).pop();
const state = app => JSON.stringify({
    tracks: app.selectedRelease.tracks, mapping: app.customMapping, sides: app.selectedSides, titleSource: app.titleSource
});
const FOUR = { '0': '3:00', '1': '4:00', '2': '5:00', '3': '6:00' };
const CHANGED = /can no longer be undone: the release was edited or the recording was reopened/;

(async () => {
    // ---- borrow -> Undo still works when nothing else happened (and re-borrowing gives the same signature) ----
    let app = mk(plainRelease());
    const pristine = app.selectedRelease;
    const signatureBefore = app.exportSignature();
    setList(app, [donorFor(pristine, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    const signatureOfBorrow = app.exportSignature();
    assert.notStrictEqual(signatureOfBorrow, signatureBefore);
    app.runToastAction(toastMatching(app, /^Borrowed/).id);
    assert.strictEqual(app.selectedRelease, pristine);
    assert.strictEqual(app.exportSignature(), signatureBefore);
    // A lookup that is still on screen when Undo runs is for the release as it was: dropped
    app = mk(plainRelease());
    setList(app, [donorFor(app.selectedRelease, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    setList(app, [donorFor(app.selectedRelease, FOUR)]);   // a new lookup finished meanwhile
    app.runToastAction(toastMatching(app, /^Borrowed/).id);
    assert.strictEqual(app.donors.status, 'idle', 'Undo forgets the donor list');
    // borrow -> Undo -> the same borrow again has the same export signature (no counters in the saved state)
    app = mk(plainRelease());
    const firstRelease = app.selectedRelease;
    setList(app, [donorFor(firstRelease, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    const firstSignature = app.exportSignature();
    app.runToastAction(toastMatching(app, /^Borrowed/).id);
    setList(app, [donorFor(firstRelease, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    assert.strictEqual(app.exportSignature(), firstSignature, 'same borrow, same signature');
    assert.ok(!JSON.stringify(app.selectedRelease.lengthsBorrowedFrom).includes('borrowId'));

    // ---- Undo of a borrow refuses after a later release edit, and leaves everything as the edit made it ----
    const interleavings = {
        'custom track added (form path)': a => {
            a.openAddTrackForm?.(1);
            return a.addCustomTrack(1, 'A3', 'Hidden Interlude');
        },
        'track renamed': a => a.renameTrack(0, 'Glass Harbour Revisited'),
    };
    for (const [name, edit] of Object.entries(interleavings)) {
        app = mk(plainRelease());
        setList(app, [donorFor(app.selectedRelease, FOUR)]);
        app.applyDonor(app.donors.list[0]);
        const borrowToast = toastMatching(app, /^Borrowed/);
        assert.strictEqual(edit(app) || '', '', name);
        const edited = state(app);
        const editedRelease = app.selectedRelease;
        app.runToastAction(borrowToast.id);
        assert.strictEqual(state(app), edited, name + ': tracks, mapping, sides and titleSource unchanged');
        assert.strictEqual(app.selectedRelease, editedRelease, name);
        assert.strictEqual(lastToast(app).type, 'warning', name);
        assert.match(lastToast(app).message, CHANGED, name);
    }

    // ... and the edit's own Undo, which the fork already guards, says the same thing for a borrow made after it
    app = mk(plainRelease());
    assert.strictEqual(app.addCustomTrack(1, 'A3', 'Hidden Interlude') || '', '');
    const customToast = toastMatching(app, /^Added/);
    setList(app, [donorFor(plainRelease(), FOUR)]);
    app.applyDonor(app.donors.list[0]);
    const afterBorrow = state(app);
    app.runToastAction(customToast.id);
    assert.strictEqual(state(app), afterBorrow);
    assert.match(lastToast(app).message, CHANGED, 'the release changed, not the recording');
    assert.ok(!/Switch back/.test(lastToast(app).message));

    // ---- split into parts (copy-on-write now) ----
    app = mk(suiteRelease());
    const unsplit = app.selectedRelease;
    setList(app, [donorFor(unsplit, { '0': '3:00', '2': '6:00' })]);
    app.applyDonor(app.donors.list[0]);
    const borrowedCopy = app.selectedRelease;
    const borrowToast = toastMatching(app, /^Borrowed/);
    app.setIndexUnfolded(app.indexTracks[0], true);
    assert.notStrictEqual(app.selectedRelease, borrowedCopy, 'split is copy-on-write');
    assert.deepStrictEqual(borrowedCopy.tracks.map(t => t.position), ['A1', 'A2', 'B1'], 'the borrowed copy keeps its shape');
    const afterSplit = state(app);
    app.runToastAction(borrowToast.id);
    assert.strictEqual(state(app), afterSplit, 'Undo of the borrow refuses after a split');
    assert.match(lastToast(app).message, CHANGED);
    // the split's own Undo still works, and gives back the borrowed copy
    app.runToastAction(toastMatching(app, /split into/).id);
    assert.strictEqual(app.selectedRelease, borrowedCopy);
    assert.deepStrictEqual(app.customMapping, [0, 1, 2]);

    // ---- the split's own Undo refuses after a later edit of the split release ----
    app = mk(suiteRelease());
    app.setIndexUnfolded(app.indexTracks[0], true);
    const splitToast = toastMatching(app, /split into/);
    assert.strictEqual(app.renameTrack(0, 'Glass Harbour Revisited') || '', '');
    const afterRename = state(app);
    app.runToastAction(splitToast.id);
    assert.strictEqual(state(app), afterRename, 'the rename is kept');
    assert.match(lastToast(app).message, CHANGED);

    // ---- title source applied after a borrow ----
    const primary = fixture('discogs_release_16440030.json');
    const serialize = (raw, id) => ({ id, artist: 'Boston Pops Orchestra', title: raw.title, year: raw.year, label: 'RCA',
        tracks: raw.tracklist.map(t => {
            const parts = (t.sub_tracks || []).map(p => ({ position: p.position, title: p.title, duration: p.duration || '' }));
            const first = parts[0].position;
            const position = /^[A-Z]+$/.test(first) ? first + '1' : /^[A-Z]+\d+/.test(first) ? first.match(/^[A-Z]+\d+/)[0] : 'A1';
            return { position, title: t.title, duration: '', parts };
        }) });
    const movementDonor = serialize(fixture('discogs_release_9326206.json'), 9326206);
    app = mk(serialize(primary, 16440030));
    app.detectedTracks = [1, 2, 3].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
    app.customMapping = [0, 1, 1];
    setList(app, [donorFor(app.selectedRelease, { '1': '4:00' })]);
    app.applyDonor(app.donors.list[0]);
    const borrowToastTs = toastMatching(app, /^Borrowed/);
    global.fetch = async url => ({
        ok: true, status: 200,
        json: async () => String(url).startsWith('/api/release/') ? movementDonor : { ready: true, music_start: 10, music_end: 2400, side_changes: [[1300, 1310]] }
    });
    app.openMovementsPanel(); app.movementsPanel.input = '9326206';
    await app.loadMovementsDonor();
    app.movementsPanel.starts = [12];
    app.applyMovements();
    assert.ok(app.titleSource, 'title source applied');
    const afterMovements = state(app);
    app.runToastAction(borrowToastTs.id);
    assert.strictEqual(state(app), afterMovements, 'Undo of the borrow leaves the movements and titleSource alone');
    assert.match(lastToast(app).message, CHANGED);

    // ---- file switch away and back: the borrow Undo behaves like the fork's other undos ----
    app = mk(plainRelease());
    app.fetchScan = () => {}; app.loadAlbumDescription = () => {}; app.initWaveform = () => {};
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [], has_more: false }) });
    setList(app, [donorFor(app.selectedRelease, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    const switchToast = toastMatching(app, /^Borrowed/);
    app.currentFileId = 'f2';
    app.runToastAction(switchToast.id);
    assert.strictEqual(lastToast(app).type, 'warning', 'refused while another recording is open');
    assert.strictEqual(lastToast(app).message, 'Switch back to that file to undo.', 'by notifyUndo\'s own guard');
    assert.deepStrictEqual(app.selectedRelease.lengthsBorrowedFrom.length, 1);

    // Really leaving and reopening the recording: the workspace is restored from a JSON clone, so the
    // release is a different object and the identity-checked Undo refuses, saying so truthfully
    app = mk(plainRelease());
    app.fetchScan = () => {}; app.loadAlbumDescription = () => {}; app.initWaveform = () => {};
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [], has_more: false }) });
    setList(app, [donorFor(app.selectedRelease, FOUR)]);
    app.applyDonor(app.donors.list[0]);
    const reopenToast = toastMatching(app, /^Borrowed/);
    app.selectFile('f2');
    app.selectFile('f1');
    assert.strictEqual(app.currentFileId, 'f1');
    assert.strictEqual(app.selectedRelease.lengthsBorrowedFrom.length, 1, 'the borrowed copy came back with the workspace');
    const reopened = state(app);
    app.runToastAction(reopenToast.id);
    assert.strictEqual(state(app), reopened, 'nothing changed');
    assert.strictEqual(lastToast(app).type, 'warning');
    assert.match(lastToast(app).message, CHANGED);

    // ---- donor lengths are matched by Discogs position, not by the server's index ----
    // Split: index 1 of the server is the umbrella "A2"; here A2 became parts A2a / A2b.
    app = mk(suiteRelease());
    const server = suiteRelease();
    app.setIndexUnfolded(app.indexTracks[0], true);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.position), ['A1', 'A2a', 'A2b', 'B1']);
    setList(app, [donorFor(server, { '0': '3:00', '1': '9:00', '2': '6:00' })]);
    assert.deepStrictEqual(app.visibleDonors.map(d => [d.matched, d.missing]), [[2, 4]], 'the umbrella length fits no part: 2 of 4');
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.duration), ['3:00', '', '', '6:00'],
        'the umbrella length is applied to no part; B1 gets its own');
    // Custom track in the middle: A3 inserted before A4
    app = mk(plainRelease());
    assert.strictEqual(app.addCustomTrack(1, 'A3', 'Hidden Interlude') || '', '');
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.position), ['A1', 'A2', 'A3', 'A4', 'B1']);
    setList(app, [donorFor(plainRelease(), FOUR)]);
    assert.deepStrictEqual(app.visibleDonors.map(d => [d.matched, d.missing]), [[4, 5]], 'custom track is missing a length but nothing fills it');
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.title + ':' + t.duration),
        ['Glass Harbor:3:00', 'Paper Lantern:4:00', 'Hidden Interlude:', 'Slow Meridian:5:00', 'Quiet Orchard:6:00']);
    // A custom track that reuses a Discogs position is not the Discogs track
    app = mk(plainRelease());
    app.selectedRelease = { ...app.selectedRelease, tracks: [{ ...T('A1', 'Mine'), custom: true }, ...app.selectedRelease.tracks] };
    setList(app, [donorFor(plainRelease(), { '0': '3:00' })]);
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.duration), ['', '3:00', '', '', ''], 'goes to the Discogs A1');
    // A split part is not the Discogs track of its position, even if it shares it
    app = mk(plainRelease());
    app.selectedRelease = { ...app.selectedRelease, tracks: [{ ...T('A1', 'Part of a work'), umbrella: { position: 'A1', title: 'Work' } }, ...app.selectedRelease.tracks.slice(1)] };
    setList(app, [donorFor(plainRelease(), { '0': '3:00' })]);
    assert.deepStrictEqual(app.visibleDonors, []);
    // A title source's tracks are not Discogs tracks either
    app = mk(plainRelease());
    app.selectedRelease = { ...app.selectedRelease, tracks: [T('A1', 'Mvt One'), T('A2', 'Mvt Two'), ...app.selectedRelease.tracks.slice(2)] };
    app.titleSource = { release_id: 5, replace_position: 'A2', donor_position: null, assignments: [{ position: 'A1', source: 'A1' }, { position: 'A2', source: 'A2' }] };
    setList(app, [donorFor(plainRelease(), { '0': '3:00', '1': '4:00', '2': '5:00' })]);
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.duration), ['', '', '5:00', ''], 'A1 / A2 belong to the title source');
    // Untouched tracklists keep their index keying: duplicate positions are no obstacle ...
    const twinRelease = () => ({ id: 7, artist: 'A', title: 'T', tracks: [
        T('A1', 'One'), T('A2', 'Two'), T('A1', 'One again'), T('A2', 'Two again'), T('B1', 'Three')] });
    app = mk(twinRelease());
    setList(app, [donorFor(twinRelease(), { '0': '1:00', '1': '2:00', '2': '3:00', '3': '4:00', '4': '5:00' })]);
    assert.deepStrictEqual(app.visibleDonors.map(d => [d.matched, d.missing]), [[5, 5]]);
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.duration), ['1:00', '2:00', '3:00', '4:00', '5:00']);
    // ... nor are empty positions
    const unnumbered = () => ({ id: 7, artist: 'A', title: 'T', tracks: [T('', 'One'), T('', 'Two')] });
    app = mk(unnumbered(), ['A']);
    app.targetTracks;   // (sides of such a release are not the point here: place by index)
    app.releaseSides = () => [{ side: 'A', tracks: app.selectedRelease.tracks.map((t, i) => ({ ...t, releaseIdx: i })) }];
    setList(app, [donorFor(unnumbered(), { '0': '1:00', '1': '2:00' })]);
    app.applyDonor(app.donors.list[0]);
    assert.deepStrictEqual(app.selectedRelease.tracks.map(t => t.duration), ['1:00', '2:00']);
    // ... but once the list was reshaped, a shifted index must never be taken for the donor's track:
    // two custom tracks in front make index 2 hold the FIRST A1, which is not the donor's second A1
    app = mk(twinRelease());
    app.selectedRelease = { ...app.selectedRelease, tracks: [{ ...T('X1', 'Mine'), custom: true }, { ...T('X2', 'Mine too'), custom: true }, ...app.selectedRelease.tracks] };
    setList(app, [donorFor(twinRelease(), { '2': '3:00' })]);   // the server's second A1
    assert.deepStrictEqual(app.visibleDonors, [], 'ambiguous after the shift: no fill rather than a wrong one');
    // An empty position is only ever placed by index on an untouched list, never searched for
    app = mk(unnumbered(), ['A']);
    app.releaseSides = () => [{ side: 'A', tracks: app.selectedRelease.tracks.map((t, i) => ({ ...t, releaseIdx: i })) }];
    app.selectedRelease = { ...app.selectedRelease, tracks: [{ ...T('X1', 'Mine'), custom: true }, ...app.selectedRelease.tracks.slice(0, 1)] };
    setList(app, [donorFor(unnumbered(), { '0': '1:00' })]);
    assert.deepStrictEqual(app.visibleDonors, []);
    // Ambiguous or unknown positions are skipped
    app = mk(plainRelease());
    app.selectedRelease = { ...app.selectedRelease, tracks: [{ ...T('X1', 'Mine'), custom: true }, ...app.selectedRelease.tracks, T('A1', 'Twin')] };
    setList(app, [{ ...donorFor(plainRelease(), { '0': '3:00', '2': '5:00' }), positions: { '0': 'A1', '2': 'Z9' } }]);
    assert.deepStrictEqual(app.visibleDonors, [], 'two A1 tracks: ambiguous; Z9: unknown');
    // A donor from a server that sends no positions fills nothing
    app = mk(plainRelease());
    setList(app, [{ release_id: 5, lengths: { '0': '3:00' } }]);
    assert.deepStrictEqual(app.visibleDonors, []);
    // Unedited: unchanged behaviour
    app = mk(plainRelease());
    setList(app, [donorFor(plainRelease(), FOUR)]);
    assert.deepStrictEqual(app.visibleDonors.map(d => [d.matched, d.missing]), [[4, 4]]);
    // An unparseable donor length neither counts nor applies
    setList(app, [donorFor(plainRelease(), { '0': 'abc', '1': '4:00' })]);
    assert.deepStrictEqual(app.visibleDonors.map(d => d.matched), [1], 'the unparseable length is no fill');

    // ---- the lookup itself is refused while detecting or export-locked ----
    for (const [name, busy, text] of [
        ['detecting', a => { a.analyzing = true; }, /detection/],
        ['export-locked', a => { a.uploadedFiles[0].status = 'processing'; }, /exporting/],
    ]) {
        app = mk(plainRelease());
        let requests = 0;
        global.fetch = async () => { requests++; return { ok: true, json: async () => ({ donors: [] }) }; };
        busy(app);
        await app.findLengthDonors();
        assert.strictEqual(requests, 0, name);
        assert.strictEqual(app.donors.status, 'idle', name);
        assert.strictEqual(lastToast(app).type, 'warning', name);
        assert.match(lastToast(app).message, text, name);
    }

    finished = true;
    console.log('borrow_lengths_edits: ok');
})().catch(error => { console.error(error); process.exit(1); });
