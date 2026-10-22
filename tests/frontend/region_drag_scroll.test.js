// A whole-region drag only scrolls the view to follow regions narrower than the view
// (WaveSurfer's own rule flipped between a wide region's start and end on every move).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();
const app = vinylApp();
const followed = [];
const regions = { adjustScroll(region) { followed.push(region.id); } };
const view = { clientWidth: 1000 };
const waveform = { getWrapper: () => ({ parentElement: view }) };
const region = (id, width) => ({ id, element: { getBoundingClientRect: () => ({ width }) } });
app.tameRegionDragScroll(waveform, regions);
regions.adjustScroll(region('narrow', 400));
regions.adjustScroll(region('exact', 1000));
regions.adjustScroll(region('wide', 4898));
assert.deepStrictEqual(followed, ['narrow', 'exact'], 'a region wider than the view leaves the scroll alone');
app.tameRegionDragScroll(waveform, {});   // a plugin without adjustScroll is left untouched
console.log('region drag scroll ok');
