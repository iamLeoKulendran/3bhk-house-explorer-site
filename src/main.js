// Interactive House Explorer — reusable viewer. Plan data lives in data/plans/<id>.json;
// this file only interprets it (through geometry.js) as Plan, Aerial and Cutaway views,
// plus a schematic approach profile when the dataset has a site.access scenario.
// V2 datasets (schema house-plan/2) are built by build-v2.js through geometry-v2.js and add a Front view
// and a Roof control; the viewer shell, labels, views, transitions and local assets are shared.
// URL options: ?plan=<id>  &view=plan|aerial|cutaway|front|frontage (front: V2; frontage: datasets with views.frontage)
//              &from=<view> (animate from that view)  &section=route|drive (V2.2+ profile panel)
//              &carport=A|B (V2.4: carport floor alternative, A = V2.3 level, B = lower)
//              &warnings=0 (start with the issue list collapsed)  V2.3 views: plan, aerial, cutaway, front, frontage, gate; the whole site is framed in the part of the window not covered by the controls and panels
//              &land=<metres within the plan's range>  &dims=1  &labels=0  &tags=1 (detail labels)
//              &profile=0  &details=1 (open the info panel)  &break=assets (asset-failure test)

import * as THREE from 'three';
import { OrbitControls } from '../vendor/three-0.180.0/OrbitControls.js';
import { GLTFLoader } from '../vendor/three-0.180.0/loaders/GLTFLoader.js';
import {
  validate, areas, wallPieces, wallBand, pieceRect, compositionBox,
  accessLayout, accessReport, accessProfile, rampHeight,
} from './geometry.js';
import * as G2 from './geometry-v2.js';
import { buildV2, renderInfoV2, renderProfileV2 } from './build-v2.js';

const DEFAULT_PLAN = 'v2-7-open-living-utility-hall';   // owner instruction 2026-10-24 (D53); earlier datasets open with ?plan=<id>
const params = new URLSearchParams(location.search);
const planId = params.get('plan') || DEFAULT_PLAN;
if (!/^[a-z0-9-]+$/.test(planId)) throw new Error(`invalid plan id "${planId}"`);
const response = await fetch(`data/plans/${planId}.json`);
if (!response.ok) throw new Error(`plan ${planId} could not be loaded (${response.status})`);
const plan = await response.json();

const IS_V2 = plan.schema === 'house-plan/2';
const P = plan.parameters;
// V2: the scene is centred on the enclosed rooms; plan y (into the site) maps to scene −z (road is +z).
const v2HouseBox = () => {
  const cells = plan.rooms.filter(G2.isEnclosed).flatMap(G2.roomCells);
  return { x0: Math.min(...cells.map(c => c.x0)), x1: Math.max(...cells.map(c => c.x1)), z0: Math.min(...cells.map(c => c.y0)), z1: Math.max(...cells.map(c => c.y1)) };
};
const E = IS_V2 ? v2HouseBox() : plan.envelope;
const report = IS_V2 ? G2.validate(plan) : validate(plan);
const area = IS_V2 ? G2.areas(plan) : areas(plan);
const comp = IS_V2 ? { x0: plan.site.display.x0, x1: plan.site.display.x1, z0: plan.site.display.y0, z1: plan.site.display.y1 } : compositionBox(plan);
const access = IS_V2 ? null : accessLayout(plan);
const vehicle = P.vehicleEnvelope ?? P.placeholderCar;
// V2 custom camera views: every plan.views entry with a position (front, frontage, gate …) is a view
const CUSTOM_VIEWS = IS_V2 ? Object.keys(plan.views ?? {}).filter(k => plan.views[k]?.position && k !== 'front') : [];
const VIEWS = IS_V2 ? ['plan', 'aerial', 'cutaway', 'front', ...CUSTOM_VIEWS] : ['plan', 'aerial', 'cutaway'];
const FRAME = IS_V2 && plan.views?.frameFreeArea === true;   // V2.3: frame the site inside the free part of the window
const PLAN_WALL_HEIGHT = 0.04;
const HAS_CARPORT = IS_V2 && G2.hasCarportOptions(plan);   // V2.4: independent carport floor, alternatives A / B
if (HAS_CARPORT && ['A', 'B'].includes(params.get('carport'))) plan.levels.carportFloor.active = params.get('carport');
const viewHeight = new Proxy({ plan: PLAN_WALL_HEIGHT, aerial: P.wallHeight, cutaway: P.cutawayHeight, front: P.wallHeight, ...Object.fromEntries(CUSTOM_VIEWS.filter(k => plan.views[k].cutaway).map(k => [k, P.cutawayHeight])) }, { get: (t, k) => t[k] ?? P.wallHeight });

const ZONE_COLOURS = {
  social: 0xf1dfb8, private: 0xd9e4f0, wet: 0xc9e3e1,
  service: 0xead9c9, circulation: 0xecebe5, future: 0xe4d6ec,
};
const ZONE_NAMES = {
  social: 'Living / dining', private: 'Bedrooms', wet: 'Bathrooms', service: 'Kitchen / utility',
  circulation: 'Hall', future: 'Future stair reserve',
};

// Scene coordinates centre the house envelope at the origin; plan z (toward the road) stays +z.
const ox = (E.x0 + E.x1) / 2, oz = (E.z0 + E.z1) / 2;
const X = x => x - ox, Z = IS_V2 ? (y => oz - y) : (z => z - oz);

const landParam = Number(params.get('land'));
const state = {
  land: Number.isFinite(landParam) && params.has('land')
    ? THREE.MathUtils.clamp(landParam, plan.levels.land.min, plan.levels.land.max) : plan.levels.land.default,
  h: PLAN_WALL_HEIGHT,
  view: VIEWS.includes(params.get('view')) ? params.get('view') : 'plan',
  roofOverride: null,   // V2: null = follow the view (hidden in Plan/Cutaway), true/false = the Roof checkbox
  railing: params.get('railing') !== '0',   // V2.5: optional steel roof railing (shown with the roof)
  section: params.get('section') ?? (HAS_CARPORT ? 'frontage' : plan.gate?.alignedTo === 'mainWall' ? 'drive' : 'route'),   // V2.2+ profile panel tab
  warningsOpen: params.get('warnings') === '0' ? false : innerWidth > 760,
};
const ffl = () => state.land + P.plinthHeight;

