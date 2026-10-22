// Custom tracks and renames: add from a track row, rename / reset / remove, copy-on-write of the
// (possibly shared) release, no re-detection, readiness, export request, Undo, workspace round-trip.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();

const mkRelease = () => ({ id: 77, artist: 'The Band', title: 'Album', tracks: [
    { position: 'A1', title: 'One', duration: '3:00' },
    { position: 'A2', title: 'Two', duration: '4:00' },
    { position: 'B1', title: 'Three', duration: '2:30' },
    { position: 'B4', title: 'Four', duration: '5:00' },
    { position: 'B6', title: 'Six', duration: '1:00' }] });

function mk() {
    const a = vinylApp();
    a.$nextTick = async () => {};
    a.currentFileId = 'f1';
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav', duration: 400 }];
    a.currentFile = a.uploadedFiles[0];
    a.selectedRelease = mkRelease();
    a.selectedSides = ['A', 'B'];
    a.detectedTracks = [1, 2, 3, 4, 5, 6].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
    a.customMapping = [0, 1, 2, 3, 4, 4];   // the sixth split has no track of its own: it doubles up on B6
    a.refreshRegionLabels = () => {};
    a.saveWorkspace = () => { a.saves = (a.saves || 0) + 1; };
    a.redetects = 0;
    a.redetectForTargets = () => { a.redetects++; return Promise.resolve(true); };
    a.analyzeGuided = a.redetectForTargets;
    return a;
}
const click = a => a.runToastAction(a.toasts[a.toasts.length - 1].id);
const positions = a => a.selectedRelease.tracks.map(t => t.position);
const ready = a => a.exportProblem(a.currentFile, a.currentWorkspaceState(false));

// ---- add from a row: prefill, insert order, remap, no re-detection ----
let a = mk();
const shared = a.selectedRelease;                       // what another workspace would also hold
const sharedJson = JSON.stringify(shared);
const cuts = JSON.stringify(a.detectedTracks);
a.openTrackForm(4, 'add');                              // row 5 maps to B6; the row above maps to B4
assert.strictEqual(a.trackForm.position, 'B5', 'next free position after the neighbour above');
assert.strictEqual(ready(a), 'Position B6 is mapped more than once.', 'the double-up is the problem we are fixing');
assert.strictEqual(a.addCustomTrack(4, ' b5 ', '  Hidden Gem  '), '');
assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B1', 'B4', 'B5', 'B6']);
assert.deepStrictEqual(a.selectedRelease.tracks[4], { position: 'B5', title: 'Hidden Gem', duration: '', custom: true });
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 5], 'mapping shifted by the insert; this row maps to the new track');
assert.strictEqual(a.redetects, 0, 'no re-detection');
assert.strictEqual(JSON.stringify(a.detectedTracks), cuts, 'no cut moved');
assert.strictEqual(ready(a), '', 'every track is mapped to a unique position');
assert.strictEqual(a.selectedRelease !== shared, true);
assert.strictEqual(JSON.stringify(shared), sharedJson, 'copy-on-write: the shared release object is untouched');
assert.strictEqual(a.trackCountMismatch, false);
assert.ok(a.saves >= 1, 'workspace saved');
assert.strictEqual(a.trackOptionLabel(a.selectedRelease.tracks[4]), 'B5 · Hidden Gem · custom');
assert.strictEqual(a.toasts[a.toasts.length - 1].action.label, 'Undo');

// ---- export request carries custom_tracks ----
let req = a.buildExportRequest('f1', a.currentWorkspaceState(false));
assert.deepStrictEqual(req.custom_tracks, [{ position: 'B5', title: 'Hidden Gem' }]);
assert.deepStrictEqual(req.track_mapping.map(m => m.discogs), ['A1', 'A2', 'B1', 'B4', 'B5', 'B6']);
assert.deepStrictEqual(a.buildExportRequest('f1', mk().currentWorkspaceState(false)).custom_tracks, [], 'nothing custom: empty list');

// ---- Undo ----
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), sharedJson);
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 4]);
assert.strictEqual(a.redetects, 0);

// ---- a position before every other (new side) and one on an unselected side ----
a = mk();
a.selectedSides = ['A'];
a.detectedTracks = a.detectedTracks.slice(0, 2);
a.customMapping = [0, 1];
assert.strictEqual(a.addCustomTrack(1, 'A3', 'Extra'), '');
assert.deepStrictEqual(positions(a).slice(0, 4), ['A1', 'A2', 'A3', 'B1']);
assert.deepStrictEqual(a.customMapping, [0, 2]);
assert.strictEqual(a.addCustomTrack(0, 'C1', 'Bonus'), '');
assert.strictEqual(positions(a).pop(), 'C1');

// ---- refused: duplicate, malformed, blank, too long ----
a = mk();
const before = JSON.stringify(a.selectedRelease);
assert.match(a.addCustomTrack(0, 'B4', 'x'), /B4 is already on this release/);
assert.match(a.addCustomTrack(0, '5', 'x'), /side letter and a number/);
assert.match(a.addCustomTrack(0, 'B5.1', 'x'), /side letter and a number/);
assert.match(a.addCustomTrack(0, 'B5', '   '), /Enter a title/);
assert.match(a.addCustomTrack(0, 'B5', 'x'.repeat(201)), /under 200/);
assert.strictEqual(JSON.stringify(a.selectedRelease), before);
assert.strictEqual(a.toasts.length, 0);
a.openTrackForm(4, 'add');
a.trackForm.position = 'B4'; a.trackForm.title = 'Dup';
a.submitTrackForm();
assert.match(a.trackForm.error, /already on this release/, 'the form stays open with the message');
a.trackForm.position = 'B5';
a.submitTrackForm();
assert.strictEqual(a.trackForm, null, 'form closes after a successful add');

