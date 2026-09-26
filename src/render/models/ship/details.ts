import * as THREE from 'three';
import { PartBuilder, M, V2, V3, box, cyl, cylZ, rod, loftRings, instanced, DEG, rng, normalizeGeo, prismBetween } from './geom';
import { Z_BOW, Z_STERN, deckY, hbDeck, deckAt, hullXAbove, hullX, hullSlopeAbove, LAYOUT as L } from './hulldef';

type Mats = Record<string, THREE.Material>;

/** Collects stanchion matrices + lifeline polylines, emitted as one InstancedMesh and one merged wire mesh. */
export class Railings {
  posts: THREE.Matrix4[] = [];
  lines: THREE.Vector3[][] = [];
  /** Railing along a polyline of [x, y, z] points (y = base height). */
  add(path: V3[], spacing = 1.8, heights = [0.38, 0.72, 1.06], postH = 1.08) {
    // resample the path at ~spacing
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = new THREE.Vector3(...path[i]), b = new THREE.Vector3(...path[i + 1]);
      const n = Math.max(1, Math.round(a.distanceTo(b) / spacing));
      for (let k = 0; k < n; k++) pts.push(a.clone().lerp(b, k / n));
    }
    pts.push(new THREE.Vector3(...path[path.length - 1]));
    for (const p of pts) this.posts.push(M(p.x, p.y, p.z, 0, 0, 0, 1, postH, 1));
    for (const h of heights) this.lines.push(pts.map((p) => p.clone().add(new THREE.Vector3(0, h, 0))));
  }
  build(root: THREE.Object3D, pb: PartBuilder, mats: Mats) {
    const post = new THREE.CylinderGeometry(0.024, 0.028, 1, 6, 1, true);
    post.translate(0, 0.5, 0);
    root.add(instanced(post, mats.paintFine, this.posts, 'stanchions'));
    for (const line of this.lines) {
      if (line.length < 2) continue;
      // piecewise straight wire: loft a thin square tube through the points (sagless)
      const rings: THREE.Vector3[][] = [];
      const r = 0.011;
      for (let i = 0; i < line.length; i++) {
        const p = line[i];
        const q = line[Math.min(i + 1, line.length - 1)], o = line[Math.max(i - 1, 0)];
        const t = q.clone().sub(o).normalize();
        const side = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 1, 0)).normalize();
        if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
        const up = new THREE.Vector3().crossVectors(side, t).normalize();
        rings.push([
          p.clone().addScaledVector(up, r), p.clone().addScaledVector(side, r), p.clone().addScaledVector(up, -r), p.clone().addScaledVector(side, -r),
        ]);
      }
      pb.addOwned('wire', loftRings(rings, true));
    }
  }
}

