// Interactive House Explorer — V2 geometry (schema house-plan/2).
// Pure functions with no Three.js or DOM dependency. The browser viewer, the SVG plan generator
// (src/plan-svg.js) and the checks (tools/check-v2.mjs) all read the same dataset through this
// module, so the 2D plan, the 3D scene and the checks share one interpretation.
//
// Plan coordinates are metres: x along the road (left → right as seen from the road), y into the
// site from the symbolic frontage line (y = 0, rear = larger y), levels above an ASSUMED road datum.
// Walls are axis-aligned centrelines with a thickness: dir 'h' runs along x at y = at, dir 'v' runs
// along y at x = at. Rooms are unions of rectangular cells bounded by wall centrelines.
// Nothing here is a survey, a structural check, a clearance test or a legal finding.

export const TOL = 1e-4;
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
export const ZONES = ['social', 'private', 'wet', 'service', 'circulation', 'future', 'outdoor'];
export const DOOR_KINDS = ['door', 'entrance-door', 'sliding-door'];
export const SQFT = 0.09290304;

// ---------- rectangles ----------
export const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
export const cellRect = c => rect(c[0], c[1], c[2], c[3]);
export const inRect = (r, x, y, tol = 0) => x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol && y <= r.y1 + tol;
export const rectOverlap = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), d = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > TOL && d > TOL ? w * d : 0;
};
const clip = (a, b) => {
  const r = rect(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1));
  return r.x1 - r.x0 > TOL && r.y1 - r.y0 > TOL ? r : null;
};

// Exact area of a union of axis-aligned rectangles (coordinate compression).
export function unionArea(rects) {
  if (!rects.length) return 0;
  const xs = [...new Set(rects.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [r.y0, r.y1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some(r => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1)) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return area;
}

// ---------- walls and openings ----------
export const wallThickness = (plan, w) => (w.kind === 'exterior' ? plan.parameters.exteriorWallThickness : plan.parameters.interiorWallThickness);

// Each wall extends half its own thickness beyond both centreline ends, so corners close.
export function wallBand(plan, w) {
  const h = wallThickness(plan, w) / 2;
  return w.dir === 'h' ? rect(w.from - h, w.at - h, w.to + h, w.at + h) : rect(w.at - h, w.from - h, w.at + h, w.to + h);
}
export const wallsById = plan => Object.fromEntries(plan.walls.map(w => [w.id, w]));
export const allBands = plan => plan.walls.map(w => wallBand(plan, w));

// Base level and height of a wall's solid part, relative to the finished floor (or the carport floor
// for walls that belong to the carport).
export function wallVertical(plan, w, land) {
  if (w.belongsTo === 'carport') return { base: 'carport', height: land !== undefined ? carportRoof(plan, land).clear : plan.carport.clearHeight };
  return { base: 'floor', height: plan.parameters.wallHeight };
}

// Where an opening cuts its wall: span along the wall plus the wall band across it.
export function openingGeom(plan, o) {
  const w = wallsById(plan)[o.wall];
  if (!w) return { problem: `unknown wall ${o.wall}` };
  const band = wallBand(plan, w), lo = o.at - o.width / 2, hi = o.at + o.width / 2;
  const cut = w.dir === 'h' ? rect(lo, band.y0, hi, band.y1) : rect(band.x0, lo, band.x1, hi);
  // Nibs: wall left each side of the opening, measured to a perpendicular wall's face or the wall end.
  const perp = plan.walls.filter(p => p.dir !== w.dir && p.id !== w.id).map(p => wallBand(plan, p));
  const along = r => (w.dir === 'h' ? [r.x0, r.x1] : [r.y0, r.y1]);
  const across = r => (w.dir === 'h' ? [r.y0, r.y1] : [r.x0, r.x1]);
  const [bs, be] = along(band);
  let left = bs, right = be;
  for (const p of perp) {
    const [a0, a1] = along(p), [c0, c1] = across(p);
    if (!(w.at >= c0 - TOL && w.at <= c1 + TOL)) continue;
    if (a1 <= lo + TOL && a1 > left) left = a1;
    if (a0 >= hi - TOL && a0 < right) right = a0;
  }
  const nibLow = lo - left, nibHigh = right - hi;
  const inside = lo >= w.from - TOL && hi <= w.to + TOL;
  const fits = inside && nibLow >= plan.parameters.minimumNib - TOL && nibHigh >= plan.parameters.minimumNib - TOL;
  return { wall: w, band, lo, hi, cut, nibLow, nibHigh, fits, inside };
}

// Wall boxes after cutting openings: solid runs, sills below windows and lintels above openings
// (heights relative to the floor, or the carport floor for carport walls).
export function wallPieces(plan, land) {
  const pieces = [];
  for (const w of plan.walls) {
    const band = wallBand(plan, w), v = wallVertical(plan, w, land);
    const geoms = plan.openings.filter(o => o.wall === w.id).map(o => ({ o, g: openingGeom(plan, o) })).filter(x => x.g.fits);
    const [s0, s1] = w.dir === 'h' ? [band.x0, band.x1] : [band.y0, band.y1];
    let runs = [[s0, s1]];
    for (const { g } of geoms) runs = runs.flatMap(([a, b]) => {
      if (g.hi <= a + TOL || g.lo >= b - TOL) return [[a, b]];
      return [...(g.lo > a + TOL ? [[a, g.lo]] : []), ...(g.hi < b - TOL ? [[g.hi, b]] : [])];
    });
    const box = (a, b) => (w.dir === 'h' ? rect(a, band.y0, b, band.y1) : rect(band.x0, a, band.x1, b));
    for (const [a, b] of runs) pieces.push({ kind: 'wall', wall: w.id, rect: box(a, b), y0: 0, y1: v.height, base: v.base, exterior: w.kind === 'exterior' });
    for (const { o, g } of geoms) {
      if (o.sill > TOL) pieces.push({ kind: 'sill', wall: w.id, opening: o.id, rect: box(g.lo, g.hi), y0: 0, y1: o.sill, base: v.base, exterior: w.kind === 'exterior' });
      pieces.push({ kind: 'lintel', wall: w.id, opening: o.id, rect: box(g.lo, g.hi), y0: o.head, y1: v.height, base: v.base, exterior: w.kind === 'exterior' });
    }
  }
  return pieces;
}

// Door swing: hinge, closed and open leaf tips, and the swept quarter disc as a polygon.
export function swingSector(plan, o) {
  if (!DOOR_KINDS.includes(o.kind) || !o.swing) return null;
  const g = openingGeom(plan, o), w = g.wall, r = o.width;
  const hingeAlong = o.swing.hinge === 'low' ? g.lo : g.hi, tipAlong = o.swing.hinge === 'low' ? g.hi : g.lo;
  const at = w.at, side = o.swing.side;
  const P = (along, off) => (w.dir === 'h' ? [along, at + off] : [at + off, along]);
  const hinge = P(hingeAlong, 0), closed = P(tipAlong, 0), open = P(hingeAlong, side * r);
  const v1 = [closed[0] - hinge[0], closed[1] - hinge[1]], v2 = [open[0] - hinge[0], open[1] - hinge[1]];
  const arc = [];
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI / 2;
    arc.push([hinge[0] + Math.cos(a) * v1[0] + Math.sin(a) * v2[0], hinge[1] + Math.cos(a) * v1[1] + Math.sin(a) * v2[1]]);
  }
  return { id: o.id, hinge, closed, open, radius: r, arc, polygon: [hinge, ...arc], side };
}
// Samples inside the swept quarter disc (used for overlap tests), out to just inside the leaf tip.
export function sectorSamples(s, step = 0.05) {
  const pts = [], v1 = [s.closed[0] - s.hinge[0], s.closed[1] - s.hinge[1]], v2 = [s.open[0] - s.hinge[0], s.open[1] - s.hinge[1]];
  const rings = Math.max(1, Math.round((s.radius - 0.005) / step));
  for (let i = 1; i <= rings; i++) {
    const k = (i / rings) * ((s.radius - 0.005) / s.radius);
    for (let a = 1.5; a < 90; a += 3) {
      const t = (a * Math.PI) / 180;
      pts.push([s.hinge[0] + k * (Math.cos(t) * v1[0] + Math.sin(t) * v2[0]), s.hinge[1] + k * (Math.cos(t) * v1[1] + Math.sin(t) * v2[1])]);
    }
  }
  return pts;
}

// ---------- rooms ----------
export const roomCells = r => r.cells.map(cellRect);
export const roomsById = plan => Object.fromEntries(plan.rooms.map(r => [r.id, r]));
export const isEnclosed = r => r.enclosed !== false;

export function roomAt(plan, x, y) {
  for (const r of plan.rooms) if (roomCells(r).some(c => x > c.x0 + 1e-6 && x < c.x1 - 1e-6 && y > c.y0 + 1e-6 && y < c.y1 - 1e-6)) return r.id;
  return null;
}

// Clear bounding box of one cell: each side is inset by the walls that cover most of that side.
function clearBox(c0, bands) {
  const inset = { l: 0, r: 0, b: 0, t: 0 };
  for (const b of bands) {
    const k = clip(c0, b);
    if (!k) continue;
    const full = (k.y1 - k.y0) >= 0.5 * (c0.y1 - c0.y0), fullX = (k.x1 - k.x0) >= 0.5 * (c0.x1 - c0.x0);
    if (full && near(k.x0, c0.x0)) inset.l = Math.max(inset.l, k.x1 - c0.x0);
    if (full && near(k.x1, c0.x1)) inset.r = Math.max(inset.r, c0.x1 - k.x0);
    if (fullX && near(k.y0, c0.y0)) inset.b = Math.max(inset.b, k.y1 - c0.y0);
    if (fullX && near(k.y1, c0.y1)) inset.t = Math.max(inset.t, c0.y1 - k.y0);
  }
  const r = rect(c0.x0 + inset.l, c0.y0 + inset.b, c0.x1 - inset.r, c0.y1 - inset.t);
  return { rect: r, w: r.x1 - r.x0, d: r.y1 - r.y0 };
}

// Clear floor: room cells minus the wall bands inside them (exact union areas).
export function roomMetrics(plan, r) {
  const cells = roomCells(r), bands = allBands(plan);
  const cut = [];
  for (const c of cells) for (const b of bands) { const k = clip(c, b); if (k) cut.push(k); }
  const cellArea = unionArea(cells), clearArea = cellArea - unionArea(cut);
  const boxes = cells.map(c => clearBox(c, bands)), c0 = cells[0];
  return {
    id: r.id, label: r.label, zone: r.zone, enclosed: isEnclosed(r), cellArea, clearArea,
    primary: c0, clearW: boxes[0].w, clearD: boxes[0].d, clearRect: boxes[0].rect, cellBoxes: boxes, multiCell: cells.length > 1,
  };
}

export function houseFootprintRects(plan) {
  const enclosedCells = plan.rooms.filter(isEnclosed).flatMap(roomCells);
  const walls = plan.walls.filter(w => !w.belongsTo).map(w => wallBand(plan, w));
  return [...enclosedCells, ...walls];
}

// Four separate area families (none is a surveyed, contractual or chargeable area).
export function areas(plan) {
  const rooms = plan.rooms.map(r => roomMetrics(plan, r));
  const enclosed = rooms.filter(r => r.enclosed);
  const gross = unionArea(houseFootprintRects(plan));
  const sum = k => enclosed.reduce((s, r) => s + r[k], 0);
  const utility = rooms.find(r => r.id === 'utility');
  const cp = rooms.find(r => r.id === 'carport'), porch = rooms.find(r => r.id === 'porch');
  const d = plan.driveway, st = plan.steps, S = plan.site, g = plan.garden;
  const outdoor = [
    { id: 'carport', label: 'Carport (covered, clear)', area: cp.clearArea },
    { id: 'porch', label: 'Entry porch (covered, cell)', area: porch.cellArea },
    { id: 'driveway', label: 'Driveway apron + climb (plan)', area: (d.x1 - d.x0) * (plan.carport.y0 - d.apronY0) },
  ];
  if (hasRoute(plan)) {
    // V2.2+: the route, garden and the frontage strips of unknown ownership are reported separately
    const r = pedRoute(plan, plan.levels.land.default), F = plan.frontage;
    const bandArea = b => (S.display.x1 - S.display.x0) * (b.y1 - b.y0);
    outdoor.push(
      { id: 'route', label: 'Pedestrian crossing, landings + flight (plan, default land)', area: unionArea([r.crossing, r.bottom, r.flight, r.upper].map(c => c.rect)) },
      { id: 'path', label: 'Garden path (plan, default land)', area: unionArea(r.path.rects.map(q => q.rect)) },
      { id: 'garden', label: 'Front garden beds + lawn (drawn)', area: unionArea([...g.lawns, ...g.beds].map(b => rect(b.x0, b.y0, b.x1, b.y1))) },
      { id: 'strip', label: 'Lower planting strip — ownership unknown', area: (F.plantingStrip.x1 - F.plantingStrip.x0) * (F.plantingStrip.y1 - F.plantingStrip.y0) },
      ...(F.verge ? [{ id: 'verge', label: 'Verge across the display width — ownership unknown', area: bandArea(F.verge) }] : []),
    );
    if (plan.site.conceptualEnvelope) {
      const E = plan.site.conceptualEnvelope;
      outdoor.push({ id: 'envelope', label: 'CONCEPTUAL planning envelope (near-square; not the parcel)', area: (E.x1 - E.x0) * (E.y1 - E.y0) });
    }
  } else {
    outdoor.push(
      { id: 'steps', label: 'Pedestrian steps (plan, at default land)', area: (st.x1 - st.x0) * (steps(plan, plan.levels.land.default).y1 - st.y0) },
      { id: 'garden', label: 'Front garden beds + lawn (drawn)', area: unionArea([...g.lawns, ...g.beds].map(b => rect(b.x0, b.y0, b.x1, b.y1))) },
    );
  }
  return {
    enclosedGross: gross, enclosedGrossSqft: gross / SQFT,
    enclosedGrossWithoutUtility: gross - (utility?.cellArea ?? 0), enclosedGrossWithoutUtilitySqft: (gross - (utility?.cellArea ?? 0)) / SQFT,
    cellTotal: sum('cellArea'), clearTotal: sum('clearArea'), clearTotalSqft: sum('clearArea') / SQFT,
    rooms, enclosedRooms: enclosed, outdoor,
    range: { minM2: 1200 * SQFT, maxM2: 1500 * SQFT },
    display: { w: S.display.x1 - S.display.x0, d: S.display.y1 - S.display.y0 },
  };
}

// ---------- levels, driveway and steps ----------
export function levels(plan, land) {
  const L = plan.levels;
  const cf = L.carportFloor, copt = cf ? cf.options.find(o => o.id === cf.active) : null;   // V2.4: independent carport floor, option A / B
  const out = {
    road: L.road.value, apron: L.road.value + L.apronAboveRoad.value, land,
    yard: land + L.yardAboveLand.value, carport: copt ? (copt.reference === 'land' ? land : L.road.value) + copt.offset : land + L.carportAboveLand.value, floor: land + plan.parameters.plinthHeight,
  };
  // V2.2+: frontage and route surfaces are separate levels
  const FR = plan.frontage;
  if (FR && FR.retainingEdge) {
    // V2.4: no verge. toe = adjoining drain-side ground; edgeCap = top of the capping (toe + visible face); strip = planting soil (below the capping)
    const E = FR.retainingEdge, toe = out.road + E.toeAboveRoad;
    Object.assign(out, { toe, edgeCap: toe + E.visibleFace, strip: toe + E.visibleFace - E.soilBelowCap });
  } else if (FR) Object.assign(out, { verge: out.road + FR.verge.aboveRoad, strip: out.road + FR.plantingStrip.aboveRoad });
  if (plan.route) Object.assign(out, { crossing: out.road + plan.route.crossing.aboveRoad, bottomLanding: out.road + plan.route.bottomLanding.aboveRoad, upperLanding: out.yard });
  return out;
}
export function ramp(plan) {
  const d = plan.driveway, c = plan.carport;
  return { y0: d.rampStartY, y1: c.y0, run: c.y0 - d.rampStartY, tb: d.bottomTransition, tt: d.topTransition };
}
export function rampPeakSlope(plan, land) {
  const r = ramp(plan), lv = levels(plan, land);
  return (lv.carport - lv.apron) / (r.run - (r.tb + r.tt) / 2);
}
// Driveway surface: level apron → parabolic bottom transition → straight climb → parabolic top
// transition → level carport. A drawn shape only.
export function rampHeight(plan, land, y) {
  const r = ramp(plan), lv = levels(plan, land), rise = lv.carport - lv.apron, g = rampPeakSlope(plan, land), s = y - r.y0;
  let z;
  if (s <= 0) z = 0;
  else if (s < r.tb) z = (g * s * s) / (2 * r.tb);
  else if (s <= r.run - r.tt) z = (g * r.tb) / 2 + g * (s - r.tb);
  else if (s < r.run) z = rise - (g * (r.run - s) ** 2) / (2 * r.tt);
  else z = rise;
  return lv.apron + z;
}
export function rampProfile(plan, land, samples = 48) {
  const r = ramp(plan);
  return Array.from({ length: samples + 1 }, (_, i) => { const y = r.y0 + (r.run * i) / samples; return [y, rampHeight(plan, land, y)]; });
}
export function steps(plan, land) {
  // V2.2+: the flight rises from the bottom landing (route data); V2.1: from the driveway apron level.
  const s = plan.steps, lv = levels(plan, land), bottom = plan.route ? lv.road + plan.route.bottomLanding.aboveRoad : lv.apron;
  const rise = lv.yard - bottom, n = Math.ceil(rise / s.maxRiser - 1e-9);
  return { risers: n, riser: rise / n, going: s.going, y0: s.y0, y1: s.y0 + (n - 1) * s.going, rise };
}

// Maximum surface slope under a footprint measured along y.
function maxSlopeOver(plan, land, y0, y1) {
  let m = 0;
  for (let y = y0; y <= y1; y += 0.05) m = Math.max(m, Math.abs(rampHeight(plan, land, y + 0.025) - rampHeight(plan, land, y - 0.025)) / 0.05);
  return m;
}

// Metrics for one land level: drawn-shape arithmetic only (not clearance, bumper, breakover,
// gradient-compliance, retaining or drainage checks).
export function accessMetrics(plan, land) {
  const r = ramp(plan), lv = levels(plan, land), env = plan.parameters.vehicleEnvelope, c = plan.carport, gate = plan.gate;
  const rise = lv.carport - lv.apron;
  const sampled = (() => {
    const p = rampProfile(plan, land, 400); let m = 0;
    for (let i = 1; i < p.length; i++) m = Math.max(m, Math.abs(p[i][1] - p[i - 1][1]) / (p[i][0] - p[i - 1][0]));
    return m;
  })();
  const wait = { y1: gate.y - 0.3, y0: gate.y - 0.3 - env.length };
  return {
    land, levels: lv, rise, run: r.run, steps: steps(plan, land),
    averageGradientPct: (100 * rise) / r.run, maxLocalGradientPct: 100 * rampPeakSlope(plan, land), sampledMaxGradientPct: 100 * sampled,
    retainedAtFrontage: lv.yard - rampHeight(plan, land, plan.site.frontageY),
    frontWallAboveRoad: lv.yard + (plan.frontage ? plan.frontage.mainWall.topAboveGarden : plan.site.frontWall.topAboveYard) - lv.road,
    ...(plan.frontage ? { retainedByMainWall: lv.yard - lv.strip, retainedByStripEdge: lv.verge !== undefined ? lv.strip - lv.verge : lv.edgeCap - lv.toe } : {}),
    carportSpareLength: c.y1 - c.y0 - env.length, carportSpareWidth: c.x1 - c.x0 - env.width,
    gateOpening: gate.x1 - gate.x0, gateOpeningSpare: gate.x1 - gate.x0 - env.width,
    waitingOnRamp: { y0: wait.y0, y1: wait.y1, maxSlopePct: 100 * maxSlopeOver(plan, land, Math.max(wait.y0, r.y0), wait.y1), offRoad: wait.y0 >= plan.site.frontageY },
    ...(() => { const near_ = rampHeight(plan, land, gate.y); return { gateBase: near_, gateSurfaceSlopePct: 100 * Math.abs(rampHeight(plan, land, gate.y - 0.05) - rampHeight(plan, land, gate.y + 0.05)) / 0.1 }; })(),
  };
}

// Leaf pocket study for the gate in REF-FRONT: both directions, with the obstacles they meet.
export function gatePockets(plan) {
  const g = plan.gate, leaf = g.x1 - g.x0 + g.leafOverlap, band = { y0: g.y - 0.15, y1: g.y + 0.15 };
  const left = rect(g.x0 - leaf, band.y0, g.x0, band.y1), right = rect(g.x1, band.y0, g.x1 + leaf, band.y1);
  const obstacles = [
    ['the right gate pier', rect(g.pierRight.x0, g.pierRight.y0, g.pierRight.x1, g.pierRight.y1)],
    ['the end of the driveway retaining wall', rect(plan.driveway.rightRetainingWall.x0, plan.driveway.rightRetainingWall.y0 ?? 0, plan.driveway.rightRetainingWall.x1, g.y + 0.1)],
    ['the symbolic left boundary wall', rect(plan.site.leftWall.x0, plan.site.leftWall.y0, plan.site.leftWall.x1, g.y + 0.1)],
    ['the left gate pier', rect(g.pierLeft.x0, g.pierLeft.y0, g.pierLeft.x1, g.pierLeft.y1)],
  ];
  const hit = p => obstacles.filter(([, o]) => rectOverlap(p, o) > 0).map(([n]) => n);
  const beyondLeft = Math.max(0, plan.site.leftWall.x0 - left.x0);
  return {
    leafLength: leaf, left, right,
    leftIssues: [`runs ${beyondLeft.toFixed(2)} m beyond the symbolic left boundary, where the neighbouring land is unknown`, ...hit(left).filter(n => !n.includes('left'))],
    rightIssues: [`needs a ${leaf.toFixed(2)} m clear run across the front garden in front of the living glazing`, ...hit(right).map(n => `meets ${n}`)],
  };
}

// ---------- wiring: links between rooms, door sectors, reachability ----------
function uncoveredLength(plan, a, b, bands) {
  let open = 0, n = 0;
  const horizontal = a.y0 === a.y1;
  for (let t = 0.005; ; t += 0.01) {
    const p = horizontal ? [a.x0 + t, a.y0] : [a.x0, a.y0 + t];
    if ((horizontal && p[0] > a.x1) || (!horizontal && p[1] > a.y1)) break;
    n++;
    if (!bands.some(r => inRect(r, p[0], p[1], 1e-9))) open += 0.01;
  }
  return open;
}
export function roomLinks(plan) {
  const bands = allBands(plan), links = [];
  const rooms = plan.rooms;
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    for (const a of roomCells(rooms[i])) for (const b of roomCells(rooms[j])) {
      let seg = null;
      for (const [ax, bx] of [[a.x1, b.x0], [a.x0, b.x1]]) {
        if (near(ax, bx)) { const y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1); if (y1 - y0 > TOL) seg = rect(ax, y0, ax, y1); }
      }
      for (const [ay, by] of [[a.y1, b.y0], [a.y0, b.y1]]) {
        if (near(ay, by)) { const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1); if (x1 - x0 > TOL) seg = rect(x0, ay, x1, ay); }
      }
      if (!seg) continue;
      const open = uncoveredLength(plan, seg, seg, bands);
      links.push({ a: rooms[i].id, b: rooms[j].id, seg, openLength: open, length: Math.max(seg.x1 - seg.x0, seg.y1 - seg.y0) });
    }
  }
  return links;
}

