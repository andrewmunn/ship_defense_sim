import * as THREE from 'three';
import { PartBuilder, M, V2, V3, box, cyl, cylZ, latheZ, prismBetween, DEG, rod, loftRings } from './geom';
import { Block, sym } from './block';

type Mats = Record<string, THREE.Material>;

function empty(name: string, x = 0, y = 0, z = 0) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

// ============================================================ Anvil 5-inch gun
/**
 * gun_mount: yaw about +Y (origin on deck at mount centre).
 * gun_elev: pitch about +X, origin on the trunnion axis. Barrel points +Z at rest.
 *   ELEVATION SIGN: rotation.x = -elevation (negative rotation.x raises the barrel).
 * gun_muzzle: at the barrel tip (+Z forward).
 */
export function createGun(mats: Mats): THREE.Group {
  const mount = new THREE.Group();
  mount.name = 'gun_mount';
  const pb = new PartBuilder();
  // low, long stealth shield: flat roof, steep sides, long raked glacis to a narrow nose
  const y0 = 0.28, y1 = 2.12;
  const bot: V2[] = [[1.58, -2.95], [1.58, 0.55], [0.82, 3.35], [-0.82, 3.35], [-1.58, 0.55], [-1.58, -2.95]];
  const crease: V2[] = [[1.62, -2.85], [1.62, 0.35], [0.74, 2.62], [-0.74, 2.62], [-1.62, 0.35], [-1.62, -2.85]];
  const top: V2[] = [[1.2, -2.35], [1.2, -0.15], [0.58, 0.2], [-0.58, 0.2], [-1.2, -0.15], [-1.2, -2.35]];
  const yc = 0.95;
  // lower band flares out slightly to a horizontal crease, upper band slopes in (and rear slopes ~20 deg)
  pb.addOwned('paintFine', prismBetween(bot, y0, crease, yc, false, true), undefined, { uvScale: 1 / 3 });
  pb.addOwned('paintFine', prismBetween(crease, yc, top, y1, true, false), undefined, { uvScale: 1 / 3 });
  // roof hatches, lifting eyes
  for (const [x, z] of [[0.55, -1.3], [-0.55, -0.6]] as [number, number][]) pb.add('paintFine', box(0.6, 0.05, 0.6), M(x, y1 + 0.025, z));
  for (const [x, z] of [[0.95, -2.1], [-0.95, -2.1], [0.9, 0.0], [-0.9, 0.0]] as [number, number][]) pb.add('darkSteel', new THREE.TorusGeometry(0.06, 0.015, 4, 8), M(x, y1 + 0.06, z, 0, Math.PI / 2, 0));
  // shadow gap + hidden training ring under the shield
  pb.add('paintDark', cyl(1.45, 1.45, y0, 40), M(0, y0 / 2, -0.4));
  // barrel slot along the glacis (narrow, dark) and access/detail panels
  const glacisAng = Math.atan2(y1 - y0, 3.35 - 0.2);
  pb.add('paintDark', box(0.34, 0.03, 1.2), M(0, 1.05, 2.15, -glacisAng, 0, 0));
  pb.add('paintFine', box(0.7, 1.0, 0.04), M(0.55, 1.35, -2.72, -0.35, 0, 0));
  for (const sx of [1, -1]) {
    pb.add('darkSteel', box(0.04, 0.04, 2.2), M(sx * 1.5, 0.75, -1.2));
    pb.add('paintFine', box(0.05, 0.5, 0.9), M(sx * 1.42, 1.55, -1.7, 0, 0, sx * -12 * DEG));
  }
  pb.add('paintFine', box(0.3, 0.2, 0.3), M(-0.7, y1 + 0.1, -1.6));
  pb.build(mount, mats, 'gun_mount');

  const elev = new THREE.Group();
  elev.name = 'gun_elev';
  elev.position.set(0, 1.12, 0.55);
  const eb = new PartBuilder();
  // 5-inch long barrel: gentle taper ~0.30 m -> ~0.20 m OD, plain muzzle
  const L = 7.4;
  const prof: V2[] = [[0.0, -0.3], [0.2, -0.3], [0.2, 1.2], [0.18, 1.35], [0.165, 2.6], [0.135, 5.0], [0.105, L - 0.12], [0.108, L], [0.064, L], [0.064, L - 0.1], [0.0, L - 0.1]];
  eb.addOwned('paintFine', latheZ(prof, 28), undefined, { uvScale: 1 / 3 });
  // tight rubber boot where the barrel leaves the glacis
  eb.addOwned('rubber', latheZ([[0.17, 1.05], [0.34, 1.12], [0.3, 1.25], [0.33, 1.38], [0.27, 1.5], [0.28, 1.6], [0.17, 1.72]], 24));
  eb.build(elev, mats, 'gun_elev');
  elev.add(empty('gun_muzzle', 0, 0, L));
  mount.add(elev);
  return mount;
}

