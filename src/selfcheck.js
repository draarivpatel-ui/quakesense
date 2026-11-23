// In-page self-checks: the same assertions the lab panel runs live in the
// browser, exported so the node test suite holds them to the same bar.
// Each check returns { id, name, ok, detail }; nothing here throws.

import { UNIFORM, waveRadius } from './seismology.js';
import {
  arrivalAt, blindRadiusKm, compareInterventions, damageRelevance, groundMotion,
  INTERVENTIONS, SOIL_CLASSES, warningLead,
} from './seismic-lab.js';
import { canonicalJSON, csvCell } from './exports.js';
import { sha256Hex } from './sha256.js';
import { decodeState, encodeState } from './bookmark.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const CHECKS = [
  {
    id: 'p-before-s',
    name: 'P wave strictly precedes S wave at every distance',
    run() {
      for (const z of [2, 13, 29]) {
        for (let r = 0; r <= 250; r += 10) {
          if (!(arrivalAt(r, z, 'P', UNIFORM) < arrivalAt(r, z, 'S', UNIFORM))) {
            return `order broke at r=${r}, z=${z}`;
          }
        }
      }
      return null;
    },
  },
  {
    id: 'lead-monotone-distance',
    name: 'Usable lead is non-decreasing with epicentral distance',
    run() {
      for (const alertS of [3, 11.7, 26]) {
        let prev = -1;
        for (let r = 0; r <= 250; r += 5) {
          const { lead } = warningLead(r, 14, alertS, UNIFORM);
          if (lead + 1e-9 < prev) return `lead fell at r=${r} for alert ${alertS}`;
          prev = lead;
        }
      }
      return null;
    },
  },
  {
    id: 'lead-nonincreasing-latency',
    name: 'More latency never buys more lead time',
    run() {
      for (const r of [0, 40, 130, 250]) {
        let prev = Infinity;
        for (let alertS = 0; alertS <= 40; alertS += 0.5) {
          const { lead } = warningLead(r, 10, alertS, UNIFORM);
          if (lead > prev + 1e-9) return `lead rose at r=${r}, alert ${alertS}`;
          prev = lead;
        }
      }
      return null;
    },
  },
  {
    id: 'blind-exact',
    name: 'Blind radius equals the analytic S-wave footprint',
    run() {
      for (const z of [4, 19, 40]) {
        for (const alertS of [1, 7.5, 20]) {
          const got = blindRadiusKm(alertS, z, UNIFORM);
          const want = Math.sqrt(Math.max(0, (alertS * 3.5) ** 2 - z * z));
          if (!near(got, want, 1e-9)) return `r=${got} != ${want} at z=${z}, alert ${alertS}`;
        }
      }
      if (blindRadiusKm(null, 10) !== null) return 'null alert gave a radius';
      return null;
    },
  },
  {
    id: 'wavefront-inverse',
    name: 'waveRadius inverts the S arrival exactly',
    run() {
      for (const z of [2, 29]) for (const r of [0, 33, 200]) {
        const t = arrivalAt(r, z, 'S', UNIFORM);
        if (!near(waveRadius(t, z, 'S', UNIFORM), r, 1e-6)) return `r=${r}, z=${z}`;
      }
      return null;
    },
  },
  {
    id: 'soil-ordering',
    name: 'Site-class amplification orders Soft Basin over Rock',
    run() {
      const factors = SOIL_CLASSES.map(s => s.factor);
      for (let i = 1; i < factors.length; i++) {
        if (!(factors[i] > factors[i - 1])) return 'factors not strictly increasing';
      }
      for (const r of [0, 75, 200]) {
        const mmi = SOIL_CLASSES.map(s => groundMotion(6.5, r, 12, s.id).mmi);
        const pga = SOIL_CLASSES.map(s => groundMotion(6.5, r, 12, s.id).pgaG);
        for (let i = 1; i < mmi.length; i++) {
          if (!(mmi[i] >= mmi[i - 1]) || !(pga[i] > pga[i - 1])) return `order broke at r=${r}`;
        }
      }
      return null;
    },
  },
  {
    id: 'interventions-shape',
    name: 'Comparator ships five measures with in-range percentages',
    run() {
      if (INTERVENTIONS.length !== 5) return `expected 5, got ${INTERVENTIONS.length}`;
      const rows = compareInterventions({ lead: 9, mmi: 7.1 });
      if (rows.length !== 5) return 'compareInterventions lost a row';
      for (const m of rows) {
        if (!(m.damageReductionPct >= 0 && m.damageReductionPct <= 100 &&
              m.casualtyReductionPct >= 0 && m.casualtyReductionPct <= 100 &&
              m.costUsd > 0)) return `bad range on ${m.id}`;
      }
      return null;
    },
  },
  {
    id: 'eew-needs-lead',
    name: 'EEW-triggered measures fail without warning; passive share holds',
    run() {
      const none = compareInterventions({ lead: null, mmi: 8 });
      const gas = none.find(m => m.id === 'gas-shutoff');
      const pack = none.find(m => m.id === 'community-package');
      if (gas.damageReductionPct !== 0) return 'shutoff armed with no alert';
      const rel = damageRelevance(8);
      if (!near(pack.armedShare, 0.55)) return 'hybrid lost passive share';
      if (!near(pack.damageReductionPct, 0.6 * 0.55 * rel * 100)) return 'hybrid arithmetic wrong';
      const short = compareInterventions({ lead: 1, mmi: 8 }).find(m => m.id === 'elevator-park');
      if (short.damageReductionPct !== 0 || !(short.marginS < 0)) return 'park armed inside margin';
      return null;
    },
  },
  {
    id: 'margin-arithmetic',
    name: 'Completion margin is lead minus activation, passive is always installed',
    run() {
      for (const lead of [0, 3.5, 9]) {
        for (const m of compareInterventions({ lead, mmi: 7 })) {
          if (m.mode === 'passive') {
            if (m.marginS !== null) return `passive ${m.id} reported a margin`;
          } else if (!near(m.marginS, lead - m.activationS)) {
            return `margin wrong on ${m.id} at lead ${lead}`;
          }
        }
      }
      return null;
    },
  },
  {
    id: 'per100k-arithmetic',
    name: 'Risk reduction per $100k matches cost arithmetic',
    run() {
      for (const m of compareInterventions({ lead: 6, mmi: 6.4 })) {
        if (!near(m.per100k, m.damageReductionPct / (m.costUsd / 100000))) {
          return `per-100k wrong on ${m.id}`;
        }
      }
      return null;
    },
  },
  {
    id: 'relevance-ramp',
    name: 'Damage relevance ramps 0 to 1 across MMI 5.2 to 7.8',
    run() {
      if (!near(damageRelevance(5.2), 0) || !near(damageRelevance(7.8), 1)) return 'ramp endpoints wrong';
      if (!near(damageRelevance(6.5), 0.5)) return 'ramp midpoint wrong';
      if (damageRelevance(3) !== 0 || damageRelevance(12) !== 1) return 'ramp clamps wrong';
      return null;
    },
  },
  {
    id: 'csv-escape',
    name: 'CSV escaping neutralizes formulas and keeps numbers numeric',
    run() {
      if (csvCell('=1+1') !== `"'=1+1"`) return 'formula not prefixed';
      if (csvCell(' =cmd') !== `"' =cmd"`) return 'whitespace prefix slipped through';
      if (csvCell(-2.375) !== '-2.375') return 'number lost numeric form';
      if (csvCell('a"b') !== '"a""b"') return 'quote not doubled';
      return null;
    },
  },
  {
    id: 'canonical-json',
    name: 'Canonical JSON sorts keys recursively and serializes deterministically',
    run() {
      const a = canonicalJSON({ b: [2, { d: 1, c: 2 }], a: 1 });
      if (a !== '{"a":1,"b":[2,{"c":2,"d":1}]}') return `bad order: ${a}`;
      if (canonicalJSON({ x: [1, 2] }) !== canonicalJSON({ x: [1, 2] })) return 'not deterministic';
      return null;
    },
  },
  {
    id: 'sha256-kat',
    name: 'Pure-JS SHA-256 matches FIPS 180-4 known answers',
    run() {
      const vectors = [
        ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ['The quick brown fox jumps over the lazy dog',
          'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
        ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
          '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
        ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
      ];
      for (const [msg, want] of vectors) {
        const got = sha256Hex(msg);
        if (got !== want) return `digest ${got.slice(0, 16)}... != ${want.slice(0, 16)}...`;
      }
      return null;
    },
  },
  {
    id: 'tamper-detect',
    name: 'Editing any payload field changes the digest',
    run() {
      const payload = { a: 1, lab: { distanceKm: 60 } };
      const digest = sha256Hex(canonicalJSON(payload));
      for (const change of [
        { ...payload, a: 2 },
        { ...payload, lab: { distanceKm: 61 } },
        { ...payload, extra: 0 },
      ]) {
        if (sha256Hex(canonicalJSON(change)) === digest) return 'edit went undetected';
      }
      return null;
    },
  },
  {
    id: 'bookmark-roundtrip',
    name: 'Bookmark links encode and decode strictly',
    run() {
      const state = { v: 1, p: 'urban', lat: 1.5, k: 5, vel: 'layered', snr: 12, dep: 8, ex: -20, ey: 9, dns: true, fst: false, lab: { d: 120, soil: 'E' } };
      const token = encodeState(state);
      if (!/^qs=[A-Za-z0-9_-]+$/.test(token)) return 'token not strict base64url';
      const back = decodeState(`#${token}`);
      if (canonicalJSON(back) !== canonicalJSON(state)) return 'round trip changed state';
      for (const bad of ['#qs=!!!', '#qs=AAAA', '#other=abc', '']) {
        if (decodeState(bad) !== null) return `accepted ${bad}`;
      }
      return null;
    },
  },
];

export function runSelfTests() {
  return CHECKS.map(c => {
    try {
      const detail = c.run();
      return { id: c.id, name: c.name, ok: detail === null, detail: detail ?? 'pass' };
    } catch (err) {
      return { id: c.id, name: c.name, ok: false, detail: err.message };
    }
  });
}
