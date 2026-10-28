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

// ---- editing a row whose track other rows share: Save adds a new track for this row only ----
a = mk();
const sharedBefore = JSON.stringify(a.selectedRelease);
a.openTrackForm(5, 'edit');                             // rows 5 and 6 both map to B6
assert.deepStrictEqual(a.trackForm.sharedWith, [5], 'row number of the other row on B6');
assert.strictEqual(a.trackForm.position, 'B7', 'prefilled with the next free position');
assert.strictEqual(a.trackForm.title, 'Six');
a.trackForm.title = 'Bonus';
a.submitTrackForm();
assert.strictEqual(a.trackForm, null);
assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B1', 'B4', 'B6', 'B7']);
assert.strictEqual(a.selectedRelease.tracks[4].title, 'Six', 'the shared entry keeps its title');
assert.deepStrictEqual(a.selectedRelease.tracks[5], { position: 'B7', title: 'Bonus', duration: '', custom: true });
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 5], 'only this row moved to the new track');
assert.strictEqual(ready(a), '', 'no position is mapped twice any more');
assert.strictEqual(a.redetects, 0);
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), sharedBefore);
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 4]);

// plural note data, and the position field is enabled for a shared entry's form
a = mk();
a.customMapping = [0, 1, 2, 4, 4, 4];
a.openTrackForm(3, 'edit');
assert.deepStrictEqual(a.trackForm.sharedWith, [5, 6]);
assert.strictEqual(a.trackFormPositionLocked(), false);

// "Rename all" keeps the old behaviour: one shared entry, every row shows the new title
a = mk();
a.openTrackForm(5, 'edit');
a.trackForm.title = 'Everywhere';
a.renameAllSharedTracks();
assert.strictEqual(a.trackForm, null);
assert.strictEqual(a.selectedRelease.tracks[4].title, 'Everywhere');
assert.deepStrictEqual(a.customMapping, [0, 1, 2, 3, 4, 4]);
assert.strictEqual(positions(a).length, 5);

// a shared form refuses a taken position and stays open
a = mk();
a.openTrackForm(5, 'edit');
a.trackForm.position = 'B4';
a.submitTrackForm();
assert.match(a.trackForm.error, /B4 is already on this release/);

// not shared: unchanged (no sharedWith, position disabled, plain rename)
a = mk();
a.openTrackForm(0, 'edit');
assert.deepStrictEqual(a.trackForm.sharedWith, []);
assert.strictEqual(a.trackForm.position, 'A1');
assert.strictEqual(a.trackFormPositionLocked(), true);
a.trackForm.title = 'Uno';
a.submitTrackForm();
assert.strictEqual(a.selectedRelease.tracks[0].title, 'Uno');
assert.strictEqual(positions(a).length, 5);

// an ignored row on the same entry does not count as sharing
a = mk();
a.detectedTracks[4].ignored = true;
a.openTrackForm(5, 'edit');
assert.deepStrictEqual(a.trackForm.sharedWith, []);

// ---- custom track position is editable ----
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');                    // tracks A1 A2 B1 B4 B5* B6; rows -> [0,1,2,3,4,5]
const titleOfRow = i => a.mappedTrack(i).title;
const titlesBefore = [0, 1, 2, 3, 4, 5].map(titleOfRow);
const customJson = JSON.stringify(a.selectedRelease);
const customMapping = [...a.customMapping];
a.openTrackForm(4, 'edit');
assert.strictEqual(a.trackForm.sharedWith.length, 0);
assert.strictEqual(a.trackFormPositionLocked(), false, 'custom entries can move');
a.trackForm.position = ' b7 ';
a.trackForm.title = 'Moved';
a.submitTrackForm();
assert.strictEqual(a.trackForm, null);
assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B1', 'B4', 'B6', 'B7']);
assert.deepStrictEqual(a.selectedRelease.tracks[5], { position: 'B7', title: 'Moved', duration: '', custom: true });
assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(titleOfRow), titlesBefore.map(t => (t === 'Hidden' ? 'Moved' : t)),
    'every row still points at the same track');
assert.strictEqual(a.redetects, 0);
click(a);
assert.strictEqual(JSON.stringify(a.selectedRelease), customJson);
assert.deepStrictEqual(a.customMapping, customMapping);

// invalid or taken positions change nothing
a = mk();
a.addCustomTrack(4, 'B5', 'Hidden');
const stable = JSON.stringify(a.selectedRelease);
const toastCount = a.toasts.length;
a.openTrackForm(4, 'edit');
a.trackForm.position = '7';
a.submitTrackForm();
assert.match(a.trackForm.error, /side letter and a number/);
a.trackForm.position = 'B6';
a.submitTrackForm();
assert.match(a.trackForm.error, /B6 is already on this release/);
assert.strictEqual(JSON.stringify(a.selectedRelease), stable);
assert.strictEqual(a.toasts.length, toastCount);
a.trackForm.position = 'B5';                            // its own position and a new title: plain rename
a.trackForm.title = 'Renamed';
a.submitTrackForm();
assert.strictEqual(a.selectedRelease.tracks[4].title, 'Renamed');
assert.strictEqual(a.selectedRelease.tracks[4].position, 'B5');

// moving the only track of a side adds the new side and prunes the empty one
a = mk();
a.selectedSides = ['A', 'B'];
a.addCustomTrack(0, 'C1', 'Bonus');
a.openTrackForm(0, 'edit');
a.trackForm.position = 'B9';
a.submitTrackForm();
assert.ok(a.selectedSides.includes('B'));
assert.ok(!a.selectedSides.includes('C'), 'a side with no tracks left is dropped');

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
