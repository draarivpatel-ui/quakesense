// Seismic readiness brief: a checksummed snapshot of the configured run
// plus the distance-lab readout and preparedness comparator. The SHA-256
// is computed by the in-repo FIPS 180-4 implementation over canonical
// JSON. It is an unkeyed tamper-detection digest, honestly labeled: not a
// signature, not a proof of authenticity, and not live telemetry.

import { canonicalJSON, csvCell } from './exports.js';
import { sha256Hex } from './sha256.js';
import {
  arrivalAt, blindRadiusKm, compareInterventions, groundMotion, warningLead,
} from './seismic-lab.js';

const alertSinceOrigin = run =>
  run.alert === null ? null : run.alert - (run.source.t0 ?? 0);

export function labReadout(run, { distanceKm, soilId }) {
  const model = run.model;
  const depthKm = run.source.z;
  const a0 = alertSinceOrigin(run);
  const gm = groundMotion(run.source.magnitude, distanceKm, depthKm, soilId);
  const { lead } = warningLead(distanceKm, depthKm, a0, model);
  return {
    distanceKm, soilId: gm.soil.id, soilName: gm.soil.name, soilFactor: gm.soil.factor,
    tP: arrivalAt(distanceKm, depthKm, 'P', model),
    tS: arrivalAt(distanceKm, depthKm, 'S', model),
    alertS: a0, leadS: lead,
    blindRadiusKm: blindRadiusKm(a0, depthKm, model),
    mmi: gm.mmi, mmiRock: gm.mmiRock, pgaG: gm.pgaG,
    interventions: compareInterventions({ lead, mmi: gm.mmi }).map(m => ({
      id: m.id, name: m.name, mode: m.mode, activationS: m.activationS,
      armedShare: m.armedShare, marginS: m.marginS,
      damageReductionPct: m.damageReductionPct, casualtyReductionPct: m.casualtyReductionPct,
      costUsd: m.costUsd, per100k: m.per100k,
    })),
  };
}

export function buildBriefPayload(run, lab) {
  const readout = labReadout(run, lab);
  return {
    version: 1,
    tool: 'QuakeSense readiness brief',
    synthetic: true,
    scenario: run.presetId,
    seed: run.seed,
    source: { x: run.source.x, y: run.source.y, z: run.source.z, t0: run.source.t0, magnitude: run.source.magnitude },
    model: run.model.id,
    settings: {
      triggerCount: run.settings.triggerCount, latencyS: run.settings.latency, snr: run.settings.snr,
    },
    alertS: run.alert,
    blindRadiusKm: run.blind.radius,
    blindAreaKm2: run.blind.area,
    stations: run.stations.map(s => ({ id: s.id, detectedS: s.detected })),
    sites: run.sites.map(s => ({ id: s.id, name: s.name, kind: s.kind, leadS: s.lead, mmi: s.mmi })),
    lab: readout,
    disclaimer: 'Planning-model estimates from a synthetic exercise. Not a live warning, not a calibrated loss forecast, not engineering design guidance, and not a replacement for USGS ShakeAlert.',
  };
}

export function makeBrief(run, lab) {
  const payload = buildBriefPayload(run, lab);
  return {
    algorithm: 'SHA-256',
    digestNote: 'Unkeyed tamper-detection digest over the canonical JSON payload. It detects edits after export; it is not a signature and proves nothing about who wrote the file.',
    serialization: 'ecmascript-json-sorted-keys-v1',
    sha256: sha256Hex(canonicalJSON(payload)),
    payload,
  };
}

export function verifyBrief(brief) {
  if (!brief || typeof brief !== 'object' || typeof brief.sha256 !== 'string') return false;
  try {
    return sha256Hex(canonicalJSON(brief.payload)) === brief.sha256.toLowerCase();
  } catch {
    return false;
  }
}

// Honest demonstration for the classroom panel: flip one field and show
// that the recomputed digest no longer matches the recorded one.
export function tamperBrief(brief) {
  const copy = JSON.parse(JSON.stringify(brief.payload));
  const before = canonicalJSON(copy);
  copy.lab.distanceKm += 1;
  const after = canonicalJSON(copy);
  return {
    changedField: 'lab.distanceKm (+1 km)',
    originalSha256: sha256Hex(before),
    tamperedSha256: sha256Hex(after),
    detected: sha256Hex(after) !== brief.sha256,
  };
}

