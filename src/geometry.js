// Interactive House Explorer — plan geometry.
// Pure functions with no Three.js dependency: the browser viewer and tools/check-model.mjs
// both use this module, so the 2D plan, the 3D walls and the checks share one interpretation.
//
// Plan coordinates are metres: x left→right, z toward the provisional road/front, y up.
// A wall "line" with axis 'x' is the line x = at (running along z); axis 'z' is z = at.

const TOL = 1e-4;
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;

export const ZONES = ['social', 'private', 'wet', 'service', 'circulation', 'future'];

export function mergeSpans(spans) {
  const sorted = spans.map(s => [...s]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + TOL) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}

function subtractSpans(span, cuts) {
  let pieces = [span];
  for (const [c0, c1] of cuts) {
    pieces = pieces.flatMap(([a, b]) => {
      if (c1 <= a + TOL || c0 >= b - TOL) return [[a, b]];
      const res = [];
      if (c0 > a + TOL) res.push([a, c0]);
      if (c1 < b - TOL) res.push([c1, b]);
      return res;
    });
  }
  return pieces;
}

// Rooms, plus the entrance pad, addressable by id for openings.
export function spacesById(plan) {
  const map = Object.fromEntries(plan.rooms.map(r => [r.id, r]));
  if (plan.site?.entry) map.entry = { id: 'entry', label: plan.site.entry.label, ...plan.site.entry };
  return map;
}

export function sharedEdge(a, b) {
  for (const [ax, bx] of [[a.x1, b.x0], [a.x0, b.x1]]) {
    if (near(ax, bx)) {
      const from = Math.max(a.z0, b.z0), to = Math.min(a.z1, b.z1);
      if (to - from > TOL) return { axis: 'x', at: ax, from, to };
    }
  }
  for (const [az, bz] of [[a.z1, b.z0], [a.z0, b.z1]]) {
    if (near(az, bz)) {
      const from = Math.max(a.x0, b.x0), to = Math.min(a.x1, b.x1);
      if (to - from > TOL) return { axis: 'z', at: az, from, to };
    }
  }
  return null;
}

function isEnvelopeLine(plan, axis, at) {
  const E = plan.envelope;
  return axis === 'x' ? near(at, E.x0) || near(at, E.x1) : near(at, E.z0) || near(at, E.z1);
}

// Every room-cell edge becomes a wall centreline (interior) or outer face (envelope).
export function wallLines(plan) {
  const P = plan.parameters;
  const lines = new Map();
  const add = (axis, at, from, to) => {
    const key = `${axis}:${at.toFixed(4)}`;
    if (!lines.has(key)) lines.set(key, { axis, at, exterior: isEnvelopeLine(plan, axis, at), spans: [] });
    lines.get(key).spans.push([from, to]);
  };
  for (const r of plan.rooms) {
    add('x', r.x0, r.z0, r.z1);
    add('x', r.x1, r.z0, r.z1);
    add('z', r.z0, r.x0, r.x1);
    add('z', r.z1, r.x0, r.x1);
  }
  return [...lines.values()].map(l => ({
    ...l,
    spans: mergeSpans(l.spans),
    thickness: l.exterior ? P.exteriorWallThickness : P.interiorWallThickness,
  }));
}

// Perpendicular extent [lo, hi] of a wall line: exterior walls sit inside the envelope face,
// interior walls are centred on their line.
export function wallBand(plan, line) {
  const E = plan.envelope, t = line.thickness;
  if (line.exterior) {
    if (line.axis === 'x') return near(line.at, E.x0) ? [line.at, line.at + t] : [line.at - t, line.at];
    return near(line.at, E.z0) ? [line.at, line.at + t] : [line.at - t, line.at];
  }
  return [line.at - t / 2, line.at + t / 2];
}

// Space taken at one end of an opening's shared edge by a wall meeting it there.
function endAllowance(lines, edge, c) {
  const perpAxis = edge.axis === 'x' ? 'z' : 'x';
  const meeting = lines.find(l => l.axis === perpAxis && near(l.at, c) &&
    l.spans.some(([a, b]) => edge.at >= a - TOL && edge.at <= b + TOL));
  if (!meeting) return 0;
  return meeting.exterior ? meeting.thickness : meeting.thickness / 2;
}