export function doorRooms(plan, o) {
  const g = openingGeom(plan, o);
  if (!g.wall) return [null, null];
  const w = g.wall, t = wallThickness(plan, w) / 2 + 0.15, c = o.at;
  const pt = off => (w.dir === 'h' ? [c, w.at + off] : [w.at + off, c]);
  const [n, p] = [pt(-t), pt(t)];
  return [roomAt(plan, ...n), roomAt(plan, ...p)];
}

export function doorGraph(plan) {
  const edges = [];
  for (const o of plan.openings) {
    if (!DOOR_KINDS.includes(o.kind)) continue;
    const [a, b] = doorRooms(plan, o);
    if (a && b && a !== b) edges.push({ id: o.id, a, b, kind: 'door' });
  }
  for (const l of roomLinks(plan)) if (l.openLength >= 0.9) edges.push({ id: `open:${l.a}-${l.b}`, a: l.a, b: l.b, kind: 'open', length: l.openLength });
  return edges;
}

export function reachable(plan, from = 'porch') {
  const adj = new Map();
  for (const e of doorGraph(plan)) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push(e.a);
  }
  const seen = new Set([from]), q = [from];
  while (q.length) for (const n of adj.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

// ---------- validation ----------
const rectInsideAnyCell = (cells, r) => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]
  .every(([x, y]) => cells.some(c => inRect(c, x, y, 1e-6)));

// Returns { errors, warnings, info }. Errors: the dataset contradicts itself or the plan has an
// access/swing/furniture defect. Warnings: known design issues that the viewer and plan must show.
export function validate(plan) {
  const errors = [], warnings = [], info = {};
  const P = plan.parameters, byWall = wallsById(plan), rooms = roomsById(plan);
  const bands = allBands(plan);

  // ids and shapes
  const seen = new Set();
  for (const group of [plan.rooms, plan.walls, plan.openings, plan.furniture]) {
    for (const x of group) { if (seen.has(x.id)) errors.push(`duplicate id ${x.id}`); seen.add(x.id); }
  }
  for (const r of plan.rooms) {
    if (!ZONES.includes(r.zone)) errors.push(`${r.id}: unknown zone ${r.zone}`);
    for (const c of roomCells(r)) if (!(c.x1 > c.x0 && c.y1 > c.y0)) errors.push(`${r.id}: empty cell`);
  }
  for (const w of plan.walls) if (!(w.to > w.from)) errors.push(`wall ${w.id}: empty`);

  // room cells must not overlap and must tile the enclosed footprint without gaps
  const cellsAll = plan.rooms.flatMap(r => roomCells(r).map(c => ({ r: r.id, c })));
  for (let i = 0; i < cellsAll.length; i++) for (let j = i + 1; j < cellsAll.length; j++) {
    if (cellsAll[i].r !== cellsAll[j].r && rectOverlap(cellsAll[i].c, cellsAll[j].c) > 0) errors.push(`${cellsAll[i].r} overlaps ${cellsAll[j].r}`);
  }

  // every opening: on a wall, inside it, nibs, rooms either side
  const sectors = [];
  for (const o of plan.openings) {
    const g = openingGeom(plan, o);
    if (g.problem) { errors.push(`opening ${o.id}: ${g.problem}`); continue; }
    if (!g.fits) errors.push(`opening ${o.id} does not fit wall ${o.wall} (nibs ${g.nibLow.toFixed(2)} / ${g.nibHigh.toFixed(2)} m, minimum ${P.minimumNib})`);
    const [a, b] = doorRooms(plan, o);
    if (DOOR_KINDS.includes(o.kind)) {
      if (!a || !b) errors.push(`door ${o.id} does not join two spaces (${a ?? 'outside'} / ${b ?? 'outside'})`);
      if (!o.swing && o.kind !== 'sliding-door') errors.push(`door ${o.id} has no swing`);
      const s = swingSector(plan, o);
      if (s) sectors.push({ o, s, rooms: [a, b] });
    } else if (o.kind !== 'servery' && a && b && isEnclosed(rooms[a]) && isEnclosed(rooms[b])) {
      warnings.push(`window ${o.id} sits between two interior spaces (${a} / ${b})`);
    }
  }

  // door swings: stay in the open (not into walls), clear of furniture, of each other and of the stair
  const stair = rooms[plan.futureStair?.room];
  for (const { o, s } of sectors) {
    const own = bands.filter((_, i) => plan.walls[i].id === o.wall);
    const bad = sectorSamples(s).filter(([x, y]) => bands.some((b, i) => plan.walls[i].id !== o.wall && inRect(b, x, y, -1e-6)));
    if (bad.length) errors.push(`door ${o.id}: swing runs into a wall`);
    const outside = sectorSamples(s).filter(([x, y]) => !roomAt(plan, x, y) && !own.some(b => inRect(b, x, y)) && !bands.some(b => inRect(b, x, y)));
    if (outside.length) errors.push(`door ${o.id}: swing leaves the drawn spaces`);
    for (const f of plan.furniture) {
      const fr = rect(f.x0, f.y0, f.x1, f.y1);
      if (sectorSamples(s).some(([x, y]) => inRect(fr, x, y, 1e-6))) errors.push(`door ${o.id}: swing hits ${f.id}`);
    }
    if (stair && roomCells(stair).some(c => sectorSamples(s).some(([x, y]) => inRect(c, x, y)))) errors.push(`door ${o.id}: swing enters the future stair provision`);
  }
  for (let i = 0; i < sectors.length; i++) for (let j = i + 1; j < sectors.length; j++) {
    const a = sectors[i], b = sectors[j];
    const sj = sectorSamples(b.s);
    const crossing = sectorSamples(a.s).some(([x, y]) => sj.some(([u, v]) => Math.hypot(x - u, y - v) < 0.06));
    if (crossing) errors.push(`door swings ${a.o.id} and ${b.o.id} overlap`);
  }

  // furniture: inside its room's clear floor, off the walls, not overlapping each other
  for (const f of plan.furniture) {
    const room = rooms[f.room], fr = rect(f.x0, f.y0, f.x1, f.y1);
    if (!room) { errors.push(`furniture ${f.id}: unknown room ${f.room}`); continue; }
    if (!(f.x1 > f.x0 && f.y1 > f.y0)) errors.push(`furniture ${f.id}: empty footprint`);
    if (!rectInsideAnyCell(roomCells(room), fr)) errors.push(`furniture ${f.id} is outside ${f.room}`);
    for (const [i, b] of bands.entries()) if (rectOverlap(fr, b) > 0) errors.push(`furniture ${f.id} overlaps wall ${plan.walls[i].id}`);
  }
  for (let i = 0; i < plan.furniture.length; i++) for (let j = i + 1; j < plan.furniture.length; j++) {
    const a = plan.furniture[i], b = plan.furniture[j];
    if (rectOverlap(rect(a.x0, a.y0, a.x1, a.y1), rect(b.x0, b.y0, b.x1, b.y1)) > 0) errors.push(`furniture ${a.id} overlaps ${b.id}`);
  }
  // tall furniture in front of a window (a servery's counter is meant to stand under it)
  for (const o of plan.openings.filter(o => !DOOR_KINDS.includes(o.kind) && o.kind !== 'servery')) {
    const g = openingGeom(plan, o); if (!g.wall) continue;
    const zone = g.wall.dir === 'h'
      ? rect(g.lo, g.band.y0 - 0.5, g.hi, g.band.y1 + 0.5) : rect(g.band.x0 - 0.5, g.lo, g.band.x1 + 0.5, g.hi);
    for (const f of plan.furniture) if (f.height > o.sill + 0.05 && rectOverlap(zone, rect(f.x0, f.y0, f.x1, f.y1)) > 0 && f.type !== 'vehicle') warnings.push(`${f.id} (${f.height} m) stands in front of window ${o.id}`);
  }

  // access: every enclosed room reachable from the porch; habitable rooms have a window
  const reach = reachable(plan, 'porch');
  for (const r of plan.rooms.filter(isEnclosed)) if (!reach.has(r.id)) errors.push(`${r.label} is not reachable from the entry porch through doors and open edges`);
  const habitable = ['living', 'kitchen', 'dining', 'bed2', 'bed3', 'master'];
  for (const id of habitable) {
    const has = plan.openings.some(o => !DOOR_KINDS.includes(o.kind) && doorRooms(plan, o).includes(id));
    if (!has) errors.push(`${rooms[id].label} has no window`);
  }
  const ensuiteDoor = plan.openings.find(o => DOOR_KINDS.includes(o.kind) && doorRooms(plan, o).includes('ensuite'));
  if (!ensuiteDoor) errors.push('ensuite has no door');
  else if (!doorRooms(plan, ensuiteDoor).includes('master')) errors.push('ensuite is not entered from the master bedroom');
  const bathDoor = plan.openings.find(o => DOOR_KINDS.includes(o.kind) && doorRooms(plan, o).includes('bath'));
  if (!bathDoor) errors.push('common bathroom has no door');
  else if (!doorRooms(plan, bathDoor).includes('hall')) errors.push('common bathroom is not entered from the hall');
  for (const id of ['bed2', 'bed3', 'master']) {
    const d = plan.openings.find(o => DOOR_KINDS.includes(o.kind) && doorRooms(plan, o).includes(id) && doorRooms(plan, o).includes('hall'));
    if (!d) errors.push(`${rooms[id].label} has no door from the hall`);
  }
  if (!plan.openings.some(o => o.kind === 'entrance-door' && doorRooms(plan, o).includes('porch') && doorRooms(plan, o).includes('hall'))) errors.push('entrance door must join the porch and the hall');

  // stair provision and circulation
  if (plan.futureStair && stair) {
    const sm = roomMetrics(plan, stair), fs = plan.futureStair;
    const dims = [sm.clearW, sm.clearD].sort((a, b) => a - b), need = [fs.boxRequired.w, fs.boxRequired.d].sort((a, b) => a - b);
    info.stairBox = { clearW: sm.clearW, clearD: sm.clearD, requiredW: fs.boxRequired.w, requiredD: fs.boxRequired.d };
    if (dims[0] < need[0] - TOL || dims[1] < need[1] - TOL) errors.push(`future stair box ${sm.clearW.toFixed(2)} × ${sm.clearD.toFixed(2)} m is smaller than the ASSUMED ${fs.boxRequired.w} × ${fs.boxRequired.d} m provision`);
    const hall = roomMetrics(plan, rooms.hall), passage = hall.cellBoxes[0].w;
    info.passageBesideStair = passage;
    if (passage < fs.minPassageBeside - TOL) errors.push(`entrance passage beside the stair box is ${passage.toFixed(2)} m, below ${fs.minPassageBeside} m`);
    warnings.push(`Once the future stair is built, the entrance passage beside it narrows to about ${passage.toFixed(2)} m clear; until then the box is usable hall floor.`);
  }
  const corrClear = roomMetrics(plan, rooms.hall).cellBoxes[1].d;
  info.corridorClear = corrClear;
  if (corrClear < 1.2) errors.push(`corridor clear width ${corrClear.toFixed(2)} m is below 1.20 m`);
  for (const o of plan.openings.filter(o => DOOR_KINDS.includes(o.kind))) {
    const min = o.kind === 'entrance-door' ? 0.9 : 0.75;
    if (o.width < min) errors.push(`door ${o.id} is ${o.width} m wide, below ${min} m`);
  }

  // façade consistency: element order along x, canopy over the door, features beside it
  const fac = plan.facade, geomOf = id => openingGeom(plan, plan.openings.find(o => o.id === id));
  const xs = fac.order.map(e => (e.opening ? plan.openings.find(o => o.id === e.opening)?.at : e.x));
  if (xs.some(x => x === undefined)) errors.push('façade order refers to a missing opening');
  for (let i = 1; i < xs.length; i++) if (!(xs[i] > xs[i - 1])) errors.push(`façade order broken between ${fac.order[i - 1].label} and ${fac.order[i].label}`);
  const door = plan.openings.find(o => o.kind === 'entrance-door');
  if (!door) errors.push('no entrance door');
  else {
    if (!(fac.entranceCanopy.x0 <= door.at - door.width / 2 && fac.entranceCanopy.x1 >= door.at + door.width / 2)) errors.push('entrance canopy does not cover the entrance door');
    for (const k of ['entranceFeature', 'stoneFeature']) {
      const f = fac[k], dg = geomOf(door.id), wall = byWall[door.wall];
      if (!near(f.y, wall.at)) errors.push(`${k} is not on the entrance wall`);
      if (f.x0 < wall.from - TOL || f.x1 > wall.to + TOL) errors.push(`${k} runs off the entrance wall`);
      if (f.x1 > dg.lo + TOL && f.x0 < dg.hi - TOL) errors.push(`${k} overlaps the entrance door`);
      for (const o of plan.openings.filter(o => o.wall === wall.id && o.id !== door.id)) { const g = openingGeom(plan, o); if (f.x1 > g.lo + TOL && f.x0 < g.hi - TOL) errors.push(`${k} overlaps ${o.id}`); }
    }
  }
  if (rectOverlap(rect(fac.entranceFeature.x0, 0, fac.entranceFeature.x1, 1), rect(fac.stoneFeature.x0, 0, fac.stoneFeature.x1, 1)) > 0) errors.push('wood and stone features overlap');
  const cp = plan.carport, lvMid = levels(plan, plan.levels.land.default);
  if (!(carportRoof(plan, plan.levels.land.default).top < lvMid.floor + P.wallHeight)) errors.push('carport roof is not lower than the house roof');
  if (!(cp.x1 <= Math.min(...plan.rooms.filter(isEnclosed).filter(r => r.id !== 'utility').flatMap(roomCells).map(c => c.x0)) + TOL)) errors.push('carport is not at the left of the house');
  if (isFrontGate(plan)) {
    // V2.3: the carport front must be level with (not behind) the front of the room beside it; the rest of the house may project forward
    const beside = plan.rooms.filter(isEnclosed).filter(r => r.id !== 'utility').flatMap(roomCells).filter(c => Math.abs(c.x0 - cp.x1) < TOL);
    if (!beside.length || cp.y0 > Math.min(...beside.map(c => c.y0)) + TOL) errors.push('carport front is behind the front of the room beside it (it must sit beside the front of the house)');
    else if (cp.y0 < Math.min(...beside.map(c => c.y0)) - 0.5) warnings.push('carport front stands well forward of the room beside it');
  } else if (cp.y0 > Math.min(...plan.rooms.filter(isEnclosed).flatMap(roomCells).map(c => c.y0)) + TOL) errors.push('carport front is behind the house front (it must sit beside the front of the house)');
  for (const roof of plan.roof.slabs) if (!(roof.x1 > roof.x0 && roof.y1 > roof.y0)) errors.push(`roof slab ${roof.id} is empty`);
  for (const [i, a] of plan.roof.pv.arrays.entries()) {
    if (!plan.roof.slabs.some(s => a.x0 >= s.x0 && a.x1 <= s.x1 && a.y0 >= s.y0 && a.y1 <= s.y1)) errors.push(`PV array ${i + 1} is not on a roof slab`);
  }

  // site: levels, driveway, steps, gate, display extent
  for (const land of [plan.levels.land.min, plan.levels.land.default, plan.levels.land.max]) {
    const lv = levels(plan, land), m = accessMetrics(plan, land);
    // V2.4: the carport floor is independent of the garden (it may be below it): only road < apron < carport < floor and apron < garden < floor are required
    const ordered = hasCarportOptions(plan) ? lv.road < lv.apron && lv.apron < lv.carport && lv.carport < lv.floor && lv.apron < lv.yard && lv.yard < lv.floor
      : lv.road < lv.apron && lv.apron < lv.yard && lv.yard < lv.carport && lv.carport < lv.floor;
    if (!ordered) errors.push(`levels are not distinct and ordered at land ${land}`);
    if (Math.abs(m.sampledMaxGradientPct - m.maxLocalGradientPct) > 0.1) errors.push(`sampled maximum gradient differs from the analytic value at land ${land}`);
    if (Math.abs(rampHeight(plan, land, ramp(plan).y0) - lv.apron) > 1e-9 || Math.abs(rampHeight(plan, land, plan.carport.y0) - lv.carport) > 1e-9) errors.push(`ramp endpoints wrong at land ${land}`);
    if (!hasRoute(plan) && (!(m.steps.riser <= plan.steps.maxRiser + 1e-9) || m.steps.y1 > plan.garden.path[0][1])) errors.push(`pedestrian steps run past the garden path start at land ${land}`);
  }
  // V2.2+: the pedestrian route at the range ends, the default and both sides of every riser-count change
  if (hasRoute(plan)) {
    info.route = [];
    for (const land of routeTestLands(plan)) {
      const vr = validateRoute(plan, land);
      errors.push(...vr.errors);
      const r = vr.route;
      info.route.push({ land, risers: r.flight.risers, riser: r.flight.riser, flightEnd: r.flight.rect.y1, upperLandingEnd: r.upper.rect.y1, pathLength: r.path.length, errors: vr.errors.length });
    }
    info.riserChangeLands = riserChangeLands(plan).map(c => c.land);
    const dr = plan.driveway, F = plan.frontage;
    if (Math.abs(dr.apronY0 - F.drain.y0) > TOL) errors.push('driveway crossing does not start at the road edge of the drain');
    if (Math.abs(plan.site.road.y1 - F.roadEdge.y) > TOL) errors.push('site road edge and frontage road edge differ');
    if (lvMid.apron - (dr.crossingThickness ?? 0) < lvMid.road - TOL) errors.push('the driveway crossing slab reaches into the drain channel (flow route blocked)');
  }
  if (isFrontGate(plan)) validateFrontGate(plan, errors, warnings, info);
  if ((hasRetainingEdge(plan) || hasCarportOptions(plan)) && !isV24(plan)) errors.push('incomplete V2.4 dataset: the carport walking route (carportRoute), the retaining edge and the carport-floor options are required together (carport walking route missing)');
  if (isV24(plan)) validateV24(plan, errors, warnings, info);
  if (isV25(plan)) validateV25(plan, errors, warnings, info);
  if (isV26(plan)) validateV26(plan, errors, warnings, info);
  const sf = stepFreeReport(plan);
  if (sf) {
    info.stepFree = sf;
    for (const m of sf.missing) errors.push(`step-free route missing: ${m} (owner requirement: step-free access from the ground-floor rooms to both bathrooms)`);
  }
  const R = ramp(plan);
  if (!(R.run > R.tb + R.tt)) errors.push('ramp is shorter than its transitions');
  if (!(plan.gate.x0 >= plan.driveway.x0 && plan.gate.x1 <= plan.driveway.x1)) errors.push('gate opening is wider than the driveway');
  const am = accessMetrics(plan, plan.levels.land.default);
  if (am.carportSpareLength <= 0 || am.carportSpareWidth <= 0 || am.gateOpeningSpare <= 0) errors.push('the ASSUMED vehicle envelope does not fit the carport and gate opening');
  const D = plan.site.display;
  for (const r of plan.rooms) for (const c of roomCells(r)) if (c.x0 < D.x0 || c.x1 > D.x1 || c.y0 < D.y0 || c.y1 > D.y1) errors.push(`${r.id} is outside the display extent`);
  const gardenRects = [...plan.garden.lawns, ...plan.garden.beds].map(b => rect(b.x0, b.y0, b.x1, b.y1));
  const houseRect = unionArea([...plan.rooms.filter(isEnclosed).flatMap(roomCells)]);
  for (const [i, g] of gardenRects.entries()) {
    for (const r of plan.rooms.filter(isEnclosed).flatMap(roomCells)) if (rectOverlap(g, r) > 0) errors.push(`garden item ${i + 1} overlaps the house`);
    if (rectOverlap(g, rect(plan.driveway.x0, -1, plan.driveway.rightRetainingWall.x1, plan.carport.y0)) > 0) errors.push(`garden item ${i + 1} overlaps the driveway`);
  }

  // area range report (not an error)
  const a = areas(plan);
  info.areas = { gross: a.enclosedGross, grossSqft: a.enclosedGrossSqft, grossWithoutUtility: a.enclosedGrossWithoutUtility, clear: a.clearTotal };
  info.inRange = a.enclosedGross >= a.range.minM2 && a.enclosedGross <= a.range.maxM2;
  if (!info.inRange) warnings.push(`Enclosed area ${a.enclosedGross.toFixed(1)} m² is outside the preliminary 1,200–1,500 sq ft exploration range (reported, not forced).`);
  info.houseRect = houseRect;
  info.sectors = sectors.map(s => s.s);
  return { errors, warnings, info };
}

// ---------- unresolved issue list shown by the viewer and the plan ----------
export function unresolvedIssues(plan, land) {
  if (isV26(plan)) return unresolvedIssuesV26(plan, land);
  if (isV25(plan)) return unresolvedIssuesV25(plan, land);
  if (isV24(plan)) return unresolvedIssuesV24(plan, land);
  if (isFrontGate(plan)) return unresolvedIssuesFrontGate(plan, land);
  if (hasRoute(plan)) return unresolvedIssuesRoute(plan, land);
  const m = accessMetrics(plan, land), gp = gatePockets(plan), f2 = n => n.toFixed(2);
  const out = [];
  const env = plan.parameters.vehicleEnvelope;
  out.push({ id: 'ramp', at: [(plan.driveway.x0 + plan.driveway.x1) / 2, (ramp(plan).y0 + ramp(plan).y1) / 2], level: 'ramp',
    text: `Ramp clearance UNCHECKED. Drawn rise ${f2(m.rise)} m over a ${f2(m.run)} m climb: average ${m.averageGradientPct.toFixed(1)}%, maximum local gradient ${m.maxLocalGradientPct.toFixed(1)}% (drawn shape; arithmetic only — not a bumper, breakover, approach/departure, gradient-compliance or drainage test). The reference ramp is far shorter than a workable climb; the ${f2(m.run)} m run is a flagged correction.` });
  out.push({ id: 'gate', at: [(plan.gate.x0 + plan.gate.x1) / 2, plan.gate.y], level: 'carport',
    text: `Vehicle gate operation unresolved (position and type PROVISIONAL, as in the primary reference). Left leaf pocket ${gp.leftIssues.join('; ')}. Right pocket ${gp.rightIssues.join('; ')}. A waiting car (ASSUMED ${f2(env.length)} m envelope) stands on the ramp at up to ${m.waitingOnRamp.maxSlopePct.toFixed(1)}%; stopping, starting and gate operation there are unchecked. The 5 m V1.2 waiting zone is not carried forward as a requirement.` });
  out.push({ id: 'drain', at: [(plan.driveway.x0 + plan.driveway.x1) / 2 + 0.4, -0.45], level: 'road',
    text: 'Roadside drain crossings unresolved: the driveway and the steps both cross the open drain; construction, capacity and permission are unchecked and the drain is unaltered.' });
  out.push({ id: 'retaining', at: [plan.steps.x1 + 1.5, 0.1], level: 'land',
    text: `Retaining and excavation unresolved: the frontage wall retains ${f2(m.retainedAtFrontage)} m of raised ground and stands ${f2(m.frontWallAboveRoad)} m above the road; the driveway is cut between walls. Excavation, foundations, drainage and retaining design need qualified professionals.` });
  out.push({ id: 'steps', at: [(plan.steps.x0 + plan.steps.x1) / 2, plan.steps.y0 + 1.6], level: 'land',
    text: `Pedestrian steps: ${m.steps.risers} risers of ${(m.steps.riser * 1000).toFixed(0)} mm at this land level; no handrail, stair-compliance or step-free route is designed, and the primary reference shows no pedestrian gate (security unresolved).` });
  out.push({ id: 'stair', at: [10.25, 13.4], level: 'floor',
    text: 'Future stair provision only: a half-turn stair box is reserved in the entrance hall and narrows the entry passage once built. Upper-floor structure and PV relocation or removal are unresolved (R13–R15).' });
  out.push({ id: 'utility', at: [1.85, 18.4], level: 'floor',
    text: 'Utility is modelled as an enclosed room (as in the aerial reference) although the plan reference calls it a service yard; it is counted in the enclosed area.' });
  return out;
}

