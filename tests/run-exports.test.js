import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJSON, csvCell, DRILL, localToLonLat, makeAudit, sha256, toCSV, toGeoJSON } from '../src/exports.js';
import { compareRuns, PRESETS, simulate, solveAt } from '../src/model.js';

for (const preset of PRESETS) {
  const base = simulate(preset);
  for (const options of [{ denser: true }, { faster: true }, { denser: true, faster: true }]) {
    test(`${preset.id}: ${Object.keys(options).join('+')} never makes modeled lead worse`, () => {
      const run = simulate(preset, options);
      const delta = compareRuns(base, run);
      assert.ok(delta.alertGained > 0);
      assert.ok(delta.areaReduced > 0);
      assert.ok(delta.siteGains.every(x => x.gained >= 0));
      for (const a of base.stations) {
        const b = run.stations.find(s => s.id === a.id);
        assert.deepEqual([a.pick, a.detected, a.pickErrorMs], [b.pick, b.detected, b.pickErrorMs]);
      }
    });
  }
  for (const velocity of ['uniform', 'layered']) {
    test(`${preset.id} ${velocity} GeoJSON uses lon/lat, CCW exterior rings, and closed boundaries`, () => {
      const run = simulate(preset, { velocity });
      const geo = toGeoJSON(run);
      assert.equal(geo.type, 'FeatureCollection');
      assert.equal(geo.synthetic, true);
      assert.equal(geo.features.filter(f => f.geometry.type === 'Point').length, run.stations.length + run.sites.length + 1);
      assert.ok(geo.features.some(f => f.properties.kind === 'illustrative-isoseismal'));
      for (const f of geo.features) {
        assert.equal(f.type, 'Feature');
        const { type, coordinates } = f.geometry;
        const ring = type === 'Point' ? [coordinates] : coordinates[0];
        for (const [lon, lat] of ring) {
          assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180);
          assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90);
        }
        if (type === 'Polygon') {
          assert.deepEqual(ring[0], ring.at(-1));
          assert.ok(ring.length >= 4);
          const twiceArea = ring.slice(0, -1).reduce((sum, [x, y], i) => sum + x * ring[i + 1][1] - y * ring[i + 1][0], 0);
          assert.ok(twiceArea > 0);
        }
      }
    });
  }
  test(`${preset.id} dispatches only after k confirmations and localization cannot see future data`, () => {
    const times = base.stations.map(s => s.detected).sort((a, b) => a - b);
    assert.ok(times.every(Number.isFinite));
    assert.ok(Math.abs(base.alert - times[base.settings.triggerCount - 1] - base.settings.latency) < 1e-12);
    assert.equal(solveAt(base, times[3] - 0.000001).ok, false);
    assert.equal(solveAt(base, times.at(-1)).ok, true);
    assert.equal(solveAt(base, times.at(-1)), solveAt(base, 45));
  });
  test(`${preset.id} audit is deterministic, covers its inputs, and matches Node's independent SHA implementation`, async () => {
    const audit = await makeAudit(base);
    assert.ok(audit.payload.stations.every(s => !('trace' in s) && !('ratios' in s)));
    assert.equal(audit.payload.seed, preset.seed);
    assert.equal(audit.sha256, createHash('sha256').update(canonicalJSON(audit.payload)).digest('hex'));
    assert.deepEqual(audit, await makeAudit(simulate(preset)));
    assert.notEqual(audit.sha256, (await makeAudit(simulate(preset, { faster: true }))).sha256);
  });
}

test('presets actually separate a warning window, blind-zone stress, and sparse geometry', () => {
  const [coast, urban, rural] = PRESETS.map(p => simulate(p));
  assert.ok(coast.sites.find(s => s.kind === 'School').lead > 5);
  assert.equal(urban.sites.find(s => s.kind === 'School').lead, 0);
  assert.ok(rural.geometry.gap > 300 && rural.geometry.gdop > 3 * urban.geometry.gdop);
});

test('zero or missing blind zone never exports an invalid degenerate polygon', () => {
  const preset = PRESETS[0];
  const a = simulate(preset, { triggerCount: 13 });
  assert.equal(a.alert, null);
  assert.equal(toGeoJSON(a).features.some(f => f.properties.kind === 'blind-zone'), false);
  const zero = { ...a, blind: { radius: 0, area: 0 } };
  assert.equal(toGeoJSON(zero).features.some(f => f.properties.kind === 'blind-zone'), false);
  assert.equal(compareRuns(a, simulate(preset)).siteGains[0].gained, null);
});

test('local east and north axes map independently around a stated geographic anchor', () => {
  const a = { lon: -125, lat: 43 };
  assert.deepEqual(localToLonLat(0, 0, a), [-125, 43]);
  const [eLon] = localToLonLat(10, 0, a);
  const [, nLat] = localToLonLat(0, 10, a);
  assert.ok(eLon > a.lon && nLat > a.lat);
});

for (const prefix of ['', ' ', '\t', '\r', '\n', '\ufeff', '\u200b', '\u2060', '\u00a0', ' \u200b\t',
  '͏', '︀', '⃝', '឴']) {
  for (const op of ['=', '+', '-', '@']) {
    test(`untrusted spreadsheet string ${JSON.stringify(prefix + op)} is neutralized`, () => {
      assert.equal(csvCell(`${prefix}${op}42`), `" '${prefix}${op}42"`.replace('" ', '"'));
    });
  }
}

