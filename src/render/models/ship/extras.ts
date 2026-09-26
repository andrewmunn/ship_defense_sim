import * as THREE from 'three';
import { PartBuilder, M, V3, box, cyl, cylZ, rod, prismBetween, DEG, rng } from './geom';
import { Block, sym } from './block';
import { symSlopes } from './superstructure';
import { detailBlock, ladder } from './facedetail';
import { LAYOUT as L, deckAt, deckY } from './hulldef';
import { wxPoint } from './weather';

/**
 * Mid-frequency dressing for the Vanguard class (0.5–3 m scale): inclined ladders, lockers, antenna farms,
 * anti-ship missile canisters, searchlights, signal lamps, ensign, SATCOM/ESM, a raised 02 house on the
 * hangar roof, and a handful of static crew figures for scale.
 */
export function buildExtras(pb: PartBuilder) {
  hangarRoofHouse(pb);
  inclinedLadders(pb);
  lockers(pb);
  antennaFarm(pb);
  missileCanisters(pb);
  searchlights(pb);
  ensign(pb);
  verticalLadders(pb);
  crew(pb);
}

// ------------------------------------------------------------------ inclined ladder (stairs) with handrails
export function inclinedLadder(pb: PartBuilder, bottom: V3, top: V3, width = 0.75) {
  const a = new THREE.Vector3(...bottom), b = new THREE.Vector3(...top);
  const run = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
  const side = new THREE.Vector3(-run.z, 0, run.x).normalize().multiplyScalar(width / 2);
  const len = a.distanceTo(b);
  const pitch = Math.atan2(b.y - a.y, run.length());
  const yaw = Math.atan2(run.x, run.z);
  for (const s of [1, -1]) {
    const o = side.clone().multiplyScalar(s);
    const [g, m] = rod(a.clone().add(o), b.clone().add(o), 1, 4);
    g.dispose();
    const st = new THREE.BoxGeometry(0.04, len, 0.2);
    pb.addOwned('paintFine', st, m);
    // handrail ~0.9 m above the stringer, with two stanchions
    const h = new THREE.Vector3(0, 0.9, 0);
    const [hg, hm] = rod(a.clone().add(o).add(h), b.clone().add(o).add(h), 0.025, 6);
    pb.addOwned('paintFine', hg, hm);
    for (const t of [0.05, 0.95]) {
      const p = a.clone().lerp(b, t).add(o);
      const [sg, sm] = rod(p, p.clone().add(h), 0.022, 6);
      pb.addOwned('paintFine', sg, sm);
    }
  }
  const n = Math.max(3, Math.round((b.y - a.y) / 0.24));
  for (let i = 1; i < n; i++) {
    const p = a.clone().lerp(b, i / n);
    pb.add('deckPlain', box(width - 0.05, 0.04, 0.2), M(p.x, p.y, p.z, 0, yaw, 0));
  }
  void pitch;
}

function inclinedLadders(pb: PartBuilder) {
  for (const sx of [1, -1]) {
    // aft 01 roof -> hangar roof, against the hangar front
    inclinedLadder(pb, [sx * 5.65, L.lvl01, -18.85], [sx * 5.65, L.hangarRoof, -20.95]);
    // main deck -> midships 01 roof along the deckhouse side, with a landing to the roof edge
    const zb = -3.6, zt = 0.2;
    inclinedLadder(pb, [sx * 7.85, deckAt(7.85, zb), zb], [sx * 7.85, L.lvl01, zt]);
    pb.add('deckPlain', box(1.5, 0.06, 0.9), M(sx * 7.45, L.lvl01 - 0.03, zt + 0.45));
    pb.add('paintFine', box(1.5, 0.12, 0.9), M(sx * 7.45, L.lvl01 - 0.12, zt + 0.45));
  }
}

function verticalLadders(pb: PartBuilder) {
  const hz1 = L.hangarAftZ;
  for (const sx of [1, -1]) {
    // flight deck -> hangar roof (aft face)
    const y0 = deckY(hz1);
    ladder(pb, M(sx * 3.75, y0, hz1 - 0.01, 0, Math.PI, 0), L.hangarRoof - y0 + 1.0);
  }
  // 05 level aft face (to the mast platform)
  ladder(pb, M(1.3, L.bridgeRoof, 9.72, 0, Math.PI, 0), L.lvl05 - L.bridgeRoof + 1.0);
}