// ---------- V2.2: frontage components, pedestrian route, plantings, obstruction checks ----------
// Datasets with a `frontage` and a `route` (V2.2 onward) use these; V2.1 keeps the original site
// treatment above. The route is derived: only the crossing level, landing depths, path turning points
// and widths are data; the flight end, the upper landing, the path start and end, the porch steps and
// the porch corridor all follow from the flight and the porch steps at the given land level.
export const drainOf = plan => plan.frontage?.drain ?? plan.site.drain;
export const hasRoute = plan => Boolean(plan.frontage && plan.route);

// Lands at which the flight gains a riser, inside the owner-estimated range (from the riser rule in steps()).
export function riserChangeLands(plan) {
  const L = plan.levels, s = plan.steps, bottom = L.road.value + (plan.route?.bottomLanding.aboveRoad ?? L.apronAboveRoad.value);
  const out = [];
  for (let k = 1; k < 100; k++) {
    const land = k * s.maxRiser + bottom - L.yardAboveLand.value;
    if (land > L.land.min + 1e-9 && land < L.land.max - 1e-9) out.push({ land, risersAtOrBelow: k, risersAbove: k + 1 });
  }
  return out;
}
// Lands every route check is run at: the range ends, the default and both sides of each change point.
export function routeTestLands(plan) {
  const L = plan.levels.land, set = [L.min, L.default, L.max];
  for (const c of riserChangeLands(plan)) set.push(c.land - 0.001, c.land + 0.001);
  if (hasCarportOptions(plan)) for (const c of carportChangeLands(plan)) set.push(c.land - 0.001, c.land + 0.001);
  return [...new Set(set.map(v => +v.toFixed(4)))].sort((a, b) => a - b);
}

// Rectangles of an axis-aligned centreline path of width w. Internal corners are filled by extending
// each segment half the width past an inner vertex; the first and last segments stop exactly at the
// end points, so the path never runs onto the landing or the steps it joins.
export function pathRects(points, w) {
  const out = [], n = points.length - 1;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1];
    if (near(ax, bx) && near(ay, by)) continue;
    const e0 = i > 0 ? w / 2 : 0, e1 = i < n - 1 ? w / 2 : 0;
    if (near(ax, bx)) {
      const up = by > ay;
      out.push({ seg: i, axisAligned: true, rect: rect(ax - w / 2, up ? ay - e0 : by - e1, ax + w / 2, up ? by + e1 : ay + e0) });
    } else if (near(ay, by)) {
      const right = bx > ax;
      out.push({ seg: i, axisAligned: true, rect: rect(right ? ax - e0 : bx - e1, ay - w / 2, right ? bx + e1 : ax + e0, ay + w / 2) });
    } else out.push({ seg: i, axisAligned: false, rect: rect(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)) });
  }
  return out;
}

