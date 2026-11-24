// Distance-lab UI: the arrivals/attenuation SVG chart, the preparedness
// comparator table, readiness-brief exports, bookmarking and self-checks.
// All values come from seismic-lab.js; this module only draws and wires.

import {
  arrivalAt, blindRadiusKm, compareInterventions, distanceProfile, groundMotion,
  LAB_DMAX, SOIL_CLASSES, warningLead,
} from './seismic-lab.js';
import { briefToCSV, briefToMarkdown, makeBrief, tamperBrief, verifyBrief } from './brief.js';
import { runSelfTests } from './selfcheck.js';

const NS = 'http://www.w3.org/2000/svg';
const PAPER = '#f7f4eb';
const P_WAVE = '#8de1ca';
const S_WAVE = '#f5b47d';
const PLOT = '#142826';
const GRID = 'rgba(247,244,235,0.10)';
const TEXT = 'rgba(247,244,235,0.66)';
const SUBTLE = 'rgba(247,244,235,0.42)';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const $ = id => document.getElementById(id);
const f1 = v => v.toFixed(1);
const f2 = v => v.toFixed(2);
const sec = v => `${f2(v)} s`;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function svgText(parent, str, x, y, { color = TEXT, size = 9, anchor = 'middle', rotate = null } = {}) {
  const t = svgEl('text', {
    x, y, fill: color, 'font-size': size, 'font-family': MONO, 'text-anchor': anchor,
  });
  if (rotate !== null) t.setAttribute('transform', `rotate(${rotate} ${x} ${y})`);
  t.textContent = str;
  parent.append(t);
  return t;
}

function svgLine(parent, x1, y1, x2, y2, attrs = {}) {
  parent.append(svgEl('line', { x1, y1, x2, y2, ...attrs }));
}

function niceCeil(raw, step = 10) {
  return Math.max(step, Math.ceil(raw / step) * step);
}

