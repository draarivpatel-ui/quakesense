import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../src/exports.js';
import {
  briefToCSV, briefToMarkdown, buildBriefPayload, labReadout, makeBrief, tamperBrief, verifyBrief,
} from '../src/brief.js';
import { b64urlDecode, b64urlEncode, decodeState, encodeState } from '../src/bookmark.js';
import { runSelfTests } from '../src/selfcheck.js';
import { PRESETS, simulate } from '../src/model.js';
import { INTERVENTIONS, LAB_DMAX } from '../src/seismic-lab.js';

const [coastal, urban, rural] = PRESETS.map(p => simulate(p));
const labs = [
  { distanceKm: 0, soilId: 'B' },
  { distanceKm: 60, soilId: 'D' },
  { distanceKm: 250, soilId: 'E' },
];

for (const [run, lab] of [[coastal, labs[0]], [coastal, labs[1]], [urban, labs[2]], [rural, labs[1]]]) {
  test(`${run.presetId} brief at ${lab.distanceKm} km class ${lab.soilId}: digest matches Node crypto`, () => {
    const brief = makeBrief(run, lab);
    assert.match(brief.sha256, /^[0-9a-f]{64}$/);
    assert.equal(brief.sha256, createHash('sha256').update(canonicalJSON(brief.payload)).digest('hex'));
    assert.match(brief.digestNote, /not a signature/i);
    assert.equal(brief.payload.synthetic, true);
    assert.match(brief.payload.disclaimer, /ShakeAlert/);
    assert.equal(brief.payload.lab.interventions.length, 5);
    assert.ok(verifyBrief(brief));
  });
}

test('labReadout is internally consistent with the run model', () => {
  for (const run of [coastal, urban, rural]) {
    const r = labReadout(run, { distanceKm: 80, soilId: 'D' });
    assert.ok(r.tP < r.tS, run.presetId);
    if (run.alert === null) assert.equal(r.leadS, null);
    else assert.ok(Math.abs(r.leadS - Math.max(0, r.tS - r.alertS)) < 1e-9);
    assert.equal(r.interventions.length, 5);
    assert.ok(r.mmi >= 1 && r.mmi <= 12);
    assert.equal(r.blindRadiusKm, run.blind.radius);
  }
});

for (const run of [coastal, urban, rural]) {
  test(`${run.presetId} brief is deterministic and sensitive to lab inputs`, () => {
    const a = makeBrief(run, { distanceKm: 60, soilId: 'B' });
    const b = makeBrief(simulate(PRESETS.find(p => p.id === run.presetId)), { distanceKm: 60, soilId: 'B' });
    assert.equal(a.sha256, b.sha256);
    assert.notEqual(a.sha256, makeBrief(run, { distanceKm: 61, soilId: 'B' }).sha256);
    assert.notEqual(a.sha256, makeBrief(run, { distanceKm: 60, soilId: 'E' }).sha256);
  });
}

test('verifyBrief detects any payload mutation and rejects malformed briefs', () => {
  const brief = makeBrief(coastal, { distanceKm: 40, soilId: 'C' });
  assert.ok(verifyBrief(brief));
  for (const mutate of [
    b => { b.payload.alertS += 0.001; },
    b => { b.payload.lab.distanceKm += 1; },
    b => { b.payload.sites[0].leadS = 99; },
    b => { b.payload.extra = 'injected'; },
    b => { delete b.payload.scenario; },
  ]) {
    const copy = JSON.parse(JSON.stringify(brief));
    mutate(copy);
    assert.equal(verifyBrief(copy), false, 'mutation went undetected');
  }
  assert.equal(verifyBrief(null), false);
  assert.equal(verifyBrief({}), false);
  assert.equal(verifyBrief({ sha256: 42, payload: {} }), false);
  const upper = { ...brief, sha256: brief.sha256.toUpperCase() };
  assert.ok(verifyBrief(upper), 'hex case must not matter');
});

test('tamperBrief demonstrates detection honestly', () => {
  const brief = makeBrief(coastal, { distanceKm: 40, soilId: 'C' });
  const t = tamperBrief(brief);
  assert.equal(t.detected, true);
  assert.match(t.changedField, /distanceKm/);
  assert.equal(t.originalSha256, brief.sha256);
  assert.notEqual(t.tamperedSha256, brief.sha256);
  assert.match(t.tamperedSha256, /^[0-9a-f]{64}$/);
});

for (const run of [coastal, urban]) {
  test(`${run.presetId} brief CSV is injection-safe and complete`, () => {
    const csv = briefToCSV(buildBriefPayload(run, { distanceKm: 30, soilId: 'D' }));
    assert.ok(csv.startsWith('"record_type","key","value"'));
    assert.ok(csv.endsWith('\r\n'));
    assert.ok(csv.includes('"intervention gas-shutoff"'));
    assert.ok(csv.includes('"meta","disclaimer"'));
    assert.ok(csv.includes('ShakeAlert'));
    for (const id of INTERVENTIONS.map(m => m.id)) assert.ok(csv.includes(id), id);
  });
}

