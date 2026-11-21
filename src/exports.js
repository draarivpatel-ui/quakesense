import { intensityRadius } from './seismology.js';

const rad = Math.PI / 180;

export function localToLonLat(x, y, { lon, lat }) {
  if (![x, y, lon, lat].every(Number.isFinite)) throw new RangeError('Coordinates must be finite');
  const d = Math.hypot(x, y) / 6371.0088;
  if (d === 0) return [lon, lat];
  const origin = lat * rad;
  const bearing = Math.atan2(x, y);
  const phi = Math.asin(Math.sin(origin) * Math.cos(d) + Math.cos(origin) * Math.sin(d) * Math.cos(bearing));
  const lambda = lon * rad + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(origin),
    Math.cos(d) - Math.sin(origin) * Math.sin(phi));
  return [((lambda / rad + 540) % 360) - 180, phi / rad];
}

export function toGeoJSON(run) {
  const { source, anchor, stations, sites, blind } = run;
  const point = ({ x, y }, properties) => ({
    type: 'Feature', properties, geometry: { type: 'Point', coordinates: localToLonLat(x, y, anchor) },
  });
  const circle = (radius, properties) => {
    const ring = Array.from({ length: 96 }, (_, i) => {
      const theta = i * 2 * Math.PI / 96;
      return localToLonLat(source.x + radius * Math.cos(theta), source.y + radius * Math.sin(theta), anchor);
    });
    ring.push([...ring[0]]);
    return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } };
  };
  const features = [
    point(source, { kind: 'synthetic-epicenter', depthKm: source.z, magnitude: source.magnitude }),
    ...stations.map(s => point(s, { kind: 'station', id: s.id, name: s.name, triggerConfirmedS: s.detected })),
    ...sites.map(s => point(s, { kind: String(s.kind ?? 'site').toLowerCase(), id: s.id, name: s.name, warningLeadS: s.lead, illustrativeMMI: s.mmi })),
  ];
  if (blind.radius > 0) features.push(circle(blind.radius, { kind: 'blind-zone', radiusKm: blind.radius, areaKm2: blind.area }));
  for (const level of [4, 5, 6, 7, 8]) {
    const r = intensityRadius(source.magnitude, source.z, level);
    if (r > 0) features.push(circle(r, { kind: 'illustrative-isoseismal', level, radiusKm: r }));
  }
  return { type: 'FeatureCollection', synthetic: true, scenario: run.presetId, blindRadiusKm: blind.radius, features };
}