// ------------------------------------------------------------------ raised 02 house on the hangar roof
function hangarRoofHouse(pb: PartBuilder) {
  const y0 = L.hangarRoof, y1 = 13.6;
  const house = new Block(sym([[2.3, -36.9], [3.2, -37.8], [3.2, -46.6]]), y0, y1, symSlopes([14, 9], 0, 12));
  pb.addOwned('paint', house.geometry());
  detailBlock(pb, house, [
    { e: 1, doors: [0.55], louvers: [[0.2, 12.9]], lights: 1, boxes: 1 },
    { e: 3, doors: [0.45], louvers: [[0.8, 12.9]], lights: 1, boxes: 1 },
    { e: 0 }, { e: 4 },
    { e: 5, louvers: [[0.3, 12.9]], lights: 1 },
  ], 41, y0);
  // roof gear: small SATCOM domes, whips, a vent
  for (const sx of [1, -1]) {
    pb.add('paintFine', cyl(0.35, 0.4, 0.5, 16), M(sx * 1.9, y1 + 0.25, -44.8));
    pb.add('radome', new THREE.SphereGeometry(0.55, 20, 12), M(sx * 1.9, y1 + 0.85, -44.8));
    pb.add('paintFine', cyl(0.06, 0.08, 0.4, 8), M(sx * 2.2, y1 + 0.2, -39.0));
    pb.add('white', cyl(0.015, 0.04, 5.0, 6), M(sx * 2.2, y1 + 2.9, -39.0));
  }
  pb.add('paintFine', box(1.2, 0.7, 1.0), M(0, y1 + 0.35, -40.5));
  pb.add('darkSteel', box(1.1, 0.05, 0.9), M(0, y1 + 0.72, -40.5));
}

// ------------------------------------------------------------------ deck lockers
function locker(pb: PartBuilder, m: THREE.Matrix4, w: number, h: number, d: number) {
  pb.add('paintFine', box(w, h, d), m.clone().multiply(M(0, h / 2, 0)));
  pb.add('paintFine', box(w + 0.06, 0.05, d + 0.06), m.clone().multiply(M(0, h, 0)));
  // doors: seam + handles on the +z face
  const nd = Math.max(1, Math.round(w / 0.7));
  for (let i = 0; i < nd; i++) {
    const x = -w / 2 + (i + 0.5) * (w / nd);
    pb.add('black', box(0.012, h * 0.85, 0.01), m.clone().multiply(M(x - w / nd / 2 + 0.01, h / 2, d / 2 + 0.003)));
    pb.add('darkSteel', box(0.04, 0.14, 0.04), m.clone().multiply(M(x + w / nd / 2 - 0.1, h * 0.55, d / 2 + 0.02)));
  }
  const p = new THREE.Vector3(0, h * 0.3, d / 2).applyMatrix4(m);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
  wxPoint(p, n, 'rust', 0.4, 0.05, 0.2);
}
function lockers(pb: PartBuilder) {
  for (const sx of [1, -1]) {
    const ry = sx > 0 ? -Math.PI / 2 : Math.PI / 2; // doors face outboard
    // main deck, against the forward deckhouse
    for (const z of [18.0, 11.5]) locker(pb, M(sx * 9.3, deckAt(9.3, z), z, 0, -ry, 0), 1.6, 1.1, 0.55);
    // 01 roof (forward), beside the decoy launchers
    locker(pb, M(sx * 6.6, L.lvl01, 29.4, 0, 0, 0), 1.3, 0.9, 0.6);
    // hangar roof, outboard
    locker(pb, M(sx * 7.6, L.hangarRoof, -44.6, 0, -ry, 0), 2.0, 1.0, 0.6);
    // flight-deck crash locker at the hangar face
    locker(pb, M(sx * 8.3, deckY(-56.8), -56.95, 0, Math.PI, 0), 1.0, 1.3, 0.6);
  }
}

