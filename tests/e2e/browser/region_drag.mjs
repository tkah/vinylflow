// Dragging a track region from its middle while zoomed in (region wider than the view) must not
// make the view jump between the region's start and end.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  for (let i = 0; i < 40; i++) { if (await b.eval(`${A} return JSON.stringify(a.searchResults.length >= 2);`)) break; await b.sleep(250); }
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return '1';`);
  for (let i = 0; i < 60; i++) { if (await b.eval(`${A} return JSON.stringify(!!a.waveform && !a.waveformLoading && !a.analyzing && a.waveformRegions.getRegions().length >= 3);`)) break; await b.sleep(250); }
  await b.sleep(500);
  // Zoom so track 2 (40 s) is much wider than the view, and centre the view inside it
  await b.eval(`${A} a.currentZoom = 120; a.waveform.zoom(120); const sc = a.waveform.getWrapper().parentElement;
    sc.scrollLeft = 62 * 120 - sc.clientWidth / 2; return '1';`);
  await b.sleep(400);
  const result = await b.eval(`${A} const sc = a.waveform.getWrapper().parentElement;
    const region = a.waveformRegions.getRegions().find(r => r.id === 'track-2');
    const el = region.element, rect = sc.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    let x = rect.left + rect.width / 2;
    const target = document.elementFromPoint(x, y);
    const fire = (type, cx) => (type === 'pointerdown' ? el : document).dispatchEvent(new PointerEvent(type,
      { bubbles: true, composed: true, clientX: cx, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true }));
    const scrolls = [Math.round(sc.scrollLeft)];
    const startBefore = region.start;
    fire('pointerdown', x);
    for (let i = 0; i < 12; i++) { x += 6; fire('pointermove', x); await new Promise(r => setTimeout(r, 30)); scrolls.push(Math.round(sc.scrollLeft)); }
    fire('pointerup', x);
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify({ viewWidth: sc.clientWidth, regionWidth: Math.round(el.getBoundingClientRect().width), scrolls,
      maxJump: Math.max(...scrolls.slice(1).map((s, i) => Math.abs(s - scrolls[i]))), moved: +(region.start - startBefore).toFixed(2) });`);
  console.log(result);
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
