// Interactive House Explorer — V2 scene builder (schema house-plan/2).
// main.js loads the dataset and supplies the shared viewer toolkit (materials, box/flat/line helpers,
// labels, local assets); this module turns the dataset into the V2 scene through geometry-v2.js, the
// same module the SVG plan and the checks use. Everything is ASSUMED visualization geometry:
// PRELIMINARY CONCEPT — PROVISIONAL DIMENSIONS — NOT SURVEYED — NOT FOR CONSTRUCTION.

import * as THREE from 'three';
import {
  allBands, areas, accessMetrics, gatePockets, levels, openingGeom, rampHeight, rampProfile, ramp, roomAt, roomCells,
  steps, swingSector, unresolvedIssues, wallPieces, wallsById, wallThickness, wallVertical, DOOR_KINDS, isEnclosed,
  hasRoute, pedRoute, plantings, drainOf, isFrontGate, gateStudy, driveSurface, gardenMetrics, envelopeMetrics,
  isV24, carportRoute, carportRoof, carportStudy, carportComparison, figureOf, flightWallY0, retainingWallPieces, activeCarportOption,
  isV25, stairDesign, serviceYard, isV26, doorParts, usabilityAudit, currentIssueNotes, slidingDoorGeometry,
} from './geometry-v2.js';
import { routeSectionPanel, driveSectionPanel, frontageSectionPanel, carportWalkPanel } from './section-svg.js';
import { hasCarportOptions } from './geometry-v2.js';

const ZONE_COLOURS = {
  social: 0xf1dfb8, private: 0xd9e4f0, wet: 0xc9e3e1, service: 0xead9c9, circulation: 0xecebe5, future: 0xe4d6ec, outdoor: 0xe2ded0,
};
const FURNITURE_COLOURS = {
  bed: 0xe9e1d3, wardrobe: 0x8b6b4a, storage: 0xa88c6a, sofa: 0xd9cfc0, table: 0xb08a5f, chair: 0xb89a73,
  counter: 0xd8d4cc, appliance: 0xc9ced3, fixture: 0xf3f6f8,
};

function pvTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#16264a'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#8fa6cf'; g.lineWidth = 2;
  for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A prism whose top follows f(y) between two x positions, resting on `bottom`. Used for the ramp
