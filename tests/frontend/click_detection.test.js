// Plan 07 slice 2: click scan state, per-track counts, per-track override, density strip.
const fs = require('fs'), assert = require('assert'), path = require('path');
const root = path.join(__dirname, '..', '..', 'backend', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Minimal DOM: createElement('canvas') with a recording 2D context.
function mkCanvas() {
  const calls = [];
  const c = {
    style: {}, width: 0, height: 0, parentNode: null, attrs: {}, calls,
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    getContext() {
      return { clearRect: (...a) => calls.push(['clear', ...a]),
               set fillStyle(v) { calls.push(['style', v]); },
               fillRect: (...a) => calls.push(['rect', ...a]) };
    },
  };
  return c;
}
global.document = { addEventListener() {}, getElementById() { return null; }, createElement: () => mkCanvas() };
global.window = global; global.WaveSurfer = {};
const vinylApp = new Function(src + ';return vinylApp;')();

const trk = (n, s, e, extra = {}) => ({ number: n, start: s, end: e, duration: e - s, ignored: false, ...extra });
function mk() {
  const a = vinylApp();
  a.notify = () => {}; a.notifyError = () => {}; a.saveExportDefault = () => {};
  a.currentFileId = 'f1'; a.currentFile = {};
  a.detectedTracks = [trk(1, 0, 100), trk(2, 100, 200), trk(3, 200, 300)];
  return a;
}
function stubWrapper(scrollWidth = 1000) {
  const kids = [];
  return { scrollWidth, clientWidth: scrollWidth, children: kids,
    appendChild(c) { c.parentNode = this; kids.push(c); },
    removeChild(c) { kids.splice(kids.indexOf(c), 1); c.parentNode = null; } };
}
function withWave(a, wrapper = stubWrapper(), duration = 300) {
  a.waveform = { getWrapper: () => wrapper, getDuration: () => duration, destroy() {}, on() {} };
  return wrapper;
}
const done = (strength, times, requested = strength) => ({ strength, requested, status: 'done', progress: 1, times });

(async () => {
  // ---- binning helpers (pure) ----
  { const a = mk();
    assert.strictEqual(a.countClicksInRange([1, 2, 3, 100, 100.5, 250], 100, 200), 2, 'start inclusive');
    assert.strictEqual(a.countClicksInRange([100, 200], 100, 200), 1, 'end exclusive');
    assert.strictEqual(a.countClicksInRange([], 0, 10), 0);
    assert.strictEqual(a.countClicksInRange([1, 2], 5, 5), 0);
    assert.strictEqual(a.countClicksInRange(null, 0, 10), 0);
    const bins = a.clickDensityBins([0, 0.4, 5, 9.99, 10, 11, -1], 10, 10);
    assert.deepStrictEqual(bins, [2, 0, 0, 0, 0, 1, 0, 0, 0, 2], 'time == duration lands in the last bin; outside ignored');
    assert.deepStrictEqual(a.clickDensityBins([1], 0, 4), [0, 0, 0, 0]);
    assert.deepStrictEqual(a.clickDensityBins([1], 10, 0), []);
    assert.strictEqual(a.clickTickAlpha(0), 0);
    assert.ok(a.clickTickAlpha(1) > 0 && a.clickTickAlpha(1) < a.clickTickAlpha(3));
    assert.strictEqual(a.clickTickAlpha(4), 1); assert.strictEqual(a.clickTickAlpha(40), 1);
  }

  // ---- counts follow boundary edits; tooltip; before-scan dash ----
  { const a = mk();
    assert.strictEqual(a.clickCountText(a.detectedTracks[0]), '—');
    assert.ok(/Not scanned/.test(a.clickTooltip(a.detectedTracks[0])));
    a.clickScans = { f1: done('medium', [10, 20, 99, 100, 150, 250, 299.9], 'off') };
    assert.deepStrictEqual(a.detectedTracks.map(t => a.trackClicks(t)), [3, 2, 2]);
    assert.strictEqual(a.clickCountText(a.detectedTracks[1]), '2');
    // boundary edit: track 1 end 100 -> 120, track 2 start 100 -> 120 (no re-scan needed)
    a.detectedTracks[0].end = 120; a.detectedTracks[1].start = 120;
    assert.deepStrictEqual(a.detectedTracks.map(t => a.trackClicks(t)), [4, 1, 2]);
    assert.strictEqual(a.clickTooltip(a.detectedTracks[0]), '4 clicks (2.0 per minute) — detected at medium');
    a.detectedTracks[1].end = 180; assert.ok(/^1 click \(/.test(a.clickTooltip(a.detectedTracks[1])));
    assert.strictEqual(a.clickScanNote(), '7 clicks found (scanned at Medium; click removal is off)');
    a.clickScans = { f1: done('strong', [1]) }; assert.strictEqual(a.clickScanNote(), '1 click found at strong');
    a.clickScans = { f1: done('light', []) }; assert.strictEqual(a.clickCountText(a.detectedTracks[0]), '0');
  }

  // ---- scan strength, button text, progress from WebSocket ----
  { const a = mk();
    assert.strictEqual(a.clickScanStrength(), 'medium'); a.declick = 'strong';
    assert.strictEqual(a.clickScanStrength(), 'strong');
    assert.strictEqual(a.clickScanButtonText(), 'Scan for clicks');
    const calls = [];
    global.fetch = async (url, opt = {}) => {
      calls.push([url, opt.method || 'GET', opt.body]);
      if (opt.method === 'POST') return { ok: true, json: async () => ({ status: 'running', strength: 'strong', requested: 'strong', progress: 0 }) };
      return { ok: true, json: async () => ({ status: 'done', strength: 'strong', requested: 'strong', progress: 1, times: [5, 6], scanned_at: 't' }) };
    };
    await a.scanClicks();
    assert.deepStrictEqual(calls[0], ['/api/clicks/f1', 'POST', JSON.stringify({ declick: 'strong' })]);
    assert.ok(a.clickScanRunning()); assert.strictEqual(a.clickScanButtonText(), 'Scanning for clicks… 0%');
    a.onClickScanMessage({ type: 'click_scan_progress', file_id: 'f1', strength: 'strong', progress: 0.37 });
    assert.strictEqual(a.clickScanButtonText(), 'Scanning for clicks… 37%');
    a.onClickScanMessage({ type: 'click_scan_progress', file_id: 'f1', strength: 'light', progress: 0.9 });
    assert.strictEqual(a.clickScanButtonText(), 'Scanning for clicks… 37%', 'other strength ignored');
    a.onClickScanMessage({ type: 'click_scan_progress', file_id: 'other', strength: 'strong', progress: 0.9 });
    assert.strictEqual(a.clickScanButtonText(), 'Scanning for clicks… 37%', 'other file ignored');
    a.onClickScanMessage({ type: 'click_scan_complete', file_id: 'f1', strength: 'strong', count: 2 });
    await new Promise(r => setImmediate(r));
    assert.ok(!a.clickScanRunning() && a.hasClickScan());
    assert.deepStrictEqual(a.clickScanFor().times, [5, 6]);
    assert.ok(/declick=strong/.test(calls[calls.length - 1][0]));
    assert.strictEqual(a.clickScanButtonText(), 'Rescan for clicks');
    a.stopClickPoll('f1'); assert.deepStrictEqual(Object.keys(a._clickPollTimers), []);
  }

  // ---- previous result stays visible during a re-scan; panel change re-scans ----
  { const a = mk(); a.declick = 'medium';
    a.clickScans = { f1: done('medium', [10, 150]) };
    let posts = 0;
    global.fetch = async (url, opt = {}) => {
      if (opt.method === 'POST') { posts++; return { ok: true, json: async () => ({ status: 'running', strength: 'strong', requested: 'strong', progress: 0.1 }) }; }
      return { ok: true, json: async () => ({ status: 'none' }) };
    };
    a.setDeclick('strong'); await new Promise(r => setImmediate(r));
    assert.strictEqual(posts, 1, 'strength change re-scans');
    assert.ok(a.clickScanRunning()); assert.deepStrictEqual(a.clickScanFor().times, [10, 150]);
    assert.strictEqual(a.trackClicks(a.detectedTracks[0]), 1, 'counts keep showing during the re-scan');
    a.stopClickPoll('f1');
    // off after medium: same scan strength -> no new scan
    const b = mk(); b.declick = 'medium'; b.clickScans = { f1: done('medium', [1]) }; posts = 0;
    b.setDeclick('off'); await new Promise(r => setImmediate(r));
    assert.strictEqual(posts, 0);
    // no scan yet -> changing the strength does not start one
    const c = mk(); c.setDeclick('light'); await new Promise(r => setImmediate(r)); assert.strictEqual(posts, 0);
  }

  // ---- ensureClickScan (A/B) ----
  { const a = mk(); a.declick = 'light'; let posts = 0;
    global.fetch = async (u, o = {}) => { posts++; return { ok: true, json: async () => ({ status: 'running', strength: 'light', requested: 'light', progress: 0 }) }; };
    a.ensureClickScan(); await new Promise(r => setImmediate(r)); assert.strictEqual(posts, 1);
    a.ensureClickScan(); assert.strictEqual(posts, 1, 'running scan is joined, not restarted');
    a.stopClickPoll('f1');
    a.clickScans = { f1: done('light', []) }; a.ensureClickScan(); assert.strictEqual(posts, 1, 'fresh result reused');
    a.clickScans = { f1: done('strong', []) }; a.ensureClickScan(); await new Promise(r => setImmediate(r));
    assert.strictEqual(posts, 2, 'stale strength is rescanned'); a.stopClickPoll('f1');
  }

  // ---- error state ----
  { const a = mk(); const toasts = []; a.notify = (m, o) => toasts.push([m, o]);
    global.fetch = async () => ({ ok: true, json: async () => ({ status: 'error', strength: 'medium', requested: 'off', error: 'ffmpeg exploded' }) });
    await a.scanClicks();
    assert.strictEqual(a.clickScanFor().status, 'error'); assert.ok(/ffmpeg exploded/.test(a.clickScanNote()));
    assert.ok(toasts.length === 1 && toasts[0][1].type === 'error');
    assert.strictEqual(a.clickScanButtonText(), 'Scan for clicks');
  }

  // ---- per-track override ----
  { const a = mk(); a.declick = 'light';
    assert.strictEqual(a.declickDefaultLabel(), 'Default (Light)');
    a.declick = 'off'; assert.strictEqual(a.declickDefaultLabel(), 'Default (Off)');
    a.setTrackDeclick(1, 'strong'); assert.strictEqual(a.detectedTracks[1].declick, 'strong');
    assert.strictEqual(a.trackEffectiveDeclick(a.detectedTracks[1]), 'strong');
    assert.strictEqual(a.trackEffectiveDeclick(a.detectedTracks[0]), 'off');
    a.setTrackDeclick(1, 'off'); assert.strictEqual(a.trackEffectiveDeclick(a.detectedTracks[1]), 'off');
    a.declick = 'medium'; assert.strictEqual(a.trackEffectiveDeclick(a.detectedTracks[1]), 'off', 'explicit Off beats the panel');
    a.setTrackDeclick(1, ''); assert.strictEqual(a.detectedTracks[1].declick, null);
    assert.strictEqual(a.trackEffectiveDeclick(a.detectedTracks[1]), 'medium');
    a.setTrackDeclick(1, 'bogus'); assert.strictEqual(a.detectedTracks[1].declick, 'off', 'unknown value reads as off');
  }

  // ---- request fields: processFile + A/B ----
  { const a = mk(); a.declick = 'light'; a.selectedRelease = { id: 5, tracks: [{ position: 'A1' }, { position: 'A2' }, { position: 'A3' }] };
    a.customMapping = [0, 1, 2]; a.startProcessPolling = () => {};
    a.setTrackDeclick(1, 'strong'); a.setTrackDeclick(2, 'off');
    let body;
    global.fetch = async (u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ job_id: 'f1' }) }; };
    await a.processFile();
    assert.strictEqual(body.declick, 'light');
    assert.deepStrictEqual(body.track_boundaries.map(b => b.declick), [undefined, 'strong', 'off']);
    assert.ok(!('declick' in body.track_boundaries[0]), 'default track sends no override');

    // A/B: effective strength of the chosen track + per-range strengths
    const b = mk(); b.declick = 'light'; b.albumGain = true; b.rumbleFilter = false; b.abTrackIdx = 1;
    b.setTrackDeclick(1, 'strong'); b.setTrackDeclick(2, 'off');
    global.fetch = async (u, o) => { if (u === '/api/restoration-test') { body = JSON.parse(o.body); } return { ok: true, json: async () => ({ original_url: '/o', processed_url: '/p', status: 'running', strength: 'light', requested: 'light' }) }; };
    b.$refs = {};
    await b.abRender();
    assert.strictEqual(body.declick, 'strong');
    assert.deepStrictEqual(body.album_ranges, [[0, 100, 'light'], [100, 200, 'strong'], [200, 300, 'off']]);
    b.stopClickPoll('f1');
  }

  // ---- A/B signature includes the override ----
  { const a = mk(); a.declick = 'light'; a.abTrackIdx = 1;
    const s0 = a.abSignature();
    a.setTrackDeclick(1, 'strong'); const s1 = a.abSignature();
    assert.notStrictEqual(s0, s1, 'chosen track override invalidates the A/B result');
    a.setTrackDeclick(1, ''); assert.strictEqual(a.abSignature(), s0);
    a.setTrackDeclick(0, 'strong'); assert.strictEqual(a.abSignature(), s0, 'other tracks do not matter without album gain');
    a.albumGain = true; const s2 = a.abSignature();
    a.setTrackDeclick(2, 'medium'); assert.notStrictEqual(a.abSignature(), s2, 'with album gain every track matters');
    a.abResult = { sig: s0 }; a.abCheckStale(); assert.strictEqual(a.abResult, null);
    // processing check uses the chosen track's effective strength
    const c = mk(); c.declick = 'off'; c.abTrackIdx = 1; assert.ok(!c.abAnyProcessing());
    c.setTrackDeclick(1, 'light'); assert.ok(c.abAnyProcessing());
    c.setTrackDeclick(1, ''); c.declick = 'medium'; assert.ok(c.abAnyProcessing());
    c.setTrackDeclick(1, 'off'); assert.ok(!c.abAnyProcessing(), 'explicit Off on the chosen track');
  }

  // ---- density strip canvas lifecycle ----
  { const a = mk(); const w = withWave(a, stubWrapper(1000), 300);
    a.refreshClickStrip(); assert.strictEqual(w.children.length, 0, 'no scan: no canvas');
    a.clickScans = { f1: done('medium', [0, 30, 30.01, 150, 299.99]) };
    a.refreshClickStrip();
    assert.strictEqual(w.children.length, 1);
    const cv = w.children[0];
    assert.strictEqual(cv.style.pointerEvents, 'none'); assert.strictEqual(cv.style.position, 'absolute');
    assert.strictEqual(cv.style.bottom, '0'); assert.strictEqual(cv.style.height, '6px');
    assert.strictEqual(cv.width, 1000, 'spans the full scroll width'); assert.strictEqual(cv.height, 6);
    const rects = cv.calls.filter(c => c[0] === 'rect');
    assert.deepStrictEqual(rects.map(r => r[1]), [0, 100, 500, 999], 'one tick per occupied column');
    const styles = cv.calls.filter(c => c[0] === 'style').map(c => c[1]);
    assert.strictEqual(styles.length, 4);
    assert.ok(styles[1] !== styles[0], 'two clicks in one column are drawn darker than one');
    // zoom: wider wrapper -> redraw at the new width, same canvas
    w.scrollWidth = 3000; a.refreshClickStrip();
    assert.strictEqual(w.children.length, 1); assert.strictEqual(cv.width, 3000);
    // huge zoom is capped (browser canvas limit), CSS stretches
    w.scrollWidth = 400000; a.refreshClickStrip(); assert.ok(cv.width <= 16384);
    // times cleared -> strip emptied but kept
    const before = cv.calls.filter(c => c[0] === 'rect').length;
    a.clickScans = { f1: done('medium', []) }; a.refreshClickStrip();
    assert.strictEqual(cv.calls.filter(c => c[0] === 'rect').length, before, 'nothing drawn when there are no clicks');
    assert.strictEqual(cv.calls[cv.calls.length - 1][0], 'clear');
    // destroy removes it and forgets the wrapper
    a.waveform.destroy = () => {};
    a.destroyWaveform();
    assert.strictEqual(w.children.length, 0); assert.strictEqual(a._clickCanvas, null);
    // new waveform = new wrapper = new canvas
    const w2 = withWave(a, stubWrapper(500), 300);
    a.clickScans = { f1: done('medium', [10]) }; a.refreshClickStrip();
    assert.strictEqual(w2.children.length, 1);
    // switching wrapper without destroy never leaks the old canvas
    const w3 = withWave(a, stubWrapper(500), 300); a.refreshClickStrip();
    assert.strictEqual(w2.children.length, 0); assert.strictEqual(w3.children.length, 1);
  }

  // ---- legend ----
  { const a = mk(); assert.ok(!a.clickLegendVisible());
    withWave(a); a.clickScans = { f1: done('medium', [1], 'off') };
    assert.ok(a.clickLegendVisible()); assert.strictEqual(a.clickLegendText(), 'Red ticks: detected clicks (medium)');
  }

  // ---- cached scan pick-up on file select ----
  { const a = mk();
    global.fetch = async (u) => ({ ok: true, json: async () => ({ status: 'done', strength: 'medium', requested: 'off', times: [3, 4], progress: 1 }) });
    await a.loadCachedClicks('f1'); assert.deepStrictEqual(a.clickScanFor().times, [3, 4]);
    global.fetch = async () => ({ ok: true, json: async () => ({ status: 'none' }) });
    const b = mk(); await b.loadCachedClicks('f1'); assert.strictEqual(b.clickScanFor(), null);
    global.fetch = async () => { throw new Error('offline'); };
    await mk().loadCachedClicks('f1');   // must not throw
  }

  // ---- markup wiring ----
  assert.ok(/data-testid="scan-clicks"/.test(html) && /clickScanButtonText\(\)/.test(html));
  assert.ok(/clickCountText\(track\)/.test(html) && /clickTooltip\(track\)/.test(html));
  assert.ok(/setTrackDeclick\(idx, \$event\.target\.value\)/.test(html) && /declickDefaultLabel\(\)/.test(html));
  assert.ok(/clickLegendText\(\)/.test(html));
  assert.ok(/grid-template-columns:[^;]*56px 128px/.test(html), 'grid has the two new columns');
  assert.ok(/click_scan_progress/.test(src) && /click_scan_complete/.test(src));
  console.log('click_detection frontend tests passed');
})().catch(e => { console.error(e); process.exit(1); });