export function placeOpenings(plan) {
  const P = plan.parameters;
  const lines = wallLines(plan);
  const spaces = spacesById(plan);
  return plan.openings.map(o => {
    const [a, b] = o.between.map(id => spaces[id]);
    const res = { ...o, fits: false, problem: null };
    if (!a || !b) return { ...res, problem: `unknown space id in ${o.between.join('–')}` };
    const edge = sharedEdge(a, b);
    if (!edge) return { ...res, problem: `${o.between.join(' and ')} do not share a wall` };
    const line = lines.find(l => l.axis === edge.axis && near(l.at, edge.at));
    if (!line) return { ...res, problem: 'no wall line on the shared edge' };
    const lo = edge.from + endAllowance(lines, edge, edge.from);
    const hi = edge.to - endAllowance(lines, edge, edge.to);
    const usable = hi - lo;
    const centre = o.along ?? (lo + hi) / 2;
    const fits = o.width + 2 * P.minimumNib <= usable + TOL &&
      centre - o.width / 2 >= lo - TOL && centre + o.width / 2 <= hi + TOL;
    return {
      ...res, edge, line, usable, centre, fits,
      problem: fits ? null : `needs ${o.width.toFixed(2)} m but only ${Math.max(usable, 0).toFixed(2)} m of shared wall is usable`,
    };
  });
}

// Wall pieces after cutting fitting openings, plus lintels above them (heights relative to finished floor).
export function wallPieces(plan, openings = placeOpenings(plan)) {
  const P = plan.parameters;
  const pieces = [];
  for (const line of wallLines(plan)) {
    const band = wallBand(plan, line);
    const cuts = openings
      .filter(o => o.fits && o.line.axis === line.axis && near(o.line.at, line.at))
      .map(o => [o.centre - o.width / 2, o.centre + o.width / 2]);
    for (const span of line.spans) {
      for (const [from, to] of subtractSpans(span, cuts)) {
        pieces.push({ kind: 'wall', axis: line.axis, at: line.at, exterior: line.exterior, from, to, band, y0: 0, y1: P.wallHeight });
      }
    }
    for (const o of openings.filter(o => o.fits && o.line.axis === line.axis && near(o.line.at, line.at))) {
      const head = o.kind === 'opening' ? P.openingHeadHeight : P.doorHeadHeight;
      pieces.push({ kind: 'lintel', axis: line.axis, at: line.at, exterior: line.exterior, from: o.centre - o.width / 2, to: o.centre + o.width / 2, band, y0: head, y1: P.wallHeight, opening: o.id });
    }
  }
  return pieces;
}

// Plan-space rectangle [x0, z0, x1, z1] covered by a wall piece.
export function pieceRect(p) {
  return p.axis === 'x' ? [p.band[0], p.from, p.band[1], p.to] : [p.from, p.band[0], p.to, p.band[1]];
}

const rectArea = r => (r.x1 - r.x0) * (r.z1 - r.z0);

export function compositionBox(plan) {
  const items = [plan.envelope, plan.site?.carport, plan.site?.entry, plan.site?.garden].filter(Boolean);
  return {
    x0: Math.min(...items.map(i => i.x0)), z0: Math.min(...items.map(i => i.z0)),
    x1: Math.max(...items.map(i => i.x1)), z1: Math.max(...items.map(i => i.z1)),
  };
}