// and the profile-following boundary wall; plan y is mapped to scene z by the supplied Z().
function profilePrism(X, Z, x0, x1, samples, bottom, topOf, material) {
  const pos = [], idx = [];
  const n = samples.length;
  for (const [y, z] of samples) {
    const t = topOf(y, z);
    pos.push(X(x0), t, Z(y), X(x1), t, Z(y), X(x0), bottom, Z(y), X(x1), bottom, Z(y));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = 4 * i, b = 4 * (i + 1);
    idx.push(a, b, b + 1, a, b + 1, a + 1);            // top
    idx.push(a, a + 2, b + 2, a, b + 2, b);            // x0 side
    idx.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3); // x1 side
  }
  const e = 4 * (n - 1);
  idx.push(0, 1, 3, 0, 3, 2, e, e + 2, e + 3, e, e + 3, e + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// Edge pieces of a roof slab that are not covered by another slab (so the parapet does not run
// across a join).
function exposedEdges(slab, others) {
  const edges = [];
  const cut = (lo, hi, covers) => covers.reduce((runs, [c0, c1]) => runs.flatMap(([a, b]) => (c1 <= a || c0 >= b ? [[a, b]] : [...(c0 > a ? [[a, c0]] : []), ...(c1 < b ? [[c1, b]] : [])])), [[lo, hi]]);
  for (const [axis, at] of [['h', slab.y0], ['h', slab.y1], ['v', slab.x0], ['v', slab.x1]]) {
    const covers = others.filter(o => (axis === 'h' ? o.y0 < at && o.y1 > at : o.x0 < at && o.x1 > at))
      .map(o => (axis === 'h' ? [o.x0, o.x1] : [o.y0, o.y1]));
    const [lo, hi] = axis === 'h' ? [slab.x0, slab.x1] : [slab.y0, slab.y1];
    for (const [a, b] of cut(lo, hi, covers)) edges.push({ axis, at, a, b });
  }
  return edges;
}

export function buildV2(env) {
  const { plan, land, X, Z, std, M, box, flat, dashed, solidLine, envelopeBox, addLabel, texturedMaterial, placeModel, assets, unitBox, esc, f2, signed, hatch } = env;
  const world = new THREE.Group();
  const reg = { world, heightBound: [], roofObjects: [], railObjects: [], planOnly: [], dimObjects: [], warnings: [] };
  const add = o => { world.add(o); return o; };
  const P = plan.parameters, S = plan.site, D = S.display, drv = plan.driveway, cp = plan.carport, gt = plan.gate, st = plan.steps, fac = plan.facade;
  const lv = levels(plan, land), floor = lv.floor, stp = steps(plan, land), R = ramp(plan), prof = rampProfile(plan, land, 60);
  const am = accessMetrics(plan, land), A = areas(plan), byWall = wallsById(plan);
  const baseOf = b => (b === 'carport' ? lv.carport : floor);
  const V22 = hasRoute(plan);   // V2.2+: separate frontage components and a derived pedestrian route
  const FG = isFrontGate(plan);   // V2.3+: gate on the front-wall line, carport columns, conceptual envelope
  const V24 = isV24(plan);   // V2.4+: no verge, retaining edge, carport options A / B, carport walking route, scale figure
  const V25 = isV25(plan);   // V2.5+: stair in the utility room, stair tower, roof railing, rear service yard
  const V26 = isV26(plan);   // V2.6+: door frames and leaves, working-space and service-route overlays (plan view)
  const roofL = carportRoof(plan, land), cr = V24 ? carportRoute(plan, land) : null;
  const tier = (v21, v22) => (V22 ? v22 : v21);   // V2.2 moves descriptive pills to Detail labels
  const FAR = 30;   // V2.1 only

  // ---- materials owned by this scene
  // The starter-pack paver map is dark brown; tint it toward the pale grey pavers of the references.
  const pavedMat = (w, h, fallback = 0xcfc8b8) => texturedMaterial(assets.paving, w, h, fallback, { color: new THREE.Color(1.75, 1.9, 2.05) });
  const stoneMat = (w, h) => texturedMaterial(assets.stone, w, h, 0xa99a86);
  const woodMat = (w, h) => texturedMaterial(assets.wood, w, h, 0x9a6b44);
  const stuccoMat = (w, h) => texturedMaterial(assets.stucco, w, h, 0xfbfaf6);
  const render = std(0xfbfaf6);
  const warmRender = std(0xefe6d3);
  const coping = std(0xcfc8b8);
  const glass = std(0x9fc3d6, { transparent: true, opacity: 0.42, roughness: 0.15 });
  const frameDark = std(0x2b2f34, { roughness: 0.5 });
  const doorLeafMat = std(0xb98d62, { roughness: 0.55 }), doorFrameMat = std(0xe9e4d8, { roughness: 0.6 });   // V2.6 ordinary doors
  const surround = std(0x4a4e53, { roughness: 0.6 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd98a });
  const lawn = std(0x9fc47b), soil = std(0x6e5a44), trunk = std(0x7a6249);
  const leafA = std(0x4f8a3d), leafB = std(0x6aa24d), flower = std(0xd25b8b), pavingFlat = std(0xcfc8b8);
  const pvMat = new THREE.MeshStandardMaterial({ map: pvTexture(), roughness: 0.35, metalness: 0.2 });
  pvMat.map.repeat.set(4, 1.5);
  const hb = (mat, x0, y0, x1, y1, base, a, b, cast = true) => {
    const m = box(mat, x0, y0, x1, y1, base + a, base + b);
    m.castShadow = m.receiveShadow = cast;
    add(m);
    reg.heightBound.push({ mesh: m, y0: a, y1: b, base });
    return m;
  };
  const roofBox = (mat, x0, y0, x1, y1, z0, z1) => { const m = add(box(mat, x0, y0, x1, y1, z0, z1)); reg.roofObjects.push(m); return m; };

  const capped = (x0, y0, x1, y1, top, base = 0) => {
    add(box(render, x0, y0, x1, y1, base, top));
    add(box(coping, x0 - 0.03, y0 - 0.03, x1 + 0.03, y1 + 0.03, top, top + 0.06));
  };
  if (V22) {
    // ---- V2.2+: display background kept separate from the conceptual site (no extended terrain)
    const F = plan.frontage, BG = S.background.margin, T0 = S.terrain, route = pedRoute(plan, land), lift = 0.012;
    const verge = std(0xc9b48f), stripSoil = std(0x7a6248), kerb = std(0x6f7479), water = std(0x3f6f8c), flowMat = 0xbfe0f0;
    add(flat(M.ground, D.x0 - BG, F.drain.y1, D.x1 + BG, D.y1 + BG, -0.01));
    add(flat(M.ground, D.x0 - BG, D.y0 - BG, D.x1 + BG, F.drain.y0, -0.01));
    add(flat(M.road, D.x0 - BG, S.road.y0, D.x1 + BG, F.roadEdge.y, 0.004));
    const roadMid = (S.road.y0 + S.road.y1) / 2;
    for (let x = D.x0 - BG; x < D.x1 + BG; x += 3) add(flat(M.roadLine, x, roadMid - 0.06, x + 1.6, roadMid + 0.06, 0.006));
    addLabel(`Road ±0.00 · ASSUMED datum`, 'level', st.x0 - 2.2, 0.05, F.roadEdge.y - 1.4, 'core', 2);
    addLabel('Display background at the road datum — neighbouring ground, buildings and boundaries are not modelled', 'site', D.x1 - 1.5, 0.05, 18.0, 'detail', 5);
    // open roadside drain: channel bottom and sides (schematic), flow along the road, kept open under the crossings
    const dd = F.drain.depth;
    add(box(M.drain, D.x0 - BG, F.drain.y0, D.x1 + BG, F.drain.y1, -dd, -dd + 0.02));
    add(flat(water, D.x0 - BG, F.drain.y0 + 0.08, D.x1 + BG, F.drain.y1 - 0.08, -dd + 0.06));
    add(box(kerb, D.x0 - BG, F.drain.y0, D.x1 + BG, F.drain.y0 + 0.08, -dd, 0.03));
    add(box(kerb, D.x0 - BG, F.drain.y1 - 0.08, D.x1 + BG, F.drain.y1, -dd, F.verge ? F.verge.aboveRoad : lv.toe));
    const dm = (F.drain.y0 + F.drain.y1) / 2;
    for (let x = D.x0; x < D.x1; x += 4) {
      const y = -dd + 0.08;
      add(solidLine([[x, y, dm], [x + 1.6, y, dm]], flowMat));
      for (const [a, b] of [[x, x + 0.25], [x + 1.6, x + 1.35]]) for (const s of [-1, 1]) add(solidLine([[a, y, dm], [b, y, dm + s * 0.12]], flowMat));
    }
    addLabel('Open roadside drain (schematic) — flow along the road, direction unknown; both crossings leave the channel open', 'site', D.x1 - 4.5, 0.15, dm, 'detail', 4);
    // verge (outside the main wall, ownership unknown), split around the driveway and the route
    const gaps = [[drv.x0, drv.x1], [st.x0, st.x1]];
    const spans = (x0, x1) => gaps.reduce((runs, [a, b]) => runs.flatMap(([u, v]) => (b <= u || a >= v ? [[u, v]] : [...(a > u ? [[u, a]] : []), ...(b < v ? [[b, v]] : [])])), [[x0, x1]]);
    if (F.verge) {
      for (const [a, b] of spans(D.x0, D.x1)) add(box(verge, a, F.verge.y0, b, F.verge.y1, 0, lv.verge));
      addLabel(`Verge ${signed(lv.verge)} — ownership UNKNOWN`, 'site', 13.5, lv.verge + 0.05, (F.verge.y0 + F.verge.y1) / 2, 'detail', 4);
    }
    // lower planting strip with a stone-faced outer edge (REF-AERIAL/REF-PLAN planter; REF-FRONT earth bank)
    const PS = F.plantingStrip;
    let edgeTop;
    if (F.retainingEdge) {
      // V2.4: raised retaining edge directly behind the drain. The visible face runs from the toe (drain-side ground) to the top of the capping;
      // the planting soil is a separate level 0.10 m below the capping.
      const E = F.retainingEdge, capH = 0.06, faceTop = lv.edgeCap - capH;
      edgeTop = lv.edgeCap;
      add(box(stoneMat(E.x1 - E.x0, faceTop - lv.toe), E.x0, E.y0, E.x1, E.y0 + E.thickness, 0, faceTop));
      add(box(coping, E.x0 - 0.02, E.y0 - 0.03, E.x1 + 0.02, E.y0 + E.thickness + 0.02, faceTop, lv.edgeCap));
      add(box(stripSoil, E.x0, E.y0 + E.thickness, PS.x1, PS.y1, 0, lv.strip));
      // visible-face dimension: toe → top of the capping, in front of the face (always drawn)
      const dx = E.x0 + 1.4, dy = E.y0 - 0.22, dc = 0x2f5d62;
      add(solidLine([[dx, lv.toe, dy], [dx, lv.edgeCap, dy]], dc));
      for (const z of [lv.toe, lv.edgeCap]) add(solidLine([[dx - 0.12, z, dy], [dx + 0.12, z, dy]], dc));
      addLabel(`Visible face ≈ ${f2(E.visibleFace)} m<br>OWNER-ESTIMATED — TO BE VERIFIED`, 'site pill', dx + 1.3, (lv.toe + lv.edgeCap) / 2, dy - 0.3, 'core', 1);
      addLabel(`Capping ${signed(lv.edgeCap)}`, 'level', E.x0 + 5.0, lv.edgeCap + 0.12, E.y0 - 0.25, 'core', 2);
      addLabel(`Toe (drain-side ground) ${signed(lv.toe)}`, 'level', E.x0 + 5.0, lv.toe + 0.08, E.y0 - 0.55, 'core', 2);
      addLabel(`Planting soil ${signed(lv.strip)} (0.10 m below the capping)`, 'site', E.x0 + 7.2, lv.strip + 0.25, (E.y0 + PS.y1) / 2 + 0.2, 'detail', 4);
      addLabel('Retaining edge — ownership UNKNOWN (may be road reserve); structure NOT specified', 'site', 14.6, lv.edgeCap + 0.55, E.y0 - 0.1, 'detail', 4);
    } else {
      edgeTop = lv.strip + PS.outerEdge.aboveStrip;
      add(box(stoneMat(PS.x1 - PS.x0, edgeTop), PS.x0, PS.y0, PS.x1, PS.y0 + PS.outerEdge.thickness, 0, edgeTop));
      add(box(coping, PS.x0 - 0.02, PS.y0 - 0.02, PS.x1, PS.y0 + PS.outerEdge.thickness + 0.02, edgeTop, edgeTop + 0.04));
      add(box(stripSoil, PS.x0, PS.y0 + PS.outerEdge.thickness, PS.x1, PS.y1, 0, lv.strip));
      addLabel(`Lower planting strip ${signed(lv.strip)} — ownership UNKNOWN`, 'site', 12.0, edgeTop + 0.2, PS.y0 + 0.3, 'detail', 4);
    }
    // main wall: stone-look base from the strip, white render above
    const MW = F.mainWall, stoneTop = lv.strip + MW.stoneAboveStrip, wallTop = lv.yard + MW.topAboveGarden;
    add(box(stoneMat(MW.x1 - MW.x0, stoneTop), MW.x0, MW.y0, MW.x1, MW.y1, 0, stoneTop));
    capped(MW.x0, MW.y0, MW.x1, MW.y1, wallTop, stoneTop);
    addLabel('Main wall: stone-look base, white render — retains the garden (unresolved)', 'site', 12.5, wallTop + 0.3, MW.y0 - 0.2, 'detail', 4);
    // raised site terrain inside the symbolic boundaries only (cut by the driveway and the flight)
    const terrain = (x0, x1, y0, y1, h = land) => {
      if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
      const m = new THREE.Mesh(unitBox, [M.landSide, M.landSide, M.landTop, M.landSide, M.landSide, M.landSide]);
      m.scale.set(x1 - x0, h, y1 - y0);
      m.position.set(X((x0 + x1) / 2), 0, Z((y0 + y1) / 2));
      m.castShadow = m.receiveShadow = true;
      add(m);
    };
    const wallRight = drv.rightRetainingWall.x1, chanR = st.x1 + st.sideWall;
    if (V24) {
      // V2.4: the lower carport (B) is a pit cut into the raised land; the carport-to-garden steps cut a notch through the garden terrain
      const pit = lv.carport < land - 1e-9;
      if (pit) { terrain(cr.xR, wallRight, cp.y0, T0.y1); terrain(T0.x0, cr.xR, cr.yRear, T0.y1); terrain(T0.x0, cr.xR, cp.y0, cr.yRear, lv.carport - 0.1); }
      else terrain(T0.x0, wallRight, cp.y0, T0.y1);
      const by0 = cr.flight.rect.y0, by1 = cr.flight.rect.y1;
      terrain(wallRight, chanR, route.flight.rect.y1, by0);
      terrain(wallRight, chanR, by1, T0.y1);
      terrain(Math.max(cr.flight.rect.x1, drv.rightRetainingWall.x0), chanR, by0, by1);
    } else {
    terrain(T0.x0, wallRight, cp.y0, T0.y1);
    terrain(wallRight, chanR, route.flight.rect.y1, T0.y1);
    }
    terrain(chanR, T0.x1, T0.y0, T0.y1);
    addLabel(`Front garden = land ${signed(land)} m`, 'level', 13.0, lv.yard + 0.1, 5.2, 'core', 2);
    // boundary walls (symbolic) — rear, right and the left-rear closure; the left driveway wall follows the ramp
    const rw = S.rightWall, rr = S.rearWall, lr = S.leftRearWall;
    capped(rw.x0, rw.y0, rw.x1, rw.y1, lv.yard + rw.topAboveYard);
    capped(rr.x0, rr.y - 0.115, rr.x1, rr.y + 0.115, lv.yard + rr.topAboveYard);
    if (lr) capped(lr.x0, lr.y0, lr.x1, lr.y1, lv.yard + lr.topAboveYard);
    addLabel(FG ? 'Symbolic walls of the CONCEPTUAL envelope — not legal lines; real boundaries unknown' : 'Symbolic boundary walls — not legal lines; real boundaries unknown', 'site', 16.0, lv.yard + 1.0, FG ? rr.y - 0.6 : 21.2, 'detail', 5);
    add(profilePrism(X, Z, S.leftWall.x0, S.leftWall.x1, prof.filter(([y]) => y <= S.leftWall.y1).concat([[S.leftWall.y1, lv.carport]]), 0, (y, z) => z + 1.1, render));
    add(profilePrism(X, Z, S.leftWall.x0 - 0.03, S.leftWall.x1 + 0.03, [[0, lv.apron], ...prof.filter(([y]) => y <= S.leftWall.y1).slice(1), [S.leftWall.y1, lv.carport]], 0, (y, z) => z + 1.16, coping));
    // driveway: schematic crossing slab over the channel, level apron across verge and strip, climb, right retaining wall
    const drw = drv.rightRetainingWall, rtop = lv.yard + drw.topAboveYard, cw = drv.x1 - drv.x0;
    add(box(pavedMat(cw, F.drain.y1 - F.drain.y0, 0xd8d2c4), drv.x0, F.drain.y0, drv.x1, F.drain.y1, lv.apron - (drv.crossingThickness ?? 0.1), lv.apron));
    add(box(pavedMat(cw, 2, 0xd8d2c4), drv.x0, F.drain.y1, drv.x1, R.y0, 0, lv.apron));
    if ((drw.y0 ?? 0) < 0) capped(drw.x0, drw.y0, drw.x1, 0, lv.strip + (drw.lowTopAboveStrip ?? 0.05));
    if (V24) retainingWallPieces(plan).forEach((q, i) => capped(q.x0, i ? q.y0 : 0, q.x1, q.y1, rtop));
    else capped(drw.x0, 0, drw.x1, drw.y1 ?? cp.y0, rtop);
    add(profilePrism(X, Z, drv.x0, drv.x1, prof, 0, (y, z) => z, M.ramp));
    for (let y = R.y0 + 0.5; y < R.y1; y += 0.5) add(solidLine([[drv.x0 + 0.02, rampHeight(plan, land, y) + 0.012, y], [drv.x1 - 0.02, rampHeight(plan, land, y) + 0.012, y]], 0x9a9382));
    const upper = prof[Math.floor(prof.length * 0.7)];
    addLabel(`Driveway climb ${f2(R.run)} m · ${am.averageGradientPct.toFixed(0)}% avg / ${am.maxLocalGradientPct.toFixed(0)}% max · clearance UNCHECKED`, 'site pill access', (drv.x0 + drv.x1) / 2, upper[1] + 0.5, upper[0], 'detail', 3);
    addLabel(`Apron ${signed(lv.apron)} · schematic crossing`, 'site', (drv.x0 + drv.x1) / 2, lv.apron + 0.2, F.verge ? F.verge.y0 : F.drain.y1, 'detail', 4);
    // ---- the pedestrian route (pedRoute: the same data as the plan, the section and the checks)
    const stepsMat = pavedMat(st.x1 - st.x0, 2), c = route.crossing, b = route.bottom;
    add(box(stepsMat, c.rect.x0, c.rect.y0, c.rect.x1, c.rect.y1, c.underside, c.level));
    add(box(stepsMat, b.rect.x0, b.rect.y0, b.rect.x1, b.rect.y1, 0, b.level));
    for (const t of route.flight.treads) {
      add(box(stepsMat, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, 0, t.level));
      add(box(render, st.x0 - st.sideWall, t.rect.y0, st.x0, t.rect.y1, 0, t.level + st.guardAboveTread));
      add(box(render, st.x1, t.rect.y0, st.x1 + st.sideWall, t.rect.y1, 0, t.level + st.guardAboveTread));
    }
    if (V24) for (const [x0, x1] of [[st.x0 - st.sideWall, st.x0], [st.x1, st.x1 + st.sideWall]]) add(box(render, x0, b.rect.y0, x1, b.rect.y1, 0, b.level + st.guardAboveTread));
    const fe = route.flight.rect.y1, lastTop = route.flight.treads.at(-1)?.level ?? b.level;
    add(box(stepsMat, st.x0, fe - 0.01, st.x1, fe, lastTop, lv.yard + lift));   // last riser face
    const ul = route.upper.rect;
    add(box(pavedMat(ul.x1 - ul.x0, ul.y1 - ul.y0), ul.x0, ul.y0, ul.x1, ul.y1, lv.yard, lv.yard + lift));
    for (const q of route.path.rects) add(box(pavedMat(q.rect.x1 - q.rect.x0, q.rect.y1 - q.rect.y0), q.rect.x0, q.rect.y0, q.rect.x1, q.rect.y1, lv.yard, lv.yard + lift));
    const pierH = lv.yard + st.pierHeight;
    for (const pr of plan.route.piers) {
      capped(pr.x0, pr.y0, pr.x1, pr.y1, pierH);
      add(box(lampMat, (pr.x0 + pr.x1) / 2 - 0.06, pr.y0 - 0.03, (pr.x0 + pr.x1) / 2 + 0.06, pr.y0, pierH - 0.5, pierH - 0.35));
    }
    add(dashed([[ul.x0, lv.yard + 0.05, ul.y0 + 0.15], [ul.x1, lv.yard + 0.05, ul.y0 + 0.15]], 0xd2553b, 0.15));
    addLabel('Optional pedestrian gate on the upper landing (other references) — not drawn', 'site', (st.x0 + st.x1) / 2, lv.yard + 0.35, ul.y0 + 0.5, 'detail', 5);
    addLabel(`Crossing + bottom landing ${signed(b.level)}`, 'level', st.x1 + 1.2, b.level + 0.1, (b.rect.y0 + b.rect.y1) / 2, 'core', 2);
    addLabel(`Upper landing = garden ${signed(route.upper.level)} · ${route.flight.risers} risers`, 'level', st.x0 - 0.2, lv.yard + 0.35, ul.y1 + 0.3, 'core', 2);
    // route centreline (dashed) from the road edge to the entrance door
    const rl = [[(st.x0 + st.x1) / 2, c.level + 0.03, c.rect.y0], [(st.x0 + st.x1) / 2, b.level + 0.03, b.rect.y1]];
    for (const t of route.flight.treads) rl.push([(st.x0 + st.x1) / 2, t.level + 0.03, t.rect.y0], [(st.x0 + st.x1) / 2, t.level + 0.03, t.rect.y1]);
    rl.push([(st.x0 + st.x1) / 2, lv.yard + lift + 0.03, fe], ...route.path.points.slice(1).map(([x, y]) => [x, lv.yard + lift + 0.03, y]));
    add(dashed(rl, 0xc8642c, 0.12));
    // planting placeholders from plantings() — the same footprints the route checks keep off the walking route
    const shrub = (x, y, r, base, mat) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
      m.position.set(X(x), base + r * 0.75, Z(y));
      m.scale.y = 0.85;
      m.castShadow = true;
      add(m);
    };
    const G = plan.garden;
    for (const l of G.lawns) add(flat(lawn, l.x0, l.y0, l.x1, l.y1, lv.yard + 0.006));
    for (const bd of G.beds) add(box(soil, bd.x0, bd.y0, bd.x1, bd.y1, lv.yard, lv.yard + 0.06));
    for (const [i, q] of plantings(plan).entries()) {
      if (q.kind === 'shrub') shrub(q.x, q.y, q.r, q.base === 'strip' ? lv.strip : lv.yard, i % 2 ? leafA : leafB);
      else if (q.kind === 'palm') {
        const trunkMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, q.height, 8), trunk);
        trunkMesh.position.set(X(q.x), lv.yard + q.height / 2, Z(q.y));
        trunkMesh.castShadow = true;
        add(trunkMesh);
        for (let k = 0; k < 9; k++) {
          const a = (k * 2 * Math.PI) / 9, frond = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), leafA);
          frond.scale.set(0.95, 0.07, 0.24);
          frond.position.set(X(q.x) + Math.cos(a) * 0.7, lv.yard + q.height - 0.2, Z(q.y) + Math.sin(a) * 0.7);
          frond.rotation.y = -a;
          frond.rotation.z = -0.5;
          frond.castShadow = true;
          add(frond);
        }
      } else if (q.kind === 'tree') {
        const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, q.height * 0.55, 8), trunk);
        tr.position.set(X(q.x), lv.yard + q.height * 0.275, Z(q.y));
        add(tr);
        for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2 + 0.4, m = new THREE.Mesh(new THREE.IcosahedronGeometry(q.crown * 0.6, 1), q.flowering ? flower : leafB);
          m.position.set(X(q.x) + Math.cos(a) * 0.55, lv.yard + q.height * 0.72, Z(q.y) + Math.sin(a) * 0.55);
          m.scale.y = 0.8;
          m.castShadow = true;
          add(m);
        }
      } else if (q.kind === 'pot' && assets.plant) add(placeModel(assets.plant, q.x, q.y, floor));
    }
  } else {
  // ---- ground, road, drain (V2.1)
  add(flat(M.ground, D.x0 - FAR, D.y0 - FAR, D.x1 + FAR, D.y1 + FAR, -0.01));
  add(flat(M.road, D.x0 - FAR, S.road.y0, D.x1 + FAR, S.road.y1, 0.004));
  const roadMid = (S.road.y0 + S.road.y1) / 2;
  for (let x = D.x0 - FAR; x < D.x1 + FAR; x += 3) add(flat(M.roadLine, x, roadMid - 0.06, x + 1.6, roadMid + 0.06, 0.006));
  add(flat(M.drain, D.x0 - FAR, S.drain.y0, D.x1 + FAR, S.drain.y1, 0.003));
  addLabel(`ROAD ±0.00 m · ASSUMED datum<br>display width ${f2(S.road.y1 - S.road.y0)} m, not measured`, 'level', D.x1 - 2.5, 0.05, (S.road.y0 + S.road.y1) / 2 + 0.4, 'detail', 4);
  addLabel('Roadside drain — position ASSUMED, unaltered; crossings unresolved', 'site pill', D.x1 - 4, 0.05, (S.drain.y0 + S.drain.y1) / 2, 'core', 3);

  // ---- raised land: blocks around the driveway and steps channels
  const wallRight = drv.rightRetainingWall.x1, chanR = st.x1 + st.sideWall;
  const landBlock = (x0, x1, y0, y1) => {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
    const m = new THREE.Mesh(unitBox, [M.landSide, M.landSide, M.landTop, M.landSide, M.landSide, M.landSide]);
    m.scale.set(x1 - x0, land, y1 - y0);
    m.position.set(X((x0 + x1) / 2), 0, Z((y0 + y1) / 2));
    m.castShadow = m.receiveShadow = true;
    add(m);
  };
  landBlock(D.x0 - FAR, drv.x0, 0, D.y1 + FAR);
  landBlock(drv.x0, wallRight, cp.y0, D.y1 + FAR);
  landBlock(wallRight, chanR, stp.y1, D.y1 + FAR);
  landBlock(chanR, D.x1 + FAR, 0, D.y1 + FAR);

  // ---- front garden at land level: lawns, beds, shrubs, trees, path
  const G = plan.garden;
  for (const l of G.lawns) add(flat(lawn, l.x0, l.y0, l.x1, l.y1, lv.yard + 0.012));
  const shrub = (x, y, r, mat) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
    m.position.set(X(x), lv.yard + r * 0.75, Z(y));
    m.scale.y = 0.85;
    m.castShadow = true;
    add(m);
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const [i, b] of G.beds.entries()) {
    add(box(soil, b.x0, b.y0, b.x1, b.y1, lv.yard, lv.yard + 0.06));
    const n = Math.max(3, Math.floor((b.x1 - b.x0) / 0.8));
    for (let k = 0; k < n; k++) shrub(b.x0 + ((k + 0.5) * (b.x1 - b.x0)) / n + (rnd() - 0.5) * 0.3, (b.y0 + b.y1) / 2 + (rnd() - 0.5) * 0.3, 0.3 + rnd() * 0.25, (k + i) % 2 ? leafA : leafB);
  }
  const pw = G.pathWidth / 2;
  G.path.slice(1).forEach(([x1, y1], i) => {
    const [x0, y0] = G.path[i];
    add(box(pavingFlat, Math.min(x0, x1) - pw, Math.min(y0, y1) - pw, Math.max(x0, x1) + pw, Math.max(y0, y1) + pw, lv.yard, lv.yard + 0.03 + 0.003 * i));
  });
  for (const p of G.palms) {
    const trunkMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, p.height, 8), trunk);
    trunkMesh.position.set(X(p.x), lv.yard + p.height / 2, Z(p.y));
    trunkMesh.castShadow = true;
    add(trunkMesh);
    for (let k = 0; k < 9; k++) {
      const a = (k * 2 * Math.PI) / 9, frond = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), leafA);
      frond.scale.set(0.95, 0.07, 0.24);
      frond.position.set(X(p.x) + Math.cos(a) * 0.7, lv.yard + p.height - 0.2, Z(p.y) + Math.sin(a) * 0.7);
      frond.rotation.y = -a;
      frond.rotation.z = -0.5;
      frond.castShadow = true;
      add(frond);
    }
  }
  for (const t of G.trees) {
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, t.height * 0.55, 8), trunk);
    tr.position.set(X(t.x), lv.yard + t.height * 0.275, Z(t.y));
    add(tr);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4, m = new THREE.Mesh(new THREE.IcosahedronGeometry(t.crown * 0.6, 1), t.flowering ? flower : leafB);
      m.position.set(X(t.x) + Math.cos(a) * 0.55, lv.yard + t.height * 0.72, Z(t.y) + Math.sin(a) * 0.55);
      m.scale.y = 0.8;
      m.castShadow = true;
      add(m);
    }
  }
  if (assets.plant) {
    for (const [x, y] of [[8.1, 9.3], [10.9, 9.3]]) add(placeModel(assets.plant, x, y, floor));
  }
  addLabel(`Front garden = land level ${signed(land)} m<br>placeholders, not a planting design`, 'site pill', 13.0, lv.yard + 0.1, 5.2, 'core', 3);

  // ---- boundary and frontage walls (symbolic, retain raised ground)
  const wallTop = lv.yard + S.frontWall.topAboveYard;
  const fw = S.frontWall;
  add(box(stoneMat(fw.x1 - chanR, fw.stoneBaseHeight), chanR, fw.y0, fw.x1, fw.y1, 0, fw.stoneBaseHeight));
  capped(chanR, fw.y0, fw.x1, fw.y1, wallTop, fw.stoneBaseHeight);
  addLabel('Frontage wall: stone-look base, white render — retains raised ground (unresolved)', 'site pill', 12.5, fw.stoneBaseHeight + 0.5, -0.7, 'core', 3);
  const rw = S.rightWall, rr = S.rearWall;
  capped(rw.x0, rw.y0, rw.x1, rw.y1, lv.yard + rw.topAboveYard);
  capped(rr.x0, rr.y - 0.115, rr.x1, rr.y + 0.115, lv.yard + rr.topAboveYard);
  addLabel('Symbolic boundary walls — not legal lines; real boundaries unknown', 'site', 16.0, lv.yard + 1.0, 21.2, 'detail', 5);
  // left boundary beside the driveway follows the ramp (neighbouring ground level unknown)
  add(profilePrism(X, Z, S.leftWall.x0, S.leftWall.x1, prof.filter(([y]) => y <= S.leftWall.y1).concat([[S.leftWall.y1, lv.carport]]), 0, (y, z) => z + 1.1, render));
  add(profilePrism(X, Z, S.leftWall.x0 - 0.03, S.leftWall.x1 + 0.03, [[0, lv.apron], ...prof.filter(([y]) => y <= S.leftWall.y1).slice(1), [S.leftWall.y1, lv.carport]], 0, (y, z) => z + 1.16, coping));
  // right retaining wall of the driveway
  const rtop = lv.yard + drv.rightRetainingWall.topAboveYard;
  capped(drv.rightRetainingWall.x0, 0, drv.rightRetainingWall.x1, cp.y0, rtop);
  addLabel('Driveway retaining walls — cut and retaining UNRESOLVED', 'site', 4.1, rtop + 0.35, 5.0, 'detail', 5);

  // ---- driveway: apron over the drain, climb with transitions, joints
  const cw = drv.x1 - drv.x0;
  add(box(pavedMat(cw, 2, 0xd8d2c4), drv.x0, drv.apronY0, drv.x1, R.y0, 0, lv.apron));
  const rampMesh = profilePrism(X, Z, drv.x0, drv.x1, prof, 0, (y, z) => z, M.ramp);
  add(rampMesh);
  for (let y = R.y0 + 0.5; y < R.y1; y += 0.5) add(solidLine([[drv.x0 + 0.02, rampHeight(plan, land, y) + 0.012, y], [drv.x1 - 0.02, rampHeight(plan, land, y) + 0.012, y]], 0x9a9382));
  add(dashed([[drv.x0, lv.apron + 0.03, R.y0], [drv.x1, lv.apron + 0.03, R.y0]], 0xc8642c, 0.12));
  const upper = prof[Math.floor(prof.length * 0.7)];
  addLabel(`Driveway climb ${f2(R.run)} m · ${am.averageGradientPct.toFixed(0)}% avg / ${am.maxLocalGradientPct.toFixed(0)}% max · clearance UNCHECKED`, 'site pill access', (drv.x0 + drv.x1) / 2, upper[1] + 0.5, upper[0], 'core', 2);
  addLabel('Climb starts — smooth bottom transition', 'site', (drv.x0 + drv.x1) / 2, lv.apron + 0.2, R.y0 - 0.4, 'detail', 4);
  addLabel('Driveway crossing over the roadside drain — unresolved', 'site pill', (drv.x0 + drv.x1) / 2 - 0.4, 0.55, -0.45, 'core', 3);
  add(dashed([[(drv.x0 + drv.x1) / 2, 0.02, S.road.y1 + 2], [(drv.x0 + drv.x1) / 2, lv.apron + 0.03, S.road.y1 + 0.2], ...prof.map(([y, z]) => [(drv.x0 + drv.x1) / 2, z + 0.04, y]), [(drv.x0 + drv.x1) / 2, lv.carport + 0.05, 14.0]], 0xc8642c));

  // ---- pedestrian steps beside the ramp (as in the primary reference)
  const stepsMat = pavedMat(st.x1 - st.x0, 2);
  add(box(stepsMat, st.x0, S.drain.y0, st.x1, S.drain.y1, 0, lv.apron));
  for (let k = 1; k < stp.risers; k++) {
    const y0 = st.y0 + (k - 1) * st.going, top = lv.apron + k * stp.riser;
    add(box(stepsMat, st.x0, y0, st.x1, y0 + st.going, 0, top));
    add(box(render, st.x0 - st.sideWall, y0, st.x0, y0 + st.going, 0, top + 0.9));
    add(box(render, st.x1, y0, st.x1 + st.sideWall, y0 + st.going, 0, top + 0.9));
  }
  const pierH = lv.yard + st.pierHeight;
  for (const [x0, x1] of [[drv.rightRetainingWall.x0, st.x0 + 0.05], [st.x1 - 0.05, chanR]]) {
    capped(x0, -0.05, x1, 0.5, pierH);
    add(box(lampMat, (x0 + x1) / 2 - 0.06, -0.08, (x0 + x1) / 2 + 0.06, -0.05, pierH - 0.5, pierH - 0.35));
  }
  addLabel(`Pedestrian steps — ${stp.risers} risers at this land level · no pedestrian gate in the primary reference`, 'site pill', (st.x0 + st.x1) / 2, lv.apron + 0.9, 1.3, 'core', 3);
  const gpt = st.pedestrianGate;
  add(dashed([[st.x0, lv.yard + 0.04, gpt.y], [st.x1, lv.yard + 0.04, gpt.y]], 0xd2553b, 0.15));
  addLabel('Optional pedestrian gate position (other references) — not drawn', 'site', (st.x0 + st.x1) / 2, lv.yard + 0.35, gpt.y + 0.4, 'detail', 5);
  }

  // V2.3: gate on the front-wall line. Its base is DERIVED from the driveway surface (gateGeometry); the piers stand on the
  // apron; the carport roof has its own columns; the space each operating option needs and the waiting car are drawn.
  const frontGate = () => {
    const gs = gateStudy(plan, land), geo = gs.geo, so = id => gs.options.find(o => o.id === id), w = gs.waiting, Fr = plan.frontage, t = geo.leafThickness;
    for (const pr of [gt.pierLeft, gt.pierRight]) {
      add(box(render, pr.x0, pr.y0, pr.x1, pr.y1, 0, geo.pierTop));
      add(box(coping, pr.x0 - 0.04, pr.y0 - 0.04, pr.x1 + 0.04, pr.y1 + 0.04, geo.pierTop, geo.pierTop + 0.07));
      add(box(lampMat, (pr.x0 + pr.x1) / 2 - 0.06, pr.y0 - 0.03, (pr.x0 + pr.x1) / 2 + 0.06, pr.y0, geo.base + 1.45, geo.base + 1.6));
    }
    // timber-slat leaf (closed), dark frame; bottom edge at the derived base + clearance
    const gw = gt.x1 - gt.x0, gh = geo.top - geo.bottom;
    add(box(woodMat(gw, gh), gt.x0, gt.y - t / 2 + 0.015, gt.x1, gt.y + t / 2 - 0.015, geo.bottom, geo.top));
    for (const [x0, x1, a, b] of [[gt.x0, gt.x1, geo.bottom, geo.bottom + 0.06], [gt.x0, gt.x1, geo.top - 0.06, geo.top], [gt.x0, gt.x0 + 0.06, geo.bottom, geo.top], [gt.x1 - 0.06, gt.x1, geo.bottom, geo.top], [(gt.x0 + gt.x1) / 2 - 0.03, (gt.x0 + gt.x1) / 2 + 0.03, geo.bottom, geo.top]]) {
      add(box(frameDark, x0, gt.y - t / 2, x1, gt.y + t / 2, a, b));
    }
    add(dashed([[gt.x0, geo.base + 0.02, gt.y], [gt.x1, geo.base + 0.02, gt.y]], 0x2f5d62, 0.1));
    // operating space: sliding pockets (right: translucent red, left: dashed), swing sweeps (inward blue, outward red)
    const sr = so('slide-right').zone, sl = so('slide-left').zone;
    add(box(M.conflict, sr.x0, sr.y0, sr.x1, sr.y1, geo.base + 0.02, geo.top));
    add(dashed([[sl.x0, geo.top, sl.y0], [sl.x1, geo.top, sl.y0], [sl.x1, geo.top, sl.y1], [sl.x0, geo.top, sl.y1], [sl.x0, geo.top, sl.y0]], 0xd2553b, 0.15));
    add(dashed([[sl.x0, geo.base + 0.04, gt.y], [sl.x1, geo.base + 0.04, gt.y]], 0xd2553b, 0.15));
    for (const [id, colour] of [['swing-in', 0x2f6fa3], ['swing-out', 0xd2553b]]) {
      const o = so(id);
      for (const [hx, hy] of o.hinges) {
        const ax = hx === gt.x0 ? 1 : -1, arc = [];
        for (let a = 0; a <= 90; a += 6) { const th = (a * Math.PI) / 180, x = hx + ax * o.radius * Math.cos(th), y = hy + o.sideY * o.radius * Math.sin(th); arc.push([x, driveSurface(plan, land, y) + 0.05, y]); }
        add(dashed([[hx, geo.base + 0.05, hy], ...arc, [hx, geo.base + 0.05, hy]], colour, 0.14));
      }
    }
    // the waiting car outside the closed gate and its road encroachment
    add(envelopeBox({ x0: w.rect.x0, z0: w.y0, x1: w.rect.x1, z1: w.y1 }, w.base, env_.height, 0xd2553b));
    if (w.encroach > 0) add(flat(M.conflict, w.rect.x0, w.y0, w.rect.x1, Fr.roadEdge.y, 0.02));
    // independent carport roof columns at the carport front
    for (const c of cp.columns) {
      const cb = V24 ? Math.min(lv.carport, rampHeight(plan, land, c.y0)) : lv.carport;
      add(box(render, c.x0, c.y0, c.x1, c.y1, cb, cpTop));
      add(box(coping, c.x0 - 0.03, c.y0 - 0.03, c.x1 + 0.03, c.y1 + 0.03, cpTop - 0.06, cpTop));
    }
    addLabel(`Gate base ${signed(geo.base)} = driveway surface`, 'level', (gt.x0 + gt.x1) / 2, geo.base + 0.35, gt.y, 'core', 1);
    addLabel(`Waiting car: ${f2(w.encroach)} m into the road`, 'site pill conflict', (w.rect.x0 + w.rect.x1) / 2, w.top + 0.4, (w.y0 + w.y1) / 2, 'core', 1);
    addLabel('Vehicle gate on the front-wall line — position & type PROVISIONAL; operation NOT DEMONSTRATED', 'site pill conflict', (gt.x0 + gt.x1) / 2 + 0.6, geo.top + 0.7, gt.y, 'detail', 2);
    addLabel('Sliding right (red) meets the pedestrian entrance and wall · left runs beyond the boundary · swing sweeps: inward blue, outward red', 'site', 5.4, geo.top + 0.3, gt.y + 1.0, 'detail', 5);
    addLabel('Carport roof columns — independent of the gate piers', 'site', (cp.columns[0].x0 + cp.columns[1].x1) / 2, cpTop + 0.35, cp.y0 - 0.2, 'detail', 4);
  };

  // ---- carport: slab, walls (from the wall list), piers, gate, roof, generic car
  if (V24 && lv.carport < lv.land - 1e-9) add(box(pavedMat(cp.x1 - cp.x0, cp.y1 - cp.y0, 0xcfcfca), 0.115, cp.y0, cp.x1 - 0.115, cp.y1 - 0.115, lv.carport - 0.1, lv.carport));
  else add(box(pavedMat(cp.x1 - cp.x0, cp.y1 - cp.y0, 0xcfcfca), 0.115, cp.y0, cp.x1 - 0.115, cp.y1 - 0.115, lv.land, lv.carport));
  const cpTop = roofL.underside;
  const env_ = P.vehicleEnvelope;
  if (FG) frontGate(); else {
  for (const pr of [gt.pierLeft, gt.pierRight]) {
    add(box(render, pr.x0, pr.y0, pr.x1, pr.y1, lv.carport, cpTop));
    add(box(lampMat, (pr.x0 + pr.x1) / 2 - 0.06, pr.y0 - 0.03, (pr.x0 + pr.x1) / 2 + 0.06, pr.y0, lv.carport + 1.7, lv.carport + 1.85));
  }
  // timber-slat sliding gate (closed), dark frame
  const gw = gt.x1 - gt.x0, gh = gt.height, gb = lv.carport;
  add(box(woodMat(gw, gh), gt.x0, gt.y - 0.03, gt.x1, gt.y + 0.03, gb + 0.05, gb + gh));
  for (const [x0, x1, a, b] of [[gt.x0, gt.x1, gb, gb + 0.06], [gt.x0, gt.x1, gb + gh, gb + gh + 0.06], [gt.x0, gt.x0 + 0.06, gb, gb + gh + 0.06], [gt.x1 - 0.06, gt.x1, gb, gb + gh + 0.06], [(gt.x0 + gt.x1) / 2 - 0.03, (gt.x0 + gt.x1) / 2 + 0.03, gb, gb + gh]]) {
    add(box(frameDark, x0, gt.y - 0.045, x1, gt.y + 0.045, a, b));
  }
  const gp = gatePockets(plan);
  add(box(M.conflict, gp.right.x0, gp.right.y0, gp.right.x1, gp.right.y1, gb + 0.02, gb + gh));
  add(dashed([[gp.left.x0, gb + 0.05, gt.y], [gp.left.x1, gb + 0.05, gt.y]], 0xd2553b, 0.2));
  addLabel('Vehicle gate: timber-slat sliding leaf — position & type PROVISIONAL, operation unresolved', 'site pill conflict', (gt.x0 + gt.x1) / 2 + 1.2, gb + gh + 0.55, gt.y - 0.5, tier('core', 'detail'), 1);
  addLabel(`Right pocket (red) ${f2(gp.leafLength)} m · left pocket (dashed) beyond the boundary — neither demonstrated`, 'site', 5.2, gb + 0.3, gt.y + 0.1, 'detail', 5);
  // waiting car: on the ramp, outside the gate
  const waitY1 = gt.y - 0.3, waitY0 = waitY1 - env_.length, wcx = (drv.x0 + drv.x1) / 2;
  const waitBase = rampHeight(plan, land, (waitY0 + waitY1) / 2);
  const wGroup = envelopeBox({ x0: wcx - env_.width / 2, z0: waitY0, x1: wcx + env_.width / 2, z1: waitY1 }, waitBase, env_.height, 0xd2553b);
  add(wGroup);
  addLabel(`A waiting car would stand on the ramp (up to ${am.waitingOnRamp.maxSlopePct.toFixed(0)}%) — stopping and starting UNCHECKED`, 'site pill conflict', wcx, waitBase + env_.height + 0.5, (waitY0 + waitY1) / 2, tier('core', 'detail'), 1);
  }
  // carport roof, parked car
  const carF = plan.furniture.find(f => f.type === 'vehicle');
  roofBox(render, -0.115, cp.y0 - cp.roofFrontOverhang, cp.x1 + 0.115, cp.y1, cpTop, cpTop + cp.roofThickness);
  if (V24) addLabel(`Carport ${activeCarportOption(plan).id} ${signed(lv.carport)} · headroom ${f2(roofL.clear)} m (roof level retained)`, 'level', (cp.x0 + cp.x1) / 2, lv.carport + 0.3, cp.y0 + 4.9, 'core', 2);
  else if (V22) addLabel(`Carport ${signed(lv.carport)}`, 'level', (cp.x0 + cp.x1) / 2, lv.carport + 0.3, cp.y0 + 1.0, 'core', 2);
  else addLabel(`Carport (covered) at the raised level ${signed(lv.carport)} m`, 'site pill', (cp.x0 + cp.x1) / 2, lv.carport + cp.clearHeight + 0.6, 12.0, 'core', 2);
  if (carF) {
    const cx = (carF.x0 + carF.x1) / 2, cyy = (carF.y0 + carF.y1) / 2;
    if (assets.car) add(placeModel(assets.car, cx, cyy, lv.carport, { fit: env_, rotateY: 0 }));
    else add(box(M.car, carF.x0, carF.y0, carF.x1, carF.y1, lv.carport, lv.carport + env_.height));
    add(envelopeBox({ x0: carF.x0, z0: carF.y0, x1: carF.x1, z1: carF.y1 }, lv.carport, env_.height));
    addLabel(`${assets.car ? 'Generic car model in an' : 'Placeholder box in an'} ASSUMED ${f2(env_.length)} × ${f2(env_.width)} m envelope — not the owner's car (Q03)`, 'site', cx, lv.carport + 0.2, carF.y1 + 0.5, 'detail', 4);
  }

  // ---- V2.4: carport walking route (parked car → strip → landing → derived steps → garden path → west porch steps → porch → entrance),
  // the utility service landing and steps, door-opening zones, and the 1.70 m scale figure. All from carportRoute() / carportStudy().
  if (V24) {
    const cs = carportStudy(plan, land), routeMat = new THREE.MeshBasicMaterial({ color: 0x3f9a63, transparent: true, opacity: 0.38, depthWrite: false });
    const zoneMat = new THREE.MeshBasicMaterial({ color: 0xe0a030, transparent: true, opacity: 0.36, depthWrite: false });
    const stepsM = pavedMat(2, 2, 0xd8d2c4), lift = 0.012, G = lv.yard;
    const lowest = r => Math.min(...[r.y0, r.y1].map(y => rampHeight(plan, land, Math.min(Math.max(y, R.y0), cp.y0))));
    // level landing at the top of the driveway (stands proud of the sloping ramp edge) and the walking strip beside the car
    for (const q of cr.platform.rects) add(box(stepsM, q.x0, q.y0, q.x1, q.y1, Math.min(lowest(q), lv.carport) - 0.04, lv.carport));
    for (const q of cr.platform.rects) add(flat(routeMat, q.x0, q.y0, q.x1, q.y1, lv.carport + lift));
    add(flat(routeMat, cr.strip.rect.x0, cr.strip.rect.y0, cr.strip.rect.x1, cr.strip.rect.y1, lv.carport + lift));
    add(flat(zoneMat, cr.doorRight.x0, cr.doorRight.y0, cr.doorRight.x1, cr.doorRight.y1, lv.carport + 2 * lift));
    add(flat(zoneMat, cr.doorLeft.x0, cr.doorLeft.y0, cr.doorLeft.x1, cr.doorLeft.y1, lv.carport + 2 * lift));
    // garden steps (up from B, one step down from A), upper landing, path along the house front
    for (const t of cr.flight.treads) add(box(stepsM, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, 0, t.level));
    add(box(stepsM, cr.upper.rect.x0, cr.upper.rect.y0, cr.upper.rect.x1, cr.upper.rect.y1, 0, G + lift));
    add(box(stepsM, cr.path.rect.x0, cr.path.rect.y0, cr.path.rect.x1, cr.path.rect.y1, G, G + lift));
    for (const t of cr.westSteps.treads) add(box(stepsM, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, lv.land, t.level));
    const wl = cr.westLanding.rect;
    add(flat(routeMat, wl.x0, wl.y0, wl.x1, wl.y1, floor + lift));
    // utility service landing (level with the utility floor) and steps along the left wall, outside the parked-car envelope
    const sv = cr.service, sl = sv.landing.rect;
    add(box(stepsM, sl.x0, sl.y0, sl.x1, sl.y1, lv.carport, floor));
    for (const t of sv.flight.treads) add(box(stepsM, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, lv.carport, t.level));
    add(flat(routeMat, sl.x0, sl.y0, sl.x1, sl.y1, floor + lift));
    // route centreline
    const yc = (cr.flight.rect.y0 + cr.flight.rect.y1) / 2, sx = (cr.strip.rect.x0 + cr.strip.rect.x1) / 2, dxm = (cr.entrance.lo + cr.entrance.hi) / 2, up = 0.04;
    const rl = [[sx, lv.carport + up, cr.car.y0 + 1.6], [sx, lv.carport + up, yc], [cr.flight.rect.x0, lv.carport + up, yc]];
    for (const t of cr.flight.treads) rl.push([t.rect.x0, t.level + up, yc], [t.rect.x1, t.level + up, yc]);
    rl.push([cr.upper.rect.x0, G + up, yc], [cr.path.rect.x1, G + up, yc]);
    for (const t of [...cr.westSteps.treads].reverse()) rl.push([t.rect.x0, t.level + up, yc], [t.rect.x1, t.level + up, yc]);
    rl.push([wl.x0, floor + up, yc], [dxm, floor + up, yc], [dxm, floor + up, cr.entrance.y]);
    add(dashed(rl, 0x2f8a52, 0.12));
    const sl0 = [[sl.x1 - 0.2, floor + up, (sl.y0 + sl.y1) / 2], [sv.flight.rect.x0 + 0.4, floor + up, sl.y0 + 0.1]];
    for (const t of [...sv.flight.treads].reverse()) sl0.push([sv.flight.rect.x0 + 0.4, t.level + up, (t.rect.y0 + t.rect.y1) / 2]);
    sl0.push([sv.flight.rect.x0 + 0.4, lv.carport + up, sv.flight.rect.y0 - 0.2]);
    add(dashed(sl0, 0x2f8a52, 0.12));
    // labels
    addLabel(`Carport walking route · ${cr.flight.risers} ${cr.flight.direction === 'up' ? 'risers up' : 'riser down'} to the garden · STEPPED, not step-free`, 'site pill', 5.0, G + 0.6, yc - 0.9, 'core', 1);
    addLabel(`Landing = carport ${signed(lv.carport)} (up to ${f2(cr.platform.proud)} m above the ramp edge)`, 'level', cr.platform.rects[0].x0 - 0.5, lv.carport + 0.35, yc - 0.5, 'core', 2);
    addLabel(`Utility service landing = floor ${signed(floor)} · ${sv.flight.risers} risers`, 'site pill', sl.x1 + 0.2, floor + 0.35, sl.y0 + 0.4, 'core', 2);
    addLabel('Door-opening zones (amber) — the walking strip shares the passenger one', 'site pill conflict', (cr.doorRight.x0 + cr.doorRight.x1) / 2 - 0.3, lv.carport + 0.45, (cr.doorRight.y0 + cr.doorRight.y1) / 2, 'detail', 3);
    addLabel(`West porch steps ×${cr.westSteps.risers} (${(cr.westSteps.riser * 1000).toFixed(0)} mm) → porch → entrance`, 'site', (cr.westSteps.rect.x0 + cr.westSteps.rect.x1) / 2 - 0.2, G + 0.3, yc - 0.8, 'detail', 4);
    // the 1.70 m scale figure standing in the road (procedural, no asset)
    const fg = figureOf(plan);
    if (fg) {
      const h = fg.height, body = std(0x2f5d62), skin = std(0xe0b895), figure = new THREE.Group();
      const part = (geo, mat, y) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; figure.add(m); };
      for (const sx0 of [-0.09, 0.09]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.065, h * 0.47, 10), std(0x3a4350)); leg.position.set(sx0, h * 0.235, 0); leg.castShadow = true; figure.add(leg); }
      part(new THREE.BoxGeometry(fg.shoulder, h * 0.36, 0.24), body, h * 0.47 + h * 0.18);
      for (const sx0 of [-1, 1]) { const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, h * 0.34, 8), body); arm.position.set(sx0 * (fg.shoulder / 2 + 0.06), h * 0.47 + h * 0.17, 0); arm.castShadow = true; figure.add(arm); }
      part(new THREE.CylinderGeometry(0.05, 0.055, h * 0.06, 8), skin, h * 0.83 + h * 0.03);
      part(new THREE.SphereGeometry(h * 0.065, 14, 10), skin, h - h * 0.065);
      figure.position.set(X(fg.x), 0.004, Z(fg.y));
      add(figure);
      add(flat(new THREE.MeshBasicMaterial({ color: 0xd2553b, transparent: true, opacity: 0.55, depthWrite: false }), fg.x - 0.32, fg.y - 0.32, fg.x + 0.32, fg.y + 0.32, 0.012));
      // a plain height rule beside the figure: 0 → 1.70 m with ticks every 0.50 m
      const rx = fg.x + 0.55, rc = 0xd2553b;
      add(solidLine([[rx, 0.01, fg.y], [rx, h, fg.y]], rc));
      for (const z of [0, 0.5, 1.0, 1.5, h]) add(solidLine([[rx - 0.1, z + 0.01, fg.y], [rx + 0.1, z + 0.01, fg.y]], rc));
      addLabel(`${f2(h)} m person — ASSUMED average height, scale reference only`, 'site pill', fg.x + 1.5, h + 0.25, fg.y, 'core', 1);
    }
  }

  // ---- house: plinth, floors, walls, openings
  const encCells = plan.rooms.filter(isEnclosed).flatMap(roomCells);
  for (const c of encCells) add(box(M.plinth, c.x0, c.y0, c.x1, c.y1, lv.land, floor));
  for (const w of plan.walls.filter(q => !q.belongsTo)) { const b = allBands(plan)[plan.walls.indexOf(w)]; add(box(M.plinth, b.x0, b.y0, b.x1, b.y1, w.skirtToCarport ? Math.min(lv.land, lv.carport) : lv.land, floor)); }
  if (V24 && lv.carport < lv.land - 1e-9) for (const w of plan.walls.filter(q => q.skirtToGround)) { const b = allBands(plan)[plan.walls.indexOf(w)]; add(box(render, b.x0, b.y0, b.x1, b.y1, 0, lv.carport)); }
  const por = plan.rooms.find(r => r.id === 'porch'), pc = roomCells(por)[0];
  add(box(pavedMat(pc.x1 - pc.x0, pc.y1 - pc.y0), pc.x0, pc.y0, pc.x1, pc.y1, lv.land, floor));
  for (const r of plan.rooms.filter(isEnclosed)) {
    for (const c of roomCells(r)) {
      let mat = std(ZONE_COLOURS[r.zone] ?? 0xeeeeee);
      if (r.zone === 'future') mat = hatch(c.x1 - c.x0, c.y1 - c.y0);
      add(flat(mat, c.x0, c.y0, c.x1, c.y1, floor + 0.002));
    }
  }
  // entrance steps down to the garden
  const es = fac.entranceSteps, entryRise = (floor - lv.yard) / es.count;
  for (let k = 1; k < es.count; k++) {
    add(box(pavedMat(es.x1 - es.x0, es.going), es.x0, pc.y0 - k * es.going, es.x1, pc.y0 - (k - 1) * es.going, lv.land, lv.yard + (es.count - k) * entryRise));
  }
  addLabel(`Entry steps ×${es.count} (${(entryRise * 1000).toFixed(0)} mm) from the garden to the porch`, 'site', (es.x0 + es.x1) / 2, lv.yard + 0.1, pc.y0 - 0.9, 'detail', 4);

  for (const p of wallPieces(plan, land)) {
    const r = p.rect, base = baseOf(p.base), tall = Math.max(r.x1 - r.x0, r.y1 - r.y0);
    let side = M.wallSide;
    if (p.exterior && assets.stucco) side = stuccoMat(tall, p.y1 - p.y0);
    const mesh = new THREE.Mesh(unitBox, [side, side, M.wallTop, side, side, side]);
    mesh.position.set(X((r.x0 + r.x1) / 2), base + p.y0, Z((r.y0 + r.y1) / 2));
    mesh.scale.set(r.x1 - r.x0, 1, r.y1 - r.y0);
    mesh.castShadow = mesh.receiveShadow = true;
    add(mesh);
    reg.heightBound.push({ mesh, y0: p.y0, y1: p.y1, base });
  }

  // outside direction of an exterior wall at an opening (towards the side with no room)
  const outwardOf = (w, o) => {
    const t = wallThickness(plan, w) / 2 + 0.2, pt = off => (w.dir === 'h' ? [o.at, w.at + off] : [w.at + off, o.at]);
    return roomAt(plan, ...pt(-t)) === null ? -1 : roomAt(plan, ...pt(t)) === null ? 1 : 0;
  };
  for (const o of plan.openings) {
    const g = openingGeom(plan, o), w = g.wall, base = baseOf(wallVertical(plan, w).base), horiz = w.dir === 'h';
    const fr = 0.06, t = wallThickness(plan, w), out = w.kind === 'exterior' ? outwardOf(w, o) : 0;
    const R = (a0, a1, c0, c1) => (horiz ? [a0, w.at + c0, a1, w.at + c1] : [w.at + c0, a0, w.at + c1, a1]);   // along [a0,a1], across [c0,c1]
    const mid = 0.045;
    if (o.kind === 'entrance-door') {
      hb(woodMat(o.width, o.head), ...R(g.lo + 0.05, g.hi - 0.05, -0.03, 0.03), base, 0, o.head - 0.05);
      hb(frameDark, ...R(g.lo, g.lo + fr, -mid, mid), base, 0, o.head);
      hb(frameDark, ...R(g.hi - fr, g.hi, -mid, mid), base, 0, o.head);
      hb(frameDark, ...R(g.lo, g.hi, -mid, mid), base, o.head - fr, o.head);
    } else if (!DOOR_KINDS.includes(o.kind)) {
      if (o.kind !== 'servery') hb(glass, ...R(g.lo + fr, g.hi - fr, -0.015, 0.015), base, o.sill + fr, o.head - fr, false);
      for (const [a0, a1, b0, b1] of [[g.lo, g.lo + fr, o.sill, o.head], [g.hi - fr, g.hi, o.sill, o.head], [g.lo, g.hi, o.head - fr, o.head], [g.lo, g.hi, o.sill, o.sill + fr]]) hb(frameDark, ...R(a0, a1, -mid, mid), base, b0, b1);
      if (o.kind === 'glazing') for (const k of [1, 2]) { const a = g.lo + ((g.hi - g.lo) * k) / 3; hb(frameDark, ...R(a - 0.025, a + 0.025, -mid, mid), base, o.sill, o.head); }
      if (o.surround && out) {
        const face = w.at + out * t / 2, s = o.surround, d0 = out > 0 ? 0 : -0.1, d1 = out > 0 ? 0.1 : 0;
        const Rs = (a0, a1) => (horiz ? [a0, face + d0, a1, face + d1] : [face + d0, a0, face + d1, a1]);
        hb(surround, ...Rs(g.lo - s, g.lo), base, o.sill, o.head + s);
        hb(surround, ...Rs(g.hi, g.hi + s), base, o.sill, o.head + s);
        hb(surround, ...Rs(g.lo - s, g.hi + s), base, o.head, o.head + s);
      }
      // plan symbol (visible in the Plan view only)
      const sym = horiz ? flat(M.glassPlan, g.lo, w.at - 0.03, g.hi, w.at + 0.03, floor + 0.06) : flat(M.glassPlan, w.at - 0.03, g.lo, w.at + 0.03, g.hi, floor + 0.06);
      add(sym); reg.planOnly.push(sym);
    }
    if (DOOR_KINDS.includes(o.kind)) {
      const th = horiz ? flat(M.threshold, g.lo, g.band.y0, g.hi, g.band.y1, floor + 0.004) : flat(M.threshold, g.band.x0, g.lo, g.band.x1, g.hi, floor + 0.004);
      add(th);
      if(o.kind==='sliding-door') {
        const dp=doorParts(plan,o),sl=slidingDoorGeometry(plan,o),q=r=>[r.x0,r.y0,r.x1,r.y1];
        hb(doorLeafMat,...q(dp.leaf.rect),base,dp.leaf.y0,dp.leaf.y1);
        for(const f of dp.frame)hb(doorFrameMat,...q(f.rect),base,f.y0,f.y1);
        const op=flat(M.threshold,...q(sl.open),floor+.07);add(op);reg.planOnly.push(op);
        addLabel(`${o.id}: surface sliding door · ${f2(o.width)} m clear · hardware provisional`,'detail',o.at,floor+2.25,w.at,'detail',5);
      }
      const s = swingSector(plan, o);
      if (s) {
        const hy = floor + 0.07, swing = new THREE.Group();
        swing.add(solidLine([[s.hinge[0], hy, s.hinge[1]], [s.open[0], hy, s.open[1]]], 0x555b63), dashed(s.arc.map(([x, y]) => [x, hy, y]), 0x8a9099, 0.08));
        add(swing); reg.planOnly.push(swing);
        if (V26 && o.kind === 'door') {   // V2.6: hinge marker (the same symbol as the SVG plan) and a leaf and frame that leave the clear opening free
          const hm = flat(M.hinge, s.hinge[0] - 0.05, s.hinge[1] - 0.05, s.hinge[0] + 0.05, s.hinge[1] + 0.05, floor + 0.08);
          add(hm); reg.planOnly.push(hm);
          const dp = doorParts(plan, o), q = r => [r.x0, r.y0, r.x1, r.y1];
          hb(doorLeafMat, ...q(dp.leaf.rect), base, dp.leaf.y0, dp.leaf.y1);
          for (const f of dp.frame) hb(doorFrameMat, ...q(f.rect), base, f.y0, f.y1);
        }
      }
    }
  }

  // façade: stone and wood-look entrance cladding, canopies (roof level), shading band
  const ent = plan.openings.find(o => o.kind === 'entrance-door'), ew = byWall[ent.wall], eOut = outwardOf(ew, ent) || -1;
  const eFace = ew.at + (eOut * wallThickness(plan, ew)) / 2;
  const feat = (f, mat) => hb(mat, f.x0, Math.min(eFace, eFace + eOut * f.depth), f.x1, Math.max(eFace, eFace + eOut * f.depth), floor, 0, f.height);
  feat(fac.entranceFeature, woodMat(fac.entranceFeature.x1 - fac.entranceFeature.x0, fac.entranceFeature.height));
  feat(fac.stoneFeature, stoneMat(fac.stoneFeature.x1 - fac.stoneFeature.x0, fac.stoneFeature.height));
  for (const [c, wood] of [[fac.entranceCanopy, true], [fac.shadingCanopy, false]]) {
    roofBox(render, c.x0, c.y0, c.x1, c.y1, floor + c.underside, floor + c.underside + c.thickness);
    if (wood) roofBox(woodMat(c.x1 - c.x0, c.y1 - c.y0), c.x0 + 0.05, c.y0 + 0.05, c.x1 - 0.05, c.y1, floor + c.underside - 0.015, floor + c.underside);
  }
  addLabel('Shaded entrance: wood-look panel and stone-look accent', 'site pill', (fac.entranceCanopy.x0 + fac.entranceCanopy.x1) / 2, floor + 3.3, fac.entranceCanopy.y0 - 0.4, tier('core', 'detail'), 3);
  if (V22) addLabel(`House floor / porch ${signed(floor)}`, 'level', pc.x1 - 0.6, floor + 0.15, pc.y0 + 0.6, 'core', 2);

  // ---- roof slabs, parapets, indicative PV (roof-level objects hidden by the roof toggle / cutaway)
  const wh = P.wallHeight, rt = P.roofSlabThickness, roofTop = floor + wh + rt;
  for (const s of plan.roof.slabs) roofBox(render, s.x0, s.y0, s.x1, s.y1, floor + wh, roofTop);
  const TT = V25 ? plan.roof.stairTower : null;   // V2.5: the stair tower counts as a neighbouring roof (no parapet inside it)
  for (const s of plan.roof.slabs) {
    for (const e of exposedEdges(s, plan.roof.slabs.filter(o => o !== s).concat(TT ? [TT] : []))) {
      const t = 0.15, r = e.axis === 'h' ? [e.a, e.at - t / 2, e.b, e.at + t / 2] : [e.at - t / 2, e.a, e.at + t / 2, e.b];
      roofBox(render, ...r, roofTop, roofTop + P.parapetHeight);
      // V2.5: optional steel safety railing on the parapets (posts and two rails; the Steel roof railing control hides it)
      if (V25 && plan.roof.railing.slabs.includes(s.id)) {
        const RL = plan.roof.railing, top = roofTop + P.parapetHeight, len = e.b - e.a, n = Math.max(1, Math.round(len / RL.postSpacing));
        const rail = (a0, a1, z0, z1, w) => { const m = roofBox(frameDark, ...(e.axis === 'h' ? [a0, e.at - w, a1, e.at + w] : [e.at - w, a0, e.at + w, a1]), z0, z1); reg.railObjects.push(m); };
        for (let k = 0; k <= n; k++) { const a = e.a + (len * k) / n; rail(a - 0.02, a + 0.02, top, top + RL.heightAboveParapet, 0.02); }
        for (const z of [top + RL.heightAboveParapet - 0.04, top + RL.heightAboveParapet / 2]) rail(e.a, e.b, z, z + 0.04, 0.018);
      }
    }
  }
  if (V25) {
    // ---- V2.5: half-turn stair in the utility room (stairDesign: the same data as the plan, the section and the checks)
    const sd = stairDesign(plan, land), SD = plan.stairDesign, stairMat = std(0xe2dccf, { roughness: 0.6 }), hr = SD.handrailHeight, railC = 0x2b2f34;
    for (const t of sd.lower.treads) add(box(stairMat, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, floor, t.level));
    add(box(stairMat, sd.landing.rect.x0, sd.landing.rect.y0, sd.landing.rect.x1, sd.landing.rect.y1, sd.landing.level - SD.waist, sd.landing.level));
    for (const t of sd.upper.treads) add(box(stairMat, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, t.level - SD.waist, t.level));
    add(solidLine([[sd.foot, floor + hr, sd.lower.rect.y0], [sd.landing.rect.x1, sd.landing.level + hr, sd.lower.rect.y0]], railC));
    add(solidLine([[sd.landing.rect.x1, sd.landing.level + hr, sd.upper.rect.y1], [sd.upper.rect.x1, sd.upperLanding.level + hr, sd.upper.rect.y1]], railC));
    roofBox(render, sd.upperLanding.rect.x0, sd.upperLanding.rect.y0, sd.upperLanding.rect.x1, sd.upperLanding.rect.y1, floor + wh, roofTop);
    roofBox(frameDark, sd.foot - 0.02, sd.upper.rect.y1, sd.foot + 0.02, sd.lower.rect.y1, roofTop, roofTop + hr);   // balustrade at the upper landing edge
    addLabel(`Stair ${sd.n} × ${(sd.riser * 1000).toFixed(0)} mm, going ${(sd.going * 1000).toFixed(0)} mm → roof / future upper floor · compliance TO BE VERIFIED`, 'site pill', (sd.clear.x0 + sd.clear.x1) / 2, floor + 2.0, (sd.clear.y0 + sd.clear.y1) / 2, 'interior', 2);
    // stair tower on the utility outline (hidden with the roof), door onto the main roof, street-facing window
    const tT = roofTop + TT.height, tw = TT.wallThickness, b0 = floor + wh, D = TT.door, Wn = TT.window;
    roofBox(render, TT.x0, TT.y0, TT.x0 + tw, TT.y1, b0, tT);
    roofBox(render, TT.x0, TT.y1 - tw, TT.x1, TT.y1, b0, tT);
    roofBox(render, TT.x1 - tw, TT.y1 - tw, TT.x1, TT.y1, b0, tT);
    roofBox(render, TT.x1 - tw, D.y1, TT.x1, TT.y1 - tw, b0, tT);
    roofBox(render, TT.x1 - tw, TT.y0, TT.x1, D.y0, b0, tT);
    roofBox(render, TT.x1 - tw, D.y0, TT.x1, D.y1, b0, roofTop);
    roofBox(render, TT.x1 - tw, D.y0, TT.x1, D.y1, roofTop + D.height, tT);
    roofBox(frameDark, TT.x1 - tw / 2 - 0.02, D.y0 + 0.03, TT.x1 - tw / 2 + 0.02, D.y1 - 0.03, roofTop, roofTop + D.height - 0.03);
    roofBox(render, TT.x0, TT.y0, Wn.x0, TT.y0 + tw, b0, tT);
    roofBox(render, Wn.x1, TT.y0, TT.x1 - tw, TT.y0 + tw, b0, tT);
    roofBox(render, Wn.x0, TT.y0, Wn.x1, TT.y0 + tw, b0, roofTop + Wn.sill);
    roofBox(render, Wn.x0, TT.y0, Wn.x1, TT.y0 + tw, roofTop + Wn.head, tT);
    roofBox(glass, Wn.x0, TT.y0 + tw / 2 - 0.015, Wn.x1, TT.y0 + tw / 2 + 0.015, roofTop + Wn.sill, roofTop + Wn.head);
    roofBox(render, TT.x0 - 0.1, TT.y0 - 0.1, TT.x1 + 0.1, TT.y1 + 0.1, tT, tT + rt);
    roofBox(coping, TT.x0 - 0.12, TT.y0 - 0.12, TT.x1 + 0.12, TT.y1 + 0.12, tT + rt, tT + rt + 0.06);
    addLabel('Stair tower — roof access (PV maintenance); the future upper floor continues from here', 'site pill', (TT.x0 + TT.x1) / 2, tT + 0.7, TT.y0 - 0.3, 'detail', 3);
    // rear service yard: back-door landing (floor level), derived steps, paving, light canopy (hidden with the roof)
    const yd = serviceYard(plan, land), yMat = pavedMat(2, 2, 0xd8d2c4);
    add(box(yMat, yd.landing.rect.x0, yd.landing.rect.y0, yd.landing.rect.x1, yd.landing.rect.y1, lv.yard, floor));
    for (const t of yd.flight.treads) add(box(yMat, t.rect.x0, t.rect.y0, t.rect.x1, t.rect.y1, lv.yard, t.level));
    add(box(yMat, yd.paving.x0, yd.paving.y0, yd.paving.x1, yd.paving.y1, lv.yard, lv.yard + 0.02));
    const can = yd.canopy.rect;
    roofBox(std(0xdfe8ee, { transparent: true, opacity: 0.5, roughness: 0.2 }), can.x0, can.y0, can.x1, can.y1, yd.canopy.underside, yd.canopy.underside + 0.03);
    addLabel(`Rear service yard (laundry) · back door → ${yd.n} steps down · rear strip of the CONCEPTUAL envelope — unverified`, 'site', (yd.paving.x0 + yd.landing.rect.x1) / 2, lv.yard + 0.6, yd.landing.rect.y1 + 0.3, 'detail', 3);
  }
  const pv = plan.roof.pv, tilt = (pv.tiltDegrees * Math.PI) / 180;
  for (const a of pv.arrays) {
    const rows = Math.floor((a.y1 - a.y0 + pv.rowGap) / (pv.rowDepth + pv.rowGap));
    for (let k = 0; k < rows; k++) {
      const y0 = a.y0 + k * (pv.rowDepth + pv.rowGap), yc = y0 + (pv.rowDepth * Math.cos(tilt)) / 2;
      const m = new THREE.Mesh(unitBox, pvMat);
      m.scale.set(a.x1 - a.x0, 0.04, pv.rowDepth);
      m.position.set(X((a.x0 + a.x1) / 2), roofTop + pv.standoff + (pv.rowDepth * Math.sin(tilt)) / 2, Z(yc));
      m.rotation.x = tilt;
      m.castShadow = true;
      add(m); reg.roofObjects.push(m);
    }
  }
  addLabel('Indicative future PV (after construction) — layout, orientation and upper-floor conflict unresolved', 'site pill', (pv.arrays[0].x0 + pv.arrays[0].x1) / 2, roofTop + 1.1, pv.arrays[0].y0 - 0.3, 'detail', 3);

  for(const c of plan.wallStorage??[])hb(doorFrameMat,c.x0,c.y0,c.x1,c.y1,floor,c.bottom,c.top);
  // ---- furniture footprints (simple boxes; no detailed furniture)
  for (const f of plan.furniture.filter(q => q.type !== 'vehicle')) {
    const fBase = V25 && f.room === plan.serviceYard?.room ? lv.yard : floor;   // V2.5: laundry fixtures stand in the yard at land level
    hb(std(FURNITURE_COLOURS[f.type] ?? 0xdddddd), f.x0, f.y0, f.x1, f.y1, fBase, 0.0, f.height);
  }
  if (V26) {   // V2.6 (Plan view only): working spaces (teal), appliance door envelopes (amber) and the service routes tested by the usability audit
    const ua = usabilityAudit(plan, { land }), roomOf = id => plan.furniture.find(f => f.id === id)?.room;
    for (const z of ua.zones) {
      const yardItem = roomOf(z.id) === plan.serviceYard?.room, m = flat(z.kind === 'door' ? M.useDoor : M.useZone, z.rect.x0, z.rect.y0, z.rect.x1, z.rect.y1, (yardItem ? lv.yard : floor) + (z.kind === 'door' ? 0.075 : 0.06));
      add(m); reg.planOnly.push(m);
    }
    for (const [i, r] of ua.routes.entries()) {
      const g = new THREE.Group();
      g.add(dashed(r.points.map(([x, y]) => [x, floor + 0.1 + i * 0.004, y]), r.ok ? 0x1f6f9f : 0xd2553b, 0.18));
      add(g); reg.planOnly.push(g);
    }
  }

  // ---- labels: rooms (core, dimensions behind the Provisional dimensions toggle), tags (detail)
  const rm = Object.fromEntries(A.rooms.map(r => [r.id, r]));
  for (const r of plan.rooms) {
    const m = rm[r.id], [lx, ly] = r.labelAt ?? [(m.clearRect.x0 + m.clearRect.x1) / 2, (m.clearRect.y0 + m.clearRect.y1) / 2];
    const dims = m.multiCell ? '' : `<span class="dim">≈ ${f2(m.clearW)} × ${f2(m.clearD)} m</span>`;
    const level = r.id === 'carport' ? lv.carport : floor;
    addLabel(`<b>${esc(r.label)}</b>${dims}<span class="dim">≈ ${m.clearArea.toFixed(1)} m²</span>`, 'room', lx, level + 0.1, ly, 'interior', r.id === 'stair' || r.id === 'hall' ? 4 : 3);   // interior labels follow the roof: hidden while the roof is on
  }
  addLabel(`House finished floor ${signed(floor)} m<br>ASSUMED plinth ${f2(P.plinthHeight)} m`, 'level', 18.3, lv.yard + 0.05, 14.5, 'detail', 4);
  addLabel(`Land ${signed(land)} m<br>OWNER-ESTIMATED ${f2(plan.levels.land.min)}–${f2(plan.levels.land.max)}`, 'level', 18.3, lv.yard + 0.05, 11.5, 'detail', 4);
  addLabel(`Display extent only — not the parcel. Boundaries, frontage and depth unverified.`, 'site', 9.0, lv.yard + 0.05, FG ? D.y1 - 0.5 : 22.8, 'detail', 5);

  // ---- provisional dimension lines (toggle)
  const hc = encCells, dimY = floor + 0.08, b0 = { x0: Math.min(...hc.map(c => c.x0)), x1: Math.max(...hc.map(c => c.x1)), y0: Math.min(...hc.map(c => c.y0)), y1: Math.max(...hc.map(c => c.y1)) }, dyLine = b0.y0 - 2.2, dxLine = b0.x1 + 1.3;
  for (const p of [[[b0.x0, dimY, dyLine], [b0.x1, dimY, dyLine]], [[b0.x0, dimY, dyLine - 0.2], [b0.x0, dimY, dyLine + 0.2]], [[b0.x1, dimY, dyLine - 0.2], [b0.x1, dimY, dyLine + 0.2]],
    [[dxLine, dimY, b0.y0], [dxLine, dimY, b0.y1]], [[dxLine - 0.2, dimY, b0.y0], [dxLine + 0.2, dimY, b0.y0]], [[dxLine - 0.2, dimY, b0.y1], [dxLine + 0.2, dimY, b0.y1]]]) {
    const l = solidLine(p, 0x2f5d62); add(l); reg.dimObjects.push(l);
  }
  addLabel(`≈ ${f2(b0.x1 - b0.x0)} m (provisional, wall centrelines)`, 'dimline', (b0.x0 + b0.x1) / 2, dimY, dyLine - 0.35, 'dim', 2);
  addLabel(`≈ ${f2(b0.y1 - b0.y0)} m<br>(provisional)`, 'dimline', dxLine + 0.9, dimY, (b0.y0 + b0.y1) / 2, 'dim', 2);

  // ---- unresolved issues (numbered badges + panel)
  const heightOf = { gate: FG ? gateStudy(plan, land).geo.top + 0.5 : 0, road: 0.4, ramp: lv.apron + 1.0, carport: lv.carport + 1.9, land: lv.yard + 0.8, floor: floor + 0.5, verge: (lv.verge ?? 0) + 0.5, strip: (lv.strip ?? 0) + 1.6, route: lv.yard + 0.3, edge: (lv.edgeCap ?? 0) + 0.7, walk: lv.carport + 1.2, service: floor + 1.2 };
  for (const w of unresolvedIssues(plan, land)) reg.warnings.push({ title: w.title, text: w.text, at: w.at ? [w.at[0], heightOf[w.level] ?? lv.yard, w.at[1]] : null });
  return reg;
}