test('brief Markdown carries the tables and no long dashes', () => {
  const md = briefToMarkdown(buildBriefPayload(urban, { distanceKm: 90, soilId: 'E' }));
  assert.match(md, /^# QuakeSense readiness brief/m);
  assert.match(md, /\| Intervention \| Mode \| Margin \|/);
  assert.match(md, /planning-model estimates/i);
  assert.match(md, /Synthetic planning exercise/);
  assert.doesNotMatch(md, /[\u2013\u2014]/);
  for (const m of INTERVENTIONS) assert.ok(md.includes(m.name), m.id);
});

for (const s of ['a', 'hello world', '{"v":1,"p":"coastal"}', 'réplica', 'x'.repeat(997)]) {
  test(`base64url round trip ${JSON.stringify(s.slice(0, 16))}`, () => {
    const token = b64urlEncode(s);
    assert.match(token, /^[A-Za-z0-9_-]*$/, 'must be unpadded base64url');
    assert.equal(b64urlDecode(token), s);
  });
}

for (const bad of ['', 'A', '====', 'a+b/', 'abc=', 'AAAAA', 'a'.repeat(5)]) {
  test(`base64url rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(b64urlDecode(bad), null);
  });
}

for (const state of [
  { v: 1, p: 'coastal' },
  { v: 1, p: 'urban', lat: 0, k: 1 },
  { v: 1, p: 'rural', lat: 30, k: 12, vel: 'layered', snr: 20, dep: 60, ex: -110, ey: 70, dns: true, fst: true, lab: { d: 250, soil: 'E' } },
  { v: 1, lab: { d: 0 } },
  { v: 1, lab: { soil: 'B' } },
]) {
  test(`bookmark round trip ${JSON.stringify(state)}`, () => {
    const token = encodeState(state);
    assert.match(token, /^qs=[A-Za-z0-9_-]+$/);
    const back = decodeState(`#${token}`);
    assert.deepEqual(back, state);
    assert.deepEqual(decodeState(token), state);
  });
}

for (const [label, hash] of [
  ['empty', ''],
  ['no prefix', '#other=abc'],
  ['bad chars', '#qs=!!!'],
  ['truncated quartet', '#qs=A'],
  ['not json', `#qs=${b64urlEncode('not json')}`],
  ['json scalar', `#qs=${b64urlEncode('42')}`],
  ['json array', `#qs=${b64urlEncode('[1,2]')}`],
  ['unknown key', `#qs=${b64urlEncode('{"v":1,"zzz":2}')}`],
  ['bad preset', `#qs=${b64urlEncode('{"v":1,"p":"mars"}')}`],
  ['string latency', `#qs=${b64urlEncode('{"v":1,"lat":"2"}')}`],
  ['latency over max', `#qs=${b64urlEncode('{"v":1,"lat":31}')}`],
  ['quorum over station cap', `#qs=${b64urlEncode('{"v":1,"k":13}')}`],
  ['depth over input max', `#qs=${b64urlEncode('{"v":1,"dep":61}')}`],
  ['depth below input min', `#qs=${b64urlEncode('{"v":1,"dep":0}')}`],
  ['epicenter off the map', `#qs=${b64urlEncode('{"v":1,"ex":111}')}`],
  ['epicenter south of map', `#qs=${b64urlEncode('{"v":1,"ey":-71}')}`],
  ['negative distance', `#qs=${b64urlEncode('{"v":1,"lab":{"d":-3}}')}`],
  ['bad soil', `#qs=${b64urlEncode('{"v":1,"lab":{"soil":"A"}}')}`],
  ['empty lab object', `#qs=${b64urlEncode('{"v":1,"lab":{}}')}`],
  ['lab array', `#qs=${b64urlEncode('{"v":1,"lab":[60]}')}`],
  ['noninteger quorum', `#qs=${b64urlEncode('{"v":1,"k":2.5}')}`],
  ['empty object', `#qs=${b64urlEncode('{}')}`],
  ['version 2', `#qs=${b64urlEncode('{"v":2,"p":"coastal"}')}`],
]) {
  test(`bookmark decode fails closed: ${label}`, () => {
    assert.equal(decodeState(hash), null);
  });
}

test('encodeState rejects invalid fields instead of emitting a bad link', () => {
  assert.throws(() => encodeState(null), RangeError);
  assert.throws(() => encodeState({ p: 'atlantis' }), RangeError);
  assert.throws(() => encodeState({ lat: -1 }), RangeError);
  assert.throws(() => encodeState({ k: 2.5 }), RangeError);
  assert.throws(() => encodeState({ lab: { soil: 'F' } }), RangeError);
  assert.throws(() => encodeState('coastal'), RangeError);
});

test('bookmark tokens survive a URL parse and keep out padding', () => {
  const token = encodeState({ v: 1, p: 'coastal', lab: { d: LAB_DMAX, soil: 'E' } });
  const url = new URL(`https://aariv.me/quakesense/#${token}`);
  assert.equal(decodeState(url.hash)?.p, 'coastal');
  assert.doesNotMatch(token.slice(3), /[+/=]/);
});

test('the in-page self-test suite passes everywhere it runs', () => {
  const results = runSelfTests();
  assert.ok(results.length >= 15, `expected at least 15 checks, got ${results.length}`);
  const ids = new Set(results.map(r => r.id));
  assert.equal(ids.size, results.length, 'duplicate check id');
  for (const r of results) {
    assert.ok(typeof r.name === 'string' && r.name.length > 5, r.id);
    assert.equal(r.ok, true, `${r.id} failed: ${r.detail}`);
  }
});