// Three different area measures; none is a surveyed or contractual area.
export function areas(plan) {
  const E = plan.envelope, P = plan.parameters;
  const allowance = (v, lo, hi) => (near(v, lo) || near(v, hi) ? P.exteriorWallThickness : P.interiorWallThickness / 2);
  const rooms = plan.rooms.map(r => {
    const cellW = r.x1 - r.x0, cellD = r.z1 - r.z0;
    const clearW = cellW - allowance(r.x0, E.x0, E.x1) - allowance(r.x1, E.x0, E.x1);
    const clearD = cellD - allowance(r.z0, E.z0, E.z1) - allowance(r.z1, E.z0, E.z1);
    return { id: r.id, label: r.label, zone: r.zone, cellW, cellD, cellArea: cellW * cellD, clearW, clearD, clearArea: clearW * clearD };
  });
  const box = compositionBox(plan);
  const sum = (k) => rooms.reduce((s, r) => s + r[k], 0);
  const site = plan.site || {};
  return {
    compositionBox: { ...box, w: box.x1 - box.x0, d: box.z1 - box.z0, area: rectArea(box) },
    enclosed: { w: E.x1 - E.x0, d: E.z1 - E.z0, area: rectArea(E), sqft: rectArea(E) / 0.09290304 },
    rooms,
    cellTotal: sum('cellArea'),
    clearTotal: sum('clearArea'),
    wallAndJunctionArea: rectArea(E) - sum('clearArea'),
    outdoor: ['carport', 'entry', 'garden'].filter(k => site[k]).map(k => ({
      id: k, label: site[k].label, w: site[k].x1 - site[k].x0, d: site[k].z1 - site[k].z0, area: rectArea(site[k]),
    })),
  };
}

// ---------- Optional access scenario (site.access, from V1.2) ----------
// All inputs are ASSUMED visualization parameters; nothing here is a clearance, gradient-compliance,
// retaining, drainage or legal check.
//
// V1.2 datasets use `waitingZone`: the gate sits at its inner end and the climb starts at the gate.
// V1.3+ datasets set the gate, the level entrance apron/ramp start and the waiting position
// independently. Both are normalised here so the viewer and checks share one interpretation.
function accessParams(a) {
  if (a.waitingZone) {
    const t = a.ramp.transitionLength;
    return {
      gateSetback: a.waitingZone.length, rampStartSetback: a.waitingZone.length, apronLevel: a.waitingZone.level,
      bottomTransition: t, topTransition: t, waitingGap: null, apronLabel: 'Waiting zone (level, ASSUMED)',
    };
  }
  return {
    gateSetback: a.gate.setbackFromLandEdge, rampStartSetback: a.ramp.startSetbackFromLandEdge,
    apronLevel: a.entrance.apronLevel, bottomTransition: a.ramp.bottomTransition, topTransition: a.ramp.topTransition,
    waitingGap: a.waiting.gapToGate, apronLabel: 'Entrance apron (level, ASSUMED)',
  };
}

// Plan rectangles for the corridor, level apron, off-road space outside the gate, gate opening and
// both possible slide pockets, ramp run, pedestrian gate and the two vehicle-envelope positions.
export function accessLayout(plan) {
  const s = plan.site, a = s?.access;
  if (!a) return null;
  const k = accessParams(a);
  const cp = s.carport, g = a.gate;
  const corridor = { x0: a.corridor.x0, x1: a.corridor.x1, z0: cp.z1, z1: s.landEdgeZ };
  const gateZ = s.landEdgeZ - k.gateSetback;
  const rampStartZ = s.landEdgeZ - k.rampStartSetback;
  const apron = { x0: corridor.x0, x1: corridor.x1, z0: rampStartZ, z1: s.landEdgeZ };
  const waitingSpace = { x0: corridor.x0, x1: corridor.x1, z0: gateZ, z1: s.landEdgeZ };   // off-road, outside the gate
  const cx = (corridor.x0 + corridor.x1) / 2;
  const opening = { x0: cx - g.clearOpening / 2, x1: cx + g.clearOpening / 2 };
  const leafLength = g.clearOpening + g.leafOverlap;
  const band = { z0: gateZ - g.trackDepth / 2, z1: gateZ + g.trackDepth / 2 };
  const pockets = {
    left: { side: 'left', x0: opening.x0 - leafLength, x1: opening.x0, ...band },
    right: { side: 'right', x0: opening.x1, x1: opening.x1 + leafLength, ...band },
  };
  const pg = a.pedestrianGate;
  const veh = plan.parameters.vehicleEnvelope;
  // The waiting vehicle stands just outside the gate: centred in the off-road space when it fits
  // (V1.2), otherwise its front is `waitingGap` from the gate and it runs out over the drain/road.
  const spare = k.gateSetback - veh.length;
  const waitingFits = spare >= 0;
  const front = gateZ + (waitingFits ? spare / 2 : k.waitingGap ?? 0);
  return {
    corridor, apron, waitingSpace, gateZ, rampStartZ, opening, leafLength, waitingFits,
    pocket: pockets[g.slideTo], otherPocket: pockets[g.slideTo === 'left' ? 'right' : 'left'],
    ramp: { z0: cp.z1, z1: rampStartZ, run: rampStartZ - cp.z1, bottomTransition: k.bottomTransition, topTransition: k.topTransition },
    waitingLevel: k.apronLevel, apronLabel: k.apronLabel,
    pedestrianGate: { x0: pg.x - pg.width / 2, x1: pg.x + pg.width / 2, z0: s.landEdgeZ - 0.2, z1: s.landEdgeZ },
    waitingCar: { x0: cx - veh.width / 2, x1: cx + veh.width / 2, z0: front, z1: front + veh.length },
    parkedCar: { x0: (cp.x0 + cp.x1) / 2 - veh.width / 2, x1: (cp.x0 + cp.x1) / 2 + veh.width / 2,
      z0: (cp.z0 + cp.z1) / 2 - veh.length / 2, z1: (cp.z0 + cp.z1) / 2 + veh.length / 2 },
  };
}

