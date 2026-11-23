// Distance-domain early-warning lab: arrivals, lead time, the blind radius,
// soil-class ground motion and the deterministic preparedness comparator.
// Every quantity is a disclosed planning-model estimate computed from the
// same velocity model as the workbench; none of it is measured telemetry,
// a calibrated loss model, or engineering design guidance.

import { arrival, intensity, UNIFORM, waveRadius } from './seismology.js';

export const LAB_DMAX = 250;

const validRange = (r, z) => Number.isFinite(r) && r >= 0 && Number.isFinite(z) && z >= 0;

export function arrivalAt(distanceKm, depthKm, phase, model = UNIFORM) {
  if (!validRange(distanceKm, depthKm)) {
    throw new RangeError('Distance and depth must be finite and nonnegative');
  }
  return arrival({ x: 0, y: 0, z: depthKm, t0: 0 }, { x: distanceKm, y: 0 }, phase, model).time;
}

// Usable warning at a site: S arrival minus the alert instant, clipped at
// zero. Seconds since origin on both sides; null alert means no warning.
export function warningLead(distanceKm, depthKm, alertS, model = UNIFORM) {
  const s = arrivalAt(distanceKm, depthKm, 'S', model);
  if (alertS === null) return { s, lead: null };
  if (!Number.isFinite(alertS)) throw new RangeError('Alert time must be null or finite');
  return { s, lead: Math.max(0, s - alertS) };
}

// Surface distance where the S front has already arrived when the alert
// goes out. Null alert means there is no blind boundary, not a zero one.
export function blindRadiusKm(alertS, depthKm, model = UNIFORM) {
  if (alertS === null) return null;
  if (!Number.isFinite(alertS) || !Number.isFinite(depthKm) || depthKm < 0) {
    throw new RangeError('Alert time must be finite and depth nonnegative');
  }
  return waveRadius(alertS, depthKm, 'S', model) ?? 0;
}

// NEHRP-style site classes as fixed planning amplification factors on PGA.
export const SOIL_CLASSES = Object.freeze([
  Object.freeze({ id: 'B', name: 'Rock B', factor: 1, note: 'firm rock reference site' }),
  Object.freeze({ id: 'C', name: 'Stiff Soil C', factor: 1.35, note: 'very dense soil or soft rock' }),
  Object.freeze({ id: 'D', name: 'Stiff Soil D', factor: 1.7, note: 'stiff soil profile' }),
  Object.freeze({ id: 'E', name: 'Soft Basin E', factor: 2.2, note: 'soft basin soil, strongest amplification' }),
]);

export function soilById(id) {
  const soil = SOIL_CLASSES.find(s => s.id === id);
  if (!soil) throw new RangeError(`Unknown site class ${String(id)}`);
  return soil;
}

// A fixed illustrative PGA-MMI mapping in the spirit of published
// intensity-amplitude relations: MMI = 1.66 * log10(PGA_cm_s2) + 3.66,
// clamped to the 1..12 scale. Both directions are exported so the soil
// factor moves MMI and PGA consistently by the same curve.
export const PGA_MMI = Object.freeze({ slope: 1.66, offset: 3.66, cms2PerG: 980.665 });

export function pgaCms2FromMmi(mmi) {
  if (!Number.isFinite(mmi)) throw new RangeError('Intensity must be finite');
  return 10 ** ((mmi - PGA_MMI.offset) / PGA_MMI.slope);
}

export function mmiFromPgaCms2(pga) {
  if (!Number.isFinite(pga) || pga <= 0) throw new RangeError('PGA must be positive and finite');
  return Math.min(12, Math.max(1, PGA_MMI.slope * Math.log10(pga) + PGA_MMI.offset));
}

export function groundMotion(magnitude, distanceKm, depthKm, soilId = 'B') {
  const soil = soilById(soilId);
  if (!Number.isFinite(magnitude) || !validRange(distanceKm, depthKm)) {
    throw new RangeError('Magnitude, distance and depth must be finite and nonnegative');
  }
  const mmiRock = intensity(magnitude, Math.hypot(distanceKm, depthKm));
  const pgaCms2 = pgaCms2FromMmi(mmiRock) * soil.factor;
  return { mmi: mmiFromPgaCms2(pgaCms2), mmiRock, pgaCms2, pgaG: pgaCms2 / PGA_MMI.cms2PerG, soil };
}

