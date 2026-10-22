// Index track (suite): "Split into parts" re-detects for the part count, "Keep as one track" folds back.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const state = () => b.eval(`${A} const r = a.waveformRegions ? a.waveformRegions.getRegions() : [];
  return JSON.stringify({ release: a.selectedRelease?.title || null, positions: (a.selectedRelease?.tracks || []).map(t => t.position),
    regions: r.filter(x => String(x.id).startsWith('track-')).length, loading: a.waveformLoading, analyzing: a.analyzing,
    banner: a.editBanner, results: a.searchResults.length, index: a.indexTracks.map(e => [e.range, e.title, e.unfolded]),
    button: document.querySelector('[data-testid=index-tracks] button')?.textContent.trim() || null });`);
const waitFor = async (cond, label, ms = 20000) => { const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) { s = await state(); if (cond(s)) return s; await b.sleep(250); }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`); };
const shotCard = name => b.eval(`document.getElementById('release-card').scrollIntoView(); return '1';`).then(() => b.sleep(500)).then(() => b.shot(`${OUT}/${name}`));
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  await waitFor(s => s.results >= 3, 'search results');
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.id === 424244)); return '1';`);
  let s = await waitFor(s => s.regions === 2 && !s.loading && !s.analyzing, 'folded: 2 regions');
  console.log('folded', JSON.stringify(s));
  await shotCard('unfold-1-folded.png');
  await b.eval(`document.querySelector('[data-testid=index-tracks] button').click(); return '1';`);
  s = await waitFor(s => s.regions === 3 && !s.loading && !s.analyzing && s.index[0]?.[2] === true, 'unfolded: 3 regions');
  console.log('unfolded', JSON.stringify(s));
  await shotCard('unfold-2-unfolded.png');
  await b.eval(`document.querySelector('[data-testid=index-tracks] button').click(); return '1';`);
  s = await waitFor(s => s.regions === 2 && !s.loading && !s.analyzing && s.index[0]?.[2] === false, 'folded again: 2 regions');
  console.log('folded again', JSON.stringify(s));
  await shotCard('unfold-3-folded-again.png');
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