// The connected pedestrian route at one land level, as ordered components with plan rectangles and
// surface levels (metres above the road datum).
export function pedRoute(plan, land) {
  const R = plan.route, st = plan.steps, F = plan.frontage, lv = levels(plan, land), w = R.path.width;
  const sp = steps(plan, land), road = lv.road;
  const crossLevel = road + R.crossing.aboveRoad, bottomLevel = road + R.bottomLanding.aboveRoad;
  const crossing = { id: 'crossing', label: 'Drain crossing (schematic)', rect: rect(st.x0, F.drain.y0, st.x1, F.drain.y1), level: crossLevel, underside: crossLevel - R.crossing.thickness };
  const bottom = { id: 'bottomLanding', label: 'Bottom landing', rect: rect(st.x0, F.drain.y1, st.x1, st.y0), level: bottomLevel };
  const treads = [];
  for (let k = 1; k < sp.risers; k++) treads.push({ rect: rect(st.x0, st.y0 + (k - 1) * st.going, st.x1, st.y0 + k * st.going), level: bottomLevel + k * sp.riser });
  const flight = { id: 'flight', label: 'Flight', rect: rect(st.x0, st.y0, st.x1, sp.y1), from: bottomLevel, to: bottomLevel + sp.risers * sp.riser, risers: sp.risers, riser: sp.riser, going: st.going, treads };
  const upper = { id: 'upperLanding', label: 'Upper landing', rect: rect(st.x0, sp.y1, st.x1, sp.y1 + R.upperLanding.depth), level: lv.yard };
  const porchCell = roomCells(plan.rooms.find(r => r.id === R.porch))[0], es = plan.facade.entranceSteps;
  const stepsY0 = porchCell.y0 - (es.count - 1) * es.going, riseP = (lv.floor - lv.yard) / es.count;
  const pts = [[R.path.via[0][0], upper.rect.y1], ...R.path.via, [R.path.via.at(-1)[0], stepsY0]];
  const rects = pathRects(pts, w);
  const length = pts.slice(1).reduce((s, p, i) => s + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
  const path = { id: 'path', label: 'Garden path', points: pts, rects, rect: rects[0]?.rect, level: lv.yard, width: w, length };
  const ptreads = [];
  for (let k = 1; k < es.count; k++) ptreads.push({ rect: rect(es.x0, porchCell.y0 - k * es.going, es.x1, porchCell.y0 - (k - 1) * es.going), level: lv.yard + (es.count - k) * riseP });
  const porchSteps = { id: 'porchSteps', label: 'Porch steps', rect: rect(es.x0, stepsY0, es.x1, porchCell.y0), from: lv.yard, to: lv.yard + es.count * riseP, risers: es.count, riser: riseP, going: es.going, treads: ptreads };
  const door = plan.openings.find(o => o.id === R.entrance), dg = door ? openingGeom(plan, door) : null, end = pts.at(-1);
  const face = dg?.wall ? dg.wall.at - wallThickness(plan, dg.wall) / 2 : porchCell.y1;
  const lo = dg?.wall ? Math.min(end[0] - w / 2, dg.lo) : end[0] - w / 2, hi = dg?.wall ? Math.max(end[0] + w / 2, dg.hi) : end[0] + w / 2;
  const porch = { id: 'porch', label: 'Porch landing', rect: rect(lo, porchCell.y0, hi, face), level: lv.floor, cell: porchCell };
  const entrance = dg?.wall ? { id: 'entrance', label: 'Entrance door', door: door.id, lo: dg.lo, hi: dg.hi, y: face, level: lv.floor } : null;
  return { land, levels: lv, clearWidthMin: R.clearWidthMin, crossing, bottom, flight, upper, path, porchSteps, porch, entrance,
    components: [crossing, bottom, flight, upper, path, porchSteps, porch, entrance] };
}
// Every rectangle that must stay clear for walking, with its component id.
export function routeRects(route) {
  return [route.crossing, route.bottom, route.flight, route.upper, ...route.path.rects.map(r => ({ id: `path segment ${r.seg + 1}`, rect: r.rect })), route.porchSteps, route.porch]
    .map(c => ({ id: c.id, rect: c.rect }));
}

// Planting placeholders as footprints, deterministic so the viewer, the plan and the checks agree.
// Shrubs are kept inside their bed or strip (a disc of radius r around each centre).
export function plantings(plan) {
  const G = plan.garden, out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const fill = (b, base, rMin, rMax, spacing, tag) => {
    const w = b.x1 - b.x0, d = b.y1 - b.y0, n = Math.max(2, Math.floor(w / spacing));
    for (let k = 0; k < n; k++) {
      const r = Math.min(rMin + rnd() * (rMax - rMin), d / 2, w / 2);
      const x = clamp(b.x0 + ((k + 0.5) * w) / n + (rnd() - 0.5) * 0.3, b.x0 + r, b.x1 - r);
      const y = clamp((b.y0 + b.y1) / 2 + (rnd() - 0.5) * 0.3, b.y0 + r, b.y1 - r);
      out.push({ kind: 'shrub', where: tag, x, y, r, base });
    }
  };
  G.beds.forEach((b, i) => fill(b, 'garden', 0.3, 0.55, 0.8, `bed ${i + 1}`));
  const S = plan.frontage?.plantingStrip;
  if (S) fill(rect(S.x0 + 0.1, S.y0 + (plan.frontage.retainingEdge?.thickness ?? S.outerEdge.thickness) + 0.05, S.x1 - 0.1, S.y1 - 0.05), 'strip', 0.18, 0.3, 0.9, 'planting strip');
  for (const p of G.palms) out.push({ kind: 'palm', where: 'garden', x: p.x, y: p.y, r: 0.2, base: 'garden', height: p.height });
  for (const t of G.trees) out.push({ kind: 'tree', where: 'garden', x: t.x, y: t.y, r: 0.2, base: 'garden', height: t.height, crown: t.crown, flowering: t.flowering });
  for (const p of G.pots ?? []) out.push({ kind: 'pot', where: 'porch', x: p.x, y: p.y, r: p.r, base: 'floor' });
  return out;
}

// Footprints that must not stand on the walking route: planting, piers, walls (frontage, flight side
// walls, retaining, boundary and house walls).
// V2.4: the flight side walls start at the bottom landing (cut into the strip zone), not at the first riser.
export const flightWallY0 = plan => (plan.frontage?.retainingEdge ? plan.frontage.drain.y1 : plan.steps.y0);

export function routeObstacles(plan, land) {
  const st = plan.steps, sp = steps(plan, land), F = plan.frontage, S = plan.site, rw = plan.driveway.rightRetainingWall, g = plan.gate;
  const out = [];
  plan.garden.beds.forEach((b, i) => out.push({ what: `planting bed ${i + 1}`, rect: rect(b.x0, b.y0, b.x1, b.y1) }));
  for (const p of plantings(plan)) out.push({ what: `${p.kind} (${p.where})`, rect: rect(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r) });
  for (const p of plan.route.piers) out.push({ what: `pier ${p.id}`, rect: rect(p.x0, p.y0, p.x1, p.y1) });
  for (const p of [g.pierLeft, g.pierRight]) out.push({ what: 'gate pier', rect: rect(p.x0, p.y0, p.x1, p.y1) });
  const sy0 = flightWallY0(plan);
  out.push({ what: 'flight side wall (left)', rect: rect(st.x0 - st.sideWall, sy0, st.x0, sp.y1) });
  out.push({ what: 'flight side wall (right)', rect: rect(st.x1, sy0, st.x1 + st.sideWall, sp.y1) });
  out.push({ what: 'driveway retaining wall', rect: rect(rw.x0, rw.y0 ?? 0, rw.x1, rw.y1 ?? plan.carport.y0) });
  out.push({ what: 'main frontage wall', rect: rect(F.mainWall.x0, F.mainWall.y0, F.mainWall.x1, F.mainWall.y1) });
  out.push({ what: 'planting strip', rect: rect(F.plantingStrip.x0, F.plantingStrip.y0, F.plantingStrip.x1, F.plantingStrip.y1) });
  for (const [k, b] of Object.entries({ leftWall: S.leftWall, leftRearWall: S.leftRearWall, rightWall: S.rightWall })) if (b) out.push({ what: `boundary wall ${k}`, rect: rect(b.x0, b.y0, b.x1, b.y1) });
  out.push({ what: 'boundary wall rearWall', rect: rect(S.rearWall.x0, S.rearWall.y - 0.115, S.rearWall.x1, S.rearWall.y + 0.115) });
  plan.walls.forEach((w, i) => out.push({ what: `house wall ${w.id}`, rect: allBands(plan)[i] }));
  return out;
}

// Route checks at one land level. Returns error strings (empty when the route is continuous, its
// levels join, nothing overlaps the treads and nothing stands on it).
export function validateRoute(plan, land) {
  const errors = [], r = pedRoute(plan, land), e = (s) => errors.push(`land ${land.toFixed(3)}: ${s}`);
  const F = plan.frontage, R = plan.route, w = r.clearWidthMin, eq = (a, b) => Math.abs(a - b) <= 1e-6;
  const xOverlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const within = (inner, outer) => inner.x0 >= outer.x0 - 1e-6 && inner.x1 <= outer.x1 + 1e-6;
  // continuity: each component starts where the previous one ends, across at least the clear width
  const chain = [[r.crossing, r.bottom], [r.bottom, r.flight], [r.flight, r.upper]];
  for (const [a, b] of chain) {
    if (!eq(a.rect.y1, b.rect.y0)) e(`${a.label} ends at y ${a.rect.y1.toFixed(2)} but ${b.label} starts at ${b.rect.y0.toFixed(2)} (route disconnected)`);
    if (xOverlap(a.rect, b.rect) < w - 1e-6) e(`${a.label} and ${b.label} share less than the ${w} m clear width`);
  }
  if (!eq(r.crossing.rect.y0, F.roadEdge.y)) e('the drain crossing does not start at the road edge');
  if (!eq(r.crossing.rect.y0, F.drain.y0) || !eq(r.crossing.rect.y1, F.drain.y1)) e('the drain crossing does not span the drain exactly');
  const P = r.path, first = P.rects[0], last = P.rects.at(-1);
  if (!P.rects.length || P.rects.some(q => !q.axisAligned)) e('garden path segments must be axis-aligned and non-empty');
  else {
    const startEdge = rect(first.rect.x0, P.points[0][1], first.rect.x1, P.points[0][1]);
    if (!eq(P.points[0][1], r.upper.rect.y1) || !within(startEdge, r.upper.rect)) e('garden path does not start on the far edge of the upper landing (route disconnected)');
    const endY = P.points.at(-1)[1], endEdge = rect(last.rect.x0, endY, last.rect.x1, endY);
    if (!eq(endY, r.porchSteps.rect.y0) || !within(endEdge, r.porchSteps.rect)) e('garden path does not end at the foot of the porch steps (route disconnected)');
    for (const q of P.rects) if (Math.min(q.rect.x1 - q.rect.x0, q.rect.y1 - q.rect.y0) < w - 1e-6) e(`garden path segment ${q.seg + 1} is narrower than ${w} m`);
  }
  if (!eq(r.porchSteps.rect.y1, r.porch.rect.y0)) e('porch steps do not reach the porch');
  if (xOverlap(r.porchSteps.rect, r.porch.rect) < w - 1e-6) e('porch steps and the porch landing share less than the clear width');
  if (!r.entrance) e(`the route has no entrance door (${R.entrance})`);
  else if (!(r.entrance.lo >= r.porch.rect.x0 - 1e-6 && r.entrance.hi <= r.porch.rect.x1 + 1e-6 && eq(r.entrance.y, r.porch.rect.y1))) e('the porch landing does not lead to the entrance door');
  if (!within(r.porch.rect, r.porch.cell)) e('the porch landing route leaves the covered porch');
  // levels at every join
  const lv = r.levels;
  if (!eq(r.crossing.level, r.bottom.level)) e(`crossing (${r.crossing.level.toFixed(2)}) and bottom landing (${r.bottom.level.toFixed(2)}) levels differ`);
  if (F.verge) { if (!eq(r.bottom.level, lv.road + F.verge.aboveRoad)) e('bottom landing is not flush with the verge'); }
  else if (!eq(r.bottom.level, lv.toe)) e('bottom landing is not flush with the drain-side ground (toe level)');
  if (r.crossing.underside < lv.road - 1e-6) e('the crossing slab reaches into the drain channel (flow route blocked)');
  if (!eq(r.flight.from, r.bottom.level)) e('flight does not start from the bottom landing level');
  if (!eq(r.flight.to, r.upper.level)) e(`flight tops out at ${r.flight.to.toFixed(3)} m, not at the upper landing (${r.upper.level.toFixed(3)} m)`);
  if (!eq(r.upper.level, lv.yard) || !eq(P.level, r.upper.level)) e('upper landing and garden path are not level with the garden');
  if (!eq(r.porchSteps.from, P.level) || !eq(r.porchSteps.to, r.porch.level) || !eq(r.porch.level, lv.floor)) e('porch steps do not join the path and the porch levels');
  if (r.flight.riser > plan.steps.maxRiser + 1e-9 || r.flight.risers !== Math.ceil((r.flight.to - r.flight.from) / plan.steps.maxRiser - 1e-9)) e('flight riser count does not follow the riser rule');
  // depths and widths
  if (r.bottom.rect.y1 - r.bottom.rect.y0 < R.bottomLanding.minDepth - 1e-6) e(`bottom landing is shallower than ${R.bottomLanding.minDepth} m`);
  if (r.upper.rect.y1 - r.upper.rect.y0 < R.upperLanding.minDepth - 1e-6) e(`upper landing is shallower than ${R.upperLanding.minDepth} m`);
  for (const c of [r.crossing, r.bottom, r.flight, r.upper, r.porchSteps, r.porch]) if (c.rect.x1 - c.rect.x0 < w - 1e-6) e(`${c.label} is narrower than ${w} m`);
  // no component overlaps another (path segments may overlap each other at their corners)
  const rr = routeRects(r);
  for (let i = 0; i < rr.length; i++) for (let j = i + 1; j < rr.length; j++) {
    if (rr[i].id.startsWith('path') && rr[j].id.startsWith('path')) continue;
    if (rectOverlap(rr[i].rect, rr[j].rect) > 1e-6) e(`${rr[i].id} overlaps ${rr[j].id} (paving over treads or landings)`);
  }
  // nothing stands on the route; lawns may run under the path only; nothing is placed in the drain
  for (const o of routeObstacles(plan, land)) for (const q of rr) if (rectOverlap(o.rect, q.rect) > 1e-6) e(`${o.what} obstructs the route (${q.id})`);
  plan.garden.lawns.forEach((l, i) => { for (const q of rr.filter(q => !q.id.startsWith('path'))) if (rectOverlap(rect(l.x0, l.y0, l.x1, l.y1), q.rect) > 1e-6) e(`lawn ${i + 1} covers the ${q.id}`); });
  const drain = rect(-1e3, F.drain.y0, 1e3, F.drain.y1);
  for (const p of plantings(plan)) if (rectOverlap(drain, rect(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r)) > 0) e(`${p.kind} in the ${p.where} is inside the drain`);
  for (const b of [...plan.garden.beds, F.plantingStrip]) if (rectOverlap(drain, rect(b.x0, b.y0, b.x1, b.y1)) > 0) e('a planting bed or the planting strip is inside the drain');
  if (F.verge) { if (F.plantingStrip.y0 < F.verge.y1 - 1e-6 || F.verge.y0 < F.drain.y1 - 1e-6 || F.drain.y0 < F.roadEdge.y - 1e-6) e('frontage components overlap or are out of order (road edge → drain → verge → strip → wall)'); }
  else if (F.plantingStrip.y0 < F.drain.y1 - 1e-6 || F.drain.y0 < F.roadEdge.y - 1e-6 || F.mainWall.y0 < F.plantingStrip.y1 - 1e-6) e('frontage components overlap or are out of order (road edge → drain → retaining edge / strip → wall)');
  return { errors, route: r };
}

// Step-free: every enclosed room reaches each bathroom through enclosed rooms only, all on the one
// finished-floor level (no room carries a floorOffset step). Level-only; not an accessibility check.
export function stepFreeReport(plan) {
  const req = plan.requirements?.stepFreeToBathrooms;
  if (!req) return null;
  const enclosed = new Set(plan.rooms.filter(isEnclosed).map(r => r.id)), offset = id => plan.rooms.find(r => r.id === id)?.floorOffset ?? 0;
  const adj = new Map();
  for (const e of doorGraph(plan)) {
    if (!enclosed.has(e.a) || !enclosed.has(e.b) || Math.abs(offset(e.a) - offset(e.b)) > 1e-6) continue;
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push(e.a);
  }
  const missing = [];
  for (const bath of req.bathrooms) {
    const seen = new Set([bath]), q = [bath];
    while (q.length) for (const n of adj.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const id of enclosed) if (!seen.has(id)) missing.push(`${id} → ${bath}`);
  }
  return { ok: missing.length === 0, missing, bathrooms: req.bathrooms, rooms: enclosed.size };
}

// V2.2+: the issue list with short titles (the viewer shows titles and expands the text on demand).
function unresolvedIssuesRoute(plan, land) {
  const m = accessMetrics(plan, land), gp = gatePockets(plan), f2 = n => n.toFixed(2), env = plan.parameters.vehicleEnvelope;
  const r = pedRoute(plan, land), F = plan.frontage, st = plan.steps, R = ramp(plan);
  const mid = (a, b) => (a + b) / 2;
  return [
    { id: 'ramp', title: 'Driveway climb — clearance UNCHECKED', at: [mid(plan.driveway.x0, plan.driveway.x1), mid(R.y0, R.y1)], level: 'ramp',
      text: `Drawn rise ${f2(m.rise)} m over a ${f2(m.run)} m climb: average ${m.averageGradientPct.toFixed(1)}%, maximum local gradient ${m.maxLocalGradientPct.toFixed(1)}% (drawn shape; arithmetic only — not a bumper, breakover, approach/departure, gradient-compliance or drainage test). Unchanged from V2.1.` },
    { id: 'gate', title: 'Vehicle gate operation', at: [mid(plan.gate.x0, plan.gate.x1), plan.gate.y], level: 'carport',
      text: `Position and type PROVISIONAL, as in the primary reference. Left leaf pocket ${gp.leftIssues.join('; ')}. Right pocket ${gp.rightIssues.join('; ')}. A waiting car (ASSUMED ${f2(env.length)} m envelope) stands on the ramp at up to ${m.waitingOnRamp.maxSlopePct.toFixed(1)}%; stopping, starting and gate operation there are unchecked.` },
    { id: 'drain', title: 'Drain crossings (schematic)', at: [mid(st.x0, st.x1), mid(F.drain.y0, F.drain.y1)], level: 'road',
      text: `The driveway and the pedestrian route cross the open roadside drain on schematic slabs at +${f2(r.crossing.level)} m that leave the channel open beneath them (flow along the road, direction unknown). Span, supports, capacity, levels and authority permission are NOT designed; the drain is unaltered.` },
    { id: 'frontage', title: 'Verge and planting-strip ownership', at: [mid(F.plantingStrip.x0, F.plantingStrip.x1), mid(F.verge.y0, F.verge.y1)], level: 'verge',
      text: 'Whether the verge and the lower planting strip in front of the main wall belong to the parcel is unknown; they may be road reserve. The bottom landing, the driveway apron and the strip planting stand on them, so they may need permission or have to move inside the wall.' },
    { id: 'retaining', title: 'Retaining and excavation', at: [mid(F.mainWall.x0, F.mainWall.x1) + 3, F.mainWall.y0], level: 'strip',
      text: `The main wall retains ${f2(m.retainedByMainWall)} m of garden above the planting strip and stands ${f2(m.frontWallAboveRoad)} m above the road; the strip edge retains ${f2(m.retainedByStripEdge)} m; the driveway and the flight are cut between walls. Excavation, foundations, drainage and retaining design need qualified professionals.` },
    { id: 'route', title: `Pedestrian route — ${r.flight.risers} risers here`, at: [st.x1 + 0.6, mid(r.flight.rect.y0, r.flight.rect.y1)], level: 'route',
      text: `One continuous route is drawn: crossing → bottom landing → ${r.flight.risers} risers of ${(r.flight.riser * 1000).toFixed(0)} mm → upper landing → ${f2(r.path.length)} m garden path → ${r.porchSteps.risers} porch risers → porch → entrance. The flight has ${steps(plan, plan.levels.land.min).risers}–${steps(plan, plan.levels.land.max).risers} risers across the land range in one run; an intermediate landing, handrails, lighting, a pedestrian gate (optional, upper landing) and a step-free street entrance are NOT designed. Route continuity and clearance are geometric checks only.` },
    { id: 'stair', title: 'Future stair and PV', at: [10.25, 13.4], level: 'floor',
      text: 'The owner prefers the future stair behind the carport or another suitable location (2026-10-22). V2.2 keeps the V2.1 hall reserve only because relocating it is a separate follow-up; it narrows the entry passage once built. Upper-floor structure and PV relocation or removal are unresolved (R13–R15).' },
    { id: 'utility', title: 'Utility enclosure', at: [1.85, 18.4], level: 'floor',
      text: 'Utility is modelled as an enclosed room (as in the aerial reference) although the plan reference calls it a service yard; it is counted in the enclosed area.' },
  ];
}

// ---------- V2.3: front-line gate, carport columns, gate study, waiting car, envelope, compaction ----------
// Datasets with gate.alignedTo === 'mainWall' (V2.3 onward) use these. Everything here is drawn-shape arithmetic
// on ASSUMED dimensions: it shows required space and conflicts; it never declares a gate workable.
export const isFrontGate = plan => plan.gate?.alignedTo === 'mainWall';

// Surface level (m above the road datum) on the driveway centreline at plan y: the carriageway, the schematic
// crossing slab over the drain, the level apron, the climb with its transitions, then the carport floor.
export function driveSurface(plan, land, y) {
  const F = plan.frontage, lv = levels(plan, land);
  if (F && y < F.roadEdge.y) return lv.road;
  if (F && y < F.drain.y1) return lv.apron;
  return rampHeight(plan, land, y);
}
const surfaceSlopePct = (plan, land, y) => 100 * Math.abs(driveSurface(plan, land, y + 0.05) - driveSurface(plan, land, y - 0.05)) / 0.1;

// Gate elevation DERIVED from the local driveway profile (never copied from the garden or carport level).
export function gateGeometry(plan, land) {
  const g = plan.gate, lv = levels(plan, land), env = plan.parameters.vehicleEnvelope, t = g.leafThickness ?? 0.08;
  const base = g.baseLevelOverride ?? driveSurface(plan, land, g.y);   // an override is a defect: validateFrontGate() rejects it
  const under = [g.y - t / 2, g.y + t / 2].map(y => driveSurface(plan, land, y));
  return {
    y: g.y, base, bottom: base + (g.bottomClearance ?? 0.05), top: base + g.height, pierTop: base + g.pierLeft.height,
    leafThickness: t, openingX0: g.x0, openingX1: g.x1, opening: g.x1 - g.x0, spare: g.x1 - g.x0 - env.width,
    slopePct: surfaceSlopePct(plan, land, g.y), stepUnderLeaf: Math.abs(under[1] - under[0]),
    belowGarden: lv.yard - base, belowCarport: lv.carport - base, source: g.base,
  };
}

// Footprint obstacles for gate movement, each with a conflict id prefix.
function gateObstacles(plan, land) {
  const st = plan.steps, sp = steps(plan, land), F = plan.frontage, S = plan.site, rw = plan.driveway.rightRetainingWall, route = pedRoute(plan, land);
  const out = [], add = (id, what, r) => out.push({ id, what, rect: r });
  for (const c of [route.crossing, route.bottom, route.flight, route.upper]) add('pedestrian-route', `the pedestrian ${c.label.toLowerCase()}`, c.rect);
  for (const p of plan.route.piers) add('pedestrian-route', `the pedestrian pier ${p.id}`, rect(p.x0, p.y0, p.x1, p.y1));
  add('pedestrian-route', 'the flight side wall', rect(st.x0 - st.sideWall, flightWallY0(plan), st.x0, sp.y1));
  add('pedestrian-route', 'the flight side wall', rect(st.x1, flightWallY0(plan), st.x1 + st.sideWall, sp.y1));
  add('walls', 'the driveway retaining wall', rect(rw.x0, rw.y0 ?? 0, rw.x1, rw.y1 ?? plan.carport.y0));
  add('walls', 'the main frontage wall', rect(F.mainWall.x0, F.mainWall.y0, F.mainWall.x1, F.mainWall.y1));
  add('boundary', 'the symbolic left boundary wall', rect(S.leftWall.x0, S.leftWall.y0, S.leftWall.x1, S.leftWall.y1));
  add('planting', 'the planting strip', rect(F.plantingStrip.x0, F.plantingStrip.y0, F.plantingStrip.x1, F.plantingStrip.y1));
  plan.garden.beds.forEach(b => add('planting', 'a planting bed', rect(b.x0, b.y0, b.x1, b.y1)));
  for (const p of plantings(plan)) add('planting', `a ${p.kind}`, rect(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r));
  if (F.verge) add('verge', 'the verge (ownership unknown)', rect(-1e3, F.verge.y0, 1e3, F.verge.y1));
  add('drain', 'the roadside drain', rect(-1e3, F.drain.y0, 1e3, F.drain.y1));
  add('road', 'the carriageway', rect(-1e3, S.road.y0, 1e3, F.roadEdge.y));
  return out;
}

// Points inside a quarter-disc sector (hinge, radius, direction of the closed leaf along x, side of the swing along y).
function quarterDisc(hx, hy, r, alongX, sideY, step = 0.1) {
  const pts = [];
  for (let i = 1; i * step <= r + 1e-9; i++) for (let a = 3; a < 90; a += 6) {
    const t = (a * Math.PI) / 180, k = i * step;
    pts.push([hx + alongX * k * Math.cos(t), hy + sideY * k * Math.sin(t)]);
  }
  return pts;
}

// The gate study at one land level: opening envelope, ground clearance, the space each operating option needs
// and what it meets, plus the waiting car. Returns conflicts as { id, text }; ids are stable and must be flagged
// in plan.gate.flags.
export function gateStudy(plan, land) {
  const g = plan.gate, F = plan.frontage, d = plan.driveway, env = plan.parameters.vehicleEnvelope, geo = gateGeometry(plan, land);
  const t = geo.leafThickness, leafLen = geo.opening + g.leafOverlap, half = geo.opening / 2, obs = gateObstacles(plan, land);
  const f2 = n => n.toFixed(2);
  const hit = (pointsOrRect, ids) => {
    const found = new Map();
    for (const o of obs) {
      if (ids && !ids.includes(o.id)) continue;
      const touch = Array.isArray(pointsOrRect) ? pointsOrRect.some(([x, y]) => inRect(o.rect, x, y)) : rectOverlap(pointsOrRect, o.rect) > 1e-6;
      if (touch && !found.has(o.id)) found.set(o.id, o.what);
    }
    return found;
  };
  const band = (x0, x1) => rect(x0, g.y - t / 2 - 0.06, x1, g.y + t / 2 + 0.06);
  const options = [];
  // sliding, pocket right / left (the leaf stays on the front-wall line)
  const right = band(g.x1, g.x1 + leafLen), left = band(g.x0 - leafLen, g.x0);
  const sr = { id: 'slide-right', label: g.options.find(o => o.id === 'slide-right')?.label, zone: right, required: `${f2(leafLen)} m of clear track beside the opening (x ${f2(g.x1)} to ${f2(g.x1 + leafLen)}) on the front-wall line`, conflicts: [] };
  for (const [id, what] of hit(right, ['pedestrian-route', 'walls', 'planting'])) sr.conflicts.push({ id: `slide-right:${id}`, text: `meets ${what}` });
  const sl = { id: 'slide-left', label: g.options.find(o => o.id === 'slide-left')?.label, zone: left, required: `${f2(leafLen)} m of clear track beside the opening (x ${f2(g.x0 - leafLen)} to ${f2(g.x0)})`, conflicts: [] };
  const beyond = Math.max(0, plan.site.leftWall.x1 - left.x0);
  if (beyond > 0) sl.conflicts.push({ id: 'slide-left:boundary', text: `runs ${f2(beyond)} m beyond the symbolic left boundary, where the neighbouring land is unknown` });
  options.push(sr, sl);
  // double swing leaves, each half the opening, hinged on the piers; inward over the driveway, outward over the verge
  const swing = (id, inward) => {
    const sideY = inward ? 1 : -1, pts = [...quarterDisc(g.x0, g.y, half, 1, sideY), ...quarterDisc(g.x1, g.y, half, -1, sideY)];
    const o = { id, label: g.options.find(q => q.id === id)?.label, points: pts, hinges: [[g.x0, g.y], [g.x1, g.y]], radius: half, sideY, required: `two leaves of ${f2(half)} m sweeping ${f2(half)} m ${inward ? 'inward over the driveway (to y ' + f2(g.y + half) + ')' : 'outward over the ' + (F.verge ? 'verge' : 'drain crossing') + ' (to y ' + f2(g.y - half) + ')'}`, conflicts: [] };
    return o;
  };
  const si = swing('swing-in', true), so = swing('swing-out', false);
  // ground clearance: the surface under the inward sweep rises above the hinge level
  const rise = Math.max(...Array.from({ length: 31 }, (_, i) => driveSurface(plan, land, g.y + (half * i) / 30))) - geo.base;
  si.groundRise = rise;
  if (rise > (g.bottomClearance ?? 0.05)) si.conflicts.push({ id: 'swing-in:ground-clearance', text: `the surface rises ${f2(rise)} m under the sweep, above the ${f2(g.bottomClearance ?? 0.05)} m leaf clearance` });
  for (const [id, what] of hit(si.points, ['pedestrian-route', 'walls', 'planting', 'boundary'])) si.conflicts.push({ id: `swing-in:${id}`, text: `meets ${what}` });
  for (const [id, what] of hit(so.points, ['verge', 'drain', 'road', 'planting', 'pedestrian-route'])) so.conflicts.push({ id: `swing-out:${id}`, text: `sweeps ${what}` });
  // waiting car (generic envelope) centred on the driveway, nose 0.3 m outside the closed leaf
  const cx = (d.x0 + d.x1) / 2, y1 = g.y - t / 2 - (g.waitingGap ?? 0.3), y0 = y1 - env.length, car = rect(cx - env.width / 2, y0, cx + env.width / 2, y1);
  if (so.points.some(([x, y]) => inRect(car, x, y))) so.conflicts.push({ id: 'swing-out:waiting-car', text: 'sweeps the space a waiting car occupies' });
  options.push(si, so);
  const over = (a0, a1) => Math.max(0, Math.min(y1, a1) - Math.max(y0, a0));
  const surf = Array.from({ length: 19 }, (_, i) => driveSurface(plan, land, y0 + ((y1 - y0) * i) / 18));
  const encroach = Math.max(0, F.roadEdge.y - y0);
  const waiting = {
    rect: car, y0, y1, length: env.length, width: env.width, base: Math.min(...surf), top: Math.min(...surf) + env.height,
    available: y1 - F.roadEdge.y, shortfall: Math.max(0, env.length - (y1 - F.roadEdge.y)), encroach,
    overDrain: over(F.drain.y0, F.drain.y1), overVerge: F.verge ? over(F.verge.y0, F.verge.y1) : 0, overApron: over(F.drain.y1, y1), overRoad: over(plan.site.road.y0, F.roadEdge.y),
    conflicts: [],
  };
  if (encroach > 0) waiting.conflicts.push({ id: 'waiting:road-encroachment', text: `the car projects ${f2(encroach)} m past the road edge into the carriageway (display width, not measured); only ${f2(waiting.available)} m of the ${f2(env.length)} m car fits between the gate and the road edge` });
  if (waiting.overDrain > 0) waiting.conflicts.push({ id: 'waiting:drain', text: `the car stands on ${f2(waiting.overDrain)} m of the schematic drain crossing (capacity unchecked)` });
  if (waiting.overVerge > 0) waiting.conflicts.push({ id: 'waiting:verge', text: `the car stands on ${f2(waiting.overVerge)} m of the verge (ownership unknown)` });
  return { land, geo, options, waiting, conflicts: [...options.flatMap(o => o.conflicts), ...waiting.conflicts], leafLength: leafLen, half };
}
export function allGateConflicts(plan) {
  const m = new Map();
  for (const land of [plan.levels.land.min, plan.levels.land.default, plan.levels.land.max]) for (const c of gateStudy(plan, land).conflicts) if (!m.has(c.id)) m.set(c.id, c.text);
  return m;
}

// Garden size and depth (drawn lawn + beds; depth from the main wall's inner face to the porch / house wall front).
export function gardenMetrics(plan) {
  const G = plan.garden, rects = [...G.lawns, ...G.beds].map(b => rect(b.x0, b.y0, b.x1, b.y1));
  const wallFace = plan.frontage ? plan.frontage.mainWall.y1 : plan.site.frontWall.y1;
  const porch = plan.rooms.find(r => r.id === 'porch');
  const wallFront = Math.min(...plan.rooms.filter(isEnclosed).flatMap(roomCells).map(c => c.y0));
  const porchFront = Math.min(wallFront, ...(porch ? roomCells(porch).map(c => c.y0) : []));
  return { area: unionArea(rects), depthToPorch: porchFront - wallFace, depthToHouseWall: wallFront - wallFace, porchFront, wallFront, wallFace };
}

// Conceptual near-square planning envelope: rectangle, aspect, area (separate from display bounds).
export function envelopeMetrics(plan) {
  const E = plan.site.conceptualEnvelope; if (!E) return null;
  const w = E.x1 - E.x0, d = E.y1 - E.y0;
  return { rect: rect(E.x0, E.y0, E.x1, E.y1), w, d, aspect: Math.max(w, d) / Math.min(w, d), area: w * d };
}

// Validation for the front-line gate, carport columns and the conceptual envelope. Errors = the dataset contradicts
// itself or an obstruction is not flagged; the conflicts themselves are design findings, not errors.
export function validateFrontGate(plan, errors, warnings, info) {
  const g = plan.gate, F = plan.frontage, cp = plan.carport, env = plan.parameters.vehicleEnvelope, L = plan.levels.land;
  const mw = (F.mainWall.y0 + F.mainWall.y1) / 2;
  if (Math.abs(g.y - mw) > 0.20) errors.push(`gate is not on the main front-wall line (gate y ${g.y.toFixed(2)}, wall centre ${mw.toFixed(2)})`);
  if (g.base !== 'driveway') errors.push('gate base must follow the driveway surface, not the raised garden or the carport');
  if (g.baseLevelOverride !== undefined) errors.push('gate elevation is hard-coded (baseLevelOverride); it must be derived from the driveway surface');
  if (g.y < F.drain.y1 || g.y > ramp(plan).y0 + ramp(plan).tb) warnings.push('gate stands off the level apron: its base slope is not zero');
  // gate elevation: derived and independently re-derived from the sampled driveway profile
  const prof = lnd => rampProfile(plan, lnd, 4000);
  for (const land of [L.min, L.default, L.max]) {
    const geo = gateGeometry(plan, land), lv = levels(plan, land), p = prof(land);
    const y0 = p[0][0], y1 = p.at(-1)[0];
    let ind;
    if (g.y <= y0) ind = lv.apron; else if (g.y >= y1) ind = lv.carport;
    else { const i = Math.max(1, p.findIndex(q => q[0] >= g.y)), a = p[i - 1], b = p[i]; ind = a[1] + ((b[1] - a[1]) * (g.y - a[0])) / (b[0] - a[0]); }
    if (Math.abs(geo.base - ind) > 1e-4) errors.push(`gate base at land ${land} is not derived from the driveway surface (${geo.base.toFixed(3)} vs ${ind.toFixed(3)})`);
    if (Math.abs(geo.base - lv.yard) < 0.2 || Math.abs(geo.base - lv.carport) < 0.2) errors.push(`gate base at land ${land} sits at the garden or carport level instead of the driveway surface`);
    if (!(geo.bottom > geo.base && geo.top > geo.bottom + 1.0)) errors.push(`gate leaf at land ${land} has no ground clearance or no height`);
    if (!(geo.pierTop > geo.top)) errors.push('gate piers must be taller than the leaf');
    if (geo.spare < 0.9) errors.push(`gate opening leaves only ${geo.spare.toFixed(2)} m beside the car envelope (minimum 0.90 m)`);
  }
  // gate piers: on the gate line, flanking the opening, independent of the carport roof and columns
  const roofRect = rect(cp.x0 - 0.115, cp.y0 - (cp.roofFrontOverhang ?? 0), cp.x1 + 0.115, cp.y1), cols = cp.columns ?? [];
  for (const pr of [g.pierLeft, g.pierRight]) {
    const r = rect(pr.x0, pr.y0, pr.x1, pr.y1);
    if (!(pr.y0 <= g.y && pr.y1 >= g.y)) errors.push(`gate pier ${pr.id} is not on the gate line`);
    if (rectOverlap(r, roofRect) > 0) errors.push(`gate pier ${pr.id} stands under the carport roof (gate piers must be independent of the carport columns)`);
    for (const c of cols) if (rectOverlap(r, rect(c.x0, c.y0, c.x1, c.y1)) > 0) errors.push(`gate pier ${pr.id} overlaps carport column ${c.id}`);
  }
  if (!(g.pierLeft.x1 <= g.x0 + TOL && g.pierRight.x0 >= g.x1 - TOL)) errors.push('gate piers do not flank the opening');
  // carport roof columns
  if (cols.length < 2) errors.push(`the carport roof needs its own columns (found ${cols.length}); the gate piers do not carry it`);
  const ids = new Set();
  for (const c of cols) {
    if (ids.has(c.id)) errors.push(`duplicate carport column id ${c.id}`); ids.add(c.id);
    if (!(c.x0 >= cp.x0 - 0.115 - TOL && c.x1 <= cp.x1 + 0.115 + TOL && c.y0 >= cp.y0 - (cp.roofFrontOverhang ?? 0) - TOL && c.y1 <= cp.y1 + TOL)) errors.push(`carport column ${c.id} is outside the carport roof footprint`);
    if (Math.abs((c.y0 + c.y1) / 2 - cp.y0) > 0.6) errors.push(`carport column ${c.id} is not at the carport front`);
  }
  if (cols.length >= 2) {
    const xs = [...cols].sort((a, b) => a.x0 - b.x0), clear = xs.at(-1).x0 - xs[0].x1;
    if (clear < env.width + 0.5) errors.push(`carport columns leave ${clear.toFixed(2)} m clear, too narrow for the ${env.width} m car envelope`);
    for (const c of cols) for (const f of plan.furniture.filter(q => q.type === 'vehicle')) if (rectOverlap(rect(c.x0, c.y0, c.x1, c.y1), rect(f.x0, f.y0, f.x1, f.y1)) > 0) errors.push(`carport column ${c.id} overlaps the parked car`);
    for (const c of cols) if (c.x1 > g.x0 && c.x0 < g.x1 && Math.abs(c.y0 - g.y) < 3) errors.push(`carport column ${c.id} stands in the gate line`);
  }
  // gate pier and route separation
  const route = pedRoute(plan, L.default), rr = routeRects(route);
  for (const pr of [g.pierLeft, g.pierRight]) for (const q of rr) if (rectOverlap(rect(pr.x0, pr.y0, pr.x1, pr.y1), q.rect) > 1e-6) errors.push(`gate pier ${pr.id} overlaps the pedestrian route (${q.id})`);
  // gate study: all conflicts must be flagged; no option may be declared workable while conflicts remain
  const found = allGateConflicts(plan), flagged = new Set(g.flags ?? []);
  for (const [id, text] of found) if (!flagged.has(id)) errors.push(`gate obstruction "${id}" is not flagged in gate.flags — ${text}`);
  for (const id of flagged) if (!found.has(id)) warnings.push(`gate.flags lists "${id}" but the geometry no longer produces it`);
  const claimsWorkable = /\b(workable|works|acceptable|adequate)\b/i.test(g.verdict ?? '') && !/NOT\b/i.test(g.verdict ?? '');
  if (claimsWorkable && found.size) errors.push('the gate is declared workable although conflicts remain; show the required space instead');
  if (!/NOT DEMONSTRATED/.test(g.verdict ?? '') && found.size) errors.push('gate.verdict must say NOT DEMONSTRATED while conflicts remain');
  info.gate = { y: g.y, lands: [L.min, L.default, L.max].map(l => { const s = gateStudy(plan, l); return { land: l, base: s.geo.base, bottom: s.geo.bottom, top: s.geo.top, slopePct: s.geo.slopePct, encroach: s.waiting.encroach, available: s.waiting.available, conflicts: s.conflicts.map(c => c.id), groundRise: s.options.find(o => o.id === 'swing-in').groundRise }; }), conflictIds: [...found.keys()] };
  // conceptual envelope
  const E = envelopeMetrics(plan), S = plan.site;
  if (!E) errors.push('missing conceptual planning envelope');
  else {
    const ev = S.conceptualEnvelope;
    if (!/CONCEPTUAL/.test(ev.evidence) || !/NOT (the parcel|surveyed)/i.test(ev.evidence)) errors.push('the envelope must be labelled CONCEPTUAL and not the parcel');
    if (ev.derivedFromArea !== false || ev.claims?.siteFit !== false || ev.claims?.setbacks !== false || ev.claims?.boundaries !== false) errors.push('the envelope must not claim to be derived from the land area, a site fit, setbacks or boundaries');
    if (E.aspect > (ev.nearSquareMaxAspect ?? 1.15)) errors.push(`the envelope is not near-square (${E.w.toFixed(2)} × ${E.d.toFixed(2)} m, aspect ${E.aspect.toFixed(2)})`);
    const D = S.display;
    if (E.rect.x0 === D.x0 && E.rect.x1 === D.x1 && E.rect.y0 === D.y0 && E.rect.y1 === D.y1) errors.push('the envelope must be separate from the display bounds');
    if (!(E.rect.x0 >= D.x0 && E.rect.x1 <= D.x1 && E.rect.y0 >= D.y0 && E.rect.y1 <= D.y1)) errors.push('the envelope is outside the display bounds');
    const inside = (r, what) => { if (!(r.x0 >= E.rect.x0 - TOL && r.x1 <= E.rect.x1 + TOL && r.y0 >= E.rect.y0 - TOL && r.y1 <= E.rect.y1 + TOL)) errors.push(`${what} is outside the conceptual envelope`); };
    for (const r of plan.rooms) for (const c of roomCells(r)) inside(c, `${r.id}`);
    for (const b of allBands(plan)) inside(b, 'a house wall');
    for (const b of [...plan.garden.lawns, ...plan.garden.beds]) inside(rect(b.x0, b.y0, b.x1, b.y1), 'a garden item');
    inside(F.mainWall, 'the main wall'); inside(rect(g.pierLeft.x0, g.pierLeft.y0, g.pierLeft.x1, g.pierLeft.y1), 'the left gate pier');
    // the crossing, bottom landing and flight start in the frontage zone in front of the main wall, outside the envelope by design
    for (const q of rr.filter(q => !['crossing', 'bottomLanding', 'flight'].includes(q.id))) inside(q.rect, `the route (${q.id})`);
    if (S.surveyEvidence) {
      const e=S.surveyEvidence;
      if (!(Number.isFinite(e.areaHectares) && e.areaHectares>0 && Number.isFinite(e.areaM2) && Math.abs(e.areaHectares*10000-e.areaM2)<1e-6 && /document transcription/.test(e.evidence??''))) errors.push('survey evidence: invalid documentary area or missing transcription label');
      if (!(S.landShape?.dimensionsKnown===false && /IMAGE-OBSERVED/.test(S.landShape.evidence??'') && e.boundaryCoordinates===null && e.boundaryLengths===null && e.spotLevels===null && e.modelAlignedToNorth===false && e.siteFit===false)) errors.push('survey evidence: undimensioned scan must not claim measured boundaries, levels, north alignment or site fit');
    } else if (!(S.landShape && /OWNER-ESTIMATED/.test(S.landShape.evidence) && S.landShape.dimensionsKnown === false)) errors.push('the almost-square land description must be recorded as OWNER-ESTIMATED with unknown dimensions');
    info.envelope = { w: E.w, d: E.d, aspect: E.aspect, area: E.area };
  }
  info.garden = gardenMetrics(plan);
}

// V2.3: the issue list (short titles; the viewer expands the text). Positions are data-driven.
function unresolvedIssuesFrontGate(plan, land) {
  const m = accessMetrics(plan, land), gs = gateStudy(plan, land), geo = gs.geo, w = gs.waiting, f2 = n => n.toFixed(2), env = plan.parameters.vehicleEnvelope;
  const r = pedRoute(plan, land), F = plan.frontage, st = plan.steps, R = ramp(plan), g = plan.gate, gm = gardenMetrics(plan), E = envelopeMetrics(plan);
  const mid = (a, b) => (a + b) / 2, rooms = roomsById(plan);
  const opt = id => gs.options.find(o => o.id === id);
  const sum = o => `${o.label}: needs ${o.required}; ${o.conflicts.length ? o.conflicts.map(c => c.text).join('; ') : 'no footprint conflict in the drawn geometry (not declared workable)'}`;
  const parent = plan.compaction?.parent;
  return [
    { id: 'ramp', title: 'Driveway climb — clearance UNCHECKED', at: [mid(plan.driveway.x0, plan.driveway.x1), mid(R.y0, R.y1)], level: 'ramp',
      text: `Drawn rise ${f2(m.rise)} m over a ${f2(m.run)} m climb: average ${m.averageGradientPct.toFixed(1)}%, maximum local gradient ${m.maxLocalGradientPct.toFixed(1)}% (drawn shape; arithmetic only — not a bumper, breakover, approach/departure, gradient-compliance or drainage test). Unchanged from V2.1 and V2.2: the climb was not shortened.` },
    { id: 'gate', title: 'Vehicle gate on the front-wall line — NOT DEMONSTRATED', at: [mid(g.x0, g.x1), g.y], level: 'gate',
      text: `The gate stands on the main front-wall line (y ${f2(g.y)}); its base is +${f2(geo.base)} m, derived from the driveway surface (${f2(geo.belowGarden)} m below the garden), with ${f2(g.bottomClearance)} m leaf clearance, ${f2(geo.opening)} m opening and ${f2(geo.spare)} m beside the ASSUMED car. ${sum(opt('slide-right'))}. ${sum(opt('slide-left'))}. ${sum(opt('swing-in'))}; the surface rises ${f2(opt('swing-in').groundRise)} m under the sweep. ${sum(opt('swing-out'))}. No option is declared workable.` },
    { id: 'waiting', title: `Waiting car: ${f2(w.encroach)} m into the road`, at: [(w.rect.x0 + w.rect.x1) / 2, mid(w.y0, w.y1)], level: 'road',
      text: `A car waiting with its nose ${f2(g.waitingGap)} m outside the closed gate occupies y ${f2(w.y0)} to ${f2(w.y1)}. Only ${f2(w.available)} m of its ${f2(env.length)} m (ASSUMED generic envelope) lies between the gate and the road edge: it projects ${f2(w.encroach)} m into the carriageway (display width, not measured), stands on ${f2(w.overDrain)} m of the schematic drain crossing and ${f2(w.overVerge)} m of the verge (ownership unknown). Automatic opening shortens the wait; it does not create waiting space. Obstruction flagged, not resolved.` },
    { id: 'drain', title: 'Drain crossings (schematic)', at: [mid(st.x0, st.x1), mid(F.drain.y0, F.drain.y1)], level: 'road',
      text: `The driveway and the pedestrian route cross the open roadside drain on schematic slabs at +${f2(r.crossing.level)} m that leave the channel open beneath them (flow along the road, direction unknown). Span, supports, capacity, levels and authority permission are NOT designed; a waiting car would stand on the driveway slab.` },
    { id: 'frontage', title: 'Verge and planting-strip ownership', at: [mid(F.plantingStrip.x0, F.plantingStrip.x1), mid(F.verge.y0, F.verge.y1)], level: 'verge',
      text: 'Whether the verge and the lower planting strip in front of the main wall belong to the parcel is unknown; they may be road reserve. The bottom landing, the driveway apron and the strip planting stand on them.' },
    { id: 'retaining', title: 'Retaining and excavation', at: [mid(F.mainWall.x0, F.mainWall.x1) + 3, F.mainWall.y0], level: 'strip',
      text: `The main wall retains ${f2(m.retainedByMainWall)} m of garden above the planting strip and stands ${f2(m.frontWallAboveRoad)} m above the road; the strip edge retains ${f2(m.retainedByStripEdge)} m; the driveway and the flight are cut between walls; the gate piers stand on the apron ${f2(geo.belowGarden)} m below the garden. Excavation, foundations, drainage and retaining design need qualified professionals.` },
    { id: 'route', title: `Pedestrian route — ${r.flight.risers} risers here`, at: [st.x1 + 0.6, mid(r.flight.rect.y0, r.flight.rect.y1)], level: 'route',
      text: `One continuous route is drawn: crossing → bottom landing → ${r.flight.risers} risers of ${(r.flight.riser * 1000).toFixed(0)} mm → upper landing → ${f2(r.path.length)} m garden path → ${r.porchSteps.risers} porch risers → porch → entrance. The flight has ${steps(plan, plan.levels.land.min).risers}–${steps(plan, plan.levels.land.max).risers} risers across the land range in one run; handrails, lighting, an intermediate landing and a step-free street entrance are NOT designed. A sliding gate to the right would cross this route.` },
    { id: 'compact', title: `Compact trial: garden ${parent ? '−' + (100 * (1 - gm.area / parent.gardenAreaM2)).toFixed(0) + '%' : ''}`, at: [11.0, gm.porchFront - 1.2], level: 'land',
      text: `The drawn lawn and beds are ${f2(gm.area)} m²${parent ? ` (V2.2: ${f2(parent.gardenAreaM2)} m²)` : ''} and the garden is ${f2(gm.depthToPorch)} m deep to the porch${parent ? ` (V2.2: ${f2(parent.depthToPorchM)} m)` : ''}. The house block moved 2.0 m toward the road beside the carport, rigidly, with no room scaled and the driveway climb unchanged. The carport is 1.0 m shorter and the utility 1.0 m shallower (explicit changes). ASSUMED visual trial, not an owner-confirmed target.` },
    { id: 'envelope', title: 'Conceptual envelope — not the parcel', at: [E.rect.x1 - 2.0, E.rect.y1 - 0.8], level: 'land',
      text: `The near-square envelope (${f2(E.w)} × ${f2(E.d)} m, aspect ${f2(E.aspect)}) is an ASSUMED composition frame. The land is OWNER-ESTIMATED as almost square; its boundaries, dimensions and orientation are unknown. It is not derived from the 20-perch estimate and makes no site-fit, setback or boundary claim.` },
    { id: 'stair', title: 'Future stair and PV', at: [...(rooms.stair?.labelAt ?? [10.25, 11.4])], level: 'floor',
      text: 'The owner prefers the future stair behind the carport or another suitable location (INFO08). V2.3 keeps the hall reserve because relocating it is a separate follow-up; it narrows the entry passage once built. Upper-floor structure and PV relocation or removal are unresolved (R13–R15).' },
    { id: 'utility', title: 'Utility enclosure, resized', at: [...(rooms.utility.labelAt ?? [1.85, 16.9])], level: 'floor',
      text: 'The utility is modelled enclosed (as in the aerial reference) and is smaller in V2.3 (about 8.4 m² clear, behind a 5.6 m carport) with its kitchen door moved; both are explicit changes. It is counted in the enclosed area.' },
  ];
}

// ---------- V2.4: frontage without the verge, independent carport floor (options A / B), carport walking route ----------
// Datasets with frontage.retainingEdge + levels.carportFloor + carportRoute (V2.4 onward) use these. Everything is
// drawn-shape arithmetic on ASSUMED dimensions (the ≈1 m visible face is OWNER-ESTIMATED — TO BE VERIFIED): it shows
// levels, step counts and conflicts; it is not a clearance, drainage, retaining, accessibility or code check.
export const hasRetainingEdge = plan => Boolean(plan.frontage?.retainingEdge);
export const hasCarportOptions = plan => Boolean(plan.levels?.carportFloor);
export const isV24 = plan => hasRetainingEdge(plan) && hasCarportOptions(plan) && Boolean(plan.carportRoute);
export const carportOptions = plan => plan.levels.carportFloor.options;
export const activeCarportOption = plan => plan.levels.carportFloor.options.find(o => o.id === plan.levels.carportFloor.active);
// A shallow copy of the plan with another carport option active (every level, profile, route and check follows it).
export const withCarportOption = (plan, id) => ({ ...plan, levels: { ...plan.levels, carportFloor: { ...plan.levels.carportFloor, active: id } } });

// Canopy roof: V2.4 keeps the roof level fixed relative to the land (retained from V2.3); the clear height above the carport floor follows the option.
export function carportRoof(plan, land) {
  const cp = plan.carport, lv = levels(plan, land);
  const underside = cp.roofUndersideAboveLand !== undefined ? land + cp.roofUndersideAboveLand : lv.carport + cp.clearHeight;
  return { underside, top: underside + cp.roofThickness, clear: underside - lv.carport };
}

const riserCount = (rise, maxRiser) => Math.max(1, Math.ceil(Math.abs(rise) / maxRiser - 1e-9));

// Lands inside the owner-estimated range at which a carport step count changes (both options, garden steps and service stair).
export function carportChangeLands(plan) {
  const L = plan.levels.land, mr = plan.steps.maxRiser, out = [], seen = new Set();
  for (const o of carportOptions(plan)) {
    const q = withCarportOption(plan, o.id);
    for (const [what, f] of [['garden', lv => lv.yard - lv.carport], ['service', lv => lv.floor - lv.carport]]) {
      const d0 = f(levels(q, L.min)), d1 = f(levels(q, L.max)), slope = (d1 - d0) / (L.max - L.min);
      if (Math.abs(slope) < 1e-9) continue;
      for (const sign of [1, -1]) for (let k = 1; k < 80; k++) {
        const land = L.min + (sign * k * mr - d0) / slope, key = `${o.id}|${what}|${land.toFixed(5)}`;
        if (land > L.min + 1e-9 && land < L.max - 1e-9 && !seen.has(key)) { seen.add(key); out.push({ option: o.id, what, land, risersAtOrBelow: k, risersAbove: k + 1 }); }
      }
    }
  }
  return out.sort((a, b) => a.land - b.land);
}

// The carport walking route at one land level for the ACTIVE carport option, as components with plan rectangles and levels.
export function carportRoute(plan, land) {
  const R = plan.carportRoute, cp = plan.carport, lv = levels(plan, land), st = plan.steps, es = plan.facade.entranceSteps, W = wallsById(plan);
  const car = plan.furniture.find(f => f.type === 'vehicle'), half = id => wallThickness(plan, W[id]) / 2, rw = plan.driveway.rightRetainingWall;
  const xL = W[R.leftWall].at + half(R.leftWall), xR = W[R.rightWall].at - half(R.rightWall), yRear = W[R.rearWall].at - half(R.rearWall);
  const door = plan.openings.find(o => o.id === plan.route.entrance), dg = door ? openingGeom(plan, door) : null;
  const porchCell0 = roomCells(plan.rooms.find(r => r.id === plan.route.porch))[0], face = dg?.wall ? dg.wall.at - wallThickness(plan, dg.wall) / 2 : porchCell0.y1;
  const C = lv.carport, G = lv.yard, Fl = lv.floor, c = R.clearWidth, y1 = R.walkY1, y0 = y1 - c, mr = st.maxRiser, going = st.going;
  // 1. walking strip beside the car (passenger side, house side) at carport level
  const strip = { id: 'carWalk', label: 'Walking strip beside the car', rect: rect(car.x1, cp.y0, xR, car.y1), level: C };
  // 2. level landing at the top of the driveway, in front of the carport; stands proud of the sloping ramp edge
  const p1 = rect(car.x1, y0, xR, cp.y0), p2 = rect(xR, y0, rw.x0, y1);
  let proud = 0;
  for (const r of [p1, p2]) for (let y = r.y0; y <= Math.min(r.y1, cp.y0) + 1e-9; y += 0.05) proud = Math.max(proud, C - rampHeight(plan, land, y));
  const platform = { id: 'platform', label: 'Landing (level with the carport)', rect: p1, rects: [p1, p2], level: C, proud };
  // 3. garden steps through the opening in the driveway retaining wall: from the carport level to the garden (up or down), derived
  const rise2 = G - C, n = R.risersOverride ?? riserCount(rise2, mr), riser = rise2 / n, x0f = rw.x0, x1f = x0f + (n - 1) * going;
  const treads = [];
  for (let k = 1; k < n; k++) treads.push({ rect: rect(x0f + (k - 1) * going, y0, x0f + k * going, y1), level: C + k * riser });
  const flight = { id: 'flight2', label: 'Garden steps', rect: rect(x0f, y0, x1f, y1), from: C, to: C + n * riser, risers: n, riser, going, treads, direction: rise2 >= 0 ? 'up' : 'down', rise: rise2 };
  const upper = { id: 'upperLanding2', label: 'Upper landing (garden level)', rect: rect(x1f, y0, x1f + R.upperLanding.depth, y1), level: G };
  // 4. garden path along the house front, then the west porch steps (same riser rule as the front porch steps), the porch landing and the entrance
  const porchCell = roomCells(plan.rooms.find(r => r.id === plan.route.porch))[0], px1 = porchCell.x0, px0 = px1 - (es.count - 1) * es.going, pr = (Fl - G) / es.count;
  const path = { id: 'path2', label: 'Garden path (house front)', rect: rect(upper.rect.x1, y0, px0, y1), level: G, length: px0 - upper.rect.x1 };
  const wtreads = [];
  for (let k = 1; k < es.count; k++) wtreads.push({ rect: rect(px1 - k * es.going, y0, px1 - (k - 1) * es.going, y1), level: G + (es.count - k) * pr });
  const westSteps = { id: 'westSteps', label: 'West porch steps', rect: rect(px0, y0, px1, y1), from: G, to: Fl, risers: es.count, riser: pr, going: es.going, treads: wtreads };
  const westLanding = { id: 'westLanding', label: 'Porch landing (west)', rect: rect(px1, y0, dg ? dg.hi : px1 + c, face), level: Fl, cell: porchCell };
  const entrance = dg?.wall ? { id: 'entrance2', door: door.id, lo: dg.lo, hi: dg.hi, y: face, level: Fl } : null;
  // 5. utility service doorway: raised landing at floor level against the door, derived stair along the left wall (out of the car envelope)
  const sv = R.service, sdoor = plan.openings.find(o => o.id === sv.door), sg = sdoor ? openingGeom(plan, sdoor) : null, sface = yRear;
  const sLanding = rect(xL, sface - sv.landingDepth, Math.max(sg ? sg.hi : 0, xL + sv.stairWidth), sface);
  const rise3 = Fl - C, n3 = sv.risersOverride ?? riserCount(rise3, mr), riser3 = rise3 / n3, sy1 = sLanding.y0, sTreads = [];
  for (let k = 1; k < n3; k++) sTreads.push({ rect: rect(xL, sy1 - k * going, xL + sv.stairWidth, sy1 - (k - 1) * going), level: C + k * riser3 });
  const service = {
    id: 'service', label: 'Utility service landing + steps', door: sv.door, doorGeom: sg,
    landing: { id: 'serviceLanding', rect: sLanding, level: Fl },
    flight: { id: 'serviceSteps', rect: rect(xL, sy1 - (n3 - 1) * going, xL + sv.stairWidth, sy1), from: C, to: C + n3 * riser3, risers: n3, riser: riser3, going, treads: sTreads, rise: rise3 },
  };
  // 6. door-opening zones beside the parked car (ASSUMED cabin doors)
  const dz = R.doorZone, z0 = car.y0 + dz.fromNose, z1 = car.y0 + dz.toNose;
  const doorLeft = rect(Math.max(xL, car.x0 - R.doorOpening), z0, car.x0, z1), doorRight = rect(car.x1, z0, Math.min(xR, car.x1 + R.doorOpening), z1);
  return { land, levels: lv, option: activeCarportOption(plan).id, xL, xR, yRear, car, strip, platform, flight, upper, path, westSteps, westLanding, entrance, service, doorLeft, doorRight,
    walkRects: [strip, { id: 'platform', rect: p1 }, { id: 'platform (east part)', rect: p2 }, flight, upper, path, westSteps, westLanding].map(q => ({ id: q.id, rect: q.rect })) };
}

// Footprints that must not stand on the carport walking route.
function carportObstacles(plan, land) {
  const out = routeObstacles(plan, land), car = plan.furniture.find(f => f.type === 'vehicle');
  for (const c of plan.carport.columns ?? []) out.push({ what: `carport column ${c.id}`, rect: rect(c.x0, c.y0, c.x1, c.y1) });
  retainingWallPieces(plan).slice(1).forEach(q => out.push({ what: 'the retaining wall north of the stair', rect: q }));
  const r = pedRoute(plan, land);
  for (const q of routeRects(r)) if (q.id !== 'porch') out.push({ what: `the street route (${q.id})`, rect: q.rect });   // the porch floor is shared by both routes (same level)
  return { obstacles: out, car: rect(car.x0, car.y0, car.x1, car.y1) };
}

// Route checks for the ACTIVE option at one land level. Door-zone / kerb / driveway overlaps are findings (flagged), not errors.
export function validateCarportRoute(plan, land) {
  const errors = [], r = carportRoute(plan, land), R = plan.carportRoute, st = plan.steps, id = activeCarportOption(plan).id, lv = r.levels, c = R.clearWidth;
  const e = s => errors.push(`carport ${id} · land ${land.toFixed(3)}: ${s}`), eq = (a, b) => Math.abs(a - b) <= 1e-6, xo = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const [p1, p2] = r.platform.rects, cp = plan.carport;
  // widths
  const sw = r.strip.rect.x1 - r.strip.rect.x0;
  if (sw < R.carWalkMin - 1e-6) e(`the walking strip beside the car is ${sw.toFixed(2)} m, narrower than the ${R.carWalkMin} m minimum`);
  const turn = (p1.x1 - p1.x0) + (p2.x1 - p2.x0);
  if (turn < c - 1e-6) e(`the landing is ${turn.toFixed(2)} m long before the garden steps, shorter than ${c} m`);
  if (r.flight.rect.y1 - r.flight.rect.y0 < c - 1e-6) e(`the garden steps are narrower than ${c} m`);
  if (r.upper.rect.x1 - r.upper.rect.x0 < R.upperLanding.minDepth - 1e-6) e(`the upper landing is shallower than ${R.upperLanding.minDepth} m`);
  if (r.path.length < -1e-6) e('the upper landing runs into the west porch steps (the garden path has no length)');
  // continuity: each component starts where the previous one ends
  if (!eq(r.strip.rect.y0, p1.y1)) e('the walking strip does not meet the landing (route disconnected)');
  else if (xo(r.strip.rect, p1) < R.carWalkMin - 1e-6) e('the walking strip and the landing share less than the minimum width');
  if (!eq(p2.x1, r.flight.rect.x0) || !eq(p2.y0, r.flight.rect.y0)) e('the landing does not reach the garden steps (route disconnected)');
  if (!eq(r.flight.rect.x1, r.upper.rect.x0)) e('the upper landing does not follow the garden steps');
  if (!eq(r.upper.rect.x1, r.path.rect.x0) || !eq(r.path.rect.x1, r.westSteps.rect.x0)) e('the garden path does not join the upper landing and the west porch steps');
  if (!eq(r.westSteps.rect.x1, r.westLanding.rect.x0)) e('the west porch steps do not reach the porch landing');
  if (!r.entrance) e('the carport route has no entrance door');
  else if (!(r.entrance.lo >= r.westLanding.rect.x0 - 1e-6 && r.entrance.hi <= r.westLanding.rect.x1 + 1e-6 && eq(r.entrance.y, r.westLanding.rect.y1))) e('the west porch landing does not lead to the entrance door');
  const pc = r.westLanding.cell;
  if (!(r.westLanding.rect.x0 >= pc.x0 - 1e-6 && r.westLanding.rect.x1 <= pc.x1 + 1e-6 && r.westLanding.rect.y1 <= pc.y1 + 1e-6)) e('the west porch landing leaves the covered porch');
  // levels at every join
  if (!eq(r.platform.level, lv.carport) || !eq(r.strip.level, lv.carport)) e('the landing and the walking strip are not level with the carport floor');
  if (!eq(r.flight.from, lv.carport)) e('the garden steps do not start at the carport level');
  if (!eq(r.flight.to, lv.yard)) e(`the garden steps top out at ${r.flight.to.toFixed(3)} m, not at the garden (${lv.yard.toFixed(3)} m)`);
  if (!eq(r.upper.level, lv.yard) || !eq(r.path.level, lv.yard) || !eq(r.westSteps.from, lv.yard)) e('the upper landing, the garden path and the west steps are not level with the garden');
  if (!eq(r.westSteps.to, lv.floor) || !eq(r.westLanding.level, lv.floor)) e('the west porch steps do not reach the house finished floor');
  if (Math.abs(r.flight.riser) > st.maxRiser + 1e-9 || r.flight.risers !== riserCount(r.flight.rise, st.maxRiser)) e('the garden-step riser count does not follow the riser rule (step count must be derived from the level difference)');
  if (r.westSteps.riser > st.maxRiser + 1e-9) e('the west porch steps exceed the maximum riser');
  // utility service doorway: a landing and derived steps, no floating doorway, nothing in the parking space
  const sv = r.service, sdoor = sv.doorGeom;
  if (!sdoor) e(`the utility service door ${plan.carportRoute.service.door} is missing`);
  else {
    const dw = openingGeom(plan, plan.openings.find(o => o.id === sv.door)).wall;
    if (!(sdoor.lo >= sv.landing.rect.x0 - 1e-6 && sdoor.hi <= sv.landing.rect.x1 + 1e-6 && eq(sv.landing.rect.y1, r.yRear))) e('the utility service door has no landing at its threshold (floating doorway)');
    if (dw.id !== R.rearWall) e('the utility service door is not on the carport rear wall');
  }
  if (!eq(sv.landing.level, lv.floor)) e('the utility service landing is not level with the utility floor');
  if (!eq(sv.flight.from, lv.carport) || !eq(sv.flight.to, lv.floor)) e('the utility service steps do not join the carport floor and the utility floor');
  if (Math.abs(sv.flight.riser) > st.maxRiser + 1e-9 || sv.flight.risers !== riserCount(sv.flight.rise, st.maxRiser)) e('the utility service-step riser count does not follow the riser rule');
  if (sv.flight.rect.y0 < cp.y0 - 1e-6) e('the utility service steps run out of the carport');
  // obstructions
  const { obstacles, car } = carportObstacles(plan, land);
  const parts = [...r.walkRects, { id: 'utility service landing', rect: sv.landing.rect }, { id: 'utility service steps', rect: sv.flight.rect }];
  for (const o of obstacles) for (const q of parts) if (rectOverlap(o.rect, q.rect) > 1e-6) e(`${o.what} obstructs the carport walking route (${q.id})`);
  for (const q of parts) if (rectOverlap(car, q.rect) > 1e-6) e(q.id.startsWith('utility service') ? `${q.id} overlap the parked car (steps blocking the parking space)` : `the walking route (${q.id}) overlaps the parked car`);
  plan.garden.lawns.forEach((l, i) => { for (const q of r.walkRects.filter(q => !q.id.startsWith('path'))) if (rectOverlap(rect(l.x0, l.y0, l.x1, l.y1), q.rect) > 1e-6) e(`lawn ${i + 1} covers the ${q.id}`); });
  // no overlap between components (the landing's two parts and the strip's end may touch only)
  const rr = r.walkRects;
  for (let i = 0; i < rr.length; i++) for (let j = i + 1; j < rr.length; j++) if (rectOverlap(rr[i].rect, rr[j].rect) > 1e-6) e(`${rr[i].id} overlaps ${rr[j].id} (paving over treads or landings)`);
  // the vehicle lane beside the landing must still take the car with margin
  const lane = r.platform.rect.x0 - plan.driveway.x0, env = plan.parameters.vehicleEnvelope;
  if (lane < env.width + 0.5) e(`the landing narrows the driveway lane to ${lane.toFixed(2)} m, too narrow for the ${env.width} m car envelope`);
  // headroom under the retained canopy
  const roof = carportRoof(plan, land);
  if (roof.clear < cp.minClearHeight - 1e-6) e(`headroom ${roof.clear.toFixed(2)} m is below the ${cp.minClearHeight} m minimum`);
  return { errors, route: r };
}

// Findings (not errors) for the ACTIVE option at one land level, with stable ids that must be flagged in carportRoute.flags.
export function carportStudy(plan, land) {
  const r = carportRoute(plan, land), R = plan.carportRoute, lv = r.levels, am = accessMetrics(plan, land), roof = carportRoof(plan, land), rm = ramp(plan), drv = plan.driveway, f2 = n => n.toFixed(2);
  const conflicts = [];
  if (rectOverlap(r.strip.rect, r.doorRight) > 1e-6) conflicts.push({ id: 'carport:walk-door-zone', text: `the ${f2(r.strip.rect.x1 - r.strip.rect.x0)} m walking strip beside the car is also the passenger door-opening space (${f2(R.doorOpening)} m); a 3.7 m carport cannot hold the car, both door zones and a clear walking strip` });
  if (rectOverlap(r.service.flight.rect, r.doorLeft) > 1e-6) conflicts.push({ id: 'carport:service-stair-door-zone', text: `the ${r.service.flight.risers}-riser utility service stair runs ${f2(rectOverlap(r.service.flight.rect, r.doorLeft) / (r.doorLeft.x1 - r.doorLeft.x0))} m into the driver-side door-opening zone` });
  if (r.platform.proud > R.proudTolerance) conflicts.push({ id: 'carport:platform-kerb', text: `the level landing stands up to ${f2(r.platform.proud)} m above the sloping top of the ramp (a kerb beside the vehicle path)` });
  if (r.platform.rects.some(q => rectOverlap(q, rect(drv.x0, rm.y0, drv.x1, plan.carport.y0)) > 1e-6)) conflicts.push({ id: 'carport:platform-on-driveway', text: 'the level landing occupies the right edge of the driveway at its top: the only vehicle/pedestrian overlap (the route avoids walking along the sloping driveway)' });
  const dGarden = lv.yard - lv.carport, dHouse = lv.floor - lv.carport;
  return {
    option: r.option, label: activeCarportOption(plan).label, land, levels: lv, route: r, conflicts,
    rise: am.rise, run: am.run, averageGradientPct: am.averageGradientPct, maxLocalGradientPct: am.maxLocalGradientPct,
    transitions: { bottom: rm.tb, top: rm.tt, straight: rm.run - rm.tb - rm.tt }, gardenDiff: dGarden, houseDiff: dHouse,
    gardenSteps: r.flight.risers, gardenRiser: r.flight.riser, gardenDirection: r.flight.direction, serviceSteps: r.service.flight.risers, serviceRiser: r.service.flight.riser,
    headroom: roof.clear, roofUnderside: roof.underside, platformProud: r.platform.proud, steps: r.flight.risers,
  };
}

// Both carport alternatives at one land level (same data, only the active option differs).
export function carportComparison(plan, land) {
  return carportOptions(plan).map(o => carportStudy(withCarportOption(plan, o.id), land));
}
// Lands every carport check is run at: range ends, default, and both sides of each step-count change.
export function carportTestLands(plan) { return routeTestLands(plan); }
export function allCarportConflicts(plan) {
  const m = new Map();
  for (const o of carportOptions(plan)) for (const land of carportTestLands(plan)) for (const c of carportStudy(withCarportOption(plan, o.id), land).conflicts) if (!m.has(c.id)) m.set(c.id, c.text);
  return m;
}

export const figureOf = plan => plan.scaleFigure ?? null;

// V2.4 validation: frontage without the verge, the ≈1 m visible face and its separate levels, independent carport levels (A, B),
// the walking route for both options at every test land, flags, the scale figure and the external-route wording.
export function validateV24(plan, errors, warnings, info) {
  const F = plan.frontage, E = F.retainingEdge, L = plan.levels.land, cp = plan.carport, S = plan.site, W = plan.parameters;
  // --- frontage: no verge; planting edge on the rear side of the drain; the visible face
  if (F.verge) errors.push('the extra verge band is still present (V2.4 removes it: road → open drain → raised retaining edge / planting strip → main wall)');
  if (Math.abs(E.y0 - F.drain.y1) > TOL) errors.push(`the planting edge (y ${E.y0}) is not coordinated with the rear side of the drain (y ${F.drain.y1})`);
  if (Math.abs(F.plantingStrip.y0 - E.y0) > TOL || Math.abs(F.plantingStrip.x0 - E.x0) > TOL || Math.abs(F.plantingStrip.x1 - E.x1) > TOL) errors.push('the planting strip does not start at the retaining edge');
  if (Math.abs(E.visibleFace - 1.0) > 0.1) errors.push(`the visible retaining face must be approximately 1.0 m (OWNER-ESTIMATED), not ${E.visibleFace} m`);
  if (!/OWNER-ESTIMATED/.test(E.faceEvidence ?? '') || !/TO BE VERIFIED/.test(E.faceEvidence ?? '')) errors.push('the visible retaining face must be labelled OWNER-ESTIMATED — TO BE VERIFIED');
  if (!(E.soilBelowCap >= 0.02)) errors.push('the planting soil surface must be separate from (below) the capping of the retaining edge');
  if (!(E.toeAboveRoad > 0)) errors.push('the retaining-face toe must stand on the adjoining drain-side ground above the road datum');
  if (!(E.thickness > 0 && F.plantingStrip.y1 - F.plantingStrip.y0 > E.thickness)) errors.push('the retaining edge is thicker than the planting strip');
  if (!(plan.derivedFrom?.coordinateShifts?.length)) errors.push('coordinate shifts and the change in frontage depth are not recorded');
  if (!(plan.route.bottomLanding.aboveRoad === E.toeAboveRoad && plan.route.crossing.aboveRoad === E.toeAboveRoad)) errors.push('the retaining-face toe is not level with the adjoining drain-side ground (crossing and bottom landing)');
  // separate frontage levels at every land level
  for (const land of [L.min, L.default, L.max]) {
    const lv = levels(plan, land);
    if (!(lv.road < lv.toe && lv.toe < lv.strip && lv.strip < lv.edgeCap && lv.strip < lv.yard && lv.yard < lv.floor)) errors.push(`frontage levels are not separate and ordered at land ${land} (toe ${lv.toe}, soil ${lv.strip}, capping ${lv.edgeCap}, garden ${lv.yard}, floor ${lv.floor})`);
    if (Math.abs(lv.edgeCap - lv.toe - E.visibleFace) > 1e-9) errors.push('the visible face is not the toe-to-capping height');
  }
  // --- carport options: independent, distinct, B lower than A
  const ids = carportOptions(plan).map(o => o.id);
  if (!(ids.includes('A') && ids.includes('B'))) errors.push('the carport alternatives A (V2.3 level) and B (lower) must both be defined');
  if (!ids.includes(plan.levels.carportFloor.active)) errors.push('the active carport option is not defined');
  const lands = carportTestLands(plan);
  info.carport = { options: ids, lands: lands.length, comparison: [L.min, L.default, L.max].map(l => ({ land: l, options: carportComparison(plan, l).map(s => ({ id: s.option, carport: s.levels.carport, rise: s.rise, avg: s.averageGradientPct, max: s.maxLocalGradientPct, gardenDiff: s.gardenDiff, houseDiff: s.houseDiff, gardenSteps: s.gardenSteps, serviceSteps: s.serviceSteps, headroom: s.headroom, proud: s.platformProud, conflicts: s.conflicts.map(c => c.id) })) })) };
  const seenErr = new Set(), found = new Map();
  for (const land of lands) {
    const A = carportOptions(plan).find(o => o.id === 'A') && withCarportOption(plan, 'A'), B = carportOptions(plan).find(o => o.id === 'B') && withCarportOption(plan, 'B');
    if (A && B) {
      const a = levels(A, land), b = levels(B, land);
      if (!(b.carport < a.carport - 0.05)) errors.push(`the lower alternative B (+${b.carport.toFixed(2)}) is not lower than the V2.3 level A (+${a.carport.toFixed(2)}) at land ${land.toFixed(3)}`);
    }
    for (const id of ids) {
      const q = withCarportOption(plan, id), lv = levels(q, land);
      if (Math.abs(lv.carport - lv.yard) < 0.02 || Math.abs(lv.carport - lv.floor) < 0.02) errors.push(`carport ${id} floor equals the garden or the house floor at land ${land.toFixed(3)} (the three levels must stay separate)`);
      if (!(lv.carport > lv.apron)) errors.push(`carport ${id} is not above the driveway apron at land ${land.toFixed(3)}`);
      const v = validateCarportRoute(q, land);
      for (const m of v.errors) if (!seenErr.has(m)) { seenErr.add(m); errors.push(m); }
      for (const cf of carportStudy(q, land).conflicts) if (!found.has(cf.id)) found.set(cf.id, cf.text);
    }
  }
  const flagged = new Set(plan.carportRoute.flags ?? []);
  for (const [id, text] of found) if (!flagged.has(id)) errors.push(`carport finding "${id}" is not flagged in carportRoute.flags — ${text}`);
  for (const id of flagged) if (!found.has(id)) warnings.push(`carportRoute.flags lists "${id}" but the geometry no longer produces it`);
  info.carport.conflictIds = [...found.keys()];
  // the external route is stepped: it must not be described as step-free
  const ev = `${plan.carportRoute.evidence} ${plan.carportRoute.service?.evidence ?? ''}`;
  if (/step-free/i.test(ev) && !/not\s+(a\s+)?step-free|not step-free/i.test(ev)) errors.push('the external carport route must not be described as step-free (it is stepped)');
  if (!/stepped|not step-free/i.test(ev)) errors.push('the carport route description must say that the external route is stepped');
  // --- scale figure standing in the road
  const fg = figureOf(plan);
  if (!fg) errors.push('the 1.70 m scale figure is missing');
  else {
    if (!(fg.height >= 1.6 && fg.height <= 1.8)) errors.push(`the scale figure is ${fg.height} m tall (an average adult is about 1.7 m)`);
    if (!(fg.y < F.roadEdge.y - 0.3 && fg.y > S.road.y0)) errors.push('the scale figure does not stand in the road');
    if (!/ASSUMED/.test(fg.evidence ?? '')) errors.push('the scale figure must be labelled ASSUMED');
  }
  info.v24 = { visibleFace: E.visibleFace, coordinateShifts: plan.derivedFrom.coordinateShifts.length, frontageDepth: F.mainWall.y0 - F.roadEdge.y };
}

// V2.4: the issue list (short titles; the viewer expands the text). Positions are data-driven.
function unresolvedIssuesV24(plan, land) {
  const m = accessMetrics(plan, land), gs = gateStudy(plan, land), geo = gs.geo, w = gs.waiting, f2 = n => n.toFixed(2), env = plan.parameters.vehicleEnvelope;
  const r = pedRoute(plan, land), F = plan.frontage, E = F.retainingEdge, st = plan.steps, R = ramp(plan), g = plan.gate, lv = levels(plan, land), cs = carportStudy(plan, land), cr = cs.route;
  const mid = (a, b) => (a + b) / 2, cmp = carportComparison(plan, land), En = envelopeMetrics(plan), rooms = roomsById(plan);
  const opt = id => gs.options.find(o => o.id === id);
  const sum = o => `${o.label}: needs ${o.required}; ${o.conflicts.length ? o.conflicts.map(c => c.text).join('; ') : 'no footprint conflict in the drawn geometry (not declared workable)'}`;
  const row = s => `${s.option}: floor ${s.levels.carport >= 0 ? '+' : '−'}${f2(Math.abs(s.levels.carport))}, rise ${f2(s.rise)} m, ${s.averageGradientPct.toFixed(1)}% avg / ${s.maxLocalGradientPct.toFixed(1)}% max, ${s.gardenSteps} garden ${s.gardenDirection === 'up' ? 'risers up' : 'riser down'}, ${s.serviceSteps} service risers, headroom ${f2(s.headroom)} m`;
  return [
    { id: 'ramp', title: `Driveway climb, carport ${cs.option} — clearance UNCHECKED`, at: [mid(plan.driveway.x0, plan.driveway.x1), mid(R.y0, R.y1)], level: 'ramp',
      text: `Active alternative ${cs.label}: drawn rise ${f2(m.rise)} m over a ${f2(m.run)} m climb: average ${m.averageGradientPct.toFixed(1)}%, maximum local gradient ${m.maxLocalGradientPct.toFixed(1)}% (drawn shape; arithmetic only — not a bumper, breakover, approach/departure, gradient-compliance or drainage test). Run unchanged from V2.1–V2.3. Alternatives at this land level — ${cmp.map(row).join(' | ')}.` },
    { id: 'gate', title: 'Vehicle gate on the front-wall line — NOT DEMONSTRATED', at: [mid(g.x0, g.x1), g.y], level: 'gate',
      text: `The gate stands on the main front-wall line (y ${f2(g.y)}); its base is +${f2(geo.base)} m, derived from the driveway surface (${f2(geo.belowGarden)} m below the garden), with ${f2(g.bottomClearance)} m leaf clearance, ${f2(geo.opening)} m opening and ${f2(geo.spare)} m beside the ASSUMED car. ${sum(opt('slide-right'))}. ${sum(opt('slide-left'))}. ${sum(opt('swing-in'))}; the surface rises ${f2(opt('swing-in').groundRise)} m under the sweep. ${sum(opt('swing-out'))}. No option is declared workable.` },
    { id: 'waiting', title: `Waiting car: ${f2(w.encroach)} m into the road`, at: [(w.rect.x0 + w.rect.x1) / 2, mid(w.y0, w.y1)], level: 'road',
      text: `With the verge removed the road edge is ${f2(F.mainWall.y0 - F.roadEdge.y)} m from the main wall (was 2.80 m). A car waiting with its nose ${f2(g.waitingGap)} m outside the closed gate occupies y ${f2(w.y0)} to ${f2(w.y1)}. Only ${f2(w.available)} m of its ${f2(env.length)} m (ASSUMED generic envelope) lies between the gate and the road edge: it projects ${f2(w.encroach)} m into the carriageway (display width, not measured) and stands on ${f2(w.overDrain)} m of the schematic drain crossing and ${f2(w.overApron)} m of apron. Automatic opening shortens the wait; it does not create waiting space. Obstruction flagged, not resolved.` },
    { id: 'drain', title: 'Drain crossings (schematic)', at: [mid(st.x0, st.x1), mid(F.drain.y0, F.drain.y1)], level: 'road',
      text: `The driveway and the pedestrian route cross the open roadside drain on schematic slabs at +${f2(r.crossing.level)} m that leave the channel open beneath them (flow along the road, direction unknown); the drain's rear side now meets the retaining edge. Span, supports, capacity, levels and authority permission are NOT designed; a waiting car would stand on the driveway slab.` },
    { id: 'frontage', title: 'Frontage ownership unknown (verge removed)', at: [mid(E.x0, E.x1), mid(F.drain.y0, F.drain.y1) + 0.0], level: 'strip',
      text: 'The broad verge is removed from the geometry, but whether the retaining edge, the planting strip, the apron and the bottom landing in front of the main wall belong to the parcel is still unknown; they may be road reserve. Nothing here establishes ownership, and no land was created or road moved to make space.' },
    { id: 'retaining', title: `Retaining edge: visible face ≈ ${f2(E.visibleFace)} m (OWNER-ESTIMATED — TO BE VERIFIED)`, at: [mid(E.x0, E.x1) + 2.5, E.y0], level: 'edge',
      text: `Toe (drain-side ground) +${f2(lv.toe)} m, top of capping +${f2(lv.edgeCap)} m, planting soil +${f2(lv.strip)} m (0.10 m below the capping), main wall rising from the soil to +${f2(lv.yard + F.mainWall.topAboveGarden)} m, garden +${f2(lv.yard)} m, house floor +${f2(lv.floor)} m. The main wall retains ${f2(m.retainedByMainWall)} m of garden above the soil; the driveway and the flights are cut between walls. Structure, foundations, drainage, the toe against the drain and the real levels are not specified; excavation and retaining need qualified professionals.` },
    { id: 'carport', title: `Carport floor: A (V2.3) vs B (lower) — showing ${cs.option}`, at: [mid(plan.carport.x0, plan.carport.x1), mid(plan.carport.y0, plan.carport.y1) - 0.6], level: 'carport',
      text: `${cmp.map(row).join(' | ')}. The canopy roof level is retained (underside land + ${f2(plan.carport.roofUndersideAboveLand)} m). B reduces the climb but sits below the garden: excavation, retaining against the raised garden and drainage of the lowered pad are unchecked. Provisional geometry comparison only — no vehicle clearance, drainage or retaining feasibility is established.` },
    { id: 'walk', title: `Carport walking route — ${cr.flight.risers} ${cr.flight.direction === 'up' ? 'risers up' : 'riser down'} to the garden here`, at: [mid(cr.platform.rects[0].x0, cr.platform.rects[0].x1), mid(cr.platform.rect.y0, cr.platform.rect.y1)], level: 'walk',
      text: `Parked car → ${f2(cr.strip.rect.x1 - cr.strip.rect.x0)} m walking strip → level landing (stands up to ${f2(cr.platform.proud)} m above the ramp edge) → ${cr.flight.risers} ${cr.flight.risers === 1 ? 'riser' : 'risers'} of ${(Math.abs(cr.flight.riser) * 1000).toFixed(0)} mm through the opening in the driveway retaining wall → upper landing → ${f2(cr.path.length)} m garden path → ${cr.westSteps.risers} west porch risers → porch → entrance. The external route is STEPPED, not step-free (the indoor route to both bathrooms stays level). Flagged: ${cs.conflicts.map(c => c.text).join('; ') || 'none'}. Handrails, lighting and a pedestrian gate are not designed.` },
    { id: 'service', title: `Utility service doorway — ${cr.service.flight.risers} risers from the carport`, at: [cr.service.landing.rect.x0 + 0.5, cr.service.landing.rect.y0 + 0.4], level: 'service',
      text: `The utility floor is ${f2(cs.houseDiff)} m above the carport floor here: a raised landing against the service door (level with the utility floor) and ${cr.service.flight.risers} risers of ${(cr.service.flight.riser * 1000).toFixed(0)} mm along the left wall, outside the parked-car envelope (the car stands 0.50 m farther forward than in V2.3 to make room). The stair can intrude into the driver-side door-opening zone (flagged). No floating doorway, but no step-free access.` },
    { id: 'route', title: `Street route — ${r.flight.risers} risers here`, at: [st.x1 + 0.6, mid(r.flight.rect.y0, r.flight.rect.y1)], level: 'route',
      text: `One continuous route is drawn: crossing → bottom landing (now cut into the strip zone, level with the toe) → ${r.flight.risers} risers of ${(r.flight.riser * 1000).toFixed(0)} mm → upper landing → ${f2(r.path.length)} m garden path → ${r.porchSteps.risers} porch risers → porch → entrance. The flight has ${steps(plan, plan.levels.land.min).risers}–${steps(plan, plan.levels.land.max).risers} risers across the land range in one run; handrails, lighting, an intermediate landing and a step-free street entrance are NOT designed. A sliding gate to the right would cross this route.` },
    { id: 'envelope', title: 'Conceptual envelope — not the parcel', at: [En.rect.x1 - 2.0, En.rect.y1 - 0.8], level: 'land',
      text: `The near-square envelope (${f2(En.w)} × ${f2(En.d)} m, aspect ${f2(En.aspect)}) is an ASSUMED composition frame. The land is OWNER-ESTIMATED as almost square; its boundaries, dimensions and orientation are unknown. It is not derived from the 20-perch estimate and makes no site-fit, setback or boundary claim.` },
    { id: 'stair', title: 'Future stair and PV', at: [...(rooms.stair?.labelAt ?? [10.25, 11.4])], level: 'floor',
      text: 'The owner prefers the future stair behind the carport or another suitable location (INFO08). V2.4 keeps the hall reserve because relocating it is a separate follow-up; it narrows the entry passage once built. Upper-floor structure and PV relocation or removal are unresolved (R13–R15).' },
  ];
}

// ---------- V2.5: half-turn stair in the utility room, stair tower, rear service yard ----------
// Datasets with a `stairDesign` (V2.5 onward). The stair is derived: the floor-to-floor height, the riser count, the flights,
// the half-landing, the lobby at the stair foot and every soffit follow from the parameters and the room's clear floor.
export const isV25 = plan => isV24(plan) && Boolean(plan.stairDesign);

export function stairDesign(plan, land = plan.levels.land.default) {
  const sd = plan.stairDesign, P = plan.parameters, room = roomsById(plan)[sd.room], C = roomMetrics(plan, room).clearRect, floor = levels(plan, land).floor;
  const f2f = P.wallHeight + P.roofSlabThickness, ruleN = Math.ceil(f2f / sd.maxRiser - 1e-9), n = sd.risersOverride ?? ruleN, riser = f2f / n;
  const nLower = Math.ceil(n / 2), nUpper = n - nLower, g = sd.going, w = sd.width;
  // foot at the east end: the lower flight runs along the rear wall rising west to the half-landing, the upper flight returns east along the front wall
  const landing = { rect: rect(C.x0, C.y0, C.x0 + sd.landingDepth, C.y1), level: floor + nLower * riser };
  const foot = landing.rect.x1 + (nLower - 1) * g;
  const lowerTreads = [], upperTreads = [];
  for (let k = 1; k < nLower; k++) lowerTreads.push({ rect: rect(foot - k * g, C.y1 - w, foot - (k - 1) * g, C.y1), level: floor + k * riser });
  for (let k = 1; k < nUpper; k++) upperTreads.push({ rect: rect(landing.rect.x1 + (k - 1) * g, C.y0, landing.rect.x1 + k * g, C.y0 + w), level: landing.level + k * riser });
  const lower = { rect: rect(landing.rect.x1, C.y1 - w, foot, C.y1), treads: lowerTreads, risers: nLower, from: floor, to: landing.level };
  const upper = { rect: rect(landing.rect.x1, C.y0, landing.rect.x1 + (nUpper - 1) * g, C.y0 + w), treads: upperTreads, risers: nUpper, from: landing.level, to: floor + f2f };
  const upperLanding = { rect: rect(upper.rect.x1, C.y0, C.x1, C.y1), level: floor + f2f };
  const lobby = rect(foot, C.y0, C.x1, C.y1);
  // clear height above the floor at plan point (x, y): under a tread, the half-landing or the upper landing slab; null where the stairwell is open
  const clearAt = (x, y) => {
    const t = upperTreads.find(q => inRect(q.rect, x, y, 1e-9));
    if (t) return t.level - sd.waist - floor;
    if (inRect(landing.rect, x, y, 1e-9)) return landing.level - sd.waist - floor;
    if (inRect(upperLanding.rect, x, y, 1e-9)) return f2f - P.roofSlabThickness;
    return null;
  };
  return { sd, room: sd.room, clear: C, floor, f2f, n, ruleN, riser, going: g, width: w, nLower, nUpper, foot, lobby, lower, landing, upper, upperLanding, footprint: [lower.rect, landing.rect, upper.rect], clearAt };
}

export function serviceYard(plan, land = plan.levels.land.default) {
  const Y = plan.serviceYard, lv = levels(plan, land), door = plan.openings.find(o => o.id === Y.door), dg = door ? openingGeom(plan, door) : null;
  if (!dg?.wall) return null;
  const outer = dg.wall.at + wallThickness(plan, dg.wall) / 2, inner = plan.site.rearWall.y - 0.115;
  const rise = lv.floor - lv.yard, ruleN = Math.max(1, Math.ceil(rise / Y.maxRiser - 1e-9)), n = Y.risersOverride ?? ruleN, riser = rise / n;
  const landing = { rect: rect(dg.lo, outer, dg.lo + Math.max(0.9, dg.hi - dg.lo), inner), level: lv.floor };
  const treads = [];
  for (let k = 1; k < n; k++) treads.push({ rect: rect(landing.rect.x0 - k * Y.going, outer, landing.rect.x0 - (k - 1) * Y.going, inner), level: lv.floor - k * riser });
  const flight = { rect: rect(landing.rect.x0 - (n - 1) * Y.going, outer, landing.rect.x0, inner), treads, risers: n, riser };
  const paving = rect(plan.site.leftRearWall.x1, outer, flight.rect.x0, inner);
  // canopy over the paving and the landing; the openings in the wall below it, with their head levels
  const cr = rect(paving.x0, outer, landing.rect.x1, inner), underside = lv.yard + (Y.canopy?.aboveLand ?? Infinity);
  const heads = plan.openings.filter(o => o.wall === dg.wall.id).map(o => ({ o, g: openingGeom(plan, o) })).filter(q => q.g.hi > cr.x0 && q.g.lo < cr.x1)
    .map(q => ({ id: q.o.id, kind: q.o.kind, head: lv.floor + q.o.head, clear: underside - (lv.floor + q.o.head) }));
  const canopy = Y.canopy ? { rect: cr, underside, overLanding: underside - lv.floor, heads } : null;
  return { Y, door: door.id, doorGeom: dg, rise, n, ruleN, riser, landing, flight, paving, canopy, depth: inner - outer, levels: lv };
}

export function validateV25(plan, errors, warnings, info) {
  const sd = plan.stairDesign, P = plan.parameters, rooms = roomsById(plan), room = rooms[sd.room];
  if (!room) { errors.push(`the stair room ${sd.room} is missing`); return; }
  const s = stairDesign(plan), C = s.clear, f2 = n => n.toFixed(2), TT = plan.roof.stairTower;
  if (sd.risersOverride !== undefined && sd.risersOverride !== s.ruleN) errors.push(`the stair riser count does not follow the riser rule (${sd.risersOverride} given, ${s.ruleN} derived from ${f2(s.f2f)} m and ${sd.maxRiser} m)`);
  if (s.riser > sd.maxRiser + 1e-9) errors.push(`stair riser ${(s.riser * 1000).toFixed(0)} mm exceeds the ${(sd.maxRiser * 1000).toFixed(0)} mm maximum`);
  if (Math.abs(s.f2f - (P.wallHeight + P.roofSlabThickness)) > 1e-9) errors.push('the stair floor-to-floor height is not wallHeight + roofSlabThickness');
  if (2 * s.width > C.y1 - C.y0 + 1e-9) errors.push(`the two ${f2(s.width)} m flights do not fit side by side in the ${f2(C.y1 - C.y0)} m deep room`);
  if (s.foot > C.x1 - 1e-9) errors.push(`the stair does not fit in the room: the stair foot (x ${f2(s.foot)}) is past the room's clear floor (x ${f2(C.x1)})`);
  if (sd.landingDepth < s.width - 1e-9) warnings.push(`the half-landing (${f2(sd.landingDepth)} m) is shallower than the ${f2(s.width)} m flight width (flagged, TO BE VERIFIED)`);
  // footprint inside the room, no furniture on it, no roof slab over the stairwell, a stair tower above it
  for (const r of s.footprint) if (!(r.x0 >= C.x0 - 1e-9 && r.x1 <= C.x1 + 1e-9 && r.y0 >= C.y0 - 1e-9 && r.y1 <= C.y1 + 1e-9)) errors.push('the stair runs outside the room');
  for (const f of plan.furniture) if (s.footprint.concat([s.lobby]).some(r => rectOverlap(r, rect(f.x0, f.y0, f.x1, f.y1)) > 0)) errors.push(`furniture ${f.id} stands in the stair or its lobby`);
  for (const sl of plan.roof.slabs) if (s.footprint.some(r => rectOverlap(r, rect(sl.x0, sl.y0, sl.x1, sl.y1)) > 0)) errors.push(`roof slab ${sl.id} covers the stairwell (no headroom over the flights)`);
  if (!TT) errors.push('the stairwell has no stair tower (roof access) above it');
  else {
    if (!(TT.x0 <= C.x0 && TT.x1 >= C.x1 && TT.y0 <= C.y0 && TT.y1 >= C.y1)) errors.push('the stair tower does not cover the stairwell');
    const top = s.f2f + TT.height - P.roofSlabThickness, worst = Math.max(...s.upper.treads.map(t => t.level - s.floor));
    if (top - worst < sd.headroomMin - 1e-9) errors.push(`headroom over the upper flight under the stair tower is ${f2(top - worst)} m, below ${sd.headroomMin} m`);
    const d = TT.door, main = plan.roof.slabs.find(q => q.id === 'main');
    if (d.face !== 'east' || !main || !(main.x0 <= TT.x1 - 1e-9 && main.x1 > TT.x1 && main.y0 <= d.y0 && main.y1 >= d.y1)) errors.push('the stair tower door does not open onto the main roof');
    if (!(d.y0 >= s.upperLanding.rect.y0 - 1e-9 && d.y1 <= s.upperLanding.rect.y1 + 1e-9)) errors.push('the stair tower door is not at the upper landing');
  }
  // doors: swings clear of the stair; the service door under an adequate soffit; the back door at the lobby
  // the lower flight is solid from the floor; under the half-landing and the upper flight a leaf clashes only where the clear height is below its head
  for (const o of plan.openings.filter(o => DOOR_KINDS.includes(o.kind))) {
    const sw = swingSector(plan, o);
    const hits = ([x, y]) => inRect(s.lower.rect, x, y, -1e-6) || ([s.landing.rect, s.upper.rect].some(r => inRect(r, x, y, -1e-6)) && (s.clearAt(x, y) ?? Infinity) < o.head - 1e-9);
    if (sw && sectorSamples(sw).some(hits)) errors.push(`door ${o.id}: swing hits the stair`);
  }
  for (const id of Object.values(sd.doors)) if (!plan.openings.some(o => o.id === id)) errors.push(`stair-room door ${id} is missing`);
  const svc = plan.openings.find(o => o.id === sd.doors.service);
  if (svc) {
    const g = openingGeom(plan, svc), y = C.y0 + 0.05;
    let low = Infinity;
    for (let x = g.lo + 0.01; x <= g.hi - 0.01; x += 0.02) { const c = s.clearAt(x, y); if (c !== null) low = Math.min(low, c); }
    info.serviceDoorSoffit = low;
    if (low < Math.max(svc.head, sd.headroomMin) - 1e-9) errors.push(`service door ${svc.id} opens under a low stair soffit (${f2(low)} m clear, door head ${f2(svc.head)} m)`);
  }
  const back = plan.openings.find(o => o.id === sd.doors.back);
  if (back) { const g = openingGeom(plan, back); if (g.lo < s.foot - 1e-6 || g.hi > C.x1 + 1e-6) errors.push(`back door ${back.id} is not at the stair-foot lobby (x ${f2(s.foot)}–${f2(C.x1)})`); }
  // windows beside a flight need guarding (or must be fixed, toughened glazing — flagged)
  for (const o of plan.openings.filter(o => !DOOR_KINDS.includes(o.kind))) {
    const g = openingGeom(plan, o);
    if (!g.wall || !s.footprint.some(r => (g.wall.dir === 'h' ? (Math.abs(g.wall.at - r.y1) < 0.2 || Math.abs(g.wall.at - r.y0) < 0.2) && g.hi > r.x0 && g.lo < r.x1 : false))) continue;
    const under = [...s.lower.treads, ...s.upper.treads].filter(t => t.rect.x1 > g.lo && t.rect.x0 < g.hi && (Math.abs(g.wall.at - t.rect.y1) < 0.2 || Math.abs(g.wall.at - t.rect.y0) < 0.2));
    if (!under.length) continue;
    const top = Math.max(...under.map(t => t.level - s.floor));
    if (o.sill < top + sd.handrailHeight - 1e-9) {
      if (o.guarding !== 'fixed-toughened') errors.push(`window ${o.id} beside the stair needs guarding (sill ${f2(o.sill)} m, treads up to ${f2(top)} m)`);
      else warnings.push(`window ${o.id} beside the stair is fixed toughened glazing (sill ${f2(o.sill)} m, treads up to ${f2(top)} m): guarding TO BE VERIFIED`);
    }
  }
  // rear service yard: derived steps, landing depth flagged, nothing on the steps
  if (plan.serviceYard) {
    const y = serviceYard(plan);
    if (!y) errors.push('the rear service yard has no back door');
    else {
      if (plan.serviceYard.risersOverride !== undefined && plan.serviceYard.risersOverride !== y.ruleN) errors.push('the yard step count does not follow the riser rule');
      if (y.depth < plan.serviceYard.landingDepthMin - 1e-9) warnings.push(`the back-door landing is ${f2(y.depth)} m deep, below ${plan.serviceYard.landingDepthMin} m (rear strip of the CONCEPTUAL envelope; flagged)`);
      const yr = roomMetrics(plan, rooms[plan.serviceYard.room]).primary;
      if (y.flight.rect.x0 < plan.site.leftRearWall.x1 - 1e-9) errors.push('the yard steps run into the left boundary');
      for (const f of plan.furniture) if ([y.landing.rect, y.flight.rect].some(r => rectOverlap(r, rect(f.x0, f.y0, f.x1, f.y1)) > 0)) errors.push(`yard steps blocked by ${f.id}`);
      if (!(y.landing.rect.x1 <= yr.x1 + 1e-9)) errors.push('the back-door landing runs out of the rear service yard');
      // canopy: above the head of every opening in the wall below it (plus the clearance), and headroom over the back-door landing
      if (y.canopy) {
        const m = plan.serviceYard.canopy.minClearAboveHeads ?? 0;
        for (const h of y.canopy.heads) if (h.clear < m - 1e-9) errors.push(`the yard canopy (+${f2(y.canopy.underside)}) is below the head of ${h.id} (+${f2(h.head)}; ${f2(m)} m clearance required)`);
        if (y.canopy.overLanding < sd.headroomMin - 1e-9) errors.push(`the yard canopy leaves ${f2(y.canopy.overLanding)} m over the back-door landing, below ${sd.headroomMin} m`);
      }
      info.yard = { risers: y.n, riser: y.riser, depth: y.depth, canopy: y.canopy && { underside: y.canopy.underside, overLanding: y.canopy.overLanding, heads: y.canopy.heads.map(h => [h.id, h.clear]) } };
    }
  }
  if (plan.roof.railing) for (const id of plan.roof.railing.slabs) if (!plan.roof.slabs.some(q => q.id === id)) errors.push(`roof railing refers to a missing slab ${id}`);
  info.v25 = { risers: s.n, riser: s.riser, going: s.going, width: s.width, foot: s.foot, lobby: s.lobby.x1 - s.lobby.x0, landingDepth: sd.landingDepth, f2f: s.f2f };
}

// Display corrections derived from current geometry. Preserve historical dataset bytes and IDs.
// Original notes remain available in the dataset and review snapshot; professional warnings stay visible.
export function currentIssueNotes(plan) {
  return plan.unresolved.items.map(i => {
    if (i.id === 'landings' && plan.stairDesign?.landingDepth >= plan.stairDesign?.width) {
      const half = plan.stairDesign.landingDepth.toFixed(2), rear = serviceYard(plan).depth.toFixed(2);
      return { ...i, title: `Half-landing ${half} m; rear landing ${rear} m remains flagged`, text: `Current half-landing ${half} m equals or exceeds the ${plan.stairDesign.width.toFixed(2)} m flight width; the stored 0.855 m wording describes the earlier revision. Rear landing ${rear} m remains below the provisional ${plan.serviceYard.landingDepthMin.toFixed(2)} m target. This corrects an annotation only: stair compliance, headroom, guarding, structure and the rear boundary remain TO BE VERIFIED.` };
    }
    if (i.id === 'tower-pv' && /west|late in the day/.test(i.text)) return { ...i, text: `The ${plan.roof.stairTower.height.toFixed(2)} m stair tower is adjacent to the indicative PV array. Orientation, solar paths and shading performance are unknown; model axes do not establish compass directions or shading times. PV relocation or removal for a future upper floor remains unresolved (R13–R15).` };
    return i;
  });
}

function unresolvedIssuesV25(plan, land) {
  const base = unresolvedIssuesV24(plan, land).filter(i => i.id !== 'stair'), s = stairDesign(plan, land), y = serviceYard(plan, land), TT = plan.roof.stairTower;
  const f2 = n => n.toFixed(2), mid = (a, b) => (a + b) / 2, text = id => currentIssueNotes(plan).find(i => i.id === id) ?? { title: id, text: '' };
  const w = plan.openings.find(o => o.guarding), wg = w ? openingGeom(plan, w) : null;
  return [...base,
    { id: 'stair', title: `Stair in the utility room — ${s.n} risers of ${(s.riser * 1000).toFixed(0)} mm, ${(s.going * 1000).toFixed(0)} mm going`, at: [mid(s.clear.x0, s.clear.x1), mid(s.clear.y0, s.clear.y1)], level: 'floor',
      text: `${text('stair').text} Derived here: floor-to-floor ${f2(s.f2f)} m, ${s.nLower} + ${s.nUpper} risers, half-landing ${f2(plan.stairDesign.landingDepth)} m (${plan.stairDesign.landingDepth < s.width - 1e-9 ? `shallower than the ${f2(s.width)} m flights — flagged` : `at least the ${f2(s.width)} m flight width; compliance still unverified`}), lobby ${f2(s.lobby.x1 - s.lobby.x0)} m at the stair foot.` },
    { id: 'tower-pv', title: text('tower-pv').title, at: [mid(TT.x0, TT.x1), mid(TT.y0, TT.y1)], level: 'floor', text: text('tower-pv').text },
    { id: 'yard', title: `${text('yard').title} — ${y.n} risers of ${(y.riser * 1000).toFixed(0)} mm`, at: [mid(y.landing.rect.x0, y.landing.rect.x1), mid(y.landing.rect.y0, y.landing.rect.y1)], level: 'land',
      text: `${text('yard').text} Back-door landing ${f2(y.depth)} m deep; ${y.n} steps of ${(y.riser * 1000).toFixed(0)} mm down to the yard.` },
    ...(wg ? [{ id: 'window', title: text('window').title, at: [mid(wg.lo, wg.hi), wg.wall.at], level: 'floor', text: text('window').text }] : []),
  ];
}

// Driveway right retaining wall as drawn rectangles. V2.4: the wall stops at rightRetainingWall.y1 (the opening for the carport-to-garden
// stair) and a short piece continues north of the stair to the house front.
export function retainingWallPieces(plan) {
  const rw = plan.driveway.rightRetainingWall, y0 = rw.y0 ?? 0, y1 = rw.y1 ?? plan.carport.y0, out = [rect(rw.x0, y0, rw.x1, y1)];
  if (isV24(plan)) {
    const R = plan.carportRoute, door = plan.openings.find(o => o.id === plan.route.entrance), wall = door ? openingGeom(plan, door).wall : null;
    const face = wall ? wall.at - wallThickness(plan, wall) / 2 : plan.carport.y0;
    if (face > R.walkY1 + 1e-9) out.push(rect(rw.x0, R.walkY1, rw.x1, face));
  }
  return out;
}

// ---------- V2.6: doorway approach, working space and service routes ----------
// PROVISIONAL design criteria of this study only. They are not legal limits, not accessibility or building-code
// checks and not an ergonomic study; they exist so that a furniture or door change that makes a doorway, a work
// position or a service route unusable is caught instead of passing a "does the box fit" test.
export const isV26 = plan => isV25(plan) && Boolean(plan.usability);
export const USABILITY_DEFAULTS = Object.freeze({
  approachDepth: 0.6,   // clear strip in front of an ordinary door, each side (m)
  workDepth: 0.9,       // clear standing space in front of a sink, hob, counter, fridge or washer (m)
  routeWidth: 0.7,      // swath a person needs along a service route, door leaf open (m)
  headroom: 2.0,        // minimum clear height on a route or approach (m)
  chairPull: 0.6,       // pull-out space behind a dining chair (m)
});
export const usabilityCriteria = plan => ({ ...USABILITY_DEFAULTS, ...(plan.usability?.criteria ?? {}) });

// A strip of `depth` against one side ('+x' '-x' '+y' '-y') of a footprint, optionally limited to a span along that side.
export function sideRect(r, side, depth, span) {
  const [a0, a1] = span ?? [0, Infinity];
  if (side === '+x' || side === '-x') {
    const y0 = r.y0 + a0, y1 = Math.min(r.y1, r.y0 + a1);
    return side === '+x' ? rect(r.x1, y0, r.x1 + depth, y1) : rect(r.x0 - depth, y0, r.x0, y1);
  }
  const x0 = r.x0 + a0, x1 = Math.min(r.x1, r.x0 + a1);
  return side === '+y' ? rect(x0, r.y1, x1, r.y1 + depth) : rect(x0, r.y0 - depth, x1, r.y0);
}

// Door leaf and frame parts. width is the CLEAR opening (the wall cut). The frame is an architrave on both wall faces,
// entirely outside the clear opening; the leaf fills the opening less a small gap. With the leaf open at 90° it stands
// inside the opening, so the passage is the opening less the leaf thickness.
export function doorLeafParams(plan) {
  return { thickness: 0.04, gap: 0.004, trim: 0.07, proud: 0.015, ...(plan.parameters.doorLeaf ?? {}) };
}
export function doorParts(plan, o) {
  const g = openingGeom(plan, o), w = g.wall, p = doorLeafParams(plan), t = wallThickness(plan, w) / 2, horiz = w.dir === 'h';
  const R = (a0, a1, c0, c1) => (horiz ? rect(a0, w.at + c0, a1, w.at + c1) : rect(w.at + c0, a0, w.at + c1, a1));
  const leaf = { rect: R(g.lo + p.gap, g.hi - p.gap, -p.thickness / 2, p.thickness / 2), y0: 0.004, y1: o.head - p.gap };
  const frame = [];
  for (const sgn of [-1, 1]) {
    const c0 = sgn < 0 ? -t - p.proud : t, c1 = sgn < 0 ? -t : t + p.proud;
    frame.push({ kind: 'jamb-low', rect: R(g.lo - p.trim, g.lo, c0, c1), y0: 0, y1: o.head + p.trim });
    frame.push({ kind: 'jamb-high', rect: R(g.hi, g.hi + p.trim, c0, c1), y0: 0, y1: o.head + p.trim });
    frame.push({ kind: 'head', rect: R(g.lo - p.trim, g.hi + p.trim, c0, c1), y0: o.head, y1: o.head + p.trim });
  }
  if (o.kind === 'sliding-door') {
    const s = slidingDoorGeometry(plan, o);
    return { opening:g, leaf:{...leaf,rect:s.closed}, frame, params:p, clearOpening:o.width, clearOpen90:o.width };
  }
  return { opening: g, leaf, frame, params: p, clearOpening: o.width, clearOpen90: o.width - p.thickness };
}
// Surface slider: clear aperture, leaf overlap and parking position from one source.
// Assumed hardware envelope, not a hardware specification or a fire/smoke rating.
export function slidingDoorGeometry(plan, o) {
  const g=openingGeom(plan,o),w=g.wall,h=w.dir==='h',p=doorLeafParams(plan),s=o.sliding;
  const side=s?.direction==='low'?-1:1, face=s?.face??-1, overlap=s?.overlap??.02, gap=s?.standOff??.04;
  const c=w.at+face*(wallThickness(plan,w)/2+gap+p.thickness/2);
  const R=(a,b)=>h?rect(a,c-p.thickness/2,b,c+p.thickness/2):rect(c-p.thickness/2,a,c+p.thickness/2,b);
  const travel=side*(o.width+overlap);
  return {closed:R(g.lo-overlap,g.hi+overlap),open:R(g.lo-overlap+travel,g.hi+overlap+travel),travel,overlap,gap,side,face};
}
// The open leaf at 90° as a plan rectangle (from the hinge, standing inside the opening by its thickness).
export function openLeafRect(plan, o) {
  if (o.kind === 'sliding-door') return slidingDoorGeometry(plan,o).open;
  const s = swingSector(plan, o), g = openingGeom(plan, o), w = g.wall, th = doorLeafParams(plan).thickness, horiz = w.dir === 'h';
  const hingeAlong = horiz ? s.hinge[0] : s.hinge[1], dirAlong = o.swing.hinge === 'low' ? 1 : -1;
  const a0 = Math.min(hingeAlong, hingeAlong + dirAlong * th), a1 = Math.max(hingeAlong, hingeAlong + dirAlong * th);
  const c0 = Math.min(w.at, w.at + o.swing.side * o.width), c1 = Math.max(w.at, w.at + o.swing.side * o.width);
  return horiz ? rect(a0, c0, a1, c1) : rect(c0, a0, c1, a1);
}
// Frame and leaf must not misrepresent the clear opening: frame outside it, leaf inside it, nothing clashing with a neighbour.
export function validateDoorParts(plan, o) {
  const errs = [], d = doorParts(plan, o), g = d.opening, p = d.params, horiz = g.wall.dir === 'h';
  if(o.kind==='sliding-door') {
    if(!o.sliding || !['low','high'].includes(o.sliding.direction) || ![-1,1].includes(o.sliding.face) || !(o.sliding.overlap>0) || !(o.sliding.standOff>=p.proud)) errs.push(`sliding door ${o.id}: invalid operating parameters`);
    const s=slidingDoorGeometry(plan,o),lo=horiz?s.open.x0:s.open.y0,hi=horiz?s.open.x1:s.open.y1;
    if(lo<g.wall.from || hi>g.wall.to) errs.push(`sliding door ${o.id}: leaf parking exceeds its wall`);
    for(const f of plan.furniture)if(rectOverlap(s.open,rect(f.x0,f.y0,f.x1,f.y1))>1e-6||rectOverlap(s.closed,rect(f.x0,f.y0,f.x1,f.y1))>1e-6)errs.push(`sliding door ${o.id}: leaf parking or closure hits ${f.id}`);
    for(const w of plan.walls.filter(w=>w.id!==o.wall))if(rectOverlap(s.open,wallBand(plan,w))>1e-6||rectOverlap(s.closed,wallBand(plan,w))>1e-6)errs.push(`sliding door ${o.id}: leaf parking or closure hits wall ${w.id}`);
    if(lo<g.hi-1e-8&&hi>g.lo+1e-8)errs.push(`sliding door ${o.id}: open leaf obstructs aperture`);
    return errs;
  }
  const along = r => (horiz ? [r.x0, r.x1] : [r.y0, r.y1]);
  for (const f of d.frame) {
    const [a0, a1] = along(f.rect);
    if (f.kind !== 'head' && a1 > g.lo + 1e-9 && a0 < g.hi - 1e-9) errs.push(`door ${o.id}: the frame (${f.kind}) intrudes into the clear opening`);
    if (f.kind === 'head' && f.y0 < o.head - 1e-9) errs.push(`door ${o.id}: the frame head sits below the opening head`);
  }
  const [l0, l1] = along(d.leaf.rect);
  if (l0 < g.lo - 1e-9 || l1 > g.hi + 1e-9) errs.push(`door ${o.id}: the leaf is wider than the clear opening`);
  if (g.hi - g.lo - (l1 - l0) > 0.02) errs.push(`door ${o.id}: the leaf is much narrower than the clear opening (drawn clear width would be misrepresented)`);
  if (d.leaf.y1 > o.head + 1e-9) errs.push(`door ${o.id}: the leaf is taller than the opening`);
  for (const o2 of plan.openings) {
    if (o2.id === o.id || o2.wall !== o.wall) continue;
    const g2 = openingGeom(plan, o2);
    if (g2.lo < g.hi + p.trim - 1e-9 && g2.hi > g.lo - p.trim + 1e-9) errs.push(`door ${o.id}: the frame trim collides with opening ${o2.id}`);
  }
  for (const w of plan.walls) {
    if (w.dir === g.wall.dir || w.id === g.wall.id) continue;
    const b = wallBand(plan, w), [b0, b1] = along(b), across = horiz ? [b.y0, b.y1] : [b.x0, b.x1];
    if (!(g.wall.at >= across[0] - 1e-9 && g.wall.at <= across[1] + 1e-9)) continue;
    if ((b1 > g.lo - p.trim + 1e-9 && b1 <= g.lo + 1e-9) || (b0 < g.hi + p.trim - 1e-9 && b0 >= g.hi - 1e-9)) errs.push(`door ${o.id}: the frame trim runs into wall ${w.id}`);
  }
  return errs;
}

function stairLowAt(stair, r, h) {
  if (!stair) return false;
  for (let x = r.x0 + 0.025; x < r.x1; x += 0.05) for (let y = r.y0 + 0.025; y < r.y1; y += 0.05) {
    const c = stair.clearAt(x, y);
    if (c !== null && c < h - 1e-9) return true;
  }
  return false;
}
const legRect = (p, q, w) => {
  const h = w / 2;
  return Math.abs(p[0] - q[0]) < 1e-9 ? rect(p[0] - h, Math.min(p[1], q[1]) - h, p[0] + h, Math.max(p[1], q[1]) + h)
    : rect(Math.min(p[0], q[0]) - h, p[1] - h, Math.max(p[0], q[0]) + h, p[1] + h);
};
const ovl = (a, b) => rectOverlap(a, b) > 1e-6;
const uniq = a => [...new Set(a)];

// Free width of a strip in front of a door (or any strip): at every depth the longest run along the door axis that no obstacle
// touches; the smallest over the depths. 0 = fully blocked somewhere.
function stripFreeWidth(r, obstacles, horizAxis) {
  const aLo = horizAxis ? r.x0 : r.y0, aHi = horizAxis ? r.x1 : r.y1, dLo = horizAxis ? r.y0 : r.x0, dHi = horizAxis ? r.y1 : r.x1;
  let worst = aHi - aLo;
  for (let d = dLo + 0.0125; d < dHi; d += 0.025) {
    let best = 0, run = 0;
    for (let a = aLo + 0.005; a < aHi; a += 0.01) {
      const x = horizAxis ? a : d, y = horizAxis ? d : a;
      const hit = obstacles.some(ob => x > ob.rect.x0 + 1e-9 && x < ob.rect.x1 - 1e-9 && y > ob.rect.y0 + 1e-9 && y < ob.rect.y1 - 1e-9);
      if (hit) run = 0; else { run += 0.01; best = Math.max(best, run); }
    }
    worst = Math.min(worst, best);
  }
  return worst;
}

// The audit. `use` and `routes` default to the dataset's usability block; a caller can pass annotations for a dataset that has
// none (tools/audit-v26.mjs does this to reproduce the V2.5 findings). Returns findings with severity 'error' or 'warning'.
export function usabilityAudit(plan, { land = plan.levels.land.default, use = null, routes = null, strict = null, extraObstacles = [] } = {}) {
  const crit = usabilityCriteria(plan), f2 = n => n.toFixed(2), findings = [], out = { crit, findings, doors: [], zones: [], routes: [] };
  const add = (severity, code, text, extra = {}) => findings.push({ severity, code, text, ...extra });
  const stair = plan.stairDesign ? stairDesign(plan, land) : null;
  const solids = wallPieces(plan, land).filter(p => p.kind === 'wall' || p.kind === 'sill').map(p => ({ what: `wall ${p.wall}`, rect: p.rect }));
  const bodies = plan.furniture.map(f => ({ what: f.id, id: f.id, rect: rect(f.x0, f.y0, f.x1, f.y1) }));
  const stairSolid = stair ? [{ what: 'the stair (lower flight)', rect: stair.lower.rect }] : [];
  const routeList = routes ?? plan.usability?.routes ?? [];
  const routeDoors = new Set(routeList.flatMap(r => r.doors ?? []));
  const strictDoors = new Set(strict ?? routeDoors);
  const insideBuilding = r => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]]
    .every(([x, y]) => plan.rooms.some(q => roomCells(q).some(c => inRect(c, x, y, 1e-6))));

  // 1. both sides of every ordinary door: the approach strip
  const approaches = [];
  for (const o of plan.openings.filter(o => DOOR_KINDS.includes(o.kind))) {
    const g = openingGeom(plan, o), w = g.wall, th = wallThickness(plan, w) / 2, d = crit.approachDepth, horiz = w.dir === 'h';
    const rec = { id: o.id, label: o.label, width: o.width, sides: [] };
    for (const sign of [-1, 1]) {
      const r = horiz ? (sign > 0 ? rect(g.lo, w.at + th, g.hi, w.at + th + d) : rect(g.lo, w.at - th - d, g.hi, w.at - th))
        : (sign > 0 ? rect(w.at + th, g.lo, w.at + th + d, g.hi) : rect(w.at - th - d, g.lo, w.at - th, g.hi));
      const room = roomAt(plan, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2) ?? 'outside';
      const obs = [...solids, ...bodies, ...stairSolid];
      const blockers = uniq(obs.filter(ob => ovl(r, ob.rect)).map(ob => ob.what));
      const lowHead = stairLowAt(stair, r, crit.headroom);
      const free = stripFreeWidth(r, [...obs, ...(lowHead ? [{ rect: r }] : [])], horiz);
      const side = { sign, rect: r, room, swingSide: o.swing && o.swing.side === sign, blockers, free, lowHead };
      rec.sides.push(side);
      const label = `door ${o.id}: ${side.swingSide ? 'swing' : 'pull'}-side approach in ${room}`;
      if (free < crit.routeWidth - 1e-9) add('error', 'approach-blocked', `${label} is blocked by ${blockers.join(', ') || 'low headroom'} (${f2(free)} m of ${f2(o.width)} m free, ${f2(crit.routeWidth)} m needed)`, { door: o.id, sign, blockers, free });
      else if (blockers.length) add('warning', 'approach-narrowed', `${label} is narrowed by ${blockers.join(', ')} to ${f2(free)} m free of ${f2(o.width)} m (flagged)`, { door: o.id, sign, blockers, free });
      if (lowHead && free >= crit.routeWidth) add('error', 'approach-headroom', `${label} has less than ${f2(crit.headroom)} m headroom`, { door: o.id, sign });
    }
    out.doors.push(rec);
  }

  // 2. working space and appliance door envelopes
  const zoneRecs = [];
  const approachRects = out.doors.flatMap(dr => dr.sides.map(s => ({ door: dr.id, rect: s.rect })));
  for (const f of plan.furniture) {
    const u = use?.[f.id] ?? f.use;
    if (!u?.zones?.length) continue;
    const body = rect(f.x0, f.y0, f.x1, f.y1), groups = new Map();
    for (const z of u.zones) {
      const r = sideRect(body, z.side, z.depth, z.span);
      const obs = [...solids, ...bodies.filter(b => b.id !== f.id), ...stairSolid];
      const blockers = uniq(obs.filter(ob => ovl(r, ob.rect)).map(ob => ob.what));
      const low = stairLowAt(stair, r, crit.headroom);
      if (low) blockers.push('low stair soffit');
      const outside = !insideBuilding(r) && !(z.allowOutside);
      const doorHits = approachRects.filter(a => ovl(r, a.rect)).map(a => a.door);
      const rec = { id: f.id, label: f.label || f.type, kind: z.kind, side: z.side, depth: z.depth, rect: r, blockers, outside, doorHits, group: z.anyOf ?? null };
      zoneRecs.push(rec);
      if (z.kind === 'work' && z.depth < crit.workDepth - 1e-9) add('error', 'criterion-weakened', `${f.id}: working space ${f2(z.depth)} m is below the ${f2(crit.workDepth)} m criterion`, { id: f.id });
      if (z.anyOf) { (groups.get(z.anyOf) ?? groups.set(z.anyOf, []).get(z.anyOf)).push(rec); continue; }
      const name = `${f.label || f.type} ${f.id}`;
      if (blockers.length || outside) add('error', z.kind === 'door' ? 'envelope-blocked' : 'zone-blocked', `${name}: ${z.kind === 'door' ? 'door-opening space' : z.kind === 'access' ? 'access space' : 'working space'} ${f2(z.depth)} m (${z.side}) is blocked by ${blockers.join(', ') || 'the building edge'}`, { id: f.id, blockers, zone: rec });
      for (const dh of doorHits) add(strictDoors.has(dh) ? 'error' : 'warning', 'zone-door', `${name}: ${z.kind} space overlaps the approach to door ${dh}${strictDoors.has(dh) ? ' (a service route door)' : ' (shared space, flagged)'}`, { id: f.id, door: dh });
    }
    for (const [gname, list] of groups) {
      if (!list.some(z => !z.blockers.length && !z.outside)) add('error', 'zone-blocked', `${f.label || f.type} ${f.id}: none of the ${gname} access spaces is free (${uniq(list.flatMap(z => z.blockers)).join(', ')})`, { id: f.id });
    }
  }
  out.zones = zoneRecs;

  // 3. service routes: a swath of routeWidth along an axis-aligned centreline; the open leaves of the doors it passes through are obstacles
  for (const rt of routeList) {
    // Invalid numbers otherwise make rectangle comparisons false and can appear clear.
    if (!Array.isArray(rt.points) || rt.points.length < 2 || rt.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
      add('error', 'route-coordinates', `route "${rt.label}": requires at least two finite numeric coordinate pairs`, { route: rt.id });
      out.routes.push({ id: rt.id, label: rt.label, points: rt.points, legs: [], minClear: 0, steps: 0, ok: false });
      continue;
    }
    const missingDoors=(rt.doors??[]).filter(id=>!plan.openings.some(o=>o.id===id&&DOOR_KINDS.includes(o.kind)));
    if(missingDoors.length) add('error','route-door',`route "${rt.label}": missing or invalid route doors ${missingDoors.join(', ')}`,{route:rt.id});
    const doors = (rt.doors ?? []).map(id => plan.openings.find(o => o.id === id)).filter(o=>o&&DOOR_KINDS.includes(o.kind));
    const leaves = doors.map(o => ({ what: `the open leaf of ${o.id}`, rect: openLeafRect(plan, o) }));
    const ign = new Set(rt.ignore ?? []);
    const obstacles = [...solids, ...bodies.filter(b => !ign.has(b.id)), ...stairSolid, ...leaves, ...extraObstacles];
    const rec = { id: rt.id, label: rt.label, points: rt.points, legs: [], minClear: Infinity, steps: 0, ok: true };
    for (let i = 1; i < rt.points.length; i++) {
      const p = rt.points[i - 1], q = rt.points[i], sw = legRect(p, q, crit.routeWidth);
      const blockedBy = uniq(obstacles.filter(ob => ovl(sw, ob.rect)).map(ob => ob.what));
      let lo = 0, hi = 1.4;
      for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (obstacles.some(ob => ovl(legRect(p, q, mid), ob.rect))) hi = mid; else lo = mid; }
      const lowHead = stairLowAt(stair, sw, crit.headroom);
      rec.legs.push({ from: p, to: q, blockedBy, clear: lo, lowHead });
      rec.minClear = Math.min(rec.minClear, lo);
      if (blockedBy.length) add('error', 'route-blocked', `route "${rt.label}": the leg (${p.map(f2).join(', ')}) → (${q.map(f2).join(', ')}) is blocked by ${blockedBy.join(', ')} (${f2(lo)} m free, ${f2(crit.routeWidth)} m needed)`, { route: rt.id, blockedBy });
      if (lowHead) add('error', 'route-headroom', `route "${rt.label}": less than ${f2(crit.headroom)} m headroom on the leg (${p.map(f2).join(', ')}) → (${q.map(f2).join(', ')})`, { route: rt.id });
    }
    rec.ok = !missingDoors.length && !rec.legs.some(l => l.blockedBy.length || l.lowHead);
    out.routes.push(rec);
  }
  // required laundry fixtures must be placed (or declared unplaced) so that "the box fits" cannot hide a missing sink
  for (const id of plan.usability?.required ?? []) {
    const placed = plan.furniture.some(f => f.id === id), declared = (plan.usability.unplaced ?? []).some(q => q.id === id);
    if (!placed && !declared) add('error', 'required-missing', `required item ${id} is neither placed nor declared unplaced`, { id });
    if (placed && declared) add('error', 'required-missing', `item ${id} is both placed and declared unplaced`, { id });
  }
  return out;
}