// Transition lengths are limited so they never overlap on a short run.
function transitions(layout) {
  const R = layout.ramp.run;
  let tb = layout.ramp.bottomTransition, tt = layout.ramp.topTransition;
  if (tb + tt > R) { const f = R / (tb + tt); tb *= f; tt *= f; }
  return { tb, tt };
}

// Peak slope of the drawn ramp (rise per metre of run) for a given land level.
export function rampPeakSlope(layout, land) {
  const { tb, tt } = transitions(layout);
  return (land - layout.waitingLevel) / (layout.ramp.run - (tb + tt) / 2);
}

// Height of the provisional ramp surface at plan z: level apron → parabolic bottom transition →
// straight section → parabolic top transition → level carport at land level. A drawn shape only.
export function rampHeight(layout, land, z) {
  const W = layout.waitingLevel, R = layout.ramp.run;
  const { tb, tt } = transitions(layout);
  const g = rampPeakSlope(layout, land);
  const u = layout.rampStartZ - z;
  if (u <= 0) return W;
  if (u >= R) return land;
  if (u < tb) return W + g * u * u / (2 * tb);
  if (u > R - tt) { const v = R - u; return land - g * v * v / (2 * tt); }
  return W + g * tb / 2 + g * (u - tb);
}

export function accessProfile(plan, land, samples = 64) {
  const L = accessLayout(plan);
  if (!L) return null;
  const ramp = [];
  for (let i = 0; i <= samples; i++) {
    const z = L.rampStartZ - (L.ramp.run * i) / samples;
    ramp.push([z, rampHeight(L, land, z)]);
  }
  return { layout: L, ramp };
}