// ============================================================ Hornet CIWS
/**
 * <p>_mount: yaw about +Y (origin at top of fixed pedestal).
 * <p>_elev: pitch about +X (rotation.x = -elevation raises), rest = +Z horizontal.
 * <p>_barrels: 6-barrel cluster, spin about local +Z.
 * <p>_muzzle: at barrel tips.
 */
export function createCIWS(prefix: string, mats: Mats): { base: THREE.Group; mount: THREE.Group } {
  const base = new THREE.Group();
  base.name = prefix + '_base';
  const bp = new PartBuilder();
  // fixed deck foundation ring
  bp.add('paintFine', cyl(0.98, 1.02, 0.28, 36), M(0, 0.14, 0));
  bp.add('paintFine', cyl(1.0, 1.0, 0.04, 36), M(0, 0.3, 0));
  bp.build(base, mats, prefix + '_base');

  const mount = new THREE.Group();
  mount.name = prefix + '_mount';
  mount.position.set(0, 0.32, 0);
  const mp = new PartBuilder();
  // train platform + below-deck-style electronics enclosure at the rear
  mp.add('paintFine', cyl(0.9, 0.95, 0.32, 36), M(0, 0.16, 0));
  mp.add('paintFine', box(1.55, 0.75, 0.62), M(0, 0.62, -0.72));
  mp.add('paintFine', box(1.25, 0.18, 0.5), M(0, 1.08, -0.78));
  // elevation cradle arms (two side plates rising to the trunnion)
  for (const sx of [1, -1]) {
    // curved yoke arm: tapered plate topped by a round trunnion boss
    const arm = prismBetween([[-0.08, -0.5], [0.08, -0.5], [0.08, 0.42], [-0.08, 0.42]], 0.3, [[-0.08, -0.3], [0.08, -0.3], [0.08, 0.3], [-0.08, 0.3]], 1.3, true, false);
    mp.addOwned('paintFine', arm, M(sx * 0.66, 0, 0.0));
    mp.add('paintFine', cyl(0.3, 0.3, 0.16, 24), M(sx * 0.66, 1.35, 0.0, 0, 0, Math.PI / 2));
    mp.add('paintDark', cyl(0.12, 0.12, 0.2, 16), M(sx * 0.72, 1.35, 0.0, 0, 0, Math.PI / 2));
  }
  mp.build(mount, mats, prefix + '_mount');

  const elev = new THREE.Group();
  elev.name = prefix + '_elev';
  elev.position.set(0, 1.35, 0.0);
  const ep = new PartBuilder();
  // white radome ('R2-D2'): cylinder + domed top, sits on top of the elevating assembly
  const rdR = 0.63;
  ep.add('radome', cyl(rdR, rdR, 1.2, 40), M(0, 0.95, -0.2));
  ep.add('radome', new THREE.SphereGeometry(rdR, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 1.55, -0.2, 0, 0, 0, 1, 0.72, 1));
  ep.add('paintFine', cyl(rdR + 0.02, rdR + 0.02, 0.07, 40), M(0, 0.36, -0.2));
  // gun/drum housing under the radome (gray), with rounded drum bottom
  ep.add('paintFine', box(0.95, 0.42, 1.55), M(0, 0.12, -0.3));
  ep.add('paintFine', cylZ(0.47, 0.47, 1.5, 30), M(0, -0.12, -0.35, 0, 0, 0, 1, 0.75, 1));
  ep.add('paintFine', cylZ(0.3, 0.47, 0.18, 30), M(0, -0.12, -1.19, 0, 0, 0, 1, 0.75, 1));
  // barrel housing / receiver in front
  ep.add('paintDark', cylZ(0.17, 0.2, 0.55, 20), M(0, -0.08, 0.6));
  // FLIR on the port side of the radome
  ep.add('paintFine', box(0.28, 0.5, 0.55), M(0.8, 0.7, -0.05));
  ep.add('paintDark', box(0.14, 0.14, 0.02), M(0.8, 0.76, 0.23));
  ep.add('paintFine', box(0.22, 0.1, 0.35), M(0.68, 0.7, -0.05));
  ep.build(elev, mats, prefix + '_elev');

  const barrels = new THREE.Group();
  barrels.name = prefix + '_barrels';
  barrels.position.set(0, -0.08, 0.85);
  const brp = new PartBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    brp.add('paintDark', cylZ(0.022, 0.026, 1.75, 8), M(Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0.875));
  }
  brp.add('paintDark', cylZ(0.115, 0.115, 0.07, 16), M(0, 0, 0.5));
  // muzzle restraint / clamp
  brp.add('paintDark', cylZ(0.118, 0.118, 0.12, 16), M(0, 0, 1.6));
  brp.build(barrels, mats, prefix + '_barrels');
  elev.add(barrels);
  // barrel shroud support (fixed to elevating mass)
  const sp = new PartBuilder();
  sp.add('paintFine', box(0.08, 0.06, 1.35), M(0, -0.24, 1.5));
  sp.build(elev, mats, prefix + '_shroud');
  const muzzle = empty(prefix + '_muzzle', 0, -0.08, 0.85 + 1.75);
  elev.add(muzzle);
  mount.add(elev);
  base.add(mount);
  return { base, mount };
}

