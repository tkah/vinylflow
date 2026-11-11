// An imported file changed on disk (409): analyze, export and the waveform show the server's
// reason as an error toast, not a generic failure.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const vinylApp = new Function(src + ';return vinylApp;')();

const DETAIL = 'side.wav changed on disk since it was imported. Import it again to split the new recording.';
global.window = global.window || {};
// Every request (analyze, process, waveform peaks) is answered with the 409 the server sends.
global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: DETAIL }) });
// The waveform is faked: the 409 must surface before any audio is loaded.
global.WaveSurfer = {
    create: () => ({ on() {}, registerPlugin: () => ({}), destroy() {}, getMediaElement: () => ({ addEventListener() {}, removeEventListener() {} }) }),
    Regions: { create: () => ({}) },
};

function mkApp() {
    const a = vinylApp();
    a.uploadedFiles = [{ id: 'f1', filename: 'side.wav', status: 'analyzed', in_place: true, duration: 120 }];
    a.currentFileId = 'f1';
    a.currentFile = a.uploadedFiles[0];
    a.$nextTick = callback => callback?.();
    a.toasts = [];
    a.notify = (message, options = {}) => { a.toasts.push({ message, ...options }); return a.toasts.length; };
    return a;
}

function onlyError(a) {
    const errors = a.toasts.filter(t => t.type === 'error');
    assert.strictEqual(errors.length, 1, 'one error toast');
    return errors[0].message;
}

(async () => {
    let a = mkApp();
    await a.analyzeFile();
    assert.strictEqual(onlyError(a), `Analysis failed: ${DETAIL}`);
    assert.strictEqual(a.analyzing, false);

    // Export: the fork reports a rejected request through failExport (status 'error', the
    // detail kept on the file) rather than restoring the previous status.
    a = mkApp();
    a.selectedRelease = { id: 1, tracks: [{ position: 'A1', title: 'One' }] };
    a.selectedSides = ['A'];
    a.detectedTracks = [{ number: 1, start: 0, end: 60, duration: 60, ignored: false }];
    a.customMapping = [0];
    await a.processFile();
    assert.strictEqual(onlyError(a), `Processing error: ${DETAIL}`);
    assert.strictEqual(a.isProcessing, false);
    assert.strictEqual(a.uploadedFiles[0].status, 'error');
    assert.strictEqual(a.uploadedFiles[0].error, DETAIL);

    a = mkApp();
    // DOM-bound helpers have nothing to bind to in Node.
    a.tameRegionDragScroll = a.guardRegionDragRelease = a.bindWaveScrollbar = () => {};
    await a.initWaveform();
    assert.strictEqual(onlyError(a), `Failed to load waveform: ${DETAIL}`);
    assert.strictEqual(a.waveformLoading, false);

    console.log('source_changed: ok');
})().catch(e => { console.error(e); process.exit(1); });
