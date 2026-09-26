import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { PartBuilder, M, V3, box, cyl, rod, DEG } from '../ship/geom';
import { telMaterials } from './materials';
import { CAMO_TILE, CAN_LEN, DECAL_UV } from './textures';

/**
 * Heavy 8x8 coastal anti-ship missile TEL (fictional, MZKT-7930 / Bal-E style).
 *
 * Conventions: meters, +Y up, +Z forward (cab end), origin on the ground at the centre of the
 * footprint. Named nodes:
 *  - tel_rack         pivot group, origin on the erector hinge axis (along X) at the rear of the bed.
 *                     rack.rotation.x = -angle raises the muzzles (+Z end) upward.
 *  - tel_muzzle_0/1   Object3D children of tel_rack at the centre of each canister's front face,
 *                     local +Z pointing out of the muzzle.
 *  - tel_wheel_0..7   wheel groups (axis along X, spin with rotation.x). Index = 2 * axle + side,
 *                     axle 0 = front, side 0 = +X, side 1 = -X.
 *  - tel_ram_barrel / tel_ram_rod  erector rams that track the rack angle automatically.
 */

// ------------------------------------------------------------------ layout constants
const WR = 0.7; // tyre radius
const WX = 1.2; // wheel centre |x|
const AXLES = [3.4, 1.7, -2.4, -4.1];
const HINGE = new THREE.Vector3(0, 1.85, -5.95);
const CAN_X = 0.48;
const CAN_Y = 0.95; // rack-local canister axis height
const CAN_Z0 = 0.2; // rack-local rear end of canister body
const CAN_R = 0.42;
const MUZZLE_Z = CAN_Z0 + CAN_LEN + 0.05;
const RAM_X = 0.28;
const RAM_P = new THREE.Vector3(0, 1.1, -4.5); // chassis trunnion (TEL space)
const RAM_Q = new THREE.Vector3(0, 0.2, 4.0); // rack lug (rack space)
const RAM_BARREL = 2.4;
const RAM_ROD = 2.4;

const UVS = 1 / CAMO_TILE;

type PB = PartBuilder;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ geometry helpers

function convex(pts: V3[]) {
  return new ConvexGeometry(pts.map((p) => v3(p[0], p[1], p[2])));
}

/** Hexahedron from 8 corners (0-3 one quad, 4-7 the opposite quad, same order). Flat shaded. */
function hexa(c: V3[]) {
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const cen = [0, 0, 0];
  for (const p of c) { cen[0] += p[0] / 8; cen[1] += p[1] / 8; cen[2] += p[2] / 8; }
  const pos: number[] = [];
  for (const f of faces) {
    const fc = [0, 0, 0];
    for (const i of f) { fc[0] += c[i][0] / 4; fc[1] += c[i][1] / 4; fc[2] += c[i][2] / 4; }
    const out = [fc[0] - cen[0], fc[1] - cen[1], fc[2] - cen[2]];
    for (const [a, b, d] of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
      const A = c[a], B = c[b], D = c[d];
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], ad = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      const n = [ab[1] * ad[2] - ab[2] * ad[1], ab[2] * ad[0] - ab[0] * ad[2], ab[0] * ad[1] - ab[1] * ad[0]];
      const flip = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
      pos.push(...A, ...(flip ? D : B), ...(flip ? B : D));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Lathe around +X from [r, x] pairs. Duplicate a point to get a hard edge. */
function latheX(profile: [number, number][], seg: number) {
  // Winding follows the profile direction: the normal is the travel direction (dr, dx) rotated to (dx, -dr).
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), seg);
  g.rotateZ(-Math.PI / 2); // lathe axis +Y -> +X
  g.computeVertexNormals();
  return g;
}

/** Make normals point away from the axis (flip winding if needed). */
function fixOutward(g: THREE.BufferGeometry, radial: (p: THREE.Vector3) => THREE.Vector3) {
  g.computeVertexNormals();
  const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute;
  let s = 0;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    tmp.set(p.getX(i), p.getY(i), p.getZ(i));
    const r = radial(tmp);
    s += r.x * n.getX(i) + r.y * n.getY(i) + r.z * n.getZ(i);
  }
  if (s < 0) flipWinding(g);
  return g;
}

function flipWinding(g: THREE.BufferGeometry) {
  if (g.index) {
    const a = g.index.array as Uint16Array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    g.index.needsUpdate = true;
  } else {
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) { const t = p.getComponent(i + 1, k); p.setComponent(i + 1, k, p.getComponent(i + 2, k)); p.setComponent(i + 2, k, t); }
    }
    p.needsUpdate = true;
  }
  g.computeVertexNormals();
}

/** Mirror a geometry across x = 0 (keeps front faces outward). */
function mirrorX(src: THREE.BufferGeometry) {
  const g = src.clone();
  g.scale(-1, 1, 1);
  if (g.index) {
    const a = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    g.index.needsUpdate = true;
  }
  // (BufferGeometry.scale already transforms the normals)
  return g;
}

/** Lathe around +Z with metric-ish cylindrical UVs (u around from -Y, v = (z - z0) / L). Profile [r, z]. */
function tubeZ(profile: [number, number][], seg: number, z0: number, L: number, u0 = 0, u1 = 1) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, z] = profile[i];
    for (let j = 0; j <= seg; j++) {
      const a = -Math.PI / 2 + (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
      uv.push(u0 + (j / seg) * (u1 - u0), (z - z0) / L);
    }
  }
  for (let i = 0; i < profile.length - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return fixOutward(g, (p) => new THREE.Vector3(p.x, p.y, 0));
}

function decalQuad(w: number, h: number, r: readonly [number, number, number, number]) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
  return g;
}

// shorthand adders
function B(pb: PB, mat: string, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  pb.add(mat, box(w, h, d), M(x, y, z, rx, ry, rz), { uvScale: UVS });
}
/** Box from min/max corners. */
function BB(pb: PB, mat: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  pb.add(mat, box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), M((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), { uvScale: UVS });
}
function R(pb: PB, mat: string, a: V3, b: V3, r: number, seg = 8, closed = false) {
  const [g, m] = rod(a, b, r, seg);
  if (closed) {
    const len = new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b));
    pb.add(mat, cyl(r, r, len, seg), m, { uvScale: UVS });
  } else pb.add(mat, g, m, { uvScale: UVS });
}
/** Cylinder along X centred at (x,y,z). */
function CX(pb: PB, mat: string, r: number, len: number, x: number, y: number, z: number, seg = 16) {
  pb.add(mat, cyl(r, r, len, seg), M(x, y, z, 0, 0, Math.PI / 2), { uvScale: UVS });
}
/** Cylinder along Y. */
function CY(pb: PB, mat: string, r: number, len: number, x: number, y: number, z: number, seg = 16, r2 = r) {
  pb.add(mat, cyl(r, r2, len, seg), M(x, y, z), { uvScale: UVS });
}
/** Cylinder along Z. */
function CZ(pb: PB, mat: string, r: number, len: number, x: number, y: number, z: number, seg = 16) {
  pb.add(mat, cyl(r, r, len, seg), M(x, y, z, Math.PI / 2, 0, 0), { uvScale: UVS });
}
const both = (f: (s: number) => void) => { f(1); f(-1); };

// ------------------------------------------------------------------ wheel

interface WheelGeo { tire: THREE.BufferGeometry; hub: THREE.BufferGeometry }
let _wheel: { right: WheelGeo; left: WheelGeo } | null = null;

