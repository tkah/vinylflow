// Plan 14: movements from another release ("title source"): title matching, slot grouping and
// positions, measured side split, apply/Undo, export payload, workspace round-trip.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'app.js'), 'utf8');
const { vinylApp, WORKSPACE_ADDITIONS } = new Function(src + ';return { vinylApp, WORKSPACE_ADDITIONS };')();
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

// The frontend sees the serialized shape of GET /api/release/{id} (_serialize_release), built here from
// the raw Discogs fixtures: an index track becomes one entry whose position is its first part's
// position (a bare "A" -> "A1"), with `parts`.
function serialize(raw, id) {
    const tracks = raw.tracklist.map((t, i) => {
        const parts = (t.sub_tracks || []).map(p => ({ position: p.position, title: p.title, duration: p.duration || '' }));
        const first = parts[0].position;
        const position = /^[A-Z]+$/.test(first) ? first + '1' : /^[A-Z]+\d+/.test(first) ? first.match(/^[A-Z]+\d+/)[0] : 'A1';
        return { position, title: t.title, duration: t.duration || '', parts };
    });
    return { id, artist: raw.artists?.[0]?.name || 'Boston Pops Orchestra', title: raw.title, year: raw.year, label: 'RCA', tracks };
}
const primaryRelease = () => serialize(fixture('discogs_release_16440030.json'), 16440030);
const donorRelease = () => serialize(fixture('discogs_release_9326206.json'), 9326206);
const GAITE = 'Gaîté Parisienne';

function mk(release = primaryRelease(), sides = ['A', 'B']) {
    const a = vinylApp();
    a.$nextTick = async () => {};
    a.currentFileId = 'f1';
    a.uploadedFiles = [{ id: 'f1', filename: 'one.wav' }];
    a.currentFile = a.uploadedFiles[0];
    a.selectedRelease = release;
    a.selectedSides = sides;
    a.detectedTracks = [1, 2, 3].map(n => ({ number: n, start: n * 10, end: n * 10 + 9, ignored: false }));
    a.refreshRegionLabels = () => {};
    a.redetects = 0;
    a.redetectForTargets = () => { a.redetects++; return Promise.resolve(true); };
    return a;
}
const click = a => a.runToastAction(a.toasts[a.toasts.length - 1].id);
const positions = a => a.selectedRelease.tracks.map(t => t.position);
const seconds = a => a.selectedRelease.tracks.map(t => a.parseTrackDuration(t.duration));