// The carport side of the service door at one land level: the approach strip must stand on the service landing, which must be at the
// door's threshold, and the steps must start beyond it. Both carport options.
export function serviceDoorCarportSide(plan, land) {
  const R = plan.carportRoute, door = plan.openings.find(o => o.id === R.service.door), crit = usabilityCriteria(plan);
  if (!door) return null;   // a missing service door is reported by the carport route check
  const g = openingGeom(plan, door);
  const r = carportRoute(plan, land), L = r.service.landing.rect, d = crit.approachDepth, th = wallThickness(plan, g.wall) / 2;
  const strip = rect(g.lo, g.wall.at - th - d, g.hi, g.wall.at - th);
  const inLanding = strip.x0 >= L.x0 - 1e-9 && strip.x1 <= L.x1 + 1e-9 && strip.y0 >= L.y0 - 1e-9 && strip.y1 <= L.y1 + 1e-9;
  const car = plan.furniture.find(f => f.type === 'vehicle');
  const carFree = !ovl(strip, rect(car.x0, car.y0, car.x1, car.y1));
  return { land, option: r.option, strip, landing: L, steps: r.service.flight.risers, stepsRect: r.service.flight.rect, inLanding, carFree, riser: r.service.flight.riser, levelDiff: r.levels.floor - r.levels.carport };
}