// ---------- renderer, camera, controls ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0xf3f0e8);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 600);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 3;
controls.maxDistance = 150;

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc6b4, 1.9));
const sun = new THREE.DirectionalLight(0xfff6e6, 2.1);   // illustrative direction; site orientation unknown
sun.position.set(-14, 26, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// ---------- local assets (optional; every failure falls back and is reported) ----------
const assetPrefix = params.get('break') === 'assets' ? 'missing-assets-test/' : '';
const assetFailures = [];
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const why = e => String(e?.message ?? e?.type ?? e);

async function loadModel(spec) {
  if (!spec) return null;
  try {
    const gltf = await gltfLoader.loadAsync(assetPrefix + spec.file);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    return { scene: gltf.scene, box };
  } catch (e) {
    assetFailures.push(`${spec.file}: ${why(e)}`);
    return null;
  }
}
async function loadMaterialSet(spec) {
  if (!spec) return null;
  const file = suffix => `${assetPrefix}${spec.dir}/${spec.name}_${suffix}_1k.jpg`;
  try {
    const [map, normalMap, roughnessMap] = await Promise.all(['diff', 'nor_gl', 'rough'].map(s => texLoader.loadAsync(file(s))));
    map.colorSpace = THREE.SRGBColorSpace;   // base colour only; normal/roughness stay linear data
    for (const t of [map, normalMap, roughnessMap]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return { map, normalMap, roughnessMap, tile: spec.tileMetres };
  } catch (e) {
    assetFailures.push(`${spec.dir}: ${why(e)}`);
    return null;
  }
}
const [carAsset, plantAsset, pavingSet, stuccoSet, stoneSet, woodSet] = await Promise.all([
  loadModel(P.carModel), loadModel(P.plantModel),
  loadMaterialSet(P.materials?.paving), loadMaterialSet(P.materials?.stucco),
  loadMaterialSet(P.materials?.stone), loadMaterialSet(P.materials?.wood),
]);

// Textured material with tile repeat for a w × h metre face (texture clones share one image).
function texturedMaterial(set, w, h, fallbackColour, extra = {}) {
  if (!set) return std(fallbackColour, extra);
  const rep = t => { const c = t.clone(); c.repeat.set(w / set.tile, h / set.tile); c.needsUpdate = true; return c; };
  return new THREE.MeshStandardMaterial({
    map: rep(set.map), normalMap: rep(set.normalMap), roughnessMap: rep(set.roughnessMap),
    normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0, ...extra,
  });
}

// ---------- materials ----------
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, ...extra });
function hatchTexture(bg, fg, px = 16) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = fg; g.lineWidth = 3;
  for (let i = -64; i < 128; i += px) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 64, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const M = {
  wallSide: std(0xfbfaf6),
  wallTop: std(0x2c2f34, { roughness: 1 }),
  plinth: std(0xd6d1c6),
  landTop: std(0xe7e0cd),
  landSide: std(0xd4cbb4),
  ground: std(0xe9e6dd),
  verge: std(0xcdd6c0),
  drain: std(0x4d5357),
  road: std(0x6f7377),
  roadLine: std(0xf4f1e8),
  carportSlab: std(0xcfcfca),
  ramp: std(0xc9c2b2, { side: THREE.DoubleSide }),
  post: std(0xf6f5f1),
  gate: std(0x3b4046, { roughness: 0.7 }),
  canopy: std(0xffffff, { transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  car: std(0x8f969d, { roughness: 0.6 }),
  envelope: new THREE.MeshBasicMaterial({ color: 0x2f6fa3, transparent: true, opacity: 0.12, depthWrite: false }),
  garden: std(0xaecb92),
  threshold: std(0xbdb5a5),
  glassPlan: std(0x6fa8c9),
  hinge: std(0x3b4047),
  useZone: new THREE.MeshBasicMaterial({ color: 0x1f9d8f, transparent: true, opacity: 0.22, depthWrite: false }),
  useDoor: new THREE.MeshBasicMaterial({ color: 0xe08a1e, transparent: true, opacity: 0.3, depthWrite: false }),
  warn: new THREE.MeshBasicMaterial({ color: 0xd2553b, transparent: true, opacity: 0.75 }),
  conflict: new THREE.MeshBasicMaterial({ color: 0xd2553b, transparent: true, opacity: 0.38, depthWrite: false }),
};
const unresolvedTex = hatchTexture('#f6e3c9', '#d9823f');
const futureTex = hatchTexture('#ece2f1', '#b9a3c9', 12);
function hatchMaterial(w, h) {
  const t = unresolvedTex.clone();
  t.repeat.set(Math.max(w, 0.1) / 1.2, Math.max(h, 0.1) / 1.2);
  t.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
}

// ---------- scene construction (rebuilt when the land level changes) ----------
const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
let world = null;
let heightBound = [];    // meshes whose visible height follows the current view height
let aboveCut = [];       // canopies: only shown when walls are near full height
let roofObjects = [];    // V2: roof slabs, parapets, canopies and PV; hidden in Plan/Cutaway or by the Roof control
let railObjects = [];    // V2.5: optional steel roof railing (a subset of roofObjects)
let planOnly = [];       // door swings: plan view only
let dimObjects = [];
let labels = [];
let warnings = [];       // { text, at: Vector3 | null }
let accessNow = null;    // accessReport for the current land level

function box(mat, x0, z0, x1, z1, y0, y1) {
  const m = new THREE.Mesh(unitBox, mat);
  m.scale.set(x1 - x0, y1 - y0, z1 - z0);
  m.position.set(X((x0 + x1) / 2), y0, Z((z0 + z1) / 2));
  m.castShadow = m.receiveShadow = true;
  return m;
}
function flat(mat, x0, z0, x1, z1, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(X((x0 + x1) / 2), y, Z((z0 + z1) / 2));
  m.receiveShadow = true;
  return m;
}
function dashed(points, color, dash = 0.35) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new THREE.Vector3(X(x), y, Z(z))));
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: dash * 0.7 }));
  line.computeLineDistances();
  return line;
}
function solidLine(points, color) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new THREE.Vector3(X(x), y, Z(z))));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
}
function envelopeBox(rect, y0, height, color = 0x2f6fa3) {
  const g = new THREE.Group();
  g.add(box(color === 0x2f6fa3 ? M.envelope : M.conflict, rect.x0, rect.z0, rect.x1, rect.z1, y0, y0 + height));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(rect.x1 - rect.x0, height, rect.z1 - rect.z0)),
    new THREE.LineBasicMaterial({ color }));
  edges.position.set(X((rect.x0 + rect.x1) / 2), y0 + height / 2, Z((rect.z0 + rect.z1) / 2));
  g.add(edges);
  g.children[0].castShadow = false;
  return g;
}

// Labels: tier 'warn' (numbered badges, always shown), 'core' (Labels toggle), 'detail'
// (Detail labels toggle), 'dim' (Provisional dimensions toggle). Lower priority number wins
// when labels would overlap on screen.
function addLabel(html, cls, x, y, z, tier = 'core', priority = 3, title = '') {
  const el = document.createElement('div');
  el.className = `label ${cls}`;
  el.innerHTML = html;
  if (title) el.title = title;
  document.getElementById('labels').appendChild(el);
  labels.push({ el, tier, priority, pos: new THREE.Vector3(X(x), y, Z(z)), w: 0, h: 0, active: true });
}
const f2 = n => n.toFixed(2);
const signed = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function placeModel(asset, cx, cz, baseY, { fit, rotateY = 0 } = {}) {
  const size = asset.box.getSize(new THREE.Vector3());
  const centre = asset.box.getCenter(new THREE.Vector3());
  const s = fit ? Math.min(fit.length / size.z, fit.width / size.x, fit.height / size.y) : 1;
  const obj = asset.scene.clone(true);
  obj.scale.setScalar(s);
  obj.rotation.y = rotateY;
  const c = centre.clone().multiplyScalar(s).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotateY);
  obj.position.set(X(cx) - c.x, baseY - asset.box.min.y * s, Z(cz) - c.z);
  obj.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return obj;
}
// The parked car: generic model scaled uniformly to fit inside the ASSUMED envelope, front
// (native +z) turned to face rearward (−z) as if driven in nose first. Fallback: a plain box.
function parkedCar(rect, baseY) {
  const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
  if (carAsset) return placeModel(carAsset, cx, cz, baseY, { fit: vehicle, rotateY: Math.PI });
  return box(M.car, cx - vehicle.width / 2, cz - vehicle.length / 2, cx + vehicle.width / 2, cz + vehicle.length / 2, baseY, baseY + vehicle.height);
}

// V2 hatch for the reserved stair box (same pattern as the V1 future-stair reserve).
function futureHatch(w, h) {
  const m = std(0xffffff, { map: futureTex.clone() });
  m.map.repeat.set(w / 0.8, h / 0.8);
  m.map.needsUpdate = true;
  return m;
}