/** Wheel geometry, axle along X, outer (hub) face toward +X for the right set. */
function wheelGeo() {
  if (_wheel) return _wheel;
  const tb = new PartBuilder();
  // carcass
  const carcass: [number, number][] = [
    [0.335, -0.2], [0.37, -0.232], [0.48, -0.25], [0.58, -0.246], [0.635, -0.224], [0.66, -0.17],
    [0.668, -0.06], [0.668, 0.06], [0.66, 0.17], [0.635, 0.224], [0.58, 0.246], [0.48, 0.25], [0.37, 0.232], [0.335, 0.2],
  ];
  const cg = latheX(carcass, 36);
  tb.addOwned('rubber', cg, undefined, { uvScale: 1.5 });
  // tread lugs: directional chevron pattern, two staggered rows + shoulder blocks
  const N = 18;
  const lugs: THREE.BufferGeometry[] = [];
  const P = (x: number, r: number, a: number): V3 => [x, Math.cos(a) * r, Math.sin(a) * r];
  const r0 = 0.655, r1 = 0.705;
  for (let i = 0; i < N; i++) {
    for (const side of [1, -1]) {
      const a0 = ((i + (side > 0 ? 0 : 0.5)) / N) * Math.PI * 2;
      const hw = 0.055 / r1; // half circumferential width (angle)
      const sk = 0.2 / r1; // skew angle across the half-width -> chevron
      const xa = side * 0.025, xb = side * 0.232;
      // main bar
      lugs.push(hexa([
        P(xa, r0, a0 - hw), P(xa, r0, a0 + hw), P(xb, r0, a0 + hw + sk), P(xb, r0, a0 - hw + sk),
        P(xa, r1, a0 - hw), P(xa, r1, a0 + hw), P(xb, r1, a0 + hw + sk), P(xb, r1, a0 - hw + sk),
      ]));
      // shoulder block wrapping onto the sidewall
      const xs0 = side * 0.232, xs1 = side * 0.262;
      const as = a0 + sk;
      lugs.push(hexa([
        P(xs0, r0 - 0.01, as - hw), P(xs0, r0 - 0.01, as + hw), P(xs1, 0.6, as + hw * 0.9), P(xs1, 0.6, as - hw * 0.9),
        P(xs0, r1, as - hw), P(xs0, r1, as + hw), P(xs1 + side * 0.012, 0.64, as + hw * 0.9), P(xs1 + side * 0.012, 0.64, as - hw * 0.9),
      ]));
    }
  }
  for (const l of lugs) tb.addOwned('rubber', l, undefined, { uvScale: 1.5 });

  // hub / rim (outer face +X)
  const hb = new PartBuilder();
  const rim: [number, number][] = [
    [0.36, 0.2], [0.365, 0.215], [0.345, 0.225], [0.335, 0.21], [0.33, 0.19], [0.31, 0.125], [0.26, 0.105], [0.2, 0.1], [0.2, 0.1], [0.19, 0.16],
  ];
  hb.addOwned('wheel', latheX(rim, 24), undefined, { uvScale: 2 });
  // inner rim face (back side)
  hb.addOwned('wheel', latheX([[0.2, -0.12], [0.3, -0.12], [0.33, -0.19], [0.36, -0.2], [0.365, -0.215], [0.345, -0.225]], 16), undefined, { uvScale: 2 });
  // hub-reduction housing + cap
  hb.addOwned('wheel', latheX([[0.19, 0.16], [0.19, 0.2], [0.185, 0.215], [0.15, 0.22], [0.15, 0.22], [0.14, 0.26], [0.1, 0.285], [0.0, 0.29]], 16), undefined, { uvScale: 2 });
  // wheel nuts (10) on the rim disc and hub bolts (8)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    hb.add('wheel', cyl(0.019, 0.019, 0.05, 5, true), M(0.125, Math.cos(a) * 0.235, Math.sin(a) * 0.235, 0, 0, Math.PI / 2), { uvScale: 2 });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    hb.add('wheel', cyl(0.011, 0.011, 0.03, 4, true), M(0.225, Math.cos(a) * 0.165, Math.sin(a) * 0.165, 0, 0, Math.PI / 2), { uvScale: 2 });
  }
  // stiffening ribs on the dished disc
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    hb.add('wheel', box(0.02, 0.1, 0.03), M(0.118, Math.cos(a) * 0.29, Math.sin(a) * 0.29, a, 0, 0), { uvScale: 2 });
  }
  // CTIS (central tyre inflation) valve + hose from hub to rim
  const [hg, hm] = rod([0.27, 0.02, 0], [0.19, 0.3, 0.02], 0.012, 5);
  hb.add('wheel', hg, hm, { uvScale: 2 });
  hb.add('wheel', cyl(0.025, 0.025, 0.05, 6), M(0.28, 0, 0, 0, 0, Math.PI / 2), { uvScale: 2 });

  const merge = (pb: PartBuilder) => {
    const g = new THREE.Group();
    pb.build(g, { rubber: new THREE.MeshBasicMaterial(), wheel: new THREE.MeshBasicMaterial() }, 'w');
    return (g.children[0] as THREE.Mesh).geometry;
  };
  const tire = merge(tb), hub = merge(hb);
  _wheel = { right: { tire, hub }, left: { tire: mirrorX(tire), hub: mirrorX(hub) } };
  return _wheel;
}

