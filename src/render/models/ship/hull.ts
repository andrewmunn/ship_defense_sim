import * as THREE from 'three';
import { Curve1D, PartBuilder, M, loftRings, latheZ, cylZ, profileSolid, V2, clamp, smooth, DEG, alongY, normalizeGeo } from './geom';
import {
  LOA, Z_BOW, Z_STERN, Z_STEM_WL, KEEL, TRANSOM_BOTTOM,
  deckY, hbDeck, hbWL, keelY, secP, flareQ, deadrise, stemY, CAMBER, flareFrac, KNUCKLE_T,
} from './hulldef';

/** Hull texture v-range (signed girth from the waterline, meters). */
export const HULL_G0 = -17;
export const HULL_G1 = 12.5;
export const hullU = (z: number) => (Z_BOW - z) / LOA;
export const hullV = (g: number) => (g - HULL_G0) / (HULL_G1 - HULL_G0);

/** Bow bulwark height at z. */
export function bulwarkH(z: number) {
  // low spray lip at the stem head only (lifelines run almost to the stem)
  if (z < BW_Z0) return 0;
  if (z < BW_Z0 + 2.5) return 0.55 * smooth((z - BW_Z0) / 2.5);
  return 0.55;
}
export const BW_Z0 = 71.0;

const NB = 60; // underwater ring samples
const NA = 40; // above-water ring samples
const NW = 3; // bulwark rows
const KN_ROW = Math.round(KNUCKLE_T * NA); // above-water row on the knuckle (duplicated)

/** Station z positions: denser at the bow. */
function stations(): number[] {
  const zs: number[] = [];
  let z = Z_STERN;
  while (z < Z_BOW - 1e-6) {
    zs.push(z);
    const ds = z > 58 ? 0.2 : z > 40 ? 0.4 : z < -70 ? 0.3 : 0.55;
    z += ds;
  }
  zs.push(Z_BOW);
  if (!zs.some((v) => Math.abs(v - Z_STEM_WL) < 0.05)) zs.push(Z_STEM_WL);
  return zs.sort((a, b) => a - b);
}

/** Section ring at z: returns list of [x, y, girth]. */
export function section(z: number, out: [number, number, number][] = []) {
  out.length = 0;
  const w = hbWL(z), d = hbDeck(z), yd = deckY(z);
  const fwd = z >= Z_STEM_WL;
  const ys = fwd ? stemY(z) : 0;
  const yb = keelY(z);
  const p = secP(z), dr = deadrise(z);
  // underwater: theta 0 (keel) -> pi/2 (WL)
  const below: [number, number][] = [];
  for (let i = 0; i <= NB; i++) {
    if (fwd) {
      below.push([0, ys]);
      continue;
    }
    // bias samples toward bilge by using theta directly
    const th = (i / NB) * (Math.PI / 2);
    const s = Math.sin(th), c = Math.cos(th);
    const x = w * Math.pow(s, 2 / p);
    let y = yb * Math.pow(c, 2 / p);
    y += dr * x * (y / yb);
    below.push([x, y]);
  }
  // girth (negative below WL)
  let g = 0;
  const gb: number[] = new Array(below.length);
  gb[NB] = 0;
  for (let i = NB - 1; i >= 0; i--) {
    g -= Math.hypot(below[i + 1][0] - below[i][0], below[i + 1][1] - below[i][1]);
    gb[i] = g;
  }
  for (let i = 0; i <= NB; i++) out.push([below[i][0], below[i][1], gb[i]]);
  const q = flareQ(z);
  const y0 = fwd ? ys : 0;
  for (let i = 1; i <= NA; i++) {
    const t = i / NA;
    const y = y0 + (yd - y0) * t;
    const x = w + (d - w) * flareFrac(z, t);
    out.push([x, y, y]);
    // duplicated knuckle row: the zero-width quad between the twins splits the vertex normals -> crisp knuckle line
    if (i === KN_ROW) out.push([x, y, y]);
  }
  // bulwark (outer face continues flare upward)
  const bh = bulwarkH(z);
  const slope = d > 0.01 ? Math.min(1.2, ((d - w) * (flareFrac(z, 1) - flareFrac(z, 0.97))) / 0.03 / Math.max(yd - y0, 0.5)) * 0.8 : 0;
  void q;
  for (let i = 1; i <= NW; i++) {
    const h = (bh * i) / NW;
    out.push([d + slope * h, yd + h, yd + h]);
  }
  return out;
}

