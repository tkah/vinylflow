// Exact release by Discogs link/number: the release is selected and tracks are placed.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const state = () => b.eval(`${A} return JSON.stringify({ release: a.selectedRelease?.title || null, tracks: a.detectedTracks.length,
  regions: a.waveformRegions ? a.waveformRegions.getRegions().filter(r => String(r.id).startsWith('track-')).length : 0,
  notice: a.releaseIdNotice, analyzing: a.analyzing, loading: a.waveformLoading });`);
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  await b.sleep(1500);
  await b.eval(`${A} a.releaseIdInput = 'https://www.discogs.com/master/99'; await a.openReleaseById(); return '1';`);
  await b.sleep(400); console.log('master link ->', JSON.stringify(await state()));
  await b.shot(`${OUT}/id-1-master-notice.png`);
  const input = 'https://www.discogs.com/release/424243-Verify-Artist-Right-Pressing';
  await b.eval(`${A} a.releaseIdInput = ${JSON.stringify(input)}; await a.openReleaseById(); return '1';`);
  for (let i = 0; i < 40; i++) { const s = await state(); if (s.regions === 3 && !s.analyzing && !s.loading) break; await b.sleep(250); }
  console.log('release link ->', JSON.stringify(await state()));
  await b.shot(`${OUT}/id-2-selected.png`);
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