// ============================================================ Lantern fire-control illuminator
/** <name>: yaw about +Y; <name>_elev: pitch about +X (rotation.x = -elevation raises); dish faces +Z. */
export function createIlluminator(name: string, mats: Mats): THREE.Group {
  const yaw = new THREE.Group();
  yaw.name = name;
  const yp = new PartBuilder();
  // bulky training base + yoke
  yp.add('paintFine', cyl(0.62, 0.68, 0.4, 28), M(0, 0.2, 0));
  yp.add('paintFine', box(1.15, 0.6, 1.0), M(0, 0.68, -0.15));
  yp.add('paintFine', box(0.8, 0.35, 0.6), M(0, 1.05, -0.35));
  for (const sx of [1, -1]) yp.add('paintFine', box(0.16, 1.05, 0.55), M(sx * 0.72, 1.1, 0.05));
  yp.build(yaw, mats, name);
  const elev = new THREE.Group();
  elev.name = name + '_elev';
  elev.position.set(0, 1.45, 0.05);
  const ep = new PartBuilder();
  // parabolic dish, ~2.3 m, facing +Z
  const R = 1.15, depth = 0.42;
  const prof: V2[] = [];
  for (let i = 0; i <= 12; i++) {
    const r = (i / 12) * R;
    prof.push([r, depth * (r / R) ** 2]);
  }
  const back: V2[] = [...prof].reverse().map(([r, z]) => [r * 0.999, z - 0.07] as V2);
  const dish = latheZ([...prof, [R + 0.05, depth + 0.02], ...back], 40);
  ep.addOwned('paintFine', dish, M(0, 0, -0.12), { uvScale: 1 / 3 });
  // rim ring
  const rim = new THREE.TorusGeometry(R + 0.04, 0.04, 6, 40);
  ep.addOwned('paintFine', rim, M(0, 0, depth - 0.1));
  // rear electronics housing + trunnion
  ep.add('paintFine', box(1.0, 0.95, 0.6), M(0, 0, -0.5));
  ep.add('paintFine', cyl(0.13, 0.13, 1.5, 12), M(0, 0, -0.3, 0, 0, Math.PI / 2));
  // Cassegrain: central feed horn + subreflector on 4 struts
  ep.add('paintFine', cylZ(0.14, 0.18, 0.35, 16), M(0, 0, 0.05));
  const subZ = 0.95;
  ep.add('paintFine', cylZ(0.24, 0.24, 0.06, 20), M(0, 0, subZ));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const [g, m] = rod(new THREE.Vector3(Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0.2), new THREE.Vector3(Math.cos(a) * 0.2, Math.sin(a) * 0.2, subZ), 0.022, 6);
    ep.add('paintFine', g, m);
  }
  ep.build(elev, mats, name + '_elev');
  yaw.add(elev);
  return yaw;
}