/** Deck-edge railings, bitts, chocks, anchors, windlass, jackstaff. */
export function buildDeckFittings(pb: PartBuilder, rails: Railings) {
  // main deck edge railings (from end of bow bulwark to hangar face)
  for (const sx of [1, -1]) {
    const path: V3[] = [];
    for (let z = 72.0; z >= L.hangarAftZ + 0.2; z -= 1.0) {
      const x = sx * (hbDeck(z) - 0.1);
      path.push([x, deckY(z) - 0.02, z]);
    }
    rails.add(path, 1.75);
  }
  // bitts (double bollards) and chocks along the deck edge
  const bittZ = [55.5, 43.0, 22.0, -6.0, -24.5, -42.0, -52.5];
  for (const sx of [1, -1]) {
    for (const z of bittZ) {
      const x = sx * (hbDeck(z) - 1.1), y = deckAt(x, z);
      pb.add('paintFine', box(0.7, 0.08, 1.5), M(x, y + 0.04, z));
      for (const dz of [-0.45, 0.45]) {
        pb.add('paintFine', cyl(0.17, 0.18, 0.5, 14), M(x, y + 0.29, z + dz));
        pb.add('paintFine', cyl(0.22, 0.22, 0.05, 14), M(x, y + 0.56, z + dz));
      }
      // closed chock at the deck edge
      const cx = sx * (hbDeck(z + 1.6) - 0.08);
      const torus = new THREE.TorusGeometry(0.22, 0.07, 6, 14);
      torus.scale(1, 0.7, 1);
      pb.addOwned('paintFine', torus, M(cx, deckY(z + 1.6) + 0.3, z + 1.6, 0, Math.PI / 2, 0));
    }
  }

  // ---- anchors in hawse pockets (port & starboard), windlass and chain
  for (const sx of [1, -1]) {
    const z = 63.6, y = 6.7;
    const x = hullXAbove(z, y);
    const slope = hullSlopeAbove(z, y);
    const tilt = Math.atan(slope); // hull side leaning outward
    const base = M(sx * (x + 0.05), y, z, 0, 0, -sx * tilt);
    // hawse pocket: dark recess disc + rim
    pb.add('black', new THREE.CircleGeometry(0.8, 20), base.clone().multiply(M(sx * 0.01, 0.1, 0, 0, sx * Math.PI / 2, 0, 1, 1.3, 1)));
    const rim = new THREE.TorusGeometry(0.82, 0.08, 6, 24);
    rim.scale(1, 1.3, 1);
    pb.addOwned('paint', rim, base.clone().multiply(M(sx * 0.02, 0.1, 0, 0, Math.PI / 2, 0)));
    // stockless anchor: shank, crown, flukes
    const am = base.clone().multiply(M(sx * 0.28, 0, 0));
    pb.add('darkSteel', box(0.22, 1.9, 0.26), am.clone().multiply(M(0, 0.2, 0)));
    pb.add('darkSteel', box(0.32, 0.3, 1.25), am.clone().multiply(M(0, -0.8, 0)));
    for (const dz of [-0.45, 0.45]) pb.add('darkSteel', box(0.24, 0.9, 0.42), am.clone().multiply(M(sx * 0.1, -0.45, dz, dz > 0 ? -0.35 : 0.35, 0, 0)));
    pb.add('darkSteel', new THREE.TorusGeometry(0.16, 0.05, 6, 12), am.clone().multiply(M(0, 1.22, 0, 0, Math.PI / 2, 0)));
    // chain pipe on deck + chain to windlass
    const hx = sx * (hbDeck(64.2) - 0.9), hz = 64.2;
    pb.add('darkSteel', cyl(0.35, 0.4, 0.3, 16), M(hx, deckAt(hx, hz) + 0.12, hz));
    const wx = sx * 1.15, wz = 59.2;
    const a = new THREE.Vector3(hx, deckAt(hx, hz) + 0.18, hz), b = new THREE.Vector3(wx, deckAt(wx, wz) + 0.15, wz);
    const n = Math.round(a.distanceTo(b) / 0.21);
    const dir = b.clone().sub(a).normalize();
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, k / n);
      const link = new THREE.TorusGeometry(0.1, 0.03, 5, 10);
      link.scale(1, 1.55, 1);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k % 2 ? 0 : Math.PI / 2));
      pb.addOwned('darkSteel', link, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
    }
    // windlass gypsy + brake drum
    pb.add('darkSteel', cyl(0.55, 0.55, 0.45, 20), M(wx, deckAt(wx, wz) + 0.75, wz, 0, 0, Math.PI / 2));
    pb.add('paintFine', cyl(0.45, 0.45, 0.35, 20), M(wx + sx * 0.5, deckAt(wx, wz) + 0.75, wz, 0, 0, Math.PI / 2));
    pb.add('paintFine', box(0.9, 0.55, 1.3), M(wx, deckAt(wx, wz) + 0.27, wz));
    // chain locker pipe
    pb.add('darkSteel', cyl(0.3, 0.3, 0.2, 14), M(wx, deckAt(wx, wz) + 0.1, wz - 1.4));
  }
  // foredeck scuttles/hatches and mushroom vents
  for (const [x, z] of [[2.6, 52.5], [-2.6, 52.5], [0, 55.8], [3.4, 43.0], [-3.4, 43.0]] as [number, number][]) {
    const y = deckAt(x, z);
    pb.add('paintFine', box(1.1, 0.12, 1.1), M(x, y + 0.06, z));
    pb.add('darkSteel', box(0.9, 0.04, 0.9), M(x, y + 0.13, z));
    pb.add('darkSteel', box(0.3, 0.05, 0.06), M(x + 0.3, y + 0.17, z));
  }
  for (const [x, z] of [[4.8, 50.0], [-4.8, 50.0], [6.4, 38.6], [-6.4, 38.6], [1.8, 62.8], [-1.8, 62.8]] as [number, number][]) {
    const y = deckAt(x, z);
    pb.add('paintFine', cyl(0.09, 0.09, 0.42, 12), M(x, y + 0.21, z));
    pb.add('paintFine', new THREE.SphereGeometry(0.2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(x, y + 0.42, z, 0, 0, 0, 1, 0.5, 1));
  }
  // windlass motor housing
  pb.add('paintFine', box(1.2, 0.9, 1.6), M(0, deckAt(0, 59.2) + 0.45, 59.2));
  // capstan / warping heads aft
  for (const sx of [1, -1]) {
    pb.add('paintFine', cyl(0.3, 0.38, 0.6, 18), M(sx * 5.2, deckAt(5.2, 30) + 0.3, 30));
  }
  // jackstaff at the stem & ensign staff at the stern
  pb.add('paintFine', cyl(0.04, 0.07, 4.2, 8), M(0, deckY(Z_BOW - 0.8) + 1.15 + 2.1, Z_BOW - 0.8));
  pb.add('paintFine', cyl(0.035, 0.06, 2.2, 8), M(0, deckY(Z_STERN) - 0.3, Z_STERN - 0.12, -1.2, 0, 0));
  // bow breakwater / fairlead on stem
  pb.add('paintFine', box(0.5, 0.35, 1.2), M(0, deckY(Z_BOW - 1.6) + 0.2, Z_BOW - 1.6));
  // stern: retractable capstans/towing padeye (flush plates) + flight deck edge lights
  for (let z = Z_STERN + 1.5; z < L.hangarAftZ - 0.5; z += 2.6)
    for (const sx of [1, -1]) {
      const x = sx * (hbDeck(z) - 0.25);
      pb.add('lamp', cyl(0.07, 0.08, 0.06, 8), M(x, deckY(z) + 0.05, z));
    }
}

