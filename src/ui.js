// QuakeSense workbench controller. All scenario math comes from the model
// modules; this file only wires DOM controls to simulate/solveAt output.

import { PRESETS, simulate, solveAt, compareRuns } from './model.js';
import { waveRadius, intensityRadius } from './seismology.js';
import { PICKER, pickerSweep } from './picker.js';
import { toGeoJSON, toCSV, makeAudit, DRILL } from './exports.js';
import { drawMap, drawTraces } from './canvas.js';

const T_MAX = 45;
const T_SNAPSHOT = 16.5;
const MAX_STATIONS = 18;
const DUP_KM = 0.25;
const KIND_LABEL = { school: 'School', hospital: 'Hospital', bridge: 'Bridge' };

const $ = (id) => document.getElementById(id);
const els = {
  presets: $('presets'),
  map: $('map'), mapStatus: $('map-status'), modeStatus: $('mode-status'),
  play: $('play'), playLabel: $('play-label'), playIcon: $('play-icon'),
  resetTime: $('reset-time'), time: $('time'), timeOut: $('time-out'),
  sites: $('sites'), alert: $('alert'), blind: $('blind'),
  denser: $('denser'), faster: $('faster'), delta: $('delta'),
  station: $('station'), traces: $('traces'), traceValues: $('trace-values'),
  velocity: $('velocity'), latency: $('latency'), triggerCount: $('trigger-count'),
  snr: $('snr'), depth: $('depth'), shortcuts: $('shortcuts'),
  coordinates: $('coordinates'), cx: $('cx'), cy: $('cy'), coordStatus: $('coord-status'),
  truth: $('truth'), estimate: $('estimate'), geom: $('geom'), wadati: $('wadati'),
  isoseismal: $('isoseismal'), stationList: $('station-list'),
  sweep: $('sweep'),
  geo: $('geo'), csv: $('csv'), audit: $('audit'), exportStatus: $('export-status'),
  inspectMap: $('inspect-map'), epicenterMode: $('epicenter-mode'), stationMode: $('station-mode'),
  drill: $('drill'), openDrill: $('open-drill'), closeDrill: $('close-drill'),
  printDrill: $('print-drill'), langEn: $('lang-en'), langEs: $('lang-es'),
  drillContent: $('drill-content'),
};

const state = {
  preset: null,
  time: 0,
  playing: false,
  denser: false,
  faster: false,
  velocity: 'uniform',
  latency: null,
  triggerCount: null,
  snr: 10,
  epicenter: null,
  depth: null,
  manual: [],
  manualSeq: 0,
  mode: 'inspect',
  selectedStationId: null,
  run: null,
  baseline: null,
  mapProj: null,
  drillLang: 'en',
  siteNow: new Map(),
};

let raf = 0;
let lastTs = 0;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setText(el, s) {
  if (el && el.textContent !== s) el.textContent = s;
}

function setStatus(s) { setText(els.mapStatus, s); }

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const sec = (v) => `${f2(v)} s`;

function currentSettings() {
  const p = state.preset;
  const source = { ...p.source };
  if (state.epicenter) { source.x = state.epicenter.x; source.y = state.epicenter.y; }
  if (state.depth !== null) source.z = state.depth;
  return {
    source,
    stations: [...p.stations.map((s) => ({ ...s })), ...state.manual.map((s) => ({ ...s }))],
    denser: state.denser,
    faster: state.faster,
    velocity: state.velocity,
    triggerCount: state.triggerCount ?? p.triggerCount,
    latency: state.latency ?? p.latency,
    snr: state.snr,
    picker: PICKER,
  };
}

function selectedStation() {
  return state.run?.stations.find((s) => s.id === state.selectedStationId) ?? state.run?.stations[0] ?? null;
}

function solution() {
  try { return solveAt(state.run, state.time); } catch { return null; }
}

function rebuild() {
  try {
    const settings = currentSettings();
    state.run = simulate(state.preset, settings);
    state.baseline = (state.denser || state.faster)
      ? simulate(state.preset, { ...settings, denser: false, faster: false })
      : null;
  } catch (err) {
    setStatus(`Scenario could not run with those settings: ${err.message}`);
    return false;
  }
  if (!state.run.stations.some((s) => s.id === state.selectedStationId)) {
    state.selectedStationId = state.run.stations[0]?.id ?? null;
  }
  renderSites();
  renderStationSelect();
  renderStationTable();
  renderNetwork();
  renderDelta();
  renderTraceValues();
  updateDynamic();
  return true;
}

