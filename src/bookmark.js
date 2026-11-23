// URL-hash bookmarks: the whole configured exercise state fits in `#qs=`
// followed by unpadded base64url of canonical JSON. Decoding is strict: a
// malformed token, bad field or unknown enum value returns null rather
// than a half-applied state. Pure string and byte work, no dependencies.

import { canonicalJSON } from './exports.js';
import { LAB_DMAX, SOIL_CLASSES } from './seismic-lab.js';
import { PRESETS } from './model.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PRESET_IDS = new Set(PRESETS.map(p => p.id));
const SOIL_IDS = new Set(SOIL_CLASSES.map(s => s.id));
const VELOCITIES = new Set(['uniform', 'layered']);

export function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += B64[c & 63];
  }
  return out;
}

export function b64urlDecode(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const bytes = new Uint8Array(Math.floor(token.length * 3 / 4));
  let n = 0;
  for (let i = 0; i < token.length; i += 4) {
    const c0 = B64.indexOf(token[i]);
    const c1 = i + 1 < token.length ? B64.indexOf(token[i + 1]) : 0;
    const c2 = i + 2 < token.length ? B64.indexOf(token[i + 2]) : -1;
    const c3 = i + 3 < token.length ? B64.indexOf(token[i + 3]) : -1;
    bytes[n++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) bytes[n++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) bytes[n++] = ((c2 & 3) << 6) | c3;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n));
  } catch {
    return null;
  }
}

const num = (v, min, max, integer = false) =>
  Number.isFinite(v) && (integer ? Number.isInteger(v) : true) && v >= min && v <= max;

// The bookmark schema. Every field is optional so a link may carry just a
// preset; anything present is validated or the whole decode fails closed.
const SCHEMA = {
  v: v => v === 1,
  p: v => PRESET_IDS.has(v),
  lat: v => num(v, 0, 30),
  k: v => num(v, 1, 12, true),
  vel: v => VELOCITIES.has(v),
  snr: v => num(v, 1, 20),
  dep: v => num(v, 1, 60),
  ex: v => num(v, -110, 110),
  ey: v => num(v, -70, 70),
  dns: v => v === true || v === false,
  fst: v => v === true || v === false,
  lab: v => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const keys = Object.keys(v);
    if (!keys.length || keys.some(k => k !== 'd' && k !== 'soil')) return false;
    if ('d' in v && !num(v.d, 0, LAB_DMAX)) return false;
    if ('soil' in v && !SOIL_IDS.has(v.soil)) return false;
    return true;
  },
};

export function encodeState(state) {
  if (typeof state !== 'object' || state === null) throw new RangeError('Bookmark state must be an object');
  const out = {};
  for (const [key, check] of Object.entries(SCHEMA)) {
    if (state[key] === undefined) continue;
    if (!check(state[key])) throw new RangeError(`Invalid bookmark field ${key}`);
    out[key] = state[key];
  }
  return `qs=${b64urlEncode(canonicalJSON(out))}`;
}

export function decodeState(hash) {
  if (typeof hash !== 'string') return null;
  const token = /^#?qs=([^&]*)/.exec(hash)?.[1];
  const text = token && b64urlDecode(token);
  if (!text) return null;
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const keys = Object.keys(state);
  if (!keys.length || keys.some(k => !(k in SCHEMA) || !SCHEMA[k](state[k]))) return null;
  return state;
}
