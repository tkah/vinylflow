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
console.log('space ok');