// ============================================================ VLS
export interface VLSResult {
  group: THREE.Group;
}
const _hatchGeo: { g?: THREE.BufferGeometry; up?: THREE.BufferGeometry } = {};
/**
 * VLS: modules of 8 cells (2 rows x 4 across) with a central uptake hatch.
 * Hatch objects `${prefix}_hatch_i`: pivot on hinge edge (outboard edge of its row),
 * open with rotation.x = +angle (0 closed .. ~1.7 rad open).
 */
export function createVLS(prefix: string, modsX: number, modsZ: number, center: V3, mats: Mats): THREE.Group {
  const g = new THREE.Group();
  g.name = prefix;
  g.position.set(center[0], center[1], center[2]);
  const MW = 3.43, ML = 2.62; // module width (x), length (z)
  const pitch = 0.84, rowOff = 0.66, hatch = 0.76;
  const pb = new PartBuilder();
  const W = modsX * MW, Lz = modsZ * ML;
  // surrounding deck frame / coaming
  pb.add('paintFine', box(W + 0.5, 0.1, Lz + 0.5), M(0, 0.0, 0));
  pb.add('deckPlain', box(W + 0.3, 0.12, Lz + 0.3), M(0, 0.02, 0));
  if (!_hatchGeo.g) {
    const hg = box(hatch, 0.05, hatch);
    hg.translate(0, 0.025, -hatch / 2);
    _hatchGeo.g = hg;
  }
  const cells: { x: number; y: number; z: number }[] = [];
  let hi = 0;
  for (let mz = 0; mz < modsZ; mz++)
    for (let mx = 0; mx < modsX; mx++) {
      const cx = -W / 2 + MW * (mx + 0.5), cz = Lz / 2 - ML * (mz + 0.5);
      // module plate + uptake hatch (long plate with ribs)
      pb.add('darkSteel', box(MW - 0.08, 0.03, ML - 0.08), M(cx, 0.085, cz));
      pb.add('vlsHatch', box(pitch * 4 - 0.1, 0.06, 0.46), M(cx, 0.11, cz));
      for (let r = 0; r < 5; r++) pb.add('darkSteel', box(0.04, 0.03, 0.46), M(cx - 1.4 + r * 0.7, 0.15, cz));
      for (const row of [1, -1]) {
        for (let c = 0; c < 4; c++) {
          const x = cx + (c - 1.5) * pitch;
          const zc = cz + row * rowOff;
          const hingeZ = zc + row * (hatch / 2);
          // hinge pin block
          pb.add('darkSteel', box(0.5, 0.05, 0.06), M(x, 0.12, hingeZ + row * 0.02));
          const pivot = new THREE.Object3D();
          pivot.position.set(x, 0.1, hingeZ);
          if (row < 0) pivot.rotation.y = Math.PI; // aft row: hatch extends toward +Z in ship frame
          const h = new THREE.Mesh(_hatchGeo.g, mats.vlsHatch);
          h.name = `${prefix}_hatch_${hi}`;
          h.castShadow = true;
          h.receiveShadow = true;
          pivot.add(h);
          g.add(pivot);
          cells.push({ x: center[0] + x, y: center[1] + 0.15, z: center[2] + zc });
          hi++;
        }
      }
    }
  pb.build(g, mats, prefix + '_frame');
  g.userData.cells = cells;
  return g;
}

