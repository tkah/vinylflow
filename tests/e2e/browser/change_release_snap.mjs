// Repro: pick release, hand-edit a cut, Change release, pick another, Snap to Discogs -> regions?
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const state = () => b.eval(`${A} const r = a.waveformRegions ? a.waveformRegions.getRegions() : [];
  return JSON.stringify({ file: a.currentFileId, release: a.selectedRelease?.title || null, tracks: a.detectedTracks.map(t => [t.start, t.end].map(x => +x.toFixed(1))),
    regions: r.filter(x => String(x.id).startsWith('track-')).length, ghosts: r.filter(x => String(x.id).startsWith('expected-')).length,
    waveform: !!a.waveform, loading: a.waveformLoading, analyzing: a.analyzing, banner: a.editBanner, edited: a.boundariesEdited,
    notice: a.rescanNotice, player: a.playerNotice, results: a.searchResults.length });`);
const waitFor = async (cond, label, ms = 20000) => { const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) { s = await state(); if (cond(s)) return s; await b.sleep(250); }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`); };
try {
  await b.goto('http://127.0.0.1:8765/');
  await b.sleep(1500);
  await b.eval(`${A} a.importTab = 'folder'; await a.loadImportList(); a.importSelected = a.importInfo.files.map(f => f.name); await a.importSelectedFiles(); return JSON.stringify(1);`);
  let s = await waitFor(s => s.results >= 2, 'search results');
  console.log('1 imported + searched', JSON.stringify(s));
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Wrong Pressing')); return JSON.stringify(1);`);
  s = await waitFor(s => s.regions === 3 && !s.loading && !s.analyzing, 'regions after first release');
  console.log('2 wrong release', JSON.stringify(s));
  await b.shot(`${OUT}/2-wrong-release.png`);
  // Hand edit: move the first cut like a region drag would
  await b.eval(`${A} const t = a.detectedTracks; t[0].end -= 2; t[0].duration = t[0].end - t[0].start; a.markEdited(); a.addTrackRegions(); return JSON.stringify(1);`);
  await b.eval(`${A} a.changeRelease(); return JSON.stringify(1);`);
  await b.sleep(1000); s = await state(); console.log('3 after Change release', JSON.stringify(s));
  console.log('3 console:', b.logs.filter(l => /error|warn/i.test(l) && !/tailwind/.test(l)).join('\n   '));
  console.log('3 visible:', await b.eval(`const v = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing'; }; return JSON.stringify({ search: v('discogs-search'), release: v('release-card') });`));
  await b.shot(`${OUT}/3-change-release.png`);
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return JSON.stringify(1);`);
  await b.sleep(800); s = await state(); console.log('4 after picking right release', JSON.stringify(s));
  await b.shot(`${OUT}/4-right-release.png`);
  await b.eval(`${A} await a.snapToDiscogs(); return JSON.stringify(1);`);
  for (const ms of [300, 1500, 4000]) { await b.sleep(ms); console.log(`5 after Snap +${ms}ms`, JSON.stringify(await state())); }
  await b.shot(`${OUT}/5-after-snap.png`);
} catch (e) { console.log('ERROR', e.message); }
finally { console.log('console:', b.logs.filter(l => !/^debug/.test(l)).slice(-15).join('\n  ')); await b.close(); }