/** Flight deck safety nets (angled outboard) along both sides and the stern. */
export function buildFlightDeckNets(pb: PartBuilder) {
  const z0 = Z_STERN + 0.2, z1 = L.hangarAftZ - 0.3;
  const W = 1.5, drop = 18 * DEG;
  const posArr: number[] = [];
  const uvArr: number[] = [];
  const idx: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ul: number, vl: number) => {
    const base = posArr.length / 3;
    for (const p of [a, b, c, d]) posArr.push(p.x, p.y, p.z);
    uvArr.push(0, 0, ul, 0, ul, vl, 0, vl);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const sx of [1, -1]) {
    const N = 16;
    for (let i = 0; i < N; i++) {
      const za = z0 + ((z1 - z0) * i) / N, zb = z0 + ((z1 - z0) * (i + 1)) / N;
      const ia = new THREE.Vector3(sx * hbDeck(za), deckY(za) - 0.1, za), ib = new THREE.Vector3(sx * hbDeck(zb), deckY(zb) - 0.1, zb);
      const oa = ia.clone().add(new THREE.Vector3(sx * W * Math.cos(drop), W * Math.sin(drop) * 0.3, 0));
      const ob = ib.clone().add(new THREE.Vector3(sx * W * Math.cos(drop), W * Math.sin(drop) * 0.3, 0));
      quad(ia, ib, ob, oa, (zb - za) / 0.15, W / 0.15);
      const [g, m] = rod(oa, ob, 0.03, 6);
      pb.addOwned('paintFine', g, m);
      if (i % 4 === 0) {
        const [g2, m2] = rod(ia, oa, 0.025, 6);
        pb.addOwned('paintFine', g2, m2);
      }
    }
  }
  // stern net
  {
    const hb = hbDeck(Z_STERN) - 0.3;
    const y = deckY(Z_STERN) - 0.1;
    const a = new THREE.Vector3(-hb, y, Z_STERN), b = new THREE.Vector3(hb, y, Z_STERN);
    const c = b.clone().add(new THREE.Vector3(0, 0.25, -1.3)), d = a.clone().add(new THREE.Vector3(0, 0.25, -1.3));
    quad(a, b, c, d, (2 * hb) / 0.15, 1.3 / 0.15);
    const [g, m] = rod(c, d, 0.03, 6);
    pb.addOwned('paintFine', g, m);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  pb.addOwned('net', g, undefined, { uv: 'keep' });
}