function buildWorldV2() {
  if (world) {
    scene.remove(world);
    world.traverse(o => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
  }
  document.getElementById('labels').replaceChildren();
  heightBound = []; aboveCut = []; planOnly = []; dimObjects = []; labels = []; warnings = []; roofObjects = [];
  const reg = buildV2({
    plan, land: state.land, X, Z, std, M, box, flat, dashed, solidLine, envelopeBox, addLabel, texturedMaterial, placeModel,
    unitBox, esc, f2, signed, hatch: futureHatch,
    assets: { car: carAsset, plant: plantAsset, paving: pavingSet, stucco: stuccoSet, stone: stoneSet, wood: woodSet },
  });
  world = reg.world;
  heightBound = reg.heightBound; planOnly = reg.planOnly; dimObjects = reg.dimObjects; roofObjects = reg.roofObjects; warnings = reg.warnings;
  railObjects = reg.railObjects ?? [];
  document.getElementById('railing-toggle').hidden = !railObjects.length;
  scene.add(world);
  warnings.forEach((w, i) => { if (w.at) addLabel(`${i + 1}`, 'badge', w.at[0], w.at[1], w.at[2], 'warn', 0, w.title ? `${w.title}: ${w.text}` : w.text); });
  applyHeight();
  applyToggles();
  renderWarnings();
  renderProfile();
}

function build() {
  if (IS_V2) { buildWorldV2(); return; }
  if (world) {
    scene.remove(world);
    world.traverse(o => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
  }
  document.getElementById('labels').replaceChildren();
  heightBound = []; aboveCut = []; planOnly = []; dimObjects = []; labels = []; warnings = [];
  world = new THREE.Group();
  const site = plan.site;
  const land = state.land, floor = ffl();
  const margin = P.landMarginShown;
  const lx0 = comp.x0 - margin, lx1 = comp.x1 + margin, lz0 = comp.z0 - margin;
  accessNow = access ? accessReport(plan, land) : null;
  const L = access;
  const cp = site.carport;

  // Ground, road (assumed datum 0), verge with a symbolic drain line, and the raised land.
  world.add(flat(M.ground, lx0 - 30, lz0 - 30, lx1 + 30, site.roadEdgeZ + P.roadDepthShown + 30, -0.01));
  world.add(flat(M.verge, lx0 - 30, site.landEdgeZ, lx1 + 30, site.roadEdgeZ, 0.002));
  if (L) {
    const dz = (site.landEdgeZ + site.roadEdgeZ) / 2;
    world.add(flat(M.drain, lx0 - 30, dz - 0.06, lx1 + 30, dz + 0.06, 0.003));
  }
  world.add(flat(M.road, lx0 - 30, site.roadEdgeZ, lx1 + 30, site.roadEdgeZ + P.roadDepthShown, 0.004));
  for (let x = lx0 - 30; x < lx1 + 30; x += 3) {
    const zc = site.roadEdgeZ + P.roadDepthShown / 2;
    world.add(flat(M.roadLine, x, zc - 0.06, x + 1.6, zc + 0.06, 0.006));
  }
  // Raised land: one block (V1.1) or three blocks around the approach cut (access scenario).
  const landBlocks = L
    ? [
      { x0: lx0, x1: lx1, z0: lz0, z1: cp.z1, cutFaces: [] },
      { x0: lx0, x1: L.corridor.x0, z0: cp.z1, z1: site.landEdgeZ, cutFaces: [0] },   // +x face toward the cut
      { x0: L.corridor.x1, x1: lx1, z0: cp.z1, z1: site.landEdgeZ, cutFaces: [1] },   // −x face toward the cut
    ]
    : [{ x0: lx0, x1: lx1, z0: lz0, z1: site.landEdgeZ, cutFaces: [] }];
  for (const b of landBlocks) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const mats = [M.landSide, M.landSide, M.landTop, M.landSide, M.landSide, M.landSide];
    if (near(b.z1, site.landEdgeZ)) mats[4] = hatchMaterial(w, land);
    for (const f of b.cutFaces) mats[f] = hatchMaterial(d, land);
    const block = new THREE.Mesh(unitBox, mats);
    block.scale.set(w, land, d);
    block.position.set(X((b.x0 + b.x1) / 2), 0, Z((b.z0 + b.z1) / 2));
    block.receiveShadow = block.castShadow = true;
    world.add(block);
  }

  // House plinth up to the assumed finished floor, room floors and thresholds.
  world.add(box(M.plinth, E.x0, E.z0, E.x1, E.z1, land, floor));
  for (const r of plan.rooms) {
    let mat = std(ZONE_COLOURS[r.zone] ?? 0xeeeeee);
    if (r.zone === 'future') {
      mat = std(0xffffff, { map: futureTex.clone() });
      mat.map.repeat.set((r.x1 - r.x0) / 0.8, (r.z1 - r.z0) / 0.8);
      mat.map.needsUpdate = true;
    }
    world.add(flat(mat, r.x0, r.z0, r.x1, r.z1, floor + 0.002));
  }

  // Walls and lintels: one box per piece; the visible height follows the current view.
  // Exterior pieces get the stucco texture on their faces when it loaded.
  for (const p of wallPieces(plan, report.openings)) {
    const [x0, z0, x1, z1] = pieceRect(p);
    let side = M.wallSide;
    if (p.exterior && stuccoSet) side = texturedMaterial(stuccoSet, Math.max(x1 - x0, z1 - z0), P.wallHeight, 0xfbfaf6);
    const mesh = new THREE.Mesh(unitBox, [side, side, M.wallTop, side, side, side]);
    mesh.position.set(X((x0 + x1) / 2), floor + p.y0, Z((z0 + z1) / 2));
    mesh.scale.set(x1 - x0, 1, z1 - z0);
    mesh.castShadow = mesh.receiveShadow = true;
    world.add(mesh);
    heightBound.push({ mesh, y0: p.y0, y1: p.y1, base: floor });
  }

  // Openings: thresholds and plan door swings for those that fit; red markers + numbered
  // warnings for those that do not.
  const spaces = Object.fromEntries([...plan.rooms, { id: 'entry', ...site.entry }].map(s => [s.id, s]));
  for (const o of report.openings) {
    if (!o.edge) continue;
    const e = o.edge, half = (P.interiorWallThickness + 0.05) / 2;
    if (o.fits) {
      const a = o.centre - o.width / 2, b = o.centre + o.width / 2;
      const [t0, t1] = wallBand(plan, o.line);
      world.add(e.axis === 'x' ? flat(M.threshold, t0, a, t1, b, floor + 0.004) : flat(M.threshold, a, t0, b, t1, floor + 0.004));
      if (o.kind !== 'opening') {
        const into = spaces[o.between[1]];
        const dir = e.axis === 'x' ? Math.sign((into.x0 + into.x1) / 2 - e.at) : Math.sign((into.z0 + into.z1) / 2 - e.at);
        const pts = [];
        for (let i = 0; i <= 16; i++) {
          const ang = (i / 16) * Math.PI / 2;
          const u = Math.cos(ang) * o.width, v = Math.sin(ang) * o.width * dir;
          pts.push(e.axis === 'x' ? [e.at + v, floor + PLAN_WALL_HEIGHT + 0.01, a + u] : [a + u, floor + PLAN_WALL_HEIGHT + 0.01, e.at + v]);
        }
        const hinge = e.axis === 'x' ? [e.at, floor + PLAN_WALL_HEIGHT + 0.01, a] : [a, floor + PLAN_WALL_HEIGHT + 0.01, e.at];
        const swing = new THREE.Group();
        swing.add(solidLine([hinge, pts[16]], 0x555b63), dashed(pts, 0x8a9099, 0.08));
        world.add(swing);
        planOnly.push(swing);
      }
    } else {
      world.add(e.axis === 'x' ? flat(M.warn, e.at - half, e.from, e.at + half, e.to, floor + 0.05)
        : flat(M.warn, e.from, e.at - half, e.to, e.at + half, floor + 0.05));
      const [na, nb] = o.between.map(id => spaces[id].label);
      const mx = e.axis === 'x' ? e.at : (e.from + e.to) / 2, mz = e.axis === 'x' ? (e.from + e.to) / 2 : e.at;
      warnings.push({ text: `${na}–${nb}: no ${o.kind} fits (${f2(Math.max(o.usable, 0))} m of wall usable)`, at: [mx, floor + 0.3, mz] });
    }
  }
  for (const id of report.unreachable) {
    const r = plan.rooms.find(q => q.id === id);
    // Badge in the room's front corner, clear of the room name label.
    warnings.push({ text: `${r.label} has no usable opening from the entrance`, at: [r.x0 + 0.45, floor + 0.3, r.z1 - 0.45] });
  }

  // Entrance pad (land → finished floor) and canopy.
  const en = site.entry;
  world.add(box(M.plinth, en.x0, en.z0, en.x1, en.z1, land, floor));
  const entryCanopy = box(M.post, en.x0 - 0.15, en.z0, en.x1 + 0.15, en.z1 + 0.15, floor + P.entryCanopyHeight, floor + P.entryCanopyHeight + 0.14);
  world.add(entryCanopy);
  aboveCut.push(entryCanopy);
  for (const x of [en.x0 + 0.1, en.x1 - 0.22]) {
    const post = box(M.post, x, en.z1 - 0.2, x + 0.12, en.z1 - 0.08, 0, P.entryCanopyHeight);
    post.position.y = floor;
    world.add(post);
    heightBound.push({ mesh: post, y0: 0, y1: P.entryCanopyHeight, base: floor });
  }

  // Carport at assumed land level, car, posts and translucent cover.
  const cpDepth = cp.z1 - cp.z0, cpWidth = cp.x1 - cp.x0;
  const slabTop = texturedMaterial(pavingSet, cpWidth, cpDepth, 0xcfcfca);
  const cpSlab = new THREE.Mesh(unitBox, [M.carportSlab, M.carportSlab, slabTop, M.carportSlab, M.carportSlab, M.carportSlab]);
  cpSlab.scale.set(cpWidth, 0.03, cpDepth);
  cpSlab.position.set(X((cp.x0 + cp.x1) / 2), land, Z((cp.z0 + cp.z1) / 2));
  cpSlab.receiveShadow = true;
  world.add(cpSlab);
  const ccx = (cp.x0 + cp.x1) / 2, ccz = (cp.z0 + cp.z1) / 2;
  const parkedRect = L ? L.parkedCar
    : { x0: ccx - vehicle.width / 2, x1: ccx + vehicle.width / 2, z0: ccz - vehicle.length / 2, z1: ccz + vehicle.length / 2 };
  world.add(parkedCar(parkedRect, land + 0.03));
  if (L) world.add(envelopeBox(parkedRect, land + 0.03, vehicle.height));
  for (const [x, z] of [[cp.x0 + 0.1, cp.z0 + 0.1], [cp.x1 - 0.22, cp.z0 + 0.1], [cp.x0 + 0.1, cp.z1 - 0.22], [cp.x1 - 0.22, cp.z1 - 0.22]]) {
    const post = box(M.post, x, z, x + 0.12, z + 0.12, 0, P.carportCanopyHeight);
    post.position.y = land;
    world.add(post);
    heightBound.push({ mesh: post, y0: 0, y1: P.carportCanopyHeight, base: land });
  }
  const cpCanopy = box(M.canopy, cp.x0 - 0.1, cp.z0 - 0.1, cp.x1 + 0.1, cp.z1 + 0.1, land + P.carportCanopyHeight, land + P.carportCanopyHeight + 0.06);
  cpCanopy.castShadow = false;
  world.add(cpCanopy);
  aboveCut.push(cpCanopy);

  // Garden placeholder at land level and decorative models.
  const gd = site.garden;
  world.add(flat(M.garden, gd.x0, gd.z0, gd.x1, gd.z1, land + 0.01));
  for (const d of site.decor || []) {
    if (d.model === 'plant' && plantAsset) world.add(placeModel(plantAsset, d.x, d.z, d.level === 'floor' ? floor : land));
  }

  if (L) buildAccess(L, land, floor);

  // Routes. With an access scenario the vehicle route follows the approach surface.
  const routes = L ? [[site.pedestrianRoute, 0x2f6fa3]] : [[site.vehicleRoute, 0xc8642c], [site.pedestrianRoute, 0x2f6fa3]];
  for (const [route, color] of routes) {
    const [x] = route.points[0];
    world.add(dashed([[x, 0.02, site.roadEdgeZ + 2.2], [x, 0.02, site.roadEdgeZ]], color));
    world.add(dashed([[x, 0.02, site.roadEdgeZ], [x, land + 0.02, site.landEdgeZ]], color, 0.15));
    world.add(dashed([[x, land + 0.03, site.landEdgeZ], ...route.points.slice(1).map(([px, pz]) => [px, land + 0.03, pz])], color));
    addLabel(esc(route.label), 'site pill', x, land * 0.55, site.landEdgeZ + 1.6, 'detail', 4);
  }

  // Provisional dimension lines (toggle).
  const dimY = floor + 0.06;
  const dz = E.z0 - 0.8, dx = E.x1 + 0.7;
  const dims = [
    solidLine([[E.x0, dimY, dz], [E.x1, dimY, dz]], 0x2f5d62),
    solidLine([[E.x0, dimY, dz - 0.2], [E.x0, dimY, dz + 0.2]], 0x2f5d62),
    solidLine([[E.x1, dimY, dz - 0.2], [E.x1, dimY, dz + 0.2]], 0x2f5d62),
    solidLine([[dx, dimY, E.z0], [dx, dimY, E.z1]], 0x2f5d62),
    solidLine([[dx - 0.2, dimY, E.z0], [dx + 0.2, dimY, E.z0]], 0x2f5d62),
    solidLine([[dx - 0.2, dimY, E.z1], [dx + 0.2, dimY, E.z1]], 0x2f5d62),
  ];
  dims.forEach(d => { world.add(d); dimObjects.push(d); });
  addLabel(`≈ ${f2(area.enclosed.w)} m (provisional)`, 'dimline', (E.x0 + E.x1) / 2, dimY, dz - 0.35, 'dim', 2);
  addLabel(`≈ ${f2(area.enclosed.d)} m<br>(provisional)`, 'dimline', dx + 0.9, dimY, (E.z0 + E.z1) / 2, 'dim', 2);

  // Labels: rooms (core), site placeholders and level tags (detail).
  const byId = Object.fromEntries(area.rooms.map(r => [r.id, r]));
  for (const r of plan.rooms) {
    const a = byId[r.id];
    addLabel(`<b>${esc(r.label)}</b><span class="dim">≈ ${f2(a.clearW)} × ${f2(a.clearD)} m</span><span class="dim">≈ ${a.clearArea.toFixed(1)} m²</span>`,
      'room', (r.x0 + r.x1) / 2, floor + 0.1, (r.z0 + r.z1) / 2, 'core', 3);
  }
  addLabel(L ? 'Carport (rearward)' : esc(cp.label), 'site pill', ccx, land + vehicle.height + 0.5, ccz, 'core', 2);
  addLabel(`${carAsset ? 'Generic car model in an' : 'Placeholder car box,'} ASSUMED ${f2(vehicle.length)} × ${f2(vehicle.width)} × ${f2(vehicle.height)} m envelope — not the owner's car (Q03)`,
    'site', ccx, land + 0.2, parkedRect.z0 - 0.4, 'detail', 4);
  addLabel(`${esc(en.label)} · steps to floor level TBC`, 'site', (en.x0 + en.x1) / 2, floor + 0.1, en.z1 + 0.35, 'detail', 4);
  addLabel(`${esc(gd.label)} (placeholder)`, 'site', (gd.x0 + gd.x1) / 2, land + 0.1, (gd.z0 + gd.z1) / 2, 'detail', 4);
  addLabel('Slope / retaining unresolved — professional design required', 'site', (lx0 + comp.x0) / 2 + 3, land * 0.5, site.landEdgeZ + 0.05, 'detail', 5);
  const tagX = (lx0 + E.x0) / 2, tagZ = L ? (cp.z1 + site.landEdgeZ) / 2 : (lz0 + cp.z0) / 2;
  addLabel('Boundary unknown — no survey', 'site', L ? lx1 - 1.6 : tagX, land + 0.05, lz0 + 0.6, 'detail', 5);
  addLabel(`Road ±0.00 m · ASSUMED datum`, 'level', comp.x1 - 1, 0.05, site.roadEdgeZ + P.roadDepthShown * 0.3, 'detail', 4);
  addLabel(`Land ${signed(land)} m<br>OWNER-ESTIMATED ${f2(plan.levels.land.min)}–${f2(plan.levels.land.max)}`, 'level',
    L ? (E.x1 + lx1) / 2 : tagX, land + 0.05, L ? comp.z0 + 1.5 : tagZ - 0.9, 'detail', 4);
  addLabel(`House finished floor ${signed(floor)} m<br>ASSUMED plinth ${f2(P.plinthHeight)} m`, 'level',
    L ? (E.x1 + lx1) / 2 : tagX, land + 0.05, L ? comp.z0 + 3.5 : tagZ + 1.1, 'detail', 4);

  // Numbered warning badges; full text is in the warnings panel.
  warnings.forEach((w, i) => {
    if (w.at) addLabel(`${i + 1}`, 'badge', w.at[0], w.at[1], w.at[2], 'warn', 0, w.text);
  });

  scene.add(world);
  applyHeight();
  applyToggles();
  renderWarnings();
  renderAccessInfo();
  renderProfile();
}

function near(a, b) { return Math.abs(a - b) < 1e-4; }

// Approach corridor: level entrance apron (V1.2: waiting zone), provisional ramp solid, candidate
// sliding gate with its lateral pocket, waiting-vehicle envelope and a separate pedestrian gate.
// Gate, apron/ramp start and waiting position come from independent dataset fields. All ASSUMED.
function buildAccess(L, land, floor) {
  const site = plan.site, W = L.waitingLevel;
  const cw = L.corridor.x1 - L.corridor.x0, cxm = (L.corridor.x0 + L.corridor.x1) / 2;

  // Level apron slab (paved top) from the land edge to the start of the climb.
  const al = L.apron.z1 - L.apron.z0;
  const apronTop = texturedMaterial(pavingSet, cw, al, 0xd8d2c4);
  const slab = new THREE.Mesh(unitBox, [M.carportSlab, M.carportSlab, apronTop, M.carportSlab, M.carportSlab, M.carportSlab]);
  slab.scale.set(cw, W, al);
  slab.position.set(X(cxm), 0, Z((L.apron.z0 + L.apron.z1) / 2));
  slab.receiveShadow = true;
  world.add(slab);

  // Provisional ramp: the profile polygon extruded across the corridor width.
  const prof = accessProfile(plan, land);
  const shape = new THREE.Shape();
  shape.moveTo(L.rampStartZ, 0);
  for (const [z, y] of prof.ramp) shape.lineTo(z, y);
  shape.lineTo(L.ramp.z0, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: cw, bevelEnabled: false });
  // shape (s, y, d) → world (x = corridor.x1 − d, y, z = s); a proper rotation, so winding is kept.
  geo.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, X(L.corridor.x1), 0, 1, 0, 0, 1, 0, 0, -oz, 0, 0, 0, 1));
  const ramp = new THREE.Mesh(geo, M.ramp);
  ramp.castShadow = ramp.receiveShadow = true;
  world.add(ramp);
  // Ramp label sits toward the carport end so it does not compete with the ramp warning badge.
  const upper = prof.ramp[Math.floor(prof.ramp.length * 0.8)];
  addLabel('Ramp — provisional · clearance UNCHECKED', 'site pill access', cxm, upper[1] + 0.4, upper[0], 'core', 2);
  world.add(dashed([[L.corridor.x0, W + 0.03, L.rampStartZ], [L.corridor.x1, W + 0.03, L.rampStartZ]], 0xc8642c, 0.12));
  addLabel('Climb starts — smooth bottom transition', 'site', cxm, W + 0.2, L.rampStartZ - 0.35, 'detail', 4);

  // Candidate sliding gate: posts, closed leaf, track and lateral pocket (red = drawn conflict).
  const gz = L.gateZ, gh = 1.6, gb = rampHeight(L, land, gz);
  for (const x of [L.opening.x0 - 0.15, L.opening.x1]) world.add(box(M.gate, x, gz - 0.075, x + 0.15, gz + 0.075, gb, gb + gh + 0.2));
  const leaf = box(M.gate, L.opening.x0 - 0.05, gz - 0.03, L.opening.x1 + 0.05, gz + 0.03, gb + 0.05, gb + gh);
  leaf.material = M.gate.clone();
  leaf.material.transparent = true;
  leaf.material.opacity = 0.55;
  world.add(leaf);
  const pk = L.pocket, other = L.otherPocket;
  world.add(box(M.conflict, pk.x0, pk.z0, pk.x1, pk.z1, gb, Math.max(land, gb + gh) + 0.05));
  const trackFar = pk.side === 'left' ? L.opening.x1 : L.opening.x0;
  world.add(solidLine([[pk.side === 'left' ? pk.x0 : pk.x1, gb + 0.02, gz], [trackFar, gb + 0.02, gz]], 0x3b4046));
  world.add(dashed([[other.x0, gb + 0.03, gz], [other.x1, gb + 0.03, gz]], 0xd2553b, 0.2));
  addLabel('Sliding gate (candidate)', 'site pill access', (L.opening.x0 + L.opening.x1) / 2, gb + gh + 0.45, gz, 'core', 2);
  const pkTagX = pk.side === 'left' ? pk.x0 + 0.6 : pk.x1 - 0.6;
  addLabel(`Gate pocket (${pk.side}) — conflict`, 'site pill conflict', pkTagX, Math.max(land, gb + gh) + 0.4, gz - 0.9, 'core', 1);
  addLabel(`Alternative pocket (${other.side}), dashed — conflict`, 'site', (other.x0 + other.x1) / 2, gb + 0.2, gz - 0.5, 'detail', 4);
  addLabel('Symbolic gate/boundary positions — not legal lines', 'site', cxm, gb + 0.2, gz + 0.6, 'detail', 4);

  // Apron and waiting vehicle. The envelope (no model) is the assumption being tested; when the
  // off-road space outside the gate is too short it is drawn red where it would actually stand.
  addLabel(esc(L.apronLabel), 'site pill access', cxm, W + 0.5, (L.apron.z0 + L.apron.z1) / 2, 'core', 3);
  if (L.waitingFits) {
    world.add(envelopeBox(L.waitingCar, W, vehicle.height));
    addLabel('Vehicle envelope, ASSUMED — footprint only', 'site', cxm, W + 0.15, L.waitingCar.z1 + 0.25, 'detail', 4);
  } else {
    world.add(envelopeBox(L.waitingCar, 0, vehicle.height, 0xd2553b));
    addLabel('Waiting car would stand on drain/road — NOT acceptable', 'site pill conflict', cxm, vehicle.height + 0.5,
      Math.min(L.waitingCar.z1 - 1, site.roadEdgeZ + 1.5), 'core', 1);
  }

  // Vehicle route along the approach surface.
  world.add(dashed([[cxm, 0.02, Math.max(site.roadEdgeZ + 2.2, L.waitingCar.z1 + 0.3)], [cxm, 0.02, site.roadEdgeZ], [cxm, W + 0.02, site.landEdgeZ],
    [cxm, W + 0.02, L.rampStartZ], ...prof.ramp.map(([z, y]) => [cxm, y + 0.03, z]), [cxm, land + 0.05, L.parkedCar.z1]], 0xc8642c));

  // Pedestrian gate on the separate pedestrian route.
  const pg = L.pedestrianGate;
  for (const x of [pg.x0 - 0.1, pg.x1]) world.add(box(M.gate, x, pg.z0, x + 0.1, pg.z1, land, land + 1.3));
  const pleaf = box(M.gate, pg.x0, pg.z0 + 0.07, pg.x1, pg.z1 - 0.07, land + 0.05, land + 1.15);
  pleaf.material = leaf.material;
  world.add(pleaf);
  addLabel('Pedestrian gate (separate)', 'site pill', (pg.x0 + pg.x1) / 2, land + 1.6, pg.z0, 'core', 2);

  // Symbolic frontage line and drain label.
  world.add(dashed([[comp.x0 - P.landMarginShown, land + 0.02, site.landEdgeZ], [comp.x1 + P.landMarginShown, land + 0.02, site.landEdgeZ]], 0x7a5a3a, 0.25));
  addLabel('Roadside drain — unresolved, unaltered', 'site pill', comp.x1 - 2, 0.05, (site.landEdgeZ + site.roadEdgeZ) / 2, 'core', 3);
  addLabel('Symbolic frontage line — not a legal boundary', 'site', comp.x1 - 1, land + 0.1, site.landEdgeZ - 0.4, 'detail', 5);

  for (const w of accessNow.warnings) {
    const y = { road: 0.3, waiting: W + 0.6, gate: gb + 0.6, ramp: land / 2 + 0.6, land: land + 0.6 }[w.level] ?? land;
    warnings.push({ text: w.text, at: w.at ? [w.at[0], y, w.at[1]] : null });
  }
}

