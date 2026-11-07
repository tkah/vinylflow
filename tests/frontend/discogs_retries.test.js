// Going back to Discogs and retrying detection: nothing is fetched twice, and no reply is lost.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();

const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (body) => ({ ok: true, status: 200, json: async () => body });

(async () => {
    // ---- "Try Discogs again" with results on screen goes back to them: no new Discogs request ----
    {
        const app = vinylApp();
        app.$nextTick = () => {};
        let searches = 0;
        app.searchDiscogs = () => { searches += 1; };
        app.searchQuery = 'Artist Album';
        app.searchResults = [{ id: 1 }];
        app.tryDiscogsAgain();
        assert.strictEqual(searches, 0, 'results kept, nothing fetched');

        // ...and with nothing to show (the search failed, or found nothing) it searches again
        app.searchResults = [];
        app.tryDiscogsAgain();
        assert.strictEqual(searches, 1);
    }

    // ---- a load left over from the previous search is not handed to this one: its reply is
    // dropped, so the same release's card would stay on "checking lengths…" ----
    {
        const app = vinylApp();
        const pending = [];
        global.fetch = (url) => new Promise(resolve => pending.push({ url, resolve }));
        const release = (duration) => reply({ id: 5, tracks: [{ position: 'A1', title: 'Song', duration }] });

        app.searchSeq = 1;
        app.searchResults = [{ id: 5, tracks: null, detailStatus: 'pending' }];
        const stale = app.loadReleaseDetails(5);
        app.searchSeq = 2;
        app.searchResults = [{ id: 5, tracks: null, detailStatus: 'pending' }];
        const current = app.loadReleaseDetails(5);
        assert.strictEqual(pending.length, 2, 'this search made its own request');

        pending[0].resolve(release('1:00'));
        assert.strictEqual(await stale, false, 'the old reply is dropped');
        pending[1].resolve(release('9:00'));
        assert.strictEqual(await current, true);
        assert.strictEqual(app.searchResults[0].tracks[0].duration, '9:00');

        // within one search a second caller still shares the running request
        app.searchResults = [{ id: 6, tracks: null, detailStatus: 'pending' }];
        const first = app.loadReleaseDetails(6);
        assert.strictEqual(app.loadReleaseDetails(6), first);
        pending[2].resolve(reply({ id: 6, tracks: [] }));
        await first;
    }

    // ---- a detection that finds nothing leaves no waveform behind: initWaveform returns at once
    // when one exists, so the retry would show its tracks without draggable regions ----
    {
        const app = vinylApp();
        let waveformInits = 0;
        app.initWaveform = async () => { waveformInits += 1; };
        app.uploadedFiles = [{ id: 'f1', filename: 'a.wav', status: 'uploaded' }];
        app.currentFileId = 'f1'; app.currentFile = app.uploadedFiles[0];
        global.fetch = async () => reply({ tracks: [] });
        await app.analyzeFile();
        assert.strictEqual(waveformInits, 0, 'no tracks: no waveform');

        global.fetch = async () => reply({ tracks: [{ number: 1, start: 0, end: 60, duration: 60 }] });
        await app.analyzeFile();   // the "detect tracks by silence only" button, still on screen
        assert.strictEqual(waveformInits, 1, 'the retry builds it, with its regions');
    }

    console.log('discogs_retries ok');
})().catch(error => { console.error(error); process.exit(1); });
