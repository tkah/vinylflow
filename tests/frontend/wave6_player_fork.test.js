// Fork-only behaviour of the ported track-table / player fixes (upstream PRs 99 and 100): they meet the
// fork's export locks, per-recording workspaces and queued exports.
//  - playerReady is about the player, never the lock: an exporting (or queued, or album-job) recording keeps
//    Play / Pause / Space / row playback, while its Length and Start/End fields refuse typing,
//  - the "Use m:ss" toast action does nothing once its recording is locked or no longer the open one,
//  - switching recordings (and closing the last one) destroys the waveform and the fallback player
//    BEFORE the current id changes, so nothing of the old file is seen under the new id.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', 'backend', 'static');
const vinylApp = new Function(fs.readFileSync(path.join(root, 'app.js'), 'utf8') + ';return vinylApp;')();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// selectFile starts the scan/hum/click lookups of the recording it opens: none may reach a network
global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
const track = (number, start, end) => ({ number, start, end, duration: end - start, ignored: false, editing: false });
function mkApp(status = 'analyzed') {
    const app = vinylApp();
    app.toasts = [];
    app.notify = (message, options = {}) => { app.toasts.push({ message, ...options }); return app.toasts.length; };
    app.uploadedFiles = [{ id: 'one', filename: 'a.wav', status }, { id: 'two', filename: 'b.wav', status: 'analyzed' }];
    app.currentFileId = 'one';
    app.currentFile = app.uploadedFiles[0];
    app.detectedTracks = [track(1, 10, 100), track(2, 100, 200)];
    app.playDuration = 600;
    app.waveform = { destroy() {}, isPlaying: () => false, getCurrentTime: () => 1, getDuration: () => 600, setTime() {}, play: async () => {}, pause() {} };
    app.waveformRegions = null;
    app.syncRegionsAround = () => {};
    return app;
}
const cuts = app => app.detectedTracks.map(t => [t.start, t.end]);

// ---- playerReady ignores every kind of lock ----
for (const status of ['analyzed', 'processing', 'queued', 'uncertain']) {
    const app = mkApp(status);
    assert.strictEqual(app.currentLocked, status !== 'analyzed', status + ': lock state');
    assert.strictEqual(app.playerReady, true, status + ': the player stays usable');
}
{
    const app = mkApp(); app.uploadedFiles[0].album_job_status = 'running';
    assert.strictEqual(app.currentLocked, true);
    assert.strictEqual(app.playerReady, true, 'an unfinished album job locks editing, not playback');
}
// not ready without a loaded waveform, while it loads, or before its duration is known
for (const [label, change] of [['no waveform', a => { a.waveform = null; }], ['loading', a => { a.waveformLoading = true; }], ['no duration', a => { a.playDuration = 0; }]]) {
    const app = mkApp(); change(app);
    assert.strictEqual(app.playerReady, false, label);
}

// ---- Space still toggles a locked recording's player (and pauses it) ----
{
    const app = mkApp('processing');
    let toggles = 0; app.togglePlay = () => { toggles++; };
    const press = { code: 'Space', key: ' ', repeat: false, defaultPrevented: false, target: { tagName: 'DIV' }, prevented: false, preventDefault() { this.prevented = true; } };
    app.onGlobalKeydown(press);
    assert.strictEqual(toggles, 1, 'Space plays/pauses while exporting');
    assert.ok(press.prevented);
}

// ---- typing is refused while locked: nothing moves, the field shows the stored value ----
for (const status of ['processing', 'queued', 'uncertain']) {
    const app = mkApp(status);
    const before = JSON.stringify(cuts(app));
    const lengthField = { value: 'typed' };
    assert.strictEqual(app.setTrackLength(0, '2:00', lengthField), false, status);
    assert.strictEqual(lengthField.value, app.formatDuration(90), status + ': length field reset');
    const startField = { value: 'typed' };
    assert.strictEqual(app.updateTrackStart(1, '104', startField), false);
    assert.strictEqual(String(startField.value), '100', status + ': start field reset');
    assert.strictEqual(app.updateTrackEnd(0, '90', { value: '' }), false);
    assert.strictEqual(JSON.stringify(cuts(app)), before, status + ': no cut moved');
    assert.strictEqual(app.boundariesEdited, false, status + ': not marked as hand-edited');
    assert.strictEqual(app.toasts.length, 0, status + ': refused silently (the fields are disabled anyway)');
}
{
    const app = mkApp();   // control: unlocked edits still work
    assert.strictEqual(app.setTrackLength(0, '2:00', { value: '' }), true);
    assert.deepStrictEqual(cuts(app), [[10, 130], [130, 200]], 'touching next cut follows');
}

