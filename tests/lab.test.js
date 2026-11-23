import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYERED, UNIFORM, waveRadius } from '../src/seismology.js';
import {
  arrivalAt, blindRadiusKm, compareInterventions, damageRelevance, distanceProfile,
  groundMotion, INTERVENTIONS, LAB_DMAX, mmiFromPgaCms2, pgaCms2FromMmi, PGA_MMI,
  SOIL_CLASSES, soilById, warningLead,
} from '../src/seismic-lab.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} within ${tol}`);

for (const model of [UNIFORM, LAYERED]) for (const z of [0, 5, 19, 40]) {
  for (const r of [0, 12.5, 60, 130, 250]) {
    test(`${model.id}: P strictly precedes S at r=${r}, z=${z}`, () => {
      const tP = arrivalAt(r, z, 'P', model);
      const tS = arrivalAt(r, z, 'S', model);
      if (r === 0 && z === 0) assert.equal(tP, tS);
      else assert.ok(tP < tS, `tP ${tP} !< tS ${tS}`);
      if (model === UNIFORM) {
        near(tP, Math.hypot(r, z) / 6);
        near(tS, Math.hypot(r, z) / 3.5);
      }
    });
  }
}

for (const z of [3, 14, 32]) for (const alertS of [2, 9.4, 25]) {
  test(`lead is non-decreasing in distance at z=${z}, alert=${alertS}`, () => {
    let prev = -1;
    for (let r = 0; r <= LAB_DMAX; r += 5) {
      const { s, lead } = warningLead(r, z, alertS, UNIFORM);
      assert.ok(Number.isFinite(s));
      near(lead, Math.max(0, s - alertS));
      assert.ok(lead + 1e-9 >= prev, `lead fell at r=${r}`);
      prev = lead;
    }
  });
}

for (const r of [0, 45, 110, 250]) for (const z of [4, 22]) {
  test(`lead never grows with latency at r=${r}, z=${z}`, () => {
    let prev = Infinity;
    for (let alertS = 0; alertS <= 45; alertS += 1.5) {
      const { lead } = warningLead(r, z, alertS, UNIFORM);
      assert.ok(lead <= prev + 1e-9, `lead rose at alert ${alertS}`);
      prev = lead;
    }
  });
}

test('warningLead keeps null alert honest and rejects bad alerts', () => {
  const { s, lead } = warningLead(60, 10, null, UNIFORM);
  assert.ok(Number.isFinite(s) && s > 0);
  assert.equal(lead, null);
  assert.throws(() => warningLead(60, 10, NaN), RangeError);
  assert.throws(() => warningLead(-1, 10, 5), RangeError);
  assert.throws(() => warningLead(60, -2, 5), RangeError);
});

for (const z of [0, 8, 19, 41]) for (const alertS of [0, 3.2, 12, 30]) {
  test(`blind radius exact at z=${z}, alert=${alertS}`, () => {
    const radius = blindRadiusKm(alertS, z, UNIFORM);
    const want = Math.sqrt(Math.max(0, (alertS * 3.5) ** 2 - z * z));
    near(radius, want, 1e-9);
    near(waveRadius(alertS, z, 'S', UNIFORM) ?? 0, radius);
    if (radius > 0) {
      const { s } = warningLead(radius, z, alertS, UNIFORM);
      near(s, alertS, 1e-6);
    }
  });
}

test('blindRadiusKm stays null without an alert and validates inputs', () => {
  assert.equal(blindRadiusKm(null, 10), null);
  assert.equal(blindRadiusKm(null, 0), null);
  assert.throws(() => blindRadiusKm(NaN, 10), RangeError);
  assert.throws(() => blindRadiusKm(5, -1), RangeError);
  assert.equal(blindRadiusKm(0.5, 30, UNIFORM), 0);
});

test('soil classes are ordered, unique and strictly amplified', () => {
  assert.deepEqual(SOIL_CLASSES.map(s => s.id), ['B', 'C', 'D', 'E']);
  const factors = SOIL_CLASSES.map(s => s.factor);
  for (let i = 1; i < factors.length; i++) assert.ok(factors[i] > factors[i - 1]);
  assert.equal(soilById('B').factor, 1);
  assert.equal(soilById('E').name, 'Soft Basin E');
  assert.throws(() => soilById('F'), RangeError);
  assert.throws(() => soilById(''), RangeError);
  assert.throws(() => soilById(null), RangeError);
});

for (const mmi of [1, 3.4, 5.2, 7.8, 9.1, 12]) {
  test(`PGA-MMI mapping inverts at MMI ${mmi}`, () => {
    const pga = pgaCms2FromMmi(mmi);
    assert.ok(Number.isFinite(pga) && pga > 0);
    near(mmiFromPgaCms2(pga), mmi, 1e-9);
  });
}

