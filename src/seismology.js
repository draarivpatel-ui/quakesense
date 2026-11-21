export const UNIFORM = Object.freeze({ id: 'uniform', vp: 6, vs: 3.5 });
export const LAYERED = Object.freeze({ id: 'layered', vp: 5.2, vs: 3, interface: 8, lower: UNIFORM });
const TAU = 2 * Math.PI;

function speed(model, phase) {
  if (phase !== 'P' && phase !== 'S') throw new RangeError('Phase must be P or S');
  return phase === 'P' ? model.vp : model.vs;
}

function radialRay(r, z, phase, model) {
  const upper = speed(model, phase);
  const h = model.interface;
  const d = Math.hypot(r, z);
  const direct = { time: d / upper, dr: d ? r / (d * upper) : 0, dz: d ? z / (d * upper) : 0 };
  if (h === undefined) return direct;
  const lower = speed(model.lower, phase);
  const pMax = 1 / lower;
  const q = (v, p) => Math.sqrt(Math.max(0, 1 / (v * v) - p * p));
  if (z <= h) {
    // A faster lower half-space can make a critically refracted head wave arrive first.
    if (lower <= upper) return direct;
    const leg = 2 * h - z;
    const qu = q(upper, pMax);
    const head = r * pMax + leg * qu;
    return r >= leg * pMax / qu && head < direct.time
      ? { time: head, dr: pMax, dz: -qu } : direct;
  }
  let lo = 0;
  let hi = 1 / Math.max(upper, lower);
  for (let i = 0; i < 48 && r > 0; i++) {
    const p = (lo + hi) / 2;
    const offset = p * (h / q(upper, p) + (z - h) / q(lower, p));
    if (offset < r) lo = p;
    else hi = p;
  }
  const p = r ? (lo + hi) / 2 : 0;
  const qu = q(upper, p);
  const ql = q(lower, p);
  return { time: p * r + h * qu + (z - h) * ql, dr: p, dz: ql };
}

export function arrival(source, receiver, phase, model = UNIFORM) {
  if (![source.x, source.y, source.z, receiver.x, receiver.y].every(Number.isFinite) || source.z < 0) {
    throw new RangeError('Coordinates must be finite and depth nonnegative');
  }
  const dx = source.x - receiver.x;
  const dy = source.y - receiver.y;
  const r = Math.hypot(dx, dy);
  const ray = radialRay(r, source.z, phase, model);
  return {
    time: (source.t0 ?? 0) + ray.time,
    jacobian: [r ? ray.dr * dx / r : 0, r ? ray.dr * dy / r : 0, ray.dz, 1],
  };
}

export function waveRadius(elapsed, depth, phase, model = UNIFORM) {
  if (!Number.isFinite(elapsed) || !Number.isFinite(depth) || depth < 0 ||
      elapsed < radialRay(0, depth, phase, model).time) return null;
  if (model.interface === undefined) {
    return Math.sqrt(Math.max(0, (elapsed * speed(model, phase)) ** 2 - depth ** 2));
  }
  let lo = 0;
  let hi = elapsed * Math.max(speed(model, phase), speed(model.lower, phase));
  for (let i = 0; i < 45; i++) {
    const mid = (lo + hi) / 2;
    if (radialRay(mid, depth, phase, model).time < elapsed) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function wadati(pairs, model = UNIFORM) {
  if (!Array.isArray(pairs)) throw new RangeError('Wadati pairs must be an array');
  if (model.interface !== undefined) return null;
  const slope = model.vp / model.vs - 1;
  const origins = pairs.filter(({ p, s }) => Number.isFinite(p) && Number.isFinite(s) && s > p)
    .map(({ p, s }) => p - (s - p) / slope).sort((a, b) => a - b);
  if (!origins.length) return null;
  const mid = Math.floor(origins.length / 2);
  return origins.length % 2 ? origins[mid] : (origins[mid - 1] + origins[mid]) / 2;
}

export function azimuthalGap(source, stations) {
  const angles = stations.filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) &&
    Math.hypot(x - source.x, y - source.y) > 1e-9)
    .map(({ x, y }) => (Math.atan2(x - source.x, y - source.y) + TAU) % TAU).sort((a, b) => a - b);
  if (angles.length < 2) return 360;
  const max = Math.max(angles[0] + TAU - angles.at(-1), ...angles.slice(1).map((a, i) => a - angles[i]));
  return max * 180 / Math.PI;
}

