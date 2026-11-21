// Typed Start / End / Length edits (ported from upstream PR 21's review fixes): refuse with a toast
// naming the reason and reset the field, instead of clamping a track to a sliver; a neighbour only
// counts when the edit shrinks it; a typed End or Length past the recording is capped at its end.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'index.html'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();

const track = (number, start, end, extra = {}) => ({ number, start, end, duration: end - start, ignored: false, editing: false, ...extra });
function mkApp(tracks) {
    const app = vinylApp();
    app.detectedTracks = tracks;
    app.toasts = []; app.notify = (message, options = {}) => { app.toasts.push({ message, ...options }); return app.toasts.length; };
    app.waveformRegions = { regions: [], getRegions() { return this.regions; } };
    app.waveformRegions.regions = tracks.map(t => {
        const region = { id: 'track-' + t.number, start: t.start, end: t.end, setOptions(o) { Object.assign(region, o); } };
        return region;
    });
    return app;
}
const ends = app => app.detectedTracks.map(t => [t.start, t.end]);

// ---- plain edits still work, with the fork's neighbour semantics (gaps kept, overlaps push) ----
let app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
app.updateTrackStart(1, '104');
assert.deepStrictEqual(ends(app), [[10, 100], [104, 200]]);
app.updateTrackStart(1, '95');
assert.deepStrictEqual(ends(app), [[10, 95], [95, 200]], 'overlapping the previous track pushes its end back');
app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
app.updateTrackEnd(0, '120');
assert.deepStrictEqual(ends(app), [[10, 120], [120, 200]]);
app.updateTrackEnd(0, '90');
assert.deepStrictEqual(ends(app), [[10, 90], [120, 200]], 'shortening leaves a gap');

// ---- nonsense changes nothing and says nothing ----
app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
const untouched = JSON.stringify(app.detectedTracks);
app.updateTrackStart(0, 'abc'); app.updateTrackEnd(0, '-5'); app.updateTrackStart(0, '');
assert.strictEqual(JSON.stringify(app.detectedTracks), untouched);
assert.strictEqual(app.boundariesEdited, false);
app.updateTrackStart(7, '5'); app.updateTrackEnd(7, '5');
assert.strictEqual(app.toasts.length, 0);

// ---- a typo must not collapse a track: refuse with a warning, reset the field, move nothing ----
const snapshot = () => JSON.stringify([app.detectedTracks, app.boundariesEdited]);
const refused = (label, run, pattern, expectedFieldValue) => {
    const input = { value: 'typed' };
    const state = snapshot(); const toastsBefore = app.toasts.length;
    run(input);
    assert.strictEqual(snapshot(), state, label + ': nothing changes');
    assert.strictEqual(app.toasts.length, toastsBefore + 1, label + ': one toast');
    assert.strictEqual(app.toasts.at(-1).type, 'warning', label);
    assert.match(app.toasts.at(-1).message, pattern, label);
    assert.strictEqual(String(input.value), String(expectedFieldValue), label + ': field reset');
};
app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
refused('End 5 on a track starting at 10', input => app.updateTrackEnd(0, '5', input), /after its start/i, 100);
refused('End equal to start', input => app.updateTrackEnd(0, '10', input), /after its start/i, 100);
refused('Start after the end', input => app.updateTrackStart(0, '150', input), /before its end/i, 10);
refused('Start equal to the end', input => app.updateTrackStart(0, '100', input), /before its end/i, 10);
refused('End under a second after the start', input => app.updateTrackEnd(0, '10.5', input), /at least 1 s/i, 100);
refused('End that leaves the next track under a second', input => app.updateTrackEnd(0, '199.5', input), /track 2/i, 100);
refused('Start that leaves the previous track under a second', input => app.updateTrackStart(1, '10.5', input), /track 1/i, 100);
// an ignored neighbour is still named (it keeps its cut points)
app = mkApp([track(1, 10, 100), track(2, 100, 200, { ignored: true })]);
refused('End that leaves an ignored neighbour under a second', input => app.updateTrackEnd(0, '199.5', input), /track 2/i, 100);
// accepted edits write the stored value back into the field
app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
let input = { value: '120' };
app.updateTrackEnd(0, '120', input);
assert.strictEqual(String(input.value), '120');

// ---- a neighbour only counts when the edit shrinks it ----
app = mkApp([track(1, 10, 100), track(2, 100, 100.5), track(3, 100.5, 200)]);
assert.ok(app.applyTrackBounds(0, 10, 99), 'shrinking track 1 leaves the already-short neighbour alone');
assert.strictEqual(app.detectedTracks[0].end, 99);
app = mkApp([track(1, 10, 100), track(2, 100, 100.5), track(3, 100.5, 200)]);
assert.ok(app.applyTrackBounds(2, 101, 200), 'moving track 3 start away from the short previous track');
assert.strictEqual(app.detectedTracks[2].start, 101);
app = mkApp([track(1, 10, 100), track(2, 100, 100.5), track(3, 100.5, 200)]);
assert.strictEqual(app.updateTrackEnd(0, '99', { value: '' }), true, 'the typed path agrees');
assert.strictEqual(app.updateTrackStart(2, '101', { value: '' }), true);