export function buildHull(pb: PartBuilder) {
  const zs = stations();
  const ringN = NB + 1 + NA + 1 + NW;
  const ns = zs.length;
  const pos = new Float32Array(ns * ringN * 3);
  const uv = new Float32Array(ns * ringN * 2);
  const ring: [number, number, number][] = [];
  for (let i = 0; i < ns; i++) {
    section(zs[i], ring);
    for (let j = 0; j < ringN; j++) {
      const k = i * ringN + j;
      pos[k * 3] = ring[j][0];
      pos[k * 3 + 1] = ring[j][1];
      pos[k * 3 + 2] = zs[i];
      uv[k * 2] = hullU(zs[i]);
      uv[k * 2 + 1] = hullV(ring[j][2]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < ns - 1; i++)
    for (let j = 0; j < ringN - 1; j++) {
      const a = i * ringN + j, b = a + 1, c = a + ringN + 1, d = a + ringN;
      // port side (x>0) outward normal: order so that normal points +x
      idx.push(a, b, c, a, c, d);
    }
  const port = new THREE.BufferGeometry();
  port.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  port.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  port.setIndex(idx);
  port.computeVertexNormals();
  // verify orientation using a midship vertex: normal x should be > 0
  const test = (Math.floor(ns / 2) * ringN + NB + 5);
  if (port.attributes.normal.getX(test) < 0) {
    const ix = port.index!.array as unknown as number[];
    for (let t = 0; t < ix.length; t += 3) {
      const tmp = ix[t + 1];
      ix[t + 1] = ix[t + 2];
      ix[t + 2] = tmp;
    }
    port.index!.needsUpdate = true;
    port.computeVertexNormals();
  }
  const stbd = mirrorX(port);
  pb.addOwned('hull', port, undefined, { uv: 'keep' });
  pb.addOwned('hull', stbd, undefined, { uv: 'keep' });

  // ---- transom (flat, at Z_STERN)
  {
    section(Z_STERN, ring);
    const pts: [number, number, number][] = ring.slice(0, NB + 1 + NA + 1).map((r) => [r[0], r[1], r[2]]);
    const tp: number[] = [];
    const tuv: number[] = [];
    const ti: number[] = [];
    // strip between centerline x=0 and the ring on each side
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      const base = tp.length / 3;
      for (const [x, y, g] of pts) {
        tp.push(sx * x, y, Z_STERN, 0, y, Z_STERN);
        tuv.push(hullU(Z_STERN) - 0.002, hullV(g), hullU(Z_STERN) - 0.002, hullV(y));
      }
      for (let j = 0; j < pts.length - 1; j++) {
        const a = base + j * 2, b = a + 1, c = a + 3, d = a + 2;
        if (sx > 0) ti.push(a, d, c, a, c, b);
        else ti.push(a, c, d, a, b, c);
      }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    tg.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
    tg.setIndex(ti);
    tg.computeVertexNormals();
    fixFacing(tg, new THREE.Vector3(0, 0, -1));
    pb.addOwned('hull', tg, undefined, { uv: 'keep' });
    // stern flap
    const flap = profileSolid([[Z_STERN + 0.2, TRANSOM_BOTTOM + 0.35], [Z_STERN - 1.1, TRANSOM_BOTTOM - 0.02], [Z_STERN - 1.1, TRANSOM_BOTTOM - 0.12], [Z_STERN + 0.2, TRANSOM_BOTTOM - 0.05]], 5.2);
    pb.addOwned('antifoul', flap);
  }

  buildDeck(pb, zs);
  buildBulwarkInner(pb, zs);
  buildDome(pb);
  buildSkeg(pb);
  buildBilgeKeels(pb);
}

function fixFacing(g: THREE.BufferGeometry, dir: THREE.Vector3) {
  const n = g.attributes.normal;
  let s = 0;
  for (let i = 0; i < n.count; i++) s += n.getX(i) * dir.x + n.getY(i) * dir.y + n.getZ(i) * dir.z;
  if (s < 0) {
    const ix = g.index!.array as unknown as number[];
    for (let t = 0; t < ix.length; t += 3) {
      const tmp = ix[t + 1];
      ix[t + 1] = ix[t + 2];
      ix[t + 2] = tmp;
    }
    g.computeVertexNormals();
  }
}

export function mirrorX(g: THREE.BufferGeometry) {
  const m = g.clone();
  const p = m.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i));
  const ix = m.index!.array as unknown as number[];
  for (let t = 0; t < ix.length; t += 3) {
    const tmp = ix[t + 1];
    ix[t + 1] = ix[t + 2];
    ix[t + 2] = tmp;
  }
  m.computeVertexNormals();
  return m;
}