// ------------------------------------------------------------------ antenna farm (bridge roof, 05 roof)
function antennaFarm(pb: PartBuilder) {
  const r = rng(71);
  const yb = L.bridgeRoof, y5 = L.lvl05;
  for (const sx of [1, -1]) {
    // UHF whips + blade antennas on the bridge roof wings
    for (const [x, z, h] of [[5.9, 17.2, 4.5], [5.6, 15.6, 3.2]] as V3[]) {
      pb.add('paintFine', cyl(0.08, 0.1, 0.35, 8), M(sx * x, yb + 0.17, z));
      pb.add('white', cyl(0.015, 0.035, h, 6), M(sx * x, yb + 0.35 + h / 2, z));
    }
    pb.add('paintFine', box(0.06, 0.5, 0.35), M(sx * 5.2, yb + 0.25, 18.6));
    // GPS mushrooms
    for (const z of [19.4, 19.9]) {
      pb.add('paintFine', cyl(0.03, 0.03, 0.3, 6), M(sx * 5.9, yb + 0.15, z));
      pb.add('white', cyl(0.09, 0.07, 0.07, 12), M(sx * 5.9, yb + 0.33, z));
    }
    // 05 roof: small SATCOM domes on plinths, ESM direction-finding cluster, EO director
    pb.add('paintFine', cyl(0.3, 0.35, 0.45, 16), M(sx * 3.1, y5 + 0.22, 11.2));
    pb.add('radome', new THREE.SphereGeometry(0.5, 20, 12), M(sx * 3.1, y5 + 0.78, 11.2));
    pb.add('paintFine', box(0.7, 0.9, 0.7), M(sx * 3.3, y5 + 0.45, 16.5));
    pb.add('darkSteel', cylZ(0.18, 0.18, 0.4, 14), M(sx * 3.3, y5 + 1.1, 16.7));
    pb.add('glass', cylZ(0.13, 0.13, 0.02, 14), M(sx * 3.3, y5 + 1.1, 16.91));
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      pb.add('radome', cyl(0.09, 0.09, 0.35, 10), M(sx * 3.0 + Math.cos(a) * 0.35, y5 + 0.2, 13.8 + Math.sin(a) * 0.35));
    }
    pb.add('paintFine', cyl(0.05, 0.05, 1.1, 8), M(sx * 3.0, y5 + 0.55, 13.8));
    pb.add('radome', cyl(0.14, 0.14, 0.28, 12), M(sx * 3.0, y5 + 1.2, 13.8));
    // a few random stubs
    for (let i = 0; i < 3; i++) {
      const x = sx * (2.6 + r() * 1.2), z = 9.9 + r() * 1.2;
      pb.add('darkSteel', cyl(0.02, 0.03, 1.2 + r() * 1.2, 5), M(x, y5 + 0.8, z));
    }
  }
  // ESM arrays on the horizon-search radar platform corners (mast), wind sensors on the yard
  for (const sx of [1, -1]) {
    pb.add('radome', cyl(0.16, 0.16, 0.5, 12), M(sx * 1.55, 25.2, 18.0));
    pb.add('paintFine', box(0.3, 0.2, 0.3), M(sx * 1.55, 24.85, 18.0));
  }
}