function makeWheel(mats: Record<string, THREE.Material>, side: number, name: string) {
  const w = wheelGeo()[side > 0 ? 'right' : 'left'];
  const g = new THREE.Group();
  g.name = name;
  const t = new THREE.Mesh(w.tire, mats.rubber);
  const h = new THREE.Mesh(w.hub, mats.wheel);
  t.name = name + '_tire';
  h.name = name + '_hub';
  for (const m of [t, h]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  return g;
}

// ------------------------------------------------------------------ cab

function buildCab(pb: PB) {
  // main shell (convex hull of chamfered section points)
  const pts: V3[] = [];
  const P = (x: number, y: number, z: number) => { pts.push([x, y, z], [-x, y, z]); };
  P(1.47, 1.0, 4.25); P(1.47, 2.0, 4.25); P(1.42, 2.95, 4.25); P(1.34, 3.02, 4.33);
  P(1.37, 1.0, 6.38); P(1.47, 1.0, 6.28); P(1.37, 1.95, 6.4); P(1.47, 1.95, 6.3);
  P(1.28, 2.84, 6.13); P(1.42, 2.84, 6.02);
  P(1.24, 3.02, 5.99); P(1.4, 2.97, 5.97);
  pb.add('camo', convex(pts), undefined, { uvScale: UVS });

  // belt-line rub strip and lower front panel lip for some depth
  both((s) => BB(pb, 'camo', s * 1.47, 1.93, 4.25, s * 1.49, 1.99, 6.26));
  BB(pb, 'camo', -1.36, 1.93, 6.38, 1.36, 1.99, 6.43);
  BB(pb, 'camo', -1.4, 1.0, 6.36, 1.4, 1.06, 6.44);

  // windscreen: two panes on the sloped face
  const wsA = new THREE.Vector2(6.4, 1.95), wsB = new THREE.Vector2(6.13, 2.84); // (z,y)
  const wsAng = Math.atan2(wsA.x - wsB.x, wsB.y - wsA.y); // lean back
  const wsN = new THREE.Vector3(0, Math.sin(wsAng), Math.cos(wsAng));
  const wsC = new THREE.Vector3(0, (wsA.y + wsB.y) / 2, (wsA.x + wsB.x) / 2);
  const wsLen = wsA.distanceTo(wsB);
  for (const s of [1, -1]) {
    const c = wsC.clone().addScaledVector(wsN, 0.012);
    const cs = wsC.clone().addScaledVector(wsN, 0.004);
    pb.add('black', box(1.24, wsLen - 0.06, 0.012), M(s * 0.645, cs.y, cs.z, -wsAng, 0, 0));
    pb.add('glass', box(1.17, wsLen - 0.13, 0.012), M(s * 0.645, c.y, c.z, -wsAng, 0, 0));
    // wiper arm + blade
    const base = wsC.clone().addScaledVector(wsN, 0.03).add(new THREE.Vector3(s * 0.85, 0, 0));
    const down = new THREE.Vector3(0, -Math.cos(wsAng), Math.sin(wsAng));
    const p0 = base.clone().addScaledVector(down, wsLen / 2 - 0.08);
    const p1 = p0.clone().add(new THREE.Vector3(-s * 0.25, 0, 0)).addScaledVector(down, -0.55);
    R(pb, 'black', p0.toArray() as V3, p1.toArray() as V3, 0.01, 5);
  }
  // centre pillar
  pb.add('camo', box(0.1, wsLen, 0.03), M(0, wsC.y + wsN.y * 0.01, wsC.z + wsN.z * 0.01, -wsAng, 0, 0), { uvScale: UVS });
  // sun visor
  pb.add('camo', box(2.6, 0.03, 0.34), M(0, 2.99, 6.14, 8 * DEG, 0, 0), { uvScale: UVS });
  for (const x of [-1.1, -0.4, 0.4, 1.1]) B(pb, 'camo', 0.03, 0.06, 0.28, x, 3.02, 6.05);

  // front: grille with slats, cab lower panel details
  BB(pb, 'black', -0.95, 1.12, 6.37, 0.95, 1.82, 6.415);
  for (let i = 0; i < 7; i++) pb.add('camo', box(1.9, 0.045, 0.06), M(0, 1.17 + i * 0.1, 6.42, -20 * DEG, 0, 0), { uvScale: UVS });
  BB(pb, 'camo', -1.0, 1.08, 6.39, 1.0, 1.12, 6.44);
  BB(pb, 'camo', -1.0, 1.82, 6.39, 1.0, 1.86, 6.44);
  // tactical number above grille on front face (below screen)

  // front bumper (heavy, camo) + headlight clusters with guards
  const bmp: V3[] = [];
  for (const s of [1, -1]) bmp.push([s * 1.45, 0.55, 6.22], [s * 1.45, 0.98, 6.22], [s * 1.42, 0.98, 6.56], [s * 1.42, 0.62, 6.58], [s * 1.36, 0.55, 6.52]);
  pb.add('camo', convex(bmp), undefined, { uvScale: UVS });
  pb.add('decal', decalQuad(0.5, 0.12, DECAL_UV.plate), M(0, 0.73, 6.585), { uv: 'keep' });
  both((s) => {
    const hx = s * 1.02;
    BB(pb, 'black', hx - 0.26, 0.64, 6.55, hx + 0.26, 0.9, 6.6);
    for (const dx of [-0.12, 0.08]) pb.add('lamp', cyl(0.07, 0.075, 0.03, 16), M(hx + s * dx, 0.77, 6.605, Math.PI / 2, 0, 0));
    BB(pb, 'lampAmber', hx + s * 0.18 - 0.04, 0.72, 6.6, hx + s * 0.18 + 0.04, 0.82, 6.612);
    // guard: frame + vertical bars
    for (const dx of [-0.26, -0.13, 0, 0.13, 0.26]) R(pb, 'steel', [hx + dx, 0.62, 6.66], [hx + dx, 0.92, 6.66], 0.008, 4);
    R(pb, 'steel', [hx - 0.27, 0.92, 6.66], [hx + 0.27, 0.92, 6.66], 0.01, 4);
    R(pb, 'steel', [hx - 0.27, 0.62, 6.66], [hx + 0.27, 0.62, 6.66], 0.01, 4);
    R(pb, 'steel', [hx - 0.27, 0.92, 6.66], [hx - 0.27, 0.92, 6.58], 0.01, 4);
    R(pb, 'steel', [hx + 0.27, 0.92, 6.66], [hx + 0.27, 0.92, 6.58], 0.01, 4);
    // tow hook
    BB(pb, 'chassis', s * 0.5 - 0.06, 0.56, 6.56, s * 0.5 + 0.06, 0.68, 6.66);
    const hook = new THREE.TorusGeometry(0.06, 0.018, 6, 12, Math.PI * 1.3);
    pb.add('chassis', hook, M(s * 0.5, 0.62, 6.7, 0, Math.PI / 2, -0.6), { uvScale: UVS });
    // marker lamps on the roof front corners
    BB(pb, 'lampAmber', s * 1.25 - 0.05, 3.02, 5.93, s * 1.25 + 0.05, 3.08, 5.99);
    // headlamp on the cab corner (upper, blackout)
    pb.add('black', cyl(0.06, 0.06, 0.08, 10), M(s * 1.36, 1.92, 6.34, Math.PI / 2, 0, 0));
    pb.add('lamp', cyl(0.05, 0.05, 0.01, 10), M(s * 1.36, 1.92, 6.385, Math.PI / 2, 0, 0));
  });
  // winch housing / skid under the cab
  BB(pb, 'chassis', -0.72, 0.5, 5.4, 0.72, 0.98, 6.24);

  // sides: doors, windows, handles, steps, mirrors
  both((s) => {
    const fx = (y: number) => (y <= 2.0 ? 1.47 : 1.47 - ((y - 2.0) / 0.95) * 0.05); // side face x at height y
    const tilt = Math.atan(0.05 / 0.95);
    // door gaps (dark seams)
    const zA = 4.58, zB = 5.88, yA = 1.06, yB = 2.9;
    R(pb, 'black', [s * (fx(yA) + 0.002), yA, zA], [s * (fx(2.0) + 0.002), 2.0, zA], 0.009, 4);
    R(pb, 'black', [s * (fx(2.0) + 0.002), 2.0, zA], [s * (fx(yB) + 0.002), yB, zA], 0.009, 4);
    R(pb, 'black', [s * (fx(yA) + 0.002), yA, zB], [s * (fx(2.0) + 0.002), 2.0, zB], 0.009, 4);
    R(pb, 'black', [s * (fx(2.0) + 0.002), 2.0, zB], [s * (fx(yB) + 0.002), yB, zB], 0.009, 4);
    R(pb, 'black', [s * (fx(yB) + 0.002), yB, zA], [s * (fx(yB) + 0.002), yB, zB], 0.009, 4);
    // window: seal + glass
    const wy = 2.42, wx = fx(wy);
    pb.add('black', box(0.03, 0.82, 1.12), M(s * (wx + 0.004), wy, 5.2, 0, 0, s * tilt));
    pb.add('glass', box(0.03, 0.74, 1.04), M(s * (wx + 0.01), wy, 5.2, 0, 0, s * tilt));
    // small rear quarter window
    pb.add('black', box(0.03, 0.62, 0.22), M(s * (wx + 0.004), wy + 0.04, 4.42, 0, 0, s * tilt));
    pb.add('glass', box(0.03, 0.56, 0.16), M(s * (wx + 0.01), wy + 0.04, 4.42, 0, 0, s * tilt));
    // door handle + hinges
    BB(pb, 'darkSteel', s * 1.47, 1.8, 4.7, s * 1.5, 1.84, 4.9);
    for (const hy of [1.35, 2.6]) R(pb, 'darkSteel', [s * (fx(hy) + 0.02), hy - 0.08, 5.9], [s * (fx(hy) + 0.02), hy + 0.08, 5.9], 0.022, 6, true);
    // door number
    const dn = decalQuad(0.56, 0.28, DECAL_UV.number);
    pb.add('decal', dn, M(s * 1.476, 1.5, 5.23, 0, (s * Math.PI) / 2, 0), { uv: 'keep' });
    // grab handle next to the door
    R(pb, 'steel', [s * 1.52, 1.3, 4.44], [s * 1.52, 2.45, 4.44], 0.016, 6);
    R(pb, 'steel', [s * 1.47, 1.3, 4.44], [s * 1.52, 1.3, 4.44], 0.014, 5);
    R(pb, 'steel', [s * 1.47, 2.45, 4.44], [s * 1.52, 2.45, 4.44], 0.014, 5);
    // steps under the door
    for (const sy of [0.42, 0.74]) BB(pb, 'chassis', s * 1.05, sy - 0.02, 4.7, s * 1.44, sy + 0.02, 5.6);
    for (const sz of [4.68, 5.62]) BB(pb, 'chassis', s * 1.05, 0.38, sz - 0.015, s * 1.44, 1.0, sz + 0.015);
    // mirrors: tubular arms from the A-pillar, main + wide-angle mirror
    const m0: V3 = [s * 1.45, 2.55, 6.15], m1: V3 = [s * 1.78, 2.62, 6.22];
    R(pb, 'darkSteel', m0, m1, 0.016, 6);
    R(pb, 'darkSteel', [s * 1.46, 1.95, 6.25], [s * 1.78, 2.2, 6.22], 0.016, 6);
    R(pb, 'darkSteel', [s * 1.78, 2.1, 6.22], [s * 1.78, 2.78, 6.22], 0.015, 6);
    BB(pb, 'black', s * 1.74, 2.3, 6.13, s * 1.83, 2.75, 6.2);
    BB(pb, 'black', s * 1.74, 2.1, 6.13, s * 1.83, 2.28, 6.2);
    // side marker lamp
    BB(pb, 'lampAmber', s * 1.47, 1.2, 6.1, s * 1.49, 1.26, 6.2);
  });

  // roof: hatch, rack with rolled camo net, antennas, beacon
  CY(pb, 'camo', 0.36, 0.08, 0.45, 3.06, 5.1, 20);
  CY(pb, 'darkSteel', 0.3, 0.04, 0.45, 3.12, 5.1, 20);
  BB(pb, 'darkSteel', 0.1, 3.08, 5.05, 0.18, 3.16, 5.15);
  for (const x of [-1.2, -0.25]) R(pb, 'darkSteel', [x, 3.18, 4.45], [x, 3.18, 5.85], 0.022, 6);
  for (const z of [4.45, 5.15, 5.85]) {
    R(pb, 'darkSteel', [-1.2, 3.18, z], [-0.25, 3.18, z], 0.02, 6);
    for (const x of [-1.2, -0.25]) R(pb, 'darkSteel', [x, 3.02, z], [x, 3.18, z], 0.018, 5);
  }
  pb.add('net', cyl(0.17, 0.17, 1.3, 12), M(-0.72, 3.36, 5.0, Math.PI / 2, 0, 0), { uvScale: 1 / 2 });
  for (const z of [4.6, 5.4]) {
    const strap = new THREE.TorusGeometry(0.18, 0.012, 4, 16);
    pb.add('black', strap, M(-0.72, 3.36, z), { uvScale: UVS });
  }
  // antennas
  both((s) => {
    CY(pb, 'black', 0.05, 0.12, s * 1.28, 3.08, 4.4, 10);
    const tipTilt = -6 * DEG;
    const L = s > 0 ? 1.8 : 1.1;
    const [ag, am] = rod([s * 1.28, 3.12, 4.4], [s * 1.28, 3.12 + L * Math.cos(tipTilt), 4.4 + L * Math.sin(tipTilt)], 0.008, 4, 0.004);
    pb.add('black', ag, am);
  });
  // flashing beacon + GPS/sat dome
  CY(pb, 'darkSteel', 0.07, 0.03, 0.9, 3.04, 4.55, 10);
  CY(pb, 'lampAmber', 0.06, 0.1, 0.9, 3.1, 4.55, 10);
  pb.add('darkSteel', new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(-1.0, 3.02, 5.75), { uvScale: UVS });

  // rear wall: snorkel intake (right) and exhaust stack (left)
  CY(pb, 'camo', 0.11, 1.2, 1.18, 2.8, 4.12, 14);
  pb.add('darkSteel', new THREE.CylinderGeometry(0.19, 0.14, 0.14, 14), M(1.18, 3.45, 4.12), { uvScale: UVS });
  pb.add('darkSteel', new THREE.CylinderGeometry(0.03, 0.19, 0.08, 14), M(1.18, 3.56, 4.12), { uvScale: UVS });
  R(pb, 'darkSteel', [1.18, 2.4, 4.03], [1.18, 2.4, 4.22], 0.03, 6); // bracket
  R(pb, 'darkSteel', [1.18, 3.1, 4.03], [1.18, 3.1, 4.22], 0.03, 6);
  // exhaust: pipe + perforated heat shield + angled outlet
  CY(pb, 'exhaust', 0.085, 1.25, -1.2, 2.82, 4.08, 12);
  CY(pb, 'darkSteel', 0.13, 0.7, -1.2, 2.72, 4.08, 14);
  for (const y of [2.4, 3.05]) CY(pb, 'chassis', 0.14, 0.04, -1.2, y, 4.08, 14);
  R(pb, 'exhaust', [-1.2, 3.44, 4.08], [-1.2, 3.58, 3.9], 0.085, 12, true);
}

// ------------------------------------------------------------------ engine compartment, decks, fenders

function buildBody(pb: PB) {
  // engine hood behind the cab (full width, above the front tandem)
  const hood: V3[] = [];
  for (const z of [2.45, 4.25]) for (const s of [1, -1]) hood.push([s * 1.45, 1.46, z], [s * 1.45, 2.1, z], [s * 1.34, 2.2, z]);
  pb.add('camo', convex(hood), undefined, { uvScale: UVS });
  // top louvre panels
  for (const zc of [2.95, 3.75]) {
    BB(pb, 'black', -0.95, 2.19, zc - 0.34, 0.95, 2.215, zc + 0.34);
    for (let i = 0; i < 8; i++) pb.add('camo', box(1.9, 0.02, 0.07), M(0, 2.225, zc - 0.3 + i * 0.086, 25 * DEG, 0, 0), { uvScale: UVS });
    BB(pb, 'camo', -0.98, 2.2, zc - 0.37, 0.98, 2.235, zc - 0.34);
    BB(pb, 'camo', -0.98, 2.2, zc + 0.34, 0.98, 2.235, zc + 0.37);
  }
  // side louvres + latches
  both((s) => {
    BB(pb, 'black', s * 1.44, 1.62, 2.85, s * 1.46, 2.02, 3.85);
    for (let i = 0; i < 5; i++) pb.add('camo', box(0.03, 0.05, 0.98), M(s * 1.465, 1.66 + i * 0.08, 3.35, 0, 0, s * 30 * DEG), { uvScale: UVS });
    for (const z of [2.6, 4.1]) BB(pb, 'darkSteel', s * 1.45, 1.9, z - 0.04, s * 1.475, 1.98, z + 0.04);
    // lifting / tie-down eyes
    const eye = new THREE.TorusGeometry(0.04, 0.012, 5, 10);
    pb.add('darkSteel', eye, M(s * 1.3, 2.24, 2.55, 0, Math.PI / 2, 0), { uvScale: UVS });
  });
  // engine / gearbox block visible between the front wheels
  BB(pb, 'darkSteel', -0.42, 0.85, 2.55, 0.42, 1.46, 4.2);
  BB(pb, 'darkSteel', -0.3, 0.72, 4.2, 0.3, 1.1, 4.9);
  // radiator/transfer case
  BB(pb, 'darkSteel', -0.35, 0.62, 0.1, 0.35, 0.95, 0.7);

  // side decks from the hood back to the tail, with deep edge skirts
  both((s) => {
    BB(pb, 'chassis', s * 0.6, 1.46, -6.22, s * 1.5, 1.52, 2.45);
    BB(pb, 'camo', s * 1.46, 1.3, -6.22, s * 1.52, 1.52, 2.45);
    // skirt drops lower between wheel groups (tool lockers)
    BB(pb, 'camo', s * 1.44, 0.82, -1.55, s * 1.52, 1.3, 0.95);
    BB(pb, 'camo', s * 1.44, 0.82, -6.22, s * 1.52, 1.3, -4.95);
    // inner wheel-well aprons
    for (const [z0, z1] of [[-4.95, -1.55], [0.95, 2.45]] as [number, number][]) BB(pb, 'chassis', s * 0.9, 1.05, z0, s * 0.92, 1.46, z1);
    // hood-side fender over the front tandem
    BB(pb, 'camo', s * 1.44, 1.3, 2.45, s * 1.52, 1.52, 4.1);
    // mudflaps
    for (const z of [0.93, -4.93, 2.68]) BB(pb, 'black', s * 0.95, 0.35, z - 0.01, s * 1.45, 1.46, z + 0.01);
    // tie-down rings along the skirt
    for (const z of [-5.6, -3.2, -0.4, 1.8]) {
      const ring = new THREE.TorusGeometry(0.035, 0.01, 4, 8);
      pb.add('darkSteel', ring, M(s * 1.53, 1.42, z, 0, Math.PI / 2, 0), { uvScale: UVS });
    }
    // anti-slip deck plates
    for (let z = -6.0; z < 2.3; z += 0.9) BB(pb, 'deck', s * 0.66, 1.52, z, s * 1.4, 1.527, z + 0.8);
  });
  // warning decal on skirts near jacks
  both((s) => {
    pb.add('decal', decalQuad(0.3, 0.14, DECAL_UV.jack), M(s * 1.524, 1.38, -1.35, 0, (s * Math.PI) / 2, 0), { uv: 'keep' });
    pb.add('decal', decalQuad(0.3, 0.14, DECAL_UV.jack), M(s * 1.524, 1.38, -5.7, 0, (s * Math.PI) / 2, 0), { uv: 'keep' });
    pb.add('decal', decalQuad(0.7, 0.35, DECAL_UV.text), M(s * 1.524, 1.06, -0.1, 0, (s * Math.PI) / 2, 0), { uv: 'keep' });
  });

  // deck stowage: lockers, hose reels, extinguisher, pioneer tools
  both((s) => {
    const lk: V3[] = [];
    for (const [x, y] of [[0.95, 1.52], [1.45, 1.52], [1.45, 1.98], [0.99, 2.02], [0.95, 1.98]] as [number, number][]) lk.push([s * x, y, 1.05], [s * x, y, 2.35]);
    pb.add('camo', convex(lk), undefined, { uvScale: UVS });
    for (const z of [1.2, 2.2]) BB(pb, 'darkSteel', s * 1.45, 1.8, z - 0.03, s * 1.47, 1.9, z + 0.03);
    R(pb, 'darkSteel', [s * 1.46, 1.99, 1.1], [s * 1.46, 1.99, 2.3], 0.012, 5);
    // hose reel
    CX(pb, 'darkSteel', 0.2, 0.12, s * 1.25, 1.75, -0.3, 16);
    CX(pb, 'black', 0.14, 0.14, s * 1.25, 1.75, -0.3, 12);
    BB(pb, 'chassis', s * 1.12, 1.52, -0.36, s * 1.15, 1.75, -0.24);
    BB(pb, 'chassis', s * 1.35, 1.52, -0.36, s * 1.38, 1.75, -0.24);
    // lockers at the rear corners of the deck
    BB(pb, 'camo', s * 0.98, 1.52, -5.25, s * 1.46, 1.85, -4.35);
    BB(pb, 'darkSteel', s * 1.46, 1.66, -4.85, s * 1.475, 1.74, -4.75);
  });
  CY(pb, 'red', 0.09, 0.5, 1.3, 1.78, 0.55, 12);
  CY(pb, 'black', 0.03, 0.08, 1.3, 2.07, 0.55, 8);
  // shovel + crowbar on the left deck edge
  BB(pb, 'wood', -1.44, 1.56, -3.8, -1.4, 1.6, -2.7);
  BB(pb, 'darkSteel', -1.46, 1.54, -2.72, -1.38, 1.62, -2.45);
  R(pb, 'darkSteel', [-1.3, 1.56, -3.9], [-1.3, 1.56, -2.4], 0.015, 6);
  // hydraulic power unit + oil tank between the rails under the rack
  BB(pb, 'camo', -0.42, 1.1, -1.25, 0.42, 1.88, 0.2);
  CZ(pb, 'camo', 0.26, 1.3, 0, 1.52, 0.95, 16);
  for (const z of [-0.8, -0.2]) BB(pb, 'darkSteel', -0.43, 1.3, z - 0.15, -0.42, 1.7, z + 0.15);
  pb.add('decal', decalQuad(0.36, 0.18, DECAL_UV.text), M(-0.425, 1.45, -0.5, 0, -Math.PI / 2, 0), { uv: 'keep' });
  for (const x of [-0.3, 0.3]) R(pb, 'black', [x, 1.5, -1.25], [x * 0.9, 1.15, -1.7], 0.02, 5);

  // ladder (left) between the front tandem wheels
  for (const z of [2.44, 2.66]) R(pb, 'steel', [-1.55, 0.3, z], [-1.55, 1.52, z], 0.018, 6);
  for (let y = 0.4; y < 1.5; y += 0.27) R(pb, 'steel', [-1.55, y, 2.44], [-1.55, y, 2.66], 0.014, 5);
  R(pb, 'steel', [-1.55, 1.52, 2.44], [-1.46, 1.52, 2.44], 0.016, 5);
  R(pb, 'steel', [-1.55, 1.52, 2.66], [-1.46, 1.52, 2.66], 0.016, 5);
  // handrail up to the hood
  R(pb, 'steel', [-1.52, 1.55, 2.5], [-1.52, 2.1, 2.5], 0.016, 5);

  // mid section, right: fuel tank + battery locker
  const tank: V3[] = [];
  for (const z of [-0.35, 0.85]) {
    for (const [y, x0, x1] of [[0.72, 0.8, 1.38], [0.66 + 0.06, 0.8, 1.38], [1.36, 0.8, 1.38]] as [number, number, number][]) {
      tank.push([x0, y, z], [x1, y, z]);
    }
    tank.push([0.74, 0.78, z], [1.44, 0.78, z], [0.74, 1.3, z], [1.44, 1.3, z]);
  }
  pb.add('camo', convex(tank), undefined, { uvScale: UVS });
  for (const z of [-0.05, 0.55]) BB(pb, 'black', 0.73, 0.7, z - 0.03, 1.45, 1.38, z + 0.03);
  CX(pb, 'darkSteel', 0.06, 0.05, 1.46, 1.2, 0.25, 12);
  BB(pb, 'camo', 0.92, 0.8, -1.5, 1.46, 1.4, -0.55);
  for (const z of [-1.3, -0.75]) BB(pb, 'darkSteel', 1.46, 1.1, z - 0.04, 1.48, 1.22, z + 0.04);
  // mid section, left: toolbox (spare wheel is added separately)
  BB(pb, 'camo', -1.46, 0.85, 0.35, -0.92, 1.42, 0.9);
  BB(pb, 'darkSteel', -1.48, 1.2, 0.58, -1.46, 1.28, 0.68);
  // spare wheel carrier
  R(pb, 'chassis', [-0.59, 0.72, -0.45], [-0.95, 0.72, -0.45], 0.05, 8);
  BB(pb, 'chassis', -0.95, 0.5, -0.5, -0.9, 0.94, -0.4);

  // rear: bumper, lights, hitch
  BB(pb, 'chassis', -1.38, 0.72, -6.32, 1.38, 1.0, -6.16);
  pb.add('decal', decalQuad(2.6, 0.22, DECAL_UV.hazard), M(0, 0.86, -6.322, 0, Math.PI, 0), { uv: 'keep' });
  both((s) => {
    BB(pb, 'black', s * 0.95, 1.06, -6.25, s * 1.4, 1.26, -6.2);
    BB(pb, 'lampRed', s * 1.28 - 0.06, 1.1, -6.262, s * 1.28 + 0.06, 1.22, -6.25);
    BB(pb, 'lampAmber', s * 1.12 - 0.05, 1.1, -6.262, s * 1.12 + 0.05, 1.22, -6.25);
    BB(pb, 'lamp', s * 1.0 - 0.03, 1.1, -6.262, s * 1.0 + 0.03, 1.22, -6.25);
  });
  pb.add('decal', decalQuad(0.5, 0.12, DECAL_UV.plate), M(0, 1.14, -6.23, 0, Math.PI, 0), { uv: 'keep' });
  BB(pb, 'black', -0.3, 1.05, -6.23, 0.3, 1.25, -6.21);
  CZ(pb, 'darkSteel', 0.07, 0.2, 0, 0.62, -6.35, 10);
  const pintle = new THREE.TorusGeometry(0.08, 0.025, 6, 12);
  pb.add('darkSteel', pintle, M(0, 0.62, -6.5, Math.PI / 2, 0, 0), { uvScale: UVS });
}

// ------------------------------------------------------------------ frame + running gear + jacks

function buildChassis(pb: PB) {
  // ladder frame
  both((s) => BB(pb, 'chassis', s * 0.45, 0.8, -6.18, s * 0.59, 1.12, 6.2));
  for (const z of [5.8, 4.6, 2.55, 0.9, -0.3, -1.6, -3.25, -5.3, -6.1]) BB(pb, 'chassis', -0.45, 0.9, z - 0.07, 0.45, 1.08, z + 0.07);
  // outrigger brackets on frame (walkway supports)
  both((s) => {
    for (const z of [-5.9, -5.0, -1.6, -0.3, 0.9, 2.3]) {
      pb.add('chassis', hexa([
        [s * 0.59, 1.0, z - 0.05], [s * 0.59, 1.0, z + 0.05], [s * 0.59, 1.46, z + 0.05], [s * 0.59, 1.46, z - 0.05],
        [s * 0.9, 1.4, z - 0.05], [s * 0.9, 1.4, z + 0.05], [s * 0.9, 1.46, z + 0.05], [s * 0.9, 1.46, z - 0.05],
      ]), undefined, { uvScale: UVS });
    }
  });

  // axles, differentials, suspension
  AXLES.forEach((z, i) => {
    R(pb, 'chassis', [-0.98, WR, z], [0.98, WR, z], 0.085, 10, true);
    CZ(pb, 'darkSteel', 0.21, 0.42, 0, WR, z, 16);
    pb.add('darkSteel', new THREE.SphereGeometry(0.21, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2), M(0, WR, z - 0.21, -Math.PI / 2, 0, 0), { uvScale: UVS });
    both((s) => {
      CX(pb, 'chassis', 0.17, 0.12, s * 0.9, WR, z, 14);
      if (i < 2) {
        // independent front suspension: wishbones + coil-over dampers + steering arm
        R(pb, 'chassis', [s * 0.5, 0.95, z - 0.3], [s * 0.85, 0.88, z], 0.04, 6, true);
        R(pb, 'chassis', [s * 0.5, 0.95, z + 0.3], [s * 0.85, 0.88, z], 0.04, 6, true);
        R(pb, 'darkSteel', [s * 0.72, 0.85, z + 0.12], [s * 0.6, 1.4, z + 0.18], 0.07, 10, true);
        R(pb, 'chrome', [s * 0.72, 0.85, z + 0.12], [s * 0.66, 1.1, z + 0.15], 0.03, 8, true);
        R(pb, 'chassis', [s * 0.86, 0.6, z - 0.2], [0, 0.6, z - 0.2], 0.025, 6, true);
      } else {
        // damper per axle
        R(pb, 'darkSteel', [s * 0.72, 0.8, z + 0.15], [s * 0.64, 1.3, z + 0.3], 0.06, 10, true);
        R(pb, 'chrome', [s * 0.72, 0.8, z + 0.15], [s * 0.69, 1.0, z + 0.2], 0.028, 8, true);
      }
    });
  });
  // rear tandem balancer: stacked leaf springs + trunnion
  both((s) => {
    for (let k = 0; k < 5; k++) {
      const L = 1.9 - k * 0.3;
      BB(pb, 'darkSteel', s * 0.65, 0.84 + k * 0.035, -3.25 - L / 2, s * 0.79, 0.87 + k * 0.035, -3.25 + L / 2);
    }
    CX(pb, 'chassis', 0.13, 0.22, s * 0.68, 1.02, -3.25, 14);
    // reaction rods
    for (const z of [-2.4, -4.1]) R(pb, 'chassis', [s * 0.3, 0.95, -3.25], [s * 0.25, 0.85, z], 0.035, 6, true);
  });
  // propshafts
  const shafts: [number, number][] = [[4.5, 3.4], [3.4, 1.7], [1.7, 0.7], [0.1, -2.4], [-2.4, -4.1]];
  for (const [a, b] of shafts) R(pb, 'darkSteel', [0, WR + 0.02, a], [0, WR + 0.02, b], 0.05, 8, true);

  // cable conduits along the left rail and hydraulic lines along the right rail
  for (let k = 0; k < 3; k++) R(pb, 'black', [-0.62, 0.96 + k * 0.05, 4.2], [-0.62, 0.96 + k * 0.05, -5.85], 0.02, 6);
  for (let k = 0; k < 2; k++) R(pb, 'steel', [0.62, 0.98 + k * 0.06, 4.2], [0.62, 0.98 + k * 0.06, -5.85], 0.014, 5);
  // hydraulic pump / valve block with hose runs
  BB(pb, 'darkSteel', 0.15, 0.85, -1.2, 0.44, 1.1, -0.5);
  for (const x of [0.2, 0.3, 0.4]) R(pb, 'black', [x, 1.1, -0.85], [x, 1.08, -4.3], 0.015, 5);

  // erector ram chassis trunnion + cross member
  BB(pb, 'chassis', -0.45, 0.92, RAM_P.z - 0.12, 0.45, 1.1, RAM_P.z + 0.12);
  both((s) => {
    for (const dx of [-0.16, 0.16]) BB(pb, 'chassis', s * RAM_X + dx - 0.02, 0.95, RAM_P.z - 0.12, s * RAM_X + dx + 0.02, 1.25, RAM_P.z + 0.12);
    CX(pb, 'darkSteel', 0.05, 0.38, s * RAM_X, RAM_P.y, RAM_P.z, 10);
  });

  // rest posts for the rack (travel position) behind the hood
  BB(pb, 'chassis', -0.45, 0.95, 1.83, 0.45, 1.12, 2.07);
  both((s) => {
    BB(pb, 'chassis', s * 0.3 - 0.09, 1.12, 1.87, s * 0.3 + 0.09, 2.02, 2.03);
    BB(pb, 'black', s * 0.3 - 0.12, 2.02, 1.84, s * 0.3 + 0.12, 2.1, 2.06);
  });

  // erector hinge brackets (on the rails) + bearings
  both((s) => {
    pb.add('chassis', hexa([
      [s * 0.44, 1.12, -6.18], [s * 0.44, 1.12, -5.35], [s * 0.44, 2.02, -5.78], [s * 0.44, 2.02, -6.12],
      [s * 0.6, 1.12, -6.18], [s * 0.6, 1.12, -5.35], [s * 0.6, 2.02, -5.78], [s * 0.6, 2.02, -6.12],
    ]), undefined, { uvScale: UVS });
    CX(pb, 'darkSteel', 0.17, 0.2, s * 0.52, HINGE.y, HINGE.z, 18);
    CX(pb, 'chrome', 0.07, 0.24, s * 0.52, HINGE.y, HINGE.z, 10);
  });

  // stabiliser jacks: two mid (on swing-out arms) and two at the rear corners
  const jack = (x: number, z: number, top: number) => {
    CY(pb, 'chassis', 0.12, top - 0.45, x, (top + 0.45) / 2, z, 14);
    CY(pb, 'chassis', 0.15, 0.08, x, top, z, 14);
    CY(pb, 'chassis', 0.14, 0.06, x, 0.48, z, 14);
    CY(pb, 'chrome', 0.075, 0.4, x, 0.26, z, 12);
    pb.add('darkSteel', new THREE.SphereGeometry(0.09, 10, 6), M(x, 0.11, z), { uvScale: UVS });
    CY(pb, 'steel', 0.3, 0.05, x, 0.025, z, 20, 0.33);
    for (let k = 0; k < 4; k++) pb.add('steel', box(0.5, 0.04, 0.03), M(x, 0.06, z, 0, (k * Math.PI) / 4, 0), { uvScale: UVS });
    R(pb, 'black', [x + Math.sign(x) * -0.1, top - 0.05, z + 0.08], [Math.sign(x) * 0.62, 1.05, z + 0.08], 0.018, 5);
  };
  both((s) => {
    // mid: box arm from frame to jack
    BB(pb, 'chassis', s * 0.59, 1.22, -1.43, s * 1.66, 1.42, -1.27);
    jack(s * 1.66, -1.35, 1.48);
    // rear corners
    BB(pb, 'chassis', s * 0.59, 1.2, -5.8, s * 1.32, 1.42, -5.6);
    jack(s * 1.34, -5.7, 1.62);
  });
}

// ------------------------------------------------------------------ rack (erector + canisters)

function buildRack(pb: PB) {
  // hinge tube + lugs
  CX(pb, 'chassisRack', 0.1, 1.24, 0, 0, 0, 16);
  both((s) => {
    pb.add('chassisRack', hexa([
      [s * 0.22, -0.13, -0.14], [s * 0.22, -0.13, 0.14], [s * 0.22, 0.55, 1.1], [s * 0.22, 0.55, -0.1],
      [s * 0.38, -0.13, -0.14], [s * 0.38, -0.13, 0.14], [s * 0.38, 0.55, 1.1], [s * 0.38, 0.55, -0.1],
    ]), undefined, { uvScale: UVS });
    // main longitudinal box beams
    BB(pb, 'camoRack', s * 0.2, 0.25, -0.1, s * 0.4, 0.55, 8.2);
    // ram lug below the beam
    BB(pb, 'chassisRack', s * RAM_X - 0.1, RAM_Q.y - 0.08, RAM_Q.z - 0.18, s * RAM_X - 0.07, 0.25, RAM_Q.z + 0.18);
    BB(pb, 'chassisRack', s * RAM_X + 0.07, RAM_Q.y - 0.08, RAM_Q.z - 0.18, s * RAM_X + 0.1, 0.25, RAM_Q.z + 0.18);
    CX(pb, 'chrome', 0.035, 0.24, s * RAM_X, RAM_Q.y, RAM_Q.z, 8);
    // rest pads under the beam front
    BB(pb, 'chassisRack', s * 0.3 - 0.12, 0.2, 7.78, s * 0.3 + 0.12, 0.25, 8.02);
  });
  // cross members
  for (const z of [0.6, 2.0, 4.0, 6.0, 8.0]) BB(pb, 'camoRack', -0.2, 0.3, z - 0.08, 0.2, 0.5, z + 0.08);

  // saddles (cradle) with cups for both canisters, and top clamp straps
  const cupR = CAN_R + 0.025;
  const saddleShape: [number, number][] = [[-1.0, 0.42], [1.0, 0.42], [1.0, CAN_Y - 0.05]];
  for (let k = 0; k <= 12; k++) { const a = (k / 12) * Math.PI; saddleShape.push([CAN_X + Math.cos(a) * cupR, CAN_Y - 0.05 - Math.sin(a) * cupR * 0.95]); }
  for (let k = 0; k <= 12; k++) { const a = (k / 12) * Math.PI; saddleShape.push([-CAN_X + Math.cos(a) * cupR, CAN_Y - 0.05 - Math.sin(a) * cupR * 0.95]); }
  saddleShape.push([-1.0, CAN_Y - 0.05]);
  // de-duplicate the shared middle point region (keep simple polygon)
  const shape = new THREE.Shape(saddleShape.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const z of [0.8, 3.1, 5.4, 7.6]) {
    const sg = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false, curveSegments: 1 });
    pb.add('camoRack', sg, M(0, 0, z - 0.1), { uvScale: UVS });
    both((s) => {
      const strap = new THREE.TorusGeometry(CAN_R + 0.03, 0.022, 5, 20, Math.PI);
      pb.add('chassisRack', strap, M(s * CAN_X, CAN_Y, z), { uvScale: UVS });
      pb.add('chassisRack', box(0.1, 0.08, 0.12), M(s * CAN_X + (CAN_R + 0.06), CAN_Y - 0.02, z), { uvScale: UVS });
      pb.add('chassisRack', box(0.1, 0.08, 0.12), M(s * CAN_X - (CAN_R + 0.06), CAN_Y - 0.02, z), { uvScale: UVS });
      pb.add('darkSteel', cyl(0.015, 0.015, 0.16, 6), M(s * CAN_X + (CAN_R + 0.06), CAN_Y + 0.02, z), { uvScale: UVS });
    });
  }
  // rear bulkhead frame between canisters' rear ends and hinge lugs
  BB(pb, 'camoRack', -1.0, 0.42, 0.02, 1.0, 0.6, 0.22);

  // canisters
  const L = CAN_LEN;
  const prof: [number, number][] = [];
  const push = (r: number, z: number) => prof.push([r, z]);
  push(0.3, 0); push(0.3, 0); push(0.455, 0); push(0.455, 0); push(0.455, 0.14); push(0.455, 0.14); push(CAN_R, 0.14); push(CAN_R, 0.14);
  const rings = [1.35, 2.55, 3.75, 4.95, 6.15, 7.3];
  for (const zr of rings) {
    push(CAN_R, zr - 0.06); push(CAN_R + 0.022, zr - 0.045); push(CAN_R + 0.022, zr + 0.045); push(CAN_R, zr + 0.06);
  }
  push(CAN_R, L - 0.16); push(CAN_R, L - 0.16); push(0.455, L - 0.16); push(0.455, L - 0.16); push(0.455, L); push(0.455, L); push(0.36, L); push(0.36, L);
  const tubes = [tubeZ(prof, 32, 0, L, 0, 0.5), tubeZ(prof, 32, 0, L, 0.5, 1)];
  // end covers: front frangible dome + rear flat cover with boss
  const front = tubeZ([[0.37, L - 0.01], [0.36, L + 0.02], [0.3, L + 0.045], [0.18, L + 0.06], [0.001, L + 0.065]], 32, 0, L);
  const rear = tubeZ([[0.001, -0.07], [0.12, -0.07], [0.12, -0.07], [0.13, -0.02], [0.3, -0.015], [0.3, -0.015], [0.31, 0.01]], 32, 0, L);
  both((s) => {
    const m = M(s * CAN_X, CAN_Y, CAN_Z0);
    pb.add('canister', tubes[s > 0 ? 0 : 1], m, { uv: 'keep' });
    pb.add('cover', front, m, { uvScale: 1 / 2 });
    pb.add('cover', rear, m, { uvScale: 1 / 2 });
    // scored lines on the frangible cover
    for (let k = 0; k < 4; k++) pb.add('black', box(0.66, 0.012, 0.01), M(s * CAN_X, CAN_Y, CAN_Z0 + L + 0.05, 0, 0, (k * Math.PI) / 4));
    // cover bolts
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pb.add('darkSteel', cyl(0.014, 0.014, 0.03, 4, true), M(s * CAN_X + Math.cos(a) * 0.41, CAN_Y + Math.sin(a) * 0.41, CAN_Z0 + L + 0.01, Math.PI / 2, 0, 0));
      pb.add('darkSteel', cyl(0.014, 0.014, 0.03, 4, true), M(s * CAN_X + Math.cos(a) * 0.41, CAN_Y + Math.sin(a) * 0.41, CAN_Z0 - 0.01, Math.PI / 2, 0, 0));
    }
    // cable conduit along the outer upper flank
    const ca = 40 * DEG;
    const cx = s * (CAN_X + Math.sin(ca) * (CAN_R + 0.03)), cy = CAN_Y + Math.cos(ca) * (CAN_R + 0.03);
    pb.add('chassisRack', box(0.07, 0.05, 7.9), M(cx, cy, CAN_Z0 + 4.2, 0, 0, -s * ca), { uvScale: UVS });
    // umbilical connector box at the rear
    BB(pb, 'chassisRack', s * (CAN_X + 0.3), CAN_Y + 0.1, CAN_Z0 + 0.25, s * (CAN_X + 0.45), CAN_Y + 0.35, CAN_Z0 + 0.6);
    // lifting lugs on top
    for (const z of [1.9, 6.7]) {
      BB(pb, 'chassisRack', s * CAN_X - 0.1, CAN_Y + CAN_R - 0.02, CAN_Z0 + z - 0.08, s * CAN_X + 0.1, CAN_Y + CAN_R + 0.03, CAN_Z0 + z + 0.08);
      const eye = new THREE.TorusGeometry(0.045, 0.014, 5, 10);
      pb.add('darkSteel', eye, M(s * CAN_X, CAN_Y + CAN_R + 0.08, CAN_Z0 + z, 0, Math.PI / 2, 0), { uvScale: UVS });
    }
  });
  // cable loop from chassis to the rack at the hinge
  for (let k = 0; k < 3; k++) {
    const loop = new THREE.TorusGeometry(0.22, 0.02, 5, 12, Math.PI);
    pb.add('black', loop, M(-0.5 - k * 0.05, 0.15, 0.3, 0, Math.PI / 2, Math.PI / 2), { uvScale: UVS });
  }
}

