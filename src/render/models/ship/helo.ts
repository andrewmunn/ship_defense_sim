import * as THREE from 'three';
import { PartBuilder, M, V2, box, cyl, cylZ, loftRings, Curve1D, profileSolid, rod, DEG } from './geom';

type Mats = Record<string, THREE.Material>;

/**
 * Petrel maritime helicopter, nose +Z, origin on the ground under the rotor mast.
 * Named children: helo_rotor (spins about +Y), helo_tail_rotor (spins about its local +X).
 */
export function createHelo(mats: Mats): THREE.Group {
  const g = new THREE.Group();
  g.name = 'helo';
  const pb = new PartBuilder();
  // fuselage loft (z from tail cone to nose); F(z, a) gives the surface point, a=0 at the top centerline
  const wC = new Curve1D([[-8.6, 0.22], [-6, 0.42], [-4.5, 0.6], [-3.1, 0.95], [-2.2, 1.12], [-1.2, 1.18], [4.6, 1.18], [5.3, 1.16], [6.0, 1.1], [6.5, 1.0], [7.0, 0.8], [7.3, 0.45]]);
  const topC = new Curve1D([[-8.6, 2.85], [-4.5, 2.8], [-2.2, 2.85], [2.5, 2.9], [4.2, 2.88], [4.9, 2.72], [5.5, 2.45], [6.0, 2.2], [6.5, 1.95], [7.0, 1.72], [7.3, 1.52]]);
  const botC = new Curve1D([[-8.6, 2.45], [-6, 2.2], [-4.5, 1.95], [-3.1, 1.3], [-2.2, 0.72], [-1.2, 0.62], [5.3, 0.62], [6.3, 0.68], [7.0, 0.82], [7.3, 0.98]]);
  const F = (z: number, a: number, off = 0) => {
    const w = wC.at(z) + off, yt = topC.at(z) + off, yb = botC.at(z) - off;
    const cy = (yt + yb) / 2, hh = (yt - yb) / 2;
    const sn = Math.sin(a), c = Math.cos(a);
    const p = 3.4;
    return new THREE.Vector3(w * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p), cy + hh * Math.sign(c) * Math.pow(Math.abs(c), 2 / p), z);
  };
  const rings: THREE.Vector3[][] = [];
  const NR = 32;
  for (let i = 0; i <= 40; i++) {
    const z = -8.6 + (7.3 + 8.6) * (1 - Math.pow(1 - i / 40, 1.3));
    const r: THREE.Vector3[] = [];
    for (let j = 0; j < NR; j++) r.push(F(z, (j / NR) * Math.PI * 2));
    rings.push(r);
  }
  pb.addOwned('helo', loftRings(rings, true, true, true), undefined, { uvScale: 1 / 4 });
  // conformal glazing patches
  const patch = (z0: number, z1: number, a0: number, a1: number, mat = 'glass') => {
    const pr: THREE.Vector3[][] = [];
    for (let i = 0; i <= 6; i++) {
      const z = z0 + ((z1 - z0) * i) / 6;
      const row: THREE.Vector3[] = [];
      for (let j = 0; j <= 6; j++) row.push(F(z, a0 + ((a1 - a0) * j) / 6, 0.02));
      pr.push(row);
    }
    const g = loftRings(pr, false);
    // ensure outward facing (normals away from fuselage axis)
    const n = g.attributes.normal, pp = g.attributes.position;
    let dot = 0;
    for (let k = 0; k < n.count; k++) dot += n.getX(k) * pp.getX(k) + n.getY(k) * (pp.getY(k) - 1.7);
    if (dot < 0) {
      const ix = g.index!.array as unknown as number[];
      for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
      g.computeVertexNormals();
    }
    pb.addOwned(mat, g, undefined, { uvScale: 1 / 4 });
  };
  patch(5.55, 6.75, -0.95, -0.08); // windscreen halves
  patch(5.55, 6.75, 0.08, 0.95);
  for (const sg of [1, -1]) {
    patch(4.35, 5.55, sg * 1.05, sg * 1.75); // cockpit door windows
    patch(1.3, 2.2, sg * 1.25, sg * 1.7); // cabin windows
    patch(-0.5, 0.3, sg * 1.25, sg * 1.7);
    // cabin sliding door outline
    pb.add('heloDark', box(0.03, 1.55, 0.04), M(sg * 1.19, 1.55, 3.0));
    pb.add('heloDark', box(0.03, 1.55, 0.04), M(sg * 1.19, 1.55, 0.6));
    pb.add('heloDark', box(0.03, 0.04, 2.4), M(sg * 1.19, 2.33, 1.8));
  }
  // upper deck: engine cowlings + transmission fairing
  pb.add('helo', box(1.5, 0.75, 4.6), M(0, 3.2, 0.9));
  for (const sx of [1, -1]) {
    pb.add('helo', cylZ(0.42, 0.48, 3.2, 16), M(sx * 0.82, 3.2, -0.3));
    pb.add('heloDark', cylZ(0.3, 0.3, 0.1, 14), M(sx * 0.82, 3.2, -1.95));
  }
  pb.add('helo', cylZ(0.3, 0.72, 1.8, 16), M(0, 3.25, -2.7));
  // rotor mast
  pb.add('heloDark', cyl(0.22, 0.3, 0.8, 12), M(0, 3.95, 1.1));
  // tail pylon (swept) + stabilator
  const pylon = profileSolid([[-8.3, 2.5], [-8.9, 2.4], [-10.1, 4.9], [-9.6, 5.1], [-8.9, 3.4]] as V2[], 0.2);
  pb.addOwned('helo', pylon, undefined, { uvScale: 1 / 4 });
  pb.add('helo', box(4.4, 0.08, 0.9), M(0, 2.65, -9.3));
  // sponsons / stub wings (ESSS pylons) + main gear
  for (const sx of [1, -1]) {
    pb.add('helo', box(0.55, 0.45, 1.8), M(sx * 1.35, 0.95, 1.1));
    pb.add('helo', box(1.6, 0.12, 0.6), M(sx * 1.9, 2.45, -1.2, 0, 0, sx * 3 * DEG));
    pb.add('heloDark', box(0.12, 0.6, 0.12), M(sx * 2.5, 2.1, -1.2));
    // main wheel + strut
    pb.add('black', cyl(0.36, 0.36, 0.25, 18), M(sx * 1.55, 0.36, 1.3, 0, 0, Math.PI / 2));
    const [sg, sm] = rod(new THREE.Vector3(sx * 1.5, 0.4, 1.3), new THREE.Vector3(sx * 1.25, 1.0, 1.1), 0.06, 8);
    pb.addOwned('heloDark', sg, sm);
  }
  // tail wheel
  pb.add('black', cyl(0.24, 0.24, 0.18, 14), M(0, 0.24, -5.3, 0, 0, Math.PI / 2));
  const [tg, tm] = rod(new THREE.Vector3(0, 0.3, -5.3), new THREE.Vector3(0, 2.1, -5.0), 0.07, 8);
  pb.addOwned('heloDark', tg, tm);
  // chin FLIR turret and APS-153 radome under fuselage
  pb.add('heloDark', new THREE.SphereGeometry(0.22, 14, 10), M(0, 0.66, 6.6));
  pb.add('helo', new THREE.SphereGeometry(0.55, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M(0, 0.62, 3.2, 0, 0, 0, 1, 0.5, 1));
  // antennas
  pb.add('heloDark', box(0.05, 0.4, 0.3), M(0, 3.05, 3.4));
  pb.build(g, mats, 'helo_body');

  // main rotor (4 blades, spread)
  const rotor = new THREE.Group();
  rotor.name = 'helo_rotor';
  rotor.position.set(0, 4.4, 1.1);
  const rp = new PartBuilder();
  rp.add('heloDark', cyl(0.45, 0.35, 0.35, 16), M(0, 0, 0));
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2 + Math.PI / 4;
    const blade = box(7.7, 0.08, 0.53);
    blade.translate(0.55 + 7.7 / 2, 0, 0);
    // slight droop
    const pos = blade.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) - 0.012 * Math.pow(pos.getX(i), 1.5) * 0.25);
    blade.computeVertexNormals();
    rp.addOwned('heloDark', blade, M(0, 0, 0, 0, a, 0));
    rp.add('heloDark', box(0.6, 0.15, 0.25), M(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5, 0, a, 0));
  }
  rp.build(rotor, mats, 'helo_rotor');
  g.add(rotor);

  // tail rotor (canted 20°, on port side of pylon top)
  const tr = new THREE.Group();
  tr.name = 'helo_tail_rotor';
  tr.position.set(-0.3, 4.55, -9.85);
  tr.rotation.z = -20 * DEG;
  const tp = new PartBuilder();
  tp.add('heloDark', cyl(0.12, 0.12, 0.3, 10), M(0, 0, 0, 0, 0, Math.PI / 2));
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2;
    const bl = box(0.05, 1.55, 0.22);
    bl.translate(0, 0.85, 0);
    tp.addOwned('heloDark', bl, M(-0.12, 0, 0, a, 0, 0));
  }
  tp.build(tr, mats, 'helo_tail_rotor');
  g.add(tr);
  void cyl;
  return g;
}