// ------------------------------------------------------------------ quad anti-ship missile canisters (fictional "Lance")
function canisterPack(pb: PartBuilder, m: THREE.Matrix4) {
  // pack along local +Z (muzzle end +Z), 2x2 canisters, elevated 12 deg on a frame
  const el = 12 * DEG;
  const pk = m.clone().multiply(M(0, 1.0, 0, -el, 0, 0));
  const Lc = 4.5, r = 0.33;
  const can = new THREE.CylinderGeometry(r, r, Lc, 8, 1, false);
  can.rotateX(Math.PI / 2);
  can.rotateZ(Math.PI / 8);
  for (const cx of [-0.36, 0.36]) for (const cy of [0.36, 1.08]) {
    const cm = pk.clone().multiply(M(cx, cy, 0));
    pb.add('paintFine', can, cm);
    for (const z of [-1.6, -0.5, 0.6, 1.7]) pb.add('paintFine', cylZ(r + 0.03, r + 0.03, 0.1, 8), cm.clone().multiply(M(0, 0, z, 0, 0, Math.PI / 8)));
    // front/back covers
    pb.add('paintFine', cylZ(r + 0.05, r + 0.05, 0.12, 8), cm.clone().multiply(M(0, 0, Lc / 2, 0, 0, Math.PI / 8)));
    pb.add('darkSteel', cylZ(r * 0.6, r * 0.6, 0.02, 12), cm.clone().multiply(M(0, 0, Lc / 2 + 0.07)));
    pb.add('darkSteel', cylZ(r + 0.04, r + 0.04, 0.2, 8), cm.clone().multiply(M(0, 0, -Lc / 2, 0, 0, Math.PI / 8)));
  }
  // clamp frames + umbilical box
  for (const z of [-1.2, 1.2]) pb.add('darkSteel', box(1.6, 0.08, 0.14), pk.clone().multiply(M(0, 1.45, z)));
  for (const z of [-1.2, 1.2]) pb.add('darkSteel', box(1.6, 0.08, 0.14), pk.clone().multiply(M(0, 0.0, z)));
  pb.add('paintFine', box(0.3, 0.5, 0.6), pk.clone().multiply(M(0.95, 0.7, -1.4)));
  // stand: two trestles, the rear one taller
  for (const [z, h] of [[-1.3, 1.0 - 1.3 * Math.sin(el)], [1.3, 1.0 + 1.3 * Math.sin(el)]] as [number, number][]) {
    for (const x of [-0.7, 0.7]) pb.add('paintFine', box(0.12, h, 0.12), m.clone().multiply(M(x, h / 2, z)));
    pb.add('paintFine', box(1.6, 0.12, 0.3), m.clone().multiply(M(0, 0.06, z)));
  }
}
function missileCanisters(pb: PartBuilder) {
  // two quad launchers cross-deck on the midships 01 roof, one firing to port, one to starboard
  canisterPack(pb, M(0, L.lvl01, -4.6, 0, Math.PI / 2, 0));
  canisterPack(pb, M(0, L.lvl01, -7.3, 0, -Math.PI / 2, 0));
  // blast deflector plates on the roof under the muzzles
  for (const [sx, z] of [[1, -4.6], [-1, -7.3]] as [number, number][]) pb.add('darkSteel', box(0.9, 0.04, 1.8), M(sx * 2.6, L.lvl01 + 0.02, z));
}

// ------------------------------------------------------------------ searchlights & signal lamps
function searchlight(pb: PartBuilder, x: number, y: number, z: number, yaw: number, R = 0.3) {
  const m = M(x, y, z, 0, yaw, 0);
  pb.add('paintFine', cyl(0.12, 0.18, 0.7, 12), m.clone().multiply(M(0, 0.35, 0)));
  pb.add('paintFine', box(R * 2 + 0.2, 0.08, 0.2), m.clone().multiply(M(0, 0.74, 0)));
  for (const s of [1, -1]) pb.add('paintFine', box(0.05, R + 0.2, 0.14), m.clone().multiply(M(s * (R + 0.08), 0.74 + (R + 0.2) / 2, 0)));
  const d = m.clone().multiply(M(0, 0.9 + R * 0.2, 0, -0.08, 0, 0));
  pb.add('paintFine', cylZ(R, R * 0.9, 0.55, 16), d);
  pb.add('paintFine', cylZ(R * 0.6, R * 0.9, 0.2, 16), d.clone().multiply(M(0, 0, -0.37)));
  pb.add('glass', cylZ(R * 0.92, R * 0.92, 0.02, 16), d.clone().multiply(M(0, 0, 0.28)));
  pb.add('darkSteel', cylZ(R + 0.02, R + 0.02, 0.05, 16), d.clone().multiply(M(0, 0, 0.27)));
  pb.add('darkSteel', box(0.08, 0.06, 0.3), d.clone().multiply(M(0, R + 0.05, -0.1)));
}
function searchlights(pb: PartBuilder) {
  for (const sx of [1, -1]) {
    searchlight(pb, sx * 5.75, L.bridgeRoof, 25.2, sx * 0.5);
    // signal lamps on the bridge-wing bulwarks (smaller, pointing outboard)
    const m = M(sx * 9.35, L.lvl03 + 1.1, 25.6, 0, sx * Math.PI / 2, 0);
    pb.add('darkSteel', cyl(0.04, 0.04, 0.3, 6), m.clone().multiply(M(0, 0.15, 0)));
    pb.add('paintFine', cylZ(0.17, 0.15, 0.36, 12), m.clone().multiply(M(0, 0.42, 0)));
    pb.add('glass', cylZ(0.15, 0.15, 0.02, 12), m.clone().multiply(M(0, 0.42, 0.19)));
    for (const dy of [-0.07, 0, 0.07]) pb.add('darkSteel', box(0.3, 0.015, 0.02), m.clone().multiply(M(0, 0.42 + dy, 0.2)));
    // flight-deck floodlight pair on hangar roof edge (aft)
    searchlight(pb, sx * 7.4, L.hangarRoof, -55.6, Math.PI + sx * 0.25, 0.22);
  }
}