// ---------- approach profile panel (same dataset and ramp function as the 3D scene) ----------
export function renderProfileV2(el, plan, land, { f2, signed, section }) {
  const DR = drainOf(plan);
  const lv = levels(plan, land), R = ramp(plan), prof = rampProfile(plan, land), am = accessMetrics(plan, land);
  const S = plan.site, cp = plan.carport, gt = plan.gate, env = plan.parameters.vehicleEnvelope;
  const yStart = S.road.y1 - 2.4, yEnd = cp.y1 + 0.3;
  const VX = 2, w = 440, h = 250, padL = 10, padR = 120, padB = 40;
  const sx = (w - padL - padR) / (yEnd - yStart), sy = sx * VX;
  const px = y => padL + (y - yStart) * sx, py = z => h - padB - z * sy;
  const pts = arr => arr.map(([y, z]) => `${px(y).toFixed(1)},${py(z).toFixed(1)}`).join(' ');
  const surface = [[yStart, 0], [DR.y0, 0], [DR.y0, lv.apron], [R.y0, lv.apron], ...prof, [cp.y1, lv.carport], [yEnd, lv.carport]];
  const fill = [...surface, [yEnd, -0.35], [yStart, -0.35]];
  const ticks = [];
  const axisY = py(-0.35) + 3;
  for (let y = Math.ceil(yStart); y <= yEnd; y += 2) ticks.push(`<line x1="${px(y)}" y1="${axisY}" x2="${px(y)}" y2="${axisY + 4}" class="tick"/><text x="${px(y)}" y="${axisY + 13}" class="tick-t">${y}</text>`);
  const tags = [[lv.floor, `Floor ${signed(lv.floor)} ASSUMED`, 'ffl-t'], [lv.carport, `Carport ${signed(lv.carport)}`, ''], [lv.yard, `Garden = land ${signed(lv.yard)}`, ''], [lv.apron, `Apron ${signed(lv.apron)}`, ''], [0, 'Road ±0.00 datum', '']];
  let lastY = -Infinity;
  const tagSvg = tags.map(([z, text, cls]) => [py(z) + 3, text, cls]).sort((a, b) => a[0] - b[0])
    .map(([y, text, cls]) => { const yy = Math.max(y, lastY + 11); lastY = yy; return `<text x="${w - padR + 6}" y="${yy}" class="lvl ${cls}">${text}</text>`; }).join('');
  const waitY1 = gt.y - 0.3, waitY0 = waitY1 - env.length, waitBase = Math.min(...[waitY0, waitY1].map(y => rampHeight(plan, land, Math.max(y, R.y0))));
  const mid = prof[Math.floor(prof.length / 2)];
  const driveHtml = `
    <div class="profile-head"><b>Schematic approach profile</b> · driveway centreline · vertical ×${VX} · ASSUMED geometry · clearance UNCHECKED · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Schematic side profile from road to carport">
      <polygon points="${pts(fill)}" class="ground"/>
      <polyline points="${pts([[0, 0], [0, lv.yard], [R.y0 + 3, lv.yard]])}" class="land"/>
      <rect x="${px(DR.y0)}" y="${py(0)}" width="${(DR.y1 - DR.y0) * sx}" height="${0.3 * sy}" class="drain"/>
      <polyline points="${pts([[yStart, 0], [DR.y0, 0]])}" class="road"/>
      <polyline points="${pts([[DR.y1, lv.apron], [R.y0, lv.apron]])}" class="waiting"/>
      <polyline points="${pts(prof)}" class="ramp"/>
      <polyline points="${pts([[cp.y0, lv.carport], [cp.y1, lv.carport]])}" class="carport"/>
      <polyline points="${pts([[11.9, lv.floor], [20.2, lv.floor]])}" class="ffl"/>
      <rect x="${px(waitY0)}" y="${py(waitBase + env.height)}" width="${(waitY1 - waitY0) * sx}" height="${env.height * sy}" class="veh conflict"/>
      <rect x="${px(cp.y0 + 0.5)}" y="${py(lv.carport + env.height)}" width="${env.length * sx}" height="${env.height * sy}" class="veh"/>
      <line x1="${px(gt.y)}" y1="${py(lv.carport)}" x2="${px(gt.y)}" y2="${py(lv.carport + gt.height)}" class="gate"/>
      <text x="${px(gt.y) - 52}" y="${py(lv.carport + gt.height) - 3}" class="note">gate (provisional)</text>
      <text x="${px((DR.y0 + DR.y1) / 2)}" y="${py(0) + 10}" class="note mid">drain?</text>
      <text x="${px(mid[0]) + 8}" y="${py(mid[1]) + 14}" class="note warn">rise ${f2(am.rise)} m / run ${f2(am.run)} m · avg ${am.averageGradientPct.toFixed(1)}% · max ${am.maxLocalGradientPct.toFixed(1)}%</text>
      <text x="${px(mid[0]) + 8}" y="${py(mid[1]) + 25}" class="note warn">clearance UNCHECKED · waiting car on the ramp</text>
      ${ticks.join('')}
      <text x="${padL}" y="${h - 2}" class="tick-t start">metres from the symbolic frontage line · road (left) → carport rear (right)</text>
      ${tagSvg}
    </svg>
    <div class="profile-foot">Drawn-shape arithmetic only — not bumper, breakover, gradient-compliance, retaining or drainage checks.</div>`;
  if (!hasRoute(plan)) { el.innerHTML = driveHtml; return; }
  // V2.2+: tabs for the pedestrian-route section (default) and the driveway profile; V2.4 adds the frontage section and the carport walk
  if (isV24(plan)) {
    const sec = ['frontage', 'drive', 'walk', 'route'].includes(section) ? section : 'frontage';
    const tabs = [['frontage', 'Frontage'], ['drive', 'Carport A / B'], ['walk', 'Carport walk'], ['route', 'Street route']]
      .map(([k, n]) => `<button type="button" role="tab" data-section="${k}" aria-selected="${sec === k}">${n}</button>`).join('');
    const body = sec === 'frontage' ? frontageSectionPanel(plan, land) : sec === 'drive' ? driveSectionPanel(plan, land) : sec === 'walk' ? carportWalkPanel(plan, land) : routeSectionPanel(plan, land);
    el.innerHTML = `<div class="profile-tabs" role="tablist" aria-label="Section shown">${tabs}</div>${body}`;
    return;
  }
  const sec = section === 'drive' ? 'drive' : 'route';
  const tabs = [['route', 'Pedestrian route'], ['drive', 'Driveway']]
    .map(([k, n]) => `<button type="button" role="tab" data-section="${k}" aria-selected="${sec === k}">${n}</button>`).join('');
  el.innerHTML = `<div class="profile-tabs" role="tablist" aria-label="Section shown">${tabs}</div>${sec === 'route' ? routeSectionPanel(plan, land) : isFrontGate(plan) ? driveSectionPanel(plan, land) : driveHtml}`;
}

