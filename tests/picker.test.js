import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, PICKER, pickerSweep, pickP, seismogram } from '../src/picker.js';

for (const rate of [50, 100, 125]) for (const seed of [2, 5, 14, 23, 104, 803, 0xffffffff, 0]) {
  test(`pure bounded independent noise, rate ${rate}, seed ${seed}: zero triggers`, () => {
    const trace = seismogram({ seed, rate });
    const pick = pickP(trace);
    assert.equal(pick.pick, null);
    assert.equal(pick.detected, null);
    assert.ok(pick.ratios.every(v => v < PICKER.triggerRatio));
  });
}

for (const p of [0.13, 2.653, 14.978, 35.543]) for (const seed of [0, 9, 22, 913]) {
  test(`P pick at ${p} s, seed ${seed}, 12 SNR, resolves within 120 ms`, () => {
    const trace = seismogram({ p, s: p + 1.4, seed, snr: 12 });
    const { pick, detected } = pickP(trace);
    assert.ok(pick !== null && pick >= p && pick - p < 0.12);
    assert.ok(Math.abs(detected - pick - 0.02) < 1e-10, 'confirmation is causal, not the backdated first crossing');
    assert.ok(detected < p + 1.4);
    assert.equal(trace.components.length, 3);
  });
}

test('Mulberry32 known sequence, independent of signed seed representation', () => {
  const r = mulberry32(1);
  assert.deepEqual(Array.from({ length: 3 }, () => r()), [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  assert.equal(mulberry32(-1)(), mulberry32(0xffffffff)());
});

test('trace and ratio arrays are repeatable and distinguish seeds', () => {
  const a = seismogram({ p: 2, s: 6, seed: 43, end: 9 });
  const b = seismogram({ p: 2, s: 6, seed: 43, end: 9 });
  assert.deepEqual(a, b);
  assert.deepEqual(pickP(a), pickP(b));
  assert.notDeepEqual(a, seismogram({ p: 2, s: 6, seed: 44, end: 9 }));
});

test('STA and LTA are exclusive adjacent windows and report a sustained crossing', () => {
  const samples = Float32Array.from([1, 1, 1, 1, 1, 1, 3, 3, 3, 0]);
  const { ratios, pick, detected } = pickP({ rate: 10, start: 0, length: samples.length, components: [samples] },
    { shortWindow: 0.2, longWindow: 0.4, triggerRatio: 4, sustain: 2 });
  assert.equal(ratios[4], 0);
  assert.equal(ratios[5], 1);
  assert.equal(ratios[6], 5);
  assert.equal(ratios[7], 9);
  assert.equal(pick, 0.6);
  assert.equal(detected, 0.7);
});

test('weak P sweep reports misses rather than conflating them with zero error', () => {
  const [low, medium, high] = pickerSweep([2, 6, 12], 16);
  assert.equal(low.detected, 0);
  assert.equal(low.meanMs, null);
  assert.ok(medium.detected > 0 && medium.detected < 16);
  assert.equal(high.detected, 16);
  assert.ok(high.meanMs > 0 && high.meanMs < medium.meanMs);
});

test('P-labeled trigger can be S when P is absent, rather than reading hidden truth', () => {
  const { pick } = pickP(seismogram({ s: 5, snr: 10, end: 7 }));
  assert.ok(pick >= 5 && pick <= 5.12);
});

test('invalid trace and detector options are not silently accepted', () => {
  assert.throws(() => seismogram({ start: 4, end: 1 }), RangeError);
  assert.throws(() => pickP(seismogram(), { shortWindow: 1.5, longWindow: 1.5 }), RangeError);
  assert.throws(() => pickP(seismogram(), { triggerRatio: NaN }), RangeError);
  assert.throws(() => pickP(seismogram(), { sustain: 1.5 }), RangeError);
});

test('non-finite phase times are rejected instead of generating NaN traces', () => {
  assert.throws(() => seismogram({ p: NaN }), RangeError);
  assert.throws(() => seismogram({ p: -Infinity }), RangeError);
  assert.throws(() => seismogram({ s: NaN }), RangeError);
  assert.throws(() => seismogram({ s: 'late' }), RangeError);
});

test('malformed traces fail with RangeError, never a silent null or TypeError', () => {
  assert.throws(() => pickP(null), RangeError);
  assert.throws(() => pickP({ rate: 100, start: 0, length: 10 }), RangeError);
  assert.throws(() => pickP({ rate: 100, start: 0, length: 10, components: [] }), RangeError);
  assert.throws(() => pickP({ rate: 100, start: 0, length: 10, components: [new Float32Array(5)] }), RangeError);
  assert.throws(() => pickP({ rate: NaN, start: 0, length: 10, components: [new Float32Array(10)] }), RangeError);
});

test('sweep arguments are validated', () => {
  assert.throws(() => pickerSweep('high'), RangeError);
  assert.throws(() => pickerSweep([NaN], 4), RangeError);
  assert.throws(() => pickerSweep([-2], 4), RangeError);
  assert.throws(() => pickerSweep([3], 0), RangeError);
  assert.throws(() => pickerSweep([3], 2.5), RangeError);
});