/** Life raft canister (white capsule) along +Z. */
function raft(pb: PartBuilder, m: THREE.Matrix4) {
  pb.add('white', cylZ(0.36, 0.36, 1.1, 16), m);
  for (const s of [1, -1]) pb.add('white', new THREE.SphereGeometry(0.36, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.clone().multiply(M(0, 0, s * 0.55, s * Math.PI / 2, 0, 0, 1, 0.55, 1)));
  for (const dz of [-0.35, 0.35]) pb.add('darkSteel', cylZ(0.375, 0.375, 0.05, 16), m.clone().multiply(M(0, 0, dz)));
}

export function buildLifeRafts(pb: PartBuilder) {
  const rack = (x: number, y: number, z: number, n: number, alongZ: boolean, two = true) => {
    for (let i = 0; i < n; i++) {
      for (let lv = 0; lv < (two ? 2 : 1); lv++) {
        const dz = (i - (n - 1) / 2) * 0.85;
        const m = alongZ ? M(x, y + 0.45 + lv * 0.75, z + dz * 0 + (i - (n - 1) / 2) * 1.9, 0, 0, 0) : M(x + dz, y + 0.45 + lv * 0.75, z, 0, Math.PI / 2, 0);
        raft(pb, m);
      }
    }
    // cradle frame
    pb.add('paintFine', box(alongZ ? 0.9 : n * 0.85 + 0.2, 0.1, alongZ ? n * 1.9 : 0.9), M(x, y + 0.05, z));
  };
  for (const sx of [1, -1]) {
    rack(sx * 6.2, L.lvl01, 11.4, 2, true);
    rack(sx * 6.5, L.lvl01, -11.6, 1, false);
    rack(sx * 8.2, L.hangarRoof, -40.5, 2, true, false);
    rack(sx * 8.2, L.hangarRoof, -48.5, 2, true, false);
  }
}

/** Rigid-hull inflatable boat (7 m) on a cradle. */
export function rhib(pb: PartBuilder, m: THREE.Matrix4) {
  const len = 7.2, w = 2.6;
  const rings: THREE.Vector3[][] = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = -len / 2 + len * t;
    const bw = (w / 2 - 0.3) * (t < 0.7 ? 1 : Math.sqrt(Math.max(0.02, 1 - Math.pow((t - 0.7) / 0.3, 2))));
    const dead = 0.45 + (t > 0.6 ? (t - 0.6) * 0.6 : 0);
    const ring: THREE.Vector3[] = [];
    const kb = 0.05 + (t > 0.75 ? (t - 0.75) * 1.4 : 0) + (t < 0.06 ? (0.06 - t) * 3 : 0);
    ring.push(new THREE.Vector3(-bw, 0.95, z), new THREE.Vector3(-bw * 0.98, 0.45 + dead * 0.2, z), new THREE.Vector3(-bw * 0.55, 0.22 + kb * 0.6, z), new THREE.Vector3(0, kb, z), new THREE.Vector3(bw * 0.55, 0.22 + kb * 0.6, z), new THREE.Vector3(bw * 0.98, 0.45 + dead * 0.2, z), new THREE.Vector3(bw, 0.95, z));
    rings.push(ring.map((p) => p.applyMatrix4(m)));
  }
  const hullG = loftRings(rings, false, false, false);
  pb.add('paintDark', hullG);
  // second copy with flipped winding so the open hull shell renders from both sides
  const ix = hullG.index!.array as unknown as number[];
  for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
  hullG.computeVertexNormals();
  pb.addOwned('paintDark', hullG);
  // inflatable collar (tube around gunwale)
  const pts: THREE.Vector3[] = [];
  const NN = 40;
  for (let i = 0; i < NN; i++) {
    const a = (i / NN) * Math.PI * 2;
    const sx = Math.cos(a), sz = Math.sin(a);
    const zz = sz > 0 ? sz * (len / 2) : sz * (len / 2 - 0.2);
    const xx = sx * (w / 2 - 0.25) * (sz > 0.6 ? Math.sqrt(Math.max(0.05, 1 - Math.pow((sz - 0.6) / 0.4, 2) * 0.9)) : 1);
    pts.push(new THREE.Vector3(xx, 1.05, zz));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const tube = new THREE.TubeGeometry(curve, 80, 0.23, 10, true);
  tube.applyMatrix4(m);
  pb.addOwned('rubber', tube);
  // console, engine, seats, A-frame
  pb.add('paintDark', box(w - 0.5, 0.06, len - 1.2), m.clone().multiply(M(0, 0.62, -0.2)));
  pb.add('paintFine', box(0.9, 0.9, 0.7), m.clone().multiply(M(0, 1.1, 0.4)));
  pb.add('glass', box(0.85, 0.35, 0.04), m.clone().multiply(M(0, 1.65, 0.72, -0.4)));
  pb.add('black', box(0.6, 0.9, 0.6), m.clone().multiply(M(0, 1.05, -3.3)));
  pb.add('paintFine', box(1.1, 0.5, 0.6), m.clone().multiply(M(0, 0.9, -0.8)));
  const [g, gm] = rod(new THREE.Vector3(-0.9, 1.0, -2.4), new THREE.Vector3(0, 2.6, -2.5), 0.04, 6);
  pb.addOwned('steel', g, m.clone().multiply(gm));
  const [g2, gm2] = rod(new THREE.Vector3(0.9, 1.0, -2.4), new THREE.Vector3(0, 2.6, -2.5), 0.04, 6);
  pb.addOwned('steel', g2, m.clone().multiply(gm2));
}

/** Boats between the funnels: RHIBs on cradles with slewing-arm davits. */
export function buildBoats(pb: PartBuilder) {
  for (const sx of [1, -1]) {
    const x = sx * 4.75, z = -5.9, y = L.lvl01;
    // cradle
    for (const dz of [-2, 1.6]) pb.add('paintFine', box(1.8, 0.45, 0.25), M(x, y + 0.22, z + dz));
    rhib(pb, M(x, y + 0.3, z));
    // davit post and jib
    const px = sx * 6.55, pz = z + 3.6;
    pb.add('paintFine', cyl(0.22, 0.28, 4.2, 14), M(px, y + 2.1, pz));
    pb.add('paintFine', box(0.3, 0.35, 5.2), M(px - sx * 0.4, y + 4.1, pz - 2.3, 0.08, sx * 0.25, 0));
    pb.add('darkSteel', cyl(0.02, 0.02, 1.6, 4), M(px - sx * 1.0, y + 3.2, z));
  }
}

/** Whip antennas and misc sensors. */
export function buildAntennas(pb: PartBuilder) {
  const whip = (x: number, y: number, z: number, h: number, lean = 0) => {
    pb.add('paintFine', cyl(0.07, 0.09, 0.5, 8), M(x, y + 0.25, z));
    pb.add('white', cyl(0.018, 0.045, h, 6), M(x + Math.sin(lean) * h * 0.5, y + 0.5 + (Math.cos(lean) * h) / 2, z, 0, 0, -lean));
  };
  for (const sx of [1, -1]) {
    whip(sx * (hbDeck(20.0) - 0.45), deckY(20.0), 20.0, 10.5, sx * 0.06);
    whip(sx * (hbDeck(12.5) - 0.45), deckY(12.5), 12.5, 8.0, sx * 0.12);
    whip(sx * 6.8, L.lvl01, 5.0, 7.5);
    whip(sx * 7.0, L.lvl01, -9.0, 8.5, sx * 0.08);
    whip(sx * 8.4, L.lvl01, -19.0, 9.0, sx * 0.08);
    whip(sx * 8.8, L.hangarRoof, -33.0, 6.0, sx * 0.1);
    whip(sx * 2.4, 20.3, 9.6, 6.0);
    // SATCOM radomes beside the forward funnel
    pb.add('paint', cyl(0.95, 1.05, 2.4, 20), M(sx * 5.5, L.lvl01 + 1.2, -0.8));
    pb.add('paintFine', cyl(1.1, 1.1, 0.2, 24), M(sx * 5.5, L.lvl01 + 2.5, -0.8));
    pb.add('radome', new THREE.SphereGeometry(1.3, 28, 18), M(sx * 5.5, L.lvl01 + 3.55, -0.8));
    // navigation lights on bridge wings
    pb.add(sx > 0 ? 'red' : 'lamp', box(0.14, 0.16, 0.2), M(sx * 9.62, L.lvl03 + 1.2, 26.9));
    pb.add('black', box(0.03, 0.3, 0.55), M(sx * 9.55, L.lvl03 + 1.2, 26.75));
  }
  // bow-mounted small antennas on forward 01 roof front
  for (const sx of [1, -1]) pb.add('paintFine', cyl(0.25, 0.3, 0.6, 12), M(sx * 3.2, L.lvl01 + 0.3, 33.4));
}

/** Hull number decals (port & starboard) and draft marks, conformed to the hull surface. */
export function buildHullDecals(pb: PartBuilder) {
  // ship's name on the transom
  pb.add('decalName', new THREE.PlaneGeometry(8.4, 1.05), M(0, 2.9, Z_STERN - 0.02, 0, Math.PI, 0), { uv: 'keep' });
  const patch = (zc: number, yc: number, w: number, h: number, side: number, mat: string, nz = 24, ny = 8, off = 0.03) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nz; i++) {
        const z = zc + w / 2 - (w * i) / nz; // i=0 at forward edge
        const y = yc - h / 2 + (h * j) / ny;
        const x = side * (hullX(z, y) + off);
        pos.push(x, y, z);
        const u = side > 0 ? i / nz : 1 - i / nz;
        uv.push(u, j / ny);
      }
    const cols = nz + 1;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nz; i++) {
        const a = j * cols + i, b = a + 1, c = a + cols + 1, d = a + cols;
        if (side > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, d, c, a, c, b);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    pb.addOwned(mat, g, undefined, { uv: 'keep' });
  };
  for (const s of [1, -1]) {
    patch(55.0, 6.9, 5.8, 2.9, s, 'decalNumber', 24, 20, 0.04);
    patch(64.4, -0.6, 0.75, 6.0, s, 'decalDraft', 2, 24, 0.02);
    patch(-73.5, 0.5, 0.75, 6.0, s, 'decalDraft', 2, 24, 0.02);
  }
}

