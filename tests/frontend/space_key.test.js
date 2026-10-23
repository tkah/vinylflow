// Space on a focused button: keydown toggles once, matching keyup is swallowed.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
global.document = { addEventListener() {}, getElementById() { return null; } };
global.window = global; global.WaveSurfer = {};
const app = new Function(src + '; return vinylApp;')()();
let toggles = 0;
app.waveform = {}; app.togglePlay = () => { toggles++; };
const ev = (type, tag) => ({ type, code: 'Space', key: ' ', repeat: false, defaultPrevented: false,
  target: { tagName: tag }, prevented: false, preventDefault() { this.prevented = true; } });
const down = ev('keydown', 'BUTTON'); app.onGlobalKeydown(down);
const up = ev('keyup', 'BUTTON'); app.onGlobalKeyup(up);
if (toggles !== 1 || !down.prevented || !up.prevented) throw new Error('button space ' + toggles);
const up2 = ev('keyup', 'BUTTON'); app.onGlobalKeyup(up2);   // unrelated keyup not swallowed
if (up2.prevented) throw new Error('stray keyup swallowed');
const inDown = ev('keydown', 'INPUT'); app.onGlobalKeydown(inDown); app.onGlobalKeyup(ev('keyup', 'INPUT'));
if (toggles !== 1 || inDown.prevented) throw new Error('input space');

// Space while the A/B test plays pauses the test; it must not start the waveform
// instead (which resumed from its playhead, often in the lead-in's surface noise).
const player = paused => ({ paused, pause() { this.paused = true; } });
const ab = { abOriginal: player(true), abProcessed: player(false), abRemoved: player(true) };
const waveformStarts = [];
const abApp = new Function(src + '; return vinylApp;')()();
abApp.$refs = ab;
abApp.waveform = { isPlaying: () => false, pause() {}, getCurrentTime: () => 12, play() { waveformStarts.push(1); } };
abApp.onGlobalKeydown(ev('keydown', 'BUTTON'));
if (!ab.abProcessed.paused) throw new Error('space did not pause the A/B test');
if (waveformStarts.length) throw new Error('space started the waveform instead of pausing the A/B test');
abApp.onGlobalKeyup(ev('keyup', 'BUTTON'));
abApp.onGlobalKeydown(ev('keydown', 'BUTTON'));   // nothing playing now: Space plays the waveform as before
if (waveformStarts.length !== 1) throw new Error('space no longer plays the waveform');
console.log('space ok');