// ------------------------------------------------------------------ erector rams (track the rack angle)

let _ramGeo: { barrel: THREE.BufferGeometry; rod: THREE.BufferGeometry } | null = null;
function ramGeo() {
  if (_ramGeo) return _ramGeo;
  const bp = new PartBuilder();
  const rp = new PartBuilder();
  for (const s of [1, -1]) {
    const x = s * RAM_X;
    // barrel from the trunnion (origin) toward +Z
    bp.add('b', cyl(0.13, 0.13, RAM_BARREL, 16), M(x, 0, RAM_BARREL / 2 + 0.05, Math.PI / 2, 0, 0), { uvScale: UVS });
    bp.add('b', cyl(0.15, 0.15, 0.12, 16), M(x, 0, 0.1, Math.PI / 2, 0, 0), { uvScale: UVS });
    bp.add('b', cyl(0.15, 0.15, 0.1, 16), M(x, 0, RAM_BARREL, Math.PI / 2, 0, 0), { uvScale: UVS });
    bp.add('b', cyl(0.08, 0.08, 0.22, 12), M(x, 0, 0, 0, 0, Math.PI / 2), { uvScale: UVS });
    // hydraulic line along the barrel
    bp.add('b', cyl(0.018, 0.018, RAM_BARREL - 0.2, 6), M(x + s * 0.12, 0.08, RAM_BARREL / 2 + 0.05, Math.PI / 2, 0, 0), { uvScale: UVS });
    // chrome rod from the rack lug (origin) toward -Z
    rp.add('r', cyl(0.085, 0.085, RAM_ROD, 14), M(x, 0, -RAM_ROD / 2 - 0.05, Math.PI / 2, 0, 0), { uvScale: UVS });
    rp.add('r', cyl(0.06, 0.06, 0.14, 10), M(x, 0, 0, 0, 0, Math.PI / 2), { uvScale: UVS });
    rp.add('r', box(0.12, 0.14, 0.16), M(x, 0, -0.08), { uvScale: UVS });
  }
  const gb = new THREE.Group();
  bp.build(gb, { b: new THREE.MeshBasicMaterial() });
  rp.build(gb, { r: new THREE.MeshBasicMaterial() });
  _ramGeo = { barrel: (gb.children[0] as THREE.Mesh).geometry, rod: (gb.children[1] as THREE.Mesh).geometry };
  return _ramGeo;
}