// ------------------------------------------------------------------ ensign on a gaff aft of the mast
function ensign(pb: PartBuilder) {
  const base = new THREE.Vector3(0, 29.6, 13.1), tip = new THREE.Vector3(0, 31.3, 10.3);
  const [g, m] = rod(base, tip, 0.06, 8, 0.04);
  pb.addOwned('paintFine', g, m);
  const [g2, m2] = rod(base.clone().add(new THREE.Vector3(0, -1.2, 0.05)), tip.clone().lerp(base, 0.35), 0.025, 6);
  pb.addOwned('paintFine', g2, m2);
  // flag: hoist at the peak, streaming aft with a few ripples (static cloth)
  const W = 2.2, H = 1.35, NW = 16, NH = 4;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= NH; j++)
    for (let i = 0; i <= NW; i++) {
      const u = i / NW, v = j / NH;
      const wave = Math.sin(u * 7.5 - 0.6 + v * 0.8) * 0.16 * u + Math.sin(u * 13 + 1.1) * 0.04 * u;
      const droop = -0.25 * u * u;
      pos.push(wave, tip.y - 0.1 - H + v * H + droop, tip.z - 0.05 - u * W * 0.97);
      uv.push(u, v);
    }
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      const a = j * (NW + 1) + i, b = a + 1, c = a + NW + 2, d = a + NW + 1;
      idx.push(a, b, c, a, c, d);
    }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fg.setIndex(idx);
  fg.computeVertexNormals();
  pb.addOwned('flag', fg, undefined, { uv: 'keep' });
  // halyard
  const [hg, hm] = rod(tip, new THREE.Vector3(0, L.lvl05 + 0.5, 11.0), 0.008, 3);
  pb.addOwned('wire', hg, hm);
}

