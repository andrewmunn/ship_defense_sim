import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Small geometry toolkit used by the procedural Vanguard-class model. */

export type V2 = [number, number];
export type V3 = [number, number, number];

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a matrix: translate, then Euler (XYZ, radians), then scale. */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, order: THREE.EulerOrder = 'XYZ') {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Matrix that maps +Y (e.g. a cylinder axis) onto the segment a->b, positioned at the midpoint; returns [matrix, length]. */
export function alongY(a: THREE.Vector3, b: THREE.Vector3): [THREE.Matrix4, number] {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return [m, len];
}

/** Ensure geometry is indexed, has position/normal/uv and nothing else (unless keep lists it). */
export function normalizeGeo(g: THREE.BufferGeometry, keep: string[] = []): THREE.BufferGeometry {
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && !keep.includes(k)) g.deleteAttribute(k);
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/** Box-projected UVs in meters (after transforms), consistent texel density. */
export function boxUV(g: THREE.BufferGeometry, scale = 1 / 8) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (ay >= ax && ay >= az) uv.setXY(i, x * scale, z * scale);
    else if (ay > 0.03) {
      // tilted wall: u along the face's horizontal tangent so that texture 'down' stays world-down
      const nx = n.getX(i), nz = n.getZ(i);
      const L = Math.hypot(nx, nz) || 1;
      uv.setXY(i, ((-nz * x + nx * z) / L) * scale, y * scale);
    } else if (ax >= az) uv.setXY(i, z * scale, y * scale);
    else uv.setXY(i, x * scale, y * scale);
  }
  uv.needsUpdate = true;
}

export interface AddOpts {
  uv?: 'box' | 'keep';
  uvScale?: number;
  keep?: string[];
}

/** Accumulates geometry per material key, then merges into one mesh per material. */
export class PartBuilder {
  lists = new Map<string, THREE.BufferGeometry[]>();
  add(mat: string, g: THREE.BufferGeometry, m?: THREE.Matrix4, opts: AddOpts = {}) {
    const geo = normalizeGeo(g.clone(), opts.keep);
    if (m) geo.applyMatrix4(m);
    if ((opts.uv ?? 'box') === 'box') boxUV(geo, opts.uvScale ?? 1 / 8);
    let l = this.lists.get(mat);
    if (!l) this.lists.set(mat, (l = []));
    l.push(geo);
    return geo;
  }
  /** Add without cloning (geometry is consumed). */
  addOwned(mat: string, g: THREE.BufferGeometry, m?: THREE.Matrix4, opts: AddOpts = {}) {
    const geo = normalizeGeo(g, opts.keep);
    if (m) geo.applyMatrix4(m);
    if ((opts.uv ?? 'box') === 'box') boxUV(geo, opts.uvScale ?? 1 / 8);
    let l = this.lists.get(mat);
    if (!l) this.lists.set(mat, (l = []));
    l.push(geo);
    return geo;
  }
  /** Merge into meshes added to `parent`. */
  build(parent: THREE.Object3D, mats: Record<string, THREE.Material>, prefix = 'part') {
    for (const [k, list] of this.lists) {
      if (!list.length) continue;
      const mat = mats[k];
      if (!mat) throw new Error('missing material ' + k);
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) throw new Error('merge failed for ' + k);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${prefix}_${k}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.lists.clear();
  }
}

// ---------------------------------------------------------------- primitives

export function box(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d);
}
export function cyl(rTop: number, rBot: number, h: number, seg = 16, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
}
/** Cylinder along +Z centered at origin. */
export function cylZ(rTop: number, rBot: number, h: number, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  g.rotateX(Math.PI / 2); // +Y -> +Z  (top end at +Z)
  return g;
}
export function sphere(r: number, ws = 16, hs = 12, phiStart = 0, phiLen = Math.PI * 2, thStart = 0, thLen = Math.PI) {
  return new THREE.SphereGeometry(r, ws, hs, phiStart, phiLen, thStart, thLen);
}

/** Cylinder between two points. */
export function rod(a: THREE.Vector3 | V3, b: THREE.Vector3 | V3, r: number, seg = 8, r2?: number): [THREE.BufferGeometry, THREE.Matrix4] {
  const A = Array.isArray(a) ? new THREE.Vector3(...a) : a;
  const B = Array.isArray(b) ? new THREE.Vector3(...b) : b;
  const [m, len] = alongY(A, B);
  return [new THREE.CylinderGeometry(r2 ?? r, r, len, seg, 1, true), m];
}

