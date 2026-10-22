// The Settings dialog fits a short window: it scrolls inside and Save stays visible.
import { launch } from './bidi.mjs';
const OUT = process.argv[2];
const b = await launch(`${OUT}/profile`);
try {
  await b.send('browsingContext.setViewport', { context: b.context, viewport: { width: 1280, height: 700 } });
  await b.goto('http://127.0.0.1:8765/'); await b.sleep(1500);
  await b.eval(`Alpine.$data(document.querySelector('[x-data]')).showSettings = true; return '1';`); await b.sleep(400);
  const m = () => b.eval(`const panel = [...document.querySelectorAll('h2')].find(h => h.textContent.trim() === 'Settings').parentElement;
    const save = [...panel.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save').getBoundingClientRect();
    return JSON.stringify({ windowH: innerHeight, panelH: Math.round(panel.getBoundingClientRect().height), contentH: panel.scrollHeight,
      scrollable: panel.scrollHeight > panel.clientHeight, sideways: panel.scrollWidth > panel.clientWidth, saveVisible: save.bottom <= innerHeight && save.top >= 0 });`);
  console.log('opened      :', await m());
  await b.eval(`const panel = [...document.querySelectorAll('h2')].find(h => h.textContent.trim() === 'Settings').parentElement; panel.scrollTop = 99999; return '1';`);
  await b.sleep(300); console.log('scrolled end:', await m());
  await b.shot(`${OUT}/settings-scrolled.png`, 'viewport');
} catch (e) { console.log('ERROR', e.message); }
finally { await b.close(); }
