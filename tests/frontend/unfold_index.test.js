// Unfold an index track (suite / classical work) into its parts and back: tracks, targets,
// re-detection or banner, mapping reset, workspace round-trip, export positions, Undo.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();

const WORK = "Symphony No. 9 In E Minor, Op. 95 'From The New World'";
const movements = [['A1', 'I. Adagio', '9:30'], ['A2', 'II. Largo', '11:40'], ['B1', 'III. Scherzo', '8:10'], ['B2', 'IV. Allegro', '11:20']]
    .map(([position, title, duration]) => ({ position, title, duration }));
const mkRelease = () => ({ id: 424244, artist: 'Dvorak', title: 'New World', tracks: [
    { position: 'A1', title: 'Prelude', duration: '2:00' },
    { position: 'A2', title: WORK, duration: '40:40', parts: movements.map(m => ({ ...m })) },
    { position: 'B3', title: 'Encore', duration: '3:00' }] });

function mk() {
    const a = vinylApp();
    a.$nextTick = async () => {};
    a.currentFileId = 'f1';
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav' }];
    a.currentFile = a.uploadedFiles[0];
    a.selectedRelease = mkRelease();
    a.selectedSides = ['A', 'B'];
    a.detectedTracks = [1, 2, 3].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
    a.refreshRegionLabels = () => {};
    a.redetects = 0;
    a.redetectForTargets = () => { a.redetects++; return Promise.resolve(true); };
    return a;
}
const click = a => a.runToastAction(a.toasts[a.toasts.length - 1].id);
const positions = a => a.selectedRelease.tracks.map(t => t.position);

// ---- the listing ----
let a = mk();
assert.deepStrictEqual(a.indexTracks.map(e => [e.title, e.range, e.unfolded, e.umbrella.parts.length]), [[WORK, 'A1–B2', false, 4]]);
assert.strictEqual(a.targetTracks.length, 3);

// ---- unfold: parts replace the umbrella, side chips and targets follow ----
a.setIndexUnfolded(a.indexTracks[0], true);
assert.deepStrictEqual(positions(a), ['A1', 'A1', 'A2', 'B1', 'B2', 'B3']);
assert.deepStrictEqual(a.selectedRelease.tracks.slice(1, 5).map(t => t.title), movements.map(m => m.title));
assert.strictEqual(a.selectedRelease.tracks[2].duration, '11:40', 'parts carry their own length');
assert.deepStrictEqual(a.sideChips.map(g => [g.side, g.tracks.length]), [['A', 3], ['B', 3]]);
assert.strictEqual(a.targetTracks.length, 6);
assert.strictEqual(a.indexTracks[0].unfolded, true); assert.strictEqual(a.indexTracks[0].count, 4);
assert.strictEqual(a.redetects, 1, 'detection re-runs for the new count');
    assert.deepStrictEqual(a.customMapping, [0, 1, 2], 'mapping reset to the first targets');
assert.strictEqual(a.trackCountMismatch, true);

// ---- export carries part positions ----
a.detectedTracks = [1, 2, 3, 4, 5, 6].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
a.resetMappingToTargets();
const req = a.buildExportRequest('f1', a.currentWorkspaceState());
assert.deepStrictEqual(req.track_mapping.map(m => m.discogs), ['A1', 'A1', 'A2', 'B1', 'B2', 'B3']);

// ---- workspace JSON round-trip keeps the unfolded state and can fold back ----
const saved = JSON.parse(JSON.stringify(a.captureWorkspace()));
const b = mk();
b.selectedRelease = saved.selectedRelease;
assert.strictEqual(b.indexTracks[0].unfolded, true);
b.setIndexUnfolded(b.indexTracks[0], false);
assert.deepStrictEqual(positions(b), ['A1', 'A2', 'B3']);
assert.strictEqual(b.selectedRelease.tracks[1].title, WORK);
assert.strictEqual(b.selectedRelease.tracks[1].parts.length, 4);
assert.strictEqual(b.selectedRelease.tracks[1].duration, '40:40');

