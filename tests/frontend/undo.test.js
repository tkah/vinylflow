// Undo flows: queue-file removal (delayed DELETE), track delete, re-analyze.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const trk = (n, s, e) => ({ number: n, start: s, end: e, duration: e - s, editing: false, ignored: false });

function mkRegions() {
    const list = [];
    return {
        list, getRegions: () => list, clearRegions() { list.length = 0; },
        addRegion(o) { const r = { ...o, element: {}, setOptions() {} }; list.push(r); return r; }
    };
}
function mkApp() {
    const a = vinylApp();
    a.$nextTick = async () => {};
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav' }, { id: 'f2', filename: 'two.wav' }, { id: 'f3', filename: 'three.wav' }];
    a.currentFileId = 'f2'; a.currentFile = a.uploadedFiles[1];
    a.waveform = { getDuration: () => 600, destroy() {}, pause() {} };
    a.waveformRegions = mkRegions();
    a.initWaveform = async () => { a.waveform = { getDuration: () => 600, destroy() {}, pause() {} }; a.waveformRegions = mkRegions(); a.addTrackRegions(); };
    return a;
}

(async () => {
    const deletes = [];
    global.fetch = async (url, opts) => { deletes.push(`${opts.method} ${url}`); return { ok: true, status: 200, json: async () => ({}) }; };

    // ---- file removal: soft remove, DELETE only after the window ----
    let a = mkApp();
    a.detectedTracks = [trk(1, 0, 100)];
    a.removeFile('f2', 40);
    assert.deepStrictEqual(a.uploadedFiles.map(f => f.id), ['f1', 'f3']);
    assert.strictEqual(a.currentFileId, null);
    assert.deepStrictEqual(a.detectedTracks, []);
    assert.strictEqual(deletes.length, 0, 'no DELETE inside the undo window');
    assert.strictEqual(a.toasts.length, 1);
    assert.strictEqual(a.toasts[0].action.label, 'Undo');
    await sleep(120);
    assert.deepStrictEqual(deletes, ['DELETE /api/queue/f2']);
    assert.strictEqual(a.toasts.length, 0);
    assert.deepStrictEqual(a.pendingRemovals, {});

    // ---- undo restores position and never calls DELETE ----
    deletes.length = 0;
    a = mkApp();
    a.workspaces = { f1: { selectedRelease: { id: 9 }, selectedSides: ['A'] } };
    a.removeFile('f1', 40);
    assert.ok(!('f1' in a.releaseChoices));
    a.runToastAction(a.toasts[0].id);
    assert.deepStrictEqual(a.uploadedFiles.map(f => f.id), ['f1', 'f2', 'f3']);
    assert.deepStrictEqual(a.releaseChoices.f1.sides, ['A']);
    assert.deepStrictEqual(a.pendingRemovals, {});
    await sleep(120);
    assert.strictEqual(deletes.length, 0);

    // ---- closing the toast (or unload) commits immediately; double commit is harmless ----
    a = mkApp();
    a.removeFile('f3', 5000);
    a.dismissToast(a.toasts[0].id);
    await sleep(10);
    assert.deepStrictEqual(deletes, ['DELETE /api/queue/f3']);
    deletes.length = 0;
    a.removeFile('f1', 5000); a.removeFile('f3', 5000);
    await a.commitAllRemovals();
    assert.deepStrictEqual(deletes.sort(), ['DELETE /api/queue/f1']);
    assert.strictEqual(a.toasts.length, 0);

    // removing the same file twice keeps one pending entry
    a = mkApp(); deletes.length = 0;
    a.removeFile('f1', 5000); a.removeFile('f1', 5000);
    assert.strictEqual(a.toasts.length, 1);
    await a.commitAllRemovals();
    assert.strictEqual(deletes.length, 1);

    // failed DELETE puts the file back and reports an error
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    a = mkApp();
    a.removeFile('f1', 5000);
    await a.commitAllRemovals();
    assert.ok(a.uploadedFiles.some(f => f.id === 'f1'));
    assert.ok(a.toasts.some(t => t.type === 'error'));
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    // ---- delete track: immediate, undo restores tracks + mapping + regions ----
    a = mkApp();
    a.detectedTracks = [trk(1, 0, 100), trk(2, 100, 200), trk(3, 200, 300)];
    a.customMapping = [0, 1, 2];
    a.addTrackRegions();
    assert.strictEqual(a.waveformRegions.list.length, 3);
    a.deleteTrack(2);
    assert.deepStrictEqual(a.detectedTracks.map(t => [t.number, t.start]), [[1, 0], [2, 200]]);
    assert.strictEqual(a.waveformRegions.list.length, 2);
    assert.strictEqual(a.boundariesEdited, true);
    const t = a.toasts[a.toasts.length - 1];
    assert.strictEqual(t.action.label, 'Undo');
    a.runToastAction(t.id);
    assert.deepStrictEqual(a.detectedTracks.map(x => [x.number, x.start, x.end]), [[1, 0, 100], [2, 100, 200], [3, 200, 300]]);
    assert.deepStrictEqual(a.customMapping, [0, 1, 2]);
    assert.strictEqual(a.boundariesEdited, false);
    assert.strictEqual(a.waveformRegions.list.length, 3);
    // deleting an unknown track does nothing
    a.toasts.length = 0; a.deleteTrack(42); assert.strictEqual(a.toasts.length, 0);
    // region-menu path goes through the same flow
    a.regionContextMenu = { show: true, trackNumber: 1 };
    a.deleteTrackFromRegionMenu();
    assert.strictEqual(a.detectedTracks.length, 2); assert.strictEqual(a.regionContextMenu.show, false);

    // ---- re-analyze: immediate, undo restores tracks + release + sides ----
    a = mkApp();
    const rel = { id: 7, tracks: [{ position: 'A1', title: 'x', duration: '1:40' }, { position: 'A2', title: 'y', duration: '1:40' }] };
    a.detectedTracks = [trk(1, 0, 100), trk(2, 100, 200)];
    a.selectedRelease = rel; a.selectedSides = ['A']; a.customMapping = [0, 1];
    a.boundariesEdited = true;
    a.analyzeFile = async () => { a.setDetectedTracks([trk(1, 0, 50), trk(2, 50, 120), trk(3, 120, 200)]); };
    await a.reanalyzeFile();
    assert.strictEqual(a.selectedRelease, null);
    assert.strictEqual(a.detectedTracks.length, 3);
    const rt = a.toasts[a.toasts.length - 1];
    assert.strictEqual(rt.action.label, 'Undo');
    a.runToastAction(rt.id);
    await sleep(5);
    assert.strictEqual(a.selectedRelease, rel);
    assert.deepStrictEqual(a.selectedSides, ['A']);
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [100, 200]);
    assert.deepStrictEqual(a.customMapping, [0, 1]);
    assert.strictEqual(a.boundariesEdited, true);
    assert.strictEqual(a.waveformRegions.list.length, 2);

    // undo after switching files refuses instead of clobbering
    a = mkApp();
    a.detectedTracks = [trk(1, 0, 100)];
    a.analyzeFile = async () => { a.setDetectedTracks([trk(1, 0, 50)]); };
    await a.reanalyzeFile();
    const stale = a.toasts[a.toasts.length - 1];
    a.currentFileId = 'f3';
    a.detectedTracks = [trk(1, 0, 10)];
    a.runToastAction(stale.id);
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [10]);
    assert.ok(a.toasts.some(x => x.type === 'warning'));

    // ---- the toast cap never commits a pending removal (review #86-2) ----
    deletes.length = 0;
    global.fetch = async (url, opts) => { deletes.push(`${opts.method} ${url}`); return { ok: true, status: 200, json: async () => ({}) }; };
    a = mkApp();
    a.uploadedFiles = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(id => ({ id, filename: `${id}.wav` }));
    a.currentFileId = null; a.currentFile = null;
    for (const f of [...a.uploadedFiles]) a.removeFile(f.id, 5000);
    await sleep(10);
    assert.deepStrictEqual(deletes, [], 'no DELETE inside any undo window');
    assert.strictEqual(a.toasts.filter(t => t.action).length, 6, 'every removal keeps its Undo');
    for (const t of [...a.toasts]) a.runToastAction(t.id);
    assert.deepStrictEqual(a.uploadedFiles.map(f => f.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    await sleep(10);
    assert.deepStrictEqual(deletes, []);

    // ...nor drops a delete-track Undo when error toasts pile up after it
    a = mkApp();
    a.detectedTracks = [trk(1, 0, 100), trk(2, 100, 200)];
    a.customMapping = [0, 1];
    a.deleteTrack(2);
    const delUndo = a.toasts[a.toasts.length - 1];
    for (let n = 1; n <= 5; n++) a.notify(`Failure ${n}`, { type: 'error' });
    assert.ok(a.toasts.some(t => t.id === delUndo.id), 'the Undo toast survives the cap');
    assert.deepStrictEqual(a.toasts.map(t => t.message).slice(1), ['Failure 2', 'Failure 3', 'Failure 4', 'Failure 5'],
        'the oldest toast without an action made room');
    a.runToastAction(delUndo.id);
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [100, 200]);

    // ---- Undo puts files back in their old order (review #86-3) ----
    const ids = (app) => app.uploadedFiles.map(f => f.id);
    const removalToast = (app, id) => app.toasts.find(t => t.id === app.pendingRemovals[id].toastId);
    for (const undoOrder of [['f1', 'f2'], ['f2', 'f1']]) {
        a = mkApp(); a.currentFileId = null; a.currentFile = null;
        a.removeFile('f1', 5000); a.removeFile('f2', 5000);
        const toastsById = { f1: removalToast(a, 'f1'), f2: removalToast(a, 'f2') };
        for (const id of undoOrder) a.runToastAction(toastsById[id].id);
        assert.deepStrictEqual(ids(a), ['f1', 'f2', 'f3'], `undo ${undoOrder.join(' then ')}`);
        await a.commitAllRemovals();
    }
    // a file added during the window doesn't break the order
    a = mkApp(); a.currentFileId = null; a.currentFile = null;
    a.removeFile('f2', 5000);
    a.uploadedFiles = [...a.uploadedFiles, { id: 'f4', filename: 'four.wav' }];
    a.runToastAction(removalToast(a, 'f2').id);
    assert.deepStrictEqual(ids(a), ['f1', 'f2', 'f3', 'f4']);
    // a failed DELETE puts the file back between its old neighbours
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    a = mkApp(); a.currentFileId = null; a.currentFile = null;
    a.removeFile('f2', 5000);
    await a.commitAllRemovals();
    assert.deepStrictEqual(ids(a), ['f1', 'f2', 'f3']);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    // ---- an Undo refuses while the recording is being re-detected or exported (review #86-4b) ----
    const deleteThenBlock = (block) => {
        const app = mkApp();
        app.detectedTracks = [trk(1, 0, 100), trk(2, 100, 200)];
        app.customMapping = [0, 1];
        app.deleteTrack(2);
        const undo = app.toasts[app.toasts.length - 1];
        block(app);
        app.runToastAction(undo.id);
        return app;
    };
    a = deleteThenBlock(app => { app.analyzing = true; });
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [100], 'undo during detection leaves the tracks alone');
    assert.ok(a.toasts.some(x => x.type === 'warning'));
    a = deleteThenBlock(app => { app.uploadedFiles[1].status = 'processing'; });   // f2 is exporting
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [100], 'undo while exporting leaves the tracks alone');
    assert.ok(a.toasts.some(x => x.type === 'warning'));
    // re-analyze Undo while a detection runs
    a = mkApp();
    a.detectedTracks = [trk(1, 0, 100)];
    a.analyzeFile = async () => { a.setDetectedTracks([trk(1, 0, 50)]); };
    await a.reanalyzeFile();
    const reUndo = a.toasts[a.toasts.length - 1];
    a.analyzing = true;
    a.runToastAction(reUndo.id);
    await sleep(5);
    assert.deepStrictEqual(a.detectedTracks.map(x => x.end), [50], 're-analyze undo during detection is refused');
    assert.ok(a.toasts.some(x => x.type === 'warning'));
    // file removal stays undoable while another recording is open or exporting
    a = mkApp();
    a.removeFile('f1', 5000);
    a.uploadedFiles[0].status = 'processing';   // f2, the open one, is exporting
    a.runToastAction(removalToast(a, 'f1').id);
    assert.deepStrictEqual(ids(a), ['f1', 'f2', 'f3']);

    console.log('undo ok');
})().catch(err => { console.error(err); process.exit(1); });
