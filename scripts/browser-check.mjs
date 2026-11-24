// QuakeSense browser integration check: serves the repo on a loopback
// ephemeral port, drives a throwaway headless Chrome over CDP with real input
// events, asserts behavior at 1440x900 and 390x844, verifies exports and the
// drill card print path, and captures docs/desktop.png and docs/wavefront.png.
// Node standard library only.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOCS = join(ROOT, 'docs');
const SCRATCH_ROOT = join(ROOT, '.browser-scratch');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function assertCheck(name, fn, detail = '') {
  try { await fn(); check(name, true); }
  catch (err) { check(name, false, detail || err.message); }
}

class CDP {
  static connect(url) {
    const ws = new WebSocket(url);
    return new Promise((res, rej) => {
      ws.addEventListener('open', () => res(new CDP(ws)), { once: true });
      ws.addEventListener('error', () => rej(new Error(`WebSocket failed: ${url}`)), { once: true });
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', e => this._onMessage(e));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome disconnected'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome socket error'));
      this.pending.clear();
    });
  }
  _onMessage(e) {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
        else p.resolve(m.result);
      }
      return;
    }
    for (const key of [`${m.sessionId || ''}:${m.method}`, `*:${m.method}`]) {
      for (const fn of this.handlers.get(key) || []) fn(m.params || {}, m.sessionId);
    }
  }
  send(method, params = {}, sessionId, timeout = 20000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
    });
  }
  on(method, fn, sessionId) {
    const key = `${sessionId || ''}:${method}`;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(fn);
  }
  once(method, sessionId, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const key = `${sessionId || ''}:${method}`;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
      const fn = params => {
        clearTimeout(timer);
        const list = this.handlers.get(key) || [];
        this.handlers.set(key, list.filter(f => f !== fn));
        resolve(params);
      };
      this.on(method, fn, sessionId);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

let server, chrome, cdp, scratch, profile, downloadDir, sid, origin;
const errors = [];
const requests = [];

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page evaluation failed');
  }
  return r.result.value;
}

async function waitFor(expression, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function rectOf(selector) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  })()`);
  if (!rect) throw new Error(`no element for ${selector}`);
  return rect;
}

async function mouse(type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, sid);
}

async function clickAt(x, y) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
}

async function click(selector) {
  const r = await rectOf(selector);
  await clickAt(r.x, r.y);
  return r;
}

async function key(keyName, code, vk, text) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
  if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, key: keyName }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
}

async function capture(file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const buf = Buffer.from(data, 'base64');
  await writeFile(join(DOCS, file), buf);
  const wpx = buf.readUInt32BE(16);
  const hpx = buf.readUInt32BE(20);
  console.log(`wrote docs/${file} (${wpx}x${hpx})`);
  return { wpx, hpx };
}

async function navigate(url) {
  const loaded = cdp.once('Page.loadEventFired', sid, 15000);
  await cdp.send('Page.navigate', { url }, sid);
  await loaded;
  await sleep(400);
}

async function setField(selector, value, type = 'change') {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event(${JSON.stringify(type)}, { bubbles: true }));
    return true;
  })()`);
}

async function startChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  await mkdir(SCRATCH_ROOT, { recursive: true });
  scratch = await mkdtemp(join(SCRATCH_ROOT, 'run-'));
  profile = join(scratch, 'profile');
  downloadDir = join(scratch, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  chrome = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-crash-restore-bubble',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    try {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const [port, path] = text.trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch { /* not written yet */ }
    await sleep(100);
  }
  throw new Error('Chrome DevToolsActivePort never appeared');
}

async function waitForFile(name, timeout = 9000) {
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < timeout) {
    const files = await readdir(downloadDir).catch(() => []);
    if (files.includes(name)) {
      const { size } = await stat(join(downloadDir, name)).catch(() => ({ size: -1 }));
      if (size > 0 && size === lastSize) return readFile(join(downloadDir, name), 'utf8');
      lastSize = size;
    }
    await sleep(200);
  }
  throw new Error(`download never appeared: ${name}`);
}