export function briefToCSV(payload) {
  const rows = [
    ['record_type', 'key', 'value'],
    ['meta', 'tool', payload.tool],
    ['meta', 'synthetic', payload.synthetic],
    ['meta', 'scenario', payload.scenario],
    ['meta', 'model', payload.model],
    ['meta', 'alert_s', payload.alertS],
    ['meta', 'blind_radius_km', payload.blindRadiusKm],
    ['lab', 'distance_km', payload.lab.distanceKm],
    ['lab', 'soil', payload.lab.soilName],
    ['lab', 'p_arrival_s', payload.lab.tP],
    ['lab', 's_arrival_s', payload.lab.tS],
    ['lab', 'lead_s', payload.lab.leadS],
    ['lab', 'mmi', payload.lab.mmi],
    ['lab', 'pga_g', payload.lab.pgaG],
    ['lab', 'blind_radius_km', payload.lab.blindRadiusKm],
    ...payload.sites.map(s => ['site', `${s.id} ${s.name} ${s.kind} lead_s`, s.leadS]),
    ...payload.lab.interventions.flatMap(m => [
      [`intervention ${m.id}`, 'armed_share', m.armedShare],
      [`intervention ${m.id}`, 'margin_s', m.marginS ?? 'always'],
      [`intervention ${m.id}`, 'damage_reduction_pct', m.damageReductionPct],
      [`intervention ${m.id}`, 'casualty_reduction_pct', m.casualtyReductionPct],
      [`intervention ${m.id}`, 'cost_usd', m.costUsd],
      [`intervention ${m.id}`, 'per_100k', m.per100k],
    ]),
    ['meta', 'disclaimer', payload.disclaimer],
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function briefToMarkdown(payload) {
  const f = (v, d = 2) => v === null || v === undefined ? 'n/a' : Number(v).toFixed(d);
  const money = v => `$${Math.round(v).toLocaleString('en-US')}`;
  const lines = [
    `# ${payload.tool}`,
    '',
    `Synthetic planning exercise (${payload.scenario}). ${payload.disclaimer}`,
    '',
    '## Scenario',
    '',
    '| Quantity | Value |',
    '| --- | --- |',
    `| Source | (${f(payload.source.x, 1)}, ${f(payload.source.y, 1)}) km, depth ${f(payload.source.z, 1)} km, M ${f(payload.source.magnitude, 1)} |`,
    `| Velocity model | ${payload.model} |`,
    `| Alert | ${payload.alertS === null ? 'no alert' : `${f(payload.alertS)} s`} |`,
    `| Blind radius | ${payload.blindRadiusKm === null ? 'n/a' : `${f(payload.blindRadiusKm, 1)} km`} |`,
    '',
    `## Distance lab at ${f(payload.lab.distanceKm, 0)} km on ${payload.lab.soilName}`,
    '',
    '| Quantity | Value |',
    '| --- | --- |',
    `| P arrival | ${f(payload.lab.tP)} s |`,
    `| S arrival | ${f(payload.lab.tS)} s |`,
    `| Usable lead | ${payload.lab.leadS === null ? 'no alert' : `${f(payload.lab.leadS)} s`} |`,
    `| MMI (site class adjusted) | ${f(payload.lab.mmi, 1)} |`,
    `| PGA (site class adjusted) | ${f(payload.lab.pgaG, 3)} g |`,
    '',
    '## Preparedness comparator (planning-model estimates)',
    '',
    '| Intervention | Mode | Margin | Damage risk reduction | Casualty risk reduction | Cost | Per $100k |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...payload.lab.interventions.map(m =>
      `| ${m.name} | ${m.mode} | ${m.marginS === null ? (m.mode === 'passive' ? 'always installed' : 'no alert') : `${f(m.marginS, 1)} s`} | ${f(m.damageReductionPct, 1)}% | ${f(m.casualtyReductionPct, 1)}% | ${money(m.costUsd)} | ${f(m.per100k, 2)} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
