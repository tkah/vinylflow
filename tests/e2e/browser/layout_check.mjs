// Footer stays at the bottom of a short page; the waveform scrollbar appears when zoomed and scrolls it.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
const A = `const a = Alpine.$data(document.querySelector('[x-data]'));`;
try {
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  console.log('empty page footer:', await b.eval(`const f = document.querySelector('footer').getBoundingClientRect();
    return JSON.stringify({ footerBottom: Math.round(f.bottom), windowHeight: innerHeight, pageHeight: document.documentElement.scrollHeight });`));
  await b.shot(`${OUT}/layout-1-empty.png`, 'viewport');
  await b.eval(`${A} a.importTab='folder'; await a.loadImportList(); a.importSelected=a.importInfo.files.map(f=>f.name); await a.importSelectedFiles(); return '1';`);
  for (let i = 0; i < 40; i++) { if (await b.eval(`${A} return JSON.stringify(a.searchResults.length >= 2);`)) break; await b.sleep(250); }
  await b.eval(`${A} await a.chooseResult(a.searchResults.find(r => r.title === 'Right Pressing')); return '1';`);
  for (let i = 0; i < 60; i++) { if (await b.eval(`${A} return JSON.stringify(!!a.waveform && !a.waveformLoading && !a.analyzing);`)) break; await b.sleep(250); }
  await b.sleep(500);
  const bar = () => b.eval(`${A} const el = document.querySelector('[data-testid=wave-scrollbar]');
    return JSON.stringify({ visible: getComputedStyle(el).display !== 'none', view: [a.waveView.start.toFixed(3), a.waveView.end.toFixed(3)] });`);
  console.log('fit to width:', await bar());
  for (let i = 0; i < 4; i++) { await b.eval(`${A} a.zoomIn(); return '1';`); await b.sleep(200); }
  console.log('zoomed in:', await bar());
  // Press the track near its right end: the view jumps there
  await b.eval(`const el = document.querySelector('[data-testid=wave-scrollbar]'); const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width * 0.9, clientY: r.top + 5, pointerId: 1, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return '1';`);
  await b.sleep(300); console.log('after track press at 90%:', await bar());
  // Drag the thumb back to the start
  await b.eval(`${A} const el = document.querySelector('[data-testid=wave-scrollbar]'); const r = el.getBoundingClientRect();
    const x0 = r.left + r.width * (a.waveView.start + a.waveView.end) / 2;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: r.top + 5, pointerId: 1, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left - 50, clientY: r.top + 5, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return '1';`);
  await b.sleep(300); console.log('after dragging thumb left:', await bar());
  // Wheel zoom: ⌘/Ctrl + wheel zooms around the pointer; a plain wheel is left to the page.
  const wheel = (mods, dy) => b.eval(`${A} const c = document.getElementById('waveform'); const sc = a.waveform.getWrapper().parentElement;
    const r = sc.getBoundingClientRect(), x = r.width * 0.3, before = (sc.scrollLeft + x) / (sc.scrollWidth / a.waveform.getDuration());
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + 50, deltaY: ${dy}, ...${JSON.stringify(mods)} });
    c.dispatchEvent(ev);
    const after = (sc.scrollLeft + x) / (sc.scrollWidth / a.waveform.getDuration());
    return JSON.stringify({ zoom: +a.currentZoom.toFixed(1), prevented: ev.defaultPrevented, timeUnderPointer: [+before.toFixed(2), +after.toFixed(2)] });`);
  console.log('cmd+wheel in :', await wheel({ metaKey: true }, -300));
  console.log('pinch (ctrl) :', await wheel({ ctrlKey: true }, -40));
  console.log('cmd+wheel out:', await wheel({ metaKey: true }, 200));
  console.log('plain wheel  :', await wheel({}, -300));
  for (let i = 0; i < 20; i++) await wheel({ metaKey: true }, 400);
  console.log('all the way out:', await bar());
  await b.eval(`document.getElementById('waveform').scrollIntoView({ block: 'center' }); return '1';`); await b.sleep(300);
  await b.shot(`${OUT}/layout-2-zoomed.png`, 'viewport');
} catch (e) { console.log('ERROR', e.message); }
finally { console.log(b.logs.filter(l => /error/i.test(l)).join('\n')); await b.close(); }
