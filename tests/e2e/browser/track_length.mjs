// Typing a length into the track table moves the end (and the touching next start) and the regions follow.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const state = () => b.eval(`${A} const r = a.waveformRegions.getRegions().filter(x => String(x.id).startsWith('track-'));
  return JSON.stringify({ tracks: a.detectedTracks.map(t => [+t.start.toFixed(1), +t.end.toFixed(1)]),
    regions: r.map(x => [+x.start.toFixed(1), +x.end.toFixed(1)]),
    field: document.querySelector('input[aria-label="Track length"]').value });`);
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  for (let i = 0; i < 40; i++) { if (await b.eval(`${A} return JSON.stringify(a.searchResults.length >= 2);`)) break; await b.sleep(250); }
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return '1';`);
  for (let i = 0; i < 60; i++) { if (await b.eval(`${A} return JSON.stringify(!!a.waveform && !a.waveformLoading && !a.analyzing && a.waveformRegions.getRegions().length >= 3);`)) break; await b.sleep(250); }
  await b.sleep(500);
  console.log('before :', await state());
  // Type into the first Length field like a user: set value, fire change
  await b.eval(`const f = document.querySelector('input[aria-label="Track length"]'); f.focus(); f.value = '0:35';
    f.dispatchEvent(new Event('change', { bubbles: true })); f.blur(); return '1';`);
  await b.sleep(400);
  console.log('typed 0:35:', await state());
  // Header cells must sit over their columns (each row is its own grid)
  console.log('header vs first row x offsets:', await b.eval(`const head = document.querySelector('.track-grid.font-semibold');
    const row = [...document.querySelectorAll('.track-grid.text-sm')][0];
    return JSON.stringify([...head.children].map((h, i) => Math.round(h.getBoundingClientRect().left - row.children[i].getBoundingClientRect().left)));`));
  await b.eval(`document.querySelector('input[aria-label="Track length"]').scrollIntoView({ block: 'center' }); return '1';`); await b.sleep(300);
  await b.shot(`${OUT}/length-typed.png`, 'viewport');
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