// An alternative laid out for the owner's choice (not built): items inside the space, each working space inside it and free of the other items.
export function validateAlternative(plan, alt) {
  const errs = [], crit = usabilityCriteria(plan), b = alt.bounds, f2 = n => n.toFixed(2), items = alt.items.map(i => ({ ...i, r: rect(...i.rect) }));
  const inside = r => r.x0 >= b.x0 - 1e-9 && r.x1 <= b.x1 + 1e-9 && r.y0 >= b.y0 - 1e-9 && r.y1 <= b.y1 + 1e-9;
  for (const i of items) {
    if (!inside(i.r)) errs.push(`alternative ${alt.id}: the ${i.label} stands outside the space`);
    if (i.zone < crit.workDepth - 1e-9) errs.push(`alternative ${alt.id}: the ${i.label} working space ${f2(i.zone)} m is below the ${f2(crit.workDepth)} m criterion`);
    const z = sideRect(i.r, i.front, i.zone);
    if (!inside(z)) errs.push(`alternative ${alt.id}: the working space of the ${i.label} leaves the space`);
    for (const j of items) if (j.id !== i.id && rectOverlap(z, j.r) > 0) errs.push(`alternative ${alt.id}: the working space of the ${i.label} is blocked by the ${j.label}`);
    for (const j of items) if (j.id > i.id && rectOverlap(i.r, j.r) > 0) errs.push(`alternative ${alt.id}: the ${i.label} overlaps the ${j.label}`);
  }
  if (alt.newRearInner !== undefined) {
    const E = plan.site.conceptualEnvelope, grow = alt.newRearInner + 0.115 - plan.site.rearWall.y, aspect = (E.y1 + grow - E.y0) / (E.x1 - E.x0);
    if (aspect > E.nearSquareMaxAspect + 1e-9) errs.push(`alternative ${alt.id}: the deeper strip makes the envelope ${f2(aspect)} deep-to-wide, beyond the near-square limit ${E.nearSquareMaxAspect}`);
  }
  if (alt.id === 'B') {
    const room = roomsById(plan).stair, c = roomCells(room)[0];
    if (!(b.x0 >= c.x0 && b.x1 <= c.x1 && b.y0 >= c.y0 && b.y1 <= c.y1)) errs.push('alternative B: the laundry room is not inside the former stair reserve');
  }
  return errs;
}