// ---- the end is capped at the recording's end (typed Start/End, Length and region updates share applyTrackBounds) ----
app = mkApp([track(1, 10, 100), track(2, 100, 200)]); app.playDuration = 300;
input = { value: '99999' };
app.updateTrackEnd(1, '99999', input);
assert.strictEqual(app.detectedTracks[1].end, 300, 'typed End past the recording');
assert.strictEqual(String(input.value), '300', 'the field shows the capped value');
app.waveformRegions.regions[1].end = 450; app.updateTrackFromRegion(app.waveformRegions.regions[1]);
assert.strictEqual(app.detectedTracks[1].end, 300, 'a region update is capped too');
app = mkApp([track(1, 10, 100), track(2, 100, 200)]); app.currentFile = { duration: 250 };
app.updateTrackEnd(1, '99999');
assert.strictEqual(app.detectedTracks[1].end, 250, 'falls back to the file duration');

// ---- Length: capped length explained even when nothing changed; refusals reset the field ----
app = mkApp([track(1, 100, 200)]); app.playDuration = 200;
input = { value: '5:00' };
assert.strictEqual(app.setTrackLength(0, '5:00', input), false);
assert.strictEqual(app.toasts.length, 1, 'the capped length is explained');
assert.match(app.toasts[0].message, /can only be/); assert.strictEqual(input.value, '1:40');
app = mkApp([track(1, 10, 100), track(2, 100, 200)]);
input = { value: '10:00' };
assert.strictEqual(app.setTrackLength(0, '10:00', input), false);
assert.strictEqual(app.toasts.at(-1).type, 'warning'); assert.match(app.toasts.at(-1).message, /track 2/i);
assert.strictEqual(input.value, '1:30');

// ---- the Start/End fields hand their element over so a refused edit can be reset ----
assert.ok(/updateTrackStart\(idx, \$event\.target\.value, \$event\.target\)/.test(html));
assert.ok(/updateTrackEnd\(idx, \$event\.target\.value, \$event\.target\)/.test(html));
// ---- a whole-region move past the recording's end keeps its length and stops at the end ----
// (e.g. the region's duration exceeds playDuration by a few ms; it used to shrink to [250, 300])
app = mkApp([track(1, 100, 200)]); app.playDuration = 300;
assert.strictEqual(app.applyTrackBounds(0, 250, 350), true);
assert.deepStrictEqual(ends(app), [[200, 300]], 'length 100 kept, shifted back to the end');
// a start beyond the recording (start-only move) never leaves the track past the end
app = mkApp([track(1, 100, 200)]); app.playDuration = 300;
app.applyTrackBounds(0, 350, 360);
assert.ok(app.detectedTracks[0].end <= 300 && app.detectedTracks[0].start <= 300 - 1 + 1e-6, 'start/end stay inside the recording');
app = mkApp([track(1, 100, 200)]); app.playDuration = 300;
app.applyTrackBounds(0, 150, 200.004 + 100);   // end-only past the end: capped
assert.strictEqual(app.detectedTracks[0].end, 300);

// ---- dragging toward an already sub-1 s neighbour stops at it, it does not jump backwards ----
const withShortMiddle = () => mkApp([track(1, 10, 100), track(2, 100, 100.5), track(3, 100.5, 200)]);
app = withShortMiddle();
app.applyTrackBounds(0, 10, 100.2);
assert.strictEqual(app.detectedTracks[0].end, 100, 'end stops at the short next track (base refused; never 99.5)');
assert.deepStrictEqual(ends(app).slice(1), [[100, 100.5], [100.5, 200]], 'the neighbours are untouched');
app = withShortMiddle();
app.applyTrackBounds(2, 100.3, 200);
assert.strictEqual(app.detectedTracks[2].start, 100.5, 'start stops at the short previous track');
assert.deepStrictEqual(ends(app).slice(0, 2), [[10, 100], [100, 100.5]]);

// ---- typed edits: a neighbour only counts when the edit actually shrinks it ----
app = withShortMiddle();
assert.strictEqual(app.updateTrackEnd(0, '99.8', { value: '' }), true, 'End 99.8 does not touch the short next track');
assert.strictEqual(app.detectedTracks[0].end, 99.8); assert.strictEqual(app.toasts.length, 0);
app = withShortMiddle();
assert.strictEqual(app.updateTrackStart(2, '100.8', { value: '' }), true, 'Start 100.8 does not touch the short previous track');
assert.strictEqual(app.detectedTracks[2].start, 100.8); assert.strictEqual(app.toasts.length, 0);
app = withShortMiddle();
assert.strictEqual(app.updateTrackEnd(0, '100.2', { value: '' }), false, 'End 100.2 would shrink the short next track further');
assert.match(app.toasts.at(-1).message, /track 2/i);
app = withShortMiddle();
assert.strictEqual(app.updateTrackStart(2, '100.3', { value: '' }), false, 'Start 100.3 would shrink the short previous track further');
assert.match(app.toasts.at(-1).message, /track 2/i);
console.log('typed_bounds ok');
