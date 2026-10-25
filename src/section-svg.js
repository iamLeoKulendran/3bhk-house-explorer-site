// Interactive House Explorer — V2.2+ pedestrian-route section as SVG strings.
// Pure functions of the plan dataset (no DOM). The viewer's profile panel shows routeSectionSvg() at the
// current land level; tools/render-v2-plan.mjs writes pedestrianSectionSheet() (land 1.50 / 1.75 / 2.00)
// next to the plan. Both read pedRoute() in geometry-v2.js, the same function as the 3D scene and the
// checks, so the section cannot drift from the model.
// PRELIMINARY — PROVISIONAL DIMENSIONS — NOT FOR CONSTRUCTION.

import {
  pedRoute, riserChangeLands, accessMetrics, levels, ramp, rampProfile, gateStudy, isEnclosed, roomCells,
  isV24, withCarportOption, carportComparison, carportStudy, carportRoute, carportRoof, activeCarportOption, figureOf,
  isV25, stairDesign, serviceYard, openingGeom,
} from './geometry-v2.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = n => n.toFixed(2);
const signed = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2);

export const SECTION_STYLE = `
.ps-t{font-family:'Segoe UI',Arial,sans-serif;fill:#2c3036;font-size:10px}
.ps-ground{fill:#ece4d2;stroke:none}.ps-surface{fill:none;stroke:#2c3036;stroke-width:1.6;stroke-linejoin:round}
.ps-road{stroke:#6b6f73;stroke-width:3}.ps-drain{fill:#5b6266;fill-opacity:.35;stroke:#4d5357;stroke-width:1}
.ps-water{stroke:#3f7fae;stroke-width:1.2;stroke-dasharray:5 3}.ps-slab{fill:#d9d2c3;stroke:#7b6a55;stroke-width:1;stroke-dasharray:4 2}
.ps-ctx{fill:none;stroke:#9a7b55;stroke-width:1;stroke-dasharray:5 3}.ps-wallctx{fill:#cbb79b;fill-opacity:.35;stroke:#7b6a55;stroke-width:.8;stroke-dasharray:3 2}
.ps-ffl{stroke:#2f5d62;stroke-width:1.2;stroke-dasharray:4 3}.ps-door{fill:#9a6b44;stroke:#3a2a1c;stroke-width:.8}
.ps-comp{font-size:9.5px;fill:#4a5058;text-anchor:middle}.ps-tick{stroke:#8d939b;stroke-width:.8}
.ps-lvl{font-size:9.5px;fill:#2c3036}.ps-lvl-ffl{fill:#2f5d62;font-weight:600}.ps-note{font-size:9.5px;fill:#555}
.ps-warn{font-size:9.5px;fill:#b5442f;font-weight:600}.ps-ok{font-size:9.5px;fill:#2f6b3a;font-weight:600}.ps-head{font-size:11.5px;font-weight:700}
`;

// One unfolded section along the route centreline at one land level: road (left) → entrance (right).
// o.scale: px per metre; o.vx: vertical exaggeration; o.pathShown: draw at most this much of the flat
// garden path (a break mark shows the cut); o.width: overall width (else fitted).
export function routeSectionSvg(plan, land, o = {}) {
  const r = pedRoute(plan, land), lv = r.levels, F = plan.frontage, st = plan.steps;
  const roadLen = o.roadLen ?? 1.4, pathLen = Math.min(r.path.length, o.pathShown ?? Infinity), cut = pathLen < r.path.length - 1e-6;
  const S = o.scale ?? 60, VX = o.vx ?? 1, fs = o.fontScale ?? 1;
  const segs = [];
  let s = 0;
  const put = (id, label, len) => { segs.push({ id, label, s0: s, s1: s + len }); s += len; };
  const sh = o.short;
  put('crossing', sh ? 'X' : 'drain crossing', F.drain.y1 - F.drain.y0);
  put('bottom', sh ? 'landing' : 'bottom landing', r.bottom.rect.y1 - r.bottom.rect.y0);
  put('flight', `flight ${r.flight.risers}R`, r.flight.rect.y1 - r.flight.rect.y0);
  put('upper', sh ? 'landing' : 'upper landing', r.upper.rect.y1 - r.upper.rect.y0);
  put('path', sh ? 'path (cut)' : cut ? `garden path ${f2(r.path.length)} m (cut)` : `garden path ${f2(r.path.length)} m`, pathLen);
  put('porchSteps', sh ? `${r.porchSteps.risers}R` : `porch steps ${r.porchSteps.risers}R`, r.porchSteps.rect.y1 - r.porchSteps.rect.y0);
  put('porch', sh ? 'porch' : 'porch landing', r.porch.rect.y1 - r.porch.rect.y0);
  const sEnd = s, at = id => segs.find(q => q.id === id);
  const door = plan.openings.find(q => q.id === r.entrance.door);
  const zMin = -(F.drain.depth + 0.15), zMax = lv.floor + door.head + 0.25;
  const padL = 8 * fs, padR = (o.padR ?? 165) * fs, padT = (o.padTop ?? 18) * fs, padB = 34 * fs;
  const w = o.width ?? Math.round(padL + (sEnd + roadLen + 0.6) * S + padR);
  const Sx = o.width ? (o.width - padL - padR) / (sEnd + roadLen + 0.6) : S, Sz = Sx * VX;
  const h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = v => padL + (v + roadLen) * Sx, py = z => padT + (zMax - z) * Sz;
  const P = pts => pts.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join(' ');
  const out = [];
  const add = x => out.push(x);
  const text = (x, y, t, cls, anchor = 'start') => add(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}">${esc(t)}</text>`);

  // surface along the route
  const pts = [[-roadLen, lv.road], [0, lv.road], [0, r.crossing.level], [at('bottom').s1, r.bottom.level]];
  const stairs = (s0, from, n, riser, going) => { let ss = s0; for (let k = 1; k <= n; k++) { pts.push([ss, from + (k - 1) * riser], [ss, from + k * riser]); if (k < n) ss += going; } };
  stairs(at('flight').s0, r.flight.from, r.flight.risers, r.flight.riser, r.flight.going);
  pts.push([at('path').s1, lv.yard]);
  stairs(at('porchSteps').s0, r.porchSteps.from, r.porchSteps.risers, r.porchSteps.riser, r.porchSteps.going);
  pts.push([sEnd, lv.floor], [sEnd + 0.6, lv.floor]);
  add(`<polygon points="${P([...pts, [sEnd + 0.6, zMin], [-roadLen, zMin]])}" class="ps-ground"/>`);
  // drain channel under the crossing (open; flow along the road, into the page) and the schematic slab
  const dr = at('crossing');
  add(`<rect x="${px(dr.s0).toFixed(1)}" y="${py(lv.road).toFixed(1)}" width="${((dr.s1 - dr.s0) * Sx).toFixed(1)}" height="${(F.drain.depth * Sz).toFixed(1)}" fill="#fbfaf6"/>`);
  add(`<rect x="${px(dr.s0).toFixed(1)}" y="${py(lv.road).toFixed(1)}" width="${((dr.s1 - dr.s0) * Sx).toFixed(1)}" height="${(F.drain.depth * Sz).toFixed(1)}" class="ps-drain"/>`);
  add(`<line x1="${px(dr.s0 + 0.05).toFixed(1)}" y1="${py(lv.road - F.drain.depth + 0.12).toFixed(1)}" x2="${px(dr.s1 - 0.05).toFixed(1)}" y2="${py(lv.road - F.drain.depth + 0.12).toFixed(1)}" class="ps-water"/>`);
  add(`<rect x="${px(dr.s0).toFixed(1)}" y="${py(r.crossing.level).toFixed(1)}" width="${((dr.s1 - dr.s0) * Sx).toFixed(1)}" height="${((r.crossing.level - r.crossing.underside) * Sz).toFixed(1)}" class="ps-slab"/>`);
  // context beside the route (dashed): planting strip and main wall beside the flight, garden, house floor
  const sAtY = y => at('flight').s0 + (y - st.y0);
  const sStrip0 = sAtY(F.plantingStrip.y0), sWall0 = sAtY(F.mainWall.y0), sWall1 = sAtY(F.mainWall.y1);
  const Ed = F.retainingEdge;
  add(`<polyline points="${P(Ed ? [[sStrip0, lv.toe], [sStrip0, lv.edgeCap], [sStrip0 + Ed.thickness, lv.edgeCap], [sStrip0 + Ed.thickness, lv.strip], [sWall0, lv.strip]] : [[at('bottom').s0, lv.verge], [sStrip0, lv.verge], [sStrip0, lv.strip], [sWall0, lv.strip]])}" class="ps-ctx"/>`);
  const wallTop = lv.yard + F.mainWall.topAboveGarden;
  add(`<rect x="${px(sWall0).toFixed(1)}" y="${py(wallTop).toFixed(1)}" width="${((sWall1 - sWall0) * Sx).toFixed(1)}" height="${((wallTop - lv.road) * Sz).toFixed(1)}" class="ps-wallctx"/>`);
  add(`<polyline points="${P([[sWall1, lv.yard], [at('flight').s1, lv.yard]])}" class="ps-ctx"/>`);
  add(`<line x1="${px(at('porchSteps').s0).toFixed(1)}" y1="${py(lv.floor).toFixed(1)}" x2="${px(at('porchSteps').s1).toFixed(1)}" y2="${py(lv.floor).toFixed(1)}" class="ps-ffl"/>`);
  add(`<polyline points="${P(pts.slice(0, 2))}" class="ps-road"/>`);
  add(`<polyline points="${P(pts.slice(1))}" class="ps-surface"/>`);
  if (cut) {
    const m = (at('path').s0 + at('path').s1) / 2, y0 = py(lv.yard) - 8 * fs, y1 = py(lv.yard) + 8 * fs, x = px(m);
    add(`<polyline points="${(x - 3).toFixed(1)},${y0.toFixed(1)} ${(x + 3).toFixed(1)},${(y0 + 5).toFixed(1)} ${(x - 3).toFixed(1)},${(y1 - 5).toFixed(1)} ${(x + 3).toFixed(1)},${y1.toFixed(1)}" fill="none" stroke="#2c3036" stroke-width="1"/>`);
  }
  // V2.4: the 1.70 m person standing in the road (scale reference)
  if (isV24(plan) && figureOf(plan)) add(figureSvg(px(-roadLen * 0.55), py(lv.road), Sx, Sz, figureOf(plan).height, o.short ? '' : '1.70 m', fs));
  // entrance door
  add(`<rect x="${(px(sEnd) - 2.5 * fs).toFixed(1)}" y="${py(lv.floor + door.head).toFixed(1)}" width="${(5 * fs).toFixed(1)}" height="${(door.head * Sz).toFixed(1)}" class="ps-door"/>`);
  text(px(sEnd) + 5 * fs, py(lv.floor + door.head) + 10 * fs, 'entrance', 'ps-note');
  // component ticks and labels under the section (two staggered rows)
  const baseY = py(zMin) + 2;
  segs.forEach((q, i) => {
    add(`<line x1="${px(q.s0).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${px(q.s0).toFixed(1)}" y2="${(baseY + 6 * fs).toFixed(1)}" class="ps-tick"/>`);
    text((px(q.s0) + px(q.s1)) / 2, baseY + (i % 2 ? 24 : 13) * fs, q.label, 'ps-comp', 'middle');
  });
  add(`<line x1="${px(sEnd).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${px(sEnd).toFixed(1)}" y2="${(baseY + 6 * fs).toFixed(1)}" class="ps-tick"/>`);
  if (!sh) text(px(-roadLen) + 2, baseY + 13 * fs, 'road', 'ps-comp', 'start');
  // flight annotation
  const fl = at('flight');
  text((px(fl.s0) + px(fl.s1)) / 2, py(lv.yard) - 8 * fs, `${r.flight.risers} × ${(r.flight.riser * 1000).toFixed(0)} mm, going ${(r.flight.going * 1000).toFixed(0)}`, 'ps-note', 'middle');
  text(px(sWall0) + 3, py(wallTop) - 3 * fs, 'main wall (beside)', 'ps-note');
  text(px(sStrip0) + 2, py(lv.strip) - 3 * fs, 'strip (beside)', 'ps-note');
  // level tags (right margin), de-overlapped
  const tags = [[lv.floor, `Floor / porch ${signed(lv.floor)}`, 'ps-lvl-ffl'], [lv.yard, `Garden / landing / path ${signed(lv.yard)}`, ''],
    [lv.strip, `${Ed ? 'Planting soil' : 'Strip'} ${signed(lv.strip)} (beside)`, ''], ...(Ed ? [[lv.edgeCap, `Capping ${signed(lv.edgeCap)} (beside)`, '']] : []), [r.bottom.level, `Crossing / landing / ${Ed ? 'toe ground' : 'verge'} ${signed(r.bottom.level)}`, ''], [lv.road, 'Road ±0.00 (datum)', '']];
  let last = -Infinity;
  for (const [z, t, cls] of tags.map(([z, t, c]) => [py(z) + 3, t, c]).sort((a, b) => a[0] - b[0])) {
    const y = Math.max(z, last + 11 * fs); last = y;
    text(px(sEnd + 0.6) + 6 * fs, y, t, `ps-lvl ${cls}`);
  }
  return { svg: out.join(''), w, h };
}