function applyHeight() {
  for (const { mesh, y0, y1, base } of heightBound) {
    const top = Math.min(y1, state.h);
    mesh.visible = top > y0 + 0.002;
    if (mesh.visible) { mesh.scale.y = top - y0; mesh.position.y = base + y0; }
  }
  const showCanopies = state.h > P.wallHeight * 0.75;
  aboveCut.forEach(m => { m.visible = showCanopies; });
  planOnly.forEach(m => { m.visible = state.h < 0.3; });
  if (IS_V2) {
    // Roof removal is a viewing mode (Plan, Cutaway), never an open roof: the house is roofed.
    const roofVisible = state.roofOverride ?? showCanopies;
    roofObjects.forEach(m => { m.visible = roofVisible; });
    railObjects.forEach(m => { m.visible = roofVisible && state.railing; });
    if (roofVisible !== lastRoofShown && lastRoofShown !== null) { lastRoofShown = roofVisible; applyToggles(); }
    lastRoofShown = roofVisible;
    const toggle = document.getElementById('show-roof');
    if (toggle) toggle.checked = roofVisible;
    const note = document.getElementById('cutaway-note');
    if (note) {
      note.hidden = roofVisible || state.view === 'front' || state.view === 'frontage';
      note.textContent = state.roofOverride === false && state.view !== 'plan' && state.view !== 'cutaway'
        ? 'ROOF HIDDEN by the Roof control — viewing only. The house is roofed.'
        : state.view === 'plan' ? 'PLAN VIEW — walls drawn at floor level and the roof hidden for viewing only. The house is roofed.'
          : 'CUTAWAY VIEW — roof and upper walls are hidden for viewing only. The house is roofed.';
    }
  }
}

