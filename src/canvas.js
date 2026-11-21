// Canvas drawing for the QuakeSense workbench: the geophysical map and the
// three component seismogram view. All coordinates passed in and out of
// project/unproject are CSS pixels relative to the canvas top-left corner.

import { waveRadius, intensityRadius } from './seismology.js';

const TAU = Math.PI * 2;
const PLOT = '#142826';
const PAPER = '#f7f4eb';
const P_WAVE = '#8de1ca';
const S_WAVE = '#f5b47d';
const GRID = 'rgba(247,244,235,0.10)';
const FAINT = 'rgba(247,244,235,0.055)';
const TEXT = 'rgba(247,244,235,0.66)';
const SUBTLE = 'rgba(247,244,235,0.42)';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const contourCache = new Map();

function dpr() {
  return Math.min(2, globalThis.devicePixelRatio || 1);
}

function contextFor(canvas) {
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 400;
  const d = dpr();
  const pw = Math.round(w * d);
  const ph = Math.round(h * d);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w, h };
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

function label(ctx, text, x, y, color = TEXT, align = 'center', size = 10) {
  ctx.fillStyle = color;
  ctx.font = `${size}px ${MONO}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function contoursFor(key, bounds) {
  if (!contourCache.has(key)) {
    const cx = (bounds.xMin + bounds.xMax) / 2;
    const cy = (bounds.yMin + bounds.yMax) / 2;
    const span = Math.max(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin);
    const rings = [];
    for (let i = 0; i < 4; i++) {
      const base = span * (0.16 + i * 0.14);
      const phase = i * 1.7;
      const pts = [];
      for (let a = 0; a <= 64; a++) {
        const t = (a / 64) * TAU;
        const r = base * (1 + 0.13 * Math.sin(3 * t + phase) + 0.06 * Math.sin(7 * t + phase * 2));
        pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
      }
      rings.push(pts);
    }
    contourCache.set(key, rings);
  }
  return contourCache.get(key);
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

export function drawMap(canvas, run, time, solution, selected) {
  const { ctx, w, h } = contextFor(canvas);
  const selId = typeof selected === 'string' ? selected : selected?.stationId ?? null;
  const b = run.bounds;
  const spanX = b.xMax - b.xMin;
  const spanY = b.yMax - b.yMin;

  ctx.fillStyle = PLOT;
  ctx.fillRect(0, 0, w, h);

  // Uniform km/px with letterboxing inside a framed plotting area.
  const m = { l: 48, r: 18, t: 18, b: 36 };
  const availW = w - m.l - m.r;
  const availH = h - m.t - m.b;
  const k = Math.min(availW / spanX, availH / spanY);
  const ox = m.l + (availW - k * spanX) / 2;
  const oy = m.t + (availH - k * spanY) / 2;
  const project = (x, y) => ({ x: ox + (x - b.xMin) * k, y: oy + (b.yMax - y) * k });
  const unproject = (cx, cy) => ({ x: b.xMin + (cx - ox) / k, y: b.yMax - (cy - oy) / k });
  const mw = k * spanX;
  const mh = k * spanY;

  // Plotting frame
  ctx.strokeStyle = 'rgba(247,244,235,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 0.5, oy - 0.5, mw + 1, mh + 1);

  // Grid with edge labels
  const step = niceStep(spanX / 6);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.ceil(b.xMin / step) * step; gx <= b.xMax; gx += step) {
    const px = project(gx, b.yMin).x;
    ctx.moveTo(px, oy);
    ctx.lineTo(px, oy + mh);
  }
  for (let gy = Math.ceil(b.yMin / step) * step; gy <= b.yMax; gy += step) {
    const py = project(b.xMin, gy).y;
    ctx.moveTo(ox, py);
    ctx.lineTo(ox + mw, py);
  }
  ctx.stroke();
  for (let gx = Math.ceil(b.xMin / step) * step; gx <= b.xMax; gx += step) {
    const px = project(gx, b.yMin).x;
    label(ctx, `${Math.round(gx)}`, px, oy + mh + 12, SUBTLE);
  }
  for (let gy = Math.ceil(b.yMin / step) * step; gy <= b.yMax; gy += step) {
    const py = project(b.xMin, gy).y;
    label(ctx, `${Math.round(gy)}`, ox - 10, py, SUBTLE, 'right');
  }
  label(ctx, 'km', ox + mw / 2, oy + mh + 24, SUBTLE);

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, mw, mh);
  ctx.clip();

  // Faint abstract survey contours and modeled isoseismal rings.
  ctx.strokeStyle = FAINT;
  ctx.lineWidth = 1;
  for (const ring of contoursFor(run.presetId, b)) {
    ctx.beginPath();
    ring.forEach(([x, y], i) => {
      const p = project(x, y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  const epi = project(run.source.x, run.source.y);
  ctx.setLineDash([3, 5]);
  for (const level of [6, 4]) {
    const r = intensityRadius(run.source.magnitude, run.source.z, level);
    if (r === null) continue;
    circle(ctx, epi.x, epi.y, r * k);
    ctx.strokeStyle = 'rgba(247,244,235,0.14)';
    ctx.stroke();
    const top = project(run.source.x, run.source.y + r);
    label(ctx, `MMI ${level === 6 ? 'VI' : 'IV'}`, top.x + 4, top.y + 8, SUBTLE, 'left', 9);
  }
  ctx.setLineDash([]);

  // Simulated wavefronts at the current exercise time.
  const elapsed = time - run.source.t0;
  const rP = waveRadius(elapsed, run.source.z, 'P', run.model);
  const rS = waveRadius(elapsed, run.source.z, 'S', run.model);
  if (rP !== null && rP > 0) {
    circle(ctx, epi.x, epi.y, rP * k);
    ctx.fillStyle = 'rgba(141,225,202,0.10)';
    ctx.fill();
    ctx.strokeStyle = P_WAVE;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    label(ctx, 'P', epi.x + rP * k * 0.72, epi.y - rP * k * 0.72, P_WAVE, 'center', 11);
  }
  if (rS !== null && rS > 0) {
    circle(ctx, epi.x, epi.y, rS * k);
    ctx.fillStyle = 'rgba(245,180,125,0.10)';
    ctx.fill();
    ctx.strokeStyle = S_WAVE;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    label(ctx, 'S', epi.x + rS * k * 0.72, epi.y - rS * k * 0.72, S_WAVE, 'center', 11);
  }

  // Hatched blind footprint: the area the S front has already passed when
  // the alert goes out. Only exists once an alert is modeled.
  if (run.alert !== null && run.blind && run.blind.radius > 0) {
    const r = run.blind.radius * k;
    ctx.save();
    circle(ctx, epi.x, epi.y, r);
    ctx.clip();
    ctx.strokeStyle = 'rgba(245,180,125,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -3 * r; d <= 3 * r; d += 7) {
      ctx.moveTo(epi.x - 2 * r, epi.y - 2 * r + d);
      ctx.lineTo(epi.x + 2 * r, epi.y + 2 * r + d);
    }
    ctx.stroke();
    ctx.restore();
    circle(ctx, epi.x, epi.y, r);
    ctx.strokeStyle = S_WAVE;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, 'blind zone', epi.x, epi.y - r - 8, S_WAVE, 'center', 9);
  }

  // Arrival links from the source to stations and target sites.
  ctx.strokeStyle = 'rgba(247,244,235,0.10)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  for (const st of run.stations) {
    const p = project(st.x, st.y);
    ctx.moveTo(epi.x, epi.y);
    ctx.lineTo(p.x, p.y);
  }
  for (const s of run.sites) {
    const p = project(s.x, s.y);
    ctx.moveTo(epi.x, epi.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Stations: triangles, filled once the picker has triggered.
  for (const st of run.stations) {
    const p = project(st.x, st.y);
    const live = st.detected !== null && st.detected <= time;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 6);
    ctx.lineTo(p.x + 5.4, p.y + 4.6);
    ctx.lineTo(p.x - 5.4, p.y + 4.6);
    ctx.closePath();
    ctx.fillStyle = live ? P_WAVE : 'rgba(247,244,235,0.16)';
    ctx.fill();
    ctx.strokeStyle = live ? P_WAVE : 'rgba(247,244,235,0.75)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    if (st.added) {
      circle(ctx, p.x, p.y - 0.5, 9.5);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(245,180,125,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (st.id === selId) {
      circle(ctx, p.x, p.y - 0.5, 12);
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    label(ctx, st.id, p.x, p.y - 13, live ? P_WAVE : TEXT, 'center', 9);
    if (live) label(ctx, `${st.detected.toFixed(1)}s`, p.x, p.y + 12, P_WAVE, 'center', 8);
  }

  // Target sites: squares whose fill shows warning state over time.
  for (const s of run.sites) {
    const p = project(s.x, s.y);
    const warned = run.alert !== null && time >= run.alert && s.lead !== null && s.lead > 0;
    const missed = run.alert !== null && time >= run.alert && (s.lead === null || s.lead === 0);
    ctx.fillStyle = warned ? 'rgba(141,225,202,0.85)' : missed ? 'rgba(245,180,125,0.5)' : 'rgba(247,244,235,0.14)';
    ctx.strokeStyle = warned ? P_WAVE : S_WAVE;
    ctx.lineWidth = 1.4;
    ctx.fillRect(p.x - 4.5, p.y - 4.5, 9, 9);
    ctx.strokeRect(p.x - 4.5, p.y - 4.5, 9, 9);
    label(ctx, s.name, p.x, p.y + 13, TEXT, 'center', 9);
  }

  // True synthetic epicenter: ringed cross.
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 1.8;
  circle(ctx, epi.x, epi.y, 5.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(epi.x - 10, epi.y);
  ctx.lineTo(epi.x + 10, epi.y);
  ctx.moveTo(epi.x, epi.y - 10);
  ctx.lineTo(epi.x, epi.y + 10);
  ctx.stroke();
  label(ctx, 'true source', epi.x + 12, epi.y - 11, PAPER, 'left', 9);

  // Located estimate and 95 percent confidence ellipse when resolved.
  if (solution && solution.ok) {
    const q = project(solution.source.x, solution.source.y);
    if (solution.ellipse && solution.ellipse.major > 0 && solution.ellipse.minor > 0) {
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, solution.ellipse.major * k,
        solution.ellipse.minor * k, -solution.ellipse.rotation, 0, TAU);
      ctx.strokeStyle = 'rgba(141,225,202,0.65)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = P_WAVE;
    ctx.lineWidth = 1.6;
    circle(ctx, q.x, q.y, 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(q.x - 7, q.y);
    ctx.lineTo(q.x + 7, q.y);
    ctx.moveTo(q.x, q.y - 7);
    ctx.lineTo(q.x, q.y + 7);
    ctx.stroke();
    label(ctx, 'est', q.x + 10, q.y + 10, P_WAVE, 'left', 9);
  }
  ctx.restore();

  // Scale bar
  const barKm = niceStep((90 / k));
  const barPx = barKm * k;
  const bx = ox + 10;
  const by = oy + mh - 12;
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + barPx, by);
  ctx.moveTo(bx, by - 4);
  ctx.lineTo(bx, by + 4);
  ctx.moveTo(bx + barPx, by - 4);
  ctx.lineTo(bx + barPx, by + 4);
  ctx.stroke();
  label(ctx, `${Math.round(barKm)} km`, bx + barPx / 2, by - 10, TEXT, 'center', 9);

  // Legend. Under 450 px the HTML legend below the canvas takes over so the
  // in-plot box never obscures stations, sites or labels.
  if (w >= 450) {
    const items = [
      ['P front', P_WAVE, 'line'],
      ['S front', S_WAVE, 'line'],
      ['station', TEXT, 'tri'],
      ['site', S_WAVE, 'sq'],
      ['source', PAPER, 'cross'],
    ];
    if (run.alert !== null) items.splice(2, 0, ['blind', S_WAVE, 'hatch']);
    if (solution && solution.ok) items.push(['estimate', P_WAVE, 'ring']);
    ctx.font = `9px ${MONO}`;
    const lw = Math.max(...items.map(i => ctx.measureText(i[0]).width)) + 30;
    const lh = items.length * 14 + 12;
    const lx = ox + mw - lw - 8;
    const ly = oy + 8;
    ctx.fillStyle = 'rgba(20,40,38,0.88)';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.strokeStyle = 'rgba(247,244,235,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx, ly, lw, lh);
    items.forEach((item, i) => {
      const y = ly + 13 + i * 14;
      const x = lx + 10;
      ctx.strokeStyle = item[1];
      ctx.fillStyle = item[1];
      ctx.lineWidth = 1.4;
      if (item[2] === 'line') {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14, y); ctx.stroke();
      } else if (item[2] === 'tri') {
        ctx.beginPath(); ctx.moveTo(x + 7, y - 4); ctx.lineTo(x + 12, y + 4); ctx.lineTo(x + 2, y + 4); ctx.closePath(); ctx.stroke();
      } else if (item[2] === 'sq') {
        ctx.strokeRect(x + 2.5, y - 4, 9, 9);
      } else if (item[2] === 'cross') {
        ctx.beginPath(); ctx.moveTo(x + 1, y); ctx.lineTo(x + 13, y); ctx.moveTo(x + 7, y - 5); ctx.lineTo(x + 7, y + 5); ctx.stroke();
      } else if (item[2] === 'ring') {
        circle(ctx, x + 7, y, 4.5); ctx.stroke();
      } else if (item[2] === 'hatch') {
        ctx.beginPath();
        for (let d = -6; d <= 6; d += 4) { ctx.moveTo(x + d, y - 5); ctx.lineTo(x + d + 10, y + 5); }
        ctx.stroke();
      }
      label(ctx, item[0], x + 20, y, TEXT, 'left', 9);
    });
  }

  return { project, unproject };
}

// Extrema-per-pixel-column trace stroke: one path, no per-sample cost.
function strokeSeries(ctx, data, n, x0, x1, mid, scale) {
  const cols = Math.max(1, Math.round(x1 - x0));
  ctx.beginPath();
  let started = false;
  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor((c * n) / cols);
    const i1 = Math.max(i0 + 1, Math.floor(((c + 1) * n) / cols));
    let lo = data[i0];
    let hi = data[i0];
    for (let i = i0 + 1; i < i1 && i < n; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const x = x0 + c;
    const yLo = mid - hi * scale;
    const yHi = mid - lo * scale;
    if (!started) { ctx.moveTo(x, yLo); started = true; }
    ctx.lineTo(x, yLo);
    ctx.lineTo(x, yHi);
  }
  ctx.stroke();
}

function vmark(ctx, x, top, bottom, color, dash, width = 1.2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawTraces(canvas, station, time, picker) {
  const { ctx, w, h } = contextFor(canvas);
  ctx.fillStyle = PLOT;
  ctx.fillRect(0, 0, w, h);
  if (!station || !station.trace) {
    label(ctx, 'no station selected', w / 2, h / 2, TEXT);
    return;
  }
  const { trace } = station;
  const n = trace.length;
  const t0 = trace.start;
  const t1 = trace.start + (n - 1) / trace.rate;

  const pad = { l: 44, r: 14, t: 14, b: 26 };
  const gap = 9;
  const laneH = (h - pad.t - pad.b - 3 * gap) / 4;
  const x0 = pad.l;
  const x1 = w - pad.r;
  const tx = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  const lanes = [
    { name: 'Z', data: trace.components[0], color: P_WAVE },
    { name: 'N', data: trace.components[1], color: S_WAVE },
    { name: 'E', data: trace.components[2], color: 'rgba(247,244,235,0.8)' },
  ];

  lanes.forEach((lane, i) => {
    const top = pad.t + i * (laneH + gap);
    const mid = top + laneH / 2;
    let amp = 1e-9;
    const d = lane.data;
    for (let j = 0; j < n; j += 4) { const a = Math.abs(d[j]); if (a > amp) amp = a; }
    ctx.strokeStyle = 'rgba(247,244,235,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x1, mid); ctx.stroke();
    ctx.strokeStyle = lane.color;
    ctx.lineWidth = 1.1;
    strokeSeries(ctx, d, n, x0, x1, mid, (laneH * 0.44) / amp);
    label(ctx, lane.name, pad.l - 14, mid, TEXT, 'center', 10);
  });

  // STA/LTA ratio lane with the trigger threshold.
  const rTop = pad.t + 3 * (laneH + gap);
  const rBot = rTop + laneH;
  const cap = Math.max(8, picker.triggerRatio * 2.2);
  ctx.strokeStyle = 'rgba(247,244,235,0.09)';
  ctx.strokeRect(x0, rTop, x1 - x0, laneH);
  if (station.ratios && station.ratios.length) {
    const rr = station.ratios;
    const rn = rr.length;
    const cols = Math.max(1, Math.round(x1 - x0));
    ctx.strokeStyle = 'rgba(169,201,187,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((c * rn) / cols);
      const i1 = Math.max(i0 + 1, Math.floor(((c + 1) * rn) / cols));
      let mx = 0;
      for (let i = i0; i < i1 && i < rn; i++) { const v = Math.min(rr[i], cap); if (v > mx) mx = v; }
      const x = x0 + c;
      const y = rBot - (mx / cap) * laneH;
      if (!started) { ctx.moveTo(x, rBot); started = true; }
      ctx.lineTo(x, y);
      ctx.lineTo(x, rBot);
    }
    ctx.stroke();
  }
  const ty = rBot - (picker.triggerRatio / cap) * laneH;
  ctx.strokeStyle = 'rgba(245,180,125,0.7)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
  ctx.setLineDash([]);
  label(ctx, `x${picker.triggerRatio}`, x1 + 2, ty, S_WAVE, 'right', 8);
  label(ctx, 'STA/LTA', pad.l - 6, rTop + laneH / 2, TEXT, 'right', 8);

  // Dim samples ahead of the playhead so the future reads as context.
  if (time >= t0 && time < t1) {
    ctx.fillStyle = 'rgba(20,40,38,0.59)';
    ctx.fillRect(tx(time), pad.t, x1 - tx(time), rBot - pad.t);
  }

  // Reference arrivals stay dashed and labeled along the top. Candidate and
  // confirmed marks appear only once the trigger time is reached.
  const top = pad.t;
  const bottom = rBot;
  for (const [t, color, name] of [[station.p, P_WAVE, 'P ref'], [station.s, S_WAVE, 'S ref']]) {
    if (t === null || t === undefined || t < t0 || t > t1) continue;
    const x = tx(t);
    vmark(ctx, x, top, bottom, color, [5, 4], 1.1);
    label(ctx, name, x, top - 5, color, 'center', 8);
  }
  if (station.detected !== null && station.detected !== undefined && station.detected <= time) {
    if (station.pick !== null && station.pick !== undefined && station.pick >= t0 && station.pick <= t1) {
      vmark(ctx, tx(station.pick), top, bottom, PAPER, [], 1);
    }
    if (station.detected >= t0 && station.detected <= t1) {
      const x = tx(station.detected);
      vmark(ctx, x, top, bottom, 'rgba(141,225,202,0.95)', [], 1);
      label(ctx, 'trigger', x + 4, pad.t + 2 * (laneH + gap) + laneH - 7, 'rgba(141,225,202,0.95)', 'left', 8);
    }
  }
  if (time >= t0 && time <= t1) {
    const x = tx(time);
    vmark(ctx, x, top - 2, bottom + 4, 'rgba(247,244,235,0.9)', [], 1.4);
    ctx.fillStyle = PAPER;
    ctx.beginPath();
    ctx.moveTo(x - 4, top - 4);
    ctx.lineTo(x + 4, top - 4);
    ctx.lineTo(x, top + 1);
    ctx.closePath();
    ctx.fill();
  }

  // Time axis
  const axY = h - pad.b + 8;
  ctx.strokeStyle = 'rgba(247,244,235,0.2)';
  ctx.beginPath(); ctx.moveTo(x0, h - pad.b); ctx.lineTo(x1, h - pad.b); ctx.stroke();
  const step = niceStep((t1 - t0) / 6);
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = tx(t);
    ctx.strokeStyle = 'rgba(247,244,235,0.25)';
    ctx.beginPath(); ctx.moveTo(x, h - pad.b); ctx.lineTo(x, h - pad.b + 4); ctx.stroke();
    label(ctx, `${Math.round(t)}`, x, axY, SUBTLE, 'center', 9);
  }
  label(ctx, 'seconds', x1, axY, SUBTLE, 'right', 9);
}