async function cleanup() {
  try { cdp?.close(); } catch {}
  try { chrome?.kill('SIGTERM'); } catch {}
  if (chrome) {
    await Promise.race([
      new Promise(r => chrome.once('exit', r)),
      sleep(2000),
    ]).catch(() => {});
    try { chrome.kill('SIGKILL'); } catch {}
    await sleep(400);
  }
  try { server?.close(); } catch {}
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  server = serve();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}/`;
  console.log(`server: ${origin}`);
  const wsUrl = await startChrome();
  console.log('chrome: headless scratch profile', scratch);

  cdp = await CDP.connect(wsUrl);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find(t => t.type === 'page');
  if (!page) throw new Error('no page target found');
  ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
  await cdp.send('Target.activateTarget', { targetId: page.targetId });

  cdp.on('Runtime.exceptionThrown', p => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'uncaught exception');
  }, sid);
  cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') errors.push(`console.error: ${(p.args || []).map(a => a.value ?? a.description ?? '').join(' ')}`);
  }, sid);
  cdp.on('Log.entryAdded', p => {
    const entry = p.entry;
    if (entry && entry.level === 'error') {
      errors.push(`[log] ${entry.source || 'browser'}: ${entry.text || ''}${entry.url ? ` ${entry.url}` : ''}`);
    }
  }, sid);
  cdp.on('Network.requestWillBeSent', p => requests.push(p.request?.url || ''), sid);

  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Network.enable', {}, sid);
  await cdp.send('Log.enable', {}, sid);

  const sel = id => `document.getElementById('${id}')`;
  const text = id => `${sel(id)}.textContent`;

  // ============ Desktop pass: 1440x900 ============
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await navigate(origin);
  await waitFor(`document.querySelectorAll('#presets button').length === 3`, 'scenario tabs');

  await assertCheck('coastal scenario active on load', async () => {
    assert.equal(await evaluate(`document.querySelector('#presets button[data-preset="coastal"]').getAttribute('aria-pressed')`), 'true');
  });
  await assertCheck('paused at authored 16.50 s snapshot', async () => {
    assert.equal((await evaluate(text('time-out'))).trim(), '16.50 s');
    assert.equal(await evaluate(`${sel('play')}.getAttribute('aria-pressed')`), 'false');
    assert.equal(await evaluate(text('play-label')), 'Play');
  });
  await assertCheck('six stations and three sites render', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('#station option').length`), 6);
    assert.equal(await evaluate(`document.querySelectorAll('#station-list tbody tr').length`), 6);
    assert.equal(await evaluate(`document.querySelectorAll('#sites .site-card').length`), 3);
  });
  await assertCheck('alert line reports modeled 14.74 s', async () => {
    assert.match(await evaluate(text('alert')), /14\.74 s/);
  });
  await assertCheck('title and disclaimer present', async () => {
    assert.equal(await evaluate(`document.querySelector('h1').textContent`), 'QuakeSense');
    assert.match(await evaluate(`document.querySelector('.exercise-note').textContent`), /Synthetic exercise\. Not a live warning or a replacement for USGS ShakeAlert\./);
  });
  await assertCheck('1440x900: no document x-overflow', async () => {
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await assertCheck('map canvas is painted, not blank', async () => {
    const colors = await evaluate(`(() => {
      const c = document.getElementById('map');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4 * 911) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return set.size;
    })()`);
    assert.ok(colors > 5, `only ${colors} colors`);
  });

  await mkdir(DOCS, { recursive: true });
  await evaluate(`(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); window.scrollTo(0, 0); return true; })()`);
  const shot1 = await capture('desktop.png');
  check('desktop.png captured at 1440x900', shot1.wpx === 1440 && shot1.hpx === 900, `${shot1.wpx}x${shot1.hpx}`);

  // Counterfactual toggles via real pointer.
  await click('#denser');
  await click('#faster');
  await waitFor(`document.querySelectorAll('#station option').length === 8`, 'eight stations');
  await assertCheck('denser plus faster yields eight stations', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('#station option').length`), 8);
  });
  await assertCheck('alert improves to 9.43 s', async () => {
    assert.match(await evaluate(text('alert')), /9\.43 s/);
  });
  await assertCheck('comparison reports 4939.2 km2 area reduced', async () => {
    assert.match(await evaluate(text('delta')), /4939\.2/);
  });
  await assertCheck('Bayview School shows 12.80 s lead', async () => {
    assert.ok(await evaluate(`[...document.querySelectorAll('.site-card')].find(c => c.textContent.includes('Bayview'))?.textContent.includes('12.80 s')`));
  });
  await assertCheck('no x-overflow after counterfactuals', async () => {
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });

  // Native timeline keys, then a settled 18 s frame for the wavefront capture.
  await click('#time');
  await key('End', 'End', 35);
  await waitFor(`${text('time-out')}.trim() === '45.00 s'`, 'End key to 45 s');
  check('End key drives timeline to 45.00 s', true);
  await key('Home', 'Home', 36);
  await waitFor(`${text('time-out')}.trim() === '0.00 s'`, 'Home key to 0 s');
  check('Home key drives timeline to 0.00 s', true);
  await setField('#time', '18', 'input');
  await waitFor(`${text('time-out')}.trim() === '18.00 s'`, '18 s frame');
  await assertCheck('status drops the 16.50 snapshot line after scrubbing', async () => {
    assert.doesNotMatch(await evaluate(text('map-status')), /16\.50/);
  });
  await evaluate(`(async () => {
    document.getElementById('time').blur();
    window.scrollTo(0, Math.max(0, document.querySelector('.map-panel').offsetTop - 12));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`);
  const shot2 = await capture('wavefront.png');
  check('wavefront.png captured at 1440x900', shot2.wpx === 1440 && shot2.hpx === 900, `${shot2.wpx}x${shot2.hpx}`);
  await assertCheck('wavefront frame shows map headline and reaches the traces', async () => {
    const m = await evaluate(`document.getElementById('map-title').getBoundingClientRect().top`);
    const t = await evaluate(`document.getElementById('traces').getBoundingClientRect().top`);
    assert.ok(m >= 0 && m < 900, `map headline top ${m}`);
    assert.ok(t < 900, `traces top ${t}`);
  });

  // High quorum: no alert, comparison unavailable, no exceptions.
  await setField('#trigger-count', '12');
  await waitFor(`${text('alert')}.includes('No alert')`, 'quorum of twelve blocks the alert');
  await assertCheck('trigger count 12 produces No alert and unavailable comparison', async () => {
    assert.match(await evaluate(text('alert')), /No alert/);
    assert.match(await evaluate(text('delta')), /Comparison unavailable/);
  });

  // Preset changes reset time and toggles.
  await click('#presets button[data-preset="urban"]');
  await waitFor(`${text('time-out')}.trim() === '0.00 s'`, 'urban reset');
  await assertCheck('urban preset resets time and both switches', async () => {
    assert.equal((await evaluate(text('time-out'))).trim(), '0.00 s');
    assert.equal(await evaluate(`${sel('denser')}.checked`), false);
    assert.equal(await evaluate(`${sel('faster')}.checked`), false);
  });
  await assertCheck('Juniper School reads No lead', async () => {
    assert.ok(await evaluate(`[...document.querySelectorAll('.site-card')].find(c => c.textContent.includes('Juniper'))?.textContent.includes('No lead')`));
  });

  await click('#presets button[data-preset="rural"]');
  await waitFor(`${text('geom')}.includes('333.7 deg')`, 'rural gap');
  await assertCheck('rural one-sided network reports 333.7 deg gap', async () => {
    assert.match(await evaluate(text('geom')), /333\.7 deg/);
  });
  await assertCheck('no early located solution on rural', async () => {
    assert.match(await evaluate(text('estimate')), /Unresolved/);
  });

  await setField('#velocity', 'layered');
  await waitFor(`${text('wadati')}.includes('unavailable')`, 'layered wadati');
  check('layered velocity reports Wadati unavailable', true);
  await setField('#velocity', 'uniform');

  // Coordinate form: custom epicenter, manual station, removal with focus return.
  await setField('#cx', '-25'); await setField('#cy', '-11');
  await click('#coordinates button[value="epicenter"]');
  await waitFor(`${text('truth')}.includes('(-25.0, -11.0)')`, 'epicenter applied');
  await assertCheck('apply epicenter shows signed coordinates', async () => {
    assert.match(await evaluate(text('truth')), /\(-25\.0, -11\.0\)/);
  });
  await setField('#cx', '-16'); await setField('#cy', '-16');
  await click('#coordinates button[value="station"]');
  await waitFor(`document.getElementById('station-list').textContent.includes('M1')`, 'manual station placed');
  await assertCheck('manual station M1 appears in the table', async () => {
    assert.match(await evaluate(`document.getElementById('station-list').textContent`), /M1/);
  });
  await click('#station-list .row-btn');
  await waitFor(`!document.getElementById('station-list').textContent.includes('M1')`, 'manual station removed');
  await assertCheck('manual station removed and focus returns to station select', async () => {
    assert.ok(!(await evaluate(`document.getElementById('station-list').textContent`)).includes('M1'));
    assert.equal(await evaluate(`document.activeElement && document.activeElement.id`), 'station');
  });
  await setField('#station', 'R02');
  await assertCheck('station select drives the trace readout', async () => {
    assert.match(await evaluate(text('trace-values')), /Reference P|P candidate/);
  });

  // Map edit via real pointer at canvas midpoint; truth must change.
  await click('#epicenter-mode');
  const mapRect = await rectOf('#map');
  const truthBefore = await evaluate(text('truth'));
  await clickAt(mapRect.x, mapRect.y);
  await waitFor(`${text('truth')} !== ${JSON.stringify(truthBefore)}`, 'epicenter moved by map click');
  await assertCheck('map click relocates the synthetic epicenter', async () => {
    assert.match(await evaluate(text('map-status')), /Epicenter moved to \(-?\d+\.\d, -?\d+\.\d\) km/);
  });
  await click('#inspect-map');
  await assertCheck('P shortcut preference defaults off', async () => {
    assert.equal(await evaluate(`${sel('shortcuts')}.checked`), false);
  });
  await click('h1');
  const tBefore = await evaluate(`${sel('time')}.value`);
  await key('p', 'KeyP', 80, 'p');
  await sleep(400);
  await assertCheck('P on body does nothing while preference is off', async () => {
    assert.equal(await evaluate(`${sel('play')}.getAttribute('aria-pressed')`), 'false');
    assert.equal(await evaluate(`${sel('time')}.value`), tBefore);
  });
  await click('#shortcuts');
  check('shortcut preference toggles on', await evaluate(`${sel('shortcuts')}.checked`) === true);
  await click('#time');
  await key('p', 'KeyP', 80, 'p');
  await sleep(300);
  await assertCheck('P is ignored with focus on the time range', async () => {
    assert.equal(await evaluate(`${sel('play')}.getAttribute('aria-pressed')`), 'false');
  });
  await click('h1');
  await key('p', 'KeyP', 80, 'p');
  await waitFor(`${sel('play')}.getAttribute('aria-pressed') === 'true'`, 'P starts playback');
  const t0 = await evaluate(`parseFloat(${text('time-out')})`);
  // Headless Chrome can idle the compositor between frames; force frames with
  // throwaway captures so the rAF-driven clock actually ticks.
  let advanced = false;
  for (let i = 0; i < 25 && !advanced; i++) {
    await cdp.send('Page.captureScreenshot', { format: 'png' }, sid).catch(() => {});
    await sleep(120);
    advanced = await evaluate(`parseFloat(${text('time-out')})`) > t0;
  }
  check('P from the page starts playback and time advances', advanced, advanced ? '' : `stuck at ${await evaluate(text('time-out'))}`);
  await key('p', 'KeyP', 80, 'p');
  await waitFor(`${sel('play')}.getAttribute('aria-pressed') === 'false'`, 'P pauses');
  check('P toggles playback off again', true);

  // Native Tab focus ring: visible, 3px, not clipped.
  await evaluate(`document.getElementById('play').focus()`);
  await key('Tab', 'Tab', 9);
  await sleep(200);
  await assertCheck('Tab lands a visible 3px focus ring', async () => {
    const info = await evaluate(`(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { id: el.id, visible: el.matches(':focus-visible'), w: cs.outlineWidth, o: cs.outlineOffset,
               inView: r.left - 6 >= 0 && r.right + 6 <= innerWidth && r.top - 6 >= 0 && r.bottom + 6 <= innerHeight };
    })()`);
    assert.equal(info.id, 'reset-time', `focus on ${info.id}`);
    assert.ok(info.visible, 'no :focus-visible');
    assert.equal(info.w, '3px'); assert.equal(info.o, '3px');
    assert.ok(info.inView, 'outline would be clipped');
  });

  // Exports over real downloads. Reset to coastal for deterministic contents.
  await click('#presets button[data-preset="coastal"]');
  await waitFor(`document.querySelectorAll('#station option').length === 6`, 'coastal reset');
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  } catch {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }, sid);
  }
  await click('#geo');
  const geo = JSON.parse(await waitForFile('quakesense-coastal.geojson'));
  await assertCheck('GeoJSON downloads with the full feature set', async () => {
    assert.equal(geo.type, 'FeatureCollection');
    assert.equal(geo.features.length, 15, `${geo.features.length} features`);
    const kinds = new Set(geo.features.map(f => f.properties.kind));
    assert.ok(kinds.has('blind-zone') && kinds.has('illustrative-isoseismal') && kinds.has('station'));
  });
  await click('#csv');
  const csv = await waitForFile('quakesense-coastal.csv');
  await assertCheck('CSV downloads with the station/site schema', async () => {
    assert.ok(csv.startsWith('"record_type","id","name","kind"'));
    assert.ok(csv.includes('illustrative_mmi'));
  });
  await click('#audit');
  const audit = JSON.parse(await waitForFile('quakesense-coastal-audit.json'));
  await assertCheck('audit JSON carries a 64-hex digest', async () => {
    assert.match(audit.sha256, /^[0-9a-f]{64}$/);
    assert.equal(audit.payload.presetId, 'coastal');
  });

  // Distance lab: SVG chart, five-row comparator, live controls.
  await assertCheck('lab chart draws arrivals plus MMI and the comparator ships five rows', async () => {
    assert.ok((await evaluate(`document.querySelectorAll('#lab-chart path').length`)) >= 2);
    assert.equal(await evaluate(`document.querySelectorAll('#retrofit tbody tr').length`), 5);
    assert.equal(await evaluate(`document.querySelectorAll('#lab-soil option').length`), 4);
    assert.match(await evaluate(text('lab-readout')), /P \d+\.\d\d s, S \d+\.\d\d s/);
    assert.match(await evaluate(text('lab-readout')), /Blind radius/);
    assert.match(await evaluate(`document.getElementById('retrofit').textContent`), /Community resilience package/);
  });
  await setField('#lab-distance', '120');
  await setField('#lab-soil', 'E');
  await assertCheck('lab readout follows site distance and soil class', async () => {
    assert.match(await evaluate(text('lab-readout')), /At 120\.0 km on Soft Basin E/);
  });
  await click('#run-selftests');
  await waitFor(`document.getElementById('selftest-status').textContent.includes('of')`, 'self-tests run');
  await assertCheck('in-page self-tests all pass in the browser', async () => {
    assert.match(await evaluate(text('selftest-status')), /^(\d+) of \1 checks pass/);
    assert.equal(await evaluate(`document.querySelectorAll('#selftest-list .st-fail').length`), 0);
  });
  await click('#brief-json');
  const brief = JSON.parse(await waitForFile('quakesense-coastal-brief.json'));
  await assertCheck('brief JSON carries a digest, five measures and the honest label', async () => {
    assert.match(brief.sha256, /^[0-9a-f]{64}$/);
    assert.equal(brief.payload.lab.interventions.length, 5);
    assert.match(brief.digestNote, /not a signature/);
    assert.equal(brief.payload.synthetic, true);
    assert.match(await evaluate(text('brief-digest')), /^SHA-256 [0-9a-f]{64}$/);
  });
  await click('#brief-md');
  const briefMd = await waitForFile('quakesense-coastal-brief.md');
  await assertCheck('brief Markdown carries the comparator table', async () => {
    assert.match(briefMd, /\| Intervention \| Mode \| Margin \|/);
    assert.match(briefMd, /Community resilience package/);
  });
  await click('#brief-csv');
  const briefCsv = await waitForFile('quakesense-coastal-brief.csv');
  await assertCheck('brief CSV is injection-safe and complete', async () => {
    assert.ok(briefCsv.startsWith('"record_type","key","value"'));
    assert.match(briefCsv, /intervention gas-shutoff/);
  });
  await click('#brief-verify');
  await assertCheck('integrity verify reports a digest match', async () => {
    assert.match(await evaluate(text('brief-status')), /Integrity verified/);
  });
  await click('#brief-tamper');
  await assertCheck('tamper demo proves the digest detects edits', async () => {
    assert.match(await evaluate(text('brief-status')), /does not match/);
  });
  const exportedDigest = await evaluate(text('brief-digest'));
  await setField('#lab-distance', '110');
  await assertCheck('changing the exercise invalidates the displayed brief digest', async () => {
    assert.equal((await evaluate(text('brief-digest'))).trim(), '');
  });
  await click('#brief-verify');
  await assertCheck('verify after a state change rebuilds the digest for the current exercise', async () => {
    const regenerated = await evaluate(text('brief-digest'));
    assert.match(regenerated, /^SHA-256 [0-9a-f]{64}$/);
    assert.notEqual(regenerated, exportedDigest);
    assert.match(await evaluate(text('brief-status')), /Integrity verified/);
  });
  await setField('#lab-distance', '120');

  await setField('#cx', '-20'); await setField('#cy', '-20');
  await click('#coordinates button[value="station"]');
  await waitFor(`document.getElementById('station-list').textContent.includes('M1')`, 'coastal manual station placed');
  await assertCheck('manual station is part of the configured exercise before bookmarking', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('#station option').length`), 7);
  });
  await click('#bookmark-btn');
  await waitFor(`location.hash.startsWith('#qs=')`, 'bookmark hash applied');
  const bmHash = await evaluate(`location.hash`);
  check('bookmark link encodes the exercise in the URL hash',
    bmHash.startsWith('#qs=') && bmHash.length > 20, bmHash.slice(0, 24));
  await navigate(`${origin}?restored${bmHash}`);
  await waitFor(`document.querySelectorAll('#presets button').length === 3`, 'restored render');
  await assertCheck('bookmark restores preset, lab settings and the manual station on reload', async () => {
    assert.equal(await evaluate(`document.getElementById('lab-soil').value`), 'E');
    assert.equal(await evaluate(`document.getElementById('lab-distance').value`), '120');
    assert.match(await evaluate(text('lab-readout')), /At 120\.0 km on Soft Basin E/);
    assert.equal(await evaluate(`document.querySelectorAll('#station option').length`), 7);
    assert.match(await evaluate(`document.getElementById('station-list').textContent`), /M1/);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });

  // Drill card: language, print suppression, one-page PDF, focus return.
  await click('#open-drill');
  await waitFor(`${sel('drill')}.open === true`, 'drill dialog');
  await assertCheck('drill card renders English by default', async () => {
    assert.equal(await evaluate(`${sel('drill-content')}.lang`), 'en');
    assert.equal(await evaluate(`document.querySelector('#drill-content h2').textContent`), 'School earthquake drill');
    assert.ok(!(await evaluate(`${sel('drill-content')}.textContent`)).includes('Simulacro'));
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sid);
  await sleep(150);
  await assertCheck('print CSS suppresses toolbar and page, keeps card', async () => {
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('drill-toolbar')).display`), 'none');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('main')).display`), 'none');
    assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('drill')).display`), 'none');
  });
  const pdf1 = await cdp.send('Page.printToPDF', { paperWidth: 8.5, paperHeight: 11, displayHeaderFooter: false, printBackground: true }, sid, 30000);
  await assertCheck('English drill card prints on exactly one page', async () => {
    const pdf = Buffer.from(pdf1.data, 'base64').toString('latin1');
    const pages = (pdf.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.equal(pages, 1, `${pages} page objects`);
    assert.match(pdf, /\/Type\s*\/Font\b/, 'printed PDF must contain text');
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: '' }, sid);
  await click('#lang-es');
  await assertCheck('Spanish drill card renders fully', async () => {
    assert.equal(await evaluate(`${sel('drill-content')}.lang`), 'es');
    assert.equal(await evaluate(`document.querySelector('#drill-content h2').textContent`), 'Simulacro escolar de terremoto');
    const body = await evaluate(`${sel('drill-content')}.textContent`);
    assert.ok(body.includes('USGS'), 'authority missing USGS');
    assert.ok(body.includes('En el simulador'), 'workbench heading missing');
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sid);
  await sleep(150);
  const pdf2 = await cdp.send('Page.printToPDF', { paperWidth: 8.5, paperHeight: 11, displayHeaderFooter: false, printBackground: true }, sid, 30000);
  await assertCheck('Spanish drill card prints on exactly one page', async () => {
    const pdf = Buffer.from(pdf2.data, 'base64').toString('latin1');
    const pages = (pdf.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.equal(pages, 1, `${pages} page objects`);
    assert.match(pdf, /\/Type\s*\/Font\b/, 'printed PDF must contain text');
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: '' }, sid);
  await click('#close-drill');
  // An idle headless page turns hidden and stops producing frames, and Blink
  // dispatches the dialog 'close' event on a rendering-coupled task: force a
  // frame so the queued event fires here (same trick as the playback check).
  await cdp.send('Page.captureScreenshot', { format: 'png' }, sid).catch(() => {});
  await assertCheck('closing the dialog returns focus to its opener', async () => {
    assert.equal(await evaluate(`${sel('drill')}.open`), false);
    assert.equal(await evaluate(`document.activeElement && document.activeElement.id`), 'open-drill');
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sid);
  await waitFor(`document.getElementById('drill-content').childElementCount === 0`, 'drill content cleared on close');
  await assertCheck('a closed dialog prints nothing and the workbench prints', async () => {
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('drill')).display`), 'none');
    assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('main')).display`), 'none');
  });
  await cdp.send('Emulation.setEmulatedMedia', { media: '' }, sid);
  await sleep(150);

  const external = requests.filter(u => u && !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('devtools:'));
  check('desktop: no cross-origin requests', external.length === 0, external.slice(0, 3).join(', '));
  check('desktop: no console errors or exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ============ Mobile pass: 390x844 ============
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false }, sid);
  await navigate(origin);
  await waitFor(`document.querySelectorAll('#presets button').length === 3`, 'mobile render');

  await assertCheck('390x844: exact 390 CSS viewport, no x-overflow', async () => {
    assert.equal(await evaluate(`document.documentElement.clientWidth`), 390);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await assertCheck('map already in the mobile viewport, above the leads', async () => {
    const info = await evaluate(`(() => {
      const m = document.getElementById('map').getBoundingClientRect();
      const s = document.getElementById('sites').getBoundingClientRect();
      return { mTop: m.top, mBottom: m.bottom, sTop: s.top };
    })()`);
    assert.ok(info.mTop < 844 && info.mBottom > 0, 'map not visible at load');
    assert.ok(info.mTop < info.sTop, 'leads precede map');
  });
  await click('#open-drill');
  await waitFor(`${sel('drill')}.open === true`, 'mobile drill dialog');
  await assertCheck('drill toolbar fits the 390 viewport', async () => {
    const d = await rectOf('#drill');
    assert.ok(d.left >= -1 && d.right <= 391, `dialog rect ${Math.round(d.left)}..${Math.round(d.right)}`);
    assert.ok(await evaluate(`document.getElementById('drill-toolbar').scrollWidth <= document.documentElement.clientWidth`));
  });
  await click('#close-drill');
  await click('#presets button[data-preset="urban"]');
  await waitFor(`${text('time-out')}.trim() === '0.00 s'`, 'mobile urban');
  await click('#denser');
  await waitFor(`document.querySelectorAll('#station option').length === 8`, 'mobile denser');
  await assertCheck('mobile: preset and toggle work with real pointer', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('#station option').length`), 8);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await evaluate(`document.querySelector('.station-scroll').focus()`);
  await assertCheck('no x-overflow while station table scroll region focused', async () => {
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await setField('#cx', '-10'); await setField('#cy', '-10');
  await click('#coordinates button[value="station"]');
  await waitFor(`document.getElementById('station-list').textContent.includes('M1')`, 'mobile manual station');
  await assertCheck('no x-overflow after adding a manual station', async () => {
    assert.ok((await evaluate(`document.getElementById('station-list').textContent`)).includes('M1'));
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await assertCheck('390x844: lab chart and comparator render without overflow', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('#retrofit tbody tr').length`), 5);
    assert.ok((await evaluate(`document.querySelectorAll('#lab-chart path').length`)) >= 2);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await setField('#lab-distance', '40');
  await assertCheck('mobile lab control updates the readout without overflow', async () => {
    assert.match(await evaluate(text('lab-readout')), /At 40\.0 km on Rock B/);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });
  await click('#run-selftests');
  await waitFor(`document.getElementById('selftest-status').textContent.includes('of')`, 'mobile self-tests');
  await assertCheck('mobile in-page self-tests all pass', async () => {
    assert.match(await evaluate(text('selftest-status')), /^(\d+) of \1 checks pass/);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
  });

  const badMobile = requests.filter(u => u && !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('devtools:'));
  check('mobile: no cross-origin requests', badMobile.length === 0, badMobile.slice(0, 3).join(', '));
  check('mobile: no console errors or exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
}

try {
  await main();
} catch (err) {
  check('run completed', false, [err.message, ...errors.slice(0, 3)].join(' | '));
} finally {
  await cleanup();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
process.exit(failed.length ? 1 : 0);