// Viewer panel: the section at the current land level, fitted to the panel width (vertical ×2, path cut).
export function routeSectionPanel(plan, land, width = 440) {
  const r = pedRoute(plan, land);
  const sec = routeSectionSvg(plan, land, { width, vx: 2, pathShown: 2.2, fontScale: 0.8, roadLen: 0.8, padTop: 14, padR: 182, short: true });
  return `
    <div class="profile-head"><b>Pedestrian route section</b> · unfolded along the route · vertical ×2 · path shortened · ASSUMED geometry · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${width} ${sec.h}" role="img" aria-label="Section along the pedestrian route from the road to the entrance"><style>${SECTION_STYLE}</style>${sec.svg}</svg>
    <div class="profile-foot">X = drain crossing. Crossing → bottom landing → ${r.flight.risers} risers → upper landing → ${f2(r.path.length)} m path → ${r.porchSteps.risers} porch risers → entrance. Levels join at every step; geometric check only (no stair compliance, handrail or step-free street access).</div>`;
}

// Standalone sheet: the section at the bottom, default and top of the owner-estimated land range.
export function pedestrianSectionSheet(plan) {
  const L = plan.levels.land, lands = [L.min, L.default, L.max], W = 1700, S = 62;
  const parts = lands.map(l => ({ land: l, r: pedRoute(plan, l), sec: routeSectionSvg(plan, l, { scale: S, vx: 1 }) }));
  const out = [];
  let y = 120;
  for (const p of parts) {
    const m = accessMetrics(plan, p.land);
    out.push(`<text x="40" y="${y}" class="ps-t ps-head">Land ${signed(p.land)} m — ${p.r.flight.risers} risers of ${(p.r.flight.riser * 1000).toFixed(0)} mm · flight ${f2(p.r.flight.rect.y1 - p.r.flight.rect.y0)} m · upper landing ${f2(p.r.upper.rect.y1 - p.r.upper.rect.y0)} m · garden path ${f2(p.r.path.length)} m · porch steps ${p.r.porchSteps.risers} × ${(p.r.porchSteps.riser * 1000).toFixed(0)} mm · main wall ${f2(m.frontWallAboveRoad)} m above the road</text>`);
    out.push(`<g transform="translate(40 ${y + 6})">${p.sec.svg}</g>`);
    y += p.sec.h + 40;
  }
  const changes = riserChangeLands(plan).map(c => `${signed(c.land)} m (${c.risersAtOrBelow} → ${c.risersAbove} risers)`).join(', ');
  const notes = [
    'One structured source: data/plans/' + plan.id + '.json → pedRoute() in src/geometry-v2.js, the same function the 3D viewer and tools/check-v2.mjs use. True scale (no vertical exaggeration); drawn unfolded along the route centreline.',
    plan.frontage.retainingEdge
      ? 'Levels shown separately: road datum ±0.00 (ASSUMED); crossing, bottom landing and the retaining-face toe +0.10 (ASSUMED; no verge); planting soil +1.00 and capping +1.10 beside the flight (ASSUMED, the ≈1 m visible face is OWNER-ESTIMATED — TO BE VERIFIED, ownership unknown); garden = upper landing = path = land (OWNER-ESTIMATED +1.50 to +2.00); house floor and porch = land + 0.45 (ASSUMED plinth). The bottom landing is cut into the strip zone and enclosed by the flight side walls.'
      : 'Levels shown separately: road datum ±0.00 (ASSUMED); crossing, bottom landing and verge +0.10 (ASSUMED); planting strip +0.50 beside the flight (ASSUMED, ownership unknown); garden = upper landing = path = land (OWNER-ESTIMATED +1.50 to +2.00); house floor and porch = land + 0.45 (ASSUMED plinth).',
    `Riser count follows the land level (risers of at most ${(plan.steps.maxRiser * 1000).toFixed(0)} mm). It changes at land ${changes}; the checks run just below and above each change point.`,
    'The drain crossing is SCHEMATIC: the slab leaves the channel open (flow along the road, direction unknown); span, supports, capacity and permission are not designed. No handrail, intermediate landing, lighting, pedestrian gate or step-free street entrance is designed. Not a stair-compliance, structural, drainage or accessibility check.',
  ];
  out.push(`<text x="40" y="${y}" class="ps-t ps-head">Notes</text>`);
  y += 16;
  for (const n of notes) {
    const words = n.split(' '); let line = '';
    for (const wd of words) { if ((line + ' ' + wd).length > 220) { out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 14; line = wd; } else line = line ? `${line} ${wd}` : wd; }
    out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 18;
  }
  const H = y + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>${esc(plan.revision)} — pedestrian route section at land ${lands.map(signed).join(' / ')} m — PRELIMINARY — PROVISIONAL DIMENSIONS — NOT FOR CONSTRUCTION</title>
<style>${SECTION_STYLE}</style>
<rect width="100%" height="100%" fill="#fbfaf6"/>
<rect x="0" y="0" width="${W}" height="34" fill="#8a2b1c"/>
<text x="${W / 2}" y="22" class="ps-t" style="fill:#fff;font-size:14px;font-weight:700;letter-spacing:.03em" text-anchor="middle">PRELIMINARY — PROVISIONAL DIMENSIONS — NOT FOR CONSTRUCTION</text>
<text x="40" y="64" class="ps-t" style="font-size:20px;font-weight:700">${esc(plan.revision)} — Pedestrian route section · road → crossing → landings → flight → garden path → porch → entrance</text>
<text x="40" y="84" class="ps-t ps-note" style="font-size:12px">Drawn from the same dataset as the plan and the 3D viewer at the bottom, default and top of the OWNER-ESTIMATED land range. Every dimension ASSUMED except that range. Generated by tools/render-v2-plan.mjs · 2026-10-22</text>
${out.join('\n')}
</svg>
`;
}

// ---------- V2.3: driveway section (road → drain → gate on the front-wall line → climb → carport) ----------
// Drawn from the same gateStudy() / driveSurface() / rampProfile() as the plan, the 3D scene and the checks.
export const DRIVE_STYLE = `
.pd-wait{fill:rgba(210,85,59,.14);stroke:#d2553b;stroke-width:1.4;stroke-dasharray:6 3}.pd-enc{fill:#b5442f;stroke:none}.pd-off{fill:#8a9099;stroke:none}
.pd-car{fill:rgba(47,111,163,.12);stroke:#2f6fa3;stroke-width:1.1;stroke-dasharray:5 3}.pd-leaf{fill:#9a6b44;stroke:#3a2a1c;stroke-width:.8}
.pd-pier{fill:#fff;fill-opacity:.7;stroke:#3a3f46;stroke-width:1;stroke-dasharray:3 2}.pd-roof{fill:#dcd6c8;stroke:#7b6a55;stroke-width:.9}
.pd-wall{fill:#e8e1d2;stroke:#7b6a55;stroke-width:.9}.pd-col{fill:none;stroke:#2c3036;stroke-width:1.2;stroke-dasharray:3 2}
.pd-swing{fill:none;stroke:#2f6fa3;stroke-width:1.6;stroke-dasharray:6 3}.pd-base{stroke:#2f5d62;stroke-width:1.2}
`;

export function driveSectionSvg(plan, land, o = {}) {
  const lv = levels(plan, land), F = plan.frontage, S = plan.site, cp = plan.carport, g = plan.gate, env = plan.parameters.vehicleEnvelope;
  const gs = gateStudy(plan, land), geo = gs.geo, w = gs.waiting, R = ramp(plan), prof = rampProfile(plan, land, 90), am = accessMetrics(plan, land);
  const sw = gs.options.find(q => q.id === 'swing-in'), car = plan.furniture.find(q => q.type === 'vehicle');
  const yA = o.yStart ?? S.road.y0 + 1.6, yB = o.yEnd ?? cp.y1 + 0.5;
  const zMin = -(F.drain.depth + 0.28), zMax = lv.carport + cp.clearHeight + cp.roofThickness + 0.3;
  const cmp = o.compact === true;   // the small viewer panel keeps only the essential labels
  const fs = o.fontScale ?? 1, VX = o.vx ?? 1, padL = 8 * fs, padR = (o.padR ?? 170) * fs, padT = (o.padTop ?? 18) * fs, padB = 44 * fs;
  const width = o.width ?? 1700, Sx = (width - padL - padR) / (yB - yA), Sz = Sx * VX;
  const h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = y => padL + (y - yA) * Sx, py = z => padT + (zMax - z) * Sz;
  const P = pts => pts.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join(' ');
  const out = [], add = x => out.push(x);
  const rc = (ya, yb, za, zb, cls) => add(`<rect x="${px(ya).toFixed(1)}" y="${py(zb).toFixed(1)}" width="${((yb - ya) * Sx).toFixed(1)}" height="${((zb - za) * Sz).toFixed(1)}" class="${cls}"/>`);
  const ln = (ya, za, yb, zb, cls) => add(`<line x1="${px(ya).toFixed(1)}" y1="${py(za).toFixed(1)}" x2="${px(yb).toFixed(1)}" y2="${py(zb).toFixed(1)}" class="${cls}"/>`);
  const tx = (y, z, t, cls = 'ps-note', anchor = 'start', dx = 0, dy = 0) => add(`<text x="${(px(y) + dx).toFixed(1)}" y="${(py(z) + dy).toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}">${esc(t)}</text>`);

  // ground along the driveway centreline
  const surf = [[yA, lv.road], [F.roadEdge.y, lv.road], [F.roadEdge.y, lv.apron], [R.y0, lv.apron], ...prof.slice(1), [cp.y1, lv.carport], [yB, lv.carport]];
  add(`<polygon points="${P([...surf, [yB, zMin], [yA, zMin]])}" class="ps-ground"/>`);
  rc(F.drain.y0, F.drain.y1, -F.drain.depth, lv.road, 'ps-drain');
  rc(F.drain.y0, F.drain.y1, lv.apron - (plan.driveway.crossingThickness ?? 0.1), lv.apron, 'ps-slab');
  ln(F.drain.y0 + 0.05, -F.drain.depth + 0.12, F.drain.y1 - 0.05, -F.drain.depth + 0.12, 'ps-water');
  // context beside the centreline (dashed): verge, planting strip, main wall, garden, house floor
  add(`<polyline points="${P([[F.verge.y0, lv.verge], [F.verge.y1, lv.verge], [F.verge.y1, lv.strip], [F.plantingStrip.y1, lv.strip]])}" class="ps-ctx"/>`);
  const wallTop = lv.yard + F.mainWall.topAboveGarden;
  rc(F.mainWall.y0, F.mainWall.y1, lv.road, wallTop, 'ps-wallctx');
  add(`<polyline points="${P([[F.mainWall.y1, lv.yard], [plan.carport.y0, lv.yard]])}" class="ps-ctx"/>`);
  const houseFront = Math.min(...plan.rooms.filter(isEnclosed).flatMap(roomCells).map(c => c.y0)), houseRear = Math.max(...plan.rooms.filter(isEnclosed).flatMap(roomCells).map(c => c.y1));
  add(`<polyline points="${P([[cp.y0, lv.floor], [Math.min(yB, houseRear), lv.floor]])}" class="ps-ffl"/>`);
  // carport: roof slab, rear wall, columns (beside), parked car
  rc(cp.y0 - cp.roofFrontOverhang, cp.y1, lv.carport + cp.clearHeight, lv.carport + cp.clearHeight + cp.roofThickness, 'pd-roof');
  rc(cp.y1 - 0.115, cp.y1 + 0.115, lv.carport, lv.carport + cp.clearHeight, 'pd-wall');
  for (const c of cp.columns ?? []) rc(c.y0, c.y1, lv.carport, lv.carport + cp.clearHeight, 'pd-col');
  if (car) rc(car.y0, car.y1, lv.carport, lv.carport + env.height, 'pd-car');
  // the gate on the front-wall line: leaf from the derived base, pier beside it
  rc(g.pierLeft.y0, g.pierLeft.y1, geo.base, geo.pierTop, 'pd-pier');
  rc(g.y - geo.leafThickness / 2, g.y + geo.leafThickness / 2, geo.bottom, geo.top, 'pd-leaf');
  ln(g.y - 0.55, geo.base, g.y + 0.55, geo.base, 'pd-base');
  // swing-in sweep (surface rise under it) and the waiting car with its road encroachment
  const zs = geo.top + 0.2;
  ln(g.y, zs, g.y + gs.half, zs, 'pd-swing');
  rc(w.y0, w.y1, w.base, w.top, 'pd-wait');
  const zb = lv.road - 0.1;
  if (w.encroach > 0) rc(w.y0, F.roadEdge.y, zb - 0.07, zb + 0.07, 'pd-enc');
  rc(Math.max(w.y0, F.roadEdge.y), w.y1, zb - 0.07, zb + 0.07, 'pd-off');
  // road, surface line
  add(`<polyline points="${P(surf.slice(0, 2))}" class="ps-road"/>`);
  add(`<polyline points="${P(surf.slice(2))}" class="ps-surface"/>`);
  // labels
  tx((w.y0 + w.y1) / 2, w.top + 0.1, cmp ? 'waiting car' : 'waiting car 4.50 m (ASSUMED)', 'ps-warn', 'middle', 0, -3 * fs);
  if (w.encroach > 0) tx((w.y0 + F.roadEdge.y) / 2 - (cmp ? 0.6 : 0), zb, cmp ? `${f2(w.encroach)} m into the road` : `${f2(w.encroach)} m into the carriageway`, 'ps-warn', 'middle', 0, 18 * fs);
  if (!cmp) tx((Math.max(w.y0, F.roadEdge.y) + w.y1) / 2 + 0.55, zb, `${f2(w.available)} m off-road`, 'ps-note', 'middle', 0, 18 * fs);
  if (!cmp) tx(g.y - 0.12, geo.top + 0.3, `gate · base ${signed(geo.base)} (derived)`, 'ps-note', 'end', 0, 0);
  if (!cmp) tx(g.y + gs.half / 2, zs, `swing-in sweep ${f2(gs.half)} m · rise ${f2(sw.groundRise)} m`, 'ps-note', 'middle', 0, -4 * fs);
  if (!cmp) {
    tx(3.0, lv.yard, `garden ${signed(lv.yard)} (beside)`, 'ps-note', 'start', 0, -3 * fs);
    tx(F.mainWall.y1 + 0.2, wallTop, 'main wall (beside)', 'ps-note', 'start', 0, -3 * fs);
    tx(F.drain.y0 + 0.5, lv.road - F.drain.depth, 'open drain · schematic crossing', 'ps-note', 'middle', 0, 11 * fs);
  }
  const mid = prof[Math.floor(prof.length * 0.55)];
  tx(mid[0] + (cmp ? 1.6 : 0), mid[1] - (cmp ? 0.15 : 0), cmp ? `climb ${f2(am.run)} m · ${am.averageGradientPct.toFixed(0)}% avg / ${am.maxLocalGradientPct.toFixed(0)}% max` : `climb ${f2(am.run)} m · ${am.averageGradientPct.toFixed(1)}% avg / ${am.maxLocalGradientPct.toFixed(1)}% max · clearance UNCHECKED`, 'ps-warn', 'middle', 0, -12 * fs);
  if (!cmp) tx((cp.y0 + cp.y1) / 2, lv.carport + cp.clearHeight + cp.roofThickness, 'carport roof — own columns (beside)', 'ps-note', 'middle', 0, -4 * fs);
  // axis ticks every 2 m from the frontage line
  const ay = py(zMin) + 4 * fs;
  for (let y = Math.ceil(yA / 2) * 2; y <= yB; y += 2) { add(`<line x1="${px(y).toFixed(1)}" y1="${ay.toFixed(1)}" x2="${px(y).toFixed(1)}" y2="${(ay + 5 * fs).toFixed(1)}" class="ps-tick"/>`); add(`<text x="${px(y).toFixed(1)}" y="${(ay + 15 * fs).toFixed(1)}" class="ps-t ps-comp" text-anchor="middle">${y}</text>`); }
  if (!cmp) add(`<text x="${px(yA) + 2}" y="${(ay + 28 * fs).toFixed(1)}" class="ps-t ps-note">metres from the symbolic frontage line (y = 0): road (left) → carport rear (right); section along the driveway centreline</text>`);
  // level tags (right margin), de-overlapped
  const tags = [[lv.floor, `House floor ${signed(lv.floor)}`, 'ps-lvl-ffl'], [lv.carport, `Carport ${signed(lv.carport)}`, ''], [lv.yard, `Garden ${signed(lv.yard)}`, ''], [lv.strip, `Strip ${signed(lv.strip)} (beside)`, ''],
    [geo.base, `Apron = gate base ${signed(geo.base)}`, ''], [lv.road, 'Road ±0.00 (datum)', '']];
  let last = -Infinity;
  for (const [z, t, cls] of tags.map(([z, t, c]) => [py(z) + 3, t, c]).sort((a, b) => a[0] - b[0])) {
    const y = Math.max(z, last + 11 * fs); last = y;
    add(`<text x="${(px(yB) + 6 * fs).toFixed(1)}" y="${y.toFixed(1)}" class="ps-t ps-lvl ${cls}">${esc(t)}</text>`);
  }
  return { svg: out.join(''), w: width, h };
}

export function driveSectionPanel(plan, land, width = 440) {
  if (isV24(plan)) return carportSectionPanel(plan, land, width);
  const gs = gateStudy(plan, land), cp = plan.carport;
  const sec = driveSectionSvg(plan, land, { width, vx: 2, fontScale: 0.8, padR: 138, padTop: 12, yStart: plan.frontage.roadEdge.y - 2.6, yEnd: cp.y0 + 1.0, compact: true });
  return `
    <div class="profile-head"><b>Driveway section</b> · centreline · vertical ×2 · gate on the front-wall line · ASSUMED geometry · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${width} ${sec.h}" role="img" aria-label="Section along the driveway from the road to the carport"><style>${SECTION_STYLE}${DRIVE_STYLE}</style>${sec.svg}</svg>
    <div class="profile-foot">Gate base ${signed(gs.geo.base)} from the driveway surface; a waiting car projects ${f2(gs.waiting.encroach)} m into the road. Drawn-shape arithmetic only — gate operation, clearance and drainage are NOT demonstrated.</div>`;
}

export function drivewaySectionSheet(plan) {
  const L = plan.levels.land, lands = [L.min, L.default, L.max], W = 1700;
  const parts = lands.map(l => ({ land: l, gs: gateStudy(plan, l), am: accessMetrics(plan, l), sec: driveSectionSvg(plan, l, { width: W - 80, vx: 1 }) }));
  const out = [];
  let y = 120;
  for (const p of parts) {
    out.push(`<text x="40" y="${y}" class="ps-t ps-head">Land ${signed(p.land)} m — climb ${f2(p.am.run)} m, rise ${f2(p.am.rise)} m, ${p.am.averageGradientPct.toFixed(1)}% average / ${p.am.maxLocalGradientPct.toFixed(1)}% steepest · gate base ${signed(p.gs.geo.base)} (${f2(p.gs.geo.belowGarden)} m below the garden) · waiting car ${f2(p.gs.waiting.encroach)} m into the road, ${f2(p.gs.waiting.available)} m off-road · inward sweep rise ${f2(p.gs.options.find(q => q.id === 'swing-in').groundRise)} m</text>`);
    out.push(`<g transform="translate(40 ${y + 6})">${p.sec.svg}</g>`);
    y += p.sec.h + 40;
  }
  const notes = [
    'One structured source: data/plans/' + plan.id + '.json → gateStudy(), driveSurface() and rampProfile() in src/geometry-v2.js, the same functions the plan, the 3D viewer and tools/check-v2.mjs use. True scale (no vertical exaggeration).',
    'The gate base is derived from the driveway surface at the gate line (the level apron, ' + signed(parts[0].gs.geo.base) + '), not from the raised garden or the carport floor. The gate piers and the carport roof columns are separate elements about 10 m apart.',
    'Waiting car: the generic 4.50 × 1.85 × 1.65 m envelope (ASSUMED; not the Focus or Vezel) with its nose 0.30 m outside the closed leaf. It stands on the schematic drain crossing and the verge and projects into the carriageway (display width, not measured). Automatic opening does not create waiting space.',
    'Not designed or checked: gate operation (no option is declared workable), vehicle clearance on the ramp, crossing structure and capacity, retaining, drainage, ownership of the verge and strip, and the neighbouring levels.',
  ];
  out.push(`<text x="40" y="${y}" class="ps-t ps-head">Notes</text>`);
  y += 16;
  for (const n of notes) {
    const words = n.split(' '); let line = '';
    for (const wd of words) { if ((line + ' ' + wd).length > 220) { out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 14; line = wd; } else line = line ? `${line} ${wd}` : wd; }
    out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 18;
  }
  const H = y + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>${esc(plan.revision)} — driveway section at land ${lands.map(signed).join(' / ')} m — PRELIMINARY — NOT SURVEYED — NOT FOR CONSTRUCTION</title>
<style>${SECTION_STYLE}${DRIVE_STYLE}</style>
<rect width="100%" height="100%" fill="#fbfaf6"/>
<rect x="0" y="0" width="${W}" height="34" fill="#8a2b1c"/>
<text x="${W / 2}" y="22" class="ps-t" style="fill:#fff;font-size:14px;font-weight:700;letter-spacing:.03em" text-anchor="middle">PRELIMINARY — NOT SURVEYED — NOT FOR CONSTRUCTION</text>
<text x="40" y="64" class="ps-t" style="font-size:20px;font-weight:700">${esc(plan.revision)} — Driveway section · road → drain → gate on the front-wall line → climb → carport</text>
<text x="40" y="84" class="ps-t ps-note" style="font-size:12px">Drawn from the same dataset as the plan and the 3D viewer at the bottom, default and top of the OWNER-ESTIMATED land range. All dimensions PROVISIONAL (ASSUMED) except that range. Generated by tools/render-v2-plan.mjs · 2026-10-22</text>
${out.join('\n')}
</svg>
`;
}

// ---------- V2.4: frontage section, carport A / B comparison section, carport walking-route section ----------
// All drawn from the same dataset through levels(), carportStudy(), carportRoute() and rampProfile(), so they cannot drift from the plan,
// the 3D scene or the checks. PRELIMINARY CONCEPT — PROVISIONAL DIMENSIONS — NOT SURVEYED — NOT FOR CONSTRUCTION.
export const V24_STYLE = `
.pf-stone{fill:#b9a07e;stroke:#6b5a45;stroke-width:.9}.pf-cap{fill:#e2dccd;stroke:#6b5a45;stroke-width:.9}.pf-soil{fill:#8f7658;fill-opacity:.55;stroke:none}
.pf-wall{fill:#f7f4ec;stroke:#6b5a45;stroke-width:.9}.pf-dim{stroke:#2f5d62;stroke-width:1.3;fill:none}.pf-dimt{font-size:10.5px;fill:#1f4a4f;font-weight:700}
.pf-lvl{stroke:#9aa3a8;stroke-width:.7;stroke-dasharray:2 3;fill:none}.pf-fig{fill:#2f5d62;stroke:#1f3d40;stroke-width:.5}.pf-figt{font-size:10px;fill:#1f4a4f;font-weight:700}
.pf-A{fill:none;stroke:#8a5a2b;stroke-width:2.2}.pf-B{fill:none;stroke:#2f6fa3;stroke-width:2.2}.pf-Af{fill:#8a5a2b;fill-opacity:.12;stroke:none}.pf-Bf{fill:#2f6fa3;fill-opacity:.12;stroke:none}
.pf-Ad{fill:none;stroke:#8a5a2b;stroke-width:1.2;stroke-dasharray:5 3}.pf-Bd{fill:none;stroke:#2f6fa3;stroke-width:1.2;stroke-dasharray:5 3}
.pf-At{font-size:10.5px;fill:#7a4a1c;font-weight:700}.pf-Bt{font-size:10.5px;fill:#1f5b8c;font-weight:700}
.pf-ground{fill:#e7dfcb;stroke:none}.pf-zone{fill:rgba(224,160,48,.35);stroke:#c98a1a;stroke-width:.8}.pf-route{fill:rgba(63,154,99,.25);stroke:#3f9a63;stroke-width:1}
.pf-treadlbl{font-size:9px;fill:#4a5058;text-anchor:middle}
`;

// A simple 1.70 m person silhouette (scale reference) with its height label. (cx, py0) = feet in pixels; sx / sz = pixels per metre.
function figureSvg(cx, py0, sx, sz, h, label, fs = 1) {
  const y = k => (py0 - k * h * sz).toFixed(1), w = (m) => (m * sx).toFixed(1), x = m => (cx + m * sx).toFixed(1);
  const out = [];
  for (const dx of [-0.105, 0.015]) out.push(`<rect x="${x(dx)}" y="${y(0.47)}" width="${w(0.09)}" height="${(0.47 * h * sz).toFixed(1)}" class="pf-fig"/>`);
  out.push(`<rect x="${x(-0.23)}" y="${y(0.83)}" width="${w(0.46)}" height="${(0.36 * h * sz).toFixed(1)}" rx="2" class="pf-fig"/>`);
  for (const dx of [-0.31, 0.25]) out.push(`<rect x="${x(dx)}" y="${y(0.8)}" width="${w(0.06)}" height="${(0.33 * h * sz).toFixed(1)}" class="pf-fig"/>`);
  out.push(`<ellipse cx="${cx.toFixed(1)}" cy="${(py0 - (h - 0.065 * h) * sz).toFixed(1)}" rx="${w(0.11)}" ry="${(0.065 * h * sz).toFixed(1)}" class="pf-fig" style="fill:#e0b895"/>`);
  if (label) out.push(`<text x="${cx.toFixed(1)}" y="${(py0 - h * sz - 5 * fs).toFixed(1)}" text-anchor="middle" class="ps-t pf-figt" style="font-size:${(10 * fs).toFixed(1)}px">${esc(label)}</text>`);
  return out.join('');
}

// Right-margin level tags, de-overlapped (z in metres; py maps z to pixels).
function levelTags(add, tags, py, x, fs = 1) {
  let last = -Infinity;
  for (const [z, t, cls] of tags.map(([z, t, c]) => [py(z) + 3, t, c]).sort((a, b) => a[0] - b[0])) {
    const y = Math.max(z, last + 11 * fs); last = y;
    add(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="ps-t ps-lvl ${cls}">${esc(t)}</text>`);
  }
}

// Section across the road, drain, retaining edge, strip, main wall and garden at x (default 12.0 m): the visible face and every reference level.
export function frontageSectionSvg(plan, land, o = {}) {
  const lv = levels(plan, land), F = plan.frontage, E = F.retainingEdge, S = plan.site, MW = F.mainWall, fg = figureOf(plan);
  const x = o.x ?? 12.0, cmp = o.compact === true, fs = o.fontScale ?? 1, VX = o.vx ?? 1;
  const yA = o.yStart ?? S.road.y0 + 4.0, yB = o.yEnd ?? 9.3, houseFront = 8.3;
  const wallTop = lv.yard + MW.topAboveGarden, stoneTop = lv.strip + MW.stoneAboveStrip, floorShown = lv.floor + 0.9;
  const zMin = -(F.drain.depth + 0.3), zMax = Math.max(floorShown, wallTop) + 0.35;
  const padL = 8 * fs, padR = (o.padR ?? 205) * fs, padT = (o.padTop ?? 20) * fs, padB = 62 * fs, width = o.width ?? 1700;
  const Sx = (width - padL - padR) / (yB - yA), Sz = Sx * VX, h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = y => padL + (y - yA) * Sx, py = z => padT + (zMax - z) * Sz;
  const P = pts => pts.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join(' ');
  const out = [], add = v => out.push(v);
  const rc = (ya, yb, za, zb, cls) => add(`<rect x="${px(ya).toFixed(1)}" y="${py(zb).toFixed(1)}" width="${((yb - ya) * Sx).toFixed(1)}" height="${((zb - za) * Sz).toFixed(1)}" class="${cls}"/>`);
  const ln = (ya, za, yb, zb, cls) => add(`<line x1="${px(ya).toFixed(1)}" y1="${py(za).toFixed(1)}" x2="${px(yb).toFixed(1)}" y2="${py(zb).toFixed(1)}" class="${cls}"/>`);
  const tx = (y, z, t, cls = 'ps-note', anchor = 'start', dx = 0, dy = 0) => add(`<text x="${(px(y) + dx).toFixed(1)}" y="${(py(z) + dy).toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}" style="font-size:${(10 * fs).toFixed(1)}px">${esc(t)}</text>`);
  const surf = [[yA, lv.road], [F.roadEdge.y, lv.road], [F.roadEdge.y, -F.drain.depth], [F.drain.y1, -F.drain.depth], [F.drain.y1, lv.toe], [E.y0, lv.toe], [E.y0, lv.edgeCap], [E.y0 + E.thickness, lv.edgeCap],
    [E.y0 + E.thickness, lv.strip], [MW.y0, lv.strip], [MW.y0, wallTop], [MW.y1, wallTop], [MW.y1, lv.yard], [houseFront, lv.yard], [houseFront, lv.floor], [yB, lv.floor]];
  add(`<polygon points="${P([...surf, [yB, zMin], [yA, zMin]])}" class="ps-ground"/>`);
  rc(F.drain.y0, F.drain.y1, -F.drain.depth, lv.road, 'ps-drain');
  ln(F.drain.y0 + 0.05, -F.drain.depth + 0.12, F.drain.y1 - 0.05, -F.drain.depth + 0.12, 'ps-water');
  rc(E.y0, E.y0 + E.thickness, lv.toe, lv.edgeCap - 0.06, 'pf-stone'); rc(E.y0 - 0.02, E.y0 + E.thickness + 0.02, lv.edgeCap - 0.06, lv.edgeCap, 'pf-cap');
  rc(E.y0 + E.thickness, MW.y0, lv.toe, lv.strip, 'pf-soil');
  rc(MW.y0, MW.y1, lv.strip, stoneTop, 'pf-stone'); rc(MW.y0, MW.y1, stoneTop, wallTop, 'pf-wall');
  rc(houseFront - 0.115, houseFront + 0.115, lv.floor, floorShown, 'pf-wall');
  add(`<polyline points="${P(surf.slice(0, 2))}" class="ps-road"/><polyline points="${P(surf.slice(1))}" class="ps-surface"/>`);
  // separate reference levels: dotted leaders from the structure to the right margin
  const refs = [[lv.floor, 'ps-lvl-ffl'], [wallTop, ''], [lv.yard, ''], [lv.edgeCap, ''], [lv.strip, ''], [lv.toe, '']];
  for (const [z] of refs) ln(Math.min(z === lv.floor ? houseFront : z === lv.toe ? E.y0 : z === lv.strip || z === lv.edgeCap ? E.y0 : MW.y1, yB), z, yB, z, 'pf-lvl');
  // visible face dimension (toe → top of the capping) in front of the face
  const dy = E.y0 - 0.42;
  ln(dy, lv.toe, dy, lv.edgeCap, 'pf-dim'); for (const z of [lv.toe, lv.edgeCap]) ln(dy - 0.1, z, dy + 0.1, z, 'pf-dim');
  tx(dy - 0.13, (lv.toe + lv.edgeCap) / 2 + 0.05, cmp ? `≈ ${f2(E.visibleFace)} m face` : `visible face ≈ ${f2(E.visibleFace)} m`, 'pf-dimt', 'end');
  if (!cmp) tx(dy - 0.13, (lv.toe + lv.edgeCap) / 2 + 0.05, 'OWNER-ESTIMATED — TO BE VERIFIED', 'pf-dimt', 'end', 0, 13 * fs);
  // soil drop below the capping and the wall retention
  ln(E.y0 + E.thickness + 0.4, lv.strip, E.y0 + E.thickness + 0.4, lv.edgeCap, 'pf-dim');
  if (!cmp) tx(E.y0 + E.thickness + 0.5, (lv.strip + lv.edgeCap) / 2 - 0.02, `soil ${f2(E.soilBelowCap)} m below the capping`, 'ps-note', 'start');
  if (!cmp) tx(MW.y1 + 0.3, (lv.strip + lv.yard) / 2, `main wall retains ${f2(lv.yard - lv.strip)} m of garden above the soil (retaining design needs professionals)`, 'ps-note', 'start');
  tx(MW.y1 + 0.3, (lv.yard + wallTop) / 2 + 0.1, cmp ? '' : `main wall top ${signed(wallTop)}`, 'ps-note', 'start');
  if (!cmp) tx((F.roadEdge.y + yA) / 2 + 0.6, lv.road, 'road', 'ps-note', 'middle', 0, 14 * fs);
  tx(houseFront - 0.1, lv.floor + 0.55, cmp ? '' : 'house wall', 'ps-note', 'end');
  // the 1.70 m person standing in the road, and a height rule from the road datum
  if (fg) add(figureSvg(px(fg.y), py(lv.road), Sx, Sz, fg.height, cmp ? '1.70 m' : `${f2(fg.height)} m person (ASSUMED)`, fs));
  const rx = yA + 0.35;
  ln(rx, 0, rx, 3.0, 'pf-dim'); for (let z = 0; z <= 3.0001; z += 0.5) ln(rx - 0.07, z, rx + 0.07, z, 'pf-dim');
  for (const z of [0, 1, 2, 3]) if (z <= zMax) tx(rx + 0.12, z, z === 0 ? '0' : `${z} m`, 'ps-note', 'start', 0, 3);
  // horizontal frontage dimension chain below the ground
  const zd = zMin + 0.12;
  const chain = [[F.roadEdge.y, F.drain.y1, `drain ${f2(F.drain.y1 - F.drain.y0)}`], [E.y0, MW.y0, `edge + strip ${f2(MW.y0 - E.y0)}`], [MW.y0, MW.y1, `wall ${f2(MW.y1 - MW.y0)}`]];
  for (const [a, b, t] of chain) { ln(a, zd, b, zd, 'pf-dim'); for (const y of [a, b]) ln(y, zd - 0.06, y, zd + 0.06, 'pf-dim'); if (!cmp) tx((a + b) / 2, zd, t, 'pf-dimt', 'middle', 0, -4 * fs); }
  ln(F.roadEdge.y, zd - 0.2, MW.y0, zd - 0.2, 'pf-dim');
  tx((F.roadEdge.y + MW.y0) / 2, zd - 0.2, `frontage depth, road edge → main wall: ${f2(MW.y0 - F.roadEdge.y)} m (V2.3: 2.80 m)`, 'pf-dimt', 'middle', 0, 13 * fs);
  levelTags(add, [[lv.floor, `House floor ${signed(lv.floor)}`, 'ps-lvl-ffl'], [wallTop, `Main wall top ${signed(wallTop)}`, ''], [lv.yard, `Garden = land ${signed(lv.yard)}`, ''], [lv.edgeCap, `Top of capping ${signed(lv.edgeCap)}`, ''],
    [lv.strip, `Planting soil ${signed(lv.strip)}`, ''], [lv.toe, `Toe / drain-side ground ${signed(lv.toe)}`, ''], [lv.road, 'Road ±0.00 (datum)', '']], py, px(yB) + 6 * fs, fs);
  return { svg: out.join(''), w: width, h };
}

export function frontageSectionPanel(plan, land, width = 440) {
  const E = plan.frontage.retainingEdge, lv = levels(plan, land);
  const sec = frontageSectionSvg(plan, land, { width, vx: 1.6, compact: true, fontScale: 0.8, padR: 150, padTop: 10, yStart: plan.frontage.roadEdge.y - 2.6, yEnd: 4.6 });
  return `
    <div class="profile-head"><b>Frontage section</b> · cut across the road, drain, retaining edge, strip, main wall and garden · vertical ×1.6 · ASSUMED geometry · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${width} ${sec.h}" role="img" aria-label="Section across the frontage with the retaining face and separate levels"><style>${SECTION_STYLE}${V24_STYLE}</style>${sec.svg}</svg>
    <div class="profile-foot">Visible face ${f2(E.visibleFace)} m = OWNER-ESTIMATED — TO BE VERIFIED. Toe ${signed(lv.toe)}, capping ${signed(lv.edgeCap)}, soil ${signed(lv.strip)}, garden ${signed(lv.yard)}, floor ${signed(lv.floor)} are separate levels. Conceptual appearance only: no wall structure, foundation or drainage is specified.</div>`;
}

export function frontageSectionSheet(plan) {
  const L = plan.levels.land, lands = [L.min, L.default, L.max], W = 1700, E = plan.frontage.retainingEdge;
  const parts = lands.map(l => ({ land: l, lv: levels(plan, l), sec: frontageSectionSvg(plan, l, { width: W - 80, vx: 1 }) }));
  const out = [];
  let y = 120;
  for (const p of parts) {
    out.push(`<text x="40" y="${y}" class="ps-t ps-head">Land ${signed(p.land)} m — toe ${signed(p.lv.toe)} · capping ${signed(p.lv.edgeCap)} · planting soil ${signed(p.lv.strip)} · main wall top ${signed(p.lv.yard + plan.frontage.mainWall.topAboveGarden)} · garden ${signed(p.lv.yard)} · house floor ${signed(p.lv.floor)} · wall retains ${f2(p.lv.yard - p.lv.strip)} m above the soil</text>`);
    out.push(`<g transform="translate(40 ${y + 6})">${p.sec.svg}</g>`);
    y += p.sec.h + 40;
  }
  const notes = [
    `One structured source: data/plans/${plan.id}.json → levels() in src/geometry-v2.js, the same function the plan, the 3D viewer and tools/check-v2.mjs use. True scale (no vertical exaggeration); section cut across the road at x = 12.0 m.`,
    `The approximately 1 m is the VISIBLE retaining-face height (CONFIRMED owner clarification 2026-10-22): ${f2(E.visibleFace)} m of exposed vertical face from the adjoining drain-side ground at its toe to the top of the capping. It is OWNER-ESTIMATED — TO BE VERIFIED. The planting soil surface (${f2(E.soilBelowCap)} m below the capping) is a separate level and is not equated with the capping.`,
    'The broad verge band is removed: road → open drain → raised retaining edge / planting strip → main wall → higher garden. The planting edge meets the rear side of the drain. The frontage is 1.00 m shallower than in V2.3 (road edge and drain moved toward the site; nothing from the strip inward moved). Ownership of the retaining edge, strip, apron and landing is still UNKNOWN (may be road reserve).',
    'The 1.70 m person (ASSUMED average adult height) stands in the road and a 0–3 m rule starts at the road datum so heights can be judged by eye. Conceptual appearance only: no wall structure, foundation, reinforcement or drainage detail is specified; the drain is shown open and unaltered.',
  ];
  return sheetShell(plan, `${plan.revision} — Frontage section · road → open drain → retaining edge (visible face) → planting strip → main wall → garden`, 'Drawn from the same dataset as the plan and the 3D viewer at the bottom, default and top of the OWNER-ESTIMATED land range. Every dimension ASSUMED except that range and the owner-estimated ≈1 m visible face (TO BE VERIFIED).', out, y, notes, W, 'frontage section');
}

// Shared sheet frame: title, banner, notes.
function sheetShell(plan, title, sub, out, y, notes, W, what) {
  out.push(`<text x="40" y="${y}" class="ps-t ps-head">Notes</text>`);
  y += 16;
  for (const n of notes) {
    const words = n.split(' '); let line = '';
    for (const wd of words) { if ((line + ' ' + wd).length > 220) { out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 14; line = wd; } else line = line ? `${line} ${wd}` : wd; }
    out.push(`<text x="40" y="${y}" class="ps-t ps-note">${esc(line)}</text>`); y += 18;
  }
  const H = y + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>${esc(plan.revision)} — ${esc(what)} — PRELIMINARY CONCEPT — PROVISIONAL DIMENSIONS — NOT SURVEYED — NOT FOR CONSTRUCTION</title>
<style>${SECTION_STYLE}${DRIVE_STYLE}${V24_STYLE}</style>
<rect width="100%" height="100%" fill="#fbfaf6"/>
<rect x="0" y="0" width="${W}" height="34" fill="#8a2b1c"/>
<text x="${W / 2}" y="22" class="ps-t" style="fill:#fff;font-size:14px;font-weight:700;letter-spacing:.03em" text-anchor="middle">PRELIMINARY CONCEPT — PROVISIONAL DIMENSIONS — NOT SURVEYED — NOT FOR CONSTRUCTION</text>
<text x="40" y="64" class="ps-t" style="font-size:20px;font-weight:700">${esc(title)}</text>
<text x="40" y="84" class="ps-t ps-note" style="font-size:12px">${esc(sub)} Generated by tools/render-v2-plan.mjs · ${plan.sheet?.date ?? (isV25(plan) ? '2026-10-23' : '2026-10-22')}</text>
${out.join('\n')}
</svg>
`;
}

// ---------- carport A / B comparison along the driveway centreline ----------
export function carportSectionSvg(plan, land, o = {}) {
  const A = withCarportOption(plan, 'A'), B = withCarportOption(plan, 'B'), lvA = levels(A, land), lvB = levels(B, land), lv = levels(plan, land);
  const F = plan.frontage, S = plan.site, cp = plan.carport, g = plan.gate, env = plan.parameters.vehicleEnvelope, car = plan.furniture.find(q => q.type === 'vehicle'), fg = figureOf(plan);
  const gs = gateStudy(plan, land), geo = gs.geo, w = gs.waiting, R = ramp(plan), roof = carportRoof(plan, land), cmpL = carportComparison(plan, land), sA = cmpL.find(c => c.option === 'A'), sB = cmpL.find(c => c.option === 'B');
  const cmp = o.compact === true, fs = o.fontScale ?? 1, VX = o.vx ?? 1;
  const yA = o.yStart ?? Math.min(S.road.y0 + 4.0, w.y0 - 0.45), yB = o.yEnd ?? cp.y1 + 0.6;
  const zMin = -(F.drain.depth + 0.28), zMax = roof.top + 0.35;
  const padL = 8 * fs, padR = (o.padR ?? 205) * fs, padT = (o.padTop ?? 18) * fs, padB = 46 * fs, width = o.width ?? 1700;
  const Sx = (width - padL - padR) / (yB - yA), Sz = Sx * VX, h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = y => padL + (y - yA) * Sx, py = z => padT + (zMax - z) * Sz;
  const P = pts => pts.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join(' ');
  const out = [], add = v => out.push(v);
  const rc = (ya, yb, za, zb, cls) => add(`<rect x="${px(ya).toFixed(1)}" y="${py(zb).toFixed(1)}" width="${((yb - ya) * Sx).toFixed(1)}" height="${((zb - za) * Sz).toFixed(1)}" class="${cls}"/>`);
  const ln = (ya, za, yb, zb, cls) => add(`<line x1="${px(ya).toFixed(1)}" y1="${py(za).toFixed(1)}" x2="${px(yb).toFixed(1)}" y2="${py(zb).toFixed(1)}" class="${cls}"/>`);
  const tx = (y, z, t, cls = 'ps-note', anchor = 'start', dx = 0, dy = 0) => add(`<text x="${(px(y) + dx).toFixed(1)}" y="${(py(z) + dy).toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}" style="font-size:${(10 * fs).toFixed(1)}px">${esc(t)}</text>`);
  const profA = rampProfile(A, land, 90), profB = rampProfile(B, land, 90);
  const surfOf = (lvX, prof) => [[yA, lv.road], [F.roadEdge.y, lv.road], [F.roadEdge.y, lv.apron], [R.y0, lv.apron], ...prof.slice(1), [cp.y1, lvX.carport], [yB, lvX.carport]];
  const sa = surfOf(lvA, profA), sb = surfOf(lvB, profB);
  add(`<polygon points="${P([...sa, [yB, zMin], [yA, zMin]])}" class="pf-Af"/>`);
  add(`<polygon points="${P([...sb, [yB, zMin], [yA, zMin]])}" class="ps-ground" style="fill-opacity:.9"/>`);
  rc(F.drain.y0, F.drain.y1, -F.drain.depth, lv.road, 'ps-drain');
  rc(F.drain.y0, F.drain.y1, lv.apron - (plan.driveway.crossingThickness ?? 0.1), lv.apron, 'ps-slab');
  // context beside the centreline: retaining edge / strip, main wall, garden, house floor
  const E = F.retainingEdge, MW = F.mainWall, wallTop = lv.yard + MW.topAboveGarden;
  add(`<polyline points="${P([[E.y0, lv.toe], [E.y0, lv.edgeCap], [E.y0 + E.thickness, lv.edgeCap], [E.y0 + E.thickness, lv.strip], [MW.y0, lv.strip]])}" class="ps-ctx"/>`);
  rc(MW.y0, MW.y1, lv.strip, wallTop, 'ps-wallctx');
  add(`<polyline points="${P([[MW.y1, lv.yard], [cp.y0 - 0.2, lv.yard]])}" class="ps-ctx"/>`);
  const houseRear = Math.max(...plan.rooms.filter(isEnclosed).flatMap(roomCells).map(c => c.y1));
  add(`<polyline points="${P([[cp.y0, lv.floor], [Math.min(yB, houseRear), lv.floor]])}" class="ps-ffl"/>`);
  // canopy (roof level retained), rear wall, columns, parked cars on each floor
  rc(cp.y0 - cp.roofFrontOverhang, cp.y1, roof.underside, roof.top, 'pd-roof');
  rc(cp.y1 - 0.115, cp.y1 + 0.115, Math.min(lvA.carport, lvB.carport), roof.underside, 'pd-wall');
  for (const c of cp.columns ?? []) rc(c.y0, c.y1, Math.min(lvA.carport, lvB.carport), roof.underside, 'pd-col');
  if (car) { rc(car.y0, car.y1, lvA.carport, lvA.carport + env.height, 'pf-Ad'); rc(car.y0, car.y1, lvB.carport, lvB.carport + env.height, 'pf-Bd'); }
  // gate, waiting car and the road encroachment
  rc(g.pierLeft.y0, g.pierLeft.y1, geo.base, geo.pierTop, 'pd-pier');
  rc(g.y - geo.leafThickness / 2, g.y + geo.leafThickness / 2, geo.bottom, geo.top, 'pd-leaf');
  rc(w.y0, w.y1, w.base, w.top, 'pd-wait');
  const zb = lv.road - 0.1;
  if (w.encroach > 0) rc(w.y0, F.roadEdge.y, zb - 0.07, zb + 0.07, 'pd-enc');
  rc(Math.max(w.y0, F.roadEdge.y), w.y1, zb - 0.07, zb + 0.07, 'pd-off');
  // the two driveway surfaces
  add(`<polyline points="${P(sa.slice(2))}" class="pf-A"/><polyline points="${P(sb.slice(2))}" class="pf-B"/>`);
  add(`<polyline points="${P(sa.slice(0, 2))}" class="ps-road"/>`);
  if (fg) add(figureSvg(px(fg.y), py(lv.road), Sx, Sz, fg.height, cmp ? '' : '1.70 m', fs));
  // headroom arrows (canopy roof level retained)
  const hy = cp.y0 + 4.9;
  for (const [c, cls, dy] of [[lvA, 'pf-Ad', 0.0], [lvB, 'pf-Bd', 0.5]]) { ln(hy + dy, c.carport, hy + dy, roof.underside, cls); for (const z of [c.carport, roof.underside]) ln(hy + dy - 0.08, z, hy + dy + 0.08, z, cls); }
  tx(hy - 0.15, (lvA.carport + roof.underside) / 2, cmp ? `${f2(sA.headroom)}` : `A headroom ${f2(sA.headroom)} m`, 'pf-At', 'end');
  tx(hy + 0.65, (lvB.carport + roof.underside) / 2, cmp ? `${f2(sB.headroom)}` : `B headroom ${f2(sB.headroom)} m`, 'pf-Bt', 'start');
  // gradient labels
  const mA = profA[Math.floor(profA.length * 0.62)], mB = profB[Math.floor(profB.length * 0.4)];
  tx(mA[0], mA[1] + 0.12, cmp ? `A ${sA.averageGradientPct.toFixed(0)}% / ${sA.maxLocalGradientPct.toFixed(0)}%` : `A · rise ${f2(sA.rise)} m / run ${f2(sA.run)} m · ${sA.averageGradientPct.toFixed(1)}% avg / ${sA.maxLocalGradientPct.toFixed(1)}% steepest`, 'pf-At', 'end', -6, -6 * fs);
  tx(mB[0], mB[1] - 0.05, cmp ? `B ${sB.averageGradientPct.toFixed(0)}% / ${sB.maxLocalGradientPct.toFixed(0)}%` : `B · rise ${f2(sB.rise)} m / run ${f2(sB.run)} m · ${sB.averageGradientPct.toFixed(1)}% avg / ${sB.maxLocalGradientPct.toFixed(1)}% steepest`, 'pf-Bt', 'start', 6, 14 * fs);
  if (!cmp) {
    tx(cp.y0 + 0.2, lvA.carport + 0.12, `A carport ${signed(lvA.carport)}`, 'pf-At', 'start', 0, -2);
    tx(cp.y0 + 0.2, lvB.carport - 0.28, `B carport ${signed(lvB.carport)}`, 'pf-Bt', 'start');
    tx(w.y1 - 0.05, w.top + 0.1, 'waiting car (ASSUMED)', 'ps-warn', 'end', 0, -3 * fs);
    tx((w.y0 + F.roadEdge.y) / 2, zb, `${f2(w.encroach)} m into the carriageway`, 'ps-warn', 'middle', 0, 18 * fs);
    tx(g.y - 0.12, geo.top + 0.3, `gate · base ${signed(geo.base)}`, 'ps-note', 'end');
    tx(houseRear - 0.4, lv.floor + 0.15, 'house floor', 'ps-note', 'end');
    tx(cp.y1 - 3.3, roof.top + 0.12, 'canopy roof level retained (own columns, beside)', 'ps-note', 'middle');
    tx(MW.y1 + 0.3, lv.yard, `garden ${signed(lv.yard)} (beside)`, 'ps-note', 'start', 0, -4 * fs);
  }
  const ay = py(zMin) + 4 * fs;
  for (let y = Math.ceil(yA / 2) * 2; y <= yB; y += 2) { add(`<line x1="${px(y).toFixed(1)}" y1="${ay.toFixed(1)}" x2="${px(y).toFixed(1)}" y2="${(ay + 5 * fs).toFixed(1)}" class="ps-tick"/><text x="${px(y).toFixed(1)}" y="${(ay + 15 * fs).toFixed(1)}" class="ps-t ps-comp" text-anchor="middle">${y}</text>`); }
  if (!cmp) add(`<text x="${px(yA) + 2}" y="${(ay + 28 * fs).toFixed(1)}" class="ps-t ps-note">metres from the symbolic frontage line (y = 0): road (left) → carport rear (right); section along the driveway centreline · brown = A (V2.3 level) · blue = B (lower carport)</text>`);
  levelTags(add, [[lv.floor, `House floor ${signed(lv.floor)}`, 'ps-lvl-ffl'], [lvA.carport, `A carport ${signed(lvA.carport)}`, ''], [lv.yard, `Garden ${signed(lv.yard)}`, ''], [lvB.carport, `B carport ${signed(lvB.carport)}`, ''],
    [geo.base, `Apron = gate base ${signed(geo.base)}`, ''], [lv.road, 'Road ±0.00 (datum)', '']], py, px(yB) + 6 * fs, fs);
  return { svg: out.join(''), w: width, h };
}

export function carportSectionPanel(plan, land, width = 440) {
  const cmpL = carportComparison(plan, land), sA = cmpL.find(c => c.option === 'A'), sB = cmpL.find(c => c.option === 'B');
  const sec = carportSectionSvg(plan, land, { width, vx: 2, fontScale: 0.8, padR: 118, padTop: 12, yStart: plan.frontage.roadEdge.y - 2.0, yEnd: plan.carport.y0 + 5.2, compact: true });
  return `
    <div class="profile-head"><b>Carport A (V2.3 level) vs B (lower)</b> · driveway centreline · vertical ×2 · ASSUMED geometry · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${width} ${sec.h}" role="img" aria-label="Section along the driveway comparing carport A and B"><style>${SECTION_STYLE}${DRIVE_STYLE}${V24_STYLE}</style>${sec.svg}</svg>
    <div class="profile-foot">A: rise ${f2(sA.rise)} m, ${sA.averageGradientPct.toFixed(1)}% / ${sA.maxLocalGradientPct.toFixed(1)}%, garden ${sA.gardenSteps} riser(s), service ${sA.serviceSteps}. B: rise ${f2(sB.rise)} m, ${sB.averageGradientPct.toFixed(1)}% / ${sB.maxLocalGradientPct.toFixed(1)}%, garden ${sB.gardenSteps}, service ${sB.serviceSteps}. Drawn-shape arithmetic only — clearance, drainage and retaining are NOT established.</div>`;
}

export function carportComparisonSheet(plan) {
  const L = plan.levels.land, lands = [L.min, L.default, L.max], W = 1700;
  const out = [];
  let y = 120;
  for (const l of lands) {
    const [a, b] = carportComparison(plan, l), sec = carportSectionSvg(plan, l, { width: W - 80, vx: 1 });
    const sd = n => `${n >= 0 ? '+' : '−'}${f2(Math.abs(n))}`;
    out.push(`<text x="40" y="${y}" class="ps-t ps-head">Land ${signed(l)} m — A ${signed(a.levels.carport)}: rise ${f2(a.rise)} / run ${f2(a.run)} m, ${a.averageGradientPct.toFixed(1)}% avg / ${a.maxLocalGradientPct.toFixed(1)}% steepest · B ${signed(b.levels.carport)}: rise ${f2(b.rise)} / run ${f2(b.run)} m, ${b.averageGradientPct.toFixed(1)}% / ${b.maxLocalGradientPct.toFixed(1)}%</text>`);
    out.push(`<text x="40" y="${y + 15}" class="ps-t ps-note">carport → garden: A ${sd(a.gardenDiff)} m (${a.gardenSteps} riser ${a.gardenDirection}), B ${sd(b.gardenDiff)} m (${b.gardenSteps} risers ${b.gardenDirection}) · carport → house floor (service door): A +${f2(a.houseDiff)} m (${a.serviceSteps} risers), B +${f2(b.houseDiff)} m (${b.serviceSteps} risers) · headroom under the retained canopy: A ${f2(a.headroom)} m, B ${f2(b.headroom)} m · landing proud of the ramp edge: A ${f2(a.platformProud)} m, B ${f2(b.platformProud)} m</text>`);
    out.push(`<g transform="translate(40 ${y + 22})">${sec.svg}</g>`);
    y += sec.h + 54;
  }
  const notes = [
    `One structured source: data/plans/${plan.id}.json → levels(), rampProfile(), carportStudy() in src/geometry-v2.js, the same functions the plan, the 3D viewer and tools/check-v2.mjs use. True scale (no vertical exaggeration). Brown = A (the V2.3 carport level, land + 0.10 m); blue = B (lower candidate, +${f2(plan.levels.carportFloor.options.find(q => q.id === 'B').offset)} m above the road datum, ASSUMED and adjustable).`,
    'The driveway run (9.00 m, y 1.00 to 10.00), its transitions and the gate on the front-wall line are identical in both alternatives; only the carport floor, and therefore the rise and the gradients, differ. The canopy roof level is retained (underside land + 2.80 m), so headroom grows in B. The gate base is the level apron (+0.10) in both.',
    'Frontage: the verge is removed, so the road edge is 1.80 m from the main wall and a waiting car projects about 2.9 m into the carriageway in both alternatives (flagged, not resolved). The 1.70 m person (ASSUMED) stands in the road for scale.',
    'Not designed or checked: vehicle clearance (bumper, breakover, approach / departure), drainage and flooding of the lowered pad, excavation, retaining against the raised garden, gate operation, the real ground levels and the ownership of the frontage. Provisional geometry comparison only.',
  ];
  return sheetShell(plan, `${plan.revision} — Driveway / carport section comparing the V2.3 carport level (A) and the lower carport (B)`, 'Drawn from the same dataset as the plan and the 3D viewer at the bottom, default and top of the OWNER-ESTIMATED land range. All dimensions PROVISIONAL (ASSUMED) except that range.', out, y, notes, W, 'carport comparison section');
}

// ---------- carport walking route, unfolded: parked car → strip → landing → steps → garden path → west porch steps → porch → entrance ----------
export function carportWalkSvg(plan, land, o = {}) {
  const q = o.option ? withCarportOption(plan, o.option) : plan, cr = carportRoute(q, land), lv = cr.levels, cs = carportStudy(q, land), fg = figureOf(plan), sv = cr.service;
  const cmp = o.compact === true, fs = o.fontScale ?? 1, VX = o.vx ?? 1, S = o.scale ?? 90, id = activeCarportOption(q).id;
  const yc = (cr.flight.rect.y0 + cr.flight.rect.y1) / 2, sx0 = (cr.strip.rect.x0 + cr.strip.rect.x1) / 2, doorMid = (cr.entrance.lo + cr.entrance.hi) / 2;
  // unfolded axis s (metres): strip (from 1.6 m behind the car nose) → landing (north, then east) → flight → upper landing → path → west steps → porch landing → door
  const segs = []; let s = 0;
  const put = (idd, label, len) => { segs.push({ id: idd, label, s0: s, s1: s + len }); s += len; };
  const stripLen = 1.6, landLen = (cr.platform.rects[0].y1 - yc) + (cr.flight.rect.x0 - sx0);
  put('strip', cmp ? 'strip' : 'walking strip', stripLen);
  put('landing', cmp ? 'landing' : 'level landing', landLen);
  put('flight', cmp ? `${cr.flight.risers}R` : `garden steps ${cr.flight.risers}R ${cr.flight.direction}`, cr.flight.rect.x1 - cr.flight.rect.x0);
  put('upper', cmp ? 'landing' : 'upper landing', cr.upper.rect.x1 - cr.upper.rect.x0);
  put('path', cmp ? 'path' : `garden path ${f2(cr.path.length)} m`, Math.max(cr.path.length, 0));
  put('west', cmp ? `${cr.westSteps.risers}R` : `west porch steps ${cr.westSteps.risers}R`, cr.westSteps.rect.x1 - cr.westSteps.rect.x0);
  put('porch', cmp ? 'porch' : 'porch landing', (doorMid - cr.westLanding.rect.x0) + (cr.entrance.y - yc));
  const sEnd = s, at = idd => segs.find(z => z.id === idd);
  const lead = 3.1;   // the parked car (4.5 m) behind the start of the route
  const zMin = Math.min(lv.carport, 0) - 0.55, zMax = lv.floor + 2.3;
  const serviceLen = (sv.landing.rect.y1 - sv.landing.rect.y0) + (sv.flight.rect.y1 - sv.flight.rect.y0) + 1.2, gapSv = 1.4;
  const padL = 8 * fs, padR = (o.padR ?? 150) * fs, padT = (o.padTop ?? 20) * fs, padB = 38 * fs;
  const totalM = lead + sEnd + 0.9 + (o.withService === false ? 0 : gapSv + serviceLen + 0.6);
  const width = o.width ?? Math.round(padL + totalM * S + padR), Sx = o.width ? (o.width - padL - padR) / totalM : S, Sz = Sx * VX;
  const h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = v => padL + (v + lead) * Sx, py = z => padT + (zMax - z) * Sz;
  const P = pts => pts.map(([a, b]) => `${px(a).toFixed(1)},${py(b).toFixed(1)}`).join(' ');
  const out = [], add = v => out.push(v);
  const rc = (a, b, za, zb, cls) => add(`<rect x="${px(a).toFixed(1)}" y="${py(zb).toFixed(1)}" width="${((b - a) * Sx).toFixed(1)}" height="${((zb - za) * Sz).toFixed(1)}" class="${cls}"/>`);
  const ln = (a, za, b, zb, cls) => add(`<line x1="${px(a).toFixed(1)}" y1="${py(za).toFixed(1)}" x2="${px(b).toFixed(1)}" y2="${py(zb).toFixed(1)}" class="${cls}"/>`);
  const tx = (v, z, t, cls = 'ps-note', anchor = 'start', dx = 0, dy = 0) => add(`<text x="${(px(v) + dx).toFixed(1)}" y="${(py(z) + dy).toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}" style="font-size:${(10 * fs).toFixed(1)}px">${esc(t)}</text>`);
  const stairs = (pts, s0, from, n, riser, going) => { let ss = s0; for (let k = 1; k <= n; k++) { pts.push([ss, from + (k - 1) * riser], [ss, from + k * riser]); if (k < n) ss += going; } };
  // surface: carport floor under the car and strip, landing (level), steps, garden, west steps, porch floor
  const pts = [[-lead, lv.carport], [at('landing').s1, lv.carport]];
  stairs(pts, at('flight').s0, cr.flight.from, cr.flight.risers, cr.flight.riser, cr.flight.going);
  pts.push([at('path').s1, lv.yard]);
  stairs(pts, at('west').s0, cr.westSteps.from, cr.westSteps.risers, cr.westSteps.riser, cr.westSteps.going);
  pts.push([sEnd, lv.floor], [sEnd + 0.9, lv.floor]);
  add(`<polygon points="${P([...pts, [sEnd + 0.9, zMin], [-lead, zMin]])}" class="ps-ground"/>`);
  // the ramp edge beside the landing (the landing stands proud of it) and the parked car beside the strip
  const rampEdge = [at('landing').s0 + 0.0, lv.carport - cr.platform.proud];
  ln(at('landing').s0, lv.carport - cr.platform.proud, at('landing').s0 + 0.55, lv.carport - cr.platform.proud * 0.5, 'pf-lvl');
  tx(at('landing').s0 + 0.55, lv.carport - cr.platform.proud - 0.22, cmp ? '' : `ramp edge ${f2(cr.platform.proud)} m below the landing`, 'ps-note', 'start', 2, 0);
  rc(-lead, at('strip').s1 - 0.4, lv.carport, lv.carport + plan.parameters.vehicleEnvelope.height, id === 'A' ? 'pf-Ad' : 'pf-Bd');
  tx(-lead + 0.1, lv.carport + plan.parameters.vehicleEnvelope.height - 0.12, cmp ? 'car' : 'parked car, beside the strip (ASSUMED 1.65 m)', 'ps-note', 'start');
  rc(at('strip').s0, at('strip').s1, lv.carport, lv.carport + 0.05, 'pf-zone');
  tx(at('strip').s0 + 0.05, lv.carport + 0.15, cmp ? '' : 'passenger door zone = strip', 'ps-warn', 'start', 0, -2);
  // garden and house context (dashed), entrance door, main route line
  ln(at('flight').s0, lv.yard, at('flight').s1, lv.yard, 'ps-ctx');
  add(`<line x1="${px(at('west').s0).toFixed(1)}" y1="${py(lv.floor).toFixed(1)}" x2="${px(at('west').s1).toFixed(1)}" y2="${py(lv.floor).toFixed(1)}" class="ps-ffl"/>`);
  add(`<polyline points="${P(pts)}" class="ps-surface"/>`);
  const door = plan.openings.find(z => z.id === cr.entrance.door);
  add(`<rect x="${(px(sEnd) - 2.5 * fs).toFixed(1)}" y="${py(lv.floor + door.head).toFixed(1)}" width="${(5 * fs).toFixed(1)}" height="${(door.head * Sz).toFixed(1)}" class="ps-door"/>`);
  tx(sEnd + 0.08, lv.floor + door.head - 0.1, 'entrance', 'ps-note');
  // person for scale on the strip
  if (fg) add(figureSvg(px(at('strip').s0 + 0.55), py(lv.carport), Sx, Sz, fg.height, cmp ? '' : '1.70 m', fs));
  // component ticks (two staggered rows) and the step annotations
  const baseY = py(zMin) + 2;
  segs.forEach((z, i) => { add(`<line x1="${px(z.s0).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${px(z.s0).toFixed(1)}" y2="${(baseY + 6 * fs).toFixed(1)}" class="ps-tick"/>`); tx((z.s0 + z.s1) / 2, zMin - (i % 2 ? 0.28 : 0.1), z.label, 'ps-comp', 'middle', 0, (cmp ? 12 : 4) * fs); });
  add(`<line x1="${px(sEnd).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${px(sEnd).toFixed(1)}" y2="${(baseY + 6 * fs).toFixed(1)}" class="ps-tick"/>`);
  if (!cmp) {
    const fl = at('flight');
    tx((fl.s0 + fl.s1) / 2, lv.yard + 0.35, `${cr.flight.risers} × ${(Math.abs(cr.flight.riser) * 1000).toFixed(0)} mm, going ${(cr.flight.going * 1000).toFixed(0)}`, 'ps-note', 'middle');
    tx(at('west').s0, lv.floor + 0.25, `${cr.westSteps.risers} × ${(cr.westSteps.riser * 1000).toFixed(0)} mm`, 'ps-note', 'middle', 0, -2);
    tx(at('landing').s0 + 0.1, lv.carport - 0.12, `landing = carport ${signed(lv.carport)}`, 'ps-note', 'start');
  }
  // utility service doorway: car side → steps along the left wall → landing → door (separate unfolded run on the right)
  if (o.withService !== false) {
    const t0 = sEnd + 0.9 + gapSv, n = sv.flight.risers, gg = sv.flight.going, flen = (n - 1) * gg, lan = sv.landing.rect.y1 - sv.landing.rect.y0;
    const sp = [[t0, lv.carport]];
    stairs(sp, t0 + 0.6, lv.carport, n, sv.flight.riser, gg);
    const lEnd = t0 + 0.6 + flen + lan;
    sp.push([lEnd, lv.floor]);
    add(`<polygon points="${P([...sp, [lEnd + 0.4, lv.floor], [lEnd + 0.4, zMin], [t0, zMin]])}" class="ps-ground"/>`);
    add(`<polyline points="${P([...sp, [lEnd + 0.4, lv.floor]])}" class="ps-surface"/>`);
    add(`<line x1="${px(t0 + 0.6).toFixed(1)}" y1="${py(lv.floor).toFixed(1)}" x2="${px(lEnd + 0.4).toFixed(1)}" y2="${py(lv.floor).toFixed(1)}" class="ps-ffl"/>`);
    add(`<rect x="${(px(lEnd) - 2.5 * fs).toFixed(1)}" y="${py(lv.floor + 2.1).toFixed(1)}" width="${(5 * fs).toFixed(1)}" height="${(2.1 * Sz).toFixed(1)}" class="ps-door"/>`);
    const zoneS0 = t0 + 0.6 - (cr.service.flight.rect.y0 > 0 ? Math.max(0, cr.service.flight.rect.y0 - cr.doorLeft.y1) : 0);
    tx(t0, lv.floor + 0.55, cmp ? 'service' : `utility service doorway · ${n} × ${(sv.flight.riser * 1000).toFixed(0)} mm`, 'ps-head', 'start');
    tx(lEnd - 0.2, lv.floor + 2.25, cmp ? '' : 'service door', 'ps-note', 'end');
    tx((t0 + 0.6 + t0 + 0.6 + flen) / 2, lv.carport + 0.25, cmp ? '' : 'steps beside the car', 'ps-note', 'middle');
    tx((t0 + 0.6 + flen + lEnd) / 2, lv.floor + 0.18, cmp ? '' : `landing ${signed(lv.floor)}`, 'ps-note', 'middle');
    if (cs.conflicts.some(c => c.id === 'carport:service-stair-door-zone') && !cmp) tx(t0, lv.carport - 0.2, '⚠ intrudes into the driver-side door zone', 'ps-warn', 'start');
  }
  levelTags(add, [[lv.floor, `Floor / porch ${signed(lv.floor)}`, 'ps-lvl-ffl'], [lv.yard, `Garden / path ${signed(lv.yard)}`, ''], [lv.carport, `Carport ${id} ${signed(lv.carport)}`, '']], py, px(sEnd + 0.9 + (o.withService === false ? 0 : gapSv + serviceLen + 0.6)) + 6 * fs, fs);
  return { svg: out.join(''), w: width, h, cs };
}

export function carportWalkPanel(plan, land, width = 440) {
  const id = activeCarportOption(plan).id, cs = carportStudy(plan, land), cr = cs.route;
  const sec = carportWalkSvg(plan, land, { width, vx: 2, fontScale: 0.8, padR: 105, padTop: 10, compact: true });
  return `
    <div class="profile-head"><b>Carport walking route, option ${esc(id)}</b> · unfolded: car → strip → landing → steps → path → west porch steps → entrance (left) · utility service doorway (right) · vertical ×2 · ASSUMED geometry · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${width} ${sec.h}" role="img" aria-label="Section along the carport walking route"><style>${SECTION_STYLE}${DRIVE_STYLE}${V24_STYLE}</style>${sec.svg}</svg>
    <div class="profile-foot">${cr.flight.risers} ${cr.flight.direction === 'up' ? 'risers up' : 'riser down'} to the garden, ${cr.westSteps.risers} porch risers, ${cr.service.flight.risers} service risers here. The external route is STEPPED, not step-free. Flagged: ${esc(cs.conflicts.map(c => c.id.replace('carport:', '')).join(', ') || 'none')}.</div>`;
}

export function carportWalkSheet(plan) {
  const L = plan.levels.land, lands = [L.min, L.default, L.max], W = 1700, out = [];
  let y = 120;
  for (const l of lands) for (const id of ['A', 'B']) {
    const sec = carportWalkSvg(plan, l, { option: id, width: W - 80, vx: 1 }), cs = sec.cs, cr = cs.route;
    out.push(`<text x="40" y="${y}" class="ps-t ps-head">Land ${signed(l)} m · carport ${id} ${signed(cs.levels.carport)} — garden steps ${cr.flight.risers} × ${(Math.abs(cr.flight.riser) * 1000).toFixed(0)} mm ${cr.flight.direction} (${(cs.gardenDiff >= 0 ? '+' : '−') + f2(Math.abs(cs.gardenDiff))} m) · west porch steps ${cr.westSteps.risers} · garden path ${f2(cr.path.length)} m · utility service steps ${cr.service.flight.risers} × ${(cr.service.flight.riser * 1000).toFixed(0)} mm (${f2(cs.houseDiff)} m) · landing proud of the ramp edge ${f2(cr.platform.proud)} m</text>`);
    out.push(`<text x="40" y="${y + 14}" class="ps-t ps-note">findings (flagged): ${esc(cs.conflicts.map(c => c.id.replace('carport:', '')).join(', '))}</text>`);
    out.push(`<g transform="translate(40 ${y + 18})">${sec.svg}</g>`);
    y += sec.h + 44;
  }
  const notes = [
    `One structured source: data/plans/${plan.id}.json → carportRoute() and carportStudy() in src/geometry-v2.js, the same functions the plan, the 3D viewer and tools/check-v2.mjs use. True scale (no vertical exaggeration); the route is unfolded along its centreline. The 1.70 m person (ASSUMED) stands on the walking strip.`,
    'The step counts are DERIVED from the level differences (risers of at most 170 mm), never typed in: the garden steps join the carport level to the garden (one riser down in A, 2 to 5 risers up in B across the land range); the west porch steps use the same rule as the front porch steps; the utility service stair joins the carport floor to the utility floor. Counts change at the land levels listed in the register and the checks run just below and above each.',
    'The external route is STEPPED and is NOT step-free (the indoor route to both bathrooms stays level). The walking strip beside the car is also the passenger door-opening space; the level landing stands proud of the sloping ramp edge and occupies the right edge of the driveway at its top; in B the service stair can intrude into the driver-side door zone. All are flagged, none resolved.',
    'Not designed or checked: handrails, lighting, drainage of the lowered carport and its steps, a pedestrian gate, stair compliance and accessibility, excavation and retaining. Geometric consistency only.',
  ];
  return sheetShell(plan, `${plan.revision} — Carport-to-garden / house walking route and the utility service doorway, carport A and B`, 'Drawn from the same dataset as the plan and the 3D viewer at the bottom, default and top of the OWNER-ESTIMATED land range for both carport alternatives. All dimensions PROVISIONAL (ASSUMED) except that range.', out, y, notes, W, 'carport walking-route section');
}

// ---------- V2.5: section through the utility-room stair (looking north, x along the room) ----------
// Both flights are drawn in one cut: the lower flight against the rear wall (solid, rising west) and the upper flight
// against the front wall (suspended, rising east, with its soffit). Levels from stairDesign(), the same data as the plan and the 3D scene.
export const STAIR_STYLE = `
.st-flight{fill:#e4dbec;stroke:#6e5a84;stroke-width:1}.st-upper{fill:#efe7f3;stroke:#6e5a84;stroke-width:1}
.st-door{fill:#9a6b44;fill-opacity:.35;stroke:#3a2a1c;stroke-width:.8}.st-doorb{fill:none;stroke:#3a2a1c;stroke-width:.8;stroke-dasharray:4 3}
`;
export function stairSectionSvg(plan, land, o = {}) {
  const s = stairDesign(plan, land), P = plan.parameters, TT = plan.roof.stairTower, fg = figureOf(plan), fs = o.fontScale ?? 1, sd = plan.stairDesign;
  const F = s.floor, roofTop = F + s.f2f, towerTop = roofTop + TT.height, C = s.clear;
  const xA = -0.6, xB = 5.6, zMin = F - 1.0, zMax = towerTop + 0.6, width = o.width ?? 1500, padL = 40 * fs, padR = 220 * fs, padT = 20 * fs, padB = 50 * fs;
  const Sx = (width - padL - padR) / (xB - xA), Sz = Sx, h = Math.round(padT + (zMax - zMin) * Sz + padB);
  const px = x => padL + (x - xA) * Sx, py = z => padT + (zMax - z) * Sz;
  const out = [], add = v => out.push(v);
  const rc = (x0, x1, z0, z1, cls) => add(`<rect x="${px(x0).toFixed(1)}" y="${py(z1).toFixed(1)}" width="${((x1 - x0) * Sx).toFixed(1)}" height="${((z1 - z0) * Sz).toFixed(1)}" class="${cls}"/>`);
  const ln = (x0, z0, x1, z1, cls) => add(`<line x1="${px(x0).toFixed(1)}" y1="${py(z0).toFixed(1)}" x2="${px(x1).toFixed(1)}" y2="${py(z1).toFixed(1)}" class="${cls}"/>`);
  const tx = (x, z, t, cls = 'ps-note', anchor = 'start', dx = 0, dy = 0) => add(`<text x="${(px(x) + dx).toFixed(1)}" y="${(py(z) + dy).toFixed(1)}" class="ps-t ${cls}" text-anchor="${anchor}" style="font-size:${(10 * fs).toFixed(1)}px">${esc(t)}</text>`);
  // ground, floor slab, cut walls, roof slabs, upper landing and the stair tower
  rc(xA, xB, zMin, F - P.plinthHeight, 'ps-ground');
  rc(xA, xB, F - P.plinthHeight, F, 'pf-wall');
  rc(-0.115, 0.115, F, towerTop, 'pf-wall');
  rc(TT.x1 - 0.23, TT.x1, roofTop + TT.door.height, towerTop, 'pf-wall');
  const wuk = plan.walls.find(w => w.id === 'W-UK'), wukX0 = wuk ? wuk.at - P.interiorWallThickness / 2 : 3.6425, wukX1 = wuk ? wuk.at + P.interiorWallThickness / 2 : 3.7575;
  rc(wukX0, wukX1, F, roofTop - P.roofSlabThickness, 'pf-wall');   // the utility / kitchen wall at its dataset position (V2.7 moves it east)
  rc(3.5, xB, roofTop - P.roofSlabThickness, roofTop, 'pf-wall');
  rc(TT.x0, TT.x1, towerTop - P.roofSlabThickness, towerTop, 'pf-wall');
  rc(s.upperLanding.rect.x0, C.x1, roofTop - P.roofSlabThickness, roofTop, 'st-flight');
  // lower flight (rear wall, solid from the floor) and the half-landing
  const lowerPts = [[s.foot, F]];
  for (const t of s.lower.treads) lowerPts.push([t.rect.x1, t.level], [t.rect.x0, t.level]);
  lowerPts.push([s.landing.rect.x1, s.landing.level], [C.x0, s.landing.level], [C.x0, F]);
  add(`<polygon points="${lowerPts.map(([x, z]) => `${px(x).toFixed(1)},${py(z).toFixed(1)}`).join(' ')}" class="st-flight"/>`);
  // upper flight (front wall, suspended): treads with the stepped soffit
  for (const t of s.upper.treads) rc(t.rect.x0, t.rect.x1, t.level - sd.waist, t.level, 'st-upper');
  // doors: the service door in the front wall (under the upper flight), the back door at the lobby (rear wall, behind the cut)
  const sv = openingGeom(plan, plan.openings.find(q => q.id === sd.doors.service)), bk = openingGeom(plan, plan.openings.find(q => q.id === sd.doors.back));
  rc(sv.lo, sv.hi, F, F + 2.1, 'st-door'); tx((sv.lo + sv.hi) / 2, F + 1.0, 'service door', 'ps-comp', 'middle');
  rc(bk.lo, bk.hi, F, F + 2.1, 'st-doorb'); tx((bk.lo + bk.hi) / 2, F + 2.18, 'back door (rear wall)', 'ps-comp', 'middle');
  tx(TT.x1 + 0.1, roofTop + 1.05, 'tower door → main roof', 'ps-note', 'start');
  // headroom: service-door soffit, over the upper flight under the tower slab, over the lobby under the upper landing
  const sx = sv.lo + 0.05, soff = s.clearAt(sx, C.y0 + 0.05);
  ln(sx, F, sx, F + soff, 'pf-dim'); tx(sx - 0.06, F + soff / 2, `soffit ${f2(soff)} m`, 'pf-dimt', 'end');
  const lastU = s.upper.treads.at(-1), hx = (lastU.rect.x0 + lastU.rect.x1) / 2, ceil = towerTop - P.roofSlabThickness;
  ln(hx, lastU.level, hx, ceil, 'pf-dim'); tx(hx + 0.08, (lastU.level + ceil) / 2, `${f2(ceil - lastU.level)} m headroom`, 'pf-dimt', 'start');
  const lx = s.lobby.x1 - 0.12;
  ln(lx, F, lx, roofTop - P.roofSlabThickness, 'pf-dim'); tx(lx - 0.06, F + 2.75, `${f2(s.f2f - P.roofSlabThickness)} m`, 'pf-dimt', 'end');
  // run dimensions under the floor
  const zd = F - P.plinthHeight - 0.2;
  const chain = [[C.x0, s.landing.rect.x1, `landing ${f2(sd.landingDepth)}`], [s.landing.rect.x1, s.foot, `${s.nLower - 1} × ${(s.going * 1000).toFixed(0)} = ${f2(s.foot - s.landing.rect.x1)}`], [s.foot, C.x1, `lobby ${f2(C.x1 - s.foot)}`]];
  for (const [a, b, t] of chain) { ln(a, zd, b, zd, 'pf-dim'); for (const x of [a, b]) ln(x, zd - 0.06, x, zd + 0.06, 'pf-dim'); tx((a + b) / 2, zd, t, 'pf-dimt', 'middle', 0, 14 * fs); }
  if (wukX0 > C.x1 + 0.1) {   // V2.7: the utility hall continues past the stair-foot lobby to the moved wall; laundry against the rear wall, behind the cut
    ln(C.x1, zd, wukX0, zd, 'pf-dim'); ln(wukX0, zd - 0.06, wukX0, zd + 0.06, 'pf-dim'); tx((C.x1 + wukX0) / 2, zd, `utility hall ${f2(wukX0 - C.x1)} (laundry)`, 'pf-dimt', 'middle', 0, 14 * fs);
    for (const f of plan.furniture.filter(q => q.room === sd.room && ['f-washer', 'f-usink'].includes(q.id))) { rc(f.x0, f.x1, F, F + f.height, 'st-doorb'); tx((f.x0 + f.x1) / 2, F + f.height + (f.id === 'f-usink' ? 0.3 : 0.08), f.label, 'ps-comp', 'middle'); }
  }
  if (fg) add(figureSvg(px(s.foot + 0.3), py(F), Sx, Sz, fg.height, `${f2(fg.height)} m person (ASSUMED)`, fs));
  tx((C.x0 + s.landing.rect.x1) / 2, s.landing.level + 0.12, `half-landing`, 'ps-comp', 'middle');
  tx((s.landing.rect.x1 + s.foot) / 2, F + 0.3, `lower flight ${s.nLower}R (rear wall)`, 'ps-comp', 'middle');
  tx((s.upper.rect.x0 + s.upper.rect.x1) / 2, s.upper.to + 0.12, `upper flight ${s.nUpper}R (front wall)`, 'ps-comp', 'middle');
  levelTags(add, [[towerTop, `Stair tower top ${signed(towerTop)}`, ''], [roofTop, `Roof / upper landing ${signed(roofTop)}`, ''], [s.landing.level, `Half-landing ${signed(s.landing.level)}`, ''], [F, `House floor ${signed(F)}`, 'ps-lvl-ffl'], [F - P.plinthHeight, `Land ${signed(F - P.plinthHeight)}`, '']], py, px(xB) + 8 * fs, fs);
  return { svg: out.join(''), w: width, h };
}

export function stairSectionSheet(plan) {
  const land = plan.levels.land.default, W = 1500, s = stairDesign(plan, land), yd = serviceYard(plan, land);
  const sec = stairSectionSvg(plan, land, { width: W - 80 });
  const out = [`<style>${STAIR_STYLE}</style>`,
    `<text x="40" y="120" class="ps-t ps-head">Land ${signed(land)} m (default) — the stair is measured from the house floor, so its geometry is the same at every land level; only the absolute levels move</text>`,
    `<g transform="translate(40 126)">${sec.svg}</g>`];
  const notes = [
    `One structured source: data/plans/${plan.id}.json → stairDesign() in src/geometry-v2.js, the same function the plan, the 3D viewer and tools/check-v2.mjs use. ${['V2.8','V2.9'].includes(plan.revision) ? 'Metric concept geometry; NOT TO SCALE when displayed or printed. Cut along the utility room (model axes only; compass orientation unknown):' : 'True scale. Cut along the utility room looking north:'} the lower flight runs against the rear wall and the upper flight against the front wall; both are drawn in this one cut.`,
    `Derived: floor-to-floor ${f2(s.f2f)} m (wall height + roof slab) → ${s.n} risers of ${(s.riser * 1000).toFixed(0)} mm (${s.nLower} + ${s.nUpper}), ${(s.going * 1000).toFixed(0)} mm going (owner default 2026-10-23), ${f2(s.width)} m flights, half-landing ${f2(plan.stairDesign.landingDepth)} m (${plan.stairDesign.landingDepth < s.width - 1e-9 ? 'shallower than the flights — flagged' : 'equal to the flight width'}), lobby ${f2(s.lobby.x1 - s.lobby.x0)} m at the stair foot. The service door opens under the upper flight; the back door is at the lobby; a ${f2(plan.roof.stairTower.height)} m stair tower gives headroom over the upper flight and a door onto the main roof.`,
    `Rear service yard (not in this cut): ${yd.n} steps of ${(yd.riser * 1000).toFixed(0)} mm from the back-door landing (${f2(yd.depth)} m deep — flagged) down to the yard at land level.`,
    'Geometry only. Rise, going, width, headroom, handrails, guarding, the stairwell opening, the half-landing structure, the tower and its waterproofing are TO BE VERIFIED against the applicable Sri Lankan regulations by qualified professionals; no compliance is claimed.',
  ];
  return sheetShell(plan, `${plan.revision} — Stair section · utility room behind the carport → roof and future upper floor`, 'Drawn from the same dataset as the plan and the 3D viewer. All dimensions PROVISIONAL (ASSUMED).', out, 126 + sec.h + 40, notes, W, 'stair section');
}