/** Square-section beam between two points. */
export function beam(a: V3, b: V3, w: number, h = w): [THREE.BufferGeometry, THREE.Matrix4] {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const [m, len] = alongY(A, B);
  return [new THREE.BoxGeometry(w, len, h), m];
}

// ---------------------------------------------------------------- polygon frustum (faceted deckhouses)

function polyArea(p: V2[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Offset polygon edges inward by per-edge distances (edge i = p[i]->p[i+1]). */
export function offsetPoly(p: V2[], d: number[] | number): V2[] {
  const n = p.length;
  const sgn = polyArea(p) > 0 ? 1 : -1;
  const lines: { px: number; pz: number; dx: number; dz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % n];
    let dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    // left normal (-dz, dx) is inward for CCW (positive area)
    const nx = -dz * sgn, nz = dx * sgn;
    const di = Array.isArray(d) ? d[i] : d;
    lines.push({ px: x0 + nx * di, pz: z0 + nz * di, dx, dz });
  }
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n], b = lines[i];
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-6) {
      out.push([b.px, b.pz]);
      continue;
    }
    const t = ((b.px - a.px) * b.dz - (b.pz - a.pz) * b.dx) / den;
    out.push([a.px + a.dx * t, a.pz + a.dz * t]);
  }
  return out;
}

/**
 * Faceted frustum from a plan polygon (x,z) at y0 to an inward-offset polygon at y1.
 * slopeDeg: per-edge inward inclination from vertical (0 = vertical wall).
 * Flat-shaded, indexed.
 */
export function frustum(poly: V2[], y0: number, y1: number, slopeDeg: number | number[], opts: { top?: boolean; bottom?: boolean; topPoly?: V2[] } = {}) {
  const h = y1 - y0;
  const n = poly.length;
  const d = Array.isArray(slopeDeg) ? slopeDeg.map((s) => Math.tan((s * Math.PI) / 180) * h) : new Array(n).fill(Math.tan((slopeDeg * Math.PI) / 180) * h);
  const top = opts.topPoly ?? offsetPoly(poly, d);
  return prismBetween(poly, y0, top, y1, opts.top ?? true, opts.bottom ?? false);
}

/** Generic flat-shaded solid between two polygons with equal vertex counts. */
export function prismBetween(bot: V2[], y0: number, top: V2[], y1: number, capTop = true, capBot = false) {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = bot.length;
  let cx = 0, cz = 0;
  for (const [x, z] of bot) { cx += x; cz += z; }
  cx /= n; cz /= n;
  const pushTri = (a: V3, b: V3, c: V3, outward: V3) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2], nz = ab[0] * ac[1] - ab[1] * ac[0];
    const flip = nx * outward[0] + ny * outward[1] + nz * outward[2] < 0;
    const base = pos.length / 3;
    pos.push(...a, ...(flip ? c : b), ...(flip ? b : c));
    idx.push(base, base + 1, base + 2);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0: V3 = [bot[i][0], y0, bot[i][1]], b1: V3 = [bot[j][0], y0, bot[j][1]];
    const t0: V3 = [top[i][0], y1, top[i][1]], t1: V3 = [top[j][0], y1, top[j][1]];
    const mx = (bot[i][0] + bot[j][0]) / 2 - cx, mz = (bot[i][1] + bot[j][1]) / 2 - cz;
    const out: V3 = [mx, 0, mz];
    pushTri(b0, b1, t1, out);
    pushTri(b0, t1, t0, out);
  }
  const cap = (p: V2[], y: number, up: boolean) => {
    const tris = THREE.ShapeUtils.triangulateShape(p.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [a, b, c] of tris) pushTri([p[a][0], y, p[a][1]], [p[b][0], y, p[b][1]], [p[c][0], y, p[c][1]], [0, up ? 1 : -1, 0]);
  };
  if (capTop) cap(top, y1, true);
  if (capBot) cap(bot, y0, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals(); // vertices are unshared per triangle -> flat
  return g;
}

/**
 * Faceted solid extruded along X from a side profile polygon given in (z,y);
 * half-width at each profile vertex may differ (for tapered stealth shapes). Mirrored about x=0.
 * widths: half-width per profile vertex.
 */