function drawChart(svg, profile, alertS, blindR, markKm, model) {
  svg.replaceChildren();
  const W = 640;
  const H = 380;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const m = { l: 54, r: 56, t: 20, b: 44 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const rows = profile.rows;
  const dMax = profile.dMax;
  const tSmax = rows.at(-1).tS;
  const tMax = niceCeil(Math.max(tSmax, alertS ?? 0, 20), 10);
  const X = r => m.l + (r / dMax) * pw;
  const Y = t => m.t + ph - (t / tMax) * ph;
  const MMI_MIN = 1;
  const MMI_MAX = 12;
  const Ym = mmi => m.t + ph - ((mmi - MMI_MIN) / (MMI_MAX - MMI_MIN)) * ph;

  svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: PLOT, rx: 8 }));

  // Grid and axes
  svg.append(svgEl('rect', {
    x: m.l, y: m.t, width: pw, height: ph, fill: 'none', stroke: 'rgba(247,244,235,0.28)', 'stroke-width': 1,
  }));
  for (let r = 0; r <= dMax; r += 50) {
    svgLine(svg, X(r), m.t, X(r), m.t + ph, { stroke: GRID, 'stroke-width': 1 });
    svgText(svg, `${r}`, X(r), m.t + ph + 14, { color: SUBTLE });
  }
  const tStep = tMax > 60 ? 20 : 10;
  for (let t = 0; t <= tMax; t += tStep) {
    svgLine(svg, m.l, Y(t), m.l + pw, Y(t), { stroke: GRID, 'stroke-width': 1 });
    svgText(svg, `${t}`, m.l - 8, Y(t), { color: SUBTLE, anchor: 'end' });
  }
  for (let mmi = 2; mmi <= 12; mmi += 2) {
    svgText(svg, `${mmi}`, m.l + pw + 8, Ym(mmi), { color: SUBTLE, anchor: 'start' });
  }
  svgText(svg, 'epicentral distance (km)', m.l + pw / 2, m.t + ph + 32, { color: TEXT, size: 10 });
  svgText(svg, 'seconds since origin', m.l - 40, m.t + ph / 2, { color: TEXT, size: 10, rotate: -90 });
  svgText(svg, 'MMI', m.l + pw + 40, m.t + ph / 2, { color: TEXT, size: 10, rotate: 90 });

  const pathFor = (data, key) => {
    let d = '';
    for (const row of data) {
      const x = X(row.r);
      const y = Y(row[key]);
      d += d ? ` L ${x.toFixed(2)} ${y.toFixed(2)}` : `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return d;
  };

  // Usable-lead window: area between the alert instant and the S curve
  // wherever S has not yet arrived when the alert goes out.
  if (alertS !== null && tSmax > alertS) {
    const first = rows.findIndex(row => row.tS > alertS);
    if (first >= 0) {
      const pts = rows.slice(first).map(row => `${X(row.r).toFixed(2)},${Y(row.tS).toFixed(2)}`);
      const poly = `M ${X(rows[first].r).toFixed(2)} ${Y(alertS).toFixed(2)} L ${pts.join(' L ')}` +
        ` L ${X(dMax).toFixed(2)} ${Y(alertS).toFixed(2)} Z`;
      svg.append(svgEl('path', { d: poly, fill: 'rgba(141,225,202,0.12)', stroke: 'none' }));
      const mid = rows[Math.floor((first + rows.length - 1) / 2)];
      svgText(svg, 'usable lead', X(mid.r), (Y(alertS) + Y(mid.tS)) / 2, { color: P_WAVE, size: 9 });
    }
  }

  // Arrival curves
  svg.append(svgEl('path', { d: pathFor(rows, 'tP'), fill: 'none', stroke: P_WAVE, 'stroke-width': 2 }));
  svg.append(svgEl('path', { d: pathFor(rows, 'tS'), fill: 'none', stroke: S_WAVE, 'stroke-width': 2 }));
  svgText(svg, 'P', X(dMax) - 6, Y(rows.at(-1).tP) - 10, { color: P_WAVE, size: 11 });
  svgText(svg, 'S', X(dMax) - 6, Y(rows.at(-1).tS) + 14, { color: S_WAVE, size: 11 });

  // MMI attenuation on the right axis, dashed so it never reads as an arrival.
  const mmiPath = rows.map((row, i) => `${i ? 'L' : 'M'} ${X(row.r).toFixed(2)} ${Ym(row.mmi).toFixed(2)}`).join(' ');
  svg.append(svgEl('path', { d: mmiPath, fill: 'none', stroke: 'rgba(245,180,125,0.95)', 'stroke-width': 1.6, 'stroke-dasharray': '6 4' }));
  svgText(svg, 'MMI', X(dMax) - 16, Ym(rows.at(-1).mmi) + 14, { color: 'rgba(245,180,125,0.95)', size: 10 });

  // Alert instant and blind span
  if (alertS === null) {
    svgText(svg, 'no alert in this configuration: every distance is unwarned',
      m.l + pw / 2, m.t + 14, { color: S_WAVE, size: 10 });
  } else {
    svgLine(svg, m.l, Y(alertS), m.l + pw, Y(alertS),
      { stroke: P_WAVE, 'stroke-width': 1.4, 'stroke-dasharray': '5 4' });
    svgText(svg, `alert ${f1(alertS)} s`, m.l + 4, Y(alertS) - 7, { color: P_WAVE, size: 9, anchor: 'start' });
    const br = Math.min(blindR ?? 0, dMax);
    if (br > 0) {
      svg.append(svgEl('rect', {
        x: X(0), y: m.t + ph - 7, width: X(br) - X(0), height: 7,
        fill: 'rgba(245,180,125,0.55)',
      }));
      svgText(svg, `blind zone 0 to ${f1(blindR ?? 0)} km`, X(br / 2), m.t + ph - 12, { color: S_WAVE, size: 9 });
    }
  }

  // Distance marker
  const r0 = Math.min(markKm, dMax);
  const gm = groundMotion(profile.magnitude, r0, profile.depthKm, profile.soilId);
  const tP0 = arrivalAt(r0, profile.depthKm, 'P', model);
  const tS0 = arrivalAt(r0, profile.depthKm, 'S', model);
  svgLine(svg, X(r0), m.t, X(r0), m.t + ph, { stroke: 'rgba(247,244,235,0.5)', 'stroke-width': 1 });
  for (const [t, c] of [[tP0, P_WAVE], [tS0, S_WAVE]]) {
    svg.append(svgEl('circle', { cx: X(r0), cy: Y(t), r: 4, fill: 'none', stroke: c, 'stroke-width': 1.6 }));
  }
  svg.append(svgEl('circle', { cx: X(r0), cy: Ym(gm.mmi), r: 4, fill: 'none', stroke: 'rgba(245,180,125,0.95)', 'stroke-width': 1.6 }));
  svgText(svg, `site ${f1(r0)} km`, X(r0), m.t - 6, { color: PAPER, size: 9 });
}

const MODE_LABEL = { passive: 'passive', eew: 'on alert', hybrid: 'hybrid' };

function armedLabel(m) {
  if (m.mode === 'passive') return 'always';
  if (m.mode === 'eew') return m.armedShare === 1 ? 'yes' : 'no';
  return m.armedShare >= 1 ? 'full' : `${Math.round(m.armedShare * 100)}%`;
}

function marginLabel(m) {
  if (m.mode === 'passive') return 'installed';
  if (m.marginS === null) return 'no alert';
  return `${m.marginS >= 0 ? '+' : ''}${f1(m.marginS)} s`;
}

export function initLabUI({ getRun, getPrefs, setPrefs, saveBlob, onBookmark }) {
  const els = {
    soil: $('lab-soil'), distance: $('lab-distance'), readout: $('lab-readout'),
    chart: $('lab-chart'), retrofit: $('retrofit'),
    bookmark: $('bookmark-btn'), briefJson: $('brief-json'), briefCsv: $('brief-csv'),
    briefMd: $('brief-md'), verify: $('brief-verify'), tamper: $('brief-tamper'),
    selftests: $('run-selftests'), digest: $('brief-digest'), briefStatus: $('brief-status'),
    selftestStatus: $('selftest-status'), selftestList: $('selftest-list'),
  };
  let lastBrief = null;

  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

  function labInputs() {
    return { distanceKm: getPrefs().distanceKm, soilId: getPrefs().soilId };
  }

  function invalidateBrief() {
    lastBrief = null;
    setText(els.digest, '');
    setText(els.briefStatus, '');
  }

  function render() {
    const run = getRun();
    if (!run) return;
    invalidateBrief();
    const { distanceKm, soilId } = getPrefs();
    if (els.soil.value !== soilId) els.soil.value = soilId;
    if (Number(els.distance.value) !== distanceKm) els.distance.value = String(distanceKm);
    const alertS = run.alert === null ? null : run.alert - (run.source.t0 ?? 0);
    const profile = distanceProfile({
      magnitude: run.source.magnitude, depthKm: run.source.z, alertS, soilId,
      model: run.model, dMax: LAB_DMAX, points: 126,
    });
    const blindR = blindRadiusKm(alertS, run.source.z, run.model);
    drawChart(els.chart, profile, alertS, blindR, distanceKm, run.model);

    const gm = groundMotion(run.source.magnitude, distanceKm, run.source.z, soilId);
    const { s, lead } = warningLead(distanceKm, run.source.z, alertS, run.model);
    const tP = arrivalAt(distanceKm, run.source.z, 'P', run.model);
    setText(els.readout,
      `At ${f1(distanceKm)} km on ${gm.soil.name} (factor ${gm.soil.factor}): ` +
      `P ${sec(tP)}, S ${sec(s)}, ` +
      `${alertS === null ? 'no alert' : `usable lead ${sec(lead)}`}, ` +
      `MMI ${f1(gm.mmi)} (rock ${f1(gm.mmiRock)}), PGA ${gm.pgaG.toFixed(3)} g. ` +
      `Blind radius ${blindR === null ? 'n/a' : `${f1(blindR)} km`}.`);

    const tbody = els.retrofit.querySelector('tbody');
    tbody.replaceChildren();
    for (const m of compareInterventions({ lead, mmi: gm.mmi })) {
      const tr = node('tr');
      tr.append(node('td', null, m.name));
      tr.append(node('td', null, MODE_LABEL[m.mode]));
      const armed = node('td', null, armedLabel(m));
      if (m.mode !== 'passive' && m.armedShare === 0) armed.className = 'armed-no';
      tr.append(armed);
      const margin = node('td', 'num', marginLabel(m));
      if (m.marginS !== null && m.marginS < 0) margin.className = 'num margin-neg';
      tr.append(margin);
      tr.append(node('td', 'num', `${f1(m.damageReductionPct)}%`));
      tr.append(node('td', 'num', `${f1(m.casualtyReductionPct)}%`));
      tr.append(node('td', 'num', `$${Math.round(m.costUsd).toLocaleString('en-US')}`));
      tr.append(node('td', 'num', `${m.per100k.toFixed(2)}`));
      tbody.append(tr);
    }
  }

  function brief() {
    const run = getRun();
    lastBrief = makeBrief(run, labInputs());
    setText(els.digest, `SHA-256 ${lastBrief.sha256}`);
    return lastBrief;
  }

  function download(kind) {
    const run = getRun();
    const b = brief();
    const base = `quakesense-${run.presetId}-brief`;
    if (kind === 'json') {
      saveBlob(`${base}.json`, new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
      setText(els.briefStatus, `Saved ${base}.json: payload plus unkeyed tamper-detection digest.`);
    } else if (kind === 'csv') {
      saveBlob(`${base}.csv`, new Blob([briefToCSV(b.payload)], { type: 'text/csv' }));
      setText(els.briefStatus, `Saved ${base}.csv: lab readout, sites and comparator rows.`);
    } else {
      saveBlob(`${base}.md`, new Blob([briefToMarkdown(b.payload)], { type: 'text/markdown' }));
      setText(els.briefStatus, `Saved ${base}.md: formatted readiness brief.`);
    }
  }

  function wire() {
    els.soil.addEventListener('change', () => {
      setPrefs({ ...getPrefs(), soilId: els.soil.value });
      render();
    });
    els.distance.addEventListener('change', () => {
      if (!els.distance.checkValidity()) { els.distance.reportValidity(); return; }
      setPrefs({ ...getPrefs(), distanceKm: els.distance.valueAsNumber });
      render();
    });
    els.bookmark.addEventListener('click', () => {
      setText(els.briefStatus, onBookmark());
    });
    els.briefJson.addEventListener('click', () => download('json'));
    els.briefCsv.addEventListener('click', () => download('csv'));
    els.briefMd.addEventListener('click', () => download('md'));
    els.verify.addEventListener('click', () => {
      const b = lastBrief ?? brief();
      setText(els.briefStatus, verifyBrief(b)
        ? 'Integrity verified: the recomputed digest matches the recorded one.'
        : 'Integrity check failed: the digest does not match this payload.');
    });
    els.tamper.addEventListener('click', () => {
      const b = lastBrief ?? brief();
      const t = tamperBrief(b);
      setText(els.briefStatus, t.detected
        ? `Tamper demo: ${t.changedField} changes the digest to ${t.tamperedSha256.slice(0, 16)}..., ` +
          `which does not match the recorded ${b.sha256.slice(0, 16)}.... Detection works.`
        : 'Tamper demo failed: an edit did not change the digest.');
    });
    els.selftests.addEventListener('click', () => {
      const results = runSelfTests();
      els.selftestList.replaceChildren();
      for (const r of results) {
        const li = node('li', r.ok ? 'st-pass' : 'st-fail');
        li.append(node('span', `tag ${r.ok ? 'st-pass-tag' : 'st-fail-tag'}`, r.ok ? 'pass' : 'fail'));
        li.append(node('span', 'st-name', r.name));
        if (!r.ok) li.append(node('span', 'st-detail', r.detail));
        els.selftestList.append(li);
      }
      const passed = results.filter(r => r.ok).length;
      setText(els.selftestStatus, `${passed} of ${results.length} checks pass. ` +
        'They prove P precedes S, lead monotonicity, blind-zone exactness, soil ordering, ' +
        'CSV escaping, tamper detection and FIPS 180-4 known answers in this browser.');
    });
  }

  for (const s of SOIL_CLASSES) {
    const opt = node('option', null, `${s.name} (x${s.factor})`);
    opt.value = s.id;
    els.soil.append(opt);
  }
  wire();
  return { render, brief, get lastBrief() { return lastBrief; } };
}