// ---- "Use m:ss": locked or another recording by the time it is clicked -> nothing happens ----
function suggestionFor(app) {
    assert.strictEqual(app.setTrackLength(0, '2.30', { value: '' }), false, '2.30 is refused, not read as 2.3 s');
    const toast = app.toasts.at(-1);
    assert.match(toast.message, /Type 2:30 for minutes and seconds\./);
    assert.strictEqual(toast.action.label, 'Use 2:30');
    return toast.action;
}
{
    const app = mkApp(); const action = suggestionFor(app);
    action.fn();
    assert.deepStrictEqual(cuts(app), [[10, 160], [160, 200]], 'the action applies 2:30 while the recording is open and free');
}
{
    const app = mkApp(); const action = suggestionFor(app);
    app.uploadedFiles[0].status = 'queued';   // Process & Save was queued meanwhile
    action.fn();
    assert.deepStrictEqual(cuts(app), [[10, 100], [100, 200]], 'locked meanwhile: refused');
}
{
    const app = mkApp(); const action = suggestionFor(app);
    app.currentFileId = 'two';                // another recording is open now
    action.fn();
    assert.deepStrictEqual(cuts(app), [[10, 100], [100, 200]], 'other recording open: refused');
}
{
    const app = mkApp(); app.setTrackLength(0, '2.75', { value: '' });
    assert.strictEqual(app.toasts.at(-1).action, undefined, 'seconds >= 60: no suggestion');
    assert.match(app.toasts.at(-1).message, /Type a length like 3:45/);
}

// ---- switching recordings destroys the waveform and fallback first ----
{
    const app = mkApp();
    app.$nextTick = () => {};
    const seen = [];
    app.destroyWaveform = function () { seen.push(['destroy', this.currentFileId]); this.fallbackAudioUrl = ''; this.waveform = null; };
    app.saveWorkspace = () => {};
    app.fallbackAudioUrl = '/api/audio/one';
    app.selectFile('two');
    assert.deepStrictEqual(seen[0], ['destroy', 'one'], 'destroyed while the old id was still current');
    assert.strictEqual(app.currentFileId, 'two');
    assert.strictEqual(app.fallbackAudioUrl, '', 'the fallback player of the old recording is gone');
}
{
    const app = mkApp();
    app.saveWorkspace = () => {}; app.abReset = () => {};
    const seen = [];
    app.destroyWaveform = function () { seen.push(this.currentFileId); };
    app.uploadedFiles = [app.uploadedFiles[0]];
    app.uploadedFiles[0].status = 'complete';
    app.resetForNextFile();
    assert.strictEqual(seen[0], 'one', 'resetForNextFile destroys before the id is cleared');
    assert.strictEqual(app.currentFileId, null);
}
// a locked recording is not reset away (its export is running)
{
    const app = mkApp('processing'); let destroyed = 0;
    app.destroyWaveform = () => { destroyed++; };
    app.resetForNextFile();
    assert.strictEqual(destroyed, 0);
    assert.strictEqual(app.currentFileId, 'one');
}

// ---- markup: no playback control waits on the lock; the fallback player replaces the waveform box ----
for (const click of ["togglePlay()", "zoomIn()", "zoomOut()", "toggleTrackPlay(idx)", "auditionCut(idx, 'start')"]) {
    const tag = html.match(new RegExp('<button @click="' + click.replace(/[()]/g, '\\$&') + '"[^>]*>'))[0];
    assert.ok(/:disabled="!playerReady/.test(tag) && !/currentLocked/.test(tag), click + ' waits for the player, not for the lock');
}
assert.ok(!/inputmode="decimal"/.test(html), 'a decimal keypad would hide the colon of m:ss');
console.log('wave6_player_fork: ok');