// fetch fake: records URLs; routes by path
function fakeFetch(routes) {
    const calls = [];
    global.fetch = async (url) => {
        calls.push(String(url));
        const key = Object.keys(routes).find(k => String(url).startsWith(k));
        const reply = key ? routes[key] : { status: 404, body: {} };
        const { status = 200, body = {} } = typeof reply === 'function' ? reply(url) : reply;
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return calls;
}
const SCAN = { ready: true, music_start: 10, music_end: 2400, side_changes: [[1300, 1310]] };

(async () => {
    // ---- title normalization and preselection ----
    const a0 = mk();
    assert.strictEqual(a0.normalizeWorkTitle('Gaîté Parisienne (As Presented By The Ballet Russe De Monte Carlo)'), 'gaite parisienne');
    assert.strictEqual(a0.normalizeWorkTitle('Gaîté Parisienne'), 'gaite parisienne');
    assert.strictEqual(a0.normalizeWorkTitle("Symphony No. 9, Op. 95 'From The New World'"), 'symphony no 9 op 95 from the new world');
    assert.ok(a0.workTitlesMatch('Gaîté Parisienne (As Presented By The Ballet Russe De Monte Carlo)', 'Gaite Parisienne'));
    assert.ok(a0.workTitlesMatch('Symphony No. 5', 'Symphony No. 5 In C Minor'), 'one starts with the other');
    assert.ok(!a0.workTitlesMatch('Gayne Ballet Suite', GAITE));
    assert.ok(!a0.workTitlesMatch('', GAITE), 'an empty title never matches');

    // ---- replaceable works: folded umbrellas, unfolded umbrellas and plain tracks ----
    let a = mk();
    let works = a.replaceableWorks();
    assert.deepStrictEqual(works.map(w => [w.position, w.slots]), [['A1', ['A', 'B1']], ['B2', ['B2a', 'B2b', 'B2c', 'B2d']]]);
    a.setIndexUnfolded(a.indexTracks[0], true);
    works = a.replaceableWorks();
    assert.deepStrictEqual(works.map(w => [w.position, w.slots, w.folded]), [['A1', ['A', 'B1'], false], ['B2', ['B2a', 'B2b', 'B2c', 'B2d'], true]]);
    assert.strictEqual(works[0].count, 2);
    a = mk({ id: 5, artist: 'X', title: 'Y', tracks: [{ position: 'A1', title: 'One', duration: '' }, { position: 'A3', title: 'Over', duration: '' }] });
    assert.deepStrictEqual(a.replaceableWorks().map(w => [w.position, w.slots]), [['A1', ['A1']], ['A3', ['A3']]]);

    // ---- slot grouping and new positions ----
    assert.deepStrictEqual(a0.slotGroups(['A', 'B1']).map(g => [g.side, g.slots]), [['A', ['A']], ['B', ['B1']]]);
    assert.deepStrictEqual(a0.slotGroups(['A1', 'A2', 'B1']).map(g => g.side), ['A', 'B']);
    const k12 = a0.borrowedPositions(['A', 'B1'], [12, 11]);
    assert.deepStrictEqual(k12.slice(0, 3), ['A1', 'A2', 'A3']);
    assert.strictEqual(k12[11], 'A12');
    assert.deepStrictEqual(k12.slice(12, 14), ['B1.1', 'B1.2']);
    assert.strictEqual(k12.length, 23); assert.strictEqual(k12[22], 'B1.11');
    assert.deepStrictEqual(a0.borrowedPositions(['A3'], [3]), ['A3.1', 'A3.2', 'A3.3']);
    assert.deepStrictEqual(a0.borrowedPositions(['A3'], [1]), ['A3']);
    assert.deepStrictEqual(a0.borrowedPositions(['A'], [1]), ['A1'], 'a bare side letter with one movement becomes A1');
    assert.deepStrictEqual(a0.borrowedPositions(['A', 'B1'], [1, 1]), ['A1', 'B1']);
    // the sort order puts B1.n before B2a, so Gayne stays after them
    assert.ok(a0.comparePositionKeys(a0.positionKey('B1.11'), a0.positionKey('B2a')) < 0);

    // ---- defaultMovementSplit ----
    assert.deepStrictEqual(a0.defaultMovementSplit([10, 10, 10, 10], [20], 2), [2, 2]);
    assert.deepStrictEqual(a0.defaultMovementSplit([10, 10, 10, 10], [29], 2), [3, 1], 'nearest cumulative length');
    assert.deepStrictEqual(a0.defaultMovementSplit([10, 10, 10, 10], [0], 2), [1, 3], 'each group keeps at least one');
    assert.deepStrictEqual(a0.defaultMovementSplit([10, 10, 10, 10], [999], 2), [3, 1]);
    assert.deepStrictEqual(a0.defaultMovementSplit([10, 10, 10, 10, 10, 10], [20, 40], 3), [2, 2, 2]);
    assert.deepStrictEqual(a0.defaultMovementSplit([1, 1, 1, 1, 1], null, 2), [3, 2], 'proportional by count without targets');
    assert.deepStrictEqual(a0.defaultMovementSplit([null, null, null, null], null, 2), [2, 2]);
    assert.deepStrictEqual(a0.defaultMovementSplit([1, 2, 3], null, 1), [3]);
    assert.strictEqual(a0.defaultMovementSplit([1], null, 2), null, 'fewer movements than groups');

    // ---- measurement from /api/scan?side_changes ----
    a = mk();
    let calls = fakeFetch({ '/api/scan/f1': { body: SCAN } });
    let work = a.replaceableWorks()[0];
    assert.deepStrictEqual(await a.measureMovementTargets(work), [1290]);
    assert.deepStrictEqual(calls, ['/api/scan/f1?side_changes=1']);
    // other tracks on side A are subtracted (and need lengths)
    a = mk({ id: 5, artist: 'X', title: 'Y', tracks: [{ position: 'A1', title: 'Intro', duration: '1:00' },
        { position: 'A2', title: 'Work', duration: '', parts: [{ position: 'A2a', title: 'x', duration: '' }, { position: 'B1', title: 'y', duration: '' }] }] });
    fakeFetch({ '/api/scan/f1': { body: SCAN } });
    assert.deepStrictEqual(await a.measureMovementTargets(a.replaceableWorks()[1]), [1230]);
    // three sides: the second boundary accumulates the middle side too
    a = mk({ id: 5, artist: 'X', title: 'Y', tracks: [{ position: 'A1', title: 'Work', duration: '',
        parts: [{ position: 'A1', title: 'x', duration: '' }, { position: 'B1', title: 'y', duration: '' }, { position: 'C1', title: 'z', duration: '' }] }] }, ['A', 'B', 'C']);
    calls = fakeFetch({ '/api/scan/f1': { body: { ready: true, music_start: 0, music_end: 3000, side_changes: [[1000, 1010], [2000, 2010]] } } });
    assert.deepStrictEqual(await a.measureMovementTargets(a.replaceableWorks()[0]), [1000, 1990]);
    assert.deepStrictEqual(calls, ['/api/scan/f1?side_changes=2']);
    // not measurable
    const notMeasurable = async (mutate, scan = SCAN) => {
        const m = mk();
        fakeFetch({ '/api/scan/f1': { body: scan } });
        mutate(m);
        return m.measureMovementTargets(m.replaceableWorks()[0]);
    };
    assert.strictEqual(await notMeasurable(() => {}, { ...SCAN, side_changes: [] }), null, 'fewer side changes than needed');
    assert.strictEqual(await notMeasurable(() => {}, { ...SCAN, side_changes: [[1, 2], [3, 4]] }), null, 'more side changes than needed');
    assert.strictEqual(await notMeasurable(() => {}, { ...SCAN, ready: false }), null);
    assert.strictEqual(await notMeasurable(m => { m.selectedSides = ['B']; }), null, 'a needed side is not selected');
    assert.strictEqual(await notMeasurable(m => { m.selectedSides = ['A']; }), null, 'one selected side has no side change to measure');
    assert.strictEqual(await notMeasurable(m => { m.selectedRelease.tracks.unshift({ position: 'A0', title: 'Pre', duration: '' }); }), null, 'unknown length of another track on the side');
    a = mk(); global.fetch = async () => { throw new Error('offline'); };
    assert.strictEqual(await a.measureMovementTargets(a.replaceableWorks()[0]), null);

    // ---- panel: own release, master link, errors, success + preselection ----
    a = mk();
    calls = fakeFetch({ '/api/release/9326206': { body: donorRelease() }, '/api/scan/f1': { body: SCAN } });
    a.openMovementsPanel();
    assert.strictEqual(a.movementsPanel.open, true);
    a.movementsPanel.input = '16440030';
    await a.loadMovementsDonor();
    assert.ok(/already/i.test(a.movementsPanel.error), a.movementsPanel.error);
    assert.deepStrictEqual(calls, [], 'own release id is refused without a fetch');
    a.movementsPanel.input = 'https://www.discogs.com/master/123-foo';
    await a.loadMovementsDonor();
    assert.ok(/master/i.test(a.movementsPanel.error));
    a.movementsPanel.input = 'nonsense';
    await a.loadMovementsDonor();
    assert.ok(a.movementsPanel.error);
    a.movementsPanel.input = '123';
    await a.loadMovementsDonor();
    assert.ok(/not found/i.test(a.movementsPanel.error), '404 message');
    a.movementsPanel.input = 'https://www.discogs.com/release/9326206-Gaite';
    await a.loadMovementsDonor();
    assert.strictEqual(a.movementsPanel.error, '');
    assert.strictEqual(a.movementsPanel.donor.id, 9326206);
    assert.strictEqual(a.movementsPanel.replacePosition, 'A1', 'matched by normalized title, not the first work by accident');
    assert.strictEqual(a.movementsPanel.donorPosition, 'A1');
    assert.ok(calls.includes('/api/scan/f1?side_changes=1'));
    assert.deepStrictEqual(a.donorMovementOptions.map(o => o.value), ['A1', a.ALL_DONOR_TRACKS]);
    assert.strictEqual(a.donorMovementOptions[0].label, `${GAITE} · 23 movements`);
    assert.strictEqual(a.donorMovementOptions[1].label, 'All tracks (1)');
    assert.strictEqual(a.replaceOptions[0].label, 'A1 · Gaîté Parisienne (As Presented By The Ballet Russe De Monte Carlo)');
    // measured default: 1290 s on side A -> the donor movement count whose cumulative length is nearest
    const donorSecs = a.movementsPanel.donor.tracks[0].parts.map(p => a.parseTrackDuration(p.duration));
    let cum = 0, best = 0, bestDiff = Infinity;
    donorSecs.forEach((s, i) => { cum += s; if (i < donorSecs.length - 1 && Math.abs(cum - 1290) < bestDiff) { bestDiff = Math.abs(cum - 1290); best = i + 1; } });
    assert.deepStrictEqual(a.movementsPanel.starts, [best]);
    assert.strictEqual(a.movementsPanel.splitNote, '');
    assert.ok(best > 1 && best < 22);
    assert.deepStrictEqual(a.splitOptions(0).slice(0, 2).map(o => o.value), [1, 2]);
    assert.ok(/^13 · Valse \(starts \d+:\d\d\)$/.test(a.splitOptions(0)[11].label), a.splitOptions(0)[11].label);

    // not measurable -> proportional + muted note
    a = mk();
    fakeFetch({ '/api/release/9326206': { body: donorRelease() }, '/api/scan/f1': { body: { ...SCAN, side_changes: [] } } });
    a.openMovementsPanel(); a.movementsPanel.input = '9326206';
    await a.loadMovementsDonor();
    assert.deepStrictEqual(a.movementsPanel.starts, [12], 'proportional: 23 movements over 2 sides');
    assert.strictEqual(a.movementsPanel.splitNote, "Couldn't measure where side B starts — check the split.");

    // ---- preview ----
    let plan = a.movementsPlan;
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.rows.length, 23);
    assert.strictEqual(plan.preview[0], `A1 · ${GAITE}: Allegro`);
    assert.strictEqual(plan.preview[plan.preview.length - 1], `B1.11 · ${GAITE}: Barcarolle`);
    assert.ok(plan.preview.length < 23, 'only the first few and the last rows');

    // ---- apply ----
    const original = a.selectedRelease;
    const originalJson = JSON.stringify(original);
    const gayneBefore = JSON.stringify(original.tracks[1]);
    a.movementsPanel.starts = [12];
    a.applyMovements();
    assert.strictEqual(JSON.stringify(original), originalJson, 'the shared release object is untouched');
    assert.notStrictEqual(a.selectedRelease, original);
    const expected = [...Array.from({ length: 12 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 11 }, (_, i) => `B1.${i + 1}`), 'B2'];
    assert.deepStrictEqual(positions(a), expected);
    assert.strictEqual(JSON.stringify(a.selectedRelease.tracks[23]), gayneBefore, 'Gayne is untouched');
    const first = a.selectedRelease.tracks[0];
    assert.deepStrictEqual([first.title, first.duration, first.umbrella.title, first.umbrella.position, first.umbrella.parts.length],
        ['Allegro', '2:05', GAITE, 'A1', 23]);
    assert.strictEqual(a.partDisplayTitle(first), `${GAITE}: Allegro`);
    assert.strictEqual(a.selectedRelease.tracks[12].umbrella.title, GAITE);
    assert.strictEqual(a.selectedRelease.tracks[0].umbrella.duration, '36:09');
    assert.deepStrictEqual(a.indexTracks.map(e => [e.title, e.unfolded, e.count]), [[GAITE, true, 23], ['Gayne Ballet Suite', false, 4]]);
    assert.deepStrictEqual(a.selectedSides, ['A', 'B']);
    assert.strictEqual(a.redetects, 1, 're-detection runs for the new target count');
    assert.deepStrictEqual(a.customMapping, [0, 1, 2]);
    assert.strictEqual(a.movementsPanel.open, false);
    assert.deepStrictEqual(a.titleSource, {
        release_id: 9326206, label: `${donorRelease().artist} – ${GAITE}`, work: GAITE,
        replace_position: 'A1', donor_position: 'A1',
        assignments: expected.slice(0, 23).map((position, i) => ({ position, source: `1.${i + 1}` }))
    });
    assert.ok(/Movements of “Gaîté Parisienne” from 9326206/.test(a.toasts[a.toasts.length - 1].message));
    assert.strictEqual(a.toasts[a.toasts.length - 1].action.label, 'Undo');
    assert.strictEqual(a.movementsLine, `Movements of ${GAITE} from ${a.titleSource.label}`);

    // fold after apply: the umbrella is re-created at the replaced position
    a.setIndexUnfolded(a.indexTracks[0], false);
    assert.deepStrictEqual(positions(a), ['A1', 'B2']);
    assert.strictEqual(a.selectedRelease.tracks[0].parts.length, 23);
    assert.strictEqual(a.selectedRelease.tracks[0].title, GAITE);
    a.setIndexUnfolded(a.indexTracks[0], true);
    assert.deepStrictEqual(positions(a), expected);

    // renames of borrowed tracks keep flowing through custom_tracks
    a.detectedTracks = Array.from({ length: 24 }, (_, i) => ({ number: i + 1, start: i * 10, end: i * 10 + 9, ignored: false }));
    a.resetMappingToTargets();
    const renamedIdx = 3;
    a.renameTrack(renamedIdx, 'Polka (renamed)');
    const request = a.buildExportRequest('f1', a.currentWorkspaceState());
    assert.deepStrictEqual(request.custom_tracks, [{ position: 'A4', title: 'Polka (renamed)' }]);
    assert.deepStrictEqual(request.title_source, {
        release_id: 9326206, replace_position: 'A1', donor_position: 'A1',
        assignments: a.titleSource.assignments
    });
    assert.ok(!('label' in request.title_source) && !('work' in request.title_source));

    // ---- Undo restores release, mapping, sides and titleSource ----
    a = mk();
    fakeFetch({ '/api/release/9326206': { body: donorRelease() }, '/api/scan/f1': { body: SCAN } });
    a.openMovementsPanel(); a.movementsPanel.input = '9326206';
    await a.loadMovementsDonor();
    const beforeJson = JSON.stringify(a.selectedRelease);
    a.applyMovements();
    assert.notStrictEqual(JSON.stringify(a.selectedRelease), beforeJson);
    click(a);
    assert.strictEqual(JSON.stringify(a.selectedRelease), beforeJson);
    assert.strictEqual(a.titleSource, null);
    assert.deepStrictEqual(a.selectedSides, ['A', 'B']);
    assert.strictEqual(a.targetTracks.length, 2);
    assert.strictEqual(a.redetects, 2);
    // request omits title_source when none
    assert.ok(!('title_source' in a.buildExportRequest('f1', a.currentWorkspaceState())));

    // ---- hand edits: ask first instead of re-detecting ----
    a = mk();
    fakeFetch({ '/api/release/9326206': { body: donorRelease() }, '/api/scan/f1': { body: SCAN } });
    a.openMovementsPanel(); a.movementsPanel.input = '9326206';
    await a.loadMovementsDonor();
    a.boundariesEdited = true;
    a.applyMovements();
    assert.strictEqual(a.editBanner, true);
    assert.strictEqual(a.redetects, 0);

    // ---- export signature, workspace round trip, selectRelease ----
    const signatureWith = a.exportSignature();
    const savedTitleSource = a.titleSource;
    a.titleSource = null;
    assert.notStrictEqual(a.exportSignature(), signatureWith, 'the signature includes the title source');
    a.titleSource = savedTitleSource;
    const saved = JSON.parse(JSON.stringify(a.captureWorkspace()));
    assert.deepStrictEqual(saved.titleSource, savedTitleSource);
    assert.strictEqual(a.validWorkspace(saved), true);
    assert.strictEqual(WORKSPACE_ADDITIONS.titleSource, null, 'saves from before this feature default to none');
    const old = { ...saved }; delete old.titleSource;
    assert.strictEqual(a.validWorkspace({ ...WORKSPACE_ADDITIONS, ...old }), true);
    const b = mk();
    b.workspaces = { f1: saved };
    b.restoreWorkspace('f1');
    assert.deepStrictEqual(b.titleSource, savedTitleSource);
    a.selectRelease(primaryRelease());
    assert.strictEqual(a.titleSource, null, 'choosing a release clears the title source');
    assert.strictEqual(a.movementsPanel.open, false);

    // ---- plain-track replacement with the donor's plain tracks (donor_position null) ----
    const plainRelease = () => ({ id: 77, artist: 'P', title: 'Plain', tracks: [
        { position: 'A1', title: 'Opener', duration: '3:00' }, { position: 'A2', title: 'Suite Title', duration: '' }, { position: 'B1', title: 'Closer', duration: '4:00' }] });
    const plainDonor = { id: 88, artist: 'D', title: 'Donor', tracks: [
        { position: '1', title: 'One', duration: '1:00' }, { position: '2', title: 'Two', duration: '2:00' }, { position: '3', title: 'Three', duration: '' }] };
    a = mk(plainRelease(), ['A', 'B']);
    fakeFetch({ '/api/release/88': { body: plainDonor } });
    a.openMovementsPanel(); a.movementsPanel.input = '88';
    await a.loadMovementsDonor();
    assert.strictEqual(a.movementsPanel.replacePosition, 'A1', 'no title match: first work');
    assert.strictEqual(a.movementsPanel.donorPosition, a.ALL_DONOR_TRACKS, 'no umbrella in the donor');
    a.movementsPanel.replacePosition = 'A2';
    await a.refreshMovementsSplit();
    assert.deepStrictEqual(a.movementsPanel.starts, [], 'a single-side slot has no split editor');
    a.applyMovements();
    assert.deepStrictEqual(positions(a), ['A1', 'A2.1', 'A2.2', 'A2.3', 'B1']);
    assert.deepStrictEqual(a.selectedRelease.tracks[2], { position: 'A2.2', title: 'Two', duration: '2:00' });
    assert.ok(!a.selectedRelease.tracks[1].umbrella);
    assert.strictEqual(a.titleSource.donor_position, null);
    assert.deepStrictEqual(a.titleSource.assignments, [{ position: 'A2.1', source: '1' }, { position: 'A2.2', source: '2' }, { position: 'A2.3', source: '3' }]);
    assert.strictEqual(a.buildExportRequest('f1', a.currentWorkspaceState()).title_source.donor_position, null);
    // one movement keeps the slot's own position
    a = mk(plainRelease(), ['A', 'B']);
    fakeFetch({ '/api/release/88': { body: { ...plainDonor, tracks: [plainDonor.tracks[0]] } } });
    a.openMovementsPanel(); a.movementsPanel.input = '88';
    await a.loadMovementsDonor();
    a.movementsPanel.replacePosition = 'A2';
    await a.refreshMovementsSplit();
    a.applyMovements();
    assert.deepStrictEqual(positions(a), ['A1', 'A2', 'B1']);
    assert.strictEqual(a.selectedRelease.tracks[1].title, 'One');

    // ---- collision refusal ----
    a = mk({ id: 77, artist: 'P', title: 'Plain', tracks: [
        { position: 'A1', title: 'Opener', duration: '' }, { position: 'A2', title: 'Suite', duration: '' }, { position: 'A2.2', title: 'Odd', duration: '' }] }, ['A']);
    fakeFetch({ '/api/release/88': { body: plainDonor } });
    a.openMovementsPanel(); a.movementsPanel.input = '88';
    await a.loadMovementsDonor();
    a.movementsPanel.replacePosition = 'A2';
    await a.refreshMovementsSplit();
    plan = a.movementsPlan;
    assert.strictEqual(plan.ok, false);
    assert.ok(plan.error.includes('A2.2'), plan.error);
    const unchanged = JSON.stringify(a.selectedRelease);
    a.applyMovements();
    assert.strictEqual(JSON.stringify(a.selectedRelease), unchanged);
    assert.strictEqual(a.titleSource, null);
    // bare A with two movements would take the existing top-level A2
    a = mk({ id: 78, artist: 'P', title: 'T', tracks: [{ position: 'A1', title: 'W', duration: '', parts: [{ position: 'A', title: 'p', duration: '' }] }, { position: 'A2', title: 'Other', duration: '' }] }, ['A']);
    fakeFetch({ '/api/release/88': { body: plainDonor } });
    a.openMovementsPanel(); a.movementsPanel.input = '88';
    await a.loadMovementsDonor();
    a.movementsPanel.replacePosition = 'A1';
    await a.refreshMovementsSplit();
    assert.ok(a.movementsPlan.error.includes('A2'));

    // ---- split editor limits: every side keeps a movement ----
    a = mk();
    fakeFetch({ '/api/release/9326206': { body: donorRelease() }, '/api/scan/f1': { body: SCAN } });
    a.openMovementsPanel(); a.movementsPanel.input = '9326206';
    await a.loadMovementsDonor();
    a.movementsPanel.starts = [0];
    assert.strictEqual(a.movementsPlan.ok, false);
    a.movementsPanel.starts = [23];
    assert.strictEqual(a.movementsPlan.ok, false);
    // locked or analyzing: nothing happens
    a.movementsPanel.starts = [12];
    a.analyzing = true;
    const lockedJson = JSON.stringify(a.selectedRelease);
    a.applyMovements();
    assert.strictEqual(JSON.stringify(a.selectedRelease), lockedJson);
    a.analyzing = false;
    // a second import is refused while a title source is set
    a.applyMovements();
    assert.ok(a.titleSource);
    a.openMovementsPanel();
    assert.strictEqual(a.movementsPanel.open, false, 'one title source per recording');
    assert.strictEqual(a.canUseMovements, false);

    // offered only where it can help: a release with a work, or a track-count mismatch
    const plain = mk({ id: 5, artist: 'Band', title: 'Pop', tracks: [{ position: 'A1', title: 'Song', duration: '3:00' }] }, ['A']);
    assert.strictEqual(plain.canUseMovements, false, 'plain release, counts agree: not offered');
    plain.trackCountMismatch = true;
    assert.strictEqual(plain.canUseMovements, true, 'more detected tracks than the release lists: offered');
    assert.strictEqual(mk().canUseMovements, true, 'a release with an index track: offered');

    console.log('title_source tests passed');
})().catch(error => { console.error(error); process.exit(1); });
