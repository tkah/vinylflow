// The "number after /release/" help line under "Know the exact pressing?" shows for the first
// few recordings only (a 35-record session made it noise), and again whenever a lookup fails.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8');
const vinylApp = new Function(source + ';return vinylApp;')();

// Fake storage keeps text between app instances, like a page reload.
const storage = new Map();
global.window = { localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value) } };

/** Open a recording the way the search card sees it: a current file, no release yet. */
function open(app, id, release = null) {
    app.currentFileId = id;
    app.currentFile = { id, filename: id + '.wav', status: 'uploaded' };
    app.selectedRelease = release;
    app.noteReleaseIdHelpShown();
}

const app = vinylApp();
for (let n = 1; n <= 5; n++) {
    open(app, 'r' + n);
    assert.strictEqual(app.showReleaseIdHelp, true, `recording ${n} shows the help`);
}
open(app, 'r3');
assert.strictEqual(app.showReleaseIdHelp, true, 'reopening a counted recording still shows it');
open(app, 'r6');
assert.strictEqual(app.showReleaseIdHelp, false, 'the sixth recording does not');

// Reopening the same recordings never used up the allowance.
storage.clear();
const repeat = vinylApp();
for (let n = 0; n < 8; n++) open(repeat, n % 2 ? 'a' : 'b');
open(repeat, 'c');
assert.strictEqual(repeat.showReleaseIdHelp, true, 'switching between two recordings counts them once each');

// A recording opened with its release already chosen never shows the card, so it does not count.
storage.clear();
const resumed = vinylApp();
for (let n = 1; n <= 5; n++) open(resumed, 'done' + n, { id: n, tracks: [] });
open(resumed, 'fresh');
assert.strictEqual(resumed.showReleaseIdHelp, true, 'recordings with a release do not use up the help');

// The count survives a reload.
storage.clear();
const before = vinylApp();
for (let n = 1; n <= 5; n++) open(before, 'r' + n);
const after = vinylApp();
open(after, 'r9');
assert.strictEqual(after.showReleaseIdHelp, false, 'a reload keeps the count');
open(after, 'r2');
assert.strictEqual(after.showReleaseIdHelp, true, 'and remembers which recordings were counted');

// A failed lookup brings the help back: a catalog number typed by mistake is the likely cause.
open(after, 'r9');
after.releaseIdNotice = 'Release 12345 was not found on Discogs.';
assert.strictEqual(after.showReleaseIdHelp, true, 'a lookup problem shows the help again');

// Unavailable or corrupt storage falls back to showing the help, never an error.
storage.set('vinylflow.releaseIdHelp.v1', '{broken');
const corrupt = vinylApp();
open(corrupt, 'x');
assert.strictEqual(corrupt.showReleaseIdHelp, true);
const realStorage = window.localStorage;
window.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
try {
    const denied = vinylApp();
    open(denied, 'y');
    assert.strictEqual(denied.showReleaseIdHelp, true);
} finally { window.localStorage = realStorage; }

// Stored values that are not a list of ids are ignored rather than breaking startup.
for (const stored of ['null', '{"a":1}', '"5"']) {
    storage.set('vinylflow.releaseIdHelp.v1', stored);
    const odd = vinylApp();
    assert.deepStrictEqual(odd.releaseIdHelpSeen, [], stored);
    open(odd, 'z');
    assert.strictEqual(odd.showReleaseIdHelp, true, stored);
}
storage.set('vinylflow.releaseIdHelp.v1', JSON.stringify([1, 'a', null, 'b', {}, 'c', 'd', 'e', 'f']));
assert.deepStrictEqual(vinylApp().releaseIdHelpSeen, ['a', 'b', 'c', 'd', 'e'], 'only string ids, at most the limit');

// Without an open recording (startup, after "Process next file") nothing is counted.
storage.clear();
const idle = vinylApp();
idle.currentFileId = 'ghost'; idle.currentFile = null; idle.selectedRelease = null;
idle.noteReleaseIdHelpShown();
assert.deepStrictEqual(idle.releaseIdHelpSeen, []);

// The markup wires the counting and the display; the hidden line stays the input's description.
const html = fs.readFileSync(path.join(__dirname, '../../backend/static/index.html'), 'utf8');
assert.match(html, /<div id="discogs-search"[^>]*x-effect="noteReleaseIdHelpShown\(\)"/, 'the search card counts the recording');
assert.match(html, /<p id="discogs-release-id-help"[^>]*x-show="showReleaseIdHelp"/, 'the help line follows showReleaseIdHelp');
assert.match(html, /id="discogs-release-id"[^>]*aria-describedby="[^"]*\bdiscogs-release-id-help\b/, 'the input still names the help');

console.log('release id help ok');