// V2: whether the roof is currently drawn (follows the view unless the Roof control overrides it).
const roofShown = () => IS_V2 && (state.roofOverride ?? state.h > P.wallHeight * 0.75);
let lastRoofShown = null;

function applyToggles() {
  const on = id => document.getElementById(id).checked;
  const showDims = on('show-dims'), showLabels = on('show-labels'), showTags = on('show-tags');
  document.body.classList.toggle('show-dims', showDims);
  dimObjects.forEach(d => { d.visible = showDims; });
  for (const l of labels) {
    l.active = l.tier === 'warn' || (l.tier === 'core' && showLabels) || (l.tier === 'detail' && showTags) || (l.tier === 'dim' && showDims)
      || (l.tier === 'interior' && showLabels && !roofShown());
    l.el.style.display = l.active ? '' : 'none';
  }
  for (const l of labels) if (l.active) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
  const profile = document.getElementById('profile');
  profile.hidden = !((access || IS_V2) && on('show-profile'));
}

// ---------- panels ----------
function renderWarnings() {
  const box = document.getElementById('warnings');
  const n = warnings.length;
  const assetNote = assetFailures.length
    ? `<p class="asset-fail">Asset fallback in use (${assetFailures.length} local file${assetFailures.length === 1 ? '' : 's'} failed to load): plain box car / untextured surfaces. Geometry and checks are unaffected.</p>`
    : '';
  const heading = `${n} unresolved issue${n === 1 ? '' : 's'} in this ${IS_V2 ? 'concept' : 'demonstration'}`;
  if (warnings.some(w => w.title)) {
    // V2.2+: short titles; each issue expands on demand and the whole list can be collapsed (keyboard accessible)
    box.innerHTML = `${assetNote}<details id="warn-list"${state.warningsOpen ? ' open' : ''}><summary><h2>${heading}</h2></summary>` +
      `<ol>${warnings.map(w => `<li><details><summary>${esc(w.title)}</summary><p>${esc(w.text)}</p></details></li>`).join('')}</ol></details>`;
    box.querySelector('#warn-list').addEventListener('toggle', e => { const was = state.warningsOpen; state.warningsOpen = e.target.open; if (was !== state.warningsOpen) refit(); });
    return;
  }
  box.innerHTML = `${assetNote}<h2>${heading}</h2>` +
    `<ol>${warnings.map(w => `<li>${esc(w.text)}</li>`).join('')}</ol>`;
}