export function validateV26(plan, errors, warnings, info) {
  const U = plan.usability, crit = usabilityCriteria(plan);
  for (const k of Object.keys(USABILITY_DEFAULTS)) if (crit[k] < USABILITY_DEFAULTS[k] - 1e-9) errors.push(`usability criterion ${k} (${crit[k]}) is weaker than the study criterion ${USABILITY_DEFAULTS[k]}`);
  if (!/PROVISIONAL/.test(U.evidence ?? '')) errors.push('the usability criteria must be labelled PROVISIONAL');
  if (/accessib|complian|code/i.test(U.claims ?? '') && !/no |not /i.test(U.claims)) errors.push('the usability checks must not claim accessibility or code compliance');
  const a = usabilityAudit(plan);
  for (const f of a.findings) (f.severity === 'error' ? errors : warnings).push(f.text);
  for (const o of plan.openings.filter(o => DOOR_KINDS.includes(o.kind))) errors.push(...validateDoorParts(plan, o));
  for(const c of plan.wallStorage??[]) {
    if(!(c.bottom>=1.5&&c.top>c.bottom&&c.top<=plan.parameters.wallHeight))errors.push(`wall storage ${c.id}: invalid vertical envelope`);
    for(const f of plan.furniture)if(rectOverlap(c,f)>1e-6&&f.height>c.bottom-.05)errors.push(`wall storage ${c.id}: overlaps or lacks clearance above ${f.id}`);
    for(const o of plan.openings.filter(o=>!DOOR_KINDS.includes(o.kind))){const g=openingGeom(plan,o);const zone=g.wall.dir==='h'?rect(g.lo,g.wall.at-.5,g.hi,g.wall.at+.5):rect(g.wall.at-.5,g.lo,g.wall.at+.5,g.hi);if(rectOverlap(c,zone)>1e-6&&c.bottom<o.head&&c.top>o.sill)errors.push(`wall storage ${c.id}: blocks window ${o.id}`);}
  }
  // the carport side of the service door, for both carport options at the range ends, the default and each step-count change
  const cp = [];
  for (const opt of carportOptions(plan)) for (const land of routeTestLands(plan)) {
    const q = withCarportOption(plan, opt.id), s = serviceDoorCarportSide(q, land);
    if (!s) continue;
    cp.push([opt.id, land, s.steps]);
    if (!s.inLanding) errors.push(`carport ${opt.id} · land ${land.toFixed(3)}: the carport-side approach to ${plan.carportRoute.service.door} does not stand on the service landing`);
    if (!s.carFree) errors.push(`carport ${opt.id} · land ${land.toFixed(3)}: the parked car blocks the carport-side approach to ${plan.carportRoute.service.door}`);
  }
  for (const alt of U.alternatives ?? []) errors.push(...validateAlternative(plan, alt));
  info.usability = { findings: a.findings.length, errors: a.findings.filter(f => f.severity === 'error').length, routes: a.routes.map(r => [r.id, r.minClear]), doors: a.doors.length, zones: a.zones.length, carport: cp };
}