// ---- Undo restores the folded release and the target count ----
a = mk();
const before = JSON.stringify(a.selectedRelease);
a.setIndexUnfolded(a.indexTracks[0], true);
assert.strictEqual(a.toasts[a.toasts.length - 1].action.label, 'Undo');
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), before);
assert.strictEqual(a.targetTracks.length, 3);
assert.strictEqual(a.redetects, 2);

// ---- fold drops a side that only the parts had ----
a = mk();
a.selectedRelease.tracks.pop();  // work now ends the release
a.setIndexUnfolded(a.indexTracks[0], true);
assert.deepStrictEqual(a.sideChips.map(g => g.side), ['A', 'B']);
a.selectedSides = ['B'];
a.setIndexUnfolded(a.indexTracks[0], false);
assert.deepStrictEqual(a.sideChips.map(g => g.side), ['A']);
assert.deepStrictEqual(a.selectedSides, ['A'], 'a vanished side is dropped from the selection');

// ---- hand edits: ask first instead of re-detecting ----
a = mk();
a.boundariesEdited = true;
a.setIndexUnfolded(a.indexTracks[0], true);
assert.strictEqual(a.editBanner, true);
assert.strictEqual(a.redetects, 0);

// ---- disabled while analyzing or locked ----
a = mk();
a.analyzing = true;
a.setIndexUnfolded(a.indexTracks[0], true);
assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B3']);

// ---- "Work: Part" display titles (mirror of MetadataHandler._part_title) ----
a = mk();
a.setIndexUnfolded(a.indexTracks[0], true);
const part = a.selectedRelease.tracks[2];
assert.strictEqual(a.prefixPartTitles, true, 'prefix is on by default');
assert.strictEqual(a.partDisplayTitle(part), `${WORK}: II. Largo`);
assert.strictEqual(a.partDisplayTitle({ title: 'Encore' }), 'Encore', 'a non-part track is unchanged');
assert.strictEqual(a.partDisplayTitle({ title: `${WORK.toUpperCase()} - II`, umbrella: { title: WORK } }),
    `${WORK.toUpperCase()} - II`, 'a part already starting with the work title (any case) is left alone');
assert.strictEqual(a.partDisplayTitle({ title: '', umbrella: { title: WORK } }), WORK, 'empty part title falls back to the work');
assert.strictEqual(a.partDisplayTitle({ title: 'X', umbrella: { title: '' } }), 'X');
assert.strictEqual(a.trackOptionLabel(part), `A2 · ${WORK}: II. Largo`);
a.detectedTracks = [1, 2, 3, 4, 5, 6].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
a.resetMappingToTargets();
assert.ok(a.regionLabel(a.detectedTracks[2]).startsWith('A2 · Symphony No. 9'));
const firstPart = part.umbrella.parts[0].title;
assert.strictEqual(a.partPrefixExample, `${WORK}: ${firstPart}`, 'checkbox example: the first split part, prefixed');

// the request, signature and workspace carry the toggle
assert.strictEqual(a.buildExportRequest('f1', a.currentWorkspaceState()).prefix_part_titles, true);
const signatureOn = a.exportSignature();
a.prefixPartTitles = false;
assert.strictEqual(a.buildExportRequest('f1', a.currentWorkspaceState()).prefix_part_titles, false);
assert.notStrictEqual(a.exportSignature(), signatureOn, 'toggling allows another export');
assert.strictEqual(a.partDisplayTitle(part), 'II. Largo');
assert.strictEqual(a.trackOptionLabel(part), 'A2 · II. Largo');
assert.strictEqual(a.partPrefixExample, firstPart, 'checkbox example follows the toggle');
const restored = mk();
Object.assign(restored, JSON.parse(JSON.stringify(a.captureWorkspace())));
assert.strictEqual(restored.prefixPartTitles, false, 'workspace round-trip keeps the toggle');

// the rename form edits the bare part title, and renames never leak the prefix
a.prefixPartTitles = true;
a.customMapping = [0, 2, 3, 4, 5, 6];
a.openTrackForm(1, 'edit');
assert.strictEqual(a.trackForm.title, 'II. Largo');
assert.deepStrictEqual(a.customTracksPayload(a.selectedRelease), []);

// choosing another release resets the toggle
a.prefixPartTitles = false;
a.selectRelease(mkRelease());
assert.strictEqual(a.prefixPartTitles, true);
console.log('unfold index ok');
