// Minimal WebDriver BiDi client for headless Firefox (Node 24 built-in WebSocket).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function launch(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true });
  // Throwaway profile: no network beyond 127.0.0.1 is ever requested by the page under test.
  fs.writeFileSync(`${profileDir}/user.js`, [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("network.proxy.allow_hijacking_localhost", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
  ].join('\n'));
  const ff = spawn('/Applications/Firefox.app/Contents/MacOS/firefox',
    ['--headless', '--no-remote', '--remote-debugging-port', '9222', '-profile', profileDir, '--width', '1400', '--height', '1000'],
    { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { ws = new WebSocket('ws://127.0.0.1:9222/session'); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; }); break; }
    catch { ws = null; }
  }
  if (!ws) throw new Error('Firefox BiDi did not start');
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = m => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const { ok, no } = pending.get(d.id); pending.delete(d.id); d.type === 'error' ? no(new Error(d.error + ': ' + d.message)) : ok(d.result); }
    else if (d.method === 'log.entryAdded') logs.push(`${d.params.level}: ${d.params.text}`); };
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; pending.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('session.new', { capabilities: {} });
  await send('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.setViewport', { context, viewport: { width: 1400, height: 1000 } });
  const api = {
    logs, send, context,
    goto: url => send('browsingContext.navigate', { context, url, wait: 'complete' }),
    async eval(expression) {
      const r = await send('script.evaluate', { expression: `(async () => { ${expression} })()`, target: { context }, awaitPromise: true, resultOwnership: 'none' });
      if (r.type === 'exception') throw new Error('page: ' + (r.exceptionDetails?.text || JSON.stringify(r.exceptionDetails)));
      return r.result?.value !== undefined ? JSON.parse(r.result.value) : undefined;
    },
    async shot(file, origin = 'document') {
      const r = await send('browsingContext.captureScreenshot', { context, origin });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async close() { try { await send('session.end'); } catch {} ws.close(); ff.kill(); },
    sleep,
  };
  return api;
}