test('CSV maintains negative numeric data and escapes quotes, commas, and internal newlines', () => {
  assert.equal(csvCell(-2.375), '-2.375');
  assert.equal(csvCell('-2.375'), '"\'-2.375"');
  assert.equal(csvCell('Cape "A",\nWest'), '"Cape ""A"",\nWest"');
  assert.equal(csvCell(null), '');
  const run = simulate(PRESETS[0]);
  run.stations[0].name = '\u200b=1+1';
  const csv = toCSV(run);
  assert.ok(csv.includes(`"'${run.stations[0].name}"`));
  assert.ok(csv.includes('"School"') && csv.includes('"Hospital"') && csv.includes('"Bridge"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('non-finite numbers export as empty cells, never as text that a sheet could misread', () => {
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(Infinity), '');
  assert.equal(csvCell(-Infinity), '');
  assert.equal(csvCell('NaN'), '"NaN"');
});

test('malformed export inputs fail loudly or degrade explicitly', () => {
  const run = simulate(PRESETS[0]);
  const bare = { ...run, sites: [{ id: 'X', name: 'Unlabeled', x: 1, y: 2, lead: 3 }] };
  assert.equal(toGeoJSON(bare).features.find(f => f.properties.id === 'X').properties.kind, 'site');
  assert.throws(() => toGeoJSON({ ...run, sites: [{ id: 'Y', name: 'Nowhere', x: NaN, y: 0 }] }), RangeError);
  assert.throws(() => localToLonLat(NaN, 0, run.anchor), RangeError);
  assert.throws(() => localToLonLat(0, 0, { lon: Infinity, lat: 0 }), RangeError);
});

test('solveAt recomputes when a visible observation mutates and stays cached when it does not', () => {
  const run = simulate(PRESETS[0]);
  const t = Math.max(...run.stations.map(s => s.detected));
  const a = solveAt(run, t);
  assert.equal(solveAt(run, t), a);
  run.stations[0].pick += 5;
  const b = solveAt(run, t);
  assert.notEqual(b, a, 'stale cached solve returned after pick mutation');
});

test('stations without a string id fail with RangeError, not a bare TypeError', () => {
  assert.throws(() => simulate(PRESETS[0], { stations: [{ name: 'Ghost', x: 1, y: 2 }] }), RangeError);
});

for (const [label, input, text] of [
  ['nested sorted keys', { z: 1, a: { y: true, a: [3, 2, 1] } }, '{"a":{"a":[3,2,1],"y":true},"z":1}'],
  ['integer-looking keys sort lexically', { 2: 4, 10: 1 }, '{"10":1,"2":4}'],
  ['unsupported members in objects are omitted', { a: undefined, b: Symbol('b'), c() {}, d: null }, '{"d":null}'],
  ['top-level undefined', undefined, undefined],
  ['top-level symbol', Symbol('not JSON'), undefined],
  ['top-level toJSON returning undefined', { toJSON: () => undefined }, undefined],
  ['nested toJSON returning undefined', { x: { toJSON: () => undefined }, y: [{ toJSON: () => undefined }] }, '{"y":[null]}'],
  ['toJSON key and receiver', { member: { n: 3, toJSON(k) { return [k, this.n]; } } }, '{"member":["member",3]}'],
  ['toJSON is not invoked a second time on returned function', { toJSON() { return Object.assign(() => 0, { toJSON: () => 12 }); } }, undefined],
  ['array holes and nonfinite entries', [, NaN, Infinity, -Infinity, -0], '[null,null,null,null,0]'],
  ['boxed primitives', [new Number(3), new String('s'), new Boolean(false)], '[3,"s",false]'],
  ['lone surrogate is escaped', '\ud800', '"\\ud800"'],
  ['control escapes', '\n\0\t', '"\\n\\u0000\\t"'],
  ['UTF-16 code units determine ordering', { '\ufffe': 1, '\u{10000}': 2 }, '{"\u{10000}":2,"\ufffe":1}'],
  ['nonobject serialization uses JS number formatting', [1e-7, 1e21, -0], '[1e-7,1e+21,0]'],
]) {
  test(`canonical JSON: ${label}`, () => assert.equal(canonicalJSON(input), text));
}

test('canonical JSON handles cycles, BigInt, and repeated reference identity correctly', () => {
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => canonicalJSON(cycle), TypeError);
  assert.throws(() => canonicalJSON({ x: 2n }), TypeError);
  assert.throws(() => canonicalJSON({ toJSON: () => Object(4n) }), TypeError);
  const shared = { b: 1 };
  assert.equal(canonicalJSON([shared, shared]), '[{"b":1},{"b":1}]');
});

test('SHA-256 known UTF-8 vector', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256('réplica'), createHash('sha256').update('réplica').digest('hex'));
});

for (const [lang, series] of Object.entries({ en: ['Drop', 'Cover', 'Hold On'], es: ['Agáchate', 'Cúbrete', 'Agárrate'] })) {
  test(`${lang} printable drill card has correct ordered actions, physics, and authority disclaimer`, () => {
    assert.deepEqual(DRILL[lang].steps.map(s => s.title), series);
    assert.match(DRILL[lang].physics, /\bP\b.*\bS\b/);
    assert.match(DRILL[lang].authority, /USGS/);
    assert.match(DRILL[lang].authority, /ShakeAlert/);
    assert.ok(DRILL[lang].exercise && DRILL[lang].steps.every(step => step.text.length > 30));
  });
}