function unresolvedIssuesV26(plan, land) {
  const base = unresolvedIssuesV25(plan, land);
  if(plan.site.surveyEvidence){const i=base.findIndex(i=>i.id==='envelope'),n=currentIssueNotes(plan).find(i=>i.id==='envelope');if(i>=0&&n)base[i]={...base[i],title:n.title,text:n.text};}
  const extra = (plan.usability.issues ?? []).map(i => { const t = currentIssueNotes(plan).find(q => q.id === i.id) ?? { title: i.id, text: '' }; const wall = i.id === 'optB-wall' ? plan.walls.find(w => w.id === 'W-UK') : null; return { id: i.id, title: t.title, at: wall ? [wall.at, i.at[1]] : i.at, level: i.level ?? 'floor', text: t.text }; });
  return [...base, ...extra];
}

// Operational (simultaneous-use) scenarios, reported SEPARATELY from the static checks above: dining chairs pulled out (someone seated or
// getting up), appliance and cupboard doors open together with the route doors, people standing at the work positions. The service routes are
// re-tested in each scenario. PROVISIONAL; a conflict is a finding for review, not a validation error.
export function operationalAudit(plan, { land = plan.levels.land.default, use = null, routes = null, standDepth = 0.45 } = {}) {
  const useOf = f => use?.[f.id] ?? f.use, f2 = n => n.toFixed(2), out = [];
  const zonesOf = (kind, types) => plan.furniture.filter(f => (!types || types.includes(f.type)) && useOf(f)?.zones?.length)
    .flatMap(f => useOf(f).zones.filter(z => z.kind === kind && !z.anyOf).map(z => ({ f, z, rect: sideRect(rect(f.x0, f.y0, f.x1, f.y1), z.side, z.depth, z.span) })));
  const routeResult = (q, extra) => usabilityAudit(q, { land, use, routes, extraObstacles: extra }).routes.map(r => ({ id: r.id, label: r.label, ok: r.ok, minClear: r.minClear, blockedBy: [...new Set(r.legs.flatMap(l => l.blockedBy))] }));
  const scenario = (id, label, q, extra, conflicts = []) => {
    const rs = routeResult(q, extra);
    for (const r of rs.filter(r => !r.ok)) conflicts.push(`route ${r.id} (${r.label}) blocked by ${r.blockedBy.join(', ')}`);
    out.push({ id, label, routes: rs, conflicts });
  };
  // S1: every dining chair pulled out into its pull-out space (its body moves there)
  const pulled = plan.furniture.map(f => {
    const z = f.type === 'chair' ? useOf(f)?.zones?.find(q => q.kind === 'access') : null;
    if (!z) return f;
    const d = z.depth, dx = z.side === '+x' ? d : z.side === '-x' ? -d : 0, dy = z.side === '+y' ? d : z.side === '-y' ? -d : 0;
    return { ...f, x0: f.x0 + dx, x1: f.x1 + dx, y0: f.y0 + dy, y1: f.y1 + dy };
  });
  scenario('S1', 'dining chairs pulled out (seated / getting up)', { ...plan, furniture: pulled }, []);
  // S2: appliance and cupboard doors open (door envelopes), with the route doors open; envelopes against each other and against door swings
  const env = zonesOf('door');
  const c2 = [];
  for (let i = 0; i < env.length; i++) for (let j = i + 1; j < env.length; j++) if (rectOverlap(env[i].rect, env[j].rect) > 1e-6) c2.push(`${env[i].f.id} and ${env[j].f.id} doors cannot be open together`);
  for (const o of plan.openings.filter(o => DOOR_KINDS.includes(o.kind) && o.swing)) {
    const pts = sectorSamples(swingSector(plan, o));
    for (const e of env) if (pts.some(([x, y]) => inRect(e.rect, x, y, -1e-6))) c2.push(`door ${o.id} swing meets the open ${e.f.id} door`);
  }
  scenario('S2', 'appliance and cupboard doors open, route doors open', plan, env.map(e => ({ what: `open ${e.f.id} door`, rect: e.rect })), c2);
  // S3: a person standing at each work position (standDepth in front of the item), others passing on the routes
  const stand = zonesOf('work').map(e => ({ what: `person at ${e.f.id}`, rect: sideRect(rect(e.f.x0, e.f.y0, e.f.x1, e.f.y1), e.z.side, Math.min(standDepth, e.z.depth)) }));
  scenario('S3', `people at the work positions (${f2(standDepth)} m standing depth) while others pass`, plan, stand);
  return out;
}
