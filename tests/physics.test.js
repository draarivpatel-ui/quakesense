import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertTime, arrival, azimuthalGap, blindZone, geometry, intensity, intensityRadius,
  LAYERED, locate, siteLead, UNIFORM, wadati, waveRadius,
} from '../src/seismology.js';

const near = (a, b, tol = 1e-8) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} within ${tol}`);
const points = [[-31, -12], [15, -37], [28, 9], [-14, 39], [41, 38], [-39, 14]].map(([x, y]) => ({ x, y }));
const measure = (source, network, model, phases = ['P', 'S']) => network.flatMap(station =>
  phases.map(phase => ({ ...station, phase, time: arrival(source, station, phase, model).time })));

for (const model of [UNIFORM, LAYERED]) for (const phase of ['P', 'S']) {
  for (const z of [0, 3, 8, 13, 29]) for (const r of [0, 21, 160]) {
    test(`${model.id} ${phase} ray and wavefront invert at r=${r}, z=${z}`, () => {
      const source = { x: 0, y: 0, z, t0: -4.25 };
      const receiver = { x: 0.6 * r, y: 0.8 * r };
      const time = arrival(source, receiver, phase, model).time - source.t0;
      near(waveRadius(time + (r === 0 ? 1e-15 : 0), z, phase, model), r, 1e-5);
      const v = phase === 'P' ? 'vp' : 'vs';
      if (model === UNIFORM) near(time, Math.hypot(r, z) / model[v]);
      else {
        assert.ok(time >= Math.hypot(r, z) / model.lower[v] - 1e-9);
        assert.ok(time <= Math.hypot(r, z) / model[v] + 1e-9);
        if (r === 0 && z > model.interface) near(time, model.interface / model[v] + (z - model.interface) / model.lower[v]);
      }
    });
  }
}

for (const model of [UNIFORM, LAYERED]) for (const phase of ['P', 'S']) {
  for (const [r, z] of [[22, 3], [170, 3], [20, 18], [72, 29], [5, 7.7]]) {
    test(`${model.id} ${phase} analytic derivative at range ${r}, depth ${z}`, () => {
      const source = { x: -0.6 * r, y: 0.8 * r, z, t0: 2 };
      const receiver = { x: 0, y: 0 };
      const { jacobian } = arrival(source, receiver, phase, model);
      const h = 1e-4;
      for (const [i, key] of ['x', 'y', 'z', 't0'].entries()) {
        const plus = { ...source, [key]: source[key] + h };
        const minus = { ...source, [key]: source[key] - h };
        near(jacobian[i], (arrival(plus, receiver, phase, model).time - arrival(minus, receiver, phase, model).time) / (2 * h), 1e-7);
      }
    });
  }
}

for (const z of [1.5, 6, 14, 32, 50]) for (const [x, y] of [[-4, 7], [12, -11], [-27, 14], [3, 16]]) {
  for (const phases of [['P'], ['P', 'S']]) {
    test(`uniform ${phases.join('+')} noiseless inversion at (${x}, ${y}, ${z})`, () => {
      const source = { x, y, z, t0: z / 10 - 3 };
      const result = locate(measure(source, points, UNIFORM, phases));
      assert.equal(result.ok, true, result.reason);
      assert.ok(Math.hypot(result.source.x - x, result.source.y - y, result.source.z - z) < 1e-4);
      near(result.source.t0, source.t0, 1e-5);
    });
  }
}

for (const z of [3, 11, 27, 44]) for (const [x, y] of [[-4, 7], [12, -11], [-27, 14]]) {
  test(`layered P+S noiseless inversion at (${x}, ${y}, ${z})`, () => {
    const source = { x, y, z, t0: 2.5 };
    const fit = locate(measure(source, points, LAYERED), LAYERED);
    assert.equal(fit.ok, true, fit.reason);
    assert.ok(Math.hypot(fit.source.x - x, fit.source.y - y, fit.source.z - z) < 1e-4);
    near(fit.source.t0, source.t0, 1e-5);
  });
}

for (const t0 of [-18, -2, 0, 0.33, 16, 48]) {
  test(`Wadati recovers ${t0} s including nonzero origin`, () => {
    const source = { x: -14, y: 3, z: 12, t0 };
    const pair = points.map(s => ({ p: arrival(source, s, 'P').time, s: arrival(source, s, 'S').time }));
    near(wadati([{ p: 5, s: 2 }, ...pair, { p: NaN, s: 2 }]), t0);
    assert.equal(wadati(pair, LAYERED), null);
  });
}

test('P-only inversion from exactly four distinct asymmetric stations', () => {
  const source = { x: 9, y: -3, z: 21, t0: -2 };
  const fit = locate(measure(source, points.slice(0, 4), UNIFORM, ['P']));
  assert.equal(fit.ok, true, fit.reason);
  assert.ok(Math.hypot(fit.source.x - source.x, fit.source.y - source.y, fit.source.z - source.z) < 1e-4);
});

for (const network of [
  [], [{ x: 0, y: 0 }], points.slice(0, 2), points.slice(0, 3),
  [...points.slice(0, 3), points[0]], Array.from({ length: 5 }, (_, i) => ({ x: i, y: 4 * i + 1 })),
]) {
  test(`fail closed on ${network.length} insufficient or collinear stations (${JSON.stringify(network.at(-1))})`, () => {
    const source = { x: 4, y: 9, z: 8, t0: 1 };
    assert.equal(locate(measure(source, network, UNIFORM)).ok, false);
    assert.equal(geometry(source, network).gdop, null);
  });
}

test('co-circular P stations cannot separate depth from origin time at the center', () => {
  const source = { x: 0, y: 0, z: 6, t0: 0 };
  const circle = [[20, 0], [0, 20], [-20, 0], [0, -20]].map(([x, y]) => ({ x, y }));
  assert.equal(geometry(source, circle).gdop, null);
  assert.equal(locate(measure(source, circle, UNIFORM, ['P'])).ok, false);
});

test('azimuthal gap includes the wraparound and ignores a receiver at the epicenter', () => {
  const p = bearings => bearings.map(a => [Math.sin(a * Math.PI / 180), Math.cos(a * Math.PI / 180)])
    .map(([x, y]) => ({ x, y }));
  const epicenter = { x: 0, y: 0 };
  near(azimuthalGap(epicenter, p([0, 90, 180, 270])), 90);
  near(azimuthalGap(epicenter, [...p([350, 10, 170]), epicenter]), 180);
  near(azimuthalGap(epicenter, p([8, 12, 20])), 348);
  near(azimuthalGap(epicenter, p([15, 120, 175])), 200);
  near(azimuthalGap(epicenter, [epicenter, ...p([10])]), 360);
});

for (const latency of [0, 0.25, 2.4, 8]) for (const count of [1, 2, 3, 4]) {
  test(`quorum ${count} and ${latency}s electronics latency define blind boundary`, () => {
    const start = { x: 0, y: 0, z: 19, t0: 1 };
    const alert = alertTime([11, null, 6, 16, 8, NaN], count, latency);
    near(alert, [6, 8, 11, 16][count - 1] + latency);
    const blind = blindZone(start, alert);
    near(blind.area, Math.PI * Math.max(0, ((alert - 1) * 3.5) ** 2 - 19 ** 2));
    if (blind.radius > 0) near(siteLead(start, { x: blind.radius, y: 0 }, alert).signed, 0);
    else assert.ok(siteLead(start, { x: 0, y: 0 }, alert).signed >= 0);
    const later = blindZone(start, alert + 1);
    assert.ok(later.area >= blind.area);
    assert.ok(siteLead(start, { x: 100, y: 0 }, alert + 1).lead <= siteLead(start, { x: 100, y: 0 }, alert).lead);
  });
}

test('unavailable alerts stay null rather than looking like zero warning', () => {
  const source = { x: 0, y: 0, z: 18 };
  assert.equal(alertTime([2, 3], 3, 0), null);
  assert.deepEqual(blindZone(source, null), { radius: null, area: null });
  assert.equal(siteLead(source, { x: 10, y: 10 }, null).lead, null);
  assert.equal(waveRadius(2, 18, 'S'), null);
  assert.throws(() => alertTime([], 0, 0), RangeError);
  assert.throws(() => alertTime([], 1, -1), RangeError);
});

for (const magnitude of [5.6, 6.1, 6.8]) for (const level of [4, 5, 6, 7, 8]) {
  test(`illustrative M${magnitude} MMI ${level} isoseismal is consistent`, () => {
    const r = intensityRadius(magnitude, 2, level);
    assert.ok(r > 0);
    near(intensity(magnitude, Math.hypot(r, 2)), level);
    assert.ok(intensity(magnitude, Math.hypot(r + 10, 2)) < level);
  });
}

test('isoseismal levels above the surface maximum have no radius', () => {
  assert.equal(intensityRadius(5.6, 13, 8), null);
  assert.equal(intensityRadius(5.6, 13, 1), null);
});
