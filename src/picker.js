export const SAMPLE_RATE = 100;
export const PICKER = Object.freeze({ shortWindow: 0.14, longWindow: 1.5, triggerRatio: 4.6, sustain: 3 });

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seismogram({ p = null, s = null, seed = 1, snr = 8, start = -2, end = 48, rate = SAMPLE_RATE } = {}) {
  if (![start, end, snr, rate].every(Number.isFinite) || end <= start || rate < 1 || snr < 0) {
    throw new RangeError('Invalid trace parameters');
  }
  const rnd = mulberry32(seed);
  const length = Math.ceil((end - start) * rate) + 1;
  const components = Array.from({ length: 3 }, () => new Float32Array(length));
  const amp = snr / Math.sqrt(3);
  const tau = 2 * Math.PI;
  for (let i = 0; i < length; i++) {
    const t = start + i / rate;
    const a = p === null ? -1 : t - p;
    const b = s === null ? -1 : t - s;
    const pw = a < 0 ? 0 : amp * Math.exp(-a / 0.65) * Math.sin(tau * (7 * a - 0.07 * a * a));
    const sw = b < 0 ? 0 : 2.7 * amp * Math.exp(-b / 1.18) * Math.sin(tau * (4 * b - 0.045 * b * b));
    const coda = b < 0 ? 0 : 0.33 * amp * Math.exp(-b / 4.1) * Math.sin(tau * (2.45 * b - 0.01 * b * b));
    components[0][i] = (2 * rnd() - 1) + pw * 0.91 + sw * 0.26 + coda * 0.35;
    components[1][i] = (2 * rnd() - 1) + pw * 0.34 + sw * 0.83 + coda * 0.43;
    components[2][i] = (2 * rnd() - 1) + pw * 0.22 - sw * 0.50 + coda * 0.68;
  }
  return { components, rate, start, length };
}

export function pickP(trace, settings = PICKER) {
  const { shortWindow, longWindow, triggerRatio, sustain } = { ...PICKER, ...settings };
  const { components, rate, start, length } = trace;
  const ns = Math.round(shortWindow * rate);
  const nl = Math.round(longWindow * rate);
  if (!(ns >= 1 && nl > ns && Number.isFinite(triggerRatio) && triggerRatio > 1 &&
      Number.isInteger(sustain) && sustain >= 1)) throw new RangeError('Invalid STA/LTA settings');
  const energy = new Float64Array(length + 1);
  const ratios = new Float32Array(length);
  let run = 0;
  let pick = null;
  let detected = null;
  for (let i = 1; i <= length; i++) {
    const k = i - 1;
    energy[i] = energy[i - 1] + components.reduce((sum, c) => sum + c[k] ** 2, 0);
    if (i < ns + nl) continue;
    const lta = (energy[i - ns] - energy[i - ns - nl]) / nl;
    const sta = (energy[i] - energy[i - ns]) / ns;
    const ratio = lta > 1e-12 ? sta / lta : sta > 1e-12 ? Infinity : 0;
    ratios[k] = ratio;
    run = ratio >= triggerRatio ? run + 1 : 0;
    if (pick === null && run >= sustain) {
      pick = start + (k - sustain + 1) / rate;
      detected = start + k / rate;
    }
  }
  return { pick, detected, ratios };
}

export function pickerSweep(levels = [2, 3, 4, 6, 8, 12], trials = 16, settings = PICKER) {
  return levels.map(snr => {
    const errors = [];
    for (let seed = 1; seed <= trials; seed++) {
      const { pick } = pickP(seismogram({ p: 2, seed, snr, end: 3.5 }), settings);
      if (pick !== null) errors.push(1000 * (pick - 2));
    }
    const meanMs = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
    return { snr, detected: errors.length, trials, meanMs, errors };
  });
}