function renderAccessInfo() {
  const el = document.getElementById('access-info');
  if (!el) return;
  if (!access) { el.innerHTML = ''; return; }
  const m = accessNow.metrics, a = plan.site.access, L = access;
  const rows = [
    ['Carport moved rearward (−z)', `${f2(m.carportRearwardShift)} m`],
    ['Corridor length, land edge → carport', `${f2(m.corridorLength)} m`],
    ['Gate line inside the land edge', `${f2(m.gateSetback)} m`],
    ['Level apron length / level', `${f2(m.apronLength)} m / ${signed(L.waitingLevel)} m`],
    ['Climbing run, climb start → carport', `${f2(m.rampRun)} m`],
    ['Drawn rise, apron → land/carport', `${f2(m.rise)} m`],
    ['Average gradient (rise / run)', `${m.averageGradientPct.toFixed(1)}%`],
    ['Maximum local gradient of drawn shape', `${m.maxLocalGradientPct.toFixed(1)}%`],
    ['Surface slope at the gate line', `${m.gateSurfaceSlopePct.toFixed(1)}%`],
    ['Cut depth: entrance / house front line', `${f2(m.cutDepthAtLandEdge)} / ${f2(m.cutDepthAtHouseFront)} m`],
    ['Corridor edge → house wall face', `${f2(m.corridorToHouse)} m`],
    ['Off-road length outside gate / envelope', `${f2(m.gateSetback)} / ${f2(vehicle.length)} m`],
    ['Spare carport length', `${f2(m.carportSpareLength)} m`],
    ['Gate opening minus envelope width', `${f2(m.gateOpeningSpare)} m`],
  ];
  el.innerHTML = `
    <h3>Access scenario — ASSUMED, clearance UNCHECKED</h3>
    <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <p>Visual footprint checks (not clearance tests):</p>
    <ul>${accessNow.checks.map(([k, ok, kind]) => `<li>${ok ? '✓' : '✗'} ${esc(k)}${ok ? '' : kind === 'conflict' ? ' — unresolved conflict' : ' — data error'}</li>`).join('')}</ul>
    <ul>${a.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    <table>${Object.entries(a.evidence).map(([k, v]) => `<tr><td>${esc(k)}<br><small>${esc(v)}</small></td><td></td></tr>`).join('')}</table>`;
}

// Schematic long section along the corridor centreline, from the road (left) to the carport
// rear (right). Same dataset and ramp function as the 3D scene. Vertical exaggeration ×2.
function renderProfile() {
  const el = document.getElementById('profile');
  if (IS_V2) { renderProfileV2(el, plan, state.land, { f2, signed, section: state.section }); return; }
  if (!access) { el.hidden = true; return; }
  const L = access, site = plan.site, land = state.land, floor = ffl(), W = L.waitingLevel;
  const prof = accessProfile(plan, land);
  const zStart = Math.max(site.roadEdgeZ + 2.5, L.waitingCar.z1 + 0.6), zEnd = plan.site.carport.z0 - 0.5;
  const VX = 2, w = 440, h = 236, padL = 10, padR = 118, padB = 40;
  const sx = (w - padL - padR) / (zStart - zEnd), sy = sx * VX;
  const px = z => padL + (zStart - z) * sx;
  const py = y => h - padB - y * sy;
  const pts = arr => arr.map(([z, y]) => `${px(z).toFixed(1)},${py(y).toFixed(1)}`).join(' ');
  const cp = site.carport;
  const surface = [[zStart, 0], [site.roadEdgeZ, 0], [site.landEdgeZ, 0], [site.landEdgeZ, W], [L.rampStartZ, W], ...prof.ramp, [cp.z1, land], [cp.z0, land]];
  const fill = [...surface, [cp.z0, -0.35], [zStart, -0.35]];
  const ticks = [];
  const axisY = py(-0.35) + 3;
  for (let d = 0; d <= zStart - zEnd; d += 2) ticks.push(`<line x1="${px(zStart - d)}" y1="${axisY}" x2="${px(zStart - d)}" y2="${axisY + 4}" class="tick"/><text x="${px(zStart - d)}" y="${axisY + 13}" class="tick-t">${d}</text>`);
  // Level tags on the right, nudged apart so close levels (road/apron) stay legible.
  const tags = [[floor, `Floor ${signed(floor)} ASSUMED`, 'ffl-t'], [land, `Land ${signed(land)} OWNER-EST.`, ''],
    [W, `Apron ${signed(W)} ASSUMED`, ''], [0, 'Road ±0.00 datum', '']];
  let lastY = -Infinity;
  const tagSvg = tags.map(([y, text, cls]) => [py(y) + 3, text, cls]).sort((a, b) => a[0] - b[0])
    .map(([y, text, cls]) => { const yy = Math.max(y, lastY + 11); lastY = yy; return `<text x="${w - padR + 6}" y="${yy}" class="lvl ${cls}">${text}</text>`; }).join('');
  const rampMid = prof.ramp[Math.floor(prof.ramp.length / 2)];
  const m = accessNow.metrics;
  const gb = rampHeight(L, land, L.gateZ);
  const waitBase = L.waitingFits ? W : 0;
  el.innerHTML = `
    <div class="profile-head"><b>Schematic approach profile</b> · corridor centreline · vertical ×${VX} · ASSUMED geometry · clearance UNCHECKED · PRELIMINARY — NOT FOR CONSTRUCTION</div>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Schematic side profile from road to carport">
      <polygon points="${pts(fill)}" class="ground"/>
      <polyline points="${pts([[site.landEdgeZ, 0], [site.landEdgeZ, land], [cp.z0, land]])}" class="land"/>
      <rect x="${px(site.roadEdgeZ)}" y="${py(0)}" width="${(site.roadEdgeZ - site.landEdgeZ) * sx}" height="${0.3 * sy}" class="drain"/>
      <polyline points="${pts([[zStart, 0], [site.roadEdgeZ, 0]])}" class="road"/>
      <polyline points="${pts([[site.landEdgeZ, W], [L.rampStartZ, W]])}" class="waiting"/>
      <polyline points="${pts(prof.ramp)}" class="ramp"/>
      <polyline points="${pts([[cp.z1, land], [cp.z0, land]])}" class="carport"/>
      <polyline points="${pts([[E.z1, floor], [E.z0, floor]])}" class="ffl"/>
      <rect x="${px(L.waitingCar.z1)}" y="${py(waitBase + vehicle.height)}" width="${(L.waitingCar.z1 - L.waitingCar.z0) * sx}" height="${vehicle.height * sy}" class="veh${L.waitingFits ? '' : ' conflict'}"/>
      <rect x="${px(L.parkedCar.z1)}" y="${py(land + vehicle.height)}" width="${(L.parkedCar.z1 - L.parkedCar.z0) * sx}" height="${vehicle.height * sy}" class="veh"/>
      ${L.waitingFits ? '' : `<text x="${px(L.waitingCar.z1) + 2}" y="${py(vehicle.height + 1.3)}" class="note warn">waiting car on drain/road — NOT acceptable</text>`}
      <line x1="${px(L.gateZ)}" y1="${py(gb)}" x2="${px(L.gateZ)}" y2="${py(gb + 1.6)}" class="gate"/>
      <text x="${px(L.gateZ) + 3}" y="${py(gb + 1.6) - 3}" class="note">gate</text>
      <line x1="${px(L.rampStartZ)}" y1="${py(W) + 3}" x2="${px(L.rampStartZ)}" y2="${py(W) + 9}" class="tick"/>
      <text x="${px((site.landEdgeZ + site.roadEdgeZ) / 2)}" y="${py(0) + 10}" class="note mid">drain?</text>
      <text x="${px(rampMid[0]) + 8}" y="${py(rampMid[1]) + 14}" class="note warn">rise ${f2(m.rise)} m / run ${f2(m.rampRun)} m · avg ${m.averageGradientPct.toFixed(1)}% · max ${m.maxLocalGradientPct.toFixed(1)}%</text>
      <text x="${px(rampMid[0]) + 8}" y="${py(rampMid[1]) + 25}" class="note warn">clearance UNCHECKED</text>
      <text x="${px((E.z1 + plan.site.carport.z1) / 2)}" y="${py(floor) + 10}" class="note mid">house floor, beside corridor</text>
      ${ticks.join('')}
      <text x="${padL}" y="${h - 2}" class="tick-t start">metres, from ${f2(zStart - site.roadEdgeZ)} m into the road · road (left) → carport rear (right)</text>
      ${tagSvg}
    </svg>
    <div class="profile-foot">Drawn-shape arithmetic only — not bumper, breakover, gradient-compliance, retaining or drainage checks. Lower-level parking stays an alternative.</div>`;
}