/** Main deck surface with camber. uv = tiled meters (non-skid), uv1 = unique atlas (markings). */
function buildDeck(pb: PartBuilder, zs: number[]) {
  const NX = 28;
  const list = zs.filter((z) => z < Z_BOW);
  list.push(Z_BOW - 0.02);
  const ns = list.length;
  const cols = NX + 1;
  const pos = new Float32Array(ns * cols * 3);
  const uv = new Float32Array(ns * cols * 2);
  const uv1 = new Float32Array(ns * cols * 2);
  for (let i = 0; i < ns; i++) {
    const z = list[i];
    const hb = hbDeck(z), yd = deckY(z);
    for (let j = 0; j <= NX; j++) {
      const t = (j / NX) * 2 - 1;
      const x = t * hb;
      const y = yd + CAMBER * (1 - t * t) + 0.005;
      const k = i * cols + j;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3; uv[k * 2 + 1] = z / 3;
      uv1[k * 2] = (x + 10.1) / 20.2; uv1[k * 2 + 1] = (z - Z_STERN) / LOA;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < ns - 1; i++)
    for (let j = 0; j < NX; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols + 1, d = a + cols;
      idx.push(a, c, b, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  fixFacing(g, new THREE.Vector3(0, 1, 0));
  pb.addOwned('deck', g, undefined, { uv: 'keep', keep: ['uv1'] });
}

/** Inner face + cap rail of the bow bulwark. */
function buildBulwarkInner(pb: PartBuilder, zs: number[]) {
  const list = zs.filter((z) => z >= BW_Z0);
  const ring: [number, number, number][] = [];
  const rows: THREE.Vector3[][] = [];
  const T = 0.12;
  for (const z of list) {
    section(z, ring);
    const top = ring[ring.length - 1];
    const base = ring[ring.length - 1 - NW];
    const bh = bulwarkH(z);
    const inX = (x: number) => Math.max(0, x - T);
    // outer top -> inner top -> inner bottom (on deck)
    rows.push([
      new THREE.Vector3(top[0], top[1], z),
      new THREE.Vector3(inX(top[0]), top[1], z),
      new THREE.Vector3(inX(base[0]) - 0.02, base[1] + CAMBER * 0.1 - 0.02, z),
    ]);
    void bh;
  }
  const g = loftRings(rows, false);
  fixFacingInward(g);
  const g2 = mirrorX(g);
  pb.addOwned('paint', g);
  pb.addOwned('paint', g2);
}
function fixFacingInward(g: THREE.BufferGeometry) {
  fixFacing(g, new THREE.Vector3(-1, 0.3, 0));
}

// ---------------------------------------------------------------- sonar dome (SQS-53)
function buildDome(pb: PartBuilder) {
  const zN = 67.3, zT = 37.5;
  const bot = new Curve1D([[zT, -6.25], [42, -6.9], [46, -7.95], [50, -8.8], [54, -9.28], [58, -9.4], [61.5, -9.22], [64, -8.55], [65.8, -7.4], [66.8, -5.9], [zN, -4.4]]);
  const topN = new Curve1D([[65.6, -0.75], [66.4, -1.2], [66.9, -2.4], [zN, -4.0]]);
  const half = new Curve1D([[zT, 0.25], [40, 0.9], [44, 1.6], [48, 2.05], [53, 2.3], [58, 2.3], [62, 2.05], [64.5, 1.7], [66, 1.2], [66.8, 0.72], [67.15, 0.32], [zN, 0.0]]);
  const rings: THREE.Vector3[][] = [];
  const NS = 70, NR = 40;
  for (let i = 0; i <= NS; i++) {
    const u = i / NS;
    const z = zT + (zN - zT) * (1 - Math.pow(1 - u, 1.7));
    const yb = bot.at(z);
    const yt = z < 65.6 ? Math.min(keelY(z) + 0.7, -0.75) : topN.at(z);
    const a = Math.max(half.at(z), 0.002);
    const b = Math.max((yt - yb) / 2, 0.002), cy = (yb + yt) / 2;
    const r: THREE.Vector3[] = [];
    for (let j = 0; j < NR; j++) {
      const th = (j / NR) * Math.PI * 2;
      const s = Math.sin(th), c = Math.cos(th);
      const pe = 2.3;
      const y = cy - b * Math.sign(c) * Math.pow(Math.abs(c), 2 / pe);
      // teardrop: narrow toward the top so the bulb blends into the forefoot
      const t = clamp((y - yb) / Math.max(yt - yb, 1e-3), 0, 1);
      const wm = t < 0.5 ? 1 : 1 - 0.35 * smooth((t - 0.5) / 0.5);
      const x = a * wm * Math.sign(s) * Math.pow(Math.abs(s), 2 / pe);
      r.push(new THREE.Vector3(x, y, z));
    }
    rings.push(r);
  }
  const g = loftRings(rings, true, true, false);
  pb.addOwned('dome', g, undefined, { uvScale: 1 / 6 });
}

// ---------------------------------------------------------------- skeg, bilge keels
function buildSkeg(pb: PartBuilder) {
  const prof: V2[] = [
    [-7, KEEL + 0.6], [-9, KEEL - 0.02], [-22, KEEL + 0.05], [-36, KEEL + 0.55], [-46, KEEL + 1.25], [-51.5, KEEL + 1.9],
    [-53.8, -2.2], [-50, -2.6], [-40, -3.9], [-28, -5.1], [-16, -5.8],
  ];
  const w = prof.map(([z, y]) => (z > -9 || z < -52 ? 0.06 : 0.32 - 0.12 * clamp((-z - 10) / 40, 0, 1)) * (y > -3 ? 0.6 : 1));
  pb.addOwned('antifoul', profileSolid(prof, w), undefined, { uvScale: 1 / 6 });
}

function buildBilgeKeels(pb: PartBuilder) {
  const z0 = -26, z1 = 20;
  const rings: THREE.Vector3[][] = [];
  const ring: [number, number, number][] = [];
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const z = z0 + ((z1 - z0) * i) / N;
    section(z, ring);
    // bilge point ~ 55% of underwater theta
    const j = Math.round(NB * 0.52);
    const [x, y] = ring[j];
    const [xa, ya] = ring[j - 1], [xb, yb] = ring[j + 1];
    // outward normal of the section curve (port side)
    let nx = yb - ya, ny = -(xb - xa);
    const L = Math.hypot(nx, ny);
    nx /= L; ny /= L;
    if (nx < 0) { nx = -nx; ny = -ny; }
    const taper = Math.min(1, (z - z0) / 6, (z1 - z) / 6);
    const depth = 0.85 * Math.max(0, taper) + 0.02;
    const th = 0.035;
    const P = (d: number, t: number) => new THREE.Vector3(x - 0.05 * nx + nx * d + (-ny) * t * 0, y - 0.05 * ny + ny * d, z).add(new THREE.Vector3(-ny * t, nx * t, 0));
    rings.push([P(0, th), P(depth, th), P(depth, -th), P(0, -th)]);
  }
  const g = loftRings(rings, true, true, true);
  pb.addOwned('antifoul', g, undefined, { uvScale: 1 / 6 });
  pb.addOwned('antifoul', mirrorX(g), undefined, { uvScale: 1 / 6 });
}

// ---------------------------------------------------------------- shafts, struts, props, rudders
export const PROP = { x: 4.45, y: -4.7, z: -58.6, R: 2.59 };
export const RUDDER = { x: 4.45, z: -64.4 };

export function buildRunningGear(pb: PartBuilder, root: THREE.Object3D, mats: Record<string, THREE.Material>) {
  for (const side of [1, -1]) {
    const sx = side;
    const exit = new THREE.Vector3(sx * 3.75, -5.0, -27.5);
    const hub = new THREE.Vector3(sx * PROP.x, PROP.y, PROP.z + 0.9);
    // shaft
    const [m, len] = alongY(exit, hub);
    pb.add('steel', new THREE.CylinderGeometry(0.26, 0.26, len, 16, 1, true), m);
    // shaft bossing / fairing at exit
    const [m2, len2] = alongY(exit.clone().add(new THREE.Vector3(-sx * 0.25, 0.9, 5)), exit.clone().lerp(hub, 0.08));
    pb.add('antifoul', new THREE.CylinderGeometry(0.34, 0.75, len2, 16), m2, { uvScale: 1 / 6 });
    // intermediate strut (single) and V-strut near prop
    const strutAt = (t: number, legs: [number, number][]) => {
      const c = exit.clone().lerp(hub, t);
      pb.add('antifoul', new THREE.CylinderGeometry(0.42, 0.42, 1.3, 16), M(c.x, c.y, c.z, Math.PI / 2), { uvScale: 1 / 6 });
      for (const [lx, ly] of legs) {
        const top = new THREE.Vector3(lx, ly, c.z);
        const [ms, ls] = alongY(c, top);
        const g = new THREE.CylinderGeometry(1, 1, ls, 12);
        g.scale(0.09, 1, 0.55);
        pb.add('antifoul', g, ms, { uvScale: 1 / 6 });
      }
    };
    const cA = exit.clone().lerp(hub, 0.42);
    strutAt(0.42, [[cA.x - sx * 0.3, -1.2]]);
    const cB = exit.clone().lerp(hub, 0.9);
    strutAt(0.9, [[cB.x - sx * 1.9, 0.0], [cB.x + sx * 1.3, 0.2]]);

    // propeller (named, spins about local +Z)
    const prop = new THREE.Group();
    prop.name = sx > 0 ? 'prop_port' : 'prop_stbd';
    prop.position.set(sx * PROP.x, PROP.y, PROP.z);
    const pp = new PartBuilder();
    const hubG = latheZ([[0, 1.25], [0.52, 1.1], [0.66, 0.6], [0.7, -0.2], [0.62, -0.9], [0.4, -1.35], [0.12, -1.6], [0, -1.65]], 28);
    pp.add('bronze', hubG, undefined, { uvScale: 1 / 2 });
    const blade = propBlade(sx > 0 ? 1 : -1);
    for (let b = 0; b < 5; b++) pp.add('bronze', blade, M(0, 0, 0, 0, 0, (b / 5) * Math.PI * 2), { uvScale: 1 / 2 });
    pp.build(prop, mats, prop.name);
    root.add(prop);

    // rudder (named, yaw about local +Y at the stock)
    const rud = new THREE.Group();
    rud.name = sx > 0 ? 'rudder_port' : 'rudder_stbd';
    rud.position.set(sx * RUDDER.x, 0, RUDDER.z);
    const rp = new PartBuilder();
    rp.addOwned('antifoul', rudderGeo(), undefined, { uvScale: 1 / 6 });
    rp.add('steel', new THREE.CylinderGeometry(0.22, 0.22, 1.2, 12), M(0, -0.8, 0));
    rp.build(rud, mats, rud.name);
    root.add(rud);
  }
}

function rudderGeo() {
  const yTop = -0.85, yBot = -6.05;
  const rings: THREE.Vector3[][] = [];
  const NC = 20;
  const levels = 8;
  for (let l = 0; l <= levels; l++) {
    const t = l / levels;
    const y = yTop + (yBot - yTop) * t;
    const chord = 3.9 - 0.7 * t;
    const zLE = 1.25 - 0.25 * t;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < NC * 2; j++) {
      const s = j < NC ? j / NC : 2 - j / NC; // 0..1..0
      const up = j < NC ? 1 : -1;
      const xs = s; // chord fraction
      const th = 0.2 * chord * 5 * (0.2969 * Math.sqrt(xs) - 0.126 * xs - 0.3516 * xs * xs + 0.2843 * xs ** 3 - 0.1036 * xs ** 4);
      ring.push(new THREE.Vector3(up * th, y, zLE - xs * chord));
    }
    rings.push(ring);
  }
  return loftRings(rings, true, true, true);
}

/** One CPP blade around +Z axis, at angle 0 (pointing +Y). hand = rotation handedness. */
function propBlade(hand: number) {
  const rh = 0.6, R = PROP.R;
  const NR = 12, NC = 12;
  const P = 1.15 * 2 * R;
  const face: THREE.Vector3[][] = [], back: THREE.Vector3[][] = [];
  for (let i = 0; i <= NR; i++) {
    const u = i / NR;
    const r = rh + (R - rh) * (1 - Math.pow(1 - u, 1.4)) * 0.999 + 0.001;
    const rn = (r - rh) / (R - rh);
    let c = 0.95 + 1.1 * Math.sin(Math.min(rn, 0.62) / 0.62 * Math.PI / 2);
    if (rn > 0.62) c *= Math.sqrt(Math.max(0, 1 - Math.pow((rn - 0.62) / 0.38, 2)));
    c = Math.max(c, 0.02);
    const skew = 0.42 * rn * rn;
    const phi = Math.atan(P / (2 * Math.PI * r));
    const thick = 0.13 * (1 - 0.88 * rn) + 0.01;
    const fr: THREE.Vector3[] = [], bk: THREE.Vector3[] = [];
    for (let j = 0; j <= NC; j++) {
      const s = (j / NC - 0.5) * c; // chord coordinate
      const prof = Math.sqrt(Math.max(0, 1 - Math.pow((2 * s) / c, 2)));
      const tf = thick * prof;
      const pt = (off: number) => {
        const tang = s * Math.cos(phi) + off * Math.sin(phi);
        const ax = -s * Math.sin(phi) + off * Math.cos(phi);
        const th = Math.PI / 2 + hand * (skew + tang / r);
        return new THREE.Vector3(r * Math.cos(th), r * Math.sin(th), hand * ax * 1);
      };
      fr.push(pt(-tf * 0.3));
      bk.push(pt(tf * 0.7));
    }
    face.push(fr);
    back.push(bk);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const grid = (G: THREE.Vector3[][], flip: boolean) => {
    const base = pos.length / 3;
    for (const row of G) for (const p of row) pos.push(p.x, p.y, p.z);
    const cols = NC + 1;
    for (let i = 0; i < NR; i++)
      for (let j = 0; j < NC; j++) {
        const a = base + i * cols + j, b = a + 1, c2 = a + cols + 1, d = a + cols;
        if (flip) idx.push(a, c2, b, a, d, c2);
        else idx.push(a, b, c2, a, c2, d);
      }
  };
  grid(face, false);
  grid(back, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  normalizeGeo(g);
  return g;
}

export { NB, NA, NW };
export const _unused = [DEG, cylZ];
