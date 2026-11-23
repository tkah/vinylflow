// Player/waveform review fixes ported from upstream PR 21 / PR 23: play() failures, the
// media-error fallback rule (only codes 3/4), the fallback generation guard, raw audio
// source, preload, teardown clearing the loading overlay, held Space, and the stale guards
// of initWaveform / the ready handler.  WaveSurfer, the media element and fetch are faked.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const { vinylApp, PREVIEW_AUDIO_NOTICE } = new Function(src + ';return {vinylApp, PREVIEW_AUDIO_NOTICE};')();

const nextTask = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let finished = false;
process.on('exit', () => { if (!finished) { console.error('player_review_fixes: async part did not finish'); process.exitCode = 1; } });

/** `loadResults` is consumed one per load(): 'ok' resolves, 'fail' rejects, a promise is settled by the test. */
function harness({ canPlay = 'maybe', peaks = [0.1, 0.2, 0.05], loadResults = [], fetchOverride = null } = {}) {
    const app = vinylApp();
    app.currentFileId = 'one';
    app.detectedTracks = [];
    const wave = {
        handlers: {}, loads: [], plays: 0, pauses: 0, zooms: [], times: [],
        media: { listeners: {}, error: null, readyState: 0, preload: '', canPlayType: () => canPlay,
            addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {} },
        on(name, fn) { this.handlers[name] = fn; },
        getMediaElement() { return this.media; },
        registerPlugin() { return { on() {}, getRegions: () => [], clearRegions() {} }; },
        getWrapper: () => ({ getBoundingClientRect: () => ({ left: 0, width: 1000 }), addEventListener() {}, parentElement: null }),
        isPlaying: () => false, getCurrentTime: () => 0,
        zoom(value) { this.zooms.push(value); },
        setTime(time) { this.times.push(time); }, destroy() {}, getDuration: () => 120,
        play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; },
        load(url, loadedPeaks, duration) {
            this.loads.push({ url, peaks: loadedPeaks, duration });
            this.media.error = null;   // a new source clears the element's error, like a real reload
            const result = loadResults.shift() || 'ok';
            if (typeof result !== 'string') return result;
            return result === 'ok' ? Promise.resolve() : Promise.reject(new Error('load failed'));
        },
    };
    const container = { offsetWidth: 1000, added: [], addEventListener(name) { this.added.push(name); } };
    wave.container = container;
    global.document = { getElementById: () => container, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    global.WaveSurfer = { create: options => { wave.options = options; return wave; }, Regions: { create: () => ({}) } };
    global.fetch = fetchOverride || (async url => {
        assert.strictEqual(url, '/api/waveform-peaks/one');
        return { ok: true, json: async () => ({ peaks, duration: 120 }) };
    });
    return { app, wave };
}
async function started(options) {
    const result = harness(options);
    await result.app.initWaveform();
    return result;
}
// The vendored WaveSurfer registers its own media 'error' listener before ours and re-emits it as
// emit('error', undefined); then our media listener runs. Fakes must forward errors in that order.
const mediaError = (wave, code) => {
    wave.media.error = { code };
    if (wave.handlers.error) wave.handlers.error(undefined);
    wave.media.listeners.error();
};
const decodeError = wave => mediaError(wave, 3);