export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // Neutralize formulas even if a spreadsheet first strips invisible or whitespace prefixes.
  const prefix = /^[\p{White_Space}\p{Cc}\p{Cf}\p{M}]*/u.exec(text)[0];
  if (/^[=+\-@]/.test(text.slice(prefix.length)) || /[\t\r\n]/.test(prefix)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCSV(run) {
  const rows = [
    ['record_type', 'id', 'name', 'kind', 'x_km', 'y_km', 'synthetic_p_s', 'synthetic_s_s', 'first_crossing_s',
      'confirmed_trigger_s', 'picker_error_ms', 'signed_lead_s', 'available_lead_s', 'illustrative_mmi'],
    ...run.stations.map(s => ['station', s.id, s.name, 'station', s.x, s.y, s.p, s.s, s.pick, s.detected, s.pickErrorMs, null, null, null]),
    ...run.sites.map(s => ['site', s.id, s.name, s.kind, s.x, s.y, null, s.s, null, null, null, s.signed, s.lead, s.mmi]),
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function unbox(value) {
  // Check internal slots rather than constructor identity or Symbol.toStringTag.
  for (const [prototype, coerce] of [
    [Number.prototype, x => +x], [String.prototype, String],
    [Boolean.prototype, x => Boolean.prototype.valueOf.call(x)], [BigInt.prototype, x => BigInt.prototype.valueOf.call(x)],
  ]) {
    try {
      prototype.valueOf.call(value);
    } catch {
      continue;
    }
    return coerce(value);
  }
  return value;
}

export function canonicalJSON(value) {
  const ancestors = new Set();
  const serialize = (value, key) => {
    if ((typeof value === 'object' && value !== null) || typeof value === 'bigint' || typeof value === 'function') {
      const hook = value.toJSON;
      if (typeof hook === 'function') value = hook.call(value, key);
    }
    if (value === null) return 'null';
    if (typeof value === 'object') value = unbox(value);
    if (typeof value === 'bigint') throw new TypeError('BigInt cannot be serialized as JSON');
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object') return JSON.stringify(value);
    if (ancestors.has(value)) throw new TypeError('Circular JSON structure');
    ancestors.add(value);
    let text;
    if (Array.isArray(value)) {
      const length = value.length;
      const items = [];
      for (let i = 0; i < length; i++) items.push(serialize(value[i], String(i)) ?? 'null');
      text = `[${items.join(',')}]`;
    } else {
      const entries = [];
      for (const k of Object.keys(value).sort()) {
        const next = serialize(value[k], k);
        if (next !== undefined) entries.push(`${JSON.stringify(k)}:${next}`);
      }
      text = `{${entries.join(',')}}`;
    }
    ancestors.delete(value);
    return text;
  };
  return serialize(value, '');
}

export async function sha256(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('SHA-256 needs HTTPS or localhost.');
  const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function makeAudit(run) {
  const { presetId, source, stations, sites, settings, alert, blind, geometry, wadatiT0, anchor, seed, model } = run;
  const payload = {
    version: 1, synthetic: true, presetId, source, settings, seed, model, alert, blind, geometry, wadatiT0, anchor, sites,
    stations: stations.map(({ id, name, x, y, p, s, pick, detected, pickErrorMs, added }) =>
      ({ id, name, x, y, p, s, pick, detected, pickErrorMs, added })),
  };
  return { algorithm: 'SHA-256', serialization: 'ecmascript-json-sorted-keys-v1', sha256: await sha256(canonicalJSON(payload)), payload };
}

export const DRILL = {
  en: {
    title: 'School earthquake drill', subtitle: 'Drop, Cover, and Hold On',
    steps: [
      { title: 'Drop', text: 'Drop onto your hands and knees. This helps keep you from being knocked down.' },
      { title: 'Cover', text: 'Cover your head and neck. Crawl under a sturdy desk or table if one is nearby. If there is no shelter nearby, stay low and protect your head and neck with your arms.' },
      { title: 'Hold On', text: 'Hold on to your shelter and be ready to move with it until the shaking stops. Stay indoors during shaking. Do not run outside.' },
    ],
    physicsTitle: 'Why a few seconds matter',
    physics: 'P waves travel faster than S waves. A network can detect P waves and send a message before S waves reach some locations. Near the source, shaking can arrive before a message. Start protecting yourself right away when you feel shaking.',
    exercise: 'For the drill, pick a site, compare the simulated alert time to S-wave arrival, then practice the motions without rushing. Follow your school procedures and any accessibility plan.',
    authority: 'Synthetic educational model. It is not a live warning or a substitute for USGS ShakeAlert or school emergency procedures.',
  },
  es: {
    title: 'Simulacro escolar de terremoto', subtitle: 'Agáchate, cúbrete y agárrate',
    steps: [
      { title: 'Agáchate', text: 'Ponte sobre las manos y las rodillas. Así reduces el riesgo de caerte.' },
      { title: 'Cúbrete', text: 'Cúbrete la cabeza y el cuello. Si hay un escritorio o una mesa resistente cerca, métete debajo. Si no hay refugio cerca, permanece agachado y protege tu cabeza y cuello con los brazos.' },
      { title: 'Agárrate', text: 'Sujeta tu refugio y muévete con él hasta que termine el movimiento. Si estás dentro, quédate dentro mientras tiembla. No corras hacia afuera.' },
    ],
    physicsTitle: 'Por qué importan unos segundos',
    physics: 'Las ondas P viajan más rápido que las ondas S. Una red puede detectar las ondas P y enviar un aviso antes de que las ondas S lleguen a algunos lugares. Cerca del origen, el suelo puede temblar antes del aviso. Protégete en cuanto sientas el movimiento.',
    exercise: 'Para el simulacro, elige un lugar, compara la alerta simulada con la llegada de las ondas S y practica los movimientos sin prisa. Sigue el protocolo de tu escuela y tu plan de accesibilidad.',
    authority: 'Modelo educativo con datos sintéticos. No es una alerta real ni sustituye a ShakeAlert del USGS ni al protocolo de emergencia escolar.',
  },
};