function renderInfo() {
  document.getElementById('notice-main').textContent = plan.notice;
  document.getElementById('notice-sub').textContent = plan.subNotice;
  document.title = `House Explorer ${plan.revision}`;
  if (IS_V2) {
    const note = assetFailures.length ? `Asset fallbacks in use: ${assetFailures.join('; ')}`
      : 'Local CC0 assets loaded: generic car, plant, paving, stucco, stone and wood-look maps (appearance only).';
    document.getElementById('details-body').innerHTML = renderInfoV2(plan, state.land, note, { f2, signed, esc });
    if (params.get('details') === '1') document.getElementById('details').open = true;
    return;
  }
  const evidence = plan.parameterEvidence || {};
  const paramRows = Object.entries(P).map(([k, v]) => {
    const val = typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${typeof b === 'object' ? JSON.stringify(b) : b}`).join(', ') : v;
    return `<tr><td>${esc(k)}<br><small>${esc(evidence[k] || '')}</small></td><td class="wrap">${esc(val)}</td></tr>`;
  }).join('');
  const roomRows = area.rooms.map(r => `<tr><td>${esc(r.label)}</td><td>${f2(r.clearW)} × ${f2(r.clearD)} = ${f2(r.clearArea)} m²</td></tr>`).join('');
  const outdoorRows = area.outdoor.map(o => `<tr><td>${esc(o.label)}</td><td>${f2(o.w)} × ${f2(o.d)} = ${f2(o.area)} m²</td></tr>`).join('');
  document.getElementById('details-body').innerHTML = `
    <p><b>${esc(plan.planFamily)} · ${esc(plan.revision)} · ${esc(plan.title)}</b></p>
    <p>${esc(plan.purpose)}</p>
    <p>Source: ${esc(plan.source.file)} (scheme ${esc(plan.source.scheme)}, sha256 ${esc(plan.source.sha256.slice(0, 12))}…)${plan.derivedFrom ? ` via ${esc(plan.derivedFrom.revision)} dataset` : ''}</p>
    <p>${esc(plan.dimensions)}</p>
    <div id="access-info"></div>
    <h3>Areas — visualization-derived, not measured</h3>
    <table>
      <tr><td>Composition bounding box (drawing extent)</td><td>${f2(area.compositionBox.w)} × ${f2(area.compositionBox.d)} = ${f2(area.compositionBox.area)} m²</td></tr>
      <tr><td>Enclosed, to outer wall faces</td><td>${f2(area.enclosed.area)} m² ≈ ${Math.round(area.enclosed.sqft)} sq ft</td></tr>
      <tr><td>Room cells (wall centrelines)</td><td>${f2(area.cellTotal)} m²</td></tr>
      <tr><td>Room clear floor, total</td><td>${f2(area.clearTotal)} m²</td></tr>
      ${roomRows}
      ${outdoorRows}
    </table>
    <h3>Levels</h3>
    <table>
      <tr><td>Road<br><small>${esc(plan.levels.road.evidence)}</small></td><td>±0.00 m</td></tr>
      <tr><td>Land<br><small>${esc(plan.levels.land.evidence)}</small></td><td id="info-land"></td></tr>
      <tr><td>Finished floor<br><small>${esc(plan.levels.finishedFloor.evidence)}</small></td><td id="info-ffl"></td></tr>
    </table>
    <h3>Parameters</h3>
    <table>${paramRows}</table>
    <h3>Zones</h3>
    <ul>${Object.entries(ZONE_NAMES).map(([z, n]) => `<li><span class="swatch" style="background:#${ZONE_COLOURS[z].toString(16).padStart(6, '0')}"></span>${esc(n)}</li>`).join('')}</ul>
    <h3>Derivation</h3>
    <p>${esc(plan.derivation.rule)}</p>
    <ul>${plan.derivation.changedRelationships.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    <p>Lighting direction is illustrative only; site orientation is unknown.</p>
    <p id="asset-status"></p>`;
  if (params.get('details') === '1') document.getElementById('details').open = true;
  document.getElementById('asset-status').textContent = assetFailures.length
    ? `Asset fallbacks in use: ${assetFailures.join('; ')}`
    : (P.carModel ? 'Local CC0 assets loaded: generic car, plant, paving and stucco textures (appearance only).' : '');
}
function updateLevelText() {
  document.getElementById('land-value').textContent = `${signed(state.land)} m`;
  document.getElementById('levels-readout').textContent =
    `Owner-estimated ${f2(plan.levels.land.min)}–${f2(plan.levels.land.max)} m · finished floor ${signed(ffl())} m (assumed plinth)`;
  const il = document.getElementById('info-land'), iff = document.getElementById('info-ffl');
  if (il) il.textContent = `${signed(state.land)} m`;
  if (iff) iff.textContent = `${signed(ffl())} m`;
}

const landInput = document.getElementById('land');
Object.assign(landInput, { min: plan.levels.land.min, max: plan.levels.land.max, value: state.land });
landInput.addEventListener('input', () => {
  const dy = Number(landInput.value) - state.land;
  state.land = Number(landInput.value);
  camera.position.y += dy;
  controls.target.y += dy;
  build();
  updateLevelText();
});
for (const k of CUSTOM_VIEWS) {
  if (document.querySelector(`[data-view="${k}"]`)) continue;
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.view = k; b.textContent = plan.views[k].label ?? k;
  document.querySelector('#controls .group').appendChild(b);
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.view)));
// V2.4: carport floor alternative toggle (the whole scene, sections, issue list and info panel follow the active option)
const carportToggle = document.querySelector('.carport-toggle');
const markCarport = () => carportToggle.querySelectorAll('[data-carport]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.carport === plan.levels.carportFloor.active)));
if (HAS_CARPORT) {
  carportToggle.hidden = false;
  markCarport();
  carportToggle.addEventListener('click', e => {
    const b = e.target.closest('[data-carport]');
    if (!b || b.dataset.carport === plan.levels.carportFloor.active) return;
    plan.levels.carportFloor.active = b.dataset.carport;
    markCarport();
    renderInfo();
    build();
    updateLevelText();
  });
}
const setCheck = (id, value) => { document.getElementById(id).checked = value; };
setCheck('show-dims', params.get('dims') === '1');
setCheck('show-labels', params.get('labels') !== '0');
setCheck('show-tags', params.get('tags') === '1');
setCheck('show-profile', params.get('profile') !== '0' && innerWidth > 760);
document.getElementById('profile-toggle').hidden = !(access || IS_V2);
document.querySelectorAll('.v2-only').forEach(el => { el.hidden = !IS_V2; });
document.querySelectorAll('[data-view="frontage"]').forEach(el => { el.hidden = !VIEWS.includes('frontage'); });
document.getElementById('profile').addEventListener('click', e => {
  const tab = e.target.closest('[data-section]');
  if (tab) { state.section = tab.dataset.section; renderProfile(); }
});
document.getElementById('show-roof').addEventListener('change', e => { state.roofOverride = e.target.checked; applyHeight(); });
document.getElementById('show-railing').checked = state.railing;
document.getElementById('show-railing').addEventListener('change', e => { state.railing = e.target.checked; applyHeight(); });
for (const id of ['show-dims', 'show-labels', 'show-tags', 'show-profile']) document.getElementById(id).addEventListener('change', applyToggles);
document.getElementById('show-profile').addEventListener('change', () => refit());

// ---------- views and transitions ----------
// V2.3: the part of the window not covered by the notice, the controls and any open panel. The camera's principal
// point is moved to its centre and distances are fitted to it, so the complete site is not hidden by the UI.
function freeArea() {
  const W = innerWidth, H = innerHeight, el = id => document.getElementById(id);
  const top = (el('notice')?.offsetHeight ?? 56) + 6, ctl = el('controls');
  const bottom = ctl ? Math.max(0, H - ctl.getBoundingClientRect().top) + 8 : 130;
  let left = 8, right = 8;
  if (W > 900) {
    const prof = el('profile');
    if (prof && !prof.hidden) left = prof.getBoundingClientRect().right + 12;
    if (state.warningsOpen || el('details')?.open) { const info = el('info'); if (info) right = W - info.getBoundingClientRect().left + 12; }
  }
  return { x: left, y: top, w: Math.max(200, W - left - right), h: Math.max(200, H - top - bottom) };
}
function applyFrame() {
  if (!FRAME) return;
  const f = freeArea(), W = innerWidth, H = innerHeight;
  camera.setViewOffset(W, H, -(f.x + f.w / 2 - W / 2), -(f.y + f.h / 2 - H / 2), W, H);
}
const fitRectFree = (w, d) => { const f = freeArea(), tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); return Math.max((w * innerHeight) / (2 * tv * f.w), (d * innerHeight) / (2 * tv * f.h)) * 1.04; };
const fitSphereFree = r => { const f = freeArea(), tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); return (r * innerHeight) / (tv * Math.min(f.w, f.h)); };
function refit() {
  if (!FRAME || tween) return;
  const keep = state.roofOverride;
  goTo(state.view, true);
  state.roofOverride = keep;
}

function fitDistance(w, d) {
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max(d / 2 / half, w / 2 / (half * camera.aspect)) * 1.06;
}
// V2 poses: Plan fits the house and front garden, Aerial/Cutaway look from the road side, Front stands
// in the road facing the façade like the primary reference. Camera data for Front lives in the dataset.
function viewPoseV2(view) {
  if (FRAME && (view === 'plan' || view === 'aerial' || view === 'cutaway')) {
    if (view === 'plan') {
      const v = plan.views.plan, target = new THREE.Vector3(X((v.x0 + v.x1) / 2), ffl(), Z((v.y0 + v.y1) / 2));
      return { target, pos: target.clone().add(new THREE.Vector3(0, fitRectFree(v.x1 - v.x0, v.y1 - v.y0), 0.3)) };
    }
    const v = plan.views[view], target = new THREE.Vector3(X(v.target[0]), ffl() + v.targetUp, Z(v.target[1]));
    return { target, pos: target.clone().add(new THREE.Vector3(...v.dir).normalize().multiplyScalar(fitSphereFree(v.radius))) };
  }
  const { x0, x1, y0, y1 } = plan.views?.plan ?? { x0: -1.4, x1: 18.6, y0: 3.5, y1: 22.6 }, cx = X((x0 + x1) / 2), cz = Z((y0 + y1) / 2);
  if (view === 'plan') {
    const target = new THREE.Vector3(cx, ffl(), cz);
    return { target, pos: target.clone().add(new THREE.Vector3(0, fitDistance(x1 - x0, y1 - y0 + 1.2), 0.3)) };
  }
  if (view === 'front' || CUSTOM_VIEWS.includes(view)) {
    const f = plan.views[view];
    return { fov: f.fov, target: new THREE.Vector3(X(f.target[0]), ffl() + f.target[1], Z(f.target[2])), pos: new THREE.Vector3(X(f.position[0]), f.position[1], Z(f.position[2])) };
  }
  const target = new THREE.Vector3(X(view === 'aerial' ? 7.6 : 8.6), ffl() - 0.2, Z(view === 'aerial' ? 12.0 : 13.2));
  const dir = view === 'aerial' ? new THREE.Vector3(-0.7, 0.62, 1.0) : new THREE.Vector3(0.35, 1.2, 0.8);
  const dist = fitDistance(24, 22) * (view === 'aerial' ? 1.12 : 0.86);
  return { target, pos: target.clone().add(dir.normalize().multiplyScalar(dist)) };
}
function viewPose(view) {
  if (IS_V2) return viewPoseV2(view);
  const site = plan.site, margin = P.landMarginShown;
  const x0 = Math.min(comp.x0 - margin, access ? access.pocket.x0 - 0.5 : Infinity), x1 = comp.x1 + margin;
  const zMin = comp.z0 - margin, zMax = Math.max(site.roadEdgeZ + 2.5, access ? access.waitingCar.z1 + 0.5 : -Infinity);
  const w = x1 - x0;
  const cx = X((x0 + x1) / 2);
  if (view === 'plan') {
    const target = new THREE.Vector3(cx, ffl(), Z((zMin + zMax) / 2) + 0.4);
    const dist = fitDistance(w, zMax - zMin + 2.2);
    return { target, pos: target.clone().add(new THREE.Vector3(0, dist, dist * 0.002)) };
  }
  const target = new THREE.Vector3(cx, ffl() - 0.4, Z((comp.z0 + site.landEdgeZ) / 2) + 0.6);
  const dir = view === 'aerial' ? new THREE.Vector3(-0.62, 0.56, 0.9) : new THREE.Vector3(0.42, 1.05, 0.78);
  const dist = fitDistance(w * 1.05, w * 0.95) * (view === 'aerial' ? 0.98 : 0.92);
  return { target, pos: target.clone().add(dir.normalize().multiplyScalar(dist)) };
}

let tween = null;
function configureControls(view) {
  const planView = view === 'plan';
  controls.enableRotate = !planView;
  controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: planView ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: planView ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
}
function goTo(view, animate = true) {
  state.view = view;
  state.roofOverride = null;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (FRAME) { camera.fov = plan.views?.[view]?.fov ?? 35; camera.updateProjectionMatrix(); applyFrame(); }
  const pose = viewPose(view);
  camera.fov = pose.fov ?? 35;   // V2 Front uses a wider lens like the reference photograph
  camera.updateProjectionMatrix();
  applyFrame();
  configureControls(view);
  if (!animate) {
    tween = null;
    state.h = viewHeight[view];
    camera.position.copy(pose.pos);
    controls.target.copy(pose.target);
    controls.update();
    applyHeight();
    return;
  }
  controls.enabled = false;
  tween = {
    start: null, duration: 1500,   // set from the first frame's timestamp (same clock as progress)
    fromPos: camera.position.clone(), fromTarget: controls.target.clone(), fromH: state.h,
    toPos: pose.pos, toTarget: pose.target, toH: viewHeight[view],
  };
}
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyFrame();
}
addEventListener('resize', resize);

// ---------- frame loop ----------
// Labels are placed in priority order; a label that would overlap one already placed is hidden.
const tmp = new THREE.Vector3();
function updateLabels() {
  const w = innerWidth, h = innerHeight, placed = [];
  const order = labels.filter(l => l.active).sort((a, b) => a.priority - b.priority);
  for (const l of order) {
    tmp.copy(l.pos).project(camera);
    let show = !(tmp.z > 1 || tmp.z < -1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05);
    const sx = ((tmp.x + 1) / 2) * w, sy = ((1 - tmp.y) / 2) * h;
    if (show) {
      const r = { x0: sx - l.w / 2 - 2, x1: sx + l.w / 2 + 2, y0: sy - l.h / 2 - 1, y1: sy + l.h / 2 + 1 };
      show = !placed.some(q => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
      if (show) placed.push(r);
    }
    l.el.style.visibility = show ? '' : 'hidden';
    if (show) l.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
  }
}
function frame(now) {
  if (tween) {
    tween.start ??= now;
    const k = Math.min(Math.max((now - tween.start) / tween.duration, 0), 1), e = ease(k);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    state.h = THREE.MathUtils.lerp(tween.fromH, tween.toH, e);
    camera.lookAt(controls.target);
    applyHeight();
    if (k >= 1) { tween = null; controls.enabled = true; controls.update(); }
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(frame);
}

resize();
renderInfo();
build();
updateLevelText();
const fromView = params.get('from');
if (VIEWS.includes(fromView) && fromView !== state.view) {
  const target = state.view;
  goTo(fromView, false);
  goTo(target, true);
} else {
  goTo(state.view, false);
}
if (IS_V2 && params.has('roof')) { state.roofOverride = params.get('roof') === '1'; applyHeight(); }   // test hook for the Roof control
requestAnimationFrame(frame);

// Local diagnostics only: record readiness, errors, asset fallbacks and which URLs were requested.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const resources = performance.getEntriesByType('resource').map(r => r.name);
  const diag = {
    ready: true, plan: planId, revision: plan.revision, view: state.view, land: state.land,
    webgl2: renderer.capabilities.isWebGL2, errors: window.__diag.errors,
    resources, external: resources.filter(u => !u.startsWith(location.origin)),
    dataErrors: report.errors, warnings: warnings.length, assetFailures,
    labelsShown: labels.filter(l => l.active && l.el.style.visibility !== 'hidden').length,
    labelsHiddenByOverlap: labels.filter(l => l.active && l.el.style.visibility === 'hidden').length,
    v2: IS_V2 ? {
      carport: HAS_CARPORT ? plan.levels.carportFloor.active : null, scaleFigure: plan.scaleFigure ? plan.scaleFigure.height : null,
      validationWarnings: report.warnings.length, inEnclosedRange: report.info.inRange, enclosedGrossM2: +report.info.areas.gross.toFixed(2),
      roofVisible: roofObjects.length ? roofObjects[0].visible : null, roofObjects: roofObjects.length,
      frontGate: report.info.gate ? { gateBase: +report.info.gate.lands[1].base.toFixed(3), encroach: +report.info.gate.lands[1].encroach.toFixed(3), conflicts: report.info.gate.conflictIds.length, frame: FRAME ? freeArea() : null } : null,
      route: report.info.route ? { testLands: report.info.route.length, routeErrors: report.info.route.reduce((s, r) => s + r.errors, 0), stepFree: report.info.stepFree?.ok ?? null } : null,
    } : null,
    access: accessNow ? {
      averageGradientPct: +accessNow.metrics.averageGradientPct.toFixed(1), maxLocalGradientPct: +accessNow.metrics.maxLocalGradientPct.toFixed(1),
      failedErrorChecks: accessNow.checks.filter(c => !c[1] && c[2] === 'error').length,
      failedConflictChecks: accessNow.checks.filter(c => !c[1] && c[2] === 'conflict').length,
    } : null,
  };
  document.getElementById('diag').textContent = JSON.stringify(diag);
  document.body.dataset.ready = '1';
  console.info(`HOUSE_EXPLORER_DIAG ${JSON.stringify(diag)}`);
}));