(async () => {
    // ---- startPlayback ----
    let { app, wave } = await started();
    // WaveSurfer 7.8.10 rejects play() with AbortError when paused before playback starts: not a failure
    wave.play = () => Promise.reject(Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }));
    app.isPlaying = true; app.startPlayback(); await nextTask();
    assert.strictEqual(app.playerNotice, '', 'AbortError shows no notice');
    assert.strictEqual(app.isPlaying, true, 'AbortError leaves the transport state to the player events');
    // a genuine failure: not playing, the element stopped (next click plays), notice shown
    wave.play = () => Promise.reject(Object.assign(new Error('no supported sources'), { name: 'NotSupportedError' }));
    wave.pauses = 0; app.isPlaying = true; app.startPlayback(); await nextTask();
    assert.strictEqual(app.isPlaying, false);
    assert.strictEqual(wave.pauses, 1, 'a failed load can leave the element "playing": pause it');
    assert.match(app.playerNotice, /Could not start playback: no supported sources/);
    // the next click plays again
    wave.play = function () { this.plays++; return Promise.resolve(); };
    wave.plays = 0; app.togglePlay(); assert.strictEqual(wave.plays, 1, 'the next click plays instead of pausing');
    await nextTask(); assert.strictEqual(app.playerNotice, '');
    // a rejection for a waveform replaced meanwhile is ignored
    let rejectLate;
    wave.play = () => new Promise((resolve, reject) => { rejectLate = reject; });
    wave.pauses = 0; app.playerNotice = ''; app.startPlayback();
    app.waveform = { pause() {} };
    rejectLate(new Error('late')); await nextTask();
    assert.strictEqual(app.playerNotice, '', 'a replaced waveform reports nothing');
    assert.strictEqual(wave.pauses, 0);

    app.waveform = wave;
    // a synchronous throw from play() also leaves the transport on Play
    wave.play = () => { throw new Error('sync boom'); };
    app.isPlaying = true; app.playerNotice = ''; app.startPlayback();
    assert.strictEqual(app.isPlaying, false, 'a sync failure clears isPlaying too');
    assert.match(app.playerNotice, /Could not start playback: sync boom/);
    // a late SUCCESS for a replaced waveform must not clear the new waveform's notice
    let resolveLate;
    wave.play = () => new Promise(resolve => { resolveLate = resolve; });
    app.startPlayback();
    const replacement = { pause() {} }; app.waveform = replacement;
    app.playerNotice = 'Audio playback error: the new waveform has a problem';
    resolveLate(); await nextTask();
    assert.strictEqual(app.playerNotice, 'Audio playback error: the new waveform has a problem');
    app.waveform = wave;

    // ---- a stale play() rejection must not cancel the fallback's resume ----
    ({ app, wave } = await started());
    let rejectOriginalPlay;
    wave.play = function () {
        this.plays++;
        return this.plays === 1 ? new Promise((resolve, reject) => { rejectOriginalPlay = reject; }) : Promise.resolve();
    };
    app.startPlayback(); wave.handlers.play();
    decodeError(wave); await nextTask();
    assert.strictEqual(wave.plays, 2, 'the fallback resumed on the preview');
    wave.pauses = 0;
    rejectOriginalPlay(Object.assign(new Error('The element has no supported sources'), { name: 'NotSupportedError' }));
    await nextTask();
    assert.strictEqual(app.playerNotice, '', 'the stale rejection says nothing about the preview');
    assert.strictEqual(wave.pauses, 0, 'and does not pause it');

    // ---- a media error of a replaced waveform says nothing about the current one ----
    ({ app, wave } = await started());
    app.waveform = { getMediaElement: () => ({}) }; app.playerNotice = ''; app.waveformLoading = true;
    mediaError(wave, 2);
    assert.strictEqual(app.playerNotice, '', 'no notice from a stale waveform');
    assert.strictEqual(app.waveformLoading, true, 'and its overlay is not cleared');

    // ---- media errors: only codes 3/4 (or a fallback in flight) reload the preview ----
    ({ app, wave } = await started());
    mediaError(wave, 2); await nextTask();
    assert.strictEqual(wave.loads.length, 1, 'network error: no reload');
    assert.match(app.playerNotice, /Audio playback error: .*network/);
    app.playerNotice = '';
    mediaError(wave, 1); await nextTask();
    assert.strictEqual(wave.loads.length, 1, 'aborted: no reload');
    assert.match(app.playerNotice, /Audio playback error: .*aborted/);
    assert.strictEqual(app.waveformLoading, false);
    wave.media.error = null; wave.handlers.error(new Error('boom in ready'));
    assert.strictEqual(wave.loads.length, 1, 'an error thrown inside a handler is not a format problem');
    assert.match(app.playerNotice, /Audio playback error: boom in ready/);
    mediaError(wave, 4); await nextTask();
    assert.strictEqual(wave.loads.length, 2, 'unsupported format falls back');
    // while the fallback is in flight the twin of its failure is absorbed whatever the code says
    ({ app, wave } = await started({ loadResults: ['ok', new Promise(() => {})] }));
    decodeError(wave); app.playerNotice = '';
    wave.handlers.error(undefined);
    assert.strictEqual(app.playerNotice, ''); assert.strictEqual(wave.loads.length, 2);
    // on the preview already: notice with the code's message, no reload
    ({ app, wave } = await started({ canPlay: '' }));
    decodeError(wave);
    assert.strictEqual(wave.loads.length, 1);
    assert.match(app.playerNotice, /Audio playback error: .*could not be decoded/);
    // fallback: the transport shows Play while the preview loads, and it resumes only when it was playing
    ({ app, wave } = await started());
    app.isPlaying = true; decodeError(wave);
    assert.strictEqual(app.isPlaying, false);
    await nextTask(); assert.strictEqual(wave.plays, 1);
    // a failed first load after the fallback took over is not a second error
    let rejectFirstLoad; const notified = [];
    ({ app, wave } = harness({ loadResults: [new Promise((resolve, reject) => { rejectFirstLoad = reject; }), 'ok'] }));
    app.notifyError = message => notified.push(message);
    let init = app.initWaveform();
    while (!wave.loads.length) await nextTask();
    decodeError(wave); rejectFirstLoad(new Error('superseded by the reload')); await init;
    assert.deepStrictEqual(notified, []);
    ({ app, wave } = harness({ loadResults: ['fail'] }));
    app.notifyError = message => notified.push(message);
    await app.initWaveform();
    assert.strictEqual(notified.length, 1, 'control: the same failure without a fallback is reported');

    // ---- audio source kept raw, same peaks array on fallback; preload ----
    ({ app, wave } = await started());
    assert.strictEqual(app._audioSource.__v_skip, true, 'Alpine must not proxy the ~240k-element peaks');
    assert.strictEqual(wave.media.preload, 'metadata', "'auto' would buffer hundreds of MB of WAV on every rebuild");
    decodeError(wave); await nextTask();
    assert.strictEqual(wave.loads[1].peaks, wave.loads[0].peaks, 'the same array object, not a copy or proxy');

    // ---- teardown resets the loading overlay; stale returns ----
    let releaseFetch;
    ({ app, wave } = harness({ fetchOverride: () => new Promise(resolve => { releaseFetch = resolve; }) }));
    init = app.initWaveform(); await nextTask();
    assert.strictEqual(app.waveformLoading, true);
    app.destroyWaveform();
    assert.strictEqual(app.waveformLoading, false, 'destroy clears the overlay');
    releaseFetch({ ok: true, json: async () => ({ peaks: [0.1], duration: 120 }) });
    await init;
    assert.strictEqual(app.waveformLoading, false); assert.strictEqual(wave.loads.length, 0);
    // replaced while the peaks request is in flight: not even an error is reported
    const reported = [];
    ({ app, wave } = harness({ fetchOverride: () => new Promise(resolve => { releaseFetch = resolve; }) }));
    app.notifyError = message => reported.push(message);
    init = app.initWaveform(); await nextTask();
    app.waveform = null;
    releaseFetch({ ok: false, json: async () => ({ detail: 'gone' }) });
    await init;
    assert.deepStrictEqual(reported, []); assert.strictEqual(wave.loads.length, 0);
    // file switched while the peaks body is parsed: nothing loaded or bound
    let releaseJson;
    ({ app, wave } = harness({ fetchOverride: async () => ({ ok: true, json: () => new Promise(resolve => { releaseJson = resolve; }) }) }));
    init = app.initWaveform(); await nextTask(); await nextTask();
    app.currentFileId = 'two';
    releaseJson({ peaks: [0.1], duration: 120 });
    await init;
    assert.strictEqual(wave.loads.length, 0);
    // (the fork's click-strip refresh also listens to 'ready', so only the binding ready handler is absent)
    app.refreshClickStrip = () => {}; wave.handlers.ready?.();
    assert.deepStrictEqual(wave.container.added, [], 'and binds no ready handler');

    // ---- ready handler: seek back, bind once, 100 ms timer drops a replaced waveform ----
    ({ app, wave } = await started());
    app.playTime = 42; wave.handlers.ready();
    assert.ok(wave.times.includes(42), 'ready seeks back to the playhead (also after a fallback reload)');
    wave.handlers.ready(); wave.handlers.ready();
    assert.deepStrictEqual(wave.container.added, ['contextmenu', 'mousedown'], 'no duplicate listeners on a later ready');
    await sleep(150);
    ({ app, wave } = await started());
    let regionBuilds = 0; app.addTrackRegions = () => { regionBuilds++; };
    wave.handlers.ready(); await sleep(150);
    assert.strictEqual(regionBuilds, 1, 'control: regions are drawn for the live waveform');
    wave.handlers.ready(); app.waveform = null; await sleep(150);
    assert.strictEqual(regionBuilds, 1, 'a replaced waveform draws nothing');

    // ---- held Space: no page scroll, no second toggle ----
    app = vinylApp(); let toggles = 0;
    app.waveform = {}; app.playDuration = 120;   // playerReady: Space needs a loaded waveform
    app.togglePlay = () => { toggles++; };
    const key = (repeat, tag = 'BODY') => ({ code: 'Space', key: ' ', repeat, defaultPrevented: false,
        target: { tagName: tag }, prevented: false, preventDefault() { this.prevented = true; } });
    const first = key(false); app.onGlobalKeydown(first);
    const held = key(true); app.onGlobalKeydown(held);
    assert.strictEqual(toggles, 1, 'a held key toggles once');
    assert.ok(first.prevented && held.prevented, 'a repeat still keeps the page from scrolling');
    const typing = key(true, 'INPUT'); app.onGlobalKeydown(typing);
    assert.ok(!typing.prevented, 'a repeat in a text field is left alone');

    finished = true;
    console.log('player_review_fixes: ok');
})().catch(error => { console.error(error); process.exit(1); });