const _q = new THREE.Vector3();
/** Rack lug position in TEL space for a given rack rotation.x. */
function ramQ(rx: number, out: THREE.Vector3) {
  const c = Math.cos(rx), s = Math.sin(rx);
  return out.set(0, HINGE.y + RAM_Q.y * c - RAM_Q.z * s, HINGE.z + RAM_Q.y * s + RAM_Q.z * c);
}

/**
 * Erector ram part that re-poses itself from the sibling `tel_rack` rotation whenever its matrix
 * updates. A subclass (not a patched instance) so it survives Object3D.clone() — the game clones
 * the registered model per launcher.
 */
class RamPart extends THREE.Mesh {
  isRod = false;
  private _rack: THREE.Object3D | null = null;
  copy(source: this, recursive?: boolean) {
    super.copy(source, recursive);
    this.isRod = source.isRod;
    return this;
  }
  updateMatrix() {
    let rack = this._rack;
    if (!rack || rack.parent !== this.parent) rack = this._rack = this.parent?.getObjectByName('tel_rack') ?? null;
    if (rack) {
      ramQ(rack.rotation.x, _q);
      const dy = _q.y - RAM_P.y, dz = _q.z - RAM_P.z;
      const th = Math.atan2(-dy, dz); // rotation.x that maps +Z onto P->Q
      this.position.copy(this.isRod ? _q : RAM_P);
      this.rotation.set(th, 0, 0);
    }
    super.updateMatrix();
  }
}

