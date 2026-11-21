import { arrival, alertTime, blindZone, geometry, intensity, LAYERED, locate, siteLead, UNIFORM, wadati } from './seismology.js';
import { PICKER, pickP, seismogram } from './picker.js';

const stations = rows => rows.map(([id, name, x, y]) => ({ id, name, x, y }));
const sites = rows => rows.map(([id, name, kind, x, y]) => ({ id, name, kind, x, y }));
const bounds = { xMin: -110, xMax: 110, yMin: -70, yMax: 70 };

export const PRESETS = [
  {
    id: 'coastal', name: 'Coastal Subduction', shortName: 'Coastal', description: 'A deep offshore source gives inland sites more time before S waves reach them.',
    source: { x: -43, y: 7, z: 29, t0: 0, magnitude: 6.8 },
    stations: stations([
      ['C01', 'Cape Point', -23, 25], ['C02', 'South Jetty', -17, -28], ['C03', 'North Ridge', 11, 48],
      ['C04', 'Estuary', 3, 0], ['C05', 'Pine Valley', 45, -38], ['C06', 'East Bluff', 61, 31],
    ]),
    sites: sites([
      ['CO-S', 'Bayview School', 'School', 28, 20],
      ['CO-H', 'Cedar Hospital', 'Hospital', 40, -12],
      ['CO-B', 'Inlet Bridge', 'Bridge', 6, -27],
    ]),
    additions: stations([['C07', 'Offshore North', -48, 19], ['C08', 'Offshore South', -39, -9]]),
    bounds, anchor: { lon: -125, lat: 43 }, latency: 2.4, triggerCount: 4, seed: 624,
  },
  {
    id: 'urban', name: 'Urban Strike-Slip', shortName: 'Urban', description: 'Shallow shaking reaches nearby sites before the station quorum can issue an alert.',
    source: { x: -8, y: 2, z: 5, t0: 0, magnitude: 6.1 },
    stations: stations([
      ['U01', 'West Junction', -40, 14], ['U02', 'North Transit', 18, 35], ['U03', 'River Yard', -25, -24],
      ['U04', 'South Loop', 16, -31], ['U05', 'East Observatory', 48, 12], ['U06', 'Foothill', -50, -34],
    ]),
    sites: sites([
      ['UR-S', 'Juniper School', 'School', 1, 6],
      ['UR-H', 'Metro Hospital', 'Hospital', 22, 4],
      ['UR-B', 'Viaduct Bridge', 'Bridge', 39, -14],
    ]),
    additions: stations([['U07', 'North Switch', -10, 12], ['U08', 'Canal Junction', -16, -4]]),
    bounds, anchor: { lon: -118, lat: 35 }, latency: 3.4, triggerCount: 4, seed: 411,
  },
  {
    id: 'rural', name: 'Sparse Rural Network', shortName: 'Rural', description: 'The stations sit on one side of the source. Detection and precise location are not the same thing.',
    source: { x: -63, y: 3, z: 13, t0: 0, magnitude: 5.6 },
    stations: stations([
      ['R01', 'Mesa', 10, 17], ['R02', 'Quarry', 22, 28], ['R03', 'Depot', 29, 1], ['R04', 'Dry Creek', 42, 12],
      ['R05', 'East Range', 57, -18],
    ]),
    sites: sites([
      ['RU-S', 'Sage School', 'School', -24, 15],
      ['RU-H', 'County Hospital', 'Hospital', 17, -17],
      ['RU-B', 'Timber Bridge', 'Bridge', -38, -30],
    ]),
    additions: stations([['R06', 'West Fork', -82, -10], ['R07', 'North Basin', -68, 28]]),
    bounds, anchor: { lon: -111, lat: 40 }, latency: 4.2, triggerCount: 4, seed: 931,
  },
];

function seedFor(id, seed) {
  for (const c of id) seed = Math.imul(seed ^ c.codePointAt(0), 16777619);
  return seed >>> 0;
}

export function simulate(preset, {
  source = preset.source, stations: network = preset.stations, denser = false, faster = false,
  velocity = 'uniform', triggerCount = preset.triggerCount, latency = preset.latency, snr = 10, picker = PICKER,
} = {}) {
  const model = velocity === 'layered' ? LAYERED : UNIFORM;
  const actualLatency = faster ? Math.min(latency, 0.65) : latency;
  const settings = { triggerCount, latency: actualLatency, snr, picker: { ...PICKER, ...picker }, velocity: model.id };
  const sensors = network.map(s => ({ ...s, added: Boolean(s.added) }));
  if (denser) {
    const { xMin, xMax, yMin, yMax } = preset.bounds;
    for (const add of preset.additions) {
      const x = Math.min(xMax, Math.max(xMin, add.x + source.x - preset.source.x));
      const y = Math.min(yMax, Math.max(yMin, add.y + source.y - preset.source.y));
      if (!sensors.some(s => s.x === x && s.y === y)) sensors.push({ ...add, x, y, added: true });
    }
  }
  const observed = sensors.map(station => {
    const p = arrival(source, station, 'P', model).time;
    const s = arrival(source, station, 'S', model).time;
    const trace = seismogram({ p, s, seed: seedFor(station.id, preset.seed), snr });
    const { pick, detected, ratios } = pickP(trace, settings.picker);
    return { ...station, p, s, trace, ratios, pick, detected, pickErrorMs: pick === null ? null : 1000 * (pick - p) };
  });
  const alert = alertTime(observed.map(s => s.detected), triggerCount, actualLatency);
  return {
    presetId: preset.id, seed: preset.seed, source: { ...source }, stations: observed, model, alert,
    blind: blindZone(source, alert, model), geometry: geometry(source, sensors, model), wadatiT0: wadati(observed, model),
    sites: preset.sites.map(site => ({
      ...site, ...siteLead(source, site, alert, model),
      mmi: intensity(source.magnitude, Math.hypot(source.x - site.x, source.y - site.y, source.z)),
    })),
    settings, bounds: preset.bounds, anchor: preset.anchor,
  };
}

const solveCache = new WeakMap();

export function solveAt(run, time) {
  const visible = run.stations.filter(s => s.detected !== null && s.detected <= time);
  let cache = solveCache.get(run);
  if (!cache) {
    cache = new Map();
    solveCache.set(run, cache);
  }
  // A fixed run's set of visible picks only grows; equal counts imply equal observations.
  if (!cache.has(visible.length)) {
    cache.set(visible.length, locate(visible.map(s => ({ x: s.x, y: s.y, time: s.pick, phase: 'P' })), run.model));
  }
  return cache.get(visible.length);
}

export function compareRuns(base, run) {
  const diff = (a, b) => a == null || b == null ? null : a - b;
  const before = new Map(base.sites.map(site => [site.id, site]));
  return {
    areaReduced: diff(base.blind.area, run.blind.area),
    alertGained: diff(base.alert, run.alert),
    siteGains: run.sites.map(site => ({ id: site.id, gained: diff(site.lead, before.get(site.id)?.lead) })),
  };
}