// ------------------------------------------------------------------ crew figures (static, low poly)
type RGB = [number, number, number];
const NAVY: RGB = [0.07, 0.09, 0.15], SKIN: RGB = [0.55, 0.38, 0.28], BOOT: RGB = [0.04, 0.04, 0.04];
function colored(g: THREE.BufferGeometry, c: RGB) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
/** A 1.78 m figure standing at the origin facing +Z. `top` = torso/vest colour, `cap` = headgear colour. */
function figure(pb: PartBuilder, m: THREE.Matrix4, top: RGB, cap: RGB, pose: 'stand' | 'binos' | 'wave' | 'point' = 'stand') {
  const add = (g: THREE.BufferGeometry, c: RGB, lm: THREE.Matrix4) => pb.addOwned('crew', colored(g, c), m.clone().multiply(lm), { keep: ['color'] });
  for (const s of [1, -1]) {
    add(new THREE.CylinderGeometry(0.075, 0.062, 0.84, 6), NAVY, M(s * 0.1, 0.5, 0, 0, 0, s * 0.03));
    add(new THREE.BoxGeometry(0.11, 0.09, 0.27), BOOT, M(s * 0.11, 0.045, 0.04));
  }
  add(new THREE.BoxGeometry(0.34, 0.24, 0.21), NAVY, M(0, 0.98, 0));
  add(new THREE.CylinderGeometry(0.19, 0.16, 0.52, 7), top, M(0, 1.32, 0, 0, 0, 0, 1, 1, 0.66));
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 6), SKIN, M(0, 1.62, 0));
  add(new THREE.SphereGeometry(0.105, 8, 6), SKIN, M(0, 1.72, 0.01, 0, 0, 0, 0.92, 1.1, 1));
  add(new THREE.SphereGeometry(0.115, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), cap, M(0, 1.75, 0));
  if (cap !== NAVY) add(new THREE.BoxGeometry(0.2, 0.03, 0.1), cap, M(0, 1.75, 0.1));
  // arms: shoulder pivot at y 1.52, x 0.23
  const arm = (s: number, rx: number, rz: number) => {
    const sh = M(s * 0.23, 1.52, 0, rx, 0, rz);
    add(new THREE.CylinderGeometry(0.05, 0.045, 0.6, 6), top, sh.clone().multiply(M(0, -0.3, 0)));
    add(new THREE.SphereGeometry(0.05, 6, 4), SKIN, sh.clone().multiply(M(0, -0.63, 0)));
  };
  if (pose === 'binos') {
    arm(1, -2.3, 0.35); arm(-1, -2.3, -0.35);
    add(new THREE.BoxGeometry(0.16, 0.08, 0.14), BOOT, M(0, 1.7, 0.15));
  } else if (pose === 'wave') {
    arm(1, 0, 0.1); arm(-1, 0.3, -2.6);
  } else if (pose === 'point') {
    arm(1, -1.45, 0.15); arm(-1, 0.1, -0.1);
  } else {
    arm(1, 0.1, 0.12); arm(-1, -0.1, -0.12);
  }
}
function crew(pb: PartBuilder) {
  const YEL: RGB = [0.75, 0.6, 0.08], BRN: RGB = [0.3, 0.2, 0.12], BLU: RGB = [0.1, 0.22, 0.5], WHT: RGB = [0.8, 0.8, 0.78], GRN: RGB = [0.15, 0.4, 0.2], KHAKI: RGB = [0.45, 0.4, 0.3];
  // bridge wings: lookout with binoculars (port), officer (stbd)
  figure(pb, M(8.75, L.lvl03, 26.2, 0, 0.9, 0), NAVY, NAVY, 'binos');
  figure(pb, M(-8.3, L.lvl03, 25.5, 0, -1.2, 0), KHAKI, NAVY, 'stand');
  // flight deck: director (yellow), chock/chain (blue, brown), safety (white)
  const fd = (x: number, z: number) => deckAt(x, z);
  figure(pb, M(0.4, fd(0.4, -59.2), -59.2, 0, Math.PI, 0), YEL, YEL, 'wave');
  figure(pb, M(4.6, fd(4.6, -64.5), -64.5, 0, -1.9, 0), BLU, BLU, 'stand');
  figure(pb, M(-4.2, fd(4.2, -69.5), -69.5, 0, 2.3, 0), BRN, BRN, 'point');
  figure(pb, M(-6.8, fd(6.8, -58.2), -58.2, 0, 2.8, 0), WHT, WHT, 'stand');
  figure(pb, M(6.9, fd(6.9, -71.0), -71.0, 0, -2.2, 0), GRN, GRN, 'stand');
  // foredeck line handlers near the windlass, one on the 01 level by the boats
  figure(pb, M(2.9, deckAt(2.9, 57.4), 57.4, 0, -0.7, 0), NAVY, NAVY, 'point');
  figure(pb, M(-3.6, deckAt(3.6, 55.2), 55.2, 0, 2.6, 0), NAVY, NAVY, 'stand');
  figure(pb, M(6.2, L.lvl01, 1.6, 0, 1.4, 0), NAVY, NAVY, 'stand');
}

export const _unusedX = [prismBetween];