// One row per distance step: arrivals, usable lead and ground motion.
export function distanceProfile({ magnitude, depthKm, alertS = null, soilId = 'B', model = UNIFORM, dMax = LAB_DMAX, points = 81 } = {}) {
  soilById(soilId);
  if (!Number.isFinite(magnitude) || !validRange(dMax, depthKm) || dMax <= 0 ||
      !Number.isInteger(points) || points < 2 || (alertS !== null && !Number.isFinite(alertS))) {
    throw new RangeError('Invalid profile parameters');
  }
  const rows = [];
  for (let i = 0; i < points; i++) {
    const r = dMax * i / (points - 1);
    const tP = arrivalAt(r, depthKm, 'P', model);
    const tS = arrivalAt(r, depthKm, 'S', model);
    const gm = groundMotion(magnitude, r, depthKm, soilId);
    rows.push({ r, tP, tS, lead: alertS === null ? null : Math.max(0, tS - alertS), mmi: gm.mmi, pgaG: gm.pgaG });
  }
  return { rows, magnitude, depthKm, alertS, soilId, modelId: model.id, dMax };
}

// Damage only accrues where shaking is damaging: a disclosed linear ramp
// from zero at MMI 5.2 to full at MMI 7.8.
export function damageRelevance(mmi) {
  if (!Number.isFinite(mmi)) throw new RangeError('Intensity must be finite');
  return Math.min(1, Math.max(0, (mmi - 5.2) / 2.6));
}

// Deterministic planning interventions. `damage` and `casualty` are the
// avoided fractions of the relevant baseline risk when the measure is
// fully armed; `activationS` is the warning time an EEW-triggered measure
// needs to complete; `passiveShare` is the fraction of a hybrid package
// that works even without warning. Costs are rough classroom estimates.
export const INTERVENTIONS = Object.freeze([
  Object.freeze({
    id: 'gas-shutoff', name: 'Automatic gas shutoff valve', mode: 'eew',
    activationS: 2.5, costUsd: 1500, damage: 0.5, casualty: 0.12,
    note: 'Closes the service line on alert; mainly cuts fire and leak losses.',
  }),
  Object.freeze({
    id: 'urm-bracing', name: 'Unreinforced masonry bracing', mode: 'passive',
    activationS: 0, costUsd: 85000, damage: 0.42, casualty: 0.5,
    note: 'Passive strengthening of bearing walls and parapets; armed with or without an alert.',
  }),
  Object.freeze({
    id: 'base-isolation', name: 'Base isolation', mode: 'passive',
    activationS: 0, costUsd: 2800000, damage: 0.68, casualty: 0.72,
    note: 'Passive bearings decouple the structure from ground motion; largest modeled reduction.',
  }),
  Object.freeze({
    id: 'elevator-park', name: 'Automated hospital elevator park', mode: 'eew',
    activationS: 5, costUsd: 40000, damage: 0.18, casualty: 0.3,
    note: 'Cars park at the nearest floor and critical systems safe themselves before S waves arrive.',
  }),
  Object.freeze({
    id: 'community-package', name: 'Community resilience package', mode: 'hybrid',
    activationS: 4, costUsd: 350000, damage: 0.6, casualty: 0.65, passiveShare: 0.55,
    note: 'Bracing, shutoffs and drills combined; the passive share works even with no warning.',
  }),
]);

export function compareInterventions({ lead = null, mmi } = {}) {
  if (!Number.isFinite(mmi) || (lead !== null && (!Number.isFinite(lead) || lead < 0))) {
    throw new RangeError('Lead must be null or nonnegative and intensity must be finite');
  }
  const rel = damageRelevance(mmi);
  return INTERVENTIONS.map(m => {
    const triggered = m.mode !== 'passive' && lead !== null && lead >= m.activationS;
    const armedShare = m.mode === 'passive' ? 1
      : m.mode === 'eew' ? (triggered ? 1 : 0)
      : m.passiveShare + (1 - m.passiveShare) * (triggered ? 1 : 0);
    const marginS = m.mode === 'passive' ? null : lead === null ? null : lead - m.activationS;
    const damageReductionPct = m.damage * armedShare * rel * 100;
    const casualtyReductionPct = m.casualty * armedShare * rel * 100;
    return {
      id: m.id, name: m.name, mode: m.mode, activationS: m.activationS, costUsd: m.costUsd,
      armed: armedShare > 0, armedShare, marginS, relevance: rel,
      damageReductionPct, casualtyReductionPct,
      per100k: damageReductionPct / (m.costUsd / 100000),
      note: m.note,
    };
  });
}