test('PGA-MMI mapping clamps to the 1..12 intensity scale', () => {
  assert.equal(mmiFromPgaCms2(1e6), 12);
  assert.equal(mmiFromPgaCms2(1e-9), 1);
  assert.throws(() => mmiFromPgaCms2(0), RangeError);
  assert.throws(() => mmiFromPgaCms2(-3), RangeError);
  assert.throws(() => mmiFromPgaCms2(NaN), RangeError);
  assert.throws(() => pgaCms2FromMmi(NaN), RangeError);
  assert.ok(Math.abs(PGA_MMI.cms2PerG - 980.665) < 1e-9);
});

for (const soilId of ['B', 'C', 'D', 'E']) for (const [m, r, z] of [[5.6, 0, 8], [6.8, 45, 29], [7.2, 180, 10]]) {
  test(`ground motion M${m} at r=${r} z=${z} on class ${soilId} stays consistent`, () => {
    const gm = groundMotion(m, r, z, soilId);
    const soil = soilById(soilId);
    assert.ok(gm.mmi >= 1 && gm.mmi <= 12);
    assert.ok(gm.mmi >= gm.mmiRock - 1e-12);
    near(gm.pgaCms2, pgaCms2FromMmi(gm.mmiRock) * soil.factor, 1e-6);
    near(gm.pgaG, gm.pgaCms2 / PGA_MMI.cms2PerG, 1e-12);
    near(gm.mmi, mmiFromPgaCms2(gm.pgaCms2), 1e-9);
    if (soilId === 'B') near(gm.mmi, gm.mmiRock, 1e-9);
    else assert.ok(gm.pgaCms2 > pgaCms2FromMmi(gm.mmiRock));
  });
}

for (const m of [5.0, 6.5, 7.4]) {
  test('PGA is ordered B < C < D < E and declines with distance', () => {
    let prevPga = -Infinity;
    for (const s of SOIL_CLASSES) {
      const gm = groundMotion(m, 60, 15, s.id);
      assert.ok(gm.pgaCms2 > prevPga, `class ${s.id} not more amplified`);
      assert.ok(gm.mmi <= 12);
      prevPga = gm.pgaCms2;
    }
    for (const s of SOIL_CLASSES) {
      const nearField = groundMotion(m, 20, 15, s.id);
      const farField = groundMotion(m, 200, 15, s.id);
      assert.ok(farField.pgaCms2 < nearField.pgaCms2);
      assert.ok(farField.mmi <= nearField.mmi + 1e-12);
    }
  });
}

test('groundMotion rejects invalid magnitudes, distances and classes', () => {
  assert.throws(() => groundMotion(NaN, 10, 5), RangeError);
  assert.throws(() => groundMotion(6, -1, 5), RangeError);
  assert.throws(() => groundMotion(6, 10, -5), RangeError);
  assert.throws(() => groundMotion(6, 10, 5, 'Q'), RangeError);
});

for (const alertS of [null, 6, 14.74]) for (const soilId of ['B', 'E']) {
  test(`distanceProfile covers 0..${LAB_DMAX} km with alert=${alertS} soil=${soilId}`, () => {
    const profile = distanceProfile({ magnitude: 6.8, depthKm: 29, alertS, soilId, points: 51 });
    assert.equal(profile.rows.length, 51);
    assert.equal(profile.rows[0].r, 0);
    near(profile.rows.at(-1).r, LAB_DMAX);
    for (const row of profile.rows) {
      assert.ok(row.tP < row.tS);
      assert.ok(row.mmi >= 1 && row.mmi <= 12);
      assert.ok(row.pgaG > 0);
      if (alertS === null) assert.equal(row.lead, null);
      else near(row.lead, Math.max(0, row.tS - alertS));
    }
    assert.ok(profile.rows.every((row, i, a) => i === 0 || row.tS >= a[i - 1].tS));
  });
}

test('distanceProfile validates its parameters', () => {
  assert.throws(() => distanceProfile({ magnitude: NaN, depthKm: 5 }), RangeError);
  assert.throws(() => distanceProfile({ magnitude: 6, depthKm: -1 }), RangeError);
  assert.throws(() => distanceProfile({ magnitude: 6, depthKm: 5, dMax: 0 }), RangeError);
  assert.throws(() => distanceProfile({ magnitude: 6, depthKm: 5, points: 1 }), RangeError);
  assert.throws(() => distanceProfile({ magnitude: 6, depthKm: 5, alertS: NaN }), RangeError);
  assert.throws(() => distanceProfile({ magnitude: 6, depthKm: 5, soilId: 'Z' }), RangeError);
});

for (const [mmi, want] of [[1, 0], [5.2, 0], [6.5, 0.5], [7.8, 1], [12, 1]]) {
  test(`damage relevance at MMI ${mmi} is ${want}`, () => {
    near(damageRelevance(mmi), want, 1e-12);
  });
}