export function profileSolid(profile: V2[], widths: number[] | number) {
  const n = profile.length;
  const w = Array.isArray(widths) ? widths : new Array(n).fill(widths);
  const pos: number[] = [];
  const idx: number[] = [];
  let cz = 0, cy = 0;
  for (const [z, y] of profile) { cz += z; cy += y; }
  cz /= n; cy /= n;
  const pushTri = (a: V3, b: V3, c: V3, outward: V3) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2], nz = ab[0] * ac[1] - ab[1] * ac[0];
    const flip = nx * outward[0] + ny * outward[1] + nz * outward[2] < 0;
    const base = pos.length / 3;
    pos.push(...a, ...(flip ? c : b), ...(flip ? b : c));
    idx.push(base, base + 1, base + 2);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [z0, y0] = profile[i], [z1, y1] = profile[j];
    const out: V3 = [0, (y0 + y1) / 2 - cy, (z0 + z1) / 2 - cz];
    const a: V3 = [w[i], y0, z0], b: V3 = [w[j], y1, z1], c: V3 = [-w[j], y1, z1], d: V3 = [-w[i], y0, z0];
    pushTri(a, b, c, out);
    pushTri(a, c, d, out);
  }
  const tris = THREE.ShapeUtils.triangulateShape(profile.map(([z, y]) => new THREE.Vector2(z, y)), []);
  for (const [a, b, c] of tris) {
    pushTri([w[a], profile[a][1], profile[a][0]], [w[b], profile[b][1], profile[b][0]], [w[c], profile[c][1], profile[c][0]], [1, 0, 0]);
    pushTri([-w[a], profile[a][1], profile[a][0]], [-w[b], profile[b][1], profile[b][0]], [-w[c], profile[c][1], profile[c][0]], [-1, 0, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Extrude a 2D shape (in x,y) along +Z by depth, centered on z. Flat caps, indexed. */
export function extrudeXY(pts: V2[], depth: number, bevel = 0) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, steps: 1 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/**
 * Loft through rings of points (each ring same length). Smooth normals.
 * closedRing: connect last point of each ring to first.
 */
export function loftRings(rings: THREE.Vector3[][], closedRing = true, capStart = false, capEnd = false) {
  const nr = rings.length, np = rings[0].length;
  const pos = new Float32Array(nr * np * 3);
  const uv = new Float32Array(nr * np * 2);
  for (let i = 0; i < nr; i++)
    for (let j = 0; j < np; j++) {
      const p = rings[i][j];
      const k = i * np + j;
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = j / (np - 1); uv[k * 2 + 1] = i / (nr - 1);
    }
  const idx: number[] = [];
  const segs = closedRing ? np : np - 1;
  for (let i = 0; i < nr - 1; i++)
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % np;
      const a = i * np + j, b = i * np + j1, c = (i + 1) * np + j1, d = (i + 1) * np + j;
      idx.push(a, b, c, a, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const parts = [g];
  const capRing = (ring: THREE.Vector3[], flip: boolean) => {
    const c = ring.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    const cp: number[] = [c.x, c.y, c.z];
    for (const p of ring) cp.push(p.x, p.y, p.z);
    const ci: number[] = [];
    for (let j = 0; j < ring.length; j++) {
      const j1 = (j + 1) % ring.length;
      if (flip) ci.push(0, j1 + 1, j + 1);
      else ci.push(0, j + 1, j1 + 1);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.setIndex(ci);
    cg.computeVertexNormals();
    normalizeGeo(cg);
    parts.push(cg);
  };
  if (capStart) capRing(rings[0], false);
  if (capEnd) capRing(rings[nr - 1], true);
  if (parts.length === 1) return g;
  normalizeGeo(g);
  return mergeGeometries(parts, false)!;
}

/** Lathe around +Z axis from profile [r, z] pairs. */
export function latheZ(profile: V2[], seg = 24) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg);
  g.rotateX(Math.PI / 2); // lathe axis Y -> Z
  return g;
}

/** Monotone cubic interpolation (Fritsch–Carlson) over sorted knots. */
export class Curve1D {
  xs: number[];
  ys: number[];
  ms: number[];
  constructor(pts: V2[]) {
    const p = [...pts].sort((a, b) => a[0] - b[0]);
    this.xs = p.map((q) => q[0]);
    this.ys = p.map((q) => q[1]);
    const n = p.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]));
    const m: number[] = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    this.ms = m;
  }
  at(x: number) {
    const xs = this.xs;
    const n = xs.length;
    if (x <= xs[0]) return this.ys[0] + this.ms[0] * (x - xs[0]) * 0; // clamp
    if (x >= xs[n - 1]) return this.ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * this.ys[lo] + (t3 - 2 * t2 + t) * h * this.ms[lo] + (-2 * t3 + 3 * t2) * this.ys[hi] + (t3 - t2) * h * this.ms[hi];
  }
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const DEG = Math.PI / 180;

/** Seeded RNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create an InstancedMesh from a list of matrices. */
export function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string) {
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.name = name;
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}
