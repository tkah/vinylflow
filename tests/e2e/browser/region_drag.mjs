// Dragging a track wider than the view from its middle: the view follows the edge the track is
// moving towards (start when dragging left, end when dragging right) and never flips between them.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
const drag = dx => b.eval(`${A} a.currentZoom = 120; a.waveform.zoom(120); const sc = a.waveform.getWrapper().parentElement;
    sc.scrollLeft = 62 * 120 - sc.clientWidth / 2; await new Promise(r => setTimeout(r, 300));
    const region = a.waveformRegions.getRegions().find(r => r.id === 'track-2');
    const el = region.element, rect = sc.getBoundingClientRect(), y = rect.top + rect.height / 2;
    let x = rect.left + rect.width / 2;
    const pps = sc.scrollWidth / a.waveform.getDuration();
    const fire = (type, cx) => (type === 'pointerdown' ? el : document).dispatchEvent(new PointerEvent(type,
      { bubbles: true, composed: true, clientX: cx, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true }));
    const edgeX = () => Math.round((${dx} < 0 ? region.start : region.end) * pps - sc.scrollLeft);
    const before = region.start, scrolls = [], edges = [];
    fire('pointerdown', x);
    for (let i = 0; i < 12; i++) { x += ${dx}; fire('pointermove', x); await new Promise(r => setTimeout(r, 30));
      scrolls.push(Math.round(sc.scrollLeft)); edges.push(edgeX()); }
    fire('pointerup', x); await new Promise(r => setTimeout(r, 200));
    const after = scrolls.slice(1).map((s, i) => Math.abs(s - scrolls[i]));
    return JSON.stringify({ dir: ${dx} < 0 ? 'left' : 'right', view: sc.clientWidth, leadingEdgeOnScreen: edges,
      maxJumpAfterFirstMove: Math.max(...after), moved: +(region.start - before).toFixed(2) });`);
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  for (let i = 0; i < 40; i++) { if (await b.eval(`${A} return JSON.stringify(a.searchResults.length >= 2);`)) break; await b.sleep(250); }
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return '1';`);
  for (let i = 0; i < 60; i++) { if (await b.eval(`${A} return JSON.stringify(!!a.waveform && !a.waveformLoading && !a.analyzing && a.waveformRegions.getRegions().length >= 3);`)) break; await b.sleep(250); }
  await b.sleep(500);
  console.log(await drag(-6));
  console.log(await drag(6));
  await b.shot(`${OUT}/drag-right.png`, 'viewport');
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