function hasAperture(stations) {
  if (stations.length < 4) return false;
  const a = stations[0];
  const r = stations.map(p => [p.x - a.x, p.y - a.y]);
  const span2 = Math.max(...r.map(([x, y]) => x * x + y * y));
  return r.some(([x, y]) => r.some(([u, v]) => Math.abs(x * v - y * u) > span2 * 1e-8));
}

function matrix(rows) {
  return Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
}

function linearSolve(a, b, tolerance = 1e-12) {
  const m = a.map((row, i) => [...row, b[i]]);
  const scale = Math.max(...a.flat().map(Math.abs));
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let i = col + 1; i < 4; i++) {
      if (Math.abs(m[i][col]) > Math.abs(m[pivot][col])) pivot = i;
    }
    if (!(Math.abs(m[pivot][col]) > tolerance * scale)) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const divisor = m[col][col];
    for (let j = col; j <= 4; j++) m[col][j] /= divisor;
    for (let i = 0; i < 4; i++) {
      if (i === col) continue;
      const f = m[i][col];
      for (let j = col; j <= 4; j++) m[i][j] -= f * m[col][j];
    }
  }
  return m.map(row => row[4]);
}

export function geometry(source, stations, model = UNIFORM, sigma = 0.045) {
  const gap = azimuthalGap(source, stations);
  if (!hasAperture(stations) || source.z === 0) return { gap, gdop: null, ellipse: null };
  // Scale origin time to length so all four direction columns are dimensionless.
  const normal = matrix(stations.map(s => arrival(source, s, 'P', model).jacobian
    .map((v, i) => i === 3 ? 1 : v * model.vp)));
  const inv = normal.map((_, j) => linearSolve(normal, [0, 1, 2, 3].map(i => Number(i === j)), 1e-10));
  if (inv.some(column => column === null)) return { gap, gdop: null, ellipse: null };
  const [a, b] = inv[0];
  const c = inv[1][1];
  const discriminant = Math.hypot(a - c, 2 * b);
  const factor = Math.sqrt(5.9914645471) * sigma * model.vp;
  const gdop = Math.sqrt(inv.reduce((sum, col, i) => sum + col[i], 0));
  const ellipse = {
    major: factor * Math.sqrt(Math.max(0, (a + c + discriminant) / 2)),
    minor: factor * Math.sqrt(Math.max(0, (a + c - discriminant) / 2)),
    rotation: 0.5 * Math.atan2(2 * b, a - c),
  };
  return { gap, gdop, ellipse };
}