// ============================================================ Wisp / chaff decoy launcher — 6 tubes
/** Adds launcher geometry to pb (ship frame) and returns tube-mouth empties (one per launcher: 60° tube). */
export function addDecoyLauncher(pb: PartBuilder, pos: V3, outward: number, idx: number): THREE.Object3D {
  const [x, y, z] = pos;
  const yawM = M(x, y, z, 0, outward > 0 ? Math.PI / 2 : -Math.PI / 2, 0); // local +Z = outboard
  pb.add('paintFine', box(1.0, 0.35, 0.8), yawM.clone().multiply(M(0, 0.175, 0)));
  let mouth: THREE.Object3D | null = null;
  const tl = 1.25;
  for (let row = 0; row < 2; row++) {
    const el = row === 0 ? 45 : 60;
    for (let c = 0; c < 3; c++) {
      const lx = (c - 1) * 0.3;
      const base = new THREE.Vector3(lx, 0.45 + row * 0.12, -0.15 + row * -0.2);
      const dir = new THREE.Vector3(0, Math.sin(el * DEG), Math.cos(el * DEG));
      const tip = base.clone().addScaledVector(dir, tl);
      const [g, m] = rod(base, tip, 0.075, 12);
      pb.add('paintFine', g, yawM.clone().multiply(m));
      pb.add('black', new THREE.CircleGeometry(0.065, 12), yawM.clone().multiply(new THREE.Matrix4().compose(tip.clone().addScaledVector(dir, 0.001), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), new THREE.Vector3(1, 1, 1))));
      if (row === 1 && c === 1) {
        const o = new THREE.Object3D();
        o.name = `decoy_launcher_${idx}`;
        const wm = yawM.clone().multiply(new THREE.Matrix4().compose(tip, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), new THREE.Vector3(1, 1, 1)));
        wm.decompose(o.position, o.quaternion, o.scale);
        mouth = o;
      }
    }
  }
  // support frame
  pb.add('paintFine', box(1.0, 0.5, 0.08), yawM.clone().multiply(M(0, 0.55, -0.3)));
  return mouth!;
}

// ============================================================ triple torpedo tubes
export function addTorpedoTubes(pb: PartBuilder, x: number, y: number, z: number, outward: number) {
  const m = M(x, y, z, 0, outward > 0 ? Math.PI / 2 - 0.5 : -Math.PI / 2 + 0.5, 0);
  pb.add('paintFine', cyl(0.35, 0.45, 0.6, 16), m.clone().multiply(M(0, 0.3, 0)));
  for (let k = 0; k < 3; k++) {
    const yy = 0.8 + (k === 1 ? 0.33 : 0), xx = (k - 1) * 0.3;
    pb.add('paintFine', cylZ(0.18, 0.18, 3.2, 16), m.clone().multiply(M(xx, yy, 0.3)));
    pb.add('darkSteel', cylZ(0.2, 0.2, 0.12, 16), m.clone().multiply(M(xx, yy, 1.9)));
  }
}

export const _unusedW = [Block, sym, loftRings];

// ============================================================ 25 mm chain gun (static)
export function addChainGun(pb: PartBuilder, x: number, y: number, z: number, outward: number) {
  const m = M(x, y, z, 0, outward > 0 ? 0.6 : -0.6, 0);
  pb.add('paintFine', cyl(0.45, 0.55, 0.5, 20), m.clone().multiply(M(0, 0.25, 0)));
  pb.add('paintFine', box(0.9, 0.75, 1.1), m.clone().multiply(M(0, 0.85, -0.1)));
  pb.add('paintFine', box(0.35, 0.4, 0.45), m.clone().multiply(M(0.55, 1.05, 0.1)));
  pb.add('glass', box(0.2, 0.2, 0.02), m.clone().multiply(M(0.55, 1.08, 0.33)));
  pb.add('paintDark', cylZ(0.05, 0.06, 1.9, 10), m.clone().multiply(M(-0.1, 0.95, 1.35)));
  pb.add('paintFine', box(0.34, 0.34, 0.6), m.clone().multiply(M(-0.35, 0.8, -0.1)));
}