// ------------------------------------------------------------------ assembly

let _template: THREE.Group | null = null;

function buildTemplate(): THREE.Group {
  const mats = telMaterials();
  const root = new THREE.Group();
  root.name = 'tel';

  const pb = new PartBuilder();
  buildCab(pb);
  buildBody(pb);
  buildChassis(pb);
  // spare wheel (left side, mid) merged into the static mesh
  const wg = wheelGeo().left;
  const spareM = M(-1.2, WR + 0.02, -0.45);
  pb.add('rubber', wg.tire, spareM, { uv: 'keep' });
  pb.add('wheel', wg.hub, spareM, { uv: 'keep' });
  const body = new THREE.Group();
  body.name = 'tel_body';
  pb.build(body, mats, 'tel');
  root.add(body);

  // wheels
  AXLES.forEach((z, i) => {
    [1, -1].forEach((s, k) => {
      const w = makeWheel(mats, s, `tel_wheel_${i * 2 + k}`);
      w.position.set(s * WX, WR, z);
      root.add(w);
    });
  });

  // rack
  const rack = new THREE.Group();
  rack.name = 'tel_rack';
  rack.position.copy(HINGE);
  const rb = new PartBuilder();
  buildRack(rb);
  rb.build(rack, mats, 'tel_rack');
  [1, -1].forEach((s, i) => {
    const mz = new THREE.Object3D();
    mz.name = `tel_muzzle_${i}`;
    mz.position.set(s * CAN_X, CAN_Y, MUZZLE_Z);
    rack.add(mz);
  });
  root.add(rack);

  // rams
  const rg = ramGeo();
  const barrel = new RamPart(rg.barrel, mats.ramPaint);
  barrel.name = 'tel_ram_barrel';
  const rodMesh = new RamPart(rg.rod, mats.chrome);
  rodMesh.isRod = true;
  rodMesh.name = 'tel_ram_rod';
  for (const m of [barrel, rodMesh]) { m.castShadow = true; m.receiveShadow = true; root.add(m); }
  return root;
}

/** Build a TEL instance (geometry/materials shared between instances). */
export function createTEL(): THREE.Group {
  if (!_template) _template = buildTemplate();
  const g = _template.clone(true);
  g.updateMatrixWorld(true);
  return g;
}