// Rendering

function buildPresetNav() {
  els.presets.replaceChildren();
  for (const p of PRESETS) {
    const btn = node('button', 'preset-btn');
    btn.type = 'button';
    btn.dataset.preset = p.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.append(node('span', 'preset-name', p.name));
    btn.append(node('span', 'preset-meta', `M ${f1(p.source.magnitude)}, ${p.stations.length} stations`));
    btn.addEventListener('click', () => selectPreset(p.id));
    els.presets.append(btn);
  }
}

function renderSites() {
  els.sites.replaceChildren();
  state.siteNow.clear();
  for (const s of state.run.sites) {
    const card = node('div', 'site-card');
    const top = node('div', 'site-top');
    top.append(node('span', 'site-kind', KIND_LABEL[s.kind] ?? s.kind));
    top.append(node('span', 'site-name', s.name));
    const now = node('span', 'site-now');
    state.siteNow.set(s.id, { el: now, s: s.s });
    top.append(now);
    card.append(top);

    const rows = node('div', 'site-rows');
    const sArrival = node('span');
    sArrival.append(node('b', null, 'S arrival'));
    sArrival.append(node('span', 'val', s.s === null ? 'n/a' : sec(s.s)));
    const lead = node('span');
    lead.append(node('b', null, 'Modeled lead'));
    const leadVal = node('span', 'val');
    if (s.lead === null) { leadVal.textContent = 'No alert'; lead.classList.add('lead-none'); }
    else if (s.lead === 0) { leadVal.textContent = 'No lead'; lead.classList.add('lead-none'); }
    else { leadVal.textContent = sec(s.lead); lead.classList.add('lead-good'); }
    lead.append(leadVal);
    const mmi = node('span');
    mmi.append(node('b', null, 'Illustrative MMI'));
    mmi.append(node('span', 'val', s.mmi === null || s.mmi === undefined ? 'n/a' : f1(s.mmi)));
    rows.append(sArrival, lead, mmi);
    card.append(rows);
    if (s.signed !== null && s.signed < 0) {
      card.append(node('p', 'blind-line',
        `S wave arrives ${f1(-s.signed)} s before the alert can: inside the blind zone.`));
    }
    els.sites.append(card);
  }
}

function renderStationSelect() {
  els.station.replaceChildren();
  for (const st of state.run.stations) {
    const opt = node('option', null, `${st.id}: ${st.name}`);
    opt.value = st.id;
    if (st.id === state.selectedStationId) opt.selected = true;
    els.station.append(opt);
  }
}