export function locate(observations, model = UNIFORM) {
  const picks = observations.filter(p => [p.x, p.y, p.time].every(Number.isFinite) && ['P', 'S'].includes(p.phase));
  const stations = [...new Map(picks.map(p => [`${p.x},${p.y}`, { x: p.x, y: p.y }])).values()];
  if (stations.length < 4) return { ok: false, reason: 'Need four distinct stations.' };
  if (!hasAperture(stations)) return { ok: false, reason: 'Stations are collinear.' };
  const asSource = ([x, y, z, t0]) => ({ x, y, z, t0 });
  // Residuals are time differences, so shifting every pick by the earliest
  // epoch leaves the solution identical while keeping it precise at any
  // absolute magnitude of the reported times.
  const tShift = Math.min(...picks.map(p => p.time));
  const obs = picks.map(p => ({ ...p, time: p.time - tShift }));
  const evaluate = u => {
    const source = asSource(u);
    const forward = obs.map(p => arrival(source, p, p.phase, model));
    const r = forward.map((p, i) => obs[i].time - p.time);
    return { r, j: forward.map(p => p.jacobian), cost: r.reduce((sum, v) => sum + v * v, 0) };
  };
  const center = k => stations.reduce((sum, s) => sum + s[k], 0) / stations.length;
  const first = obs.reduce((a, b) => a.time < b.time ? a : b);
  const seeds = [[center('x'), center('y')], [first.x, first.y]];
  const depths = model.interface === undefined ? [4, 18, 38] : [3, 7, 14, 32];
  let winner;
  for (const [x, y] of seeds) for (const z of depths) {
    const start = { x, y, z, t0: 0 };
    const t0 = obs.reduce((sum, p) => sum + p.time - arrival(start, p, p.phase, model).time, 0) / obs.length;
    let u = [x, y, z, t0];
    let e = evaluate(u);
    let lambda = 1e-3;
    for (let step = 0; step < 100 && e.cost > 1e-24 && lambda < 1e12; step++) {
      const normal = matrix(e.j);
      const rhs = normal.map((_, i) => e.r.reduce((sum, v, k) => sum + v * e.j[k][i], 0));
      normal.forEach((row, i) => { row[i] += lambda * Math.max(row[i], 1e-5); });
      const delta = linearSolve(normal, rhs);
      if (!delta || delta.every(v => Math.abs(v) < 1e-10)) break;
      const trial = u.map((v, i) => v + delta[i]);
      trial[2] = Math.max(0, trial[2]);
      if (!trial.every(Number.isFinite)) break;
      const candidate = evaluate(trial);
      if (candidate.cost < e.cost) {
        [u, e] = [trial, candidate];
        lambda = Math.max(1e-13, lambda / 3);
      } else {
        lambda *= 8;
      }
    }
    if (!winner || e.cost < winner.cost) winner = { u, ...e };
    if (winner.cost < 1e-24) break;
  }
  const source = asSource(winner.u);
  source.t0 += tShift;
  const normal = matrix(winner.j);
  const rms = Math.sqrt(winner.cost / obs.length);
  if (!Number.isFinite(rms)) return { ok: false, reason: 'Picks are numerically inconsistent.' };
  if (source.z <= 1e-4 || !linearSolve(normal, [1, 0, 0, 0], 1e-11)) {
    return { ok: false, reason: 'Depth and origin time are not resolved.' };
  }
  return { ok: true, source, rms, ...geometry(source, stations, model) };
}

export function alertTime(picks, count, latency) {
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(latency) || latency < 0) {
    throw new RangeError('Trigger count must be positive and latency must be nonnegative');
  }
  const times = picks.filter(Number.isFinite).sort((a, b) => a - b);
  return times.length >= count ? times[count - 1] + latency : null;
}

export function blindZone(source, alert, model = UNIFORM) {
  if (alert === null) return { radius: null, area: null };
  const radius = waveRadius(alert - (source.t0 ?? 0), source.z, 'S', model) ?? 0;
  return { radius, area: Math.PI * radius ** 2 };
}

export function siteLead(source, site, alert, model = UNIFORM) {
  const s = arrival(source, site, 'S', model).time;
  return { s, signed: alert === null ? null : s - alert, lead: alert === null ? null : Math.max(0, s - alert) };
}

// An illustrative log-distance intensity proxy, not a calibrated loss model.
export function intensity(magnitude, distance) {
  if (!Number.isFinite(magnitude) || !Number.isFinite(distance)) {
    throw new RangeError('Magnitude and distance must be finite');
  }
  return Math.max(1, Math.min(12, 1.5 * magnitude + 1.5 - 3 * Math.log10(Math.max(1, distance))));
}

export function intensityRadius(magnitude, depth, level) {
  if (level <= 1 || level > 12) return null;
  if (!Number.isFinite(magnitude) || !Number.isFinite(depth) || depth < 0) return null;
  const d = 10 ** ((1.5 * magnitude + 1.5 - level) / 3);
  return d > depth && d >= 1 ? Math.sqrt(d * d - depth * depth) : null;
}