// ---------- assumptions, areas and references panel ----------
export function renderInfoV2(plan, land, assetNote, { f2, signed, esc }) {
  const A = areas(plan), lv = levels(plan, land);
  const rows = A.enclosedRooms.map(r => `<tr><td>${esc(r.label)}</td><td>${r.multiCell ? 'L-shaped · ' : `${f2(r.clearW)} × ${f2(r.clearD)} = `}${f2(r.clearArea)} m²</td></tr>`).join('');
  const out = A.outdoor.map(o => `<tr><td>${esc(o.label)}</td><td>${f2(o.area)} m²</td></tr>`).join('');
  const evidence = plan.parameterEvidence;
  const P = plan.parameters;
  const prow = Object.entries(P).map(([k, v]) => `<tr><td>${esc(k)}<br><small>${esc(evidence[k] || '')}</small></td><td class="wrap">${esc(typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${typeof b === 'object' ? '…' : b}`).join(', ') : v)}</td></tr>`).join('');
  return `
    <p><b>${esc(plan.planFamily)} · ${esc(plan.revision)} · ${esc(plan.title)}</b></p>
    <p>${esc(plan.purpose)}</p>
    <p>${esc(plan.dimensions)}</p>
    <h3>References (priority order)</h3>
    <ul>${plan.references.map(r => `<li><b>${esc(r.id)}</b> — ${esc(r.role)}<br><small>${esc(r.file)} · sha256 ${esc(r.sha256.slice(0, 12))}…</small></li>`).join('')}</ul>
    <h3>Areas — ASSUMED model dimensions, not measured</h3>
    <table>
      <tr><td>Enclosed, to outer wall faces</td><td>${f2(A.enclosedGross)} m² ≈ ${Math.round(A.enclosedGrossSqft)} sq ft</td></tr>
      <tr><td>…without the utility room</td><td>${f2(A.enclosedGrossWithoutUtility)} m² ≈ ${Math.round(A.enclosedGrossWithoutUtilitySqft)} sq ft</td></tr>
      <tr><td>Preliminary exploration range</td><td>${f2(A.range.minM2)}–${f2(A.range.maxM2)} m² (1,200–1,500 sq ft)</td></tr>
      <tr><td>Room cells (wall centrelines)</td><td>${f2(A.cellTotal)} m²</td></tr>
      <tr><td>Clear floor, enclosed rooms</td><td>${f2(A.clearTotal)} m² ≈ ${Math.round(A.clearTotalSqft)} sq ft</td></tr>
      ${rows}${out}
    </table>
    <h3>Levels (distinct)</h3>
    <table>
      <tr><td>Road<br><small>${esc(plan.levels.road.evidence)}</small></td><td>${signed(lv.road)} m</td></tr>
      <tr><td>Driveway apron / crossing<br><small>${esc(plan.levels.apronAboveRoad.evidence)}</small></td><td>${signed(lv.apron)} m</td></tr>
      <tr><td>Land / front garden<br><small>${esc(plan.levels.land.evidence)}</small></td><td id="info-land">${signed(lv.land)} m</td></tr>
      <tr><td>Carport floor${hasCarportOptions(plan) ? ` — active option ${esc(activeCarportOption(plan).id)}` : ''}<br><small>${esc(hasCarportOptions(plan) ? plan.levels.carportFloor.evidence + ' ' + activeCarportOption(plan).evidence : plan.levels.carportAboveLand.evidence)}</small></td><td>${signed(lv.carport)} m</td></tr>
      ${lv.toe !== undefined ? `<tr><td>Retaining-face toe (drain-side ground)<br><small>${esc(plan.frontage.retainingEdge.toeEvidence)}</small></td><td>${signed(lv.toe)} m</td></tr>
      <tr><td>Top of the retaining edge / capping<br><small>${esc(plan.frontage.retainingEdge.faceEvidence)}</small></td><td>${signed(lv.edgeCap)} m</td></tr>
      <tr><td>Planting soil surface<br><small>${esc(plan.frontage.retainingEdge.soilEvidence)}</small></td><td>${signed(lv.strip)} m</td></tr>` : ''}
      <tr><td>House finished floor<br><small>${esc(plan.levels.finishedFloor.evidence)}</small></td><td id="info-ffl">${signed(lv.floor)} m</td></tr>
    </table>
    ${hasRoute(plan) ? routeInfo(plan, land, { f2, signed, esc }) : ''}
    ${isFrontGate(plan) ? gateInfo(plan, land, { f2, signed, esc }) : ''}
    ${isV24(plan) ? carportInfo(plan, land, { f2, signed, esc }) : ''}
    <h3>Unresolved items</h3>
    <ul>${currentIssueNotes(plan).map(i => `<li><b>${esc(i.title)}.</b> ${esc(i.text)}</li>`).join('')}</ul>
    <p>Future upper floor and PV relocation are recorded (R13–R15); ${esc(plan.gate.evidence)}</p>
    <h3>Parameters</h3>
    <table>${prow}</table>
    <p>Lighting direction is illustrative only; site orientation is unknown. Discrepancies between the reference images and this model are listed in ${hasRoute(plan) ? 'V2_1_DISCREPANCY_REGISTER-r01.md and, for the frontage and route, V2_2_FRONTAGE_ROUTE_REGISTER-r01.md' : 'V2_1_DISCREPANCY_REGISTER-r01.md'}.</p>
    <p id="asset-status">${esc(assetNote)}</p>`;
}

// V2.2+: owner answers, frontage components and the derived pedestrian route for the info panel.
function routeInfo(plan, land, { f2, signed, esc }) {
  const F = plan.frontage, lv = levels(plan, land), r = pedRoute(plan, land);
  const rows = [
    ['Road edge', `y ${f2(F.roadEdge.y)}`, signed(lv.road), F.roadEdge.evidence],
    ['Open drain', `y ${f2(F.drain.y0)} to ${f2(F.drain.y1)}`, `${f2(F.drain.depth)} m deep`, F.drain.evidence],
    ...(F.verge ? [['Verge', `y ${f2(F.verge.y0)} to ${f2(F.verge.y1)}`, signed(lv.verge), `${F.verge.ownership}. ${F.verge.evidence}`]] : [['Verge', 'REMOVED in V2.4', '—', 'The broad verge band between the drain and the planting strip is deleted (not recoloured).']]),
    ...(F.retainingEdge ? [['Raised retaining edge', `y ${f2(F.retainingEdge.y0)}, face ${f2(F.retainingEdge.visibleFace)} m`, `toe ${signed(lv.toe)} → capping ${signed(lv.edgeCap)}`, F.retainingEdge.faceEvidence]] : []),
    ['Lower planting strip', `y ${f2(F.plantingStrip.y0)} to ${f2(F.plantingStrip.y1)}`, signed(lv.strip), `${F.plantingStrip.ownership ?? 'Ownership UNKNOWN — may be road reserve'}. ${F.plantingStrip.evidence}`],
    ['Main wall', `y ${f2(F.mainWall.y0)} to ${f2(F.mainWall.y1)}`, `top ${signed(lv.yard + F.mainWall.topAboveGarden)}`, F.mainWall.evidence],
    ['Raised garden', `from y ${f2(F.mainWall.y1)}`, signed(lv.yard), F.raisedGarden.evidence],
  ].map(([n, where, l, e]) => `<tr><td>${esc(n)} · ${esc(where)}<br><small>${esc(e)}</small></td><td>${esc(l)}</td></tr>`).join('');
  const comps = [
    [r.crossing.label, `${f2(r.crossing.rect.y1 - r.crossing.rect.y0)} m`, signed(r.crossing.level)],
    [r.bottom.label, `${f2(r.bottom.rect.y1 - r.bottom.rect.y0)} m`, signed(r.bottom.level)],
    [`Flight, ${r.flight.risers} × ${(r.flight.riser * 1000).toFixed(0)} mm`, `${f2(r.flight.rect.y1 - r.flight.rect.y0)} m`, `${signed(r.flight.from)} → ${signed(r.flight.to)}`],
    [r.upper.label, `${f2(r.upper.rect.y1 - r.upper.rect.y0)} m`, signed(r.upper.level)],
    [r.path.label, `${f2(r.path.length)} m`, signed(r.path.level)],
    [`Porch steps, ${r.porchSteps.risers} × ${(r.porchSteps.riser * 1000).toFixed(0)} mm`, `${f2(r.porchSteps.rect.y1 - r.porchSteps.rect.y0)} m`, `${signed(r.porchSteps.from)} → ${signed(r.porchSteps.to)}`],
    [r.porch.label, `${f2(r.porch.rect.y1 - r.porch.rect.y0)} m`, signed(r.porch.level)],
  ].map(([n, l, z]) => `<tr><td>${esc(n)} · ${esc(l)}</td><td>${esc(z)}</td></tr>`).join('');
  return `
    ${plan.ownerAnswers.items.length ? `<h3>Owner answers recorded 2026-10-22</h3><ul>${plan.ownerAnswers.items.map(a => `<li>${esc(a.answer)} <small>(${esc(a.affects)})</small></li>`).join('')}</ul>` : ''}
    <h3>Frontage components (road → garden)</h3>
    <table>${rows}</table>
    <h3>Pedestrian route at this land level (derived from the flight)</h3>
    <table>${comps}</table>
    <p>${esc(plan.route.evidence)}</p>`;
}

// V2.3+: gate study, waiting car, compaction and the conceptual envelope for the info panel.
function gateInfo(plan, land, { f2, signed, esc }) {
  const gs = gateStudy(plan, land), geo = gs.geo, w = gs.waiting, gm = gardenMetrics(plan), E = envelopeMetrics(plan), pp = plan.compaction.parent;
  const opts = gs.options.map(o => `<tr><td>${esc(o.label)}<br><small>needs ${esc(o.required)}. ${o.conflicts.length ? esc(o.conflicts.map(c => c.text).join('; ')) : 'No footprint conflict in the drawn geometry — not declared workable.'}</small></td><td>${o.conflicts.length ? o.conflicts.length + ' conflict' + (o.conflicts.length > 1 ? 's' : '') : 'clear*'}</td></tr>`).join('');
  return `
    <h3>Front-line gate — derived, NOT DEMONSTRATED</h3>
    <table>
      <tr><td>Gate line y<br><small>${esc(plan.gate.evidence)}</small></td><td>${f2(plan.gate.y)}</td></tr>
      <tr><td>Base (driveway surface at the gate line)</td><td>${signed(geo.base)} m</td></tr>
      <tr><td>Leaf bottom → top above the datum</td><td>${f2(geo.bottom)} → ${f2(geo.top)} m</td></tr>
      <tr><td>Below the garden / carport floor</td><td>${f2(geo.belowGarden)} / ${f2(geo.belowCarport)} m</td></tr>
      <tr><td>Opening / beside the ASSUMED car</td><td>${f2(geo.opening)} / ${f2(geo.spare)} m</td></tr>
      ${opts}
    </table>
    <p>* ${esc(plan.gate.verdict)}.</p>
    <h3>Waiting car outside the closed gate</h3>
    <table>
      <tr><td>Footprint (generic ASSUMED envelope)</td><td>y ${f2(w.y0)} to ${f2(w.y1)}</td></tr>
      <tr><td>Off-road length between gate and road edge</td><td>${f2(w.available)} m of ${f2(w.length)} m</td></tr>
      <tr><td>Into the carriageway (display width, not measured)</td><td>${f2(w.encroach)} m</td></tr>
      <tr><td>${plan.frontage.verge ? 'On the drain crossing / the verge' : 'On the drain crossing / the apron (no verge)'}</td><td>${f2(w.overDrain)} / ${f2(plan.frontage.verge ? w.overVerge : w.overApron)} m</td></tr>
    </table>
    <p>Automatic opening does not establish adequate waiting space.</p>
    <h3>${isV24(plan) ? 'Compact garden (preserved from V2.3) and conceptual envelope' : 'Compact trial (ASSUMED) and conceptual envelope'}</h3>
    <table>
      <tr><td>Drawn lawn + beds (${esc(pp.revision ?? 'V2.2')} → now)</td><td>${f2(pp.gardenAreaM2)} → ${f2(gm.area)} m² (${(100 * (gm.area / pp.gardenAreaM2 - 1)).toFixed(1)}%)</td></tr>
      <tr><td>Depth to the porch / the house wall</td><td>${f2(pp.depthToPorchM)} → ${f2(gm.depthToPorch)} m / ${f2(pp.depthToHouseWallM)} → ${f2(gm.depthToHouseWall)} m</td></tr>
      <tr><td>Conceptual envelope (not the parcel)</td><td>${f2(E.w)} × ${f2(E.d)} m, aspect ${f2(E.aspect)}</td></tr>
    </table>
    <p>${esc(plan.site.conceptualEnvelope.evidence)} ${esc(plan.site.landShape.evidence)}</p>
    <p>${esc(plan.compaction.evidence)}</p>`;
}

// V2.4+: carport alternatives A / B, the carport walking route and the frontage before / after for the info panel.
function carportInfo(plan, land, { f2, signed, esc }) {
  const cmp = carportComparison(plan, land), active = carportStudy(plan, land), cr = active.route, F = plan.frontage, pf = plan.derivedFrom;
  const cols = cmp.map(c => `<td><b>${esc(c.option)}</b></td>`).join('');
  const row = (n, f) => `<tr><td>${esc(n)}</td>${cmp.map(c => `<td>${f(c)}</td>`).join('')}</tr>`;
  const sd = n => `${n >= 0 ? '+' : '−'}${f2(Math.abs(n))} m`;
  return `
    <h3>Carport alternatives at land ${signed(land)} m (provisional geometry comparison)</h3>
    <table>
      <tr><td></td>${cols}</tr>
      ${row('Carport floor', c => signed(c.levels.carport))}
      ${row('Road / apron → garden / house floor', c => `${signed(c.levels.apron)} → ${signed(c.levels.yard)} / ${signed(c.levels.floor)}`)}
      ${row('Vehicle climb: rise / run', c => `${f2(c.rise)} / ${f2(c.run)} m`)}
      ${row('Average / steepest gradient', c => `${c.averageGradientPct.toFixed(1)}% / ${c.maxLocalGradientPct.toFixed(1)}%`)}
      ${row('Transitions (bottom / straight / top)', c => `${f2(c.transitions.bottom)} / ${f2(c.transitions.straight)} / ${f2(c.transitions.top)} m`)}
      ${row('Carport → garden', c => `${sd(c.gardenDiff)} = ${c.gardenSteps} ${c.gardenDirection === 'up' ? 'risers up' : 'riser down'}`)}
      ${row('Carport → house floor (service door)', c => `${sd(c.houseDiff)} = ${c.serviceSteps} risers`)}
      ${row('Headroom under the retained canopy', c => `${f2(c.headroom)} m`)}
      ${row('Findings (flagged)', c => esc(c.conflicts.map(q => q.id.replace('carport:', '')).join(', ')))}
    </table>
    <p>${esc(plan.levels.carportFloor.evidence)} Neither alternative is a vehicle-clearance, drainage, excavation or retaining finding.</p>
    <h3>Carport walking route (active option ${esc(active.option)})</h3>
    <table>
      <tr><td>Walking strip beside the car</td><td>${f2(cr.strip.rect.x1 - cr.strip.rect.x0)} m wide, ${signed(cr.strip.level)}</td></tr>
      <tr><td>Level landing (stands up to ${f2(cr.platform.proud)} m above the ramp edge)</td><td>${signed(cr.platform.level)}</td></tr>
      <tr><td>Garden steps ${cr.flight.direction}</td><td>${cr.flight.risers} × ${(Math.abs(cr.flight.riser) * 1000).toFixed(0)} mm → ${signed(cr.upper.level)}</td></tr>
      <tr><td>Garden path (house front)</td><td>${f2(cr.path.length)} m at ${signed(cr.path.level)}</td></tr>
      <tr><td>West porch steps</td><td>${cr.westSteps.risers} × ${(cr.westSteps.riser * 1000).toFixed(0)} mm → ${signed(cr.westLanding.level)}</td></tr>
      <tr><td>Utility service landing + steps</td><td>${cr.service.flight.risers} × ${(cr.service.flight.riser * 1000).toFixed(0)} mm → ${signed(cr.service.landing.level)}</td></tr>
    </table>
    <p>${esc(plan.carportRoute.evidence)}</p>
    <h3>V2.4 coordinate shifts</h3>
    <ul>${pf.coordinateShifts.map(c => `<li>${esc(c.text)}</li>`).join('')}</ul>
    <p>${esc(plan.scaleFigure.evidence)}</p>`;
}