export const _unusedD = [rng, normalizeGeo];
export type _V2 = V2;

/**
 * Forecastle breakwater: a chevron bulwark between the gun and the forward VLS, raked forward,
 * with triangular gussets on its aft face and freeing ports at the deck.
 */
export function buildBreakwater(pb: PartBuilder) {
  const apex: V2 = [0, 43.45], end: V2 = [6.3, 40.35];
  const H = 1.15, T = 0.08, rake = 0.3; // top leans forward by `rake`
  for (const sx of [1, -1]) {
    const a = new THREE.Vector3(0, 0, apex[1]), b = new THREE.Vector3(sx * end[0], 0, end[1]);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const p0 = a.clone().lerp(b, i / N), p1 = a.clone().lerp(b, (i + 1) / N);
      const y0 = deckAt(p0.x, p0.z) - 0.05, y1 = deckAt(p1.x, p1.z) - 0.05;
      // plate: quad strip with thickness, following the cambered deck
      const bot: V2[] = [[p0.x, p0.z], [p1.x, p1.z], [p1.x, p1.z - T], [p0.x, p0.z - T]];
      const top: V2[] = bot.map(([x, z]) => [x, z + rake] as V2);
      const g = prismBetween(bot, 0, top, H, true, false);
      const pp = g.attributes.position;
      for (let k = 0; k < pp.count; k++) {
        const t = (pp.getX(k) - p0.x) / (p1.x - p0.x || 1e-6);
        pp.setY(k, pp.getY(k) + y0 + (y1 - y0) * Math.min(1, Math.max(0, t)));
      }
      g.computeVertexNormals();
      pb.addOwned('paint', normalizeGeo(g));
    }
    // top rolled edge
    const [rg, rm] = rod(new THREE.Vector3(0, deckAt(0, apex[1]) + H - 0.05, apex[1] + rake - T / 2), new THREE.Vector3(sx * end[0], deckAt(end[0], end[1]) + H - 0.05, end[1] + rake - T / 2), 0.06, 8);
    pb.addOwned('paintFine', rg, rm);
    // gussets (aft side) and freeing ports (dark slots at the deck)
    const dir = b.clone().sub(a).normalize();
    const nrm = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(sx); // points aft-ish
    if (nrm.z > 0) nrm.negate();
    for (let d = 0.6; d < a.distanceTo(b) - 0.2; d += 1.05) {
      const p = a.clone().addScaledVector(dir, d);
      const y = deckAt(p.x, p.z);
      const gus = prismBetween([[-0.03, 0], [0.03, 0], [0.03, 0.55], [-0.03, 0.55]], 0, [[-0.03, 0], [0.03, 0], [0.03, 0.05], [-0.03, 0.05]], H * 0.8, true, false);
      pb.addOwned('paintFine', gus, M(p.x + nrm.x * T, y - 0.02, p.z + nrm.z * T, 0, Math.atan2(nrm.x, nrm.z), 0));
      if (Math.round(d / 1.05) % 2 === 0) pb.add('black', box(0.45, 0.16, 0.02), M(p.x + nrm.x * (T + 0.005), y + 0.1, p.z + nrm.z * (T + 0.005), 0, Math.atan2(-dir.z, dir.x), 0));
    }
  }
}
