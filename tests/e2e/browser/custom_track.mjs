// Custom track + rename: split a third pressing track in two, name the extra split with "Custom track...",
// rename another track, then print the export request body. No cut may move and no re-detection runs.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const state = () => b.eval(`${A} const r = a.waveformRegions ? a.waveformRegions.getRegions() : [];
  return JSON.stringify({ release: a.selectedRelease?.title || null, positions: (a.selectedRelease?.tracks || []).map(t => t.position),
    regions: r.filter(x => String(x.id).startsWith('track-')).length, loading: a.waveformLoading, analyzing: a.analyzing,
    results: a.searchResults.length, mapping: a.customMapping, cuts: a.detectedTracks.map(t => [t.start, t.end].map(x => +x.toFixed(1))),
    problem: a.exportProblem(a.currentFile, a.currentWorkspaceState(false)) });`);
const waitFor = async (cond, label, ms = 20000) => { const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) { s = await state(); if (cond(s)) return s; await b.sleep(250); }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`); };
const type = (testid, text) => b.eval(`const el = document.querySelector('[data-testid=${testid}]:not([style*="display: none"])'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return '1';`);
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  await waitFor(s => s.results >= 3, 'search results');
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return '1';`);
  let s = await waitFor(s => s.regions === 3 && !s.loading && !s.analyzing, '3 regions');
  console.log('1 right pressing', JSON.stringify(s));
  // Split the third track in two, as a right-click "Split here" does.
  await b.eval(`${A} const t = a.detectedTracks[2]; a.contextMenu.time = (t.start + t.end) / 2; a.splitAtContextMenu(); return '1';`);
  s = await waitFor(s => s.regions === 4, '4 regions after the split');
  console.log('2 split (4th has no track)', JSON.stringify(s));
  const cuts = JSON.stringify(s.cuts);
  // Choose "Custom track..." on row 4 through the real <select>.
  await b.eval(`const sel = [...document.querySelectorAll('select')].filter(el => el.querySelector('option[value=custom]'))[3]; sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true })); return '1';`);
  await b.sleep(400);
  console.log('3 form position prefill', await b.eval(`return JSON.stringify(document.querySelector('[data-testid=track-form-position]:not([disabled])')?.value)`));
  await type('track-form-title', 'Hidden Gem');
  await b.sleep(300);
  await b.shot(`${OUT}/ct-1-form.png`);
  await b.eval(`const f = [...document.querySelectorAll('[data-testid=track-form]')].find(f => getComputedStyle(f).display !== 'none'); f.requestSubmit(); return '1';`);
  await b.sleep(500);
  // Rename the second track through its Rename button.
  await b.eval(`document.querySelectorAll('[data-testid=rename-track]')[1].click(); return '1';`);
  await b.sleep(300);
  await type('track-form-title', 'Second Song (Remastered)');
  await b.eval(`const f = [...document.querySelectorAll('[data-testid=track-form]')].find(f => getComputedStyle(f).display !== 'none'); f.requestSubmit(); return '1';`);
  await b.sleep(600);
  s = await state();
  console.log('4 after add + rename', JSON.stringify(s), 'cuts unchanged:', JSON.stringify(s.cuts) === cuts);
  await b.eval(`document.querySelector('.track-grid').scrollIntoView(); return '1';`);
  await b.sleep(400);
  await b.shot(`${OUT}/ct-2-table.png`);
  console.log('5 export request', await b.eval(`${A} return JSON.stringify(a.buildExportRequest(a.currentFileId), null, 1);`));
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