// Metrics and conflicts for one land level. Errors: the scenario contradicts itself. Warnings:
// unresolved access issues that must stay visible. Checks are visual footprint checks only.
export function accessReport(plan, land) {
  const L = accessLayout(plan);
  if (!L) return null;
  const s = plan.site, a = s.access, E = plan.envelope, P = plan.parameters, veh = P.vehicleEnvelope;
  const errors = [], warnings = [], checks = [];
  const f2 = n => n.toFixed(2);
  const named = { 'house envelope': E, 'entrance pad': s.entry, garden: s.garden };
  for (const [what, r] of [['carport', s.carport], ['approach corridor', L.corridor]]) {
    for (const [n, o] of Object.entries(named)) if (o && overlapArea(r, o) > 0) errors.push(`${what} overlaps ${n}`);
  }
  if (overlapArea(L.pedestrianGate, L.corridor) > 0) errors.push('pedestrian gate overlaps the vehicle corridor');
  if (L.opening.x0 < L.corridor.x0 - TOL || L.opening.x1 > L.corridor.x1 + TOL) errors.push('gate opening is wider than the corridor');
  if (L.ramp.run <= 0) errors.push('ramp start leaves no climbing run before the carport');
  if (L.gateZ >= s.landEdgeZ || L.gateZ <= L.ramp.z0) errors.push('gate is not between the land edge and the carport');

  const rise = land - L.waitingLevel;
  const peak = rampPeakSlope(L, land);
  const surfaceAt = z => rampHeight(L, land, z);
  const slopeAt = z => Math.abs(surfaceAt(z - 0.01) - surfaceAt(z + 0.01)) / 0.02;
  const houseFrontZ = Math.min(E.z1, s.landEdgeZ);
  const metrics = {
    carportRearwardShift: a.carportRearwardShift,
    corridorLength: L.corridor.z1 - L.corridor.z0,
    gateSetback: s.landEdgeZ - L.gateZ,
    apronLength: s.landEdgeZ - L.rampStartZ,
    rampRun: L.ramp.run, rise,
    averageGradientPct: (rise / L.ramp.run) * 100,
    maxLocalGradientPct: peak * 100,
    gateSurfaceSlopePct: slopeAt(L.gateZ) * 100,
    cutDepthAtLandEdge: land - L.waitingLevel,
    cutDepthAtHouseFront: land - surfaceAt(houseFrontZ),
    cutDepthAtGate: land - surfaceAt(L.gateZ),
    corridorToHouse: E.x0 - L.corridor.x1,
    carportSpareLength: (s.carport.z1 - s.carport.z0) - veh.length,
    carportSpareWidth: (s.carport.x1 - s.carport.x0) - veh.width,
    waitingSpareLength: (s.landEdgeZ - L.gateZ) - veh.length,
    waitingOverhang: Math.max(0, L.waitingCar.z1 - s.landEdgeZ),
    gateOpeningSpare: L.opening.x1 - L.opening.x0 - veh.width,
    landX0: compositionBox(plan).x0 - P.landMarginShown,
    landX1: compositionBox(plan).x1 + P.landMarginShown,
  };
  const rampMid = [(L.corridor.x0 + L.corridor.x1) / 2, (L.ramp.z0 + L.ramp.z1) / 2];

  warnings.push({ id: 'ramp', at: rampMid, level: 'ramp',
    text: `Ramp clearance UNCHECKED. Drawn rise ${f2(rise)} m over a ${f2(L.ramp.run)} m climbing run: average ${metrics.averageGradientPct.toFixed(1)}%, maximum local gradient ${metrics.maxLocalGradientPct.toFixed(1)}% (drawn shape; arithmetic only — not a bumper, breakover, approach/departure, gradient-compliance or drainage test)` });
  warnings.push({ id: 'cut', at: [L.corridor.x1, (L.corridor.z0 + L.corridor.z1) / 2], level: 'land',
    text: `Approach is cut up to ${f2(metrics.cutDepthAtLandEdge)} m into the raised land at the entrance and ${f2(metrics.cutDepthAtHouseFront)} m at the house front line, ${f2(metrics.corridorToHouse)} m from the house wall face; excavation, retaining, foundations and drainage unresolved` });

  // Sliding-gate pockets: both directions are assessed; the dataset's slideTo is the one drawn.
  const ped = s.pedestrianRoute.points;
  const pedX = ped[0][0], pedZ0 = Math.min(...ped.map(p => p[1])), pedZ1 = Math.max(s.roadEdgeZ, ...ped.map(p => p[1]));
  const trackDepth = land - surfaceAt(L.gateZ);
  const pocketIssues = pk => {
    const hits = [];
    if (overlapArea(pk, E) > 0) hits.push('overlaps the house');
    if (s.entry && overlapArea(pk, s.entry) > 0) hits.push('overlaps the entrance pad');
    if (s.garden && overlapArea(pk, s.garden) > 0) hits.push('overlaps the garden');
    const beyond = Math.max(0, metrics.landX0 - pk.x0, pk.x1 - metrics.landX1);
    if (beyond > 0) hits.push(`extends ${f2(beyond)} m beyond the illustrated land (boundary unknown)`);
    const zHit = pk.z1 > pedZ0 && pk.z0 < pedZ1;
    if (zHit && pedX >= pk.x0 && pedX <= pk.x1) hits.push('crosses the pedestrian route');
    else if (zHit && (pk.side === 'right' ? pedX > pk.x1 : pedX < pk.x0)) hits.push(`leaves ${f2(Math.min(Math.abs(pedX - pk.x0), Math.abs(pedX - pk.x1)))} m to the pedestrian route`);
    if (overlapArea(pk, L.pedestrianGate) > 0) hits.push('overlaps the pedestrian gate');
    if (pk.x0 < L.corridor.x0 - TOL || pk.x1 > L.corridor.x1 + TOL) {
      hits.push(`lies in raised land about ${f2(trackDepth)} m above the gate track, so the cut and retaining would have to widen around it`);
    }
    return hits;
  };
  const chosen = pocketIssues(L.pocket), other = pocketIssues(L.otherPocket);
  warnings.push({ id: 'gate', at: [(L.pocket.x0 + L.pocket.x1) / 2, L.gateZ], level: 'gate',
    text: `Sliding-gate lateral space not demonstrated. The ${f2(L.leafLength)} m leaf pocket drawn (${L.pocket.side}) ${chosen.join('; ')}. Sliding ${L.otherPocket.side} instead ${other.join('; ')}. Gate and boundary positions are symbolic` });

  if (!L.waitingFits) {
    warnings.push({ id: 'waiting', at: [(L.waitingCar.x0 + L.waitingCar.x1) / 2, Math.min(L.waitingCar.z1, s.roadEdgeZ + 1)], level: 'road',
      text: `No safe waiting space demonstrated. The gate is ${f2(metrics.gateSetback)} m inside the land edge, leaving ${f2(metrics.gateSetback)} m of off-road space, but the ASSUMED envelope is ${f2(veh.length)} m long; a vehicle waiting for the gate would stand ${f2(metrics.waitingOverhang)} m out over the drain and road. This is NOT acceptable and remains unresolved. An off-road wait needs a deeper gate setback, which shortens the climb (as in V1.2), or another professionally reviewed arrangement` });
  }
  warnings.push({ id: 'drain', at: [(L.corridor.x0 + L.corridor.x1) / 2 + 0.8, (s.landEdgeZ + s.roadEdgeZ) / 2], level: 'road',
    text: 'Roadside drain crossing unresolved and unaltered; the 0.36 m drawing gap is not available ramp length' });
  if (metrics.carportSpareLength < 0) warnings.push({ id: 'carport-fit', at: [(s.carport.x0 + s.carport.x1) / 2, s.carport.z0], level: 'land',
    text: `Vehicle envelope is ${f2(-metrics.carportSpareLength)} m longer than the carport` });
  else if (a.flagCarportLength) warnings.push({ id: 'carport-length', at: [(s.carport.x0 + s.carport.x1) / 2, s.carport.z0 + 0.4], level: 'land',
    text: `Limited carport length: only ${f2(metrics.carportSpareLength)} m longer than the ASSUMED ${f2(veh.length)} m envelope. Actual Ford Focus / Honda Vezel lengths and overhangs are unverified (Q03); a longer vehicle would stand on the top transition or block the approach` });

  // Visual footprint checks (not clearance tests). 'error' = scenario contradicts itself;
  // 'conflict' = an unresolved design conflict that must be shown, not hidden.
  checks.push(['parked vehicle envelope inside carport', metrics.carportSpareLength >= -TOL && metrics.carportSpareWidth >= -TOL, 'error']);
  checks.push(['gate opening wider than vehicle envelope', metrics.gateOpeningSpare > 0, 'error']);
  checks.push(['sliding leaf stays on the gate line (no sweep over road, drain or ramp)', L.gateZ < s.landEdgeZ && L.gateZ >= L.ramp.z0 - TOL, 'error']);
  checks.push(['waiting vehicle envelope off road and drain, outside the gate', L.waitingFits && L.waitingCar.z1 <= s.landEdgeZ + TOL, 'conflict']);
  checks.push(['pedestrian gate/route separate from vehicle corridor and drawn gate pocket',
    overlapArea(L.pedestrianGate, L.corridor) === 0 && overlapArea(L.pedestrianGate, L.pocket) === 0 && (pedX < L.corridor.x0 || pedX > L.corridor.x1)
    && !(pedX >= L.pocket.x0 && pedX <= L.pocket.x1 && L.pocket.z1 > pedZ0 && L.pocket.z0 < pedZ1), 'conflict']);
  checks.push(['pedestrian gate clear of the waiting vehicle', overlapArea(L.pedestrianGate, L.waitingCar) === 0, 'conflict']);
  for (const [label, ok, kind] of checks) {
    if (!ok && kind === 'conflict' && !label.startsWith('waiting')) warnings.push({ id: 'visual', at: null, level: 'land', text: `Visual conflict: ${label} — failed` });
  }

  return { layout: L, metrics, errors, warnings, checks };
}