// ---- locked recording: nothing changes ----
a = mk();
Object.defineProperty(a, 'currentLocked', { get: () => true });
assert.match(a.addCustomTrack(0, 'B5', 'x'), /Not available/);
assert.match(a.renameTrack(0, 'x'), /Not available/);
a.openTrackForm(0, 'edit');
assert.strictEqual(a.trackForm, null);

// ---- rename: copy-on-write, keeps position / length, original kept, reset ----
a = mk();
const other = a.selectedRelease;                        // another workspace's view of the same release
const otherJson = JSON.stringify(other);
assert.strictEqual(a.renameTrack(1, '  Deux  '), '');
assert.strictEqual(JSON.stringify(other), otherJson, 'shared release object untouched');
assert.deepStrictEqual(a.selectedRelease.tracks[1], { position: 'A2', title: 'Deux', duration: '4:00', originalTitle: 'Two', renamed: true });
assert.strictEqual(a.trackOptionLabel(a.selectedRelease.tracks[1]), 'A2 · Deux · renamed');
assert.strictEqual(a.redetects, 0);
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 4], 'mapping unchanged by a rename');
assert.strictEqual(a.renameTrack(1, 'Deux again'), '');
assert.strictEqual(a.selectedRelease.tracks[1].originalTitle, 'Two', 'the Discogs title is kept through repeated renames');
assert.deepStrictEqual(a.buildExportRequest('f1', a.currentWorkspaceState(false)).custom_tracks, [{ position: 'A2', title: 'Deux again' }]);
a.openTrackForm(1, 'edit');
assert.strictEqual(a.trackForm.title, 'Deux again');
a.resetTrackTitle();
assert.deepStrictEqual(a.selectedRelease.tracks[1], { position: 'A2', title: 'Two', duration: '4:00' });
assert.deepStrictEqual(a.buildExportRequest('f1', a.currentWorkspaceState(false)).custom_tracks, []);
assert.match(a.resetRenamedTrack(1), /Not available/, 'nothing to reset');
a.renameTrack(2, 'Trois');
a.renameTrack(2, 'Three');                              // typing the Discogs title back is a reset
assert.strictEqual(a.selectedRelease.tracks[2].renamed, undefined);
assert.match(a.renameTrack(2, ' '), /Enter a title/);
click(a); click(a);                                      // undo toasts, newest first

// ---- rename Undo ----
a = mk();
const pristine = JSON.stringify(a.selectedRelease);
a.renameTrack(0, 'Uno');
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), pristine);

// ---- renaming a custom track just retitles it (no originalTitle) ----
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');
a.renameTrack(4, 'Hidden Gem');
assert.deepStrictEqual(a.selectedRelease.tracks[4], { position: 'B5', title: 'Hidden Gem', duration: '', custom: true });

// ---- remove: only when no other row maps to it; undo ----
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');                    // row 5 -> B5 (index 4)
a.setMapping(5, 4);                                     // row 6 also maps to it
assert.match(a.removeCustomTrack(4, 4), /Another track is mapped to B5/);
assert.strictEqual(a.selectedRelease.tracks.length, 6);
a.setMapping(5, 5);
const withCustom = JSON.stringify(a.selectedRelease);
const mappingWith = [...a.customMapping];
assert.strictEqual(a.removeCustomTrack(4, 4), '');
assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B1', 'B4', 'B6']);
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 3, 4], 'this row falls back to the track before; later rows shift down');
assert.strictEqual(a.redetects, 0);
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), withCustom);
assert.deepStrictEqual(a.customMapping, mappingWith);
assert.match(a.removeCustomTrack(0, 0), /Not available/, 'Discogs tracks cannot be removed');

// ---- Undo declines once another release replaced the edit ----
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');
a.selectedRelease = mkRelease();
click(a);
assert.strictEqual(positions(a).length, 5, 'unchanged');
assert.strictEqual(a.toasts[a.toasts.length - 1].type, 'warning');

// ---- workspace JSON round-trip keeps custom + renamed entries and the export payload ----
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');
a.renameTrack(1, 'Deux');
const saved = JSON.parse(JSON.stringify(a.captureWorkspace()));
const b = mk();
b.selectedRelease = saved.selectedRelease;
b.customMapping = saved.customMapping;
assert.deepStrictEqual(b.customTracksPayload(b.selectedRelease), [{ position: 'A2', title: 'Deux' }, { position: 'B5', title: 'Hidden' }]);
assert.strictEqual(b.selectedRelease.tracks[1].originalTitle, 'Two');
assert.strictEqual(ready(b), '');

// ---- the export signature changes, so a completed export is marked as changed ----
a = mk();
const signature = a.exportSignature();
a.renameTrack(0, 'Uno');
assert.notStrictEqual(a.exportSignature(), signature);

// ---- changing the release drops an open form ----
a = mk();
a.openTrackForm(0, 'add');
a.changeRelease();
assert.strictEqual(a.trackForm, null);
console.log('custom_tracks ok');