test('damage relevance is non-decreasing and validates input', () => {
  let prev = -1;
  for (let mmi = 1; mmi <= 12; mmi += 0.25) {
    const rel = damageRelevance(mmi);
    assert.ok(rel >= prev && rel >= 0 && rel <= 1);
    prev = rel;
  }
  assert.throws(() => damageRelevance(NaN), RangeError);
});

test('the comparator ships exactly the five planned measures with sane parameters', () => {
  assert.equal(INTERVENTIONS.length, 5);
  const ids = new Set(INTERVENTIONS.map(m => m.id));
  assert.deepEqual([...ids].sort(),
    ['base-isolation', 'community-package', 'elevator-park', 'gas-shutoff', 'urm-bracing']);
  for (const m of INTERVENTIONS) {
    assert.ok(m.damage > 0 && m.damage < 1, m.id);
    assert.ok(m.casualty > 0 && m.casualty < 1, m.id);
    assert.ok(m.costUsd > 0, m.id);
    assert.ok(m.activationS >= 0, m.id);
    assert.ok(['passive', 'eew', 'hybrid'].includes(m.mode), m.id);
    if (m.mode === 'eew') assert.ok(m.activationS > 0, m.id);
    if (m.mode === 'passive') assert.equal(m.activationS, 0, m.id);
    if (m.mode === 'hybrid') assert.ok(m.passiveShare > 0 && m.passiveShare < 1, m.id);
  }
});

for (const lead of [null, 0, 1.5, 4, 9, 30]) for (const mmi of [4, 6, 7.3, 9]) {
  test(`comparator arithmetic at lead=${lead}, MMI=${mmi}`, () => {
    const rel = damageRelevance(mmi);
    const rows = compareInterventions({ lead, mmi });
    assert.equal(rows.length, 5);
    for (const m of rows) {
      const spec = INTERVENTIONS.find(i => i.id === m.id);
      const triggered = m.mode !== 'passive' && lead !== null && lead >= m.activationS;
      const wantShare = m.mode === 'passive' ? 1 : m.mode === 'eew' ? (triggered ? 1 : 0)
        : spec.passiveShare + (1 - spec.passiveShare) * (triggered ? 1 : 0);
      near(m.armedShare, wantShare, 1e-12);
      near(m.damageReductionPct, spec.damage * wantShare * rel * 100, 1e-9);
      near(m.casualtyReductionPct, spec.casualty * wantShare * rel * 100, 1e-9);
      near(m.per100k, m.damageReductionPct / (m.costUsd / 100000), 1e-9);
      if (m.mode === 'passive') assert.equal(m.marginS, null);
      else if (lead === null) assert.equal(m.marginS, null);
      else near(m.marginS, lead - m.activationS);
      assert.equal(m.armed, m.armedShare > 0);
    }
  });
}

test('EEW-triggered measures report zero benefit inside the blind zone', () => {
  const rows = compareInterventions({ lead: null, mmi: 8 });
  for (const m of rows.filter(r => r.mode === 'eew')) {
    assert.equal(m.damageReductionPct, 0, m.id);
    assert.equal(m.casualtyReductionPct, 0, m.id);
  }
  const pack = rows.find(r => r.id === 'community-package');
  assert.ok(pack.damageReductionPct > 0, 'hybrid keeps its passive share');
  const full = 0.6 * damageRelevance(8) * 100;
  assert.ok(pack.damageReductionPct < full, 'passive share alone cannot be fully armed');
});

test('a short lead arms nothing triggered and negative margins stay honest', () => {
  const rows = compareInterventions({ lead: 1, mmi: 8 });
  for (const m of rows.filter(r => r.mode === 'eew')) {
    assert.ok(m.marginS < 0, m.id);
    assert.equal(m.damageReductionPct, 0, m.id);
  }
  const pack = rows.find(r => r.id === 'community-package');
  assert.equal(pack.armedShare, 0.55);
});

test('compareInterventions validates its inputs', () => {
  assert.throws(() => compareInterventions({ lead: -1, mmi: 6 }), RangeError);
  assert.throws(() => compareInterventions({ lead: NaN, mmi: 6 }), RangeError);
  assert.throws(() => compareInterventions({ lead: 3, mmi: NaN }), RangeError);
});

test('cheaper measures can outscore expensive ones per dollar', () => {
  const rows = compareInterventions({ lead: 8, mmi: 7.4 });
  const gas = rows.find(r => r.id === 'gas-shutoff');
  const iso = rows.find(r => r.id === 'base-isolation');
  assert.ok(gas.per100k > iso.per100k, 'the $1.5k valve should beat $2.8M isolation per $100k');
  assert.ok(iso.damageReductionPct > gas.damageReductionPct, 'isolation still wins on absolute reduction');
});
