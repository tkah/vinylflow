// Discogs search: 12 results per fetch, "Load more" adds the next 12, at most 3 fetches per query.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();
const cases = [];
const test = (name, run) => cases.push({ name, run });
const settle = async app => {
    for (let turn = 0; turn < 1000 && !app.detailsSettled; turn++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * Fake server. /api/search pages like the real endpoint: has_more for a full page below
 * the 3-page limit. Pages overlap by one result (Discogs ordering can shift between
 * requests), which must not produce a duplicate card. `total` = Discogs matches.
 */
function fakeServer({ total = 100, gate = null } = {}) {
    const searches = [], releases = [];
    global.fetch = async (url, options = {}) => {
        if (url === '/api/search') {
            const { query, max_results, page } = JSON.parse(options.body);
            searches.push({ query, max_results, page });
            if (gate) await gate.promise;
            const first = page === 1 ? 1 : (page - 1) * max_results;   // later pages start one early
            const ids = [];
            for (let id = first; id < first + max_results && id <= total; id++) ids.push(id);
            const results = ids.map(id => ({ id, artist: 'Artist', title: `Pressing ${id}` }));
            return { ok: true, json: async () => ({ results, has_more: page < 3 && ids.length === max_results }) };
        }
        releases.push(url);
        const id = Number(url.split('/').pop());
        return { ok: true, json: async () => ({ id, tracks: [{ position: 'A1', title: 'Song', duration: '3:00' }] }) };
    };
    return { searches, releases };
}
async function searched(options) {
    const server = fakeServer(options);
    const app = vinylApp();
    app.searchQuery = 'Artist Album';
    await app.searchDiscogs();
    await settle(app);
    return { app, server };
}

test('a search shows 12 results and loads their lengths', async () => {
    const { app, server } = await searched();
    assert.deepStrictEqual(server.searches, [{ query: 'Artist Album', max_results: 12, page: 1 }]);
    assert.strictEqual(app.searchResults.length, 12);
    assert.strictEqual(server.releases.length, 12);
    assert.strictEqual(app.searchHasMore, true);
});

test('Load more adds the next 12, fetching lengths only for the new ones, and stops after 3 fetches', async () => {
    const { app, server } = await searched();
    await app.loadMoreResults(); await settle(app);
    assert.strictEqual(server.searches[1].page, 2);
    assert.strictEqual(app.searchResults.length, 23, 'the result repeated from page 1 is not shown twice');
    assert.strictEqual(new Set(app.searchResults.map(result => result.id)).size, 23);
    assert.strictEqual(server.releases.length, 23, 'no release page fetched twice');
    assert.ok(app.searchResults.every(result => result.detailStatus === 'loaded'));
    assert.strictEqual(app.searchHasMore, true);
    await app.loadMoreResults(); await settle(app);
    assert.strictEqual(server.searches[2].page, 3);
    assert.strictEqual(app.searchHasMore, false, 'third fetch is the last');
    await app.loadMoreResults();
    assert.strictEqual(server.searches.length, 3, 'never a fourth fetch');
});

test('no Load more when Discogs has no further results', async () => {
    const { app, server } = await searched({ total: 7 });
    assert.strictEqual(app.searchResults.length, 7);
    assert.strictEqual(app.searchHasMore, false);
    await app.loadMoreResults();
    assert.strictEqual(server.searches.length, 1);
});

test('a Load more answered after a new search is dropped', async () => {
    let open;
    const gate = { promise: new Promise(resolve => { open = resolve; }) };
    const { app } = await searched();
    const server = fakeServer({ gate });
    const more = app.loadMoreResults();
    app.searchQuery = 'Another Album';
    const fresh = app.searchDiscogs();
    open(); await more; await fresh; await settle(app);
    assert.strictEqual(server.searches[0].page, 2);
    assert.strictEqual(app.searchResults.length, 12, 'only the new search\'s results');
    assert.strictEqual(app.searchMoreLoading, false);
});

test('switching recordings forgets Load more with the results', async () => {
    const { app } = await searched();
    app.uploadedFiles = [{ id: 'one', filename: 'one.wav' }, { id: 'two', filename: 'two.wav' }];
    app.currentFileId = 'one'; app.currentFile = app.uploadedFiles[0];
    app.discogsConfigured = false;   // no automatic search for the next recording
    app.saveWorkspace = app.abReset = app.fetchScan = app.loadCachedClicks = app.destroyWaveform = () => {};
    app.selectFile('two');
    assert.deepStrictEqual(app.searchResults, []);
    assert.strictEqual(app.searchHasMore, false);
});

(async () => {
    let failed = 0;
    for (const { name, run } of cases) {
        try { await run(); console.log(`ok - ${name}`); } catch (error) { failed++; console.error(`${name}:`, error); }
    }
    assert.strictEqual(failed, 0, `${failed} Discogs search paging regressions failed`);
})().catch(error => { console.error(error); process.exit(1); });