function renderStationTable() {
  const tbody = els.stationList.querySelector('tbody');
  tbody.replaceChildren();
  const manualIds = new Set(state.manual.map((s) => s.id));
  for (const st of state.run.stations) {
    const tr = node('tr');
    tr.append(node('td', null, `${st.id}: ${st.name}`));
    tr.append(node('td', 'num', f1(st.x)));
    tr.append(node('td', 'num', f1(st.y)));
    tr.append(node('td', 'num', st.pick === null ? 'none' : f2(st.pick)));
    tr.append(node('td', 'num', st.detected === null ? 'none' : f2(st.detected)));
    tr.append(node('td', 'num', st.pickErrorMs === null || st.pickErrorMs === undefined ? 'n/a' : `${Math.round(st.pickErrorMs)}`));
    const origin = node('td');
    const isManual = manualIds.has(st.id);
    origin.append(node('span', `tag${isManual ? ' manual' : ''}`, isManual ? 'manual' : st.added ? 'added' : 'base'));
    tr.append(origin);
    const action = node('td');
    if (isManual) {
      const rm = node('button', 'row-btn', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove station ${st.name}`);
      rm.addEventListener('click', () => removeManualStation(st.id));
      action.append(rm);
    }
    tr.append(action);
    tbody.append(tr);
  }
}

function renderNetwork() {
  const r = state.run;
  const src = r.source;
  setText(els.truth,
    `Epicenter (${f1(src.x)}, ${f1(src.y)}) km, depth ${f1(src.z)} km, ` +
    `origin ${f2(src.t0)} s, magnitude ${f1(src.magnitude)}. ` +
    `Velocity model: ${r.model?.id ?? state.velocity}.`);
  const g = r.geometry ?? {};
  const ell = g.ellipse;
  setText(els.geom,
    `Azimuthal gap ${g.gap === undefined ? 'n/a' : `${f1(g.gap)} deg`}, ` +
    `GDOP ${g.gdop === null || g.gdop === undefined ? 'unresolved' : f1(g.gdop)}` +
    (ell ? `, 95% ellipse ${f1(ell.major)} x ${f1(ell.minor)} km` : ', no 95% ellipse'));
  setText(els.wadati, r.wadatiT0 === null || r.wadatiT0 === undefined
    ? 'Wadati origin check unavailable for the layered velocity model.'
    : `Wadati origin from reference P and S picks: ${f2(r.wadatiT0)} s.`);
  const rp = waveRadius(T_MAX - src.t0, src.z, 'P', r.model);
  const rs = waveRadius(T_MAX - src.t0, src.z, 'S', r.model);
  const mmi6 = intensityRadius(src.magnitude, src.z, 6);
  setText(els.isoseismal,
    `At ${T_MAX} s the modeled fronts reach P ${rp === null ? 'not yet' : `${f1(rp)} km`}, ` +
    `S ${rs === null ? 'not yet' : `${f1(rs)} km`}. ` +
    `Illustrative MMI VI reach: ${mmi6 === null ? 'inside source depth only' : `${f1(mmi6)} km`}.`);
}

function renderDelta() {
  els.delta.replaceChildren();
  if (!state.denser && !state.faster) {
    els.delta.append(node('p', null,
      'Baseline network shown. Enable a counterfactual to compare warning performance.'));
    return;
  }
  const cmp = compareRuns(state.baseline, state.run);
  if (!cmp || cmp.areaReduced === null || cmp.alertGained === null) {
    els.delta.append(node('p', null,
      'Comparison unavailable: at least one configuration produces no alert.'));
    return;
  }
  const ul = node('ul');
  const li1 = node('li');
  li1.append(node('span', null, 'Blind-zone area reduced: '));
  li1.append(node('span', 'val', `${f1(cmp.areaReduced)} km\u00B2`));
  const li2 = node('li');
  li2.append(node('span', null, 'Alert issued earlier: '));
  li2.append(node('span', 'val', `${f1(cmp.alertGained)} s`));
  ul.append(li1, li2);
  if (Array.isArray(cmp.siteGains) && cmp.siteGains.length) {
    for (const g of cmp.siteGains) {
      const li = node('li');
      const site = state.run.sites.find((s) => s.id === g.id);
      li.append(node('span', null, `${site?.name ?? g.id} lead gain: `));
      li.append(node('span', 'val', g.gained === null ? 'Unavailable' : `${f1(g.gained)} s`));
      ul.append(li);
    }
  }
  els.delta.append(ul);
}

function renderTraceValues() {
  els.traceValues.replaceChildren();
  const st = selectedStation();
  if (!st) return;
  const items = [
    ['Reference P', st.p === null ? 'n/a' : sec(st.p)],
    ['Reference S', st.s === null ? 'n/a' : sec(st.s)],
    ['P candidate', st.pick === null ? 'none' : sec(st.pick)],
    ['Pick error', st.pickErrorMs === null || st.pickErrorMs === undefined ? 'n/a' : `${Math.round(st.pickErrorMs)} ms`],
    ['Triggered', st.detected === null ? 'never' : sec(st.detected)],
    ['Picker', `ratio ${PICKER.triggerRatio} (STA ${PICKER.shortWindow} s, LTA ${PICKER.longWindow} s)`],
  ];
  for (const [k, v] of items) {
    const span = node('span');
    span.append(node('b', null, `${k}: `));
    span.append(node('span', 'val', v));
    els.traceValues.append(span);
  }
  if (st.pick === null) {
    els.traceValues.append(node('p', 'trace-note',
      'The picker made no P pick on this trace at the current signal-to-noise setting.'));
  } else if (st.s !== null && st.pick >= st.s) {
    els.traceValues.append(node('p', 'trace-note',
      'The pick lands after the reference S arrival: a possible phase misidentification by the picker. The detector does not know the reference phases.'));
  } else if (st.detected === null) {
    els.traceValues.append(node('p', 'trace-note',
      'The picker saw the trace but never sustained the trigger ratio.'));
  }
}

function renderSweep() {
  const tbody = els.sweep.querySelector('tbody');
  tbody.replaceChildren();
  for (const row of pickerSweep(undefined, 16, PICKER)) {
    const tr = node('tr');
    tr.append(node('td', null, `${row.snr}`));
    tr.append(node('td', null, `${row.detected}`));
    tr.append(node('td', null, `${row.trials}`));
    tr.append(node('td', null, row.meanMs === null ? 'n/a' : `${Math.round(row.meanMs)}`));
    tbody.append(tr);
  }
}

// Per-frame updates: text only changes when the value actually changes.

function updateDynamic() {
  const r = state.run;
  if (!r) return;
  if (els.time.value !== String(state.time)) els.time.value = state.time;
  setText(els.timeOut, `${f2(state.time)} s`);

  const trig = r.stations.filter((s) => s.detected !== null && s.detected <= state.time).length;
  const need = r.settings.triggerCount;
  const total = r.stations.length;
  if (r.alert === null) {
    setText(els.alert,
      `No alert: the network never reaches ${need} confirmed triggers in this configuration. ` +
      `Triggered so far: ${trig} of ${total} stations.`);
    els.alert.classList.remove('is-live');
  } else if (state.time >= r.alert) {
    setText(els.alert,
      `Alert issued at ${sec(r.alert)} (modeled). ${trig} of ${total} stations triggered.`);
    els.alert.classList.add('is-live');
  } else {
    setText(els.alert,
      `Alert pending: modeled at ${sec(r.alert)}, in ${f1(r.alert - state.time)} s. ` +
      `Triggered ${trig} of ${need} needed (${total} stations).`);
    els.alert.classList.remove('is-live');
  }

  let blindText;
  if (r.alert === null || !r.blind || r.blind.radius === null) {
    blindText = 'Blind zone: not applicable without an alert.';
  } else if (r.blind.radius === 0) {
    blindText = 'No surface blind zone under the current model.';
  } else {
    blindText = `Blind zone: S wave reaches within ${f1(r.blind.radius)} km before the alert (${f1(r.blind.area)} km\u00B2 hatched on the map).`;
  }
  setText(els.blind, blindText);

  for (const [id, rec] of state.siteNow) {
    if (rec.s === null) { setText(rec.el, 'S n/a'); continue; }
    const d = rec.s - state.time;
    setText(rec.el, d > 0 ? `S in ${f1(d)} s` : 'S wave passed');
  }

  const sol = solution();
  if (sol && sol.ok) {
    const s = sol.source;
    setText(els.estimate,
      `Located (${f1(s.x)}, ${f1(s.y)}) km, depth ${f1(s.z)} km, origin ${f2(s.t0)} s, ` +
      `RMS ${Math.round(sol.rms * 1000)} ms, gap ${f1(sol.gap)} deg, ` +
      `GDOP ${sol.gdop === null ? 'unresolved' : f1(sol.gdop)}` +
      (sol.ellipse ? `, 95% ellipse ${f1(sol.ellipse.major)} x ${f1(sol.ellipse.minor)} km` : ''));
  } else {
    setText(els.estimate, `Unresolved at ${f2(state.time)} s${sol?.reason ? `: ${sol.reason}` : '.'}`);
  }

  draw();
}

function draw() {
  const r = state.run;
  if (!r) return;
  state.mapProj = drawMap(els.map, r, state.time, solution(), { stationId: state.selectedStationId });
  drawTraces(els.traces, selectedStation(), state.time, PICKER);
}

// Playback

function syncPlayBtn() {
  setText(els.playLabel, state.playing ? 'Pause' : 'Play');
  els.play.setAttribute('aria-pressed', String(state.playing));
  els.playIcon.setAttribute('viewBox', '0 0 16 16');
  els.playIcon.replaceChildren();
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (state.playing) {
    path.setAttribute('d', 'M4 3h3v10H4zM9 3h3v10H9z');
  } else {
    path.setAttribute('d', 'M4.5 2.5v11l9-5.5z');
  }
  path.setAttribute('fill', 'currentColor');
  els.playIcon.append(path);
}

function tick(ts) {
  if (!state.playing) return;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  state.time = Math.min(T_MAX, state.time + dt);
  if (state.time >= T_MAX) {
    stopPlay();
    setStatus(`Exercise complete at ${sec(T_MAX)}.`);
  }
  updateDynamic();
  if (state.playing) raf = requestAnimationFrame(tick);
}

function startPlay() {
  if (state.time >= T_MAX) setTime(0);
  state.playing = true;
  lastTs = performance.now();
  syncPlayBtn();
  raf = requestAnimationFrame(tick);
  setStatus('Exercise running.');
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(raf);
  syncPlayBtn();
}

function togglePlay() {
  if (state.playing) { stopPlay(); setStatus(`Paused at ${sec(state.time)}.`); }
  else startPlay();
}

function setTime(t) {
  state.time = Math.max(0, Math.min(T_MAX, t));
  updateDynamic();
}

// Map modes and editing

const MODE_TEXT = {
  inspect: 'Inspect mode: click a station marker to load its seismogram.',
  epicenter: 'Move epicenter: click the map to relocate the synthetic source.',
  station: `Add station: click the map to place a temporary station (limit ${MAX_STATIONS} total).`,
};

function setMode(mode) {
  state.mode = mode;
  for (const [el, m] of [[els.inspectMap, 'inspect'], [els.epicenterMode, 'epicenter'], [els.stationMode, 'station']]) {
    el.setAttribute('aria-pressed', String(m === mode));
  }
  setText(els.modeStatus, MODE_TEXT[mode]);
  els.map.classList.toggle('mode-edit', mode !== 'inspect');
}

function tryAddStation(x, y, report) {
  const p = state.preset;
  const planned = p.stations.length + (state.denser ? (p.additions?.length ?? 0) : 0) + state.manual.length;
  if (planned >= MAX_STATIONS) {
    report(`Station limit reached (${MAX_STATIONS}). Remove a manual station first.`);
    return false;
  }
  const clash = state.run.stations.some((s) => Math.hypot(s.x - x, s.y - y) < DUP_KM);
  if (clash) {
    report(`A station already sits within ${DUP_KM} km of that point.`);
    return false;
  }
  state.manualSeq += 1;
  const st = { id: `M${state.manualSeq}`, name: `Manual ${state.manualSeq}`, x, y };
  state.manual.push(st);
  if (rebuild()) {
    state.selectedStationId = st.id;
    renderStationSelect();
    renderStationTable();
    draw();
    report(`Station ${st.id} placed at (${f1(x)}, ${f1(y)}) km.`);
    return true;
  }
  state.manual.pop();
  return false;
}

function removeManualStation(id) {
  const i = state.manual.findIndex((s) => s.id === id);
  if (i === -1) return;
  state.manual.splice(i, 1);
  if (state.selectedStationId === id) state.selectedStationId = null;
  rebuild();
  els.station.focus();
  setStatus(`Station ${id} removed.`);
}

function clampToBounds(x, y) {
  const b = state.run.bounds;
  return {
    x: Math.max(b.xMin, Math.min(b.xMax, x)) || 0,
    y: Math.max(b.yMin, Math.min(b.yMax, y)) || 0,
  };
}

function onMapClick(ev) {
  if (!state.mapProj) return;
  const rect = els.map.getBoundingClientRect();
  const cx = ev.clientX - rect.left;
  const cy = ev.clientY - rect.top;
  if (state.mode === 'inspect') {
    let best = null;
    let bestD = 14;
    for (const st of state.run.stations) {
      const p = state.mapProj.project(st.x, st.y);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) { bestD = d; best = st; }
    }
    if (best) {
      state.selectedStationId = best.id;
      els.station.value = best.id;
      renderStationTable();
      renderTraceValues();
      draw();
      setStatus(`Station ${best.id}: ${best.name}.`);
    }
    return;
  }
  const { x, y } = state.mapProj.unproject(cx, cy);
  const b = state.run.bounds;
  if (x < b.xMin - 1e-7 || x > b.xMax + 1e-7 || y < b.yMin - 1e-7 || y > b.yMax + 1e-7) {
    setStatus('Choose a point inside the plotted frame.');
    return;
  }
  const c = clampToBounds(Number(x.toFixed(1)), Number(y.toFixed(1)));
  if (state.mode === 'epicenter') {
    state.epicenter = { x: c.x, y: c.y };
    els.cx.value = f1(c.x);
    els.cy.value = f1(c.y);
    if (rebuild()) setStatus(`Epicenter moved to (${f1(c.x)}, ${f1(c.y)}) km.`);
  } else if (state.mode === 'station') {
    tryAddStation(c.x, c.y, setStatus);
  }
}

// Preset selection and control sync

function syncControls() {
  const p = state.preset;
  els.denser.checked = state.denser;
  els.faster.checked = state.faster;
  els.velocity.value = state.velocity;
  els.latency.value = state.latency ?? p.latency;
  els.triggerCount.value = state.triggerCount ?? p.triggerCount;
  els.snr.value = state.snr;
  els.depth.value = state.depth ?? p.source.z;
  els.cx.min = p.bounds.xMin;
  els.cx.max = p.bounds.xMax;
  els.cy.min = p.bounds.yMin;
  els.cy.max = p.bounds.yMax;
  els.cx.value = f1(state.epicenter?.x ?? p.source.x);
  els.cy.value = f1(state.epicenter?.y ?? p.source.y);
}

function selectPreset(id) {
  const p = PRESETS.find((q) => q.id === id) ?? PRESETS[0];
  stopPlay();
  state.preset = p;
  state.time = 0;
  state.denser = false;
  state.faster = false;
  state.velocity = 'uniform';
  state.latency = null;
  state.triggerCount = null;
  state.snr = 10;
  state.epicenter = null;
  state.depth = null;
  state.manual = [];
  state.manualSeq = 0;
  state.selectedStationId = null;
  for (const btn of els.presets.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === p.id));
  }
  syncControls();
  setMode('inspect');
  if (rebuild()) setStatus(p.description ?? `${p.name} loaded.`);
}

// Exports

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function wireExports() {
  els.geo.addEventListener('click', () => {
    try {
      const name = `quakesense-${state.run.presetId}.geojson`;
      saveBlob(name, new Blob([JSON.stringify(toGeoJSON(state.run), null, 2)], { type: 'application/geo+json' }));
      setText(els.exportStatus, `Saved ${name}: stations, sites, intensity rings and the alert footprint.`);
    } catch (err) { setText(els.exportStatus, `GeoJSON export failed: ${err.message}`); }
  });
  els.csv.addEventListener('click', () => {
    try {
      const name = `quakesense-${state.run.presetId}.csv`;
      saveBlob(name, new Blob([toCSV(state.run)], { type: 'text/csv' }));
      setText(els.exportStatus, `Saved ${name}: station picks, detections and site leads.`);
    } catch (err) { setText(els.exportStatus, `CSV export failed: ${err.message}`); }
  });
  els.audit.addEventListener('click', async () => {
    try {
      const run = state.run;
      const audit = await makeAudit(run);
      const name = `quakesense-${run.presetId}-audit.json`;
      saveBlob(name, new Blob([JSON.stringify(audit, null, 2)], { type: 'application/json' }));
      setText(els.exportStatus, `Saved ${name}: full reproducibility record.`);
    } catch (err) { setText(els.exportStatus, `Audit export failed: ${err.message}`); }
  });
}

// Drill card dialog

function renderDrill(lang) {
  const data = DRILL[lang] ?? DRILL.en;
  const article = els.drillContent;
  article.lang = lang;
  article.replaceChildren();
  const title = node('h2', null, data.title);
  title.id = 'drill-title';
  article.append(title);
  if (data.subtitle) article.append(node('p', 'drill-sub', data.subtitle));
  const ol = node('ol');
  for (const step of data.steps) {
    const li = node('li');
    li.append(node('strong', null, step.title));
    li.append(document.createTextNode(step.text));
    ol.append(li);
  }
  article.append(ol);
  article.append(node('h3', null, data.physicsTitle));
  article.append(node('p', null, data.physics));
  article.append(node('h3', null, lang === 'es' ? 'En el simulador' : 'In the workbench'));
  article.append(node('p', null, data.exercise));
  article.append(node('p', 'drill-authority', data.authority));
}

function setDrillLang(lang) {
  state.drillLang = lang;
  els.langEn.setAttribute('aria-pressed', String(lang === 'en'));
  els.langEs.setAttribute('aria-pressed', String(lang === 'es'));
  renderDrill(lang);
}

function wireDrill() {
  els.openDrill.addEventListener('click', () => {
    if (state.playing) togglePlay();
    renderDrill(state.drillLang);
    els.drill.showModal();
    els.closeDrill.focus();
  });
  els.closeDrill.addEventListener('click', () => {
    els.drillContent.replaceChildren();
    els.drill.close();
  });
  els.drill.addEventListener('close', () => {
    els.drillContent.replaceChildren();
    els.openDrill.focus();
  });
  els.printDrill.addEventListener('click', () => window.print());
  els.langEn.addEventListener('click', () => setDrillLang('en'));
  els.langEs.addEventListener('click', () => setDrillLang('es'));
}

// Keyboard shortcut: P toggles playback, opt-in via the preference checkbox.

function wireKeys() {
  addEventListener('keydown', (e) => {
    if (e.repeat || e.isComposing) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'p' && e.key !== 'P') return;
    if (!els.shortcuts.checked) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t instanceof Element &&
        t.closest('input, select, textarea, button, a, [contenteditable], [role="textbox"]')) return;
    e.preventDefault();
    togglePlay();
  });
}

// Wiring

function wire() {
  els.play.addEventListener('click', togglePlay);
  els.resetTime.addEventListener('click', () => {
    stopPlay();
    setTime(0);
    setStatus('Simulation time reset to 0.00 s.');
  });
  els.time.addEventListener('input', () => {
    stopPlay();
    setTime(parseFloat(els.time.value));
    setStatus('Timeline scrubbed. Use Play to continue.');
  });
  els.map.addEventListener('click', onMapClick);
  els.inspectMap.addEventListener('click', () => setMode('inspect'));
  els.epicenterMode.addEventListener('click', () => setMode('epicenter'));
  els.stationMode.addEventListener('click', () => setMode('station'));
  els.denser.addEventListener('change', () => {
    if (els.denser.checked &&
        state.preset.stations.length + state.manual.length + (state.preset.additions?.length ?? 0) > MAX_STATIONS) {
      els.denser.checked = false;
      setStatus('Remove a manual station before adding the two comparison stations.');
      return;
    }
    state.denser = els.denser.checked;
    rebuild();
  });
  els.faster.addEventListener('change', () => { state.faster = els.faster.checked; rebuild(); });
  els.velocity.addEventListener('change', () => { state.velocity = els.velocity.value; rebuild(); });
  for (const [field, key] of [[els.latency, 'latency'], [els.triggerCount, 'triggerCount'], [els.snr, 'snr'], [els.depth, 'depth']]) {
    field.addEventListener('change', () => {
      if (!field.checkValidity()) { field.reportValidity(); return; }
      state[key] = field.valueAsNumber;
      rebuild();
    });
  }
  els.coordinates.addEventListener('submit', (e) => {
    e.preventDefault();
    const x = parseFloat(els.cx.value);
    const y = parseFloat(els.cy.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const c = clampToBounds(Number(x.toFixed(1)), Number(y.toFixed(1)));
    const intent = e.submitter?.value;
    if (intent === 'station') {
      tryAddStation(c.x, c.y, (m) => setText(els.coordStatus, m));
    } else {
      state.epicenter = { x: c.x, y: c.y };
      if (rebuild()) setText(els.coordStatus, `Epicenter applied at (${f1(c.x)}, ${f1(c.y)}) km.`);
    }
  });
  els.station.addEventListener('change', () => {
    state.selectedStationId = els.station.value;
    renderStationTable();
    renderTraceValues();
    draw();
  });
  wireExports();
  wireDrill();
  wireKeys();
  const ro = new ResizeObserver(() => draw());
  ro.observe(els.map);
  ro.observe(els.traces);
}

// Boot

buildPresetNav();
renderSweep();
wire();
selectPreset('coastal');
setTime(T_SNAPSHOT);
renderTraceValues();
setStatus(`Paused at ${sec(T_SNAPSHOT)}. Play or scrub to follow the wavefronts.`);