function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const d = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return w > TOL && d > TOL ? w * d : 0;
}

// Returns { errors, warnings, openings, unreachable }. Errors mean the data is internally
// inconsistent; warnings are known design problems the viewer must display, not hide.
export function validate(plan) {
  const errors = [], warnings = [];
  const E = plan.envelope;
  const ids = new Set();
  for (const r of plan.rooms) {
    if (ids.has(r.id)) errors.push(`duplicate room id ${r.id}`);
    ids.add(r.id);
    if (!ZONES.includes(r.zone)) errors.push(`${r.id}: unknown zone ${r.zone}`);
    if (!(r.x1 > r.x0 && r.z1 > r.z0)) errors.push(`${r.id}: empty rectangle`);
    if (r.x0 < E.x0 - TOL || r.x1 > E.x1 + TOL || r.z0 < E.z0 - TOL || r.z1 > E.z1 + TOL) errors.push(`${r.id}: outside envelope`);
  }
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      if (overlapArea(plan.rooms[i], plan.rooms[j]) > 0) errors.push(`${plan.rooms[i].id} overlaps ${plan.rooms[j].id}`);
    }
  }
  const cellSum = plan.rooms.reduce((s, r) => s + rectArea(r), 0);
  if (!near(cellSum, rectArea(E), 1e-3)) errors.push(`room cells cover ${cellSum.toFixed(3)} m² but envelope is ${rectArea(E).toFixed(3)} m² (gaps or overlaps)`);

  for (const k of ['carport', 'entry', 'garden']) {
    const s = plan.site?.[k];
    if (s && overlapArea(s, E) > 0) errors.push(`site.${k} overlaps the house envelope`);
  }
  if (plan.site?.access) {
    const { min, max } = plan.levels.land;
    for (const land of [min, max]) for (const e of accessReport(plan, land).errors) errors.push(`access (land ${land}): ${e}`);
  }

  const lines = wallLines(plan);
  const pieces = wallPieces(plan);
  const onCellEdge = p => plan.rooms.some(r => p.axis === 'x' ? near(p.at, r.x0) || near(p.at, r.x1) : near(p.at, r.z0) || near(p.at, r.z1));
  for (const p of pieces) if (!onCellEdge(p)) errors.push(`wall piece at ${p.axis}=${p.at} is not on a room-cell edge`);

  const openings = placeOpenings(plan);
  for (const o of openings) {
    if (o.problem && !o.edge) errors.push(`opening ${o.id}: ${o.problem}`);
    else if (!o.fits) warnings.push(`Opening ${o.between.join('–')} not drawn: ${o.problem}`);
  }

  // Reachability from the entrance pad through openings that fit.
  const adj = new Map();
  for (const o of openings.filter(o => o.fits)) {
    const [a, b] = o.between;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  const seen = new Set(['entry']), queue = ['entry'];
  while (queue.length) for (const n of adj.get(queue.shift()) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const unreachable = plan.rooms.filter(r => !seen.has(r.id)).map(r => r.id);
  for (const id of unreachable) warnings.push(`${plan.rooms.find(r => r.id === id).label} has no usable opening from the entrance`);

  return { errors, warnings, openings, unreachable, wallLineCount: lines.length, wallPieceCount: pieces.length };
}
